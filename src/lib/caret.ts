/**
 * Selection and caret plumbing for `contenteditable` rows.
 *
 * All offsets here are plain character offsets into a row's text, matching the
 * model's `Caret.offset`. The DOM's node/offset pairs never escape this module.
 */

export interface TextRange {
  start: number
  end: number
}

/** Character offset of a DOM position, measured from the start of `el`. */
function offsetWithin(
  el: HTMLElement,
  container: Node,
  nodeOffset: number,
): number {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.setEnd(container, nodeOffset)
  return range.toString().length
}

/**
 * The current selection as character offsets, or `null` if the selection is
 * not inside `el`. `start` is always <= `end`, regardless of drag direction.
 */
export function selectionRangeIn(el: HTMLElement): TextRange | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    return null
  }
  const start = offsetWithin(el, range.startContainer, range.startOffset)
  const end = offsetWithin(el, range.endContainer, range.endOffset)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

export function caretOffsetIn(el: HTMLElement): number {
  return selectionRangeIn(el)?.start ?? 0
}

export function hasCollapsedSelection(): boolean {
  const selection = window.getSelection()
  return selection === null || selection.isCollapsed
}

/** Resolve a character offset to the text node and node-offset that hold it. */
function locate(el: HTMLElement, offset: number): { node: Node; offset: number } {
  const target = Math.max(0, offset)
  let remaining = target
  let lastText: Text | null = null

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (remaining <= text.data.length) return { node: text, offset: remaining }
    remaining -= text.data.length
    lastText = text
  }

  // Past the end, or no text at all (an empty row holds no text node).
  if (lastText !== null) return { node: lastText, offset: lastText.data.length }
  return { node: el, offset: 0 }
}

export function setCaretIn(el: HTMLElement, offset: number): void {
  const selection = window.getSelection()
  if (selection === null) return

  const { node, offset: nodeOffset } = locate(el, offset)
  const range = document.createRange()
  range.setStart(node, nodeOffset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Bounding box of the caret. Returns `null` when it cannot be measured, which
 * callers treat as "assume a line boundary" — being slightly too eager to move
 * between rows is better than a caret that will not move at all.
 */
function caretRect(el: HTMLElement): DOMRect | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer)) return null

  const rects = range.getClientRects()
  const first = rects[0]
  if (first !== undefined && first.height > 0) return first

  // A collapsed range at a text-node boundary often reports no rects at all.
  // Measuring the character before it gives the same line.
  if (range.startOffset > 0) {
    const probe = range.cloneRange()
    probe.setStart(range.startContainer, range.startOffset - 1)
    const probeRects = probe.getClientRects()
    const last = probeRects[probeRects.length - 1]
    if (last !== undefined && last.height > 0) return last
  }
  return null
}

/**
 * Whether the caret sits on the first wrapped line of the row.
 *
 * Checking geometry rather than `offset === 0` is what makes arrow keys behave
 * inside a row whose text wraps over several lines: within the row the browser
 * moves the caret itself, and we only take over at the real edges. Assumes the
 * element has no vertical padding, which `Row.svelte` enforces.
 */
export function isOnFirstVisualLine(el: HTMLElement): boolean {
  const caret = caretRect(el)
  if (caret === null) return true
  return caret.top - el.getBoundingClientRect().top < caret.height * 0.5
}

export function isOnLastVisualLine(el: HTMLElement): boolean {
  const caret = caretRect(el)
  if (caret === null) return true
  return el.getBoundingClientRect().bottom - caret.bottom < caret.height * 0.5
}

/**
 * Whether `contenteditable="plaintext-only"` is honoured.
 *
 * It is the better mode — the browser stops rich paste and formatting commands
 * for us — but an unrecognised value maps to "inherit", which would leave the
 * row *not editable at all*. So detect rather than assume, and fall back to
 * `true` plus our own paste and formatting handling.
 */
export function supportsPlaintextOnly(): boolean {
  if (typeof document === 'undefined') return false
  const probe = document.createElement('div')
  probe.setAttribute('contenteditable', 'plaintext-only')
  return probe.contentEditable === 'plaintext-only'
}
