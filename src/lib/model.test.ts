import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  createDoc,
  depthOf,
  getItem,
  indexInParent,
  isDescendantOf,
  lastVisibleInSubtree,
  nextSibling,
  nextVisible,
  previousSibling,
  previousVisible,
  subtreeIds,
  visibleRows,
} from './model'
import { docFromOutline, idOf, outline, visibleOutlineOf } from './test-utils'

const SAMPLE = outline`
  a
    b
      c
    d
  e
`

describe('createDoc', () => {
  it('starts with one empty item so there is somewhere to type', () => {
    const doc = createDoc('first')
    expect(getItem(doc, doc.rootId).children).toEqual(['first'])
    expect(getItem(doc, 'first').text).toBe('')
    expect(getItem(doc, 'first').parent).toBe(doc.rootId)
  })
})

describe('docFromOutline', () => {
  it('round-trips through the visible outline', () => {
    expect(visibleOutlineOf(docFromOutline(SAMPLE))).toBe(SAMPLE)
  })

  it('marks collapsed items with a leading angle bracket', () => {
    const doc = docFromOutline(outline`
      > a
        b
    `)
    expect(getItem(doc, idOf(doc, 'a')).collapsed).toBe(true)
    expect(getItem(doc, idOf(doc, 'b')).collapsed).toBe(false)
  })

  it('rejects a misaligned indent rather than guessing', () => {
    expect(() => docFromOutline('a\n   b')).toThrow(/multiple of 2/)
  })
})

describe('sibling and depth queries', () => {
  const doc = docFromOutline(SAMPLE)

  it('reports depth relative to the root', () => {
    expect(depthOf(doc, idOf(doc, 'a'))).toBe(0)
    expect(depthOf(doc, idOf(doc, 'b'))).toBe(1)
    expect(depthOf(doc, idOf(doc, 'c'))).toBe(2)
  })

  it('reports depth relative to a zoom root', () => {
    expect(depthOf(doc, idOf(doc, 'c'), idOf(doc, 'a'))).toBe(1)
    expect(depthOf(doc, idOf(doc, 'a'), idOf(doc, 'a'))).toBe(-1)
  })

  it('finds siblings and positions', () => {
    expect(indexInParent(doc, idOf(doc, 'd'))).toBe(1)
    expect(previousSibling(doc, idOf(doc, 'd'))).toBe(idOf(doc, 'b'))
    expect(nextSibling(doc, idOf(doc, 'b'))).toBe(idOf(doc, 'd'))
    expect(previousSibling(doc, idOf(doc, 'b'))).toBeUndefined()
    expect(nextSibling(doc, idOf(doc, 'd'))).toBeUndefined()
  })

  it('identifies descendants', () => {
    expect(isDescendantOf(doc, idOf(doc, 'c'), idOf(doc, 'a'))).toBe(true)
    expect(isDescendantOf(doc, idOf(doc, 'e'), idOf(doc, 'a'))).toBe(false)
    expect(isDescendantOf(doc, idOf(doc, 'a'), idOf(doc, 'a'))).toBe(false)
  })

  it('collects a subtree in pre-order, including the root of it', () => {
    expect(subtreeIds(doc, idOf(doc, 'a'))).toEqual([
      idOf(doc, 'a'),
      idOf(doc, 'b'),
      idOf(doc, 'c'),
      idOf(doc, 'd'),
    ])
  })
})

describe('visibleRows', () => {
  it('flattens the tree with depths', () => {
    const doc = docFromOutline(SAMPLE)
    expect(
      visibleRows(doc).map((row) => [getItem(doc, row.id).text, row.depth]),
    ).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 1],
      ['e', 0],
    ])
  })

  it('omits children of a collapsed item', () => {
    const doc = docFromOutline(outline`
      > a
        b
      c
    `)
    expect(visibleOutlineOf(doc)).toBe('a\nc')
  })

  it('reports child presence and collapse state per row', () => {
    const doc = docFromOutline(outline`
      > a
        b
      c
    `)
    expect(visibleRows(doc)).toEqual([
      { id: idOf(doc, 'a'), depth: 0, hasChildren: true, collapsed: true },
      { id: idOf(doc, 'c'), depth: 0, hasChildren: false, collapsed: false },
    ])
  })

  it('renders a subtree when given a zoom root', () => {
    const doc = docFromOutline(SAMPLE)
    expect(visibleOutlineOf(doc, idOf(doc, 'a'))).toBe('b\n  c\nd')
  })
})

describe('visible-order navigation', () => {
  const doc = docFromOutline(SAMPLE)
  const at = (text: string) => idOf(doc, text)

  it('walks forward in the order shown on screen', () => {
    expect(nextVisible(doc, at('a'))).toBe(at('b'))
    expect(nextVisible(doc, at('b'))).toBe(at('c'))
    // Past the end of a subtree, continue at the parent's next sibling.
    expect(nextVisible(doc, at('c'))).toBe(at('d'))
    expect(nextVisible(doc, at('d'))).toBe(at('e'))
    expect(nextVisible(doc, at('e'))).toBeUndefined()
  })

  it('walks backward in the order shown on screen', () => {
    expect(previousVisible(doc, at('e'))).toBe(at('d'))
    expect(previousVisible(doc, at('d'))).toBe(at('c'))
    // A first child is preceded by its parent.
    expect(previousVisible(doc, at('b'))).toBe(at('a'))
    // The root sentinel is not a row, so the first item has nothing before it.
    expect(previousVisible(doc, at('a'))).toBeUndefined()
  })

  it('steps over a collapsed subtree instead of into it', () => {
    const collapsed = docFromOutline(outline`
      > a
        b
      c
    `)
    expect(nextVisible(collapsed, idOf(collapsed, 'a'))).toBe(idOf(collapsed, 'c'))
    expect(previousVisible(collapsed, idOf(collapsed, 'c'))).toBe(
      idOf(collapsed, 'a'),
    )
  })

  it('finds the deepest visible descendant', () => {
    expect(lastVisibleInSubtree(doc, at('a'))).toBe(at('d'))
    expect(lastVisibleInSubtree(doc, at('b'))).toBe(at('c'))
    const collapsed = docFromOutline(outline`
      > a
        b
    `)
    expect(lastVisibleInSubtree(collapsed, idOf(collapsed, 'a'))).toBe(
      idOf(collapsed, 'a'),
    )
  })
})

describe('ancestorsOf', () => {
  const doc = docFromOutline(SAMPLE)

  it('lists the path from the root down to the parent', () => {
    expect(ancestorsOf(doc, idOf(doc, 'c'))).toEqual([
      doc.rootId,
      idOf(doc, 'a'),
      idOf(doc, 'b'),
    ])
  })

  it('is just the root for a top-level item', () => {
    expect(ancestorsOf(doc, idOf(doc, 'a'))).toEqual([doc.rootId])
  })

  it('is empty for the root itself', () => {
    expect(ancestorsOf(doc, doc.rootId)).toEqual([])
  })
})
