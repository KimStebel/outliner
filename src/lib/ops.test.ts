import { describe, expect, it } from 'vitest'
import type { Caret, Doc } from './model'
import { getItem } from './model'
import { createSequentialIds } from './id'
import type { OpContext } from './ops'
import {
  ensureNonEmpty,
  indentItem,
  mergeWithPrevious,
  outdentItem,
  removeSubtree,
  setCollapsed,
  splitItem,
  toggleCollapsed,
  validateDoc,
} from './ops'
import { Tx, revert } from './tx'
import {
  docFromOutline,
  idOf,
  outline,
  outlineOf,
  visibleOutlineOf,
} from './test-utils'

interface Applied {
  doc: Doc
  caret: Caret | null
  /** Full outline after the op. */
  after: string
  /** Outline before the op, for undo assertions. */
  before: string
  /** Reverts the op and returns the resulting outline. */
  undo: () => string
}

/**
 * Run one op against an outline. Also asserts the structural invariants hold
 * afterwards, so no test can pass while leaving a corrupt tree behind.
 */
function apply(
  source: string,
  op: (tx: Tx, ctx: OpContext, doc: Doc) => Caret | null,
): Applied {
  const doc = docFromOutline(source)
  const before = outlineOf(doc)
  const ctx: OpContext = { newId: createSequentialIds('n') }
  const tx = new Tx(doc)
  const caret = op(tx, ctx, doc)
  const changes = tx.collect()

  expect(validateDoc(doc)).toEqual([])

  return {
    doc,
    caret,
    before,
    after: outlineOf(doc),
    undo: () => {
      revert(doc, changes)
      expect(validateDoc(doc)).toEqual([])
      return outlineOf(doc)
    },
  }
}

describe('splitItem', () => {
  it('appends an empty sibling when splitting at the end of a leaf', () => {
    const r = apply('a\nb', (tx, ctx, doc) => splitItem(tx, ctx, idOf(doc, 'a'), 1))
    expect(r.after).toBe('a\n\nb')
    expect(r.caret).toEqual({ id: 'n1', offset: 0 })
    expect(r.undo()).toBe(r.before)
  })

  it('divides the text between the two items when splitting mid-word', () => {
    const r = apply('hello', (tx, ctx, doc) =>
      splitItem(tx, ctx, idOf(doc, 'hello'), 2),
    )
    expect(r.after).toBe('he\nllo')
    expect(r.caret).toEqual({ id: 'n1', offset: 0 })
    expect(r.undo()).toBe(r.before)
  })

  it('pushes the line down when splitting at offset 0, leaving the caret put', () => {
    // Moving all the text into a fresh record instead would make the caret
    // appear to jump to a different row.
    const r = apply('a', (tx, ctx, doc) => splitItem(tx, ctx, idOf(doc, 'a'), 0))
    expect(r.after).toBe('\na')
    expect(r.caret).toEqual({ id: r.doc.items['i1']?.id, offset: 0 })
    expect(getItem(r.doc, 'i1').text).toBe('a')
    expect(r.undo()).toBe(r.before)
  })

  it('makes the tail a first child when the item has visible children', () => {
    // The children belong with the head, so a sibling would detach them.
    const r = apply(
      outline`
        a
          b
      `,
      (tx, ctx, doc) => splitItem(tx, ctx, idOf(doc, 'a'), 1),
    )
    expect(r.after).toBe('a\n  \n  b')
    expect(r.undo()).toBe(r.before)
  })

  it('makes the tail a sibling when the children are collapsed out of view', () => {
    const r = apply(
      outline`
        > a
          b
      `,
      (tx, ctx, doc) => splitItem(tx, ctx, idOf(doc, 'a'), 1),
    )
    expect(visibleOutlineOf(r.doc)).toBe('a\n')
    expect(getItem(r.doc, 'n1').parent).toBe(r.doc.rootId)
    expect(r.undo()).toBe(r.before)
  })

  it('clamps an out-of-range offset', () => {
    const r = apply('ab', (tx, ctx, doc) => splitItem(tx, ctx, idOf(doc, 'ab'), 99))
    expect(r.after).toBe('ab\n')
  })
})

describe('indentItem', () => {
  it('nests an item under its previous sibling', () => {
    const r = apply('a\nb', (tx, _ctx, doc) => indentItem(tx, idOf(doc, 'b')))
    expect(r.after).toBe('a\n  b')
    expect(r.undo()).toBe(r.before)
  })

  it('is a no-op for a first child, which has nothing to nest under', () => {
    const r = apply('a\nb', (tx, _ctx, doc) => indentItem(tx, idOf(doc, 'a')))
    expect(r.after).toBe(r.before)
  })

  it('carries the item’s own children along', () => {
    const r = apply(
      outline`
        a
        b
          c
      `,
      (tx, _ctx, doc) => indentItem(tx, idOf(doc, 'b')),
    )
    expect(r.after).toBe('a\n  b\n    c')
    expect(r.undo()).toBe(r.before)
  })

  it('expands the new parent so the item does not vanish', () => {
    const r = apply(
      outline`
        > a
          b
        c
      `,
      (tx, _ctx, doc) => indentItem(tx, idOf(doc, 'c')),
    )
    expect(getItem(r.doc, idOf(r.doc, 'a')).collapsed).toBe(false)
    expect(visibleOutlineOf(r.doc)).toBe('a\n  b\n  c')
    expect(r.undo()).toBe(r.before)
  })
})

describe('outdentItem', () => {
  it('moves an item out to be its parent’s next sibling', () => {
    const r = apply(
      outline`
        a
          b
        c
      `,
      (tx, _ctx, doc) => outdentItem(tx, idOf(doc, 'b')),
    )
    expect(r.after).toBe('a\nb\nc')
    expect(r.undo()).toBe(r.before)
  })

  it('is a no-op at the top level', () => {
    const r = apply('a\nb', (tx, _ctx, doc) => outdentItem(tx, idOf(doc, 'a')))
    expect(r.after).toBe(r.before)
  })

  it('adopts the following siblings, preserving the order on screen', () => {
    // Without adoption, c and d would render above b despite following it.
    const r = apply(
      outline`
        p
          a
          b
          c
          d
      `,
      (tx, _ctx, doc) => outdentItem(tx, idOf(doc, 'b')),
    )
    expect(r.after).toBe('p\n  a\nb\n  c\n  d')
    expect(visibleOutlineOf(r.doc)).toBe('p\n  a\nb\n  c\n  d')
    expect(r.undo()).toBe(r.before)
  })

  it('expands itself when adopting, so the new children stay visible', () => {
    const r = apply(
      outline`
        p
          > a
            x
          b
      `,
      (tx, _ctx, doc) => outdentItem(tx, idOf(doc, 'a')),
    )
    expect(getItem(r.doc, idOf(r.doc, 'a')).collapsed).toBe(false)
    expect(r.after).toBe('p\na\n  x\n  b')
    expect(r.undo()).toBe(r.before)
  })

  it('keeps its own children when there is nothing to adopt', () => {
    const r = apply(
      outline`
        p
          a
            x
      `,
      (tx, _ctx, doc) => outdentItem(tx, idOf(doc, 'a')),
    )
    expect(r.after).toBe('p\na\n  x')
    expect(r.undo()).toBe(r.before)
  })
})

describe('mergeWithPrevious', () => {
  it('joins the text onto the previous visible row', () => {
    const r = apply('ab\ncd', (tx, _ctx, doc) =>
      mergeWithPrevious(tx, idOf(doc, 'cd')),
    )
    expect(r.after).toBe('abcd')
    expect(r.caret).toEqual({ id: 'i1', offset: 2 })
    expect(r.undo()).toBe(r.before)
  })

  it('joins into the deepest visible descendant, not the previous sibling', () => {
    const r = apply(
      outline`
        a
          b
        c
      `,
      (tx, _ctx, doc) => mergeWithPrevious(tx, idOf(doc, 'c')),
    )
    expect(r.after).toBe('a\n  bc')
    expect(r.undo()).toBe(r.before)
  })

  it('joins a first child into its parent', () => {
    const r = apply(
      outline`
        a
          b
      `,
      (tx, _ctx, doc) => mergeWithPrevious(tx, idOf(doc, 'b')),
    )
    expect(r.after).toBe('ab')
    expect(r.undo()).toBe(r.before)
  })

  it('refuses to merge an item that has children', () => {
    // Reparenting a subtree on a Backspace is a quiet way to lose work.
    const r = apply(
      outline`
        a
        b
          c
      `,
      (tx, _ctx, doc) => mergeWithPrevious(tx, idOf(doc, 'b')),
    )
    expect(r.after).toBe(r.before)
    expect(r.caret).toBeNull()
  })

  it('is a no-op on the very first row', () => {
    const r = apply('a\nb', (tx, _ctx, doc) =>
      mergeWithPrevious(tx, idOf(doc, 'a')),
    )
    expect(r.after).toBe(r.before)
  })

  it('deletes an empty row without changing the previous text', () => {
    const doc = docFromOutline('a')
    const tx = new Tx(doc)
    const parentId = doc.rootId
    // Append an empty sibling by hand, since the outline notation cannot express one.
    doc.items['empty'] = {
      id: 'empty',
      text: '',
      parent: parentId,
      children: [],
      collapsed: false,
    }
    getItem(doc, parentId).children.push('empty')

    const caret = mergeWithPrevious(tx, 'empty')
    expect(caret).toEqual({ id: 'i1', offset: 1 })
    expect(outlineOf(doc)).toBe('a')
  })
})

describe('removeSubtree', () => {
  it('deletes the item and every descendant', () => {
    const r = apply(
      outline`
        a
          b
            c
        d
      `,
      (tx, ctx, doc) => removeSubtree(tx, ctx, idOf(doc, 'a')),
    )
    expect(r.after).toBe('d')
    expect(Object.keys(r.doc.items).sort()).toEqual([r.doc.rootId, 'i4'].sort())
    expect(r.undo()).toBe(r.before)
  })

  it('puts the caret at the end of the preceding row', () => {
    const r = apply('ab\ncd', (tx, ctx, doc) =>
      removeSubtree(tx, ctx, idOf(doc, 'cd')),
    )
    expect(r.caret).toEqual({ id: 'i1', offset: 2 })
  })

  it('falls forward to the next row when deleting the first one', () => {
    const r = apply('ab\ncd', (tx, ctx, doc) =>
      removeSubtree(tx, ctx, idOf(doc, 'ab')),
    )
    expect(r.after).toBe('cd')
    expect(r.caret).toEqual({ id: 'i2', offset: 2 })
  })

  it('does not aim the caret at a row inside the deleted subtree', () => {
    const r = apply(
      outline`
        a
          b
      `,
      (tx, ctx, doc) => removeSubtree(tx, ctx, idOf(doc, 'a')),
    )
    // 'b' was the only other visible row and it is gone too, so a fresh
    // empty item must be created rather than pointing the caret at a corpse.
    expect(r.caret).not.toBeNull()
    expect(r.doc.items[r.caret?.id ?? '']).toBeDefined()
  })

  it('recreates an empty item rather than leaving nothing to type into', () => {
    const r = apply('only', (tx, ctx, doc) =>
      removeSubtree(tx, ctx, idOf(doc, 'only')),
    )
    expect(getItem(r.doc, r.doc.rootId).children).toHaveLength(1)
    expect(r.caret).toEqual({ id: 'n1', offset: 0 })
    expect(r.undo()).toBe(r.before)
  })
})

describe('collapse', () => {
  it('toggles an item that has children', () => {
    const r = apply(
      outline`
        a
          b
      `,
      (tx, _ctx, doc) => toggleCollapsed(tx, idOf(doc, 'a')),
    )
    expect(r.after).toBe('> a\n  b')
    expect(r.undo()).toBe(r.before)
  })

  it('ignores a leaf, which has nothing to hide', () => {
    const r = apply('a', (tx, _ctx, doc) => setCollapsed(tx, idOf(doc, 'a'), true))
    expect(getItem(r.doc, 'i1').collapsed).toBe(false)
    expect(r.after).toBe(r.before)
  })
})

describe('ensureNonEmpty', () => {
  it('adds an item to an empty document', () => {
    const doc = docFromOutline('')
    const tx = new Tx(doc)
    const caret = ensureNonEmpty(tx, { newId: createSequentialIds('n') })
    expect(caret).toEqual({ id: 'n1', offset: 0 })
    expect(getItem(doc, doc.rootId).children).toEqual(['n1'])
  })

  it('leaves a non-empty document alone', () => {
    const doc = docFromOutline('a')
    const tx = new Tx(doc)
    expect(ensureNonEmpty(tx, { newId: createSequentialIds('n') })).toBeNull()
    expect(tx.collect()).toEqual([])
  })
})

describe('validateDoc', () => {
  it('accepts a sound document', () => {
    expect(validateDoc(docFromOutline(SAMPLE_OUTLINE))).toEqual([])
  })

  it('reports a missing root', () => {
    expect(validateDoc({ rootId: 'nope', items: {} })).toEqual([
      'Missing root item: nope',
    ])
  })

  it('reports a dangling child reference', () => {
    const doc = docFromOutline('a')
    getItem(doc, 'i1').children.push('ghost')
    expect(validateDoc(doc)).toContain('Item i1 references missing child ghost')
  })

  it('reports a broken parent back-reference', () => {
    const doc = docFromOutline('a\nb')
    getItem(doc, 'i2').parent = 'i1'
    expect(validateDoc(doc)).toContain('Parent i1 does not list child i2')
  })

  it('reports an orphan unreachable from the root', () => {
    const doc = docFromOutline('a')
    doc.items['orphan'] = {
      id: 'orphan',
      text: 'x',
      parent: null,
      children: [],
      collapsed: false,
    }
    expect(validateDoc(doc)).toContain('Item orphan is unreachable from the root')
  })

  it('terminates on a cycle instead of hanging', () => {
    const doc = docFromOutline('a\nb')
    getItem(doc, 'i1').children.push('i2')
    getItem(doc, 'i2').children.push('i1')
    expect(validateDoc(doc).length).toBeGreaterThan(0)
  })
})

const SAMPLE_OUTLINE = outline`
  a
    b
  c
`
