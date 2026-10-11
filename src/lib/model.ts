/**
 * The document model: a flat map of items plus ordered child lists.
 *
 * Flat rather than nested because every structural edit (indent, outdent,
 * delete-subtree) then touches two or three records instead of rebuilding a
 * tree, and because the undo journal can record whole records cheaply.
 *
 * Items are mutated in place. That is deliberate: in phase 2 the `Doc` gets
 * wrapped in Svelte's `$state` proxy, so an in-place `item.text = …` invalidates
 * only the one row's binding instead of re-rendering the list on every
 * keystroke. Nothing in this file imports Svelte, so it stays unit-testable in
 * plain Node.
 */

export type ItemId = string

export interface Item {
  id: ItemId
  text: string
  /** `null` only for the root sentinel. */
  parent: ItemId | null
  /** Ordered. The single source of truth for sibling order. */
  children: ItemId[]
  collapsed: boolean
}

export interface Doc {
  items: Record<ItemId, Item>
  rootId: ItemId
}

/**
 * Where the text cursor should sit after an edit. Ops return this so the
 * renderer knows what to focus; undo restores the caret along with the content,
 * which is what makes undo feel non-destructive.
 */
export interface Caret {
  id: ItemId
  offset: number
}

/** A row of the flattened, currently-visible tree. */
export interface Row {
  id: ItemId
  /** 0 for children of the render root. */
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

export const ROOT_ID = 'root'

export function createItem(id: ItemId, parent: ItemId | null, text = ''): Item {
  return { id, parent, text, children: [], collapsed: false }
}

/** Deep-enough copy for journalling: only `children` needs unsharing. */
export function cloneItem(item: Item): Item {
  return { ...item, children: [...item.children] }
}

/**
 * A new document: the root sentinel plus one empty item, so there is always
 * somewhere to type. The root itself is never rendered.
 */
export function createDoc(firstItemId: ItemId): Doc {
  const root = createItem(ROOT_ID, null)
  const first = createItem(firstItemId, ROOT_ID)
  root.children.push(first.id)
  return { rootId: ROOT_ID, items: { [root.id]: root, [first.id]: first } }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findItem(doc: Doc, id: ItemId): Item | undefined {
  return doc.items[id]
}

/**
 * Throws if the id is unknown. Callers holding an id across an edit should
 * reach for {@link findItem} instead — a deleted subtree invalidates ids.
 */
export function getItem(doc: Doc, id: ItemId): Item {
  const item = doc.items[id]
  if (item === undefined) throw new Error(`Unknown item id: ${id}`)
  return item
}

export function isRoot(doc: Doc, id: ItemId): boolean {
  return id === doc.rootId
}

export function parentOf(doc: Doc, id: ItemId): Item | undefined {
  const parentId = getItem(doc, id).parent
  return parentId === null ? undefined : getItem(doc, parentId)
}

/** Position of `id` among its parent's children, or -1 if it has no parent. */
export function indexInParent(doc: Doc, id: ItemId): number {
  const parent = parentOf(doc, id)
  return parent ? parent.children.indexOf(id) : -1
}

export function previousSibling(doc: Doc, id: ItemId): ItemId | undefined {
  const parent = parentOf(doc, id)
  if (!parent) return undefined
  const index = parent.children.indexOf(id)
  return index > 0 ? parent.children[index - 1] : undefined
}

export function nextSibling(doc: Doc, id: ItemId): ItemId | undefined {
  const parent = parentOf(doc, id)
  if (!parent) return undefined
  const index = parent.children.indexOf(id)
  return index === -1 ? undefined : parent.children[index + 1]
}

/** Depth relative to `fromId` (default: the document root). */
export function depthOf(doc: Doc, id: ItemId, fromId: ItemId = doc.rootId): number {
  let depth = -1
  let cursor: ItemId | null = id
  while (cursor !== null) {
    if (cursor === fromId) return depth
    cursor = getItem(doc, cursor).parent
    depth += 1
  }
  return -1
}

export function isDescendantOf(doc: Doc, id: ItemId, ancestorId: ItemId): boolean {
  let cursor = getItem(doc, id).parent
  while (cursor !== null) {
    if (cursor === ancestorId) return true
    cursor = getItem(doc, cursor).parent
  }
  return false
}

/** Pre-order ids of the subtree rooted at `id`, including `id` itself. */
export function subtreeIds(doc: Doc, id: ItemId): ItemId[] {
  const out: ItemId[] = []
  const stack: ItemId[] = [id]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    out.push(current)
    const item = getItem(doc, current)
    // Push reversed so the shallowest sibling is processed first.
    for (let i = item.children.length - 1; i >= 0; i -= 1) {
      const child = item.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Visible-tree traversal
//
// "Visible" means reachable from the render root without passing through a
// collapsed item. This is the order the user sees, so it is the order that
// Backspace-merge and arrow navigation must follow.
// ---------------------------------------------------------------------------

export function visibleRows(doc: Doc, fromId: ItemId = doc.rootId): Row[] {
  const rows: Row[] = []
  const walk = (parentId: ItemId, depth: number): void => {
    for (const childId of getItem(doc, parentId).children) {
      const child = getItem(doc, childId)
      const hasChildren = child.children.length > 0
      rows.push({ id: childId, depth, hasChildren, collapsed: child.collapsed })
      if (hasChildren && !child.collapsed) walk(childId, depth + 1)
    }
  }
  walk(fromId, 0)
  return rows
}

/** Deepest last descendant reachable without expanding anything. */
export function lastVisibleInSubtree(doc: Doc, id: ItemId): ItemId {
  let item = getItem(doc, id)
  while (item.children.length > 0 && !item.collapsed) {
    const last = item.children[item.children.length - 1]
    if (last === undefined) break
    item = getItem(doc, last)
  }
  return item.id
}

export function nextVisible(doc: Doc, id: ItemId): ItemId | undefined {
  const item = getItem(doc, id)
  if (item.children.length > 0 && !item.collapsed) return item.children[0]

  let cursor = item
  while (cursor.parent !== null) {
    const parent = getItem(doc, cursor.parent)
    const sibling = parent.children[parent.children.indexOf(cursor.id) + 1]
    if (sibling !== undefined) return sibling
    cursor = parent
  }
  return undefined
}

export function previousVisible(doc: Doc, id: ItemId): ItemId | undefined {
  const item = getItem(doc, id)
  if (item.parent === null) return undefined

  const parent = getItem(doc, item.parent)
  const index = parent.children.indexOf(id)
  if (index <= 0) {
    // First child: the parent itself precedes it, unless the parent is the
    // unrendered root sentinel.
    return parent.id === doc.rootId ? undefined : parent.id
  }
  const prev = parent.children[index - 1]
  return prev === undefined ? undefined : lastVisibleInSubtree(doc, prev)
}
