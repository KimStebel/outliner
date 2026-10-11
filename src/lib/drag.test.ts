import { describe, expect, it } from 'vitest'
import { projectDrop } from './drag'
import { visibleRows } from './model'
import { moveItem, validateDoc } from './ops'
import { Tx, revert } from './tx'
import { docFromOutline, idOf, outline, outlineOf } from './test-utils'

const TREE = outline`
  a
    b
      c
    d
  e
`

/** Visible rows with one subtree removed, as a live drag would see them. */
function rowsExcluding(doc: ReturnType<typeof docFromOutline>, text: string) {
  const dragged = idOf(doc, text)
  const hidden = new Set(
    visibleRows(doc)
      .map((row) => row.id)
      .filter((id) => {
        let cursor: string | null = id
        while (cursor !== null) {
          if (cursor === dragged) return true
          cursor = doc.items[cursor]?.parent ?? null
        }
        return false
      }),
  )
  return visibleRows(doc).filter((row) => !hidden.has(row.id))
}

describe('projectDrop', () => {
  const doc = docFromOutline(TREE)

  it('drops at the very top as the first root child', () => {
    const rows = rowsExcluding(doc, 'e')
    expect(projectDrop(doc, rows, 0, 0)).toEqual({
      parentId: doc.rootId,
      afterId: null,
      depth: 0,
    })
  })

  it('drops at the end after the last top-level item', () => {
    const rows = rowsExcluding(doc, 'b')
    expect(projectDrop(doc, rows, rows.length, 0)).toEqual({
      parentId: doc.rootId,
      afterId: idOf(doc, 'e'),
      depth: 0,
    })
  })

  it('nests one level deeper than the row above when dragged right', () => {
    const rows = rowsExcluding(doc, 'e')
    // Gap just below 'd' (a's last child): going deeper makes it d's child.
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'd')) + 1
    expect(projectDrop(doc, rows, gap, 9)).toEqual({
      parentId: idOf(doc, 'd'),
      afterId: null,
      depth: 2,
    })
  })

  it('cannot skip a level: depth is capped just below the row above', () => {
    const rows = rowsExcluding(doc, 'e')
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'a')) + 1
    // 'a' is at depth 0, so however far right you drag, depth 1 is the most.
    expect(projectDrop(doc, rows, gap, 5).depth).toBe(1)
  })

  it('cannot be shallower than the row below', () => {
    const rows = rowsExcluding(doc, 'e')
    // Between 'a' and its child 'b': a depth-0 drop is unrepresentable, since
    // 'b' would then render under a parent it does not belong to.
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'b'))
    expect(projectDrop(doc, rows, gap, 0).depth).toBe(1)
  })

  it('walks up ancestors when dragged left', () => {
    const rows = rowsExcluding(doc, 'e')
    // Below 'd', the last of a's children. Dragging left to depth 0 should
    // land after the whole of 'a', not after 'd'.
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'd')) + 1
    expect(projectDrop(doc, rows, gap, 0)).toEqual({
      parentId: doc.rootId,
      afterId: idOf(doc, 'a'),
      depth: 0,
    })
  })

  it('lands between ancestors at an intermediate depth', () => {
    const rows = rowsExcluding(doc, 'e')
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'd')) + 1
    expect(projectDrop(doc, rows, gap, 1)).toEqual({
      parentId: idOf(doc, 'a'),
      afterId: idOf(doc, 'd'),
      depth: 1,
    })
  })

  it('stops climbing at the depth the row below allows', () => {
    const rows = rowsExcluding(doc, 'e')
    // Between 'c' (depth 2) and 'd' (depth 1). Depth 0 is unrepresentable
    // here: 'd' would then render as a child of the dropped item, which is
    // not where it belongs. Clamping leaves it a sibling of 'b'.
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'd'))
    expect(projectDrop(doc, rows, gap, 0)).toEqual({
      parentId: idOf(doc, 'a'),
      afterId: idOf(doc, 'b'),
      depth: 1,
    })
  })
})

describe('moveItem', () => {
  function move(
    source: string,
    text: string,
    apply: (doc: ReturnType<typeof docFromOutline>) => [string, string | null],
  ) {
    const doc = docFromOutline(source)
    const before = outlineOf(doc)
    const tx = new Tx(doc)
    const [parentId, afterId] = apply(doc)
    moveItem(tx, idOf(doc, text), parentId, afterId)
    const changes = tx.collect()
    expect(validateDoc(doc)).toEqual([])
    return {
      doc,
      after: outlineOf(doc),
      undo: () => {
        revert(doc, changes)
        expect(validateDoc(doc)).toEqual([])
        return outlineOf(doc)
      },
      before,
    }
  }

  it('reorders among siblings', () => {
    const r = move('a\nb\nc', 'c', (doc) => [doc.rootId, idOf(doc, 'a')])
    expect(r.after).toBe('a\nc\nb')
    expect(r.undo()).toBe(r.before)
  })

  it('moves to the start when there is no sibling to follow', () => {
    const r = move('a\nb\nc', 'c', (doc) => [doc.rootId, null])
    expect(r.after).toBe('c\na\nb')
    expect(r.undo()).toBe(r.before)
  })

  it('takes the whole subtree along', () => {
    const r = move(
      outline`
        a
        b
          x
            y
      `,
      'b',
      (doc) => [idOf(doc, 'a'), null],
    )
    expect(r.after).toBe('a\n  b\n    x\n      y')
    expect(r.undo()).toBe(r.before)
  })

  it('expands a folded destination so the item does not vanish', () => {
    const r = move(
      outline`
        > a
          x
        b
      `,
      'b',
      (doc) => [idOf(doc, 'a'), idOf(doc, 'x')],
    )
    expect(r.after).toBe('a\n  x\n  b')
    expect(r.undo()).toBe(r.before)
  })

  it('refuses to move an item into its own subtree', () => {
    // Allowing it would cut that whole branch loose from the root.
    const r = move(
      outline`
        a
          b
      `,
      'a',
      (doc) => [idOf(doc, 'b'), null],
    )
    expect(r.after).toBe(r.before)
  })

  it('refuses to move an item into itself', () => {
    const r = move('a\nb', 'a', (doc) => [idOf(doc, 'a'), null])
    expect(r.after).toBe(r.before)
  })

  it('is a no-op when dropped exactly where it already is', () => {
    const r = move('a\nb', 'b', (doc) => [doc.rootId, idOf(doc, 'a')])
    expect(r.after).toBe(r.before)
  })
})

describe('projectDrop and moveItem together', () => {
  it('produce the arrangement the indicator promised', () => {
    const doc = docFromOutline(TREE)
    const dragged = idOf(doc, 'e')
    const rows = rowsExcluding(doc, 'e')
    // Drop 'e' just under 'b', nested as its child.
    const gap = rows.findIndex((row) => row.id === idOf(doc, 'c'))
    const target = projectDrop(doc, rows, gap, 2)

    const tx = new Tx(doc)
    moveItem(tx, dragged, target.parentId, target.afterId)
    tx.collect()

    expect(validateDoc(doc)).toEqual([])
    expect(outlineOf(doc)).toBe('a\n  b\n    e\n    c\n  d')
  })

  it('round-trips an arbitrary reorder through undo', () => {
    const doc = docFromOutline(TREE)
    const before = outlineOf(doc)
    const rows = rowsExcluding(doc, 'b')
    const target = projectDrop(doc, rows, rows.length, 0)

    const tx = new Tx(doc)
    moveItem(tx, idOf(doc, 'b'), target.parentId, target.afterId)
    const changes = tx.collect()
    expect(outlineOf(doc)).toBe('a\n  d\ne\nb\n  c')

    revert(doc, changes)
    expect(outlineOf(doc)).toBe(before)
    expect(validateDoc(doc)).toEqual([])
  })
})
