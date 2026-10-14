//! Whole-document sync for the outliner.
//!
//! The document is small enough (~100KB) that uploading all of it is cheaper
//! than any scheme for uploading part of it, so this service does exactly one
//! thing: hold the latest copy and hand it back.
//!
//! Authentication is in the middle of moving. Caddy sits in front and enforces
//! HTTP basic auth, and this process is not published outside the compose
//! network — keep it that way, since exposing the port would expose the
//! document. On top of that, a request carrying a bearer token has it checked
//! here, against the identity provider's published keys (see `auth`).
//!
//! So during the transition: a bearer token must be valid, and a request
//! without one is trusted to have been authenticated by the proxy. Once every
//! client sends a token, the second half of that goes away along with basic
//! auth.
//!
//! The one guard that matters is conditional writes. A client that has been
//! offline holds a whole stale document, and uploading it would not merge
//! badly, it would erase everything done elsewhere. So an overwrite must name
//! the version it is replacing, and is refused if that is no longer current.

use std::{
    env,
    fs::{self, File},
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

mod auth;

const DOC_FILE: &str = "doc.json";
const TMP_FILE: &str = "doc.json.tmp";
/// The copy displaced by the most recent write. A bad upload is recoverable
/// from here without reaching for a backup of the whole disk.
const BAK_FILE: &str = "doc.json.bak";

/// Far above a realistic document, low enough that a broken client cannot
/// fill the disk.
const MAX_BODY: usize = 5 * 1024 * 1024;

#[derive(Clone)]
struct Stored {
    bytes: Bytes,
    /// Quoted, as it travels in `ETag` and `If-Match`.
    etag: String,
    modified: SystemTime,
}

struct AppState {
    dir: PathBuf,
    doc: RwLock<Option<Stored>>,
    /// `None` until an issuer is configured, which is how this ran when the
    /// proxy was the only thing authenticating.
    auth: Option<auth::Auth>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into()));
    let bind: SocketAddr = env::var("BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;

    let auth = auth::Auth::from_env().map_err(|error| -> Box<dyn std::error::Error> {
        // A typo here would otherwise mean tokens are silently never checked.
        format!("auth is misconfigured: {error}").into()
    })?;
    match &auth {
        Some(auth) => {
            log(&format!("validating bearer tokens: {}", auth.describe()));
            auth.prefetch().await;
        }
        None => log("AUTH_ISSUER is unset, so bearer tokens are not accepted"),
    }

    fs::create_dir_all(&dir)?;
    let existing = load(&dir)?;
    match &existing {
        Some(doc) => log(&format!(
            "loaded {} bytes from {}, etag {}",
            doc.bytes.len(),
            dir.join(DOC_FILE).display(),
            short(&doc.etag)
        )),
        None => log(&format!("no document yet in {}", dir.display())),
    }

    let state = Arc::new(AppState {
        dir,
        doc: RwLock::new(existing),
        auth,
    });

    let listener = tokio::net::TcpListener::bind(bind).await?;
    log(&format!("listening on {bind}"));

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// Finish any in-flight write before the process goes away.
async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
    log("shutting down");
}

fn router(state: Arc<AppState>) -> Router {
    // The document is the only thing worth guarding. `/api/health` stays open
    // so the deployment check can reach it without credentials; it says
    // nothing but "ok".
    let document = Router::new()
        // `get` also answers HEAD: axum runs the handler and drops the body,
        // so conditional requests behave identically on both.
        .route("/api/doc", get(get_doc).put(put_doc))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));

    Router::new()
        .merge(document)
        .route("/api/health", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

/// Let the request through if whoever sent it has been authenticated.
///
/// Two ways in while auth is being moved. A bearer token is checked here and
/// must be valid. A request without one is let through because the proxy in
/// front enforces basic auth and this service is not reachable any other way —
/// that half disappears with basic auth itself.
async fn authenticate(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let bearer = header_str(request.headers(), header::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty());

    match (&state.auth, bearer) {
        (Some(auth), Some(token)) => match auth.verify(token).await {
            Ok(_) => next.run(request).await,
            Err(denied) => {
                // Worth a line: a client that cannot authenticate looks
                // identical to one that is not syncing.
                log(&format!("refused a request: {denied}"));
                unauthorized()
            }
        },
        (Some(_), None) => next.run(request).await,
        // Refused rather than ignored: accepting it would mean trusting a
        // token nothing had checked.
        (None, Some(_)) => {
            log("refused a request: a bearer token arrived but AUTH_ISSUER is unset");
            unauthorized()
        }
        (None, None) => next.run(request).await,
    }
}

/// Deliberately says nothing about which check failed; the log does that.
fn unauthorized() -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer"),
    );
    (StatusCode::UNAUTHORIZED, headers, "unauthorized").into_response()
}

async fn get_doc(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let guard = state.doc.read().await;
    let Some(doc) = guard.as_ref() else {
        return (StatusCode::NOT_FOUND, "no document stored yet").into_response();
    };

    let meta = meta_headers(doc);
    if let Some(candidates) = header_str(&headers, header::IF_NONE_MATCH) {
        if etag_matches(candidates, &doc.etag) {
            return (StatusCode::NOT_MODIFIED, meta).into_response();
        }
    }
    (meta, doc.bytes.clone()).into_response()
}

async fn put_doc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        log("refused a write: empty body");
        return (StatusCode::BAD_REQUEST, "empty body").into_response();
    }
    // Not a schema check — just a refusal to persist something that is not
    // even JSON, which would otherwise be handed back to every client.
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        log(&format!("refused a write of {} bytes: not JSON", body.len()));
        return (StatusCode::BAD_REQUEST, "body is not valid JSON").into_response();
    }

    let mut guard = state.doc.write().await;
    let if_match = header_str(&headers, header::IF_MATCH);

    match (guard.as_ref(), if_match) {
        // An overwrite has to name the version it replaces.
        (Some(current), None) => {
            log(&format!(
                "refused a write of {} bytes: no If-Match, holding {}",
                body.len(),
                short(&current.etag),
            ));
            return (
                StatusCode::PRECONDITION_REQUIRED,
                meta_headers(current),
                "If-Match required: fetch the current document first",
            )
                .into_response();
        }
        (Some(current), Some(candidates)) => {
            if !etag_matches(candidates, &current.etag) {
                // Worth recording: this is the moment two devices diverged,
                // and the one that lost is about to have its copy replaced.
                log(&format!(
                    "refused a write of {} bytes: client had {}, holding {}",
                    body.len(),
                    short(candidates),
                    short(&current.etag),
                ));
                // The caller is working from a document that is no longer
                // current. Hand back the live metadata so it can refetch.
                return (
                    StatusCode::PRECONDITION_FAILED,
                    meta_headers(current),
                    "stale document: refetch and retry",
                )
                    .into_response();
            }
        }
        // Nothing stored, but the caller believes otherwise.
        (None, Some(candidates)) => {
            log(&format!(
                "refused a write of {} bytes: client had {}, holding nothing",
                body.len(),
                short(candidates),
            ));
            return (StatusCode::PRECONDITION_FAILED, "no document stored yet")
                .into_response();
        }
        // First write.
        (None, None) => {}
    }

    let dir = state.dir.clone();
    let to_write = body.clone();
    let written = tokio::task::spawn_blocking(move || write_atomic(&dir, &to_write)).await;

    let modified = match written {
        Ok(Ok(modified)) => modified,
        Ok(Err(error)) => {
            log(&format!("write failed: {error}"));
            return (StatusCode::INTERNAL_SERVER_ERROR, "could not store document")
                .into_response();
        }
        Err(error) => {
            log(&format!("write task failed: {error}"));
            return (StatusCode::INTERNAL_SERVER_ERROR, "could not store document")
                .into_response();
        }
    };

    let stored = Stored {
        etag: etag_of(&body),
        bytes: body,
        modified,
    };
    log(&format!(
        "stored {} bytes, etag {}",
        stored.bytes.len(),
        short(&stored.etag)
    ));
    let meta = meta_headers(&stored);
    *guard = Some(stored);

    (StatusCode::NO_CONTENT, meta).into_response()
}

fn meta_headers(doc: &Stored) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&doc.etag) {
        headers.insert(header::ETAG, value);
    }
    if let Ok(value) = HeaderValue::from_str(&httpdate::fmt_http_date(doc.modified)) {
        headers.insert(header::LAST_MODIFIED, value);
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // The browser cache must never answer a sync request with a stale copy.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    headers
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Content codings a proxy may have applied, and named in the entity tag.
const CODINGS: [&str; 5] = ["gzip", "br", "zstd", "deflate", "compress"];

/// The identity of the stored document, whatever representation a tag names.
///
/// A proxy that compresses a response must change its entity tag, because the
/// compressed body is a different representation — Caddy appends `-gzip` and
/// friends. The client then sends that tag straight back in `If-Match` or
/// `If-None-Match`, and a literal comparison against the identity tag misses
/// every time: writes get refused as stale, and conditional reads never get a
/// 304 so the whole document is re-sent on every poll.
///
/// All those tags name the same stored bytes, so comparison happens on the
/// part that identifies them.
fn core(tag: &str) -> &str {
    let inner = tag.trim().trim_start_matches("W/").trim_matches('"');
    for coding in CODINGS {
        if let Some(base) = inner.strip_suffix(coding) {
            if let Some(base) = base.strip_suffix('-') {
                return base;
            }
        }
    }
    inner
}

/// `If-Match` / `If-None-Match` hold a comma-separated list, `*`, or weak tags.
fn etag_matches(candidates: &str, current: &str) -> bool {
    let wanted = core(current);
    candidates
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || core(candidate) == wanted)
}

/// Enough of an entity tag to tell two apart in a log line, without filling
/// it with sixty-four hex characters.
fn short(etag: &str) -> &str {
    let trimmed = etag.trim().trim_start_matches("W/").trim_matches('"');
    trimmed.get(..12).unwrap_or(trimmed)
}

fn etag_of(bytes: &[u8]) -> String {
    format!("\"{:x}\"", Sha256::digest(bytes))
}

/// Replace the document without ever leaving a half-written file in place.
///
/// A crash during a plain overwrite leaves a truncated document, which is
/// worse than none at all: the next client to sync would pull the wreckage
/// over its good local copy.
fn write_atomic(dir: &Path, bytes: &[u8]) -> io::Result<SystemTime> {
    let target = dir.join(DOC_FILE);
    let tmp = dir.join(TMP_FILE);

    if target.exists() {
        fs::copy(&target, dir.join(BAK_FILE))?;
    }

    {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        // Flush the contents before the rename, or a crash can leave the new
        // name pointing at an empty file.
        file.sync_all()?;
    }

    fs::rename(&tmp, &target)?;
    // Durably record the rename itself.
    File::open(dir)?.sync_all()?;

    fs::metadata(&target)?.modified()
}

fn load(dir: &Path) -> io::Result<Option<Stored>> {
    let target = dir.join(DOC_FILE);
    match fs::read(&target) {
        Ok(bytes) => {
            let modified = fs::metadata(&target)?.modified()?;
            Ok(Some(Stored {
                etag: etag_of(&bytes),
                bytes: Bytes::from(bytes),
                modified,
            }))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn log(message: &str) {
    println!("[{}] {message}", httpdate::fmt_http_date(SystemTime::now()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    struct Harness {
        router: Router,
        state: Arc<AppState>,
        _dir: tempfile::TempDir,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = Arc::new(AppState {
            dir: dir.path().to_path_buf(),
            doc: RwLock::new(load(dir.path()).expect("load")),
            auth: None,
        });
        Harness {
            router: router(state.clone()),
            state,
            _dir: dir,
        }
    }

    async fn send(harness: &Harness, request: Request<axum::body::Body>) -> Response {
        harness
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("response")
    }

    fn put_request(body: &str, if_match: Option<&str>) -> Request<axum::body::Body> {
        let mut builder = Request::builder().method("PUT").uri("/api/doc");
        if let Some(value) = if_match {
            builder = builder.header(header::IF_MATCH, value);
        }
        builder
            .body(axum::body::Body::from(body.to_owned()))
            .expect("request")
    }

    fn get_request(if_none_match: Option<&str>) -> Request<axum::body::Body> {
        let mut builder = Request::builder().method("GET").uri("/api/doc");
        if let Some(value) = if_none_match {
            builder = builder.header(header::IF_NONE_MATCH, value);
        }
        builder.body(axum::body::Body::empty()).expect("request")
    }

    async fn body_of(response: Response) -> String {
        let bytes = response.into_body().collect().await.expect("body").to_bytes();
        String::from_utf8(bytes.to_vec()).expect("utf8")
    }

    fn etag_of_response(response: &Response) -> String {
        response
            .headers()
            .get(header::ETAG)
            .expect("etag")
            .to_str()
            .expect("etag str")
            .to_owned()
    }

    /// A harness whose service validates bearer tokens, with the test key
    /// already loaded so nothing here touches the network.
    fn guarded_harness() -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = Arc::new(AppState {
            dir: dir.path().to_path_buf(),
            doc: RwLock::new(None),
            auth: Some(auth::tests::auth()),
        });
        Harness {
            router: router(state.clone()),
            state,
            _dir: dir,
        }
    }

    fn get_with_auth(value: Option<&str>) -> Request<axum::body::Body> {
        let mut builder = Request::builder().method("GET").uri("/api/doc");
        if let Some(value) = value {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        builder.body(axum::body::Body::empty()).expect("request")
    }

    #[tokio::test]
    async fn a_valid_bearer_token_reaches_the_document() {
        let h = guarded_harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;

        let bearer = format!("Bearer {}", auth::tests::token());
        let response = send(&h, get_with_auth(Some(&bearer))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_of(response).await, r#"{"a":1}"#);
    }

    #[tokio::test]
    async fn a_bad_bearer_token_gets_401_and_not_the_document() {
        let h = guarded_harness();
        send(&h, put_request(r#"{"secret":1}"#, None)).await;

        let response = send(&h, get_with_auth(Some("Bearer not.a.token"))).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_ne!(body_of(response).await, r#"{"secret":1}"#);
    }

    #[tokio::test]
    async fn a_token_for_an_unlisted_subject_cannot_write() {
        // The guard that matters once the provider allows sign-up: a real
        // token from a real account that is simply not this one.
        let h = guarded_harness();
        let stranger = auth::tests::sign(
            auth::tests::header(),
            auth::tests::claims_with("sub", serde_json::json!("stranger00000000000000aa")),
        );
        let request = Request::builder()
            .method("PUT")
            .uri("/api/doc")
            .header(header::AUTHORIZATION, format!("Bearer {stranger}"))
            .body(axum::body::Body::from(r#"{"theirs":1}"#))
            .expect("request");

        assert_eq!(send(&h, request).await.status(), StatusCode::UNAUTHORIZED);
        // And nothing was stored.
        assert_eq!(
            send(&h, get_request(None)).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn a_request_with_no_token_is_still_let_through() {
        // The transition: the proxy in front enforces basic auth, and this
        // service is not reachable any other way. Removing this is the last
        // step of the move, not an oversight.
        let h = guarded_harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;
        assert_eq!(send(&h, get_with_auth(None)).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn basic_credentials_are_left_to_the_proxy() {
        let h = guarded_harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;
        let response = send(&h, get_with_auth(Some("Basic a2ltOnNlY3JldA=="))).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_bearer_token_is_refused_when_nothing_can_check_it() {
        // AUTH_ISSUER unset. Accepting the token would mean trusting one that
        // nothing had verified, so it is refused rather than ignored.
        let h = harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;
        let bearer = format!("Bearer {}", auth::tests::token());
        assert_eq!(
            send(&h, get_with_auth(Some(&bearer))).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn health_needs_no_token() {
        // The deployment check reads this without credentials, and it says
        // nothing but "ok".
        let h = guarded_harness();
        let request = Request::builder()
            .method("GET")
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .expect("request");
        assert_eq!(send(&h, request).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_is_404_before_anything_is_stored() {
        let h = harness();
        let response = send(&h, get_request(None)).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn first_write_needs_no_precondition_and_round_trips() {
        let h = harness();
        let response = send(&h, put_request(r#"{"a":1}"#, None)).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let etag = etag_of_response(&response);

        let response = send(&h, get_request(None)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(etag_of_response(&response), etag);
        assert_eq!(body_of(response).await, r#"{"a":1}"#);
    }

    #[tokio::test]
    async fn the_document_survives_a_restart() {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = Arc::new(AppState {
            dir: dir.path().to_path_buf(),
            doc: RwLock::new(None),
            auth: None,
        });
        let app = router(state);
        app.clone()
            .oneshot(put_request(r#"{"kept":true}"#, None))
            .await
            .expect("put");

        // A fresh process over the same directory.
        let reloaded = load(dir.path()).expect("load").expect("some");
        assert_eq!(reloaded.bytes.as_ref(), br#"{"kept":true}"#);
    }

    #[tokio::test]
    async fn a_matching_etag_is_not_modified() {
        let h = harness();
        let etag = etag_of_response(&send(&h, put_request(r#"{"a":1}"#, None)).await);

        let response = send(&h, get_request(Some(&etag))).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(body_of(response).await, "");
    }

    #[tokio::test]
    async fn a_stale_etag_gets_the_document() {
        let h = harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;
        let response = send(&h, get_request(Some("\"nonsense\""))).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn head_reports_metadata_without_a_body() {
        let h = harness();
        let etag = etag_of_response(&send(&h, put_request(r#"{"a":1}"#, None)).await);

        let request = Request::builder()
            .method("HEAD")
            .uri("/api/doc")
            .body(axum::body::Body::empty())
            .expect("request");
        let response = send(&h, request).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(etag_of_response(&response), etag);
        assert!(response.headers().contains_key(header::LAST_MODIFIED));
        assert_eq!(body_of(response).await, "");
    }

    #[tokio::test]
    async fn head_honours_if_none_match() {
        let h = harness();
        let etag = etag_of_response(&send(&h, put_request(r#"{"a":1}"#, None)).await);

        let request = Request::builder()
            .method("HEAD")
            .uri("/api/doc")
            .header(header::IF_NONE_MATCH, &etag)
            .body(axum::body::Body::empty())
            .expect("request");
        assert_eq!(send(&h, request).await.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn overwriting_without_if_match_is_refused() {
        let h = harness();
        send(&h, put_request(r#"{"a":1}"#, None)).await;

        let response = send(&h, put_request(r#"{"a":2}"#, None)).await;
        assert_eq!(response.status(), StatusCode::PRECONDITION_REQUIRED);
        // The stored document is untouched.
        assert_eq!(body_of(send(&h, get_request(None)).await).await, r#"{"a":1}"#);
    }

    #[tokio::test]
    async fn a_stale_write_is_refused_and_changes_nothing() {
        // The case this whole precondition exists for: a client that has been
        // offline uploads a whole document built from an old version.
        let h = harness();
        let first = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        send(&h, put_request(r#"{"v":2}"#, Some(&first))).await;

        let response = send(&h, put_request(r#"{"v":"stale"}"#, Some(&first))).await;
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(body_of(send(&h, get_request(None)).await).await, r#"{"v":2}"#);
    }

    #[tokio::test]
    async fn a_refused_write_reports_the_current_version() {
        let h = harness();
        let first = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        let second = etag_of_response(&send(&h, put_request(r#"{"v":2}"#, Some(&first))).await);

        let response = send(&h, put_request(r#"{"v":3}"#, Some(&first))).await;
        assert_eq!(etag_of_response(&response), second);
    }

    #[tokio::test]
    async fn a_matching_write_succeeds() {
        let h = harness();
        let first = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        let response = send(&h, put_request(r#"{"v":2}"#, Some(&first))).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_ne!(etag_of_response(&response), first);
    }

    #[tokio::test]
    async fn if_match_star_accepts_any_current_version() {
        let h = harness();
        send(&h, put_request(r#"{"v":1}"#, None)).await;
        let response = send(&h, put_request(r#"{"v":2}"#, Some("*"))).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn if_match_on_a_missing_document_is_refused() {
        let h = harness();
        let response = send(&h, put_request(r#"{"v":1}"#, Some("\"whatever\""))).await;
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    }

    #[tokio::test]
    async fn junk_is_not_persisted() {
        let h = harness();
        let response = send(&h, put_request("not json at all", None)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(send(&h, get_request(None)).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_empty_body_is_refused() {
        let h = harness();
        assert_eq!(
            send(&h, put_request("", None)).await.status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused() {
        let h = harness();
        let huge = format!("\"{}\"", "x".repeat(MAX_BODY + 1));
        let response = send(&h, put_request(&huge, None)).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn the_previous_version_is_kept_alongside() {
        let h = harness();
        let first = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        send(&h, put_request(r#"{"v":2}"#, Some(&first))).await;

        let backup = fs::read(h.state.dir.join(BAK_FILE)).expect("backup");
        assert_eq!(backup, br#"{"v":1}"#);
    }

    #[tokio::test]
    async fn no_temporary_file_is_left_behind() {
        let h = harness();
        send(&h, put_request(r#"{"v":1}"#, None)).await;
        assert!(!h.state.dir.join(TMP_FILE).exists());
    }

    #[test]
    fn a_short_tag_stays_readable_and_distinguishing() {
        assert_eq!(short("\"0123456789abcdef\""), "0123456789ab");
        assert_eq!(short("W/\"0123456789abcdef\""), "0123456789ab");
        // Short or odd values must not panic on slicing.
        assert_eq!(short("\"abc\""), "abc");
        assert_eq!(short(""), "");
    }

    #[test]
    fn etag_matching_handles_lists_stars_and_weak_tags() {
        assert!(etag_matches("*", "\"abc\""));
        assert!(etag_matches("\"abc\"", "\"abc\""));
        assert!(etag_matches("\"zzz\", \"abc\"", "\"abc\""));
        assert!(etag_matches("W/\"abc\"", "\"abc\""));
        assert!(!etag_matches("\"zzz\"", "\"abc\""));
        assert!(!etag_matches("", "\"abc\""));
    }

    #[test]
    fn a_tag_rewritten_by_a_compressing_proxy_still_matches() {
        // What a browser is handed when the proxy gzips the response. Without
        // this, every write from that browser is refused as stale and every
        // poll re-downloads the whole document.
        assert!(etag_matches("\"abc-gzip\"", "\"abc\""));
        assert!(etag_matches("\"abc-br\"", "\"abc\""));
        assert!(etag_matches("\"abc-zstd\"", "\"abc\""));
        assert!(etag_matches("W/\"abc-gzip\"", "\"abc\""));
        assert!(etag_matches("\"zzz\", \"abc-gzip\"", "\"abc\""));
        // A different document is still a different document.
        assert!(!etag_matches("\"zzz-gzip\"", "\"abc\""));
    }

    #[tokio::test]
    async fn a_write_conditioned_on_a_compressed_tag_is_accepted() {
        let h = harness();
        let etag = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        let compressed = format!("{}-gzip\"", etag.trim_end_matches('"'));

        let response = send(&h, put_request(r#"{"v":2}"#, Some(&compressed))).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn a_read_conditioned_on_a_compressed_tag_is_not_modified() {
        let h = harness();
        let etag = etag_of_response(&send(&h, put_request(r#"{"v":1}"#, None)).await);
        let compressed = format!("{}-gzip\"", etag.trim_end_matches('"'));

        let response = send(&h, get_request(Some(&compressed))).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    }
}
