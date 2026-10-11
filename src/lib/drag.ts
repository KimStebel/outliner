/**
 * Turning a drag position into a place in the tree.
 *
 * A drag has two degrees of freedom: vertical position picks the gap between
 * rows, horizontal position picks the nesting depth. This module does the
 * second half — resolving a (gap, desired depth) pair into a concrete parent
 * and sibling — and is deliberately free of DOM so it can be tested directly.
 */

import type { Doc, ItemId, Row } from './model'
import { getItem } from './model'

/** Where a drag began, as reported by whichever element started it. */
export interface DragStart {
  pointerId: number
  clientX: number
  clientY: number
  /**
   * Start dragging at once rather than waiting for travel. A long press has
   * already expressed the intent; the bullet, which must also work with a
   * mouse, waits for movement so a plain click still folds the row.
   */
  immediate: boolean
}

export interface DropTarget {
  parentId: ItemId
  /** Insert directly after this sibling, or at the start when `null`. */
  afterId: ItemId | null
  /** The depth actually used, after clamping. Drives the drop indicator. */
  depth: number
}

/**
 * Resolve a drop.
 *
 * `rows` must be the visible rows *excluding the dragged subtree* — the
 * dragged item cannot be its own neighbour, and its descendants travel with
 * it. `gapIndex` is the position in that list the item would occupy.
 *
 * The depth is clamped to what the surrounding rows allow:
 *
 * - At most one level deeper than the row above, since you can become its
 *   child but not its grandchild — there is no intermediate item to adopt you.
 * - At least as deep as the row below. Dropping shallower would leave that row
 *   rendered beneath a new, shallower parent it does not belong to, which the
 *   tree cannot express.
 */
export function projectDrop(
  doc: Doc,
  rows: readonly Row[],
  gapIndex: number,
  desiredDepth: number,
  /** The item the view is rooted at; depth 0 means a child of this. */
  rootId: ItemId = doc.rootId,
): DropTarget {
  const previous = rows[gapIndex - 1]
  if (previous === undefined) {
    // Above everything: the only possibility is first child of the root.
    return { parentId: rootId, afterId: null, depth: 0 }
  }

  const next = rows[gapIndex]
  const maxDepth = previous.depth + 1
  const minDepth = next?.depth ?? 0
  const depth = Math.max(minDepth, Math.min(desiredDepth, maxDepth))

  if (depth > previous.depth) {
    return { parentId: previous.id, afterId: null, depth }
  }

  // Walk up from the row above until we reach the chosen depth; the item lands
  // just after whatever ancestor sits at that level.
  let anchor = previous.id
  for (let current = previous.depth; current > depth; current -= 1) {
    const parent = getItem(doc, anchor).parent
    if (parent === null) break
    anchor = parent
  }

  return {
    parentId: getItem(doc, anchor).parent ?? rootId,
    afterId: anchor,
    depth,
  }
}
