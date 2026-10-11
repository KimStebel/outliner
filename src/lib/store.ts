/**
 * The editing facade: owns the document, the caret, and the undo/redo stacks.
 *
 * Every mutation goes through `transact`, so no caller can change the document
 * without producing an undo entry. The ops themselves stay free of history
 * concerns.
 */

import type { Caret, Doc, ItemId, Row } from './model'
import { createDoc, findItem, visibleRows } from './model'
import { countNodes, parseMarkdown } from './markdown'
import type { Change } from './tx'
import { Tx, mergeChanges, reapply, revert } from './tx'
import * as ops from './ops'
import type { OpContext } from './ops'
import { randomId } from './id'

export interface HistoryEntry {
  label: string
  changes: Change[]
  caretBefore: Caret | null
  caretAfter: Caret | null
  /**
   * Entries with an equal, non-null key that land within the coalesce window
   * merge into one undo step. Keeps per-keystroke edits from producing
   * per-character undo.
   */
  coalesceKey: string | null
  at: number
}

export interface DocStoreOptions {
  newId?: () => ItemId
  /** Injected so coalescing is deterministic under test. */
  now?: () => number
  maxHistory?: number
  coalesceWindowMs?: number
}

const DEFAULT_MAX_HISTORY = 200
const DEFAULT_COALESCE_WINDOW_MS = 600

export class DocStore {
  doc: Doc
  /** Where the caret should be. The renderer syncs the DOM selection to this. */
  caret: Caret | null = null

  private readonly ctx: OpContext
  private readonly now: () => number
  private readonly maxHistory: number
  private readonly coalesceWindowMs: number
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []

  constructor(doc?: Doc, options: DocStoreOptions = {}) {
    const newId = options.newId ?? randomId
    this.ctx = { newId }
    this.now = options.now ?? (() => Date.now())
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
    this.doc = doc ?? createDoc(newId())
    const first = this.doc.items[this.doc.rootId]?.children[0]
    if (first !== undefined) this.caret = { id: first, offset: 0 }
  }

  // -- queries --------------------------------------------------------------

  /** The flattened visible tree. Pass a zoom root to render a subtree. */
  rows(fromId?: ItemId): Row[] {
    return visibleRows(this.doc, fromId)
  }

  textOf(id: ItemId): string {
    return findItem(this.doc, id)?.text ?? ''
  }

  /** True if `id` still exists — ids held across a delete must be rechecked. */
  exists(id: ItemId): boolean {
    return findItem(this.doc, id) !== undefined
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** Depth of the undo stack. Exposed for tests and debugging. */
  get undoDepth(): number {
    return this.past.length
  }

  // -- caret ----------------------------------------------------------------

  /**
   * Report the caret without recording history — call on focus and selection
   * change. Also breaks text coalescing, so clicking elsewhere and returning
   * starts a fresh undo step.
   */
  setCaret(caret: Caret | null): void {
    this.caret = caret
    this.breakCoalescing()
  }

  /** Force the next edit to start a new undo entry. */
  breakCoalescing(): void {
    const top = this.past[this.past.length - 1]
    if (top !== undefined) top.coalesceKey = null
  }

  // -- mutations ------------------------------------------------------------

  setText(id: ItemId, text: string, caret?: Caret): void {
    this.transact('type', (tx) => ops.setText(tx, id, text), {
      coalesceKey: `text:${id}`,
      caretAfter: caret ?? { id, offset: text.length },
    })
  }

  splitItem(id: ItemId, start: number, end: number = start): void {
    this.transact('split', (tx) => ops.splitItem(tx, this.ctx, id, start, end))
  }

  /** Replace a range with text; multi-line text becomes multiple rows. */
  replaceRange(id: ItemId, start: number, end: number, text: string): void {
    this.transact('paste', (tx) =>
      ops.replaceRange(tx, this.ctx, id, start, end, text),
    )
  }

  insertAfter(id: ItemId): void {
    this.transact('insert', (tx) => ops.insertAfter(tx, this.ctx, id))
  }

  indent(id: ItemId): void {
    this.transact('indent', (tx) => ops.indentItem(tx, id))
  }

  outdent(id: ItemId): void {
    this.transact('outdent', (tx) => ops.outdentItem(tx, id))
  }

  /** Delete an item and its descendants. Backs the swipe-right gesture. */
  remove(id: ItemId): void {
    this.transact('delete', (tx) => ops.removeSubtree(tx, this.ctx, id))
  }

  mergeWithPrevious(id: ItemId): void {
    this.transact('merge', (tx) => ops.mergeWithPrevious(tx, id))
  }

  /** Move an item under a new parent, after a given sibling. Backs drag/drop. */
  moveItem(id: ItemId, newParentId: ItemId, afterId: ItemId | null): void {
    this.transact('move', (tx) => ops.moveItem(tx, id, newParentId, afterId))
  }

  /**
   * Append a markdown document to the end of the outline, preserving its
   * heading and list nesting. Returns how many items were added.
   *
   * Appending rather than replacing: an import should never be able to
   * destroy what is already there, and one undo takes it back out.
   */
  importMarkdown(markdown: string): number {
    const nodes = parseMarkdown(markdown)
    if (nodes.length === 0) return 0

    this.transact('import', (tx) => {
      const root = tx.get(this.doc.rootId)
      const onlyChildId = root.children.length === 1 ? root.children[0] : undefined
      const onlyChild = onlyChildId === undefined ? undefined : tx.get(onlyChildId)
      // A pristine document is one empty row; importing into it should not
      // leave that row stranded above the imported content.
      const pristine =
        onlyChild !== undefined &&
        onlyChild.text === '' &&
        onlyChild.children.length === 0

      const lastChild = pristine
        ? null
        : (root.children[root.children.length - 1] ?? null)

      const caret = ops.insertTree(tx, this.ctx, this.doc.rootId, lastChild, nodes)

      if (pristine && onlyChildId !== undefined) {
        tx.update(this.doc.rootId, (target) => {
          target.children.splice(target.children.indexOf(onlyChildId), 1)
        })
        tx.remove(onlyChildId)
      }
      return caret
    })

    return countNodes(nodes)
  }

  /** Fold or unfold everything foldable, as one undo step. */
  setAllCollapsed(collapsed: boolean): void {
    this.transact(collapsed ? 'collapse all' : 'expand all', (tx) =>
      ops.setAllCollapsed(tx, collapsed),
    )
  }

  /**
   * How many items could be folded, and how many already are. Drives whether
   * a fold-everything control is useful and which direction it should go.
   */
  get foldable(): { total: number; collapsed: number } {
    let total = 0
    let collapsed = 0
    for (const [id, item] of Object.entries(this.doc.items)) {
      if (id === this.doc.rootId || item.children.length === 0) continue
      total += 1
      if (item.collapsed) collapsed += 1
    }
    return { total, collapsed }
  }

  toggleCollapsed(id: ItemId): void {
    this.transact('collapse', (tx) => ops.toggleCollapsed(tx, id))
  }

  setCollapsed(id: ItemId, collapsed: boolean): void {
    this.transact('collapse', (tx) => ops.setCollapsed(tx, id, collapsed))
  }

  // -- history --------------------------------------------------------------

  undo(): boolean {
    const entry = this.past.pop()
    if (entry === undefined) return false
    revert(this.doc, entry.changes)
    this.caret = entry.caretBefore
    // A restored entry must not re-merge with whatever comes next.
    entry.coalesceKey = null
    this.future.push(entry)
    return true
  }

  redo(): boolean {
    const entry = this.future.pop()
    if (entry === undefined) return false
    reapply(this.doc, entry.changes)
    this.caret = entry.caretAfter
    this.past.push(entry)
    return true
  }

  /**
   * Run `operation` in a transaction and record the result.
   *
   * Transactions that change nothing — a no-op outdent at the top level, say —
   * record no history and, importantly, leave the redo stack intact.
   */
  private transact(
    label: string,
    operation: (tx: Tx) => Caret | null,
    options: { coalesceKey?: string; caretAfter?: Caret } = {},
  ): void {
    const caretBefore = this.caret
    const tx = new Tx(this.doc)
    const resultCaret = operation(tx)
    const changes = tx.collect()

    if (changes.length === 0) {
      // Still honour a caret the op asked for, even with no content change.
      if (resultCaret !== null) this.caret = resultCaret
      return
    }

    const caretAfter = resultCaret ?? options.caretAfter ?? this.caret
    this.caret = caretAfter
    this.future = []

    const coalesceKey = options.coalesceKey ?? null
    const top = this.past[this.past.length - 1]
    const canCoalesce =
      top !== undefined &&
      coalesceKey !== null &&
      top.coalesceKey === coalesceKey &&
      this.now() - top.at <= this.coalesceWindowMs

    if (canCoalesce && top !== undefined) {
      top.changes = mergeChanges(top.changes, changes)
      top.caretAfter = caretAfter
      top.at = this.now()
      // Coalescing away to nothing (type then delete back) drops the entry.
      if (top.changes.length === 0) this.past.pop()
      return
    }

    this.past.push({
      label,
      changes,
      caretBefore,
      caretAfter,
      coalesceKey,
      at: this.now(),
    })
    if (this.past.length > this.maxHistory) this.past.shift()
  }
}
