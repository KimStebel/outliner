//! Bearer token validation against the identity provider's published keys.
//!
//! The point of validating tokens here rather than asking the provider about
//! every request is that the provider then sits outside the hot path: the
//! public keys are fetched once and cached, and signatures are checked
//! locally. Rauthy being down does not stop a client with a valid token.
//!
//! Only Ed25519 is accepted, and the algorithm is never taken from the token.
//! That is deliberate: the classic JWT failures — `alg: none`, or an RSA
//! public key replayed as an HMAC secret — all come from letting the token
//! choose how it gets verified. Here the header's `alg` is only ever compared
//! against the one supported value, and anything else is refused before a key
//! is even looked up.
//!
//! A valid token proves the provider issued it to *somebody*, and that
//! somebody gets a document of their own, kept apart from everyone else's by
//! their subject. So any account the provider holds can store a document here
//! — which is why self sign-up stays off in Rauthy's config.

use std::{
    collections::HashMap,
    env,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use http_body_util::BodyExt;
use hyper_util::{client::legacy::Client, rt::TokioExecutor};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::user::UserId;

/// The only algorithm accepted, and the only one Rauthy is configured to use.
const ALGORITHM: &str = "EdDSA";

/// Rauthy marks access tokens with this. An ID token carries `Id` and must not
/// be accepted in place of one: it is addressed to the client, not to this
/// service, and is not evidence of a request being authorised.
const ACCESS_TOKEN_TYPE: &str = "Bearer";

/// Shortest gap between two fetches of the key set.
///
/// A token naming an unknown key triggers a refetch, which is what lets a key
/// rotation be picked up — Rauthy rotates on the 1st of each month and this
/// cannot be disabled. Unthrottled, though, a stream of tokens carrying
/// made-up key ids would turn into a request to the provider each, so a miss
/// can only cause a fetch this often.
const MIN_REFETCH: Duration = Duration::from_secs(10);

/// Why a token was refused.
///
/// Reported in the log and never to the caller, which gets a bare 401: which
/// check failed is useful to whoever runs this and is a hint to anyone else.
#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    Malformed(&'static str),
    UnsupportedAlgorithm(String),
    UnknownKey(String),
    BadSignature,
    NotAnAccessToken(String),
    WrongIssuer(String),
    WrongAudience(String),
    Expired,
    NotYetValid,
    UnusableSubject(String),
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(why) => write!(f, "malformed token: {why}"),
            Self::UnsupportedAlgorithm(alg) => write!(f, "algorithm {alg} is not accepted"),
            Self::UnknownKey(kid) => write!(f, "no published key with id {kid}"),
            Self::BadSignature => write!(f, "signature does not verify"),
            Self::NotAnAccessToken(typ) => write!(f, "token type is {typ}, not an access token"),
            Self::WrongIssuer(iss) => write!(f, "issued by {iss}"),
            Self::WrongAudience(aud) => write!(f, "addressed to {aud}"),
            Self::Expired => write!(f, "expired"),
            Self::NotYetValid => write!(f, "not valid yet"),
            Self::UnusableSubject(sub) => write!(f, "subject {sub:?} cannot name a document"),
        }
    }
}

pub struct Config {
    /// Exactly as the provider writes it. Rauthy builds this as
    /// `<scheme>://<pub_url>/auth/v1/` — the trailing slash is part of it, and
    /// a comparison without it rejects every token.
    pub issuer: String,
    pub audience: String,
    /// Tolerance on `exp` and `nbf`, for clocks that disagree.
    pub leeway: u64,
}

pub struct Auth {
    config: Config,
    keys: RwLock<KeyCache>,
    /// Where to fetch the key set. `None` in tests, which seed keys directly.
    jwks_url: Option<String>,
}

#[derive(Default)]
struct KeyCache {
    by_id: HashMap<String, VerifyingKey>,
    fetched: Option<Instant>,
}

impl Auth {
    /// Build from the environment.
    ///
    /// `None` only when `AUTH_DISABLED` says so, which the test harness uses
    /// and nothing else should. Without an issuer and without that, this
    /// returns an error rather than running: nothing else authenticates these
    /// requests any more, so a missing configuration would mean handing the
    /// document to anyone who asked.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(issuer) = env::var("AUTH_ISSUER") else {
            if env::var("AUTH_DISABLED").is_ok_and(|value| value == "true") {
                return Ok(None);
            }
            return Err("AUTH_ISSUER is not set, so no request could be \
                        authenticated. Set it, or set AUTH_DISABLED=true to \
                        run without any authentication at all."
                .to_string());
        };
        let jwks_url = env::var("AUTH_JWKS_URL")
            .map_err(|_| "AUTH_ISSUER is set but AUTH_JWKS_URL is not".to_string())?;
        let leeway = match env::var("AUTH_LEEWAY_SECS") {
            Ok(value) => value
                .parse()
                .map_err(|_| format!("AUTH_LEEWAY_SECS is not a number: {value}"))?,
            Err(_) => 60,
        };

        Ok(Some(Self {
            config: Config {
                audience: env::var("AUTH_AUDIENCE").unwrap_or_else(|_| "outliner".into()),
                issuer,
                leeway,
            },
            keys: RwLock::new(KeyCache::default()),
            jwks_url: Some(jwks_url),
        }))
    }

    pub fn describe(&self) -> String {
        format!(
            "issuer {}, audience {}",
            self.config.issuer, self.config.audience
        )
    }

    /// Check a token and return the user it belongs to.
    pub async fn verify(&self, token: &str) -> Result<UserId, Denied> {
        let mut parts = token.split('.');
        let (Some(header_b64), Some(claims_b64), Some(signature_b64), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Denied::Malformed("expected three dot-separated parts"));
        };

        let header: Header = decode_json(header_b64).ok_or(Denied::Malformed("header"))?;
        // Before any key lookup, and never used to choose how to verify.
        if header.alg != ALGORITHM {
            return Err(Denied::UnsupportedAlgorithm(header.alg));
        }
        let kid = header.kid.ok_or(Denied::Malformed("header has no kid"))?;

        let key = self
            .key(&kid)
            .await
            .ok_or_else(|| Denied::UnknownKey(kid.clone()))?;

        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .ok()
            .and_then(|bytes| <[u8; 64]>::try_from(bytes.as_slice()).ok())
            .map(|bytes: [u8; 64]| Signature::from_bytes(&bytes))
            .ok_or(Denied::Malformed("signature is not 64 bytes"))?;

        // Over the exact bytes as they arrived, not a re-encoding of the
        // decoded parts.
        let signed = &token[..header_b64.len() + 1 + claims_b64.len()];
        key.verify_strict(signed.as_bytes(), &signature)
            .map_err(|_| Denied::BadSignature)?;

        // Only now is anything in the token worth reading.
        let claims: Claims = decode_json(claims_b64).ok_or(Denied::Malformed("claims"))?;
        self.authorise(claims)
    }

    /// The claim checks, once the signature is known to be good.
    fn authorise(&self, claims: Claims) -> Result<UserId, Denied> {
        if claims.typ != ACCESS_TOKEN_TYPE {
            return Err(Denied::NotAnAccessToken(claims.typ));
        }
        if claims.iss != self.config.issuer {
            return Err(Denied::WrongIssuer(claims.iss));
        }

        let audiences = claims.aud.into_vec();
        if !audiences.iter().any(|aud| *aud == self.config.audience) {
            return Err(Denied::WrongAudience(audiences.join(",")));
        }

        let now = unix_now();
        let leeway = i64::try_from(self.config.leeway).unwrap_or(i64::MAX);
        if claims.exp + leeway < now {
            return Err(Denied::Expired);
        }
        if let Some(nbf) = claims.nbf {
            if nbf - leeway > now {
                return Err(Denied::NotYetValid);
            }
        }

        let subject = claims.sub.ok_or(Denied::Malformed("claims have no sub"))?;
        // The subject becomes a directory name, so it has to be one that
        // cannot reach outside the data directory.
        UserId::parse(&subject).ok_or(Denied::UnusableSubject(subject))
    }

    /// A key by id, fetching the key set if this one has not been seen.
    async fn key(&self, kid: &str) -> Option<VerifyingKey> {
        if let Some(key) = self.keys.read().await.by_id.get(kid) {
            return Some(*key);
        }

        let url = self.jwks_url.as_deref()?;
        // Held across the fetch on purpose: concurrent misses then wait for
        // one request rather than each making their own.
        let mut cache = self.keys.write().await;
        // Another task may have filled it while this one waited.
        if let Some(key) = cache.by_id.get(kid) {
            return Some(*key);
        }
        if cache.fetched.is_some_and(|at| at.elapsed() < MIN_REFETCH) {
            return None;
        }
        cache.fetched = Some(Instant::now());

        match fetch_keys(url).await {
            Ok(keys) => {
                crate::log(&format!("fetched {} signing key(s) from {url}", keys.len()));
                cache.by_id = keys;
            }
            Err(error) => {
                crate::log(&format!("could not fetch signing keys from {url}: {error}"));
            }
        }
        cache.by_id.get(kid).copied()
    }

    /// Load the key set now, so the first request does not pay for it.
    ///
    /// Failure is not fatal: the provider may simply not be up yet, and the
    /// next token that arrives will try again.
    pub async fn prefetch(&self) {
        let Some(url) = self.jwks_url.as_deref() else {
            return;
        };
        let mut cache = self.keys.write().await;
        cache.fetched = Some(Instant::now());
        match fetch_keys(url).await {
            Ok(keys) => {
                crate::log(&format!("fetched {} signing key(s) from {url}", keys.len()));
                cache.by_id = keys;
            }
            Err(error) => crate::log(&format!(
                "could not fetch signing keys from {url} yet ({error}); \
                 will retry when a token arrives"
            )),
        }
    }
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: Option<String>,
    aud: Audience,
    exp: i64,
    nbf: Option<i64>,
    typ: String,
}

/// `aud` is a single string or a list of them, and Rauthy sends both shapes.
#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(one) => vec![one],
            Self::Many(many) => many,
        }
    }
}

fn decode_json<T: for<'de> Deserialize<'de>>(part: &str) -> Option<T> {
    let bytes = URL_SAFE_NO_PAD.decode(part).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| i64::try_from(since.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

// -- the key set --------------------------------------------------------------

#[derive(Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    crv: Option<String>,
    /// The public key, base64url with no padding.
    x: Option<String>,
    kid: Option<String>,
}

/// Fetch and parse the key set, keeping only the Ed25519 keys.
///
/// Plain HTTP with no TLS stack, because this call never leaves the container
/// network: the provider is reached by its service name, not through the
/// public address that appears in the token's issuer.
async fn fetch_keys(url: &str) -> Result<HashMap<String, VerifyingKey>, String> {
    let uri: hyper::Uri = url.parse().map_err(|error| format!("bad url: {error}"))?;
    // No request body, so the type the client would send has to be named.
    let client = Client::builder(TokioExecutor::new()).build_http::<String>();
    let response = client
        .get(uri)
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("answered {}", response.status()));
    }
    let body = response
        .into_body()
        .collect()
        .await
        .map_err(|error| format!("could not read the body: {error}"))?
        .to_bytes();

    let set: JwkSet =
        serde_json::from_slice(&body).map_err(|error| format!("not a key set: {error}"))?;

    let mut keys = HashMap::new();
    for jwk in set.keys {
        // Rauthy publishes its RSA keys alongside the Ed25519 one. Skipping
        // them is not an error; they are simply never used here.
        if jwk.kty != "OKP" || jwk.crv.as_deref() != Some("Ed25519") {
            continue;
        }
        let (Some(kid), Some(x)) = (jwk.kid, jwk.x) else {
            continue;
        };
        let Some(key) = URL_SAFE_NO_PAD
            .decode(&x)
            .ok()
            .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
            .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
        else {
            continue;
        };
        keys.insert(kid, key);
    }

    if keys.is_empty() {
        return Err("the key set has no Ed25519 keys".to_string());
    }
    Ok(keys)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const ISSUER: &str = "https://outliner.example/auth/v1/";
    pub(crate) const SUBJECT: &str = "outlinerkimstebel0000001";

    pub(crate) fn user(subject: &str) -> UserId {
        UserId::parse(subject).expect("usable subject")
    }
    const KID: &str = "test-key";

    fn signing_key() -> SigningKey {
        // Fixed, so the suite needs no randomness and a failure is repeatable.
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// An `Auth` with the test key already in the cache and no URL, so nothing
    /// in this module can reach the network.
    pub(crate) fn auth() -> Auth {
        let mut by_id = HashMap::new();
        by_id.insert(KID.to_string(), signing_key().verifying_key());
        Auth {
            config: Config {
                issuer: ISSUER.to_string(),
                audience: "outliner".to_string(),
                leeway: 60,
            },
            keys: RwLock::new(KeyCache {
                by_id,
                fetched: Some(Instant::now()),
            }),
            jwks_url: None,
        }
    }

    fn encode(value: &serde_json::Value) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).expect("json"))
    }

    /// A token signed with the test key, from whatever header and claims.
    pub(crate) fn sign(header: serde_json::Value, claims: serde_json::Value) -> String {
        let signed = format!("{}.{}", encode(&header), encode(&claims));
        let signature = signing_key().sign(signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    pub(crate) fn header() -> serde_json::Value {
        serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": KID })
    }

    fn claims() -> serde_json::Value {
        let now = unix_now();
        serde_json::json!({
            "iss": ISSUER,
            "sub": SUBJECT,
            "aud": "outliner",
            "typ": "Bearer",
            "iat": now,
            "nbf": now,
            "exp": now + 3600,
        })
    }

    pub(crate) fn token() -> String {
        sign(header(), claims())
    }

    /// Claims with one field replaced.
    pub(crate) fn claims_with(key: &str, value: serde_json::Value) -> serde_json::Value {
        let mut c = claims();
        c[key] = value;
        c
    }

    #[tokio::test]
    async fn a_good_token_names_its_subject() {
        assert_eq!(auth().verify(&token()).await, Ok(user(SUBJECT)));
    }

    // -- the attacks that matter ---------------------------------------------

    #[tokio::test]
    async fn an_unsigned_token_is_refused() {
        // `alg: none` with an empty signature: the oldest JWT bug there is.
        let signed = format!(
            "{}.{}",
            encode(&serde_json::json!({ "alg": "none", "kid": KID })),
            encode(&claims())
        );
        let result = auth().verify(&format!("{signed}.")).await;
        assert_eq!(
            result,
            Err(Denied::UnsupportedAlgorithm("none".to_string()))
        );
    }

    #[tokio::test]
    async fn a_token_claiming_a_symmetric_algorithm_is_refused() {
        // Algorithm confusion: sign with the public key as an HMAC secret and
        // hope the verifier dispatches on the header. Refused before any key
        // is looked up, so the trick has nothing to work with.
        let result = auth()
            .verify(&sign(
                serde_json::json!({ "alg": "HS256", "kid": KID }),
                claims(),
            ))
            .await;
        assert_eq!(
            result,
            Err(Denied::UnsupportedAlgorithm("HS256".to_string()))
        );
    }

    #[tokio::test]
    async fn a_token_signed_by_another_key_is_refused() {
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let signed = format!("{}.{}", encode(&header()), encode(&claims()));
        let signature = other.sign(signed.as_bytes());
        let forged = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));
        assert_eq!(auth().verify(&forged).await, Err(Denied::BadSignature));
    }

    #[tokio::test]
    async fn an_edited_payload_is_refused() {
        // The subject swapped for an allowed one, signature left alone.
        let good = token();
        let (signed, signature) = good.rsplit_once('.').expect("signature");
        let (header_b64, _) = signed.split_once('.').expect("header");
        let tampered = format!(
            "{header_b64}.{}.{signature}",
            encode(&claims_with("sub", serde_json::json!("somebody-else")))
        );
        assert_eq!(auth().verify(&tampered).await, Err(Denied::BadSignature));
    }

    #[tokio::test]
    async fn an_id_token_is_not_accepted_as_an_access_token() {
        // Same issuer, same subject, same signature — but addressed to the
        // client rather than to this service.
        let result = auth()
            .verify(&sign(header(), claims_with("typ", serde_json::json!("Id"))))
            .await;
        assert_eq!(result, Err(Denied::NotAnAccessToken("Id".to_string())));
    }

    #[tokio::test]
    async fn a_valid_token_for_someone_else_is_their_own_user() {
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("sub", serde_json::json!("a-stranger0000000000000x")),
            ))
            .await;
        assert_eq!(result, Ok(user("a-stranger0000000000000x")));
    }

    #[tokio::test]
    async fn a_subject_that_is_not_a_safe_directory_name_is_refused() {
        // Properly signed, so this is about what the provider might issue, not
        // about forgery: the subject is used as a path component.
        for sub in ["", "..", "../elsewhere", "a/b"] {
            let result = auth()
                .verify(&sign(header(), claims_with("sub", serde_json::json!(sub))))
                .await;
            assert_eq!(
                result,
                Err(Denied::UnusableSubject(sub.to_string())),
                "{sub:?}"
            );
        }
    }

    // -- the ordinary checks -------------------------------------------------

    #[tokio::test]
    async fn an_expired_token_is_refused() {
        let now = unix_now();
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("exp", serde_json::json!(now - 3600)),
            ))
            .await;
        assert_eq!(result, Err(Denied::Expired));
    }

    #[tokio::test]
    async fn a_token_from_the_future_is_refused() {
        let now = unix_now();
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("nbf", serde_json::json!(now + 3600)),
            ))
            .await;
        assert_eq!(result, Err(Denied::NotYetValid));
    }

    #[tokio::test]
    async fn small_clock_differences_are_tolerated() {
        let now = unix_now();
        // Both inside the 60s leeway.
        assert!(auth()
            .verify(&sign(
                header(),
                claims_with("exp", serde_json::json!(now - 30))
            ))
            .await
            .is_ok());
        assert!(auth()
            .verify(&sign(
                header(),
                claims_with("nbf", serde_json::json!(now + 30))
            ))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_token_from_another_issuer_is_refused() {
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("iss", serde_json::json!("https://elsewhere/auth/v1/")),
            ))
            .await;
        assert_eq!(
            result,
            Err(Denied::WrongIssuer(
                "https://elsewhere/auth/v1/".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn the_issuers_trailing_slash_is_part_of_it() {
        // Rauthy writes `<pub_url>/auth/v1/`. Dropping the slash is the most
        // likely configuration mistake, and it must not be forgiven here.
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("iss", serde_json::json!("https://outliner.example/auth/v1")),
            ))
            .await;
        assert!(matches!(result, Err(Denied::WrongIssuer(_))));
    }

    #[tokio::test]
    async fn a_token_for_another_audience_is_refused() {
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("aud", serde_json::json!("some-other-app")),
            ))
            .await;
        assert_eq!(
            result,
            Err(Denied::WrongAudience("some-other-app".to_string()))
        );
    }

    #[tokio::test]
    async fn an_audience_list_containing_us_is_accepted() {
        let result = auth()
            .verify(&sign(
                header(),
                claims_with("aud", serde_json::json!(["something-else", "outliner"])),
            ))
            .await;
        assert_eq!(result, Ok(user(SUBJECT)));
    }

    #[tokio::test]
    async fn an_unknown_key_is_refused_without_reaching_the_network() {
        let result = auth()
            .verify(&sign(
                serde_json::json!({ "alg": "EdDSA", "kid": "rotated-away" }),
                claims(),
            ))
            .await;
        assert_eq!(result, Err(Denied::UnknownKey("rotated-away".to_string())));
    }

    #[tokio::test]
    async fn rubbish_is_refused_rather_than_panicking() {
        let auth = auth();
        for nonsense in [
            "",
            "....",
            "one.two",
            "one.two.three.four",
            "!!!.!!!.!!!",
            "eyJhbGciOiJFZERTQSJ9",
        ] {
            assert!(
                auth.verify(nonsense).await.is_err(),
                "accepted {nonsense:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_short_signature_is_refused() {
        let signed = format!("{}.{}", encode(&header()), encode(&claims()));
        let truncated = format!("{signed}.{}", URL_SAFE_NO_PAD.encode([0u8; 32]));
        assert!(auth().verify(&truncated).await.is_err());
    }

    #[tokio::test]
    async fn a_token_with_no_subject_is_refused() {
        let mut c = claims();
        c.as_object_mut().expect("object").remove("sub");
        assert_eq!(
            auth().verify(&sign(header(), c)).await,
            Err(Denied::Malformed("claims have no sub"))
        );
    }

    #[test]
    fn a_key_set_keeps_only_the_ed25519_keys() {
        // Shaped like what Rauthy publishes: three RSA keys and one Ed25519.
        let x = URL_SAFE_NO_PAD.encode(signing_key().verifying_key().to_bytes());
        let set = serde_json::json!({
            "keys": [
                { "kty": "RSA", "alg": "RS256", "kid": "rsa-1", "n": "...", "e": "AQAB" },
                { "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "kid": KID, "x": x },
                { "kty": "OKP", "crv": "X25519", "kid": "wrong-curve", "x": x },
            ]
        });
        let parsed: JwkSet = serde_json::from_value(set).expect("parse");
        let mut keys = HashMap::new();
        for jwk in parsed.keys {
            if jwk.kty != "OKP" || jwk.crv.as_deref() != Some("Ed25519") {
                continue;
            }
            if let (Some(kid), Some(x)) = (jwk.kid, jwk.x) {
                let bytes = URL_SAFE_NO_PAD.decode(&x).expect("decode");
                let bytes = <[u8; 32]>::try_from(bytes.as_slice()).expect("32 bytes");
                keys.insert(kid, VerifyingKey::from_bytes(&bytes).expect("key"));
            }
        }
        assert_eq!(keys.len(), 1);
        assert!(keys.contains_key(KID));
    }
}
