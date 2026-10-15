/**
 * Did the deployment land?
 *
 * This asks about configuration and plumbing, not behaviour: is the right
 * build live, is it reachable over a valid certificate, are the headers and
 * auth wired up, does the API answer. Behaviour belongs to the unit suites
 * and to `npm run e2e`, which run against instances they own.
 *
 * Nothing here writes. Writes are blocked at the network layer, and the
 * stored document's ETag is compared at the start and the end to prove it —
 * an earlier version of this suite wrote to production and destroyed the
 * document it was meant to be checking.
 *
 * Usage: npm run build && node scripts/smoke-prod.mjs [url]
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chromium, request } from 'playwright'

const BASE = process.argv[2] ?? 'https://outliner.stebel.kim'
const API = `${BASE}/api/doc`
const CLIENT_ID = 'outliner'

const [email, ...secret] = readFileSync('prod-rauthy-user', 'utf8')
  .trim()
  .split(':')
const password = secret.join(':')

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const anonymous = await request.newContext()

/**
 * Sign in for real, and come back with an access token.
 *
 * There is no other way to read the document now that basic auth is gone, so
 * every run of this check also proves that signing in works — which nothing
 * automated did before.
 *
 * Read-only throughout: the app is intercepted so it cannot load, because
 * loading it would start sync, and sync writes.
 */
async function accessToken() {
  const b64url = (buffer) => buffer.toString('base64url')
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.route(
    (url) => url.origin === BASE && !url.pathname.startsWith('/auth/'),
    (route) => route.fulfill({ status: 200, body: 'intercepted' }),
  )

  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${BASE}/`,
    response_type: 'code',
    scope: 'openid email',
    state: b64url(randomBytes(16)),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  try {
    await page.goto(`${BASE}/auth/v1/oidc/authorize?${query}`, {
      waitUntil: 'networkidle',
    })
    const field = page.locator('input[type=password]')
    await page.locator('input[type=email]').fill(email)
    await page.locator('button[type=submit]').click()
    await field.waitFor({ state: 'visible', timeout: 20_000 })
    await field.fill(password)
    await page.locator('button[type=submit]').click()
    await page.waitForURL((url) => url.searchParams.has('code'), {
      timeout: 20_000,
    })
    const code = new URL(page.url()).searchParams.get('code')
    await browser.close()

    const exchanged = await anonymous.post(`${BASE}/auth/v1/oidc/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE}/`,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    })
    if (!exchanged.ok()) return null
    return (await exchanged.json()).access_token ?? null
  } catch {
    await browser.close()
    return null
  }
}

console.log('\nreachable')
const root = await anonymous.get(`${BASE}/`)
check(
  'the site answers 200 over https',
  root.status() === 200,
  String(root.status()),
)
const insecure = await anonymous.get(BASE.replace('https://', 'http://'), {
  maxRedirects: 0,
})
check(
  'plain http redirects',
  insecure.status() >= 300 && insecure.status() < 400,
  String(insecure.status()),
)

console.log('\nthe live build is the one that was deployed')
// The check this suite exists for. "The deploy silently did not take effect"
// has happened twice here — a file watcher that saw nothing, and a Caddy that
// was never reloaded — and nothing else would have noticed.
// Compare the whole shell rather than one asset reference: it names every
// hashed bundle, so a change to the CSS alone is caught as readily as a
// change to the JS.
const assetPattern = /\/assets\/[A-Za-z0-9_.-]+/g
const assetsIn = (html) => (html.match(assetPattern) ?? []).sort()

const localShell = readFileSync('dist/index.html', 'utf8').trim()
const liveShell = (await root.text()).trim()
const localAssets = assetsIn(localShell)
const liveAssets = assetsIn(liveShell)

check(
  'the server is serving the build in dist/',
  liveShell === localShell,
  localAssets.join(' ') === liveAssets.join(' ')
    ? 'the same assets, but the shell differs'
    : `live names ${liveAssets.join(' ')}, dist/ names ${localAssets.join(' ')}`,
)

const liveAsset = liveAssets.find((path) => path.endsWith('.js'))

console.log('\nheaders')
const headers = root.headers()
for (const [name, expected] of [
  ['strict-transport-security', /max-age=\d+/],
  ['content-security-policy', /default-src 'self'/],
  ['x-content-type-options', /nosniff/],
  ['x-frame-options', /DENY/],
  ['referrer-policy', /no-referrer/],
]) {
  check(
    `${name} is set`,
    expected.test(headers[name] ?? ''),
    headers[name] ?? '(absent)',
  )
}
check(
  'the shell is revalidated, so a deploy reaches people',
  /no-cache/.test(headers['cache-control'] ?? ''),
  headers['cache-control'] ?? '(absent)',
)
const asset = await anonymous.get(`${BASE}${liveAsset}`)
check(
  'hashed assets are immutable',
  /immutable/.test(asset.headers()['cache-control'] ?? ''),
  asset.headers()['cache-control'] ?? '(absent)',
)
const worker = await anonymous.get(`${BASE}/sw.js`)
check(
  'the service worker is revalidated too',
  /no-cache/.test(worker.headers()['cache-control'] ?? ''),
  worker.headers()['cache-control'] ?? '(absent)',
)

console.log('\nauth')
const unauthenticated = await anonymous.get(API)
check('the API refuses anonymous reads', unauthenticated.status() === 401)
check(
  'and asks for a bearer token, there being nothing else now',
  /bearer/i.test(unauthenticated.headers()['www-authenticate'] ?? ''),
  unauthenticated.headers()['www-authenticate'] ?? '(absent)',
)
const legacyBasic = await anonymous.get(API, {
  headers: {
    Authorization: `Basic ${Buffer.from('kim:whatever').toString('base64')}`,
  },
})
check('basic credentials no longer get anywhere', legacyBasic.status() === 401)
const badBearer = await anonymous.get(API, {
  headers: { Authorization: 'Bearer not.a.real.token' },
})
check('a bearer token that does not verify is refused', badBearer.status() === 401)
check('the static site needs no auth', root.status() === 200)

console.log('\nsigning in')
// The only way to read the document now, so every run of this proves the
// login flow works end to end — which nothing automated did before.
const token = await accessToken()
check('the whole login flow works against the live site', token !== null)
const api = await request.newContext({
  extraHTTPHeaders: token === null ? {} : { Authorization: `Bearer ${token}` },
})

console.log('\nthe identity provider')
const providerHealth = await anonymous.get(`${BASE}/auth/v1/health`)
check(
  'answers on this origin, under /auth',
  providerHealth.status() === 200,
  String(providerHealth.status()),
)
const discovery = await anonymous.get(
  `${BASE}/auth/v1/.well-known/openid-configuration`,
)
check('publishes a discovery document', discovery.status() === 200)

// The one value that has to agree between two services. A mismatch refuses
// every token and shows up nowhere until a client tries to sync.
const expectedIssuer = (readFileSync('deploy/docker-compose.yml', 'utf8').match(
  /AUTH_ISSUER:\s*(\S+)/,
) ?? [])[1]
const advertisedIssuer = discovery.ok()
  ? ((await discovery.json()).issuer ?? null)
  : null
check(
  'advertises the issuer the backend was configured with',
  advertisedIssuer === expectedIssuer,
  `provider says ${advertisedIssuer}, backend expects ${expectedIssuer}`,
)

const jwks = await anonymous.get(`${BASE}/auth/v1/oidc/certs`)
const keys = jwks.ok() ? ((await jwks.json()).keys ?? []) : []
check(
  'publishes an Ed25519 signing key for the backend to verify against',
  keys.some((key) => key.crv === 'Ed25519'),
  keys.map((key) => key.alg).join(',') || '(none)',
)

// Bootstrap data is applied once, on an empty database, and Rauthy says
// nothing at all if it cannot read the files — which is how the first deploy
// came up with no client registered and a login page that 404s. An authorize
// request is the cheapest way to ask whether it exists, and is read-only.
const authorize = await anonymous.get(
  `${BASE}/auth/v1/oidc/authorize?` +
    new URLSearchParams({
      client_id: 'outliner',
      redirect_uri: `${BASE}/`,
      response_type: 'code',
      scope: 'openid email',
      state: 'deployment-check',
      // Any well-formed challenge; nothing is redeemed here.
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    }),
)
check(
  "has the app's client registered, so signing in is possible",
  authorize.status() === 200,
  `${authorize.status()} (404 means bootstrap did not apply)`,
)

// Ours must not reach the provider's pages. `form-action 'none'` applied to a
// login page is the kind of breakage that only surfaces when someone tries to
// use it.
check(
  "does not get the app's content-security policy stapled on",
  !/form-action 'none'/.test(discovery.headers()['content-security-policy'] ?? ''),
  discovery.headers()['content-security-policy'] ?? '(absent)',
)

console.log('\nthe API answers')
const before = await api.get(API)
check(
  'an authenticated read succeeds',
  before.status() === 200 || before.status() === 404,
  String(before.status()),
)
const etagBefore = before.headers()['etag'] ?? null
if (before.status() === 200) {
  // Conditional reads must work with the tag a browser is handed, which the
  // compressing proxy rewrites. If they do not, every poll re-downloads the
  // whole document and every write is refused as stale.
  const conditional = await api.get(API, {
    headers: { 'If-None-Match': etagBefore },
  })
  check('a conditional read with that tag gets 304', conditional.status() === 304)
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  // No credentials: this browser is a device that has never signed in, which
  // is what the app has to cope with. Sync reports that a sign-in is needed
  // and the rest of the app still has to work.
})

// A structural guarantee that this suite cannot write, whatever the app does.
let writesAttempted = 0
await context.route('**/api/**', (route) => {
  const method = route.request().method()
  if (method === 'GET' || method === 'HEAD') return route.continue()
  writesAttempted += 1
  return route.abort()
})

const page = await context.newPage()
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  // Sync requests fail here by construction, writes being blocked above, and
  // the browser logs each as an error that cannot be suppressed.
  if (message.location()?.url?.includes('/api/')) return
  problems.push(`console: ${message.text()}`)
})

console.log('\nthe app runs')
await page.goto(BASE, { waitUntil: 'load' })
await page.waitForSelector('.row')
check('it renders rows', (await page.$$eval('.row', (n) => n.length)) > 0)
const transport = await page.evaluate(
  () => performance.getEntriesByType('navigation')[0]?.nextHopProtocol ?? '',
)
check('over HTTP/2 or HTTP/3', /^h[23]/.test(transport), transport || '(unknown)')
check(
  'in a secure context, which the service worker needs',
  await page.evaluate(() => window.isSecureContext),
)
check('nothing was blocked by the CSP', problems.length === 0, problems.join(' | '))

console.log('\ninstallable and offline')
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]')
  const result = await fetch(link.href)
  return result.ok ? result.json() : null
})
check('the manifest loads and is standalone', manifest?.display === 'standalone')
check(
  'every icon it declares resolves',
  await page.evaluate(async (icons) => {
    for (const icon of icons) if (!(await fetch(icon.src)).ok) return false
    return true
  }, manifest?.icons ?? []),
)
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  null,
  {
    timeout: 20000,
  },
)
check('the service worker controls the page', true)

await context.setOffline(true)
await page.reload()
await page.waitForSelector('.row', { timeout: 15000 })
check(
  'the app still loads with the network cut',
  (await page.$$eval('.row', (n) => n.length)) > 0,
)
await context.setOffline(false)

console.log('\nproduction was left alone')
const after = await api.get(API)
check(
  'the stored document is untouched',
  (after.headers()['etag'] ?? null) === etagBefore &&
    after.status() === before.status(),
  `was ${etagBefore ?? before.status()}, now ${after.headers()['etag'] ?? after.status()}`,
)
if (writesAttempted > 0) {
  console.log(`  --   ${writesAttempted} write(s) were attempted and blocked`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
await browser.close()
await api.dispose()
await anonymous.dispose()
process.exit(failures === 0 ? 0 : 1)
