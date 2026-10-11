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
  const handle = page
    .locator('.row', { hasText: rowText })
    .first()
    .locator('.bullet')
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
  await page.waitForTimeout(600)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.row')
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

console.log('\nthe bullet shows the fold state')
const chevron = page
  .locator('.row', { hasText: 'Welcome' })
  .first()
  .locator('.chevron')
const bullet = page
  .locator('.row', { hasText: 'Welcome' })
  .first()
  .locator('button')
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
