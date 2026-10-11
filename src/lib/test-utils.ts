/**
 * Outline <-> Doc conversion, for tests only.
 *
 * Structural assertions are far easier to review as indented text than as
 * records and id arrays, so tests are written against this notation:
 *
 *   a
 *     b
 *     c
 *
 * Two spaces per level. A leading `>` marks a collapsed item (`> a`).
 * Ids are assigned `i1…iN` in document order; look them up by text with
 * {@link idOf}.
 */

import type { Doc, Item, ItemId } from './model'
import { ROOT_ID, createItem, getItem, visibleRows } from './model'

const INDENT_WIDTH = 2

export function docFromOutline(outline: string): Doc {
  const root = createItem(ROOT_ID, null)
  const items: Record<ItemId, Item> = { [ROOT_ID]: root }
  /** Most recent item id seen at each depth. */
  const parentAtDepth: ItemId[] = [ROOT_ID]
  let counter = 0

  const lines = outline.split('\n').filter((line) => line.trim().length > 0)
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (indent % INDENT_WIDTH !== 0) {
      throw new Error(
        `Outline indent must be a multiple of ${INDENT_WIDTH}: "${line}"`,
      )
    }
    const depth = indent / INDENT_WIDTH
    const parentId = parentAtDepth[depth]
    if (parentId === undefined) {
      throw new Error(`Outline line is indented past its parent: "${line}"`)
    }

    let text = line.trim()
    let collapsed = false
    if (text.startsWith('>')) {
      collapsed = true
      text = text.slice(1).trim()
    }

    counter += 1
    const item = createItem(`i${counter}`, parentId, text)
    item.collapsed = collapsed
    items[item.id] = item
    const parent = items[parentId]
    if (parent === undefined) throw new Error(`Missing parent ${parentId}`)
    parent.children.push(item.id)
    parentAtDepth[depth + 1] = item.id
    parentAtDepth.length = depth + 2
  }

  return { rootId: ROOT_ID, items }
}

/** Serialise the full tree, collapsed or not. Mirrors {@link docFromOutline}. */
export function outlineOf(doc: Doc, fromId: ItemId = doc.rootId): string {
  const lines: string[] = []
  const walk = (parentId: ItemId, depth: number): void => {
    for (const childId of getItem(doc, parentId).children) {
      const child = getItem(doc, childId)
      const marker = child.collapsed && child.children.length > 0 ? '> ' : ''
      lines.push(`${' '.repeat(depth * INDENT_WIDTH)}${marker}${child.text}`)
      walk(childId, depth + 1)
    }
  }
  walk(fromId, 0)
  return lines.join('\n')
}

/** Serialise only what the user would see — collapsed subtrees omitted. */
export function visibleOutlineOf(doc: Doc, fromId: ItemId = doc.rootId): string {
  return visibleRows(doc, fromId)
    .map(
      (row) =>
        `${' '.repeat(row.depth * INDENT_WIDTH)}${getItem(doc, row.id).text}`,
    )
    .join('\n')
}

/** The id of the single item with this text. Throws unless exactly one matches. */
export function idOf(doc: Doc, text: string): ItemId {
  const matches = Object.values(doc.items).filter((item) => item.text === text)
  if (matches.length === 0) throw new Error(`No item with text "${text}"`)
  if (matches.length > 1) throw new Error(`Text "${text}" is ambiguous`)
  const match = matches[0]
  if (match === undefined) throw new Error(`No item with text "${text}"`)
  return match.id
}

/** Strip the leading newline and common indentation from a template literal. */
export function outline(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const raw = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
    '',
  )
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  const shortest = lines.reduce(
    (min, line) => Math.min(min, line.length - line.trimStart().length),
    Infinity,
  )
  const strip = Number.isFinite(shortest) ? shortest : 0
  return lines.map((line) => line.slice(strip)).join('\n')
}
