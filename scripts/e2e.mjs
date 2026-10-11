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

async function clickRow(page, text) {
  await page.locator('[data-item-id]', { hasText: text }).first().click()
}

// `detached` puts the server in its own process group. npx launches vite via a
// shell, so killing the direct child would orphan the node process and leave
// the port bound; killing the group takes the whole tree.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

function stopServer() {
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
page.on('console', (message) => {
  if (message.type() === 'error') {
    failures += 1
    console.log(`  FAIL console error — ${message.text()}`)
  }
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
await clickRow(page, 'Try it')
await page.keyboard.press('Home')
await page.keyboard.press('ArrowUp')
check(
  'arrow up moves to the previous visible row',
  (await focusedRowText(page)) === 'Tap a bullet with children to fold it',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)
await page.keyboard.press('ArrowDown')
check(
  'arrow down comes back',
  (await focusedRowText(page)) === 'Try it',
  `got ${JSON.stringify(await focusedRowText(page))}`,
)

console.log('\ncollapse hides children')
const beforeCollapse = (await outlineOf(page)).length
await page.locator('.row', { hasText: 'Welcome' }).first().locator('button').click()
const afterCollapse = (await outlineOf(page)).length
check(
  'folding Welcome hides its four children',
  beforeCollapse - afterCollapse === 4,
  `${beforeCollapse} -> ${afterCollapse}`,
)
await page.locator('.row', { hasText: 'Welcome' }).first().locator('button').click()
check('unfolding restores them', (await outlineOf(page)).length === beforeCollapse)

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
