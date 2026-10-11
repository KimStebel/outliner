/**
 * Editing operations.
 *
 * Every op takes a {@link Tx} (which journals its inverse) and returns the
 * caret position the renderer should move to, or `null` to mean "leave the
 * caret where it is". Ops never touch the DOM and never decide what is
 * focused — they only describe intent.
 *
 * Ops are total: an operation that cannot apply (outdenting a top-level item,
 * indenting a first child) is a no-op returning `null`, rather than an error.
 * The UI can then bind keys unconditionally without pre-checking.
 */

import type { Caret, Doc, ItemId } from './model'
import {
  createItem,
  getItem,
  isDescendantOf,
  nextVisibleOutsideSubtree,
  previousVisible,
  subtreeIds,
} from './model'
import type { Tx } from './tx'

export interface OpContext {
  newId: () => ItemId
}

/** Replace an item's text. The caller owns the caret, since it knows the DOM selection. */
export function setText(tx: Tx, id: ItemId, text: string): null {
  tx.update(id, (item) => {
    item.text = text
  })
  return null
}

export function setCollapsed(tx: Tx, id: ItemId, collapsed: boolean): null {
  const item = tx.get(id)
  // Collapsing a leaf would hide nothing and leaves a confusing twisty state.
  if (item.children.length === 0) return null
  tx.update(id, (target) => {
    target.collapsed = collapsed
  })
  return null
}

export function toggleCollapsed(tx: Tx, id: ItemId): null {
  return setCollapsed(tx, id, !tx.get(id).collapsed)
}

/** Order and clamp a selection range against the text it indexes into. */
function clampRange(text: string, start: number, end: number): [number, number] {
  const lo = Math.max(0, Math.min(Math.min(start, end), text.length))
  const hi = Math.max(lo, Math.min(Math.max(start, end), text.length))
  return [lo, hi]
}

/**
 * Enter. Splits `id` at the caret, discarding any selected range so that
 * pressing Enter over a selection replaces it, as in any text field.
 *
 * Three cases, matching what outliners do and what the caret makes you expect:
 *
 * - At a collapsed caret at offset 0 of a non-empty item, push the current
 *   line down: a new empty sibling goes *above*, and the caret stays put.
 *   Moving all the text into a new record instead would make the caret appear
 *   to jump.
 * - If the item has visible children, the tail becomes the new *first child* —
 *   the children belong to the head, so a sibling would detach them.
 * - Otherwise the tail becomes the next sibling.
 */
export function splitItem(
  tx: Tx,
  ctx: OpContext,
  id: ItemId,
  start: number,
  end: number = start,
): Caret {
  const item = tx.get(id)
  const [from, to] = clampRange(item.text, start, end)
  const head = item.text.slice(0, from)
  const tail = item.text.slice(to)

  if (from === 0 && to === 0 && item.text.length > 0) {
    const sibling = createItem(ctx.newId(), item.parent, '')
    insertSiblingAt(tx, sibling, id, 'before')
    return { id, offset: 0 }
  }

  tx.update(id, (target) => {
    target.text = head
  })

  const hasVisibleChildren = item.children.length > 0 && !item.collapsed
  if (hasVisibleChildren) {
    const child = createItem(ctx.newId(), id, tail)
    tx.insert(child)
    tx.update(id, (target) => {
      target.children.unshift(child.id)
    })
    return { id: child.id, offset: 0 }
  }

  const sibling = createItem(ctx.newId(), item.parent, tail)
  insertSiblingAt(tx, sibling, id, 'after')
  return { id: sibling.id, offset: 0 }
}

/**
 * Replace the range `[start, end)` of `id` with `text` — the paste path, and
 * also how typed input over a selection is applied.
 *
 * Multi-line text becomes multiple items rather than one item containing
 * newlines: a row holds a single line by definition, and flattening the breaks
 * to spaces would silently discard the structure someone just pasted. The whole
 * insert is one transaction, so pasting fifty lines is still one undo step.
 *
 * New items go where {@link splitItem} would put them: first children if the
 * item has visible children, otherwise next siblings.
 */
export function replaceRange(
  tx: Tx,
  ctx: OpContext,
  id: ItemId,
  start: number,
  end: number,
  text: string,
): Caret {
  const item = tx.get(id)
  const [from, to] = clampRange(item.text, start, end)
  const head = item.text.slice(0, from)
  const tail = item.text.slice(to)

  const lines = text.split(/\r\n|\r|\n/)
  // A trailing newline is a routine copy artefact and should not leave an
  // empty row behind.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const first = lines[0] ?? ''

  if (lines.length === 1) {
    tx.update(id, (target) => {
      target.text = head + first + tail
    })
    return { id, offset: head.length + first.length }
  }

  tx.update(id, (target) => {
    target.text = head + first
  })

  const rest = lines.slice(1)
  const asChildren = item.children.length > 0 && !item.collapsed
  const containerId = asChildren ? id : item.parent
  if (containerId === null) throw new Error('Cannot insert text into the root')
  const insertAtIndex = asChildren
    ? 0
    : tx.get(containerId).children.indexOf(id) + 1

  const created = rest.map((line, index) =>
    // The text that followed the caret rides along on the final new row.
    createItem(
      ctx.newId(),
      containerId,
      line + (index === rest.length - 1 ? tail : ''),
    ),
  )
  for (const row of created) tx.insert(row)
  tx.update(containerId, (container) => {
    container.children.splice(insertAtIndex, 0, ...created.map((row) => row.id))
  })

  const last = created[created.length - 1]
  if (last === undefined) return { id, offset: head.length + first.length }
  return { id: last.id, offset: (rest[rest.length - 1] ?? '').length }
}

/** Insert an empty sibling directly after `id`, regardless of children. */
export function insertAfter(tx: Tx, ctx: OpContext, id: ItemId): Caret {
  const item = tx.get(id)
  const sibling = createItem(ctx.newId(), item.parent, '')
  insertSiblingAt(tx, sibling, id, 'after')
  return { id: sibling.id, offset: 0 }
}

function insertSiblingAt(
  tx: Tx,
  sibling: ReturnType<typeof createItem>,
  relativeTo: ItemId,
  side: 'before' | 'after',
): void {
  const parentId = tx.get(relativeTo).parent
  if (parentId === null) throw new Error('Cannot add a sibling to the root')
  sibling.parent = parentId
  tx.insert(sibling)
  tx.update(parentId, (parent) => {
    const index = parent.children.indexOf(relativeTo)
    parent.children.splice(side === 'after' ? index + 1 : index, 0, sibling.id)
  })
}

/**
 * Tab. Makes `id` the last child of its previous sibling.
 *
 * No-op for a first child, which has nothing to nest under. If the new parent
 * was collapsed it is expanded, so the item does not vanish as you indent it.
 */
export function indentItem(tx: Tx, id: ItemId): null {
  const item = tx.get(id)
  if (item.parent === null) return null

  const parent = tx.get(item.parent)
  const index = parent.children.indexOf(id)
  const newParentId = index > 0 ? parent.children[index - 1] : undefined
  if (newParentId === undefined) return null

  tx.update(parent.id, (target) => {
    target.children.splice(target.children.indexOf(id), 1)
  })
  tx.update(newParentId, (target) => {
    target.children.push(id)
    target.collapsed = false
  })
  tx.update(id, (target) => {
    target.parent = newParentId
  })
  return null
}

/**
 * Shift-Tab. Makes `id` the next sibling of its parent.
 *
 * Any siblings that followed `id` are adopted as its children. Without that,
 * they would end up rendered *above* the outdented item despite having come
 * after it — outdent would silently reorder the document.
 *
 * No-op at depth 0, where there is no shallower level to move to.
 */
export function outdentItem(tx: Tx, id: ItemId): null {
  const item = tx.get(id)
  if (item.parent === null) return null

  const parent = tx.get(item.parent)
  if (parent.parent === null) return null // already top level

  const grandparentId = parent.parent
  const index = parent.children.indexOf(id)
  const followingSiblings = parent.children.slice(index + 1)

  tx.update(parent.id, (target) => {
    target.children.splice(index)
  })

  for (const siblingId of followingSiblings) {
    tx.update(siblingId, (sibling) => {
      sibling.parent = id
    })
  }
  if (followingSiblings.length > 0) {
    tx.update(id, (target) => {
      target.children.push(...followingSiblings)
      // Adopted children must not land inside a collapsed node, or they vanish.
      target.collapsed = false
    })
  }

  tx.update(id, (target) => {
    target.parent = grandparentId
  })
  tx.update(grandparentId, (target) => {
    target.children.splice(target.children.indexOf(parent.id) + 1, 0, id)
  })
  return null
}

/**
 * Delete an item and everything under it — the swipe-right gesture.
 *
 * The caret moves to the row that *follows* the deleted subtree, at its start:
 * the list closes up under the caret and editing carries on downwards. Only
 * when nothing follows does it fall back to the preceding row, landing at the
 * end of that text.
 *
 * The document is never left empty; see {@link ensureNonEmpty}.
 */
export function removeSubtree(tx: Tx, ctx: OpContext, id: ItemId): Caret | null {
  const item = tx.get(id)
  if (item.parent === null) return null

  // Resolve the caret target before the subtree stops existing. Neither
  // candidate can be inside it: one skips past the subtree, the other
  // precedes it.
  const following = nextVisibleOutsideSubtree(tx.doc, id)
  const preceding =
    following === undefined ? previousVisible(tx.doc, id) : undefined
  const precedingLength =
    preceding === undefined ? 0 : getItem(tx.doc, preceding).text.length

  const doomed = subtreeIds(tx.doc, id)
  const parentId = item.parent

  tx.update(parentId, (parent) => {
    parent.children.splice(parent.children.indexOf(id), 1)
  })
  for (const doomedId of doomed) {
    tx.remove(doomedId)
  }

  if (following !== undefined) return { id: following, offset: 0 }
  if (preceding !== undefined) return { id: preceding, offset: precedingLength }
  return ensureNonEmpty(tx, ctx)
}

/**
 * Backspace at offset 0. Appends this item's text to the preceding visible row
 * and deletes it.
 *
 * Any children follow the text to the item it merged into, so nothing is ever
 * dropped. Where they land depends on which row preceded this one:
 *
 * - Merging a *first child* into its parent puts them at the position the item
 *   itself occupied, so the siblings that followed it keep their place.
 * - Otherwise the previous visible row is, by construction, the deepest
 *   last-descendant before this item, so appending keeps document order.
 *
 * Either way the destination is expanded when it adopts children: dropping
 * them into a collapsed item would make them vanish on a keystroke, which
 * reads as data loss even though nothing was lost.
 */
export function mergeWithPrevious(tx: Tx, id: ItemId): Caret | null {
  const item = tx.get(id)
  if (item.parent === null) return null

  const previousId = previousVisible(tx.doc, id)
  if (previousId === undefined) return null

  const parentId = item.parent
  const joinOffset = tx.get(previousId).text.length
  const carriedText = item.text
  const adopted = [...item.children]
  const vacatedIndex = tx.get(parentId).children.indexOf(id)

  tx.update(parentId, (parent) => {
    parent.children.splice(vacatedIndex, 1)
  })

  if (adopted.length > 0) {
    for (const childId of adopted) {
      tx.update(childId, (child) => {
        child.parent = previousId
      })
    }
    tx.update(previousId, (target) => {
      if (previousId === parentId) {
        target.children.splice(vacatedIndex, 0, ...adopted)
      } else {
        target.children.push(...adopted)
      }
      target.collapsed = false
    })
  }

  if (carriedText.length > 0) {
    tx.update(previousId, (target) => {
      target.text += carriedText
    })
  }
  tx.remove(id)
  return { id: previousId, offset: joinOffset }
}

/**
 * Move `id` to be a child of `newParentId`, directly after `afterId` (or first
 * when that is `null`). Backs drag and drop; the item's own subtree travels
 * with it, since only the parent link changes.
 *
 * Refuses to move an item inside its own subtree, which would detach that
 * whole branch from the root.
 */
export function moveItem(
  tx: Tx,
  id: ItemId,
  newParentId: ItemId,
  afterId: ItemId | null,
): null {
  const item = tx.get(id)
  if (item.parent === null) return null
  if (id === newParentId) return null
  if (isDescendantOf(tx.doc, newParentId, id)) return null
  if (item.parent === newParentId && afterId === id) return null

  const oldParentId = item.parent
  tx.update(oldParentId, (parent) => {
    parent.children.splice(parent.children.indexOf(id), 1)
  })

  // Index is resolved after the removal, so a move within one parent cannot
  // be thrown off by the shift.
  tx.update(newParentId, (parent) => {
    if (afterId === null) {
      parent.children.unshift(id)
      return
    }
    const at = parent.children.indexOf(afterId)
    if (at === -1) parent.children.push(id)
    else parent.children.splice(at + 1, 0, id)
  })

  tx.update(id, (target) => {
    target.parent = newParentId
  })

  if (newParentId !== tx.doc.rootId) {
    // Dropping into a folded parent would make the item vanish on release.
    tx.update(newParentId, (parent) => {
      parent.collapsed = false
    })
  }
  return null
}

/**
 * Guarantee at least one item exists, so there is always a row to type into.
 * Returns the caret for a freshly created item, or `null` if none was needed.
 */
export function ensureNonEmpty(tx: Tx, ctx: OpContext): Caret | null {
  const root = tx.get(tx.doc.rootId)
  if (root.children.length > 0) return null

  const item = createItem(ctx.newId(), root.id, '')
  tx.insert(item)
  tx.update(root.id, (target) => {
    target.children.push(item.id)
  })
  return { id: item.id, offset: 0 }
}

/**
 * Structural self-check, used by the persistence validator and by tests.
 * Returns the problems found; an empty array means the document is sound.
 */
export function validateDoc(doc: Doc): string[] {
  const problems: string[] = []
  const root = doc.items[doc.rootId]
  if (root === undefined) {
    return [`Missing root item: ${doc.rootId}`]
  }
  if (root.parent !== null) problems.push('Root must have a null parent')

  for (const [id, item] of Object.entries(doc.items)) {
    if (item.id !== id) problems.push(`Key ${id} does not match item id ${item.id}`)
    if (new Set(item.children).size !== item.children.length) {
      problems.push(`Item ${id} lists a duplicate child`)
    }
    for (const childId of item.children) {
      const child = doc.items[childId]
      if (child === undefined) {
        problems.push(`Item ${id} references missing child ${childId}`)
      } else if (child.parent !== id) {
        problems.push(`Child ${childId} does not point back to parent ${id}`)
      }
    }
    if (item.parent !== null) {
      const parent = doc.items[item.parent]
      if (parent === undefined) {
        problems.push(`Item ${id} references missing parent ${item.parent}`)
      } else if (!parent.children.includes(id)) {
        problems.push(`Parent ${item.parent} does not list child ${id}`)
      }
    }
  }

  // Every item must be reachable from the root: catches cycles and orphans,
  // which the pairwise checks above cannot see.
  const reachable = new Set(subtreeIdsSafe(doc, doc.rootId))
  for (const id of Object.keys(doc.items)) {
    if (!reachable.has(id)) problems.push(`Item ${id} is unreachable from the root`)
  }
  return problems
}

/** Like `subtreeIds`, but cycle- and dangling-reference-tolerant. */
function subtreeIdsSafe(doc: Doc, from: ItemId): ItemId[] {
  const seen = new Set<ItemId>()
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const item = doc.items[current]
    if (item === undefined) continue
    for (const child of item.children) stack.push(child)
  }
  return [...seen]
}
