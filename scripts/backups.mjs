/**
 * What is in the backup bucket, and is the newest document backup any good?
 *
 * Deliberately does not restore anything. It downloads the newest document
 * backup and inspects it instead: that answers "is the data all there?"
 * without touching production, where a restore would propagate to every
 * device and overwrite whatever they hold.
 *
 * Usage: npm run backups
 */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BUCKET = 'outliner-backups'
const DOC_PREFIX = 'doc/'
/** What Hiqlite names its own backups, at the root of the bucket. */
const DB_PREFIX = 'backup_node_'
const EXPECTED = 10

const field = (name) =>
  readFileSync('prod-cloudflare-r2', 'utf8').match(
    new RegExp(`^${name}:\\s*(\\S+)`, 'm'),
  )?.[1] ?? ''

const ACCOUNT = field('accountId')
const KEY = field('key')
const SECRET = field('secret')
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`

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

/**
 * A signed S3 request, via curl.
 *
 * curl signs SigV4 itself with `--aws-sigv4`, which is why nothing had to be
 * installed on the server either. The credentials go in on stdin so they stay
 * out of the process list.
 */
function r2(path, { head = false } = {}) {
  const args = [
    '-sS',
    '--aws-sigv4',
    'aws:amz:auto:s3',
    ...(head ? ['-I'] : []),
    `${ENDPOINT}/${path}`,
    '-K',
    '-',
  ]
  // No `encoding`, so this comes back as a Buffer — the body may be gzip, and
  // decoding it as text would corrupt it.
  const output = execFileSync('curl', args, {
    input: `user = "${KEY}:${SECRET}"\n`,
    maxBuffer: 64 * 1024 * 1024,
  })
  return head ? output.toString('utf8') : output
}

function listing(prefix) {
  const xml = r2(
    `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`,
  ).toString('utf8')
  const objects = []
  const pattern =
    /<Key>([^<]+)<\/Key>\s*<LastModified>([^<]+)<\/LastModified>\s*(?:<ETag>[^<]*<\/ETag>\s*)?<Size>(\d+)<\/Size>/g
  for (const [, key, modified, size] of xml.matchAll(pattern)) {
    objects.push({ key, modified: new Date(modified), size: Number(size) })
  }
  return objects.sort((a, b) => a.key.localeCompare(b.key))
}

const days = (date) => (Date.now() - date.getTime()) / 86_400_000

function describeAge(date) {
  const age = days(date)
  if (age < 1) return `${Math.round(age * 24)}h ago`
  return `${age.toFixed(1)} days ago`
}

// -- what is there -----------------------------------------------------------

const documents = listing(DOC_PREFIX)
const databases = listing(DB_PREFIX)

console.log(`\nthe document, ${documents.length} backup(s)`)
for (const object of documents) {
  console.log(
    `  ${object.key.padEnd(28)} ${String(object.size).padStart(7)} bytes  ${describeAge(object.modified)}`,
  )
}

console.log(`\nRauthy's database, ${databases.length} backup(s)`)
for (const object of databases) {
  console.log(
    `  ${object.key.padEnd(44)} ${String(object.size).padStart(9)} bytes  ${describeAge(object.modified)}`,
  )
}

console.log('\nretention')
check(
  `at most ${EXPECTED} document backups are kept`,
  documents.length <= EXPECTED,
  `found ${documents.length}`,
)
check('there is at least one', documents.length > 0)

const newest = documents.at(-1)
if (newest !== undefined) {
  // Not an assertion about the timer being healthy — a stall is the one thing
  // this cannot tell you about, and nothing here pretends otherwise. It is
  // just the age, stated plainly.
  check(
    'the newest is from the last 48 hours',
    days(newest.modified) < 2,
    describeAge(newest.modified),
  )
}

// -- is the newest document backup actually usable ---------------------------

if (newest === undefined) {
  console.log('\nnothing to inspect')
} else {
  console.log(`\ninspecting ${newest.key}`)

  const metadata = r2(`${BUCKET}/${newest.key}`, { head: true })
  const recordedSha = metadata.match(/^x-amz-meta-sha256:\s*(\S+)/im)?.[1] ?? null
  const recordedBytes = metadata.match(/^x-amz-meta-bytes:\s*(\d+)/im)?.[1] ?? null
  check('it records the hash it was uploaded with', recordedSha !== null)

  const gzipped = r2(`${BUCKET}/${newest.key}`)
  let body = null
  try {
    body = gunzipSync(gzipped)
    check('it gunzips', true)
  } catch (error) {
    check('it gunzips', false, String(error))
  }

  if (body !== null) {
    // The whole point of recording the hash: this distinguishes "a file came
    // back" from "the bytes are the ones that were backed up".
    const actual = createHash('sha256').update(body).digest('hex')
    check(
      'the bytes are exactly what was uploaded',
      actual === recordedSha,
      `${actual.slice(0, 12)} vs ${String(recordedSha).slice(0, 12)}`,
    )
    check(
      'and the recorded size agrees',
      String(body.length) === recordedBytes,
      `${body.length} vs ${recordedBytes}`,
    )

    // Structural validation, the same rules the app applies before it will
    // adopt a document — a file that parses as JSON but is not a document
    // would restore into an empty outline.
    let parsed = null
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch (error) {
      check('it parses as JSON', false, String(error))
    }
    if (parsed !== null) {
      check('it parses as JSON', true)
      check(
        'it is a version 1 envelope',
        parsed.version === 1,
        String(parsed.version),
      )

      const doc = parsed.doc ?? {}
      const items = doc.items ?? {}
      const ids = Object.keys(items)
      check('it names a root', typeof doc.rootId === 'string', String(doc.rootId))
      check('the root is present', ids.includes(doc.rootId))
      check('it holds items', ids.length > 1, `${ids.length} item(s)`)

      const malformed = ids.filter((id) => {
        const item = items[id]
        return (
          item?.id !== id ||
          typeof item.text !== 'string' ||
          !Array.isArray(item.children) ||
          typeof item.collapsed !== 'boolean' ||
          (item.parent !== null && typeof item.parent !== 'string')
        )
      })
      check(
        'every item is well formed',
        malformed.length === 0,
        malformed.join(','),
      )

      // Children and parents have to agree, or the outline would not render.
      const broken = ids.filter((id) =>
        items[id].children.some(
          (child) => items[child] === undefined || items[child].parent !== id,
        ),
      )
      check('parents and children agree', broken.length === 0, broken.join(','))

      const orphans = ids.filter(
        (id) =>
          id !== doc.rootId &&
          (items[id].parent === null ||
            !items[items[id].parent]?.children.includes(id)),
      )
      check('nothing is orphaned', orphans.length === 0, orphans.join(','))

      const text = ids.filter((id) => items[id].text.length > 0).length
      console.log(
        `  → ${ids.length} items, ${text} with text, ${body.length} bytes uncompressed`,
      )

      // Compared against what the server holds right now, which is the most
      // direct answer to "is all the data there". A difference is not a
      // failure — the document has probably just been edited since — so this
      // reports rather than asserts.
      console.log('\nagainst the live document')
      const token = await liveToken()
      if (token === null) {
        console.log('  (could not sign in, so skipping the comparison)')
      } else {
        const live = await fetch('https://outliner.stebel.kim/api/doc', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        const liveBody = await live.text()
        const liveItems = Object.keys(JSON.parse(liveBody).doc?.items ?? {}).length
        const liveSha = createHash('sha256').update(liveBody).digest('hex')
        if (liveSha === actual) {
          console.log('  identical to what the server holds')
        } else {
          console.log(
            `  the server now has ${liveItems} items, this backup has ${ids.length}` +
              ` (${liveItems - ids.length >= 0 ? '+' : ''}${liveItems - ids.length} since)`,
          )
        }
        check(
          'the backup is not obviously truncated',
          ids.length >= liveItems * 0.5,
          `${ids.length} vs ${liveItems} live`,
        )
      }
    }
  }
}

/** Read-only sign-in, as the deployment check does. */
async function liveToken() {
  try {
    const context = await request.newContext()
    const [email, ...rest] = readFileSync('prod-rauthy-user', 'utf8')
      .trim()
      .split(':')
    const password = rest.join(':')
    await context.dispose()
    const { chromium } = await import('playwright')
    const { createHash: hash, randomBytes } = await import('node:crypto')
    const b64 = (b) => b.toString('base64url')
    const verifier = b64(randomBytes(32))
    const challenge = b64(hash('sha256').update(verifier).digest())
    const base = 'https://outliner.stebel.kim'

    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.route(
      (url) => url.origin === base && !url.pathname.startsWith('/auth/'),
      (route) => route.fulfill({ status: 200, body: 'intercepted' }),
    )
    const query = new URLSearchParams({
      client_id: 'outliner',
      redirect_uri: `${base}/`,
      response_type: 'code',
      scope: 'openid email',
      state: b64(randomBytes(16)),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    await page.goto(`${base}/auth/v1/oidc/authorize?${query}`, {
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

    const response = await fetch(`${base}/auth/v1/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${base}/`,
        client_id: 'outliner',
        code_verifier: verifier,
      }),
    })
    return response.ok ? ((await response.json()).access_token ?? null) : null
  } catch {
    return null
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
