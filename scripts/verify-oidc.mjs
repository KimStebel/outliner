/**
 * Proves what the backend is about to depend on, against a real Rauthy.
 *
 * Phase 1 of the auth plan established the token shape by reading Rauthy's
 * source. This checks that reading was right, end to end: it drives the real
 * login page, exchanges the code with PKCE, verifies the signature against the
 * published JWKS, and asserts every claim the backend will validate — before
 * any of that validation exists in Rust to be debugged.
 *
 * The signature check matters most. If Ed25519 verification against the JWKS
 * works here, the only thing left for the backend is plumbing.
 *
 * Usage: ./deploy/rauthy/rauthy-local.sh && node scripts/verify-oidc.mjs
 */

import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { chromium } from 'playwright'

// Fixed by deploy/rauthy/: `pub_url`, the client's redirect_uri, and the
// pinned user id all name these. They are not free parameters.
const ORIGIN = 'http://localhost:8080'
const ISSUER = `${ORIGIN}/auth/v1/`
const CLIENT_ID = 'outliner'
// Identical to the real client but with a 70s access token, which puts its
// refresh token's `nbf` 10 seconds out instead of nearly a day. Local only;
// see deploy/rauthy/rauthy-local.sh.
const PROBE_CLIENT_ID = 'outliner-refresh-probe'
const PROBE_TOKEN_SECONDS = 70
const SUBJECT = 'outlinerkimstebel0000001'
const EMAIL = 'kim@localhost'
const PASSWORD = 'LocalUserPassword123!'
// Rauthy's hard cap: `10 <= access_token_lifetime <= 86400`.
const ACCESS_TOKEN_SECONDS = 86400
const REFRESH_TOKEN_DAYS = 30

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function equal(label, actual, expected) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  )
}

const b64url = (buffer) => buffer.toString('base64url')
const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString())

function decodeJwt(token) {
  const [header, payload, signature] = token.split('.')
  return {
    header: decodePart(header),
    claims: decodePart(payload),
    signature,
    signed: `${header}.${payload}`,
  }
}

async function reachable(url) {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    if (await reachable(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

// -- the server on :8080 ------------------------------------------------------

// Rauthy has to be reached on the app's own origin, not on its own port: the
// issuer, the cookies and the Host check all assume one origin. In production
// Caddy does this; in dev the Vite proxy does.
let devServer = null

if (await reachable(`${ORIGIN}/auth/v1/health`)) {
  console.log(`Using the server already on ${ORIGIN}`)
} else if (!(await reachable('http://127.0.0.1:8081/auth/v1/health'))) {
  console.error('Rauthy is not running. Start it with:')
  console.error('  ./deploy/rauthy/rauthy-local.sh')
  process.exit(1)
} else {
  console.log(`Starting the dev server for the /auth proxy`)
  devServer = spawn('npm', ['run', 'dev'], { stdio: 'ignore' })
  if (!(await waitFor(`${ORIGIN}/auth/v1/health`))) {
    console.error(`${ORIGIN}/auth/v1/health never came up`)
    devServer.kill('SIGTERM')
    process.exit(1)
  }
}

// -- the authorization code flow ---------------------------------------------

const browser = await chromium.launch()

/**
 * The full authorization code flow in a real browser, for one client.
 *
 * Driven rather than called directly because `POST /oidc/authorize` wants a
 * proof-of-work token that the login page's own script computes.
 */
async function login(clientId) {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const redirectUri = `${ORIGIN}/`

  const page = await browser.newPage()
  // The redirect lands on the app itself, which has no part in what is being
  // tested and would start syncing. Answer it with a stub so the flow
  // completes without loading it.
  await page.route(
    (url) => url.origin === ORIGIN && url.pathname === '/',
    (route) => route.fulfill({ status: 200, body: 'landed' }),
  )

  const authorizeUrl =
    `${ORIGIN}/auth/v1/oidc/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

  await page.goto(authorizeUrl, { waitUntil: 'networkidle' })
  const title = await page.title()
  const onOrigin = page.url().startsWith(ORIGIN)

  // Ids on this page are randomised per render, so go by type.
  //
  // Two steps: the password field exists from the start but stays hidden until
  // the email has been submitted, so it cannot simply be filled in up front.
  const password = page.locator('input[type=password]')
  await page.locator('input[type=email]').fill(EMAIL)
  await page.locator('button[type=submit]').click()
  await password.waitFor({ state: 'visible', timeout: 20_000 })
  await password.fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(
    (url) => url.pathname === '/' && url.searchParams.has('code'),
    { timeout: 20_000 },
  )

  const landed = new URL(page.url())
  await page.close()

  const exchanged = await tokenRequest({
    grant_type: 'authorization_code',
    code: landed.searchParams.get('code'),
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  })

  return {
    onOrigin,
    title,
    code: landed.searchParams.get('code'),
    stateBack: landed.searchParams.get('state'),
    stateSent: state,
    exchanged,
  }
}

// -- the token exchange ------------------------------------------------------

async function tokenRequest(body) {
  const response = await fetch(`${ORIGIN}/auth/v1/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

const signedIn = await login(CLIENT_ID)

console.log('\nthe login page')
check('is served on the app origin', signedIn.onOrigin)
check(
  'knows which client it is for',
  signedIn.title.includes('Outliner'),
  signedIn.title,
)

console.log('\nthe redirect back')
check(
  'carries an authorization code',
  signedIn.code !== null && signedIn.code.length > 0,
)
equal('returns the state unchanged', signedIn.stateBack, signedIn.stateSent)

console.log('\nthe token exchange')
equal('succeeds', signedIn.exchanged.status, 200)

const tokens = signedIn.exchanged.json ?? {}
check('returns an access token', typeof tokens.access_token === 'string')
check(
  'returns a refresh token',
  typeof tokens.refresh_token === 'string',
  // Without this, option B is off the table and a password is needed daily.
  'no refresh token: check `refresh_token` is in the client flows_enabled',
)
equal('says the token is a Bearer', tokens.token_type, 'Bearer')
equal('issues it for 24h', tokens.expires_in, ACCESS_TOKEN_SECONDS)

// -- the access token, claim by claim ----------------------------------------

const access = decodeJwt(tokens.access_token)

console.log('\nthe access token header')
equal('is signed with EdDSA', access.header.alg, 'EdDSA')
check('names the key that signed it', typeof access.header.kid === 'string')

console.log('\nits signature')
const jwks = await (await fetch(`${ORIGIN}/auth/v1/oidc/certs`)).json()
const jwk = jwks.keys.find((k) => k.kid === access.header.kid)
check('was made by a key the JWKS publishes', jwk !== undefined, access.header.kid)
if (jwk !== undefined) {
  equal('an Ed25519 key', [jwk.kty, jwk.crv], ['OKP', 'Ed25519'])
  // The whole backend rests on this working.
  check(
    'verifies against that key',
    verify(
      null,
      Buffer.from(access.signed),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(access.signature, 'base64url'),
    ),
  )
  check(
    'and fails if a single byte of the payload is changed',
    !verify(
      null,
      Buffer.from(`${access.signed}x`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(access.signature, 'base64url'),
    ),
  )
}

console.log('\nits claims')
// The trailing slash is part of the issuer. Rauthy builds it as
// `<scheme>://<pub_url>/auth/v1/`, and a comparison without it rejects
// everything.
equal('iss is the issuer, trailing slash included', access.claims.iss, ISSUER)
check(
  'aud names this client',
  [].concat(access.claims.aud).includes(CLIENT_ID),
  JSON.stringify(access.claims.aud),
)
// Distinguishes an access token from an ID token, which must not be accepted
// in its place.
equal('typ marks it an access token', access.claims.typ, 'Bearer')
equal('sub is the user the backend will authorise', access.claims.sub, SUBJECT)
equal('scope is what was asked for', access.claims.scope, 'openid email')
equal('email came through', access.claims.email, EMAIL)
equal(
  'lives exactly as long as configured',
  access.claims.exp - access.claims.iat,
  ACCESS_TOKEN_SECONDS,
)

console.log('\nthe id token is not interchangeable with it')
const id = decodeJwt(tokens.id_token)
equal('its typ differs', id.claims.typ, 'Id')
equal('though it is the same subject', id.claims.sub, SUBJECT)

// -- the refresh token -------------------------------------------------------

console.log('\nthe refresh token')
const refresh = decodeJwt(tokens.refresh_token)
equal('is marked as one', refresh.claims.typ, 'Refresh')

// This is the part that is easy to get wrong when writing the client. A
// refresh token is not valid from the moment it is issued: Rauthy sets
//
//   nbf = now + access_token_lifetime - 60s
//   exp = nbf + refresh_token_lifetime
//
// so it cannot be redeemed until the access token has 60 seconds left, and the
// span from iat to exp is a month *plus* the access token's lifetime. A client
// that tries to refresh early — the usual "renew at half life" approach — gets
// a 401 every time.
equal(
  'cannot be used until the access token is nearly expired',
  refresh.claims.nbf - refresh.claims.iat,
  ACCESS_TOKEN_SECONDS - 60,
)
equal(
  `is then good for ${REFRESH_TOKEN_DAYS} days`,
  Math.round((refresh.claims.exp - refresh.claims.nbf) / 86400),
  REFRESH_TOKEN_DAYS,
)

console.log('\nredeeming it too early')
const tooEarly = await tokenRequest({
  grant_type: 'refresh_token',
  refresh_token: tokens.refresh_token,
  client_id: CLIENT_ID,
})
equal('is refused', tooEarly.status, 401)

// -- redeeming one for real --------------------------------------------------

// Waiting out the real client's 24h is not an option, so this uses a client
// that is identical except for a 70 second access token. That puts its refresh
// nbf 10 seconds out, which is worth waiting for: it exercises the actual nbf
// rule rather than turning it off.
console.log(`\nredeeming one inside its window (via ${PROBE_CLIENT_ID})`)
const probe = await login(PROBE_CLIENT_ID)
equal('the probe client signs in', probe.exchanged.status, 200)
const probeTokens = probe.exchanged.json ?? {}
equal('with a short access token', probeTokens.expires_in, PROBE_TOKEN_SECONDS)

const probeRefresh = decodeJwt(probeTokens.refresh_token)
const waitMs = (probeRefresh.claims.nbf - Math.floor(Date.now() / 1000) + 2) * 1000
console.log(`  (waiting ${Math.max(0, Math.round(waitMs / 1000))}s for nbf)`)
if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))

const refreshed = await tokenRequest({
  grant_type: 'refresh_token',
  refresh_token: probeTokens.refresh_token,
  client_id: PROBE_CLIENT_ID,
})
equal('succeeds', refreshed.status, 200)
const renewed = refreshed.json ?? {}
check('yields a new access token', typeof renewed.access_token === 'string')
check(
  'which is not the one we had',
  renewed.access_token !== probeTokens.access_token,
)
check(
  'and a new refresh token, so they rotate',
  typeof renewed.refresh_token === 'string' &&
    renewed.refresh_token !== probeTokens.refresh_token,
)
if (typeof renewed.access_token === 'string') {
  const next = decodeJwt(renewed.access_token)
  // No second password prompt happened to get here: this is the whole point
  // of the refresh token, and why a month between logins is achievable
  // despite the 24h cap on access tokens.
  equal('for the same subject, with no new login', next.claims.sub, SUBJECT)
  equal('and the issuer unchanged', next.claims.iss, ISSUER)
}

// -- an unknown kid must be refetchable --------------------------------------

// The signing keys rotate on the 1st of each month and it cannot be turned
// off, so the backend's JWKS cache has to refetch on a kid it does not know.
// This only checks the lookup exists; the backend's own tests cover the cache.
console.log('\nper-key lookup, for refetching after a rotation')
const byKid = await fetch(`${ORIGIN}/auth/v1/oidc/certs/${access.header.kid}`)
equal('a known kid resolves', byKid.status, 200)

// -- done --------------------------------------------------------------------

await browser.close()
devServer?.kill('SIGTERM')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
