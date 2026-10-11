import { beforeEach, describe, expect, it } from 'vitest'
import { DocStore } from './store'
import { createSequentialIds } from './id'
import { validateDoc } from './ops'
import { docFromOutline, idOf, outline, outlineOf } from './test-utils'

let clock = 0

function makeStore(source: string, options: { maxHistory?: number } = {}) {
  clock = 0
  return new DocStore(docFromOutline(source), {
    newId: createSequentialIds('n'),
    now: () => clock,
    coalesceWindowMs: 600,
    ...options,
  })
}

beforeEach(() => {
  clock = 0
})

describe('construction', () => {
  it('builds an empty document with somewhere to type', () => {
    const store = new DocStore(undefined, { newId: createSequentialIds('n') })
    expect(store.rows()).toHaveLength(1)
    expect(store.caret).toEqual({ id: 'n1', offset: 0 })
  })

  it('places the caret on the first row of a loaded document', () => {
    const store = makeStore('a\nb')
    expect(store.caret).toEqual({ id: 'i1', offset: 0 })
  })
})

describe('queries', () => {
  it('reads text and existence', () => {
    const store = makeStore('a')
    expect(store.textOf('i1')).toBe('a')
    expect(store.textOf('gone')).toBe('')
    expect(store.exists('i1')).toBe(true)
    expect(store.exists('gone')).toBe(false)
  })
})

describe('undo and redo', () => {
  it('reverses a structural edit and restores the caret', () => {
    const store = makeStore(outline`
      a
      b
    `)
    store.setCaret({ id: idOf(store.doc, 'b'), offset: 1 })
    store.indent(idOf(store.doc, 'b'))
    expect(outlineOf(store.doc)).toBe('a\n  b')

    expect(store.undo()).toBe(true)
    expect(outlineOf(store.doc)).toBe('a\nb')
    expect(store.caret).toEqual({ id: 'i2', offset: 1 })

    expect(store.redo()).toBe(true)
    expect(outlineOf(store.doc)).toBe('a\n  b')
  })

  it('restores an entire deleted subtree', () => {
    const store = makeStore(outline`
      a
        b
          c
      d
    `)
    store.remove(idOf(store.doc, 'a'))
    expect(outlineOf(store.doc)).toBe('d')

    store.undo()
    expect(outlineOf(store.doc)).toBe('a\n  b\n    c\nd')
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('reports when there is nothing to undo or redo', () => {
    const store = makeStore('a')
    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
    expect(store.canRedo).toBe(false)
    expect(store.redo()).toBe(false)
  })

  it('survives repeated undo/redo cycles without drift', () => {
    const store = makeStore(outline`
      p
        a
        b
        c
    `)
    const original = outlineOf(store.doc)
    store.outdent(idOf(store.doc, 'b'))
    const edited = outlineOf(store.doc)

    for (let i = 0; i < 5; i += 1) {
      store.undo()
      expect(outlineOf(store.doc)).toBe(original)
      store.redo()
      expect(outlineOf(store.doc)).toBe(edited)
    }
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('discards the redo stack once a new edit lands', () => {
    const store = makeStore('a\nb')
    store.indent(idOf(store.doc, 'b'))
    store.undo()
    expect(store.canRedo).toBe(true)

    clock += 1000
    store.setText('i1', 'changed')
    expect(store.canRedo).toBe(false)
  })

  it('keeps the redo stack when an operation turns out to be a no-op', () => {
    // Pressing Shift-Tab at the top level must not silently destroy redo.
    const store = makeStore('a\nb')
    store.indent(idOf(store.doc, 'b'))
    store.undo()
    expect(store.canRedo).toBe(true)

    store.outdent('i1')
    expect(store.canRedo).toBe(true)
    expect(store.undoDepth).toBe(0)
  })

  it('caps the history at maxHistory entries', () => {
    const store = makeStore('a\nb\nc\nd', { maxHistory: 2 })
    for (const text of ['w', 'x', 'y', 'z']) {
      clock += 1000
      store.setText('i1', text)
    }
    expect(store.undoDepth).toBe(2)
  })
})

describe('typing coalescence', () => {
  it('folds consecutive keystrokes into one undo step', () => {
    const store = makeStore('a')
    store.setText('i1', 'ab')
    clock += 50
    store.setText('i1', 'abc')
    clock += 50
    store.setText('i1', 'abcd')

    expect(store.undoDepth).toBe(1)
    store.undo()
    expect(store.textOf('i1')).toBe('a')
  })

  it('starts a new step once the coalesce window lapses', () => {
    const store = makeStore('a')
    store.setText('i1', 'ab')
    clock += 601
    store.setText('i1', 'abc')

    expect(store.undoDepth).toBe(2)
    store.undo()
    expect(store.textOf('i1')).toBe('ab')
  })

  it('does not merge edits to different items', () => {
    const store = makeStore('a\nb')
    store.setText('i1', 'aa')
    store.setText('i2', 'bb')
    expect(store.undoDepth).toBe(2)
  })

  it('breaks the step when a structural edit intervenes', () => {
    const store = makeStore('a\nb')
    store.setText('i2', 'bb')
    store.indent('i2')
    store.setText('i2', 'bbb')

    expect(store.undoDepth).toBe(3)
    store.undo()
    expect(store.textOf('i2')).toBe('bb')
    store.undo()
    expect(outlineOf(store.doc)).toBe('a\nbb')
  })

  it('breaks the step when the caret is reported elsewhere', () => {
    const store = makeStore('a')
    store.setText('i1', 'ab')
    store.setCaret({ id: 'i1', offset: 0 })
    store.setText('i1', 'xab')
    expect(store.undoDepth).toBe(2)
  })

  it('drops the step entirely when typing is undone by hand', () => {
    const store = makeStore('a')
    store.setText('i1', 'ab')
    store.setText('i1', 'a')
    expect(store.undoDepth).toBe(0)
    expect(store.textOf('i1')).toBe('a')
  })

  it('tracks the caret through a coalesced step', () => {
    const store = makeStore('a')
    store.setText('i1', 'ab', { id: 'i1', offset: 2 })
    store.setText('i1', 'abc', { id: 'i1', offset: 3 })
    expect(store.caret).toEqual({ id: 'i1', offset: 3 })
    store.undo()
    expect(store.caret).toEqual({ id: 'i1', offset: 0 })
  })
})

describe('editing via the store', () => {
  it('splits on Enter and moves the caret to the new row', () => {
    const store = makeStore('hello')
    store.splitItem('i1', 2)
    expect(outlineOf(store.doc)).toBe('he\nllo')
    expect(store.caret).toEqual({ id: 'n1', offset: 0 })
  })

  it('inserts an empty sibling after a parent without nesting into it', () => {
    const store = makeStore(outline`
      a
        b
    `)
    store.insertAfter(idOf(store.doc, 'a'))
    expect(store.rows()).toHaveLength(3)
    expect(store.doc.items['n1']?.parent).toBe(store.doc.rootId)
  })

  it('merges on Backspace at the start of a row', () => {
    const store = makeStore('ab\ncd')
    store.mergeWithPrevious('i2')
    expect(outlineOf(store.doc)).toBe('abcd')
    expect(store.caret).toEqual({ id: 'i1', offset: 2 })
  })

  it('toggles collapse', () => {
    const store = makeStore(outline`
      a
        b
    `)
    store.toggleCollapsed('i1')
    expect(store.rows()).toHaveLength(1)
    store.toggleCollapsed('i1')
    expect(store.rows()).toHaveLength(2)
  })

  it('keeps a typeable row after deleting the last item', () => {
    const store = makeStore('only')
    store.remove('i1')
    expect(store.rows()).toHaveLength(1)
    expect(store.caret).toEqual({ id: 'n1', offset: 0 })
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('leaves the document valid after a long mixed edit session', () => {
    const store = makeStore(outline`
      a
      b
      c
    `)
    store.indent('i2')
    store.setText('i2', 'bee')
    clock += 1000
    store.splitItem('i2', 1)
    store.indent('n1')
    store.outdent('n1')
    store.remove('i3')
    store.toggleCollapsed('i1')
    expect(validateDoc(store.doc)).toEqual([])

    while (store.canUndo) store.undo()
    expect(outlineOf(store.doc)).toBe('a\nb\nc')
    expect(validateDoc(store.doc)).toEqual([])

    while (store.canRedo) store.redo()
    expect(validateDoc(store.doc)).toEqual([])
  })
})
