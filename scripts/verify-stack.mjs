/**
 * The auth rules, against the real stack.
 *
 * `verify-oidc.mjs` checks what the provider issues. This checks what happens
 * to it afterwards: that Caddy lets a bearer token past without also demanding
 * basic auth, that the backend refuses a bad one, that Rauthy's own pages do
 * not get the app's content-security policy stapled to them, and that a user
 * can sign in through the app and have sync start working.
 *
 * None of that is visible from the unit suites. Caddy's matcher, the service
 * worker's handling of the login redirect, and the two-way split between
 * basic auth and bearer tokens only exist once everything is wired together.
 *
 * Usage: ./deploy/stack-local.sh && node scripts/verify-stack.mjs
 */

import { createHash, randomBytes } from 'node:crypto'
import { chromium } from 'playwright'

const ORIGIN = 'http://localhost:8080'
const CLIENT_ID = 'outliner'
const EMAIL = 'kim@localhost'
const PASSWORD = 'LocalUserPassword123!'

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

async function api(path, init = {}) {
  return fetch(`${ORIGIN}${path}`, { cache: 'no-store', ...init })
}

if (
  !(await api('/auth/v1/health')
    .then((r) => r.ok)
    .catch(() => false))
) {
  console.error('The stack is not running. Start it with:')
  console.error('  ./deploy/stack-local.sh')
  process.exit(1)
}

// -- who gets past the proxy -------------------------------------------------

console.log('\nan unauthenticated request')
const bare = await api('/api/doc')
equal('is refused', bare.status, 401)
check(
  'and asks for a bearer token, there being nothing else now',
  (bare.headers.get('WWW-Authenticate') ?? '').toLowerCase().includes('bearer'),
  bare.headers.get('WWW-Authenticate') ?? 'no header',
)

console.log('\nbasic credentials')
const withBasic = await api('/api/doc', {
  headers: {
    Authorization: `Basic ${Buffer.from('kim:whatever').toString('base64')}`,
  },
})
equal('no longer get anywhere', withBasic.status, 401)

console.log('\na bearer token that does not verify')
const badBearer = await api('/api/doc', {
  headers: { Authorization: 'Bearer not.a.real.token' },
})
equal('is refused', badBearer.status, 401)

// -- headers -----------------------------------------------------------------

console.log('\nthe app')
const shell = await api('/')
equal('is served', shell.status, 200)
const appCsp = shell.headers.get('Content-Security-Policy') ?? ''
check('is locked to its own origin', appCsp.includes("connect-src 'self'"), appCsp)
check(
  'and cannot submit a form anywhere',
  appCsp.includes("form-action 'none'"),
  appCsp,
)

console.log("\nthe provider's own pages")
const discovery = await api('/auth/v1/.well-known/openid-configuration')
equal('are reachable without credentials', discovery.status, 200)
const authCsp = discovery.headers.get('Content-Security-Policy') ?? ''
// Our policy must not reach them. `form-action 'none'` applied to a login page
// is exactly the kind of breakage that only shows up when someone tries to
// sign in.
check(
  "do not get the app's policy stapled on",
  !authCsp.includes("form-action 'none'"),
  authCsp,
)
equal(
  'and advertise the issuer the backend expects',
  (await discovery.json()).issuer,
  `${ORIGIN}/auth/v1/`,
)

// -- a real token ------------------------------------------------------------

const browser = await chromium.launch()

/** Sign in through the real login page and return the tokens. */
async function signIn(page) {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${ORIGIN}/`,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  await page.goto(`${ORIGIN}/auth/v1/oidc/authorize?${query}`, {
    waitUntil: 'networkidle',
  })

  const password = page.locator('input[type=password]')
  await page.locator('input[type=email]').fill(EMAIL)
  await page.locator('button[type=submit]').click()
  await password.waitFor({ state: 'visible', timeout: 20_000 })
  await password.fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.waitForURL((url) => url.searchParams.has('code'), { timeout: 20_000 })

  const code = new URL(page.url()).searchParams.get('code')
  const response = await fetch(`${ORIGIN}/auth/v1/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${ORIGIN}/`,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })
  return response.json()
}

const tokenPage = await browser.newPage()
// Keep the app itself out of this part; it gets its own section below.
await tokenPage.route(
  (url) => url.origin === ORIGIN && url.pathname === '/',
  (route) => route.fulfill({ status: 200, body: 'landed' }),
)
const tokens = await signIn(tokenPage)
await tokenPage.close()

console.log('\na real bearer token')
check('was issued', typeof tokens.access_token === 'string')
const bearer = { Authorization: `Bearer ${tokens.access_token}` }

const read = await api('/api/doc', { headers: bearer })
check(
  'gets past both Caddy and the backend',
  read.status !== 401,
  `got ${read.status}`,
)

console.log('\nwriting with it')
// A real document, not a token of one: the app section below syncs against
// whatever is stored here, and it rightly refuses to adopt something it
// cannot read — which looked like a sync bug the first time round.
const body = JSON.stringify({
  version: 1,
  doc: {
    rootId: 'root',
    items: {
      root: {
        id: 'root',
        text: '',
        parent: null,
        children: ['a'],
        collapsed: false,
      },
      a: {
        id: 'a',
        text: 'written by the stack check',
        parent: 'root',
        children: [],
        collapsed: false,
      },
    },
  },
})
const first = await api('/api/doc', {
  method: 'PUT',
  headers: { ...bearer, 'Content-Type': 'application/json' },
  // Only sent unconditionally if nothing is stored; otherwise name the
  // version being replaced, as any client has to.
  ...(read.status === 200
    ? {
        headers: {
          ...bearer,
          'Content-Type': 'application/json',
          'If-Match': read.headers.get('ETag'),
        },
      }
    : {}),
  body,
})
check('is accepted', first.status === 204, `got ${first.status}`)
check('and returns an entity tag', first.headers.get('ETag') !== null)

const back = await api('/api/doc', { headers: bearer })
equal('and reading it back gives what was written', await back.text(), body)

console.log('\na token with its payload edited')
// Same signature, different claims: the subject swapped for someone else.
const [header, , signature] = tokens.access_token.split('.')
const forgedClaims = Buffer.from(
  JSON.stringify({
    ...JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString(),
    ),
    sub: 'somebodyelse00000000aaaa',
  }),
).toString('base64url')
const forged = await api('/api/doc', {
  headers: { Authorization: `Bearer ${header}.${forgedClaims}.${signature}` },
})
equal('is refused', forged.status, 401)

// -- the app, signing in for itself ------------------------------------------

console.log('\nthe app with no session')
const page = await browser.newPage()
await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' })

// The service worker has to be in charge before the login redirect is
// followed, or the part that could break it is not being tested: its navigate
// handler answers from cache, and without the /auth bypass it would serve the
// app shell instead of the login page.
const controlled = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready
  return registration.active !== null
})
check('has its service worker installed', controlled)

const indicator = page.locator('.status')
await indicator.filter({ hasText: 'Sign in' }).waitFor({ timeout: 20_000 })
check('reports that it needs a sign-in', true)

console.log('\nsigning in from the app')
await indicator.filter({ hasText: 'Sign in' }).click()
await page.waitForURL((url) => url.pathname.startsWith('/auth/'), {
  timeout: 20_000,
})
await page
  .locator('input[type=email]')
  .waitFor({ state: 'visible', timeout: 20_000 })
// The app shell would have no email field and would be titled plain
// "Outliner". Getting the provider's own page here is what proves the service
// worker let the navigation through instead of answering it from cache.
check(
  'reaches the real login page, not the cached app shell',
  (await page.title()).startsWith('Login'),
  await page.title(),
)

const appPassword = page.locator('input[type=password]')
await page.locator('input[type=email]').fill(EMAIL)
await page.locator('button[type=submit]').click()
await appPassword.waitFor({ state: 'visible', timeout: 20_000 })
await appPassword.fill(PASSWORD)
await page.locator('button[type=submit]').click()

await page.waitForURL(
  (url) => url.origin === ORIGIN && !url.pathname.startsWith('/auth/'),
  { timeout: 20_000 },
)

console.log('\nback in the app')
// Waited for rather than asserted outright: the redirect arrives before the
// app has run, and it is the app that tidies the query.
await page
  .waitForURL((url) => !url.search.includes('code='), { timeout: 20_000 })
  .catch(() => {})
check(
  'the code is cleared from the address bar',
  !page.url().includes('code='),
  page.url(),
)

// Sync should now be working on a token alone — no basic credentials are in
// this browser at all.
await indicator
  .filter({ hasText: /Saved|Updated|Unsaved|Saving/ })
  .waitFor({ timeout: 30_000 })
check('sync stops reporting a sign-in is needed', true)

// What was stored before signing in should now be on screen: the token was
// enough to read the document, not merely to be let through.
check(
  'and the document written earlier is what is shown',
  (await page.locator('.row').first().textContent())?.includes(
    'written by the stack check',
  ) === true,
  (await page.locator('.row').first().textContent()) ?? '',
)

const settled = await indicator.textContent()
check(
  `and settles on something healthy (${settled?.trim()})`,
  /Saved|Updated/.test(settled ?? ''),
  settled ?? '',
)

// A reload must not need another sign-in: that is what the refresh token and
// the stored session are for.
await page.reload({ waitUntil: 'networkidle' })
await indicator.filter({ hasText: /Saved|Updated/ }).waitFor({ timeout: 30_000 })
check('and the session survives a reload', true)

await browser.close()

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
