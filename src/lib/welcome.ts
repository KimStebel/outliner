/**
 * The document a first-time visitor sees. It doubles as a reminder of the
 * keys, since there is no other UI explaining them yet.
 */

import type { Doc, Item, ItemId } from './model'
import { ROOT_ID, createItem } from './model'

/** `[depth, text]`, depth 0 being top level. */
const LINES: ReadonlyArray<readonly [number, string]> = [
  [0, 'Welcome'],
  [1, 'Return starts a new item'],
  [1, 'Tab indents, Shift-Tab outdents'],
  [1, 'Backspace at the start joins to the item above'],
  [1, 'Tap a bullet with children to fold it'],
  [0, 'Try it'],
  [1, 'Edit this line'],
  [1, 'Then add your own below'],
]

export function welcomeDoc(newId: () => ItemId): Doc {
  const root = createItem(ROOT_ID, null)
  const items: Record<ItemId, Item> = { [ROOT_ID]: root }
  /** Most recent item at each depth, so the next line can find its parent. */
  const parentAtDepth: ItemId[] = [ROOT_ID]

  for (const [depth, text] of LINES) {
    const parentId = parentAtDepth[depth]
    const parent = parentId === undefined ? undefined : items[parentId]
    if (parentId === undefined || parent === undefined) {
      throw new Error(`Welcome line "${text}" is indented past its parent`)
    }

    const item = createItem(newId(), parentId, text)
    items[item.id] = item
    parent.children.push(item.id)
    parentAtDepth[depth + 1] = item.id
    parentAtDepth.length = depth + 2
  }

  return { rootId: ROOT_ID, items }
}
