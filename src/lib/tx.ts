/**
 * Record-level change journalling.
 *
 * Rather than hand-writing an inverse for every operation — error-prone for
 * things like outdent, which rewrites three records and adopts siblings — each
 * op runs inside a {@link Tx} that snapshots the *before* image of every record
 * it touches. The inverse of any op, however complex, is then just "put these
 * records back".
 *
 * Because the model is flat, a journal entry is a handful of small records, so
 * this stays cheap enough to run on every keystroke.
 */

import type { Doc, Item, ItemId } from './model'
import { cloneItem, getItem } from './model'

export interface Change {
  id: ItemId
  /** `undefined` means the record did not exist before the change. */
  before: Item | undefined
  /** `undefined` means the record was deleted. */
  after: Item | undefined
}

export class Tx {
  readonly doc: Doc
  /** Insertion-ordered; `undefined` value means "did not exist". */
  private readonly befores = new Map<ItemId, Item | undefined>()

  constructor(doc: Doc) {
    this.doc = doc
  }

  /** Snapshot a record before its first modification in this transaction. */
  private touch(id: ItemId): void {
    if (this.befores.has(id)) return
    const existing = this.doc.items[id]
    this.befores.set(id, existing === undefined ? undefined : cloneItem(existing))
  }

  get(id: ItemId): Item {
    return getItem(this.doc, id)
  }

  /** Mutate an existing record in place, journalling its prior state. */
  update(id: ItemId, mutate: (item: Item) => void): void {
    this.touch(id)
    mutate(getItem(this.doc, id))
  }

  /** Add a record that does not yet exist. */
  insert(item: Item): void {
    if (this.doc.items[item.id] !== undefined) {
      throw new Error(`Cannot insert over existing item: ${item.id}`)
    }
    this.touch(item.id)
    this.doc.items[item.id] = item
  }

  remove(id: ItemId): void {
    this.touch(id)
    delete this.doc.items[id]
  }

  /** True if nothing was touched, so the caller can skip an empty history entry. */
  get isEmpty(): boolean {
    return this.befores.size === 0
  }

  /**
   * Pair each before-image with the record's current state. Call once, at
   * commit time.
   */
  collect(): Change[] {
    const changes: Change[] = []
    for (const [id, before] of this.befores) {
      const current = this.doc.items[id]
      const after = current === undefined ? undefined : cloneItem(current)
      // A touched-but-unchanged record contributes nothing to undo.
      if (sameItem(before, after)) continue
      changes.push({ id, before, after })
    }
    return changes
  }
}

function sameItem(a: Item | undefined, b: Item | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.text === b.text &&
    a.parent === b.parent &&
    a.collapsed === b.collapsed &&
    a.children.length === b.children.length &&
    a.children.every((child, i) => child === b.children[i])
  )
}

/** Restore the `before` side of each change. Clones, so entries stay reusable. */
export function revert(doc: Doc, changes: readonly Change[]): void {
  // Reverse order so inserts are undone before the records they referenced.
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i]
    if (change === undefined) continue
    applyImage(doc, change.id, change.before)
  }
}

/** Re-apply the `after` side of each change. */
export function reapply(doc: Doc, changes: readonly Change[]): void {
  for (const change of changes) {
    applyImage(doc, change.id, change.after)
  }
}

function applyImage(doc: Doc, id: ItemId, image: Item | undefined): void {
  if (image === undefined) {
    delete doc.items[id]
  } else {
    doc.items[id] = cloneItem(image)
  }
}

/**
 * Fold `incoming` into `base`, keeping the earliest `before` and latest `after`
 * per record. Used to coalesce consecutive keystrokes into one undo step.
 */
export function mergeChanges(
  base: readonly Change[],
  incoming: readonly Change[],
): Change[] {
  const merged = base.map((change) => ({ ...change }))
  const indexById = new Map<ItemId, number>()
  merged.forEach((change, i) => indexById.set(change.id, i))

  for (const change of incoming) {
    const existing = indexById.get(change.id)
    if (existing === undefined) {
      indexById.set(change.id, merged.length)
      merged.push({ ...change })
    } else {
      const target = merged[existing]
      if (target !== undefined) target.after = change.after
    }
  }

  // A record created and then deleted within one coalesced step is a no-op.
  return merged.filter((change) => !sameItem(change.before, change.after))
}
