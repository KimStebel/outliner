/**
 * End-to-end smoke test against a real browser.
 *
 * The unit suite covers the model, but none of the risk in phase 2 lives
 * there: caret placement, focus handoff on Enter, and `contenteditable`
 * behaviour only exist in a browser. This drives the built app in a
 * phone-sized viewport and asserts what the user would see.
 *
 * Usage: npm run build && node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`

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

/** The visible outline as the user sees it: depth-indented text per row. */
async function outlineOf(page) {
  return page.$$eval('.row', (rows) =>
    rows.map((row) => {
      const depth = Number(
        getComputedStyle(row).getPropertyValue('--depth').trim() || '0',
      )
      const text = row.querySelector('[data-item-id]')?.textContent ?? ''
      return `${'  '.repeat(depth)}${text}`
    }),
  )
}

async function focusedRowText(page) {
  return page.evaluate(() => document.activeElement?.textContent ?? null)
}

async function caretOffset(page) {
  return page.evaluate(() => {
    const el = document.activeElement
    const selection = window.getSelection()
    if (!el || !selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const probe = document.createRange()
    probe.selectNodeContents(el)
    probe.setEnd(range.endContainer, range.endOffset)
    return probe.toString().length
  })
}

/**
 * Synthesise a touch swipe as pointer events. Playwright's touchscreen only
 * taps, and the handlers key off `pointerType`, so drive them directly.
 */
async function swipe(page, rowText, dx, dy = 0, steps = 6) {
  const row = page.locator('.swipe', { hasText: rowText }).first()
  const box = await row.boundingBox()
  const x0 = box.x + 20
  const y0 = box.y + box.height / 2
  const send = (type, x, y) =>
    row.dispatchEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    })
  await send('pointerdown', x0, y0)
  for (let i = 1; i <= steps; i += 1) {
    await send('pointermove', x0 + (dx * i) / steps, y0 + (dy * i) / steps)
  }
  await send('pointerup', x0 + dx, y0 + dy)
  await page.waitForTimeout(80)
}

/** Swipe and pause at the far end so mid-gesture state can be inspected. */
async function swipeAndHold(page, rowText, dx, inspect) {
  const row = page.locator('.swipe', { hasText: rowText }).first()
  const box = await row.boundingBox()
  const x0 = box.x + 20
  const y0 = box.y + box.height / 2
  const send = (type, x, y) =>
    row.dispatchEvent(type, {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    })
  await send('pointerdown', x0, y0)
  for (let i = 1; i <= 6; i += 1) await send('pointermove', x0 + (dx * i) / 6, y0)
  await page.waitForTimeout(50)
  const result = await inspect()
  await send('pointerup', x0 + dx, y0)
  await page.waitForTimeout(80)
  return result
}

/**
 * Drag a row by its bullet. Uses the real mouse so hit testing, the drag
 * threshold and the handle's touch-action all take part.
 */
async function dragRow(page, rowText, { dy = 0, dx = 0 }) {
  const handle = page.locator('.row', { hasText: rowText }).first().locator('.dot')
  const box = await handle.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // Several steps: one jump would clear the threshold without the
  // intermediate moves that compute the drop target.
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8)
  }
  await page.waitForTimeout(60)
  const indicator = await page.locator('.drop-indicator').count()
  await page.mouse.up()
  await page.waitForTimeout(120)
  return indicator
}

/**
 * Back to the welcome document. The settle wait matters: a queued debounced
 * write is flushed on pagehide, so clearing storage with one still pending
 * lets the old document reappear after the reload.
 */
async function resetDocument(page) {
  // Let any debounced write land first, so it cannot arrive after the reset
  // and repopulate the store.
  await page.waitForTimeout(600)
  // Both sides: clearing only the browser would leave the client adopting
  // the previous test's document from the server on reload.
  await resetBackend()
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.row')
}

/**
 * Hold a finger on a row's text (not its bullet) and then move, the way a
 * long-press drag works on a phone.
 */
async function longPressDrag(
  page,
  rowText,
  { dy = 0, dx = 0, hold = 500, steps = 8 },
) {
  const row = page.locator('.swipe', { hasText: rowText }).first()
  const box = await row.boundingBox()
  // Well clear of the bullet, to prove the whole row is a handle.
  const x0 = box.x + box.width * 0.6
  const y0 = box.y + box.height / 2
  const send = (type, x, y) =>
    row.dispatchEvent(type, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    })

  await send('pointerdown', x0, y0)
  await page.waitForTimeout(hold)
  const grabbed = await page.locator('.row.dragging').count()
  for (let i = 1; i <= steps; i += 1) {
    await send('pointermove', x0 + (dx * i) / steps, y0 + (dy * i) / steps)
  }
  await page.waitForTimeout(60)
  const indicator = await page.locator('.drop-indicator').count()
  await send('pointerup', x0 + dx, y0 + dy)
  await page.waitForTimeout(120)
  return { grabbed, indicator }
}

async function clickRow(page, text) {
  const row = page.locator('[data-item-id]', { hasText: text }).first()
  const box = await row.boundingBox()
  // Past the end of the last line, rather than the element's centre. The
  // centre can land on a link, where focus is suppressed by design so that
  // tapping a URL does not raise the keyboard — leaving the row unfocused and
  // every following assertion meaningless. This also puts the caret at the
  // end of the text regardless of how the row wraps.
  await row.click({ position: { x: box.width - 4, y: box.height - 4 } })
}

// A real sync backend, on a scratch directory of its own. Without it the app
// under test would be permanently failing to sync, which is not the state
// anyone actually uses it in — and nothing would exercise the client against
// the real protocol.
const BACKEND = 'backend/target/release/outliner-sync'
const BACKEND_PORT = 8787
let backendDir = mkdtempSync(join(tmpdir(), 'outliner-e2e-'))
let backend = null

function startBackend() {
  backend = spawn(BACKEND, [], {
    env: {
      ...process.env,
      DATA_DIR: backendDir,
      BIND: `127.0.0.1:${BACKEND_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('backend did not start')),
      15000,
    )
    backend.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer)
        setTimeout(resolve, 100)
      }
    })
  })
}

function stopBackend() {
  if (backend?.pid === undefined) return
  try {
    process.kill(-backend.pid, 'SIGKILL')
  } catch {
    backend?.kill('SIGKILL')
  }
  backend = null
}

/** A backend with nothing stored, as if it had never been written to. */
async function resetBackend() {
  stopBackend()
  rmSync(backendDir, { recursive: true, force: true })
  backendDir = mkdtempSync(join(tmpdir(), 'outliner-e2e-'))
  await startBackend()
}

/** What the backend currently holds, or null when it holds nothing. */
function storedDocument() {
  try {
    return readFileSync(join(backendDir, 'doc.json'), 'utf8')
  } catch {
    return null
  }
}

// `detached` puts the server in its own process group. npx launches vite via a
// shell, so killing the direct child would orphan the node process and leave
// the port bound; killing the group takes the whole tree.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

function stopServer() {
  stopBackend()
  rmSync(backendDir, { recursive: true, force: true })
  if (server.pid === undefined || server.killed) return
  try {
    process.kill(-server.pid, 'SIGKILL')
  } catch {
    server.kill('SIGKILL')
  }
}

process.on('exit', stopServer)
process.on('SIGINT', () => {
  stopServer()
  process.exit(130)
})

await startBackend()

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server timeout')), 30000)
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes(String(PORT))) {
      clearTimeout(timer)
      setTimeout(resolve, 300)
    }
  })
})

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
})
const page = await context.newPage()
page.on('pageerror', (error) => {
  failures += 1
  console.log(`  FAIL uncaught page error — ${error.message}`)
})
// Sync requests are expected to fail during the offline section and while the
// backend restarts between resets, and the browser logs each as a console
// error that cannot be suppressed. Filtered by URL, so a genuinely missing
// asset still fails the run; sync itself is covered by explicit checks below
// rather than by the absence of console noise.
page.on('console', (message) => {
  if (message.type() !== 'error') return
  if (message.location()?.url?.includes('/api/')) return
  failures += 1
  console.log(`  FAIL console error — ${message.text()}`)
})

await page.goto(BASE)
await page.waitForSelector('.row')

console.log('\nfirst load')
equal('welcome document renders', await outlineOf(page), [
  'Welcome',
  '  Return starts a new item',
  '  Tab indents, Shift-Tab outdents',
  '  Backspace at the start joins to the item above',
  '  Tap a bullet with children to fold it',
  'Try it',
  '  Edit this line',
  '  Then add your own below',
])

console.log('\ntyping')
await clickRow(page, 'Edit this line')
await page.keyboard.press('End')
await page.keyboard.type(' now')
check(
  'typed text lands in the row',
  (await focusedRowText(page)) === 'Edit this line now',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)
check('caret stays after the typed text', (await caretOffset(page)) === 18)

console.log('\nenter splits and focuses the new row')
await page.keyboard.press('Enter')
await page.keyboard.type('brand new')
equal('new sibling created at the same depth', await outlineOf(page), [
  'Welcome',
  '  Return starts a new item',
  '  Tab indents, Shift-Tab outdents',
  '  Backspace at the start joins to the item above',
  '  Tap a bullet with children to fold it',
  'Try it',
  '  Edit this line now',
  '  brand new',
  '  Then add your own below',
])
check('focus moved to the new row', (await focusedRowText(page)) === 'brand new')

console.log('\nenter mid-text splits the text')
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('Enter')
equal('text divided between the two rows', (await outlineOf(page)).slice(6, 9), [
  '  Edit this line now',
  '  brand ',
  '  new',
])
check('caret sits at the start of the tail', (await caretOffset(page)) === 0)
await page.keyboard.press('Backspace')
check(
  'backspace at offset 0 rejoins them',
  (await focusedRowText(page)) === 'brand new',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)
check('caret lands at the join', (await caretOffset(page)) === 6)

console.log('\ntab indents, shift-tab outdents')
await page.keyboard.press('Tab')
equal('indented under the previous sibling', (await outlineOf(page)).slice(6, 8), [
  '  Edit this line now',
  '    brand new',
])
check('caret survives the indent', (await caretOffset(page)) === 6)
await page.keyboard.press('Shift+Tab')
equal('outdent returns it', (await outlineOf(page)).slice(6, 8), [
  '  Edit this line now',
  '  brand new',
])

console.log('\nundo and redo')
await page.keyboard.press('Control+z')
equal('undo reverses the outdent', (await outlineOf(page)).slice(6, 8), [
  '  Edit this line now',
  '    brand new',
])
await page.keyboard.press('Control+Shift+z')
equal('redo reapplies it', (await outlineOf(page)).slice(6, 8), [
  '  Edit this line now',
  '  brand new',
])

console.log('\nundo coalesces typing')
await clickRow(page, 'brand new')
await page.keyboard.press('End')
await page.keyboard.type('XYZ')
await page.keyboard.press('Control+z')
check(
  'one undo removes the whole typed run',
  (await focusedRowText(page)) === 'brand new',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)

console.log('\narrow keys cross rows')
// Chosen at runtime rather than named: which rows exist depends on what
// earlier sections left behind, and which rows wrap depends on the layout.
// In a wrapped row ArrowDown moves to the next visual line rather than the
// next row — correct, but not what this is testing.
const adjacentPair = await page.$$eval('[data-item-id]', (nodes) => {
  const single = nodes.map((node) => {
    const style = getComputedStyle(node)
    const lineHeight = Number.parseFloat(style.lineHeight) || 24
    return node.getBoundingClientRect().height < lineHeight * 1.5
  })
  for (let i = 1; i < nodes.length; i += 1) {
    if (single[i] && single[i - 1]) {
      return {
        index: i,
        above: nodes[i - 1].textContent,
        here: nodes[i].textContent,
      }
    }
  }
  return null
})
check('found two adjacent rows that fit on one line', adjacentPair !== null)

const pairTarget = page.locator('[data-item-id]').nth(adjacentPair.index)
const pairBox = await pairTarget.boundingBox()
await pairTarget.click({
  position: { x: pairBox.width - 4, y: pairBox.height - 4 },
})
await page.keyboard.press('Home')
await page.keyboard.press('ArrowUp')
check(
  'arrow up moves to the previous visible row',
  (await focusedRowText(page)) === adjacentPair.above,
  `got ${JSON.stringify(await focusedRowText(page))}, wanted ${JSON.stringify(adjacentPair.above)}`,
)
await page.keyboard.press('ArrowDown')
check(
  'arrow down comes back',
  (await focusedRowText(page)) === adjacentPair.here,
  `got ${JSON.stringify(await focusedRowText(page))}`,
)

console.log('\ncollapse hides children')
const beforeCollapse = (await outlineOf(page)).length
await page.locator('.row', { hasText: 'Welcome' }).first().locator('.fold').click()
const afterCollapse = (await outlineOf(page)).length
check(
  'folding Welcome hides its four children',
  beforeCollapse - afterCollapse === 4,
  `${beforeCollapse} -> ${afterCollapse}`,
)
await page.locator('.row', { hasText: 'Welcome' }).first().locator('.fold').click()
check('unfolding restores them', (await outlineOf(page)).length === beforeCollapse)

console.log('\nthe bullet shows the fold state')
const chevron = page
  .locator('.row', { hasText: 'Welcome' })
  .first()
  .locator('.fold svg')
const bullet = page.locator('.row', { hasText: 'Welcome' }).first().locator('.fold')
const rotationOf = async () => {
  // Settle first: sampling mid-transition reads an intermediate angle.
  await page.waitForTimeout(250)
  return chevron.evaluate((el) => getComputedStyle(el).transform)
}
// Rotated a quarter turn: the chevron points down while the row is open.
const OPEN = 'matrix(0, 1, -1, 0, 0, 0)'

check(
  'expanded rows report themselves expanded',
  (await bullet.getAttribute('aria-expanded')) === 'true',
)
const openRotation = await rotationOf()
check('the open chevron points down', openRotation === OPEN, openRotation)

await bullet.click()
const foldedRotation = await rotationOf()
check(
  'folded rows report themselves collapsed',
  (await bullet.getAttribute('aria-expanded')) === 'false',
)
check(
  'the folded chevron points right',
  foldedRotation === 'none' || foldedRotation === 'matrix(1, 0, 0, 1, 0, 0)',
  foldedRotation,
)

await bullet.click()
const reopened = await rotationOf()
check('unfolding turns it back down', reopened === OPEN, reopened)

// A leaf has nothing to fold, so it must not offer a chevron.
check(
  'leaves keep a plain dot',
  (await page
    .locator('.row', { hasText: 'Return starts a new item' })
    .first()
    .locator('.chevron')
    .count()) === 0,
)

console.log('\nmulti-line paste becomes multiple rows')
await clickRow(page, 'Then add your own below')
await page.keyboard.press('End')
await page.evaluate(() => {
  const target = document.activeElement
  const data = new DataTransfer()
  data.setData('text/plain', '\nalpha\nbeta\ngamma')
  target?.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }),
  )
})
await page.waitForTimeout(150)
equal('each pasted line is its own row', (await outlineOf(page)).slice(-4), [
  '  Then add your own below',
  '  alpha',
  '  beta',
  '  gamma',
])
check(
  'caret follows the paste',
  (await focusedRowText(page)) === 'gamma',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)

console.log('\nrich-text paste inserts plain text only')
await page.evaluate(() => {
  const target = document.activeElement
  const data = new DataTransfer()
  data.setData('text/html', '<b>bold</b>')
  data.setData('text/plain', 'plain')
  target?.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }),
  )
})
await page.waitForTimeout(150)
check(
  'no markup reached the row',
  !(await page.evaluate(() => document.activeElement?.innerHTML ?? '')).includes(
    '<b>',
  ),
)

console.log('\narrow keys stay inside a row whose text wraps')
// The geometry checks in caret.ts are the fragile part: an offset-based test
// would wrongly jump rows from the middle of a wrapped line.
await clickRow(page, 'alpha')
await page.keyboard.press('End')
await page.keyboard.type(
  'x'.repeat(40) + ' ' + 'y'.repeat(40) + ' ' + 'z'.repeat(40),
)
const wrappedHeight = await page
  .locator('.row', { hasText: 'alpha' })
  .first()
  .evaluate((row) => row.getBoundingClientRect().height)
const lineHeight = await page.evaluate(
  () => Number.parseFloat(getComputedStyle(document.body).lineHeight) || 24,
)
check(
  'the row really does wrap onto several lines',
  wrappedHeight > lineHeight * 2,
  `height ${wrappedHeight} vs line ${lineHeight}`,
)
const longText = await focusedRowText(page)
await page.keyboard.press('ArrowUp')
check(
  'arrow up from the last wrapped line stays in the row',
  (await focusedRowText(page)) === longText,
  `got ${JSON.stringify(await focusedRowText(page))}`,
)
// Walk up a wrapped line at a time. The press count is whatever the viewport
// happens to wrap to, so loop rather than hardcode it; what matters is that the
// caret keeps moving and does eventually leave instead of getting stuck.
let pressesToLeave = 0
while (pressesToLeave < 20 && (await focusedRowText(page)) === longText) {
  await page.keyboard.press('ArrowUp')
  pressesToLeave += 1
}
check(
  'arrow up walks the wrapped lines and then leaves the row',
  (await focusedRowText(page)) !== longText,
  `still in the row after ${pressesToLeave} presses`,
)
check(
  'leaving took more than one press, so wrapped lines were walked',
  pressesToLeave > 1,
  `took ${pressesToLeave}`,
)

console.log('\nbackspace carries children to the row above')
await clickRow(page, 'Try it')
await page.keyboard.press('End')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
check(
  'the row is emptied but still present',
  (await focusedRowText(page)) === '',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)
const childCountBefore = (await outlineOf(page)).length
await page.keyboard.press('Backspace')
const merged = await outlineOf(page)
check(
  'merging an item with children keeps every row',
  merged.length === childCountBefore - 1,
  `${childCountBefore} -> ${merged.length}`,
)
check(
  'the children moved up a level with it',
  merged.some((row) => row.trimStart().startsWith('Edit this line now')),
  JSON.stringify(merged),
)

console.log('\ntapping below the list adds a row')
const rowsBeforeTail = await outlineOf(page)
const beforeTail = rowsBeforeTail.length
const lastIndent = (rowsBeforeTail.at(-1) ?? '').match(/^ */)[0]
const outlineBox = await page.locator('.outline').boundingBox()
await page
  .locator('.outline')
  .click({ position: { x: outlineBox.width / 2, y: outlineBox.height - 24 } })
await page.keyboard.type('from the tail')
equal(
  // A sibling of the last row, which is what pressing Enter there would do.
  'a new row continues the list at the last row’s depth',
  (await outlineOf(page)).slice(-1),
  [`${lastIndent}from the tail`],
)
check(
  'exactly one row was added',
  (await outlineOf(page)).length === beforeTail + 1,
)

console.log('\nkeyboard bar: indent and outdent by tapping')
await page.evaluate(() => document.activeElement?.blur())
await page.waitForTimeout(200) // the blur is debounced, to survive re-renders
check(
  'the bar is hidden when nothing is focused',
  !(await page.locator('.bar').isVisible()),
)
await clickRow(page, 'beta')
check('the bar appears while editing', await page.locator('.bar').isVisible())
const barOutdent = page.locator('.bar button[aria-label="Outdent"]')
const barIndent = page.locator('.bar button[aria-label="Indent"]')

const depthOf = async (text) => {
  const row = (await outlineOf(page)).find((r) => r.trimStart() === text)
  return row === undefined ? null : row.match(/^ */)[0].length / 2
}
const beforeIndent = await depthOf('beta')
await barIndent.tap()
await page.waitForTimeout(80)
check(
  'tapping indent nests the row',
  (await depthOf('beta')) === beforeIndent + 1,
  `${beforeIndent} -> ${await depthOf('beta')}`,
)
// The whole point of suppressing the default on pointerdown: losing focus here
// would close the keyboard and unmount the bar after a single tap.
check(
  'the row keeps focus, so the keyboard stays up',
  (await focusedRowText(page)) === 'beta',
  `focus is on ${JSON.stringify(await focusedRowText(page))}`,
)
check(
  'the bar is still there for a second tap',
  await page.locator('.bar').isVisible(),
)
await barOutdent.tap()
await page.waitForTimeout(80)
check(
  'tapping outdent moves it back',
  (await depthOf('beta')) === beforeIndent,
  `now ${await depthOf('beta')}`,
)
check(
  'focus survives outdent too',
  (await focusedRowText(page)) === 'beta',
  `focus is on ${JSON.stringify(await focusedRowText(page))}`,
)

console.log('\nkeyboard bar: buttons reflect what is possible')
await clickRow(page, 'Welcome')
await page.waitForTimeout(80)
check('outdent is disabled on a top-level row', await barOutdent.isDisabled())
check('indent is disabled on the very first row', await barIndent.isDisabled())

console.log('\nswipe right deletes a subtree')
await page.evaluate(() => document.activeElement?.blur())
await page.waitForTimeout(200)
const beforeSwipe = await outlineOf(page)
// A short drag is below the commit threshold and must leave the row alone.
await swipe(page, 'Tab indents', 30)
equal('a short swipe does not delete', await outlineOf(page), beforeSwipe)

// A vertical drag is a scroll, not a swipe, however far it travels.
await swipe(page, 'Tab indents', 10, 140)
equal('a vertical drag does not delete', await outlineOf(page), beforeSwipe)

// Mid-gesture the row must stay clipped; a row sliding past the edge gives
// the whole page horizontal overflow.
const overflow = await swipeAndHold(page, 'Tab indents', 260, async () =>
  page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  })),
)
check(
  'the sliding row does not widen the page',
  overflow.scrollW <= overflow.clientW,
  `scrollWidth ${overflow.scrollW} vs clientWidth ${overflow.clientW}`,
)

const afterSwipe = await outlineOf(page)
check(
  'a full swipe removes the row',
  !afterSwipe.some((r) => r.includes('Tab indents')),
  JSON.stringify(afterSwipe),
)
// Swiping is not an editing gesture; focusing a neighbour afterwards would
// pop the on-screen keyboard open over a list the user was only tidying.
check(
  'the swipe does not focus a row',
  await page.evaluate(() => !document.activeElement?.hasAttribute('data-item-id')),
)
check(
  'and so the keyboard bar stays hidden',
  !(await page.locator('.bar').isVisible()),
)

console.log('\nthe header undo restores a swiped row')
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
equal('undo restores the row', await outlineOf(page), beforeSwipe)

console.log('\nswiping a parent takes its children and says so')
await swipe(page, 'Welcome', 260)
const afterParent = await outlineOf(page)
check(
  'the whole subtree is gone',
  !afterParent.some((r) => r.includes('Welcome') || r.includes('Return starts')),
  JSON.stringify(afterParent),
)
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
check(
  'undo brings the whole subtree back',
  (await outlineOf(page)).length === beforeSwipe.length,
)

console.log('\nctrl-enter deletes from the keyboard')
// Build a known pair of siblings rather than relying on whatever earlier
// tests left behind, so the caret target is unambiguous.
await page.locator('[data-item-id]').last().click()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('DOOMED')
await page.keyboard.press('Enter')
await page.keyboard.type('SURVIVOR')
await clickRow(page, 'DOOMED')
const rowsBeforeKeyDelete = await outlineOf(page)

await page.keyboard.press('Control+Enter')
await page.waitForTimeout(100)
const afterKeyDelete = await outlineOf(page)
check(
  'ctrl-enter deletes the row',
  !afterKeyDelete.some((row) => row.includes('DOOMED')),
  JSON.stringify(afterKeyDelete),
)
// The caret follows the list downwards rather than jumping backwards.
check(
  'the caret lands on the row below, not the one above',
  (await focusedRowText(page)) === 'SURVIVOR',
  `focus on ${JSON.stringify(await focusedRowText(page))}`,
)
check('at its start', (await caretOffset(page)) === 0)
check('no toast is shown', (await page.locator('.toast').count()) === 0)

console.log('\nctrl-enter on a parent skips its children')
await clickRow(page, 'SURVIVOR')
await page.keyboard.press('Tab') // nest SURVIVOR under the row above it
await page.waitForTimeout(80)
const parentRow = (await outlineOf(page)).at(-2)?.trimStart()
await clickRow(page, parentRow)
await page.keyboard.press('Control+Enter')
await page.waitForTimeout(100)
check(
  'the nested child went with the parent',
  !(await outlineOf(page)).some((row) => row.includes('SURVIVOR')),
)
check(
  'the caret did not land inside the deleted subtree',
  (await focusedRowText(page)) !== 'SURVIVOR',
  `focus on ${JSON.stringify(await focusedRowText(page))}`,
)

await page.keyboard.press('Control+z')
await page.keyboard.press('Control+z')
await page.keyboard.press('Control+z')
await page.waitForTimeout(100)
equal('undo restores it all', await outlineOf(page), rowsBeforeKeyDelete)

console.log('\ndrag and drop reorders')
await page.evaluate(() => document.activeElement?.blur())
// Known starting shape, independent of what earlier sections left behind.
await resetDocument(page)

const hadIndicator = await dragRow(page, 'Try it', { dy: -260 })
check('an indicator appears while dragging', hadIndicator === 1)
check(
  'the indicator is gone after the drop',
  (await page.locator('.drop-indicator').count()) === 0,
)
const reordered = await outlineOf(page)
check(
  'the dragged subtree moved up, children included',
  reordered.indexOf('Try it') < reordered.indexOf('Welcome'),
  JSON.stringify(reordered),
)
check(
  'its children came along',
  reordered[reordered.indexOf('Try it') + 1]?.startsWith('  Edit this line'),
  JSON.stringify(reordered),
)

console.log('\ndragging sideways changes nesting')
await resetDocument(page)
const beforeNest = await outlineOf(page)
const indentPx = await page.evaluate(() =>
  Number.parseFloat(
    getComputedStyle(document.querySelector('.outline')).getPropertyValue(
      '--indent',
    ),
  ),
)
check('the indent is readable from CSS in px', indentPx === 22, String(indentPx))

// 'Try it' sits directly below the last child of 'Welcome'. Dragging it a
// short way up and one indent to the right should nest it under 'Welcome'.
await dragRow(page, 'Try it', { dy: -14, dx: indentPx })
const nested = await outlineOf(page)
const nestedRow = nested.find((row) => row.trimStart() === 'Try it')
check(
  'the row gained a level of nesting',
  nestedRow?.startsWith('  '),
  JSON.stringify(nested),
)
check(
  'and its own children went one deeper too',
  nested.some((row) => row.startsWith('    Edit this line')),
  JSON.stringify(nested),
)

console.log('\ndragging is a single undo step')
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
equal('one undo puts the whole subtree back', await outlineOf(page), beforeNest)

console.log('\na drag cannot drop an item inside itself')
const beforeSelfDrop = await outlineOf(page)
// Drag a parent far down, past its own descendants.
await dragRow(page, 'Welcome', { dy: 120, dx: 3 * indentPx })
const afterSelfDrop = await outlineOf(page)
check(
  'the document is still structurally sound',
  afterSelfDrop.length === beforeSelfDrop.length,
  `${beforeSelfDrop.length} -> ${afterSelfDrop.length}`,
)
check(
  'Welcome still has its children',
  afterSelfDrop[
    afterSelfDrop.indexOf(afterSelfDrop.find((r) => r.trimStart() === 'Welcome')) +
      1
  ]?.trimStart() === 'Return starts a new item',
  JSON.stringify(afterSelfDrop),
)

console.log('\ntapping the bullet after a drag does not fold it')
await resetDocument(page)
const rowsBeforeTapTest = (await outlineOf(page)).length
await dragRow(page, 'Try it', { dy: -14, dx: 0 })
check(
  'the row is still unfolded after being dragged',
  (await outlineOf(page)).length === rowsBeforeTapTest,
  `${rowsBeforeTapTest} -> ${(await outlineOf(page)).length}`,
)

console.log('\nlinks')
await resetDocument(page)
await page.locator('[data-item-id]').last().click()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('docs at https://example.com/x and me@example.com')
// A URL typed just now only becomes a link once the row loses focus.
await page.evaluate(() => document.activeElement?.blur())
await page.waitForTimeout(200)

const links = await page.$$eval('.text a', (nodes) =>
  nodes.map((n) => ({
    text: n.textContent,
    href: n.getAttribute('href'),
    rel: n.rel,
    target: n.target,
  })),
)
check(
  'the URL became a link',
  links.some((l) => l.href === 'https://example.com/x'),
  JSON.stringify(links),
)
check(
  'the email became a mailto link',
  links.some((l) => l.href === 'mailto:me@example.com'),
  JSON.stringify(links),
)
check(
  'links open in a new tab without handing over the opener',
  links.every((l) => l.target === '_blank' && l.rel.includes('noopener')),
  JSON.stringify(links),
)

// The caret depends on this: rendered characters must equal stored ones.
const rowText = await page.$$eval('[data-item-id]', (nodes) =>
  nodes.map((n) => n.textContent).find((t) => t?.includes('docs at')),
)
check(
  'the rendered text is unchanged by linkifying',
  rowText === 'docs at https://example.com/x and me@example.com',
  JSON.stringify(rowText),
)

console.log('\nediting still works in a row containing a link')
// A short row, so Home and End address the whole text rather than one
// wrapped visual line.
await clickRow(page, 'docs at https://example.com/x and me@example.com')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('see https://a.test')
await page.evaluate(() => document.activeElement?.blur())
await page.waitForTimeout(200)
await clickRow(page, 'see https://a.test')

await page.keyboard.press('End')
check(
  'End lands past the anchor at the true text length',
  (await caretOffset(page)) === 'see https://a.test'.length,
  String(await caretOffset(page)),
)
await page.keyboard.press('Home')
check('Home reaches offset 0 across the anchor', (await caretOffset(page)) === 0)

await page.keyboard.type('X')
check(
  'typing at offset 0 inserts before the link, not inside it',
  (await focusedRowText(page)) === 'Xsee https://a.test',
  JSON.stringify(await focusedRowText(page)),
)
await page.keyboard.press('End')
await page.keyboard.type('!')
check(
  'and typing at the end appends after it',
  (await focusedRowText(page)) === 'Xsee https://a.test!',
  JSON.stringify(await focusedRowText(page)),
)

console.log('\na dangerous scheme is never turned into a link')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('javascript:alert(1)')
await page.evaluate(() => document.activeElement?.blur())
await page.waitForTimeout(200)
check(
  'javascript: stays inert text',
  (
    await page.$$eval('.text a', (nodes) =>
      nodes.map((n) => n.getAttribute('href')),
    )
  ).every((href) => href === null || !href.startsWith('javascript:')),
)

console.log('\nmarkdown import')
await resetDocument(page)
const beforeImport = (await outlineOf(page)).length
await page.locator('header button', { hasText: 'Import' }).click()
check('the dialog opens', await page.locator('dialog').isVisible())
check(
  'the import button is inert with nothing to import',
  await page.locator('dialog .primary').isDisabled(),
)

await page.locator('dialog textarea').fill(`# Trip
- passport
  - renew it
- tickets
# Home
- keys`)
check(
  'it counts what will be added',
  (await page.locator('dialog .primary').textContent())?.includes('6 items'),
  await page.locator('dialog .primary').textContent(),
)
await page.locator('dialog .primary').click()
await page.waitForTimeout(150)
check('the dialog closes', !(await page.locator('dialog').isVisible()))

const imported = await outlineOf(page)
equal(
  'headings and list indentation become nesting',
  imported.slice(beforeImport),
  ['Trip', '  passport', '    renew it', '  tickets', 'Home', '  keys'],
)

console.log('\nimport is one undo step and is not destructive')
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
check(
  'one undo removes the whole import',
  (await outlineOf(page)).length === beforeImport,
  `${beforeImport} -> ${(await outlineOf(page)).length}`,
)

console.log('\ncancelling an import changes nothing')
await page.locator('header button', { hasText: 'Import' }).click()
await page.locator('dialog textarea').fill('- nope')
await page.locator('dialog .ghost').click()
await page.waitForTimeout(100)
check('the document is untouched', (await outlineOf(page)).length === beforeImport)

console.log('\nan imported link is clickable')
await page.locator('header button', { hasText: 'Import' }).click()
await page.locator('dialog textarea').fill('- docs https://imported.test/page')
await page.locator('dialog .primary').click()
await page.waitForTimeout(200)
check(
  'the URL from the import rendered as a link',
  (
    await page.$$eval('.text a', (nodes) =>
      nodes.map((n) => n.getAttribute('href')),
    )
  ).includes('https://imported.test/page'),
)

console.log('\ncollapse all')
await resetDocument(page)
const expandedCount = (await outlineOf(page)).length
const foldAll = page.locator('header button[aria-label="Collapse all"]')
check('the header offers a collapse-all control', await foldAll.isVisible())
await foldAll.click()
await page.waitForTimeout(150)
const folded = await outlineOf(page)
equal('only top-level rows remain', folded, ['Welcome', 'Try it'])

console.log('\nthe same control expands again')
const unfoldAll = page.locator('header button[aria-label="Expand all"]')
check('it has turned into expand-all', await unfoldAll.isVisible())
await unfoldAll.click()
await page.waitForTimeout(150)
check(
  'everything comes back',
  (await outlineOf(page)).length === expandedCount,
  `${expandedCount} -> ${(await outlineOf(page)).length}`,
)

console.log('\ncollapsing everything is one undo step')
await foldAll.click()
await page.waitForTimeout(150)
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(150)
check(
  'a single undo restores every row',
  (await outlineOf(page)).length === expandedCount,
  `${expandedCount} -> ${(await outlineOf(page)).length}`,
)

console.log('\nthe header still fits a narrow phone')
await page.setViewportSize({ width: 320, height: 640 })
await page.waitForTimeout(100)
const narrow = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}))
check(
  'four controls do not overflow at 320px',
  narrow.scrollW <= narrow.clientW,
  `${narrow.scrollW} > ${narrow.clientW}`,
)
await page.setViewportSize({ width: 390, height: 844 })

console.log('\nlong-press anywhere on a row to drag it')
await resetDocument(page)
const beforeLongPress = await outlineOf(page)
const held = await longPressDrag(page, 'Try it', { dy: -260 })
check('holding the row text picks it up', held.grabbed > 0)
check('a drop indicator follows the finger', held.indicator === 1)
const afterLongPress = await outlineOf(page)
check(
  'the row moved',
  afterLongPress.indexOf('Try it') < beforeLongPress.indexOf('Try it'),
  JSON.stringify(afterLongPress),
)
check(
  'its children came with it',
  afterLongPress[afterLongPress.indexOf('Try it') + 1]?.startsWith(
    '  Edit this line',
  ),
  JSON.stringify(afterLongPress),
)
check(
  'the page is left selectable again',
  await page.evaluate(() => !document.body.classList.contains('is-dragging-row')),
)

console.log('\nmoving before the hold completes is a scroll, not a drag')
await resetDocument(page)
const beforeQuick = await outlineOf(page)
const quick = await longPressDrag(page, 'Try it', { dy: -260, hold: 80 })
check('nothing was picked up', quick.grabbed === 0)
equal('and the outline is unchanged', await outlineOf(page), beforeQuick)

console.log('\na row that is being edited can still be dragged')
// The row keeps focus after the keyboard is dismissed, so a focused row that
// refused to be picked up left the last row touched undraggable.
await resetDocument(page)
const beforeEditingDrag = await outlineOf(page)
await clickRow(page, 'Try it')
await page.waitForTimeout(100)
const whileEditing = await longPressDrag(page, 'Try it', { dy: -260 })
check('holding a focused row picks it up', whileEditing.grabbed > 0)
const afterEditingDrag = await outlineOf(page)
check(
  'and it moves',
  afterEditingDrag.indexOf('Try it') < beforeEditingDrag.indexOf('Try it'),
  JSON.stringify(afterEditingDrag),
)

console.log('\nthe bullet still drags without any hold')
await resetDocument(page)
const beforeBullet = await outlineOf(page)
await dragRow(page, 'Try it', { dy: -260 })
check(
  'a bullet drag needs no long press',
  (await outlineOf(page)).indexOf('Try it') < beforeBullet.indexOf('Try it'),
)

console.log('\nswipe to delete still works alongside the hold')
await resetDocument(page)
await swipe(page, 'Tab indents', 260)
check(
  'a quick swipe still deletes',
  !(await outlineOf(page)).some((row) => row.includes('Tab indents')),
)

console.log('\nzoom into an item')
await resetDocument(page)
const zoomDot = (text) =>
  page.locator('.row', { hasText: text }).first().locator('.dot')
await zoomDot('Welcome').click()
await page.waitForTimeout(150)
equal("only the item's children are listed", await outlineOf(page), [
  'Return starts a new item',
  'Tab indents, Shift-Tab outdents',
  'Backspace at the start joins to the item above',
  'Tap a bullet with children to fold it',
])
check(
  'the zoomed item becomes the title',
  (await page.locator('nav h2').textContent()) === 'Welcome',
)
check(
  'a breadcrumb back to everything is offered',
  await page.locator('nav button', { hasText: 'All items' }).isVisible(),
)

console.log('\nchildren are rendered at the top level of the zoomed view')
const depthZero = await page.$$eval('.row', (nodes) =>
  nodes.map((n) =>
    Number(getComputedStyle(n).getPropertyValue('--depth').trim() || '0'),
  ),
)
check(
  'their depth restarts at zero',
  depthZero.every((d) => d === 0),
  JSON.stringify(depthZero),
)

console.log('\nediting inside a zoom stays inside it')
await clickRow(page, 'Return starts a new item')
await page.keyboard.press('Home')
await page.keyboard.press('ArrowUp')
check(
  'arrow up does not escape to the parent',
  (await focusedRowText(page)) === 'Return starts a new item',
  `focus on ${JSON.stringify(await focusedRowText(page))}`,
)
const rowsBeforeBackspace = (await outlineOf(page)).length
await page.keyboard.press('Backspace')
await page.waitForTimeout(100)
check(
  'backspace does not merge into the hidden parent',
  (await outlineOf(page)).length === rowsBeforeBackspace,
)
await page.keyboard.press('Shift+Tab')
await page.waitForTimeout(100)
check(
  'shift-tab does not lift the row out of the view',
  (await outlineOf(page)).length === rowsBeforeBackspace,
)
check(
  'and the outdent button knows it too',
  await page.locator('.bar button[aria-label="Outdent"]').isDisabled(),
)

console.log('\nzooming out again')
await page.locator('nav button', { hasText: 'All items' }).click()
await page.waitForTimeout(150)
check('the whole document is back', (await outlineOf(page)).length === 8)
check('the breadcrumb is gone', (await page.locator('nav').count()) === 0)

console.log('\nnested zoom builds a trail')
await zoomDot('Welcome').click()
await page.waitForTimeout(120)
await zoomDot('Tap a bullet with children to fold it').count()
// Zoom one level deeper using a child that has no children of its own.
await zoomDot('Tab indents, Shift-Tab outdents').click()
await page.waitForTimeout(150)
const trail = await page.$$eval('nav ol button', (nodes) =>
  nodes.map((n) => n.textContent),
)
equal('the trail lists each ancestor', trail, ['All items', 'Welcome'])
check(
  'the deepest item is the title',
  (await page.locator('nav h2').textContent()) ===
    'Tab indents, Shift-Tab outdents',
)
check('an emptied zoom shows no rows', (await outlineOf(page)).length === 0)

console.log('\nan empty zoomed item can still be typed into')
const outlineBox2 = await page.locator('.outline').boundingBox()
await page
  .locator('.outline')
  .click({ position: { x: outlineBox2.width / 2, y: outlineBox2.height - 24 } })
await page.keyboard.type('first child')
check(
  'tapping below creates a child of the zoomed item',
  (await outlineOf(page)).includes('first child'),
  JSON.stringify(await outlineOf(page)),
)

console.log('\nescape zooms out one level')
await page.keyboard.press('Escape')
await page.waitForTimeout(150)
check(
  'it lands on the parent, not all the way out',
  (await page.locator('nav h2').textContent()) === 'Welcome',
  await page.locator('nav h2').textContent(),
)

console.log('\nthe fold chevron and the zoom dot are separate controls')
await page.locator('nav button', { hasText: 'All items' }).click()
await page.waitForTimeout(150)
const beforeFold = (await outlineOf(page)).length
await page.locator('.row', { hasText: 'Welcome' }).first().locator('.fold').click()
await page.waitForTimeout(150)
check(
  'the chevron folds rather than zooming',
  (await outlineOf(page)).length < beforeFold &&
    (await page.locator('nav').count()) === 0,
)

console.log('\ninstallability')
await resetDocument(page)
const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href')
check('a manifest is linked', manifestHref === '/manifest.webmanifest')
const manifest = await page.evaluate(async (href) => {
  const response = await fetch(href)
  return response.ok ? response.json() : null
}, manifestHref)
check('it parses', manifest !== null)
check(
  'with a name and standalone display',
  manifest?.name === 'Outliner' && manifest?.display === 'standalone',
  JSON.stringify(manifest && { name: manifest.name, display: manifest.display }),
)
check(
  'and a start_url inside its scope',
  manifest?.start_url === '/' && manifest?.scope === '/',
)
const sizes = (manifest?.icons ?? []).map((icon) => icon.sizes)
check(
  'it declares a 192 and a 512 icon',
  sizes.includes('192x192') && sizes.includes('512x512'),
  JSON.stringify(sizes),
)
check(
  'one of them is maskable, for round launcher shapes',
  (manifest?.icons ?? []).some((icon) => icon.purpose === 'maskable'),
)

const iconStatuses = await page.evaluate(async (icons) => {
  const results = {}
  for (const icon of icons) {
    const response = await fetch(icon.src)
    results[icon.src] = response.status
  }
  return results
}, manifest?.icons ?? [])
check(
  'every declared icon actually exists',
  Object.values(iconStatuses).every((status) => status === 200),
  JSON.stringify(iconStatuses),
)
check(
  'iOS has its own touch icon, since it ignores the manifest',
  (await page.getAttribute('link[rel="apple-touch-icon"]', 'href')) !== null,
)

console.log('\nthe service worker takes control')
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  null,
  {
    timeout: 10000,
  },
)
check(
  'the page is controlled by a worker',
  await page.evaluate(() => navigator.serviceWorker.controller !== null),
)
const cached = await page.evaluate(async () => {
  const names = await caches.keys()
  const cache = await caches.open(names[0])
  return (await cache.keys()).map((request) => new URL(request.url).pathname).sort()
})
check(
  'the shell and its assets are precached',
  cached.includes('/') &&
    cached.some((path) => path.endsWith('.js')) &&
    cached.some((path) => path.endsWith('.css')),
  JSON.stringify(cached),
)

console.log('\nit works with the network switched off')
// The real test of the feature: a cold load with no server reachable.
await page.evaluate(() => {
  localStorage.clear()
})
await page.reload()
await page.waitForSelector('.row')
await clickRow(page, 'Edit this line')
await page.keyboard.press('End')
await page.keyboard.type(' offline')
await page.waitForTimeout(700)

await context.setOffline(true)
await page.reload()
await page.waitForSelector('.row', { timeout: 10000 })
check('the app still loads', (await outlineOf(page)).length > 0)
check(
  'and the document typed before going offline is intact',
  (await outlineOf(page)).some((row) => row.includes('Edit this line offline')),
  JSON.stringify(await outlineOf(page)),
)

console.log('\nediting continues while offline')
await clickRow(page, 'Edit this line offline')
await page.keyboard.press('End')
await page.keyboard.type('!')
check(
  'typing works with no network',
  (await focusedRowText(page)) === 'Edit this line offline!',
)
await page.waitForTimeout(700)
await page.reload()
await page.waitForSelector('.row')
check(
  'and survives another offline reload',
  (await outlineOf(page)).some((row) => row.includes('Edit this line offline!')),
)
await context.setOffline(false)

console.log('\nsync: an edit reaches the server')
await resetDocument(page)
// A fresh client against an empty store uploads what it has.
await page.waitForFunction(
  () => document.querySelector('.status')?.textContent?.includes('Saved'),
  null,
  { timeout: 15000 },
)
check('the first upload happens on its own', storedDocument() !== null)

await clickRow(page, 'Edit this line')
await page.keyboard.press('End')
await page.keyboard.type(' SYNCED')
check(
  'the status says so immediately',
  (await page.locator('.status').textContent())?.includes('Unsaved'),
  await page.locator('.status').textContent(),
)
check(
  'and nothing has been uploaded yet',
  !(storedDocument() ?? '').includes('SYNCED'),
)

// Past the five-second quiet period.
await page.waitForTimeout(7000)
check('the edit reaches the server', (storedDocument() ?? '').includes('SYNCED'))
check(
  'and the status settles on Saved',
  (await page.locator('.status').textContent())?.includes('Saved'),
  await page.locator('.status').textContent(),
)

console.log('\nsync: another device picks it up')
const second = await context.newPage()
await second.goto(BASE)
await second.waitForSelector('.row')
await second.waitForTimeout(1500)
const seen = await second.$$eval('[data-item-id]', (nodes) =>
  nodes.map((node) => node.textContent),
)
check(
  'a second client loads what the first saved',
  seen.some((text) => text?.includes('SYNCED')),
  JSON.stringify(seen.slice(0, 3)),
)

console.log('\nsync: a stale write is refused rather than applied')
// Move the server on underneath this client, exactly as a second device
// would. Its next upload must lose, and it must take the server's version.
await second.locator('[data-item-id]', { hasText: 'SYNCED' }).first().click()
await second.keyboard.press('End')
await second.keyboard.type(' FROM-SECOND')
await second.waitForTimeout(7000)
check('the second client wrote', (storedDocument() ?? '').includes('FROM-SECOND'))

await page.bringToFront()
await clickRow(page, 'Then add your own below')
await page.keyboard.press('End')
await page.keyboard.type(' FROM-FIRST')
await page.waitForTimeout(9000)
const settled = storedDocument() ?? ''
check(
  'the server keeps the version it already had',
  settled.includes('FROM-SECOND'),
  'the losing write overwrote it',
)
const firstRows = await page.$$eval('[data-item-id]', (nodes) =>
  nodes.map((node) => node.textContent),
)
check(
  'and the losing client took the server version',
  firstRows.some((text) => text?.includes('FROM-SECOND')),
  JSON.stringify(firstRows.slice(0, 4)),
)
await second.close()

console.log('\nduplicate from the keyboard bar')
await resetDocument(page)
await clickRow(page, 'Welcome')
await page.waitForTimeout(100)
const beforeDuplicate = await outlineOf(page)
await page.locator('.bar button[aria-label="Duplicate"]').tap()
await page.waitForTimeout(150)
const afterDuplicate = await outlineOf(page)
equal(
  'the item and its children are copied in directly after it',
  afterDuplicate.slice(0, 10),
  [...beforeDuplicate.slice(0, 5), ...beforeDuplicate.slice(0, 5)],
)
check(
  'the caret moves to the copy, ready to edit it',
  (await focusedRowText(page)) === 'Welcome',
  JSON.stringify(await focusedRowText(page)),
)
await page.keyboard.type(' COPY')
const edited = await outlineOf(page)
check(
  'editing the copy leaves the original alone',
  edited.filter((row) => row.trimStart() === 'Welcome').length === 1 &&
    edited.some((row) => row.includes('Welcome COPY')),
  JSON.stringify(edited.slice(0, 7)),
)

console.log('\nduplicating is a single undo step')
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
await page.locator('header button', { hasText: 'Undo' }).click()
await page.waitForTimeout(100)
equal('one undo removes the whole copy', await outlineOf(page), beforeDuplicate)

console.log('\nctrl-d duplicates from a keyboard')
// The bar only appears on touch, so without this there is no way on desktop.
await clickRow(page, 'Try it')
const beforeShortcut = (await outlineOf(page)).length
await page.keyboard.press('Control+d')
await page.waitForTimeout(150)
check(
  'the subtree is duplicated',
  (await outlineOf(page)).length === beforeShortcut + 3,
  `${beforeShortcut} -> ${(await outlineOf(page)).length}`,
)

console.log('\non touch the fold chevron sits away from the zoom dot')
await resetDocument(page)
const boxes = async (target) =>
  target.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('button.fold'),
    )
    const box = (selector) => {
      const el = row.querySelector(selector)
      if (el === null) return null
      const rect = el.getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right) }
    }
    return {
      fold: box('button.fold'),
      dot: box('.dot'),
      text: box('[data-item-id]'),
    }
  })

const touch = await boxes(page)
check(
  'the chevron is past the end of the text',
  touch.fold.left >= touch.text.right,
  JSON.stringify(touch),
)
check('the dot stays at the start', touch.dot.right <= touch.text.left)
// The whole point: a thumb aimed at one cannot land on the other.
check(
  'they are far apart',
  touch.fold.left - touch.dot.right > 200,
  `${touch.fold.left - touch.dot.right}px apart`,
)
check(
  'and the chevron still folds from there',
  await (async () => {
    const before = (await outlineOf(page)).length
    await page
      .locator('.row', { hasText: 'Welcome' })
      .first()
      .locator('.fold')
      .click()
    await page.waitForTimeout(200)
    const after = (await outlineOf(page)).length
    await page
      .locator('.row', { hasText: 'Welcome' })
      .first()
      .locator('.fold')
      .click()
    await page.waitForTimeout(200)
    return after < before
  })(),
)

console.log('\nwith a fine pointer it stays in the gutter')
// Moving it would cost text width for no benefit where taps are precise.
const desktop = await context
  .browser()
  .newContext({ viewport: { width: 900, height: 700 } })
const desktopPage = await desktop.newPage()
await desktopPage.goto(BASE)
await desktopPage.waitForSelector('.row')
const fine = await boxes(desktopPage)
check(
  'the chevron is before the text',
  fine.fold.right <= fine.text.left,
  JSON.stringify(fine),
)
check('and immediately beside the dot', fine.dot.left - fine.fold.right < 12)
await desktop.close()

console.log('\nsync: an edit that changes nothing is not uploaded')
await resetDocument(page)
await page.waitForFunction(
  () => document.querySelector('.status')?.textContent?.includes('Saved'),
  null,
  { timeout: 15000 },
)
let uploads = 0
page.on('request', (request) => {
  if (request.method() === 'PUT' && request.url().includes('/api/doc')) uploads += 1
})

// Shift-Tab at the top level is a no-op operation, but it still reports a
// change — which used to schedule a full upload of an identical document.
await clickRow(page, 'Welcome')
await page.keyboard.press('Shift+Tab')
await page.waitForTimeout(7000)
check('a no-op edit uploads nothing', uploads === 0, `${uploads} upload(s)`)

// Typing and removing it again leaves the document byte-identical.
await page.keyboard.type('zz')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await page.waitForTimeout(7000)
check(
  'typing and undoing it uploads nothing',
  uploads === 0,
  `${uploads} upload(s)`,
)

// But a real change still goes.
await page.keyboard.type(' REAL')
await page.waitForTimeout(7000)
check('a real change still uploads', uploads === 1, `${uploads} upload(s)`)
check('and reaches the server', (storedDocument() ?? '').includes('REAL'))

console.log('\npersistence across reload')

const beforeReload = await outlineOf(page)
await page.waitForTimeout(700) // let the debounced write land
await page.reload()
await page.waitForSelector('.row')
equal('the document survives a reload', await outlineOf(page), beforeReload)

console.log(`\n${checks - failures}/${checks} checks passed`)
await browser.close()
stopServer()
process.exit(failures === 0 ? 0 : 1)
