/**
 * Smoke-test the deployed site.
 *
 * Runs against the real origin, so it exercises the things only production
 * has: the Caddy response headers, the content security policy, and a service
 * worker in a genuinely secure context. A CSP that blocks something shows up
 * here as a console error, which this treats as a failure.
 *
 * Usage: node scripts/smoke-prod.mjs [url]
 */

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'https://outliner.stebel.kim'

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

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})
const page = await context.newPage()

const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  // The browser logs any 4xx as a console error. A 401 before signing in and
  // a 404 against an empty store are both normal protocol outcomes, not
  // faults, and there is no way to suppress the log.
  if (/status of (401|404)/.test(message.text())) return
  problems.push(`console: ${message.text()}`)
})

console.log(`\nloading ${BASE}`)
const response = await page.goto(BASE, { waitUntil: 'load' })
check(
  'responds 200 over https',
  response?.status() === 200,
  String(response?.status()),
)
await page.waitForSelector('.row')

const protocol = await page.evaluate(
  () => performance.getEntriesByType('navigation')[0]?.nextHopProtocol ?? '',
)
check(
  'negotiated HTTP/2 or HTTP/3',
  /^h[23]/.test(protocol),
  protocol || '(unknown)',
)

const security = await page.evaluate(() => ({
  secure: window.isSecureContext,
  protocol: location.protocol,
}))
check(
  'is a secure context, which the service worker needs',
  security.secure && security.protocol === 'https:',
  JSON.stringify(security),
)

const rows = await page.$$eval('.row [data-item-id]', (nodes) =>
  nodes.map((node) => node.textContent),
)
check('the app renders its rows', rows.length > 0, JSON.stringify(rows.slice(0, 2)))

console.log('\nnothing blocked by the content security policy')
check(
  'no console or page errors on load',
  problems.length === 0,
  problems.join(' | '),
)

console.log('\nediting works on the deployed build')
await page.locator('[data-item-id]', { hasText: 'Edit this line' }).first().click()
await page.keyboard.press('End')
await page.keyboard.type(' live')
check(
  'typing lands',
  (await page.evaluate(() => document.activeElement?.textContent)) ===
    'Edit this line live',
)
await page.keyboard.press('Enter')
await page.keyboard.type('new row')
await page.keyboard.press('Tab')
const depths = await page.$$eval('.row', (nodes) =>
  nodes.map((node) => ({
    text: node.querySelector('[data-item-id]')?.textContent,
    depth: Number(getComputedStyle(node).getPropertyValue('--depth').trim() || '0'),
  })),
)
const nested = depths.find((row) => row.text === 'new row')
check(
  'Enter and Tab still nest',
  nested !== undefined && nested.depth === 2,
  JSON.stringify(nested),
)

console.log('\ninstallable')
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]')
  if (link === null) return null
  const result = await fetch(link.href)
  return result.ok ? result.json() : null
})
check('the manifest loads', manifest !== null)
check('with standalone display', manifest?.display === 'standalone')
const iconOk = await page.evaluate(async (icons) => {
  for (const icon of icons) {
    const result = await fetch(icon.src)
    if (!result.ok) return false
  }
  return true
}, manifest?.icons ?? [])
check('and every icon it declares', iconOk)

console.log('\nservice worker in a real secure context')
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  null,
  {
    timeout: 20000,
  },
)
check('registers and controls the page', true)

console.log('\nworks with the network cut')
await page.waitForTimeout(800)
await context.setOffline(true)
await page.reload()
await page.waitForSelector('.row', { timeout: 15000 })
const offlineRows = await page.$$eval('.row [data-item-id]', (nodes) =>
  nodes.map((node) => node.textContent),
)
check('the app loads offline', offlineRows.length > 0)
check(
  'and the edit made online is still there',
  offlineRows.some((text) => text?.includes('Edit this line live')),
  JSON.stringify(offlineRows.slice(0, 3)),
)
await context.setOffline(false)

console.log(`\n${checks - failures}/${checks} checks passed`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
