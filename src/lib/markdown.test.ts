import { describe, expect, it } from 'vitest'
import { countNodes, parseMarkdown, type ParsedNode } from './markdown'
import { docFromOutline, outline, outlineOf } from './test-utils'
import { DocStore } from './store'
import { createSequentialIds } from './id'
import { validateDoc } from './ops'

/** Render a parsed forest back to indented text, for readable assertions. */
function shape(nodes: readonly ParsedNode[], depth = 0): string {
  return nodes
    .flatMap((node) => [
      `${'  '.repeat(depth)}${node.text}`,
      ...(node.children.length > 0 ? [shape(node.children, depth + 1)] : []),
    ])
    .join('\n')
}

describe('parseMarkdown', () => {
  it('nests a bullet list by indentation', () => {
    expect(
      shape(
        parseMarkdown(outline`
          - groceries
            - milk
            - bread
          - chores
        `),
      ),
    ).toBe('groceries\n  milk\n  bread\nchores')
  })

  it('accepts any bullet marker', () => {
    expect(shape(parseMarkdown('- a\n* b\n+ c'))).toBe('a\nb\nc')
  })

  it('strips ordered-list numbering', () => {
    expect(shape(parseMarkdown('1. first\n2. second\n1) third'))).toBe(
      'first\nsecond\nthird',
    )
  })

  it('nests by heading level', () => {
    expect(
      shape(
        parseMarkdown(`# Project
## Design
## Build
# Other`),
      ),
    ).toBe('Project\n  Design\n  Build\nOther')
  })

  it('puts list items under the heading that precedes them', () => {
    expect(
      shape(
        parseMarkdown(`# Trip
- passport
  - renew
# Home
- keys`),
      ),
    ).toBe('Trip\n  passport\n    renew\nHome\n  keys')
  })

  it('restarts list nesting under a new heading', () => {
    // Otherwise a deeply indented list would capture the next heading's items.
    const parsed = parseMarkdown(`# A
    - deep
# B
- shallow`)
    expect(shape(parsed)).toBe('A\n  deep\nB\n  shallow')
  })

  it('treats tabs as indentation', () => {
    expect(shape(parseMarkdown('- a\n\t- b\n\t\t- c'))).toBe('a\n  b\n    c')
  })

  it('handles an indented plain-text outline with no markers at all', () => {
    expect(shape(parseMarkdown('a\n  b\n    c\nd'))).toBe('a\n  b\n    c\nd')
  })

  it('ignores blank lines and thematic breaks', () => {
    expect(shape(parseMarkdown('- a\n\n---\n\n- b\n***\n___'))).toBe('a\nb')
  })

  it('keeps fenced code verbatim, without the fences', () => {
    const parsed = parseMarkdown(
      '- note\n```\n# not a heading\n- not a bullet\n```',
    )
    expect(shape(parsed)).toBe('note\n# not a heading\n- not a bullet')
  })

  it('leaves inline syntax exactly as written', () => {
    // Rows store what you see; nothing here renders bold or collapses a link.
    expect(shape(parseMarkdown('- **bold** and [label](https://a.test)'))).toBe(
      '**bold** and [label](https://a.test)',
    )
  })

  it('keeps task-list markers, since there is no done state to map them to', () => {
    expect(shape(parseMarkdown('- [ ] todo\n- [x] done'))).toBe(
      '[ ] todo\n[x] done',
    )
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })

  it('does not mistake a thematic break for a bullet', () => {
    expect(parseMarkdown('---')).toEqual([])
  })

  it('tolerates a list that starts already indented', () => {
    expect(shape(parseMarkdown('    - a\n      - b'))).toBe('a\n  b')
  })

  it('tolerates an over-indented child, treating it as one level deeper', () => {
    expect(shape(parseMarkdown('- a\n        - b\n- c'))).toBe('a\n  b\nc')
  })
})

describe('countNodes', () => {
  it('counts the whole forest', () => {
    expect(countNodes(parseMarkdown('- a\n  - b\n  - c\n- d'))).toBe(4)
    expect(countNodes([])).toBe(0)
  })
})

describe('importMarkdown', () => {
  it('appends the parsed tree to the document', () => {
    const store = new DocStore(docFromOutline('existing'), {
      newId: createSequentialIds('n'),
    })
    const added = store.importMarkdown('# Trip\n- passport\n  - renew')

    expect(added).toBe(3)
    expect(outlineOf(store.doc)).toBe('existing\nTrip\n  passport\n    renew')
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('is a single undo step however large the import', () => {
    const store = new DocStore(docFromOutline('existing'), {
      newId: createSequentialIds('n'),
    })
    const many = Array.from({ length: 40 }, (_, i) => `- item ${i}`).join('\n')
    store.importMarkdown(many)
    expect(store.undoDepth).toBe(1)

    store.undo()
    expect(outlineOf(store.doc)).toBe('existing')
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('replaces the lone empty row of a fresh document', () => {
    // Otherwise an import into a brand-new outline leaves a blank row on top.
    const store = new DocStore(undefined, { newId: createSequentialIds('n') })
    store.importMarkdown('- a\n- b')
    expect(outlineOf(store.doc)).toBe('a\nb')
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('keeps a non-empty document intact', () => {
    const store = new DocStore(docFromOutline('keep me'), {
      newId: createSequentialIds('n'),
    })
    store.importMarkdown('- added')
    expect(outlineOf(store.doc)).toBe('keep me\nadded')
  })

  it('does nothing for input with no content', () => {
    const store = new DocStore(docFromOutline('existing'), {
      newId: createSequentialIds('n'),
    })
    expect(store.importMarkdown('\n\n---\n')).toBe(0)
    expect(store.undoDepth).toBe(0)
    expect(outlineOf(store.doc)).toBe('existing')
  })
})
