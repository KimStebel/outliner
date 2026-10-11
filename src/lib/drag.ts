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
): DropTarget {
  const previous = rows[gapIndex - 1]
  if (previous === undefined) {
    // Above everything: the only possibility is first child of the root.
    return { parentId: doc.rootId, afterId: null, depth: 0 }
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
    parentId: getItem(doc, anchor).parent ?? doc.rootId,
    afterId: anchor,
    depth,
  }
}
