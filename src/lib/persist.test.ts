import { describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  createDocStorage,
  envelope,
  reviveEnvelope,
} from './persist'
import { createMemoryStorage } from './storage'
import { DocStore } from './store'
import { createSequentialIds } from './id'
import { docFromOutline, outline, outlineOf } from './test-utils'
import type { Doc } from './model'

const SAMPLE = outline`
  a
    b
  > c
    d
`

function wire(doc: Doc): unknown {
  return JSON.parse(JSON.stringify(envelope(doc))) as unknown
}

describe('reviveEnvelope', () => {
  it('round-trips a document through JSON', () => {
    const doc = docFromOutline(SAMPLE)
    const revived = reviveEnvelope(wire(doc))
    expect(revived).not.toBeNull()
    expect(outlineOf(revived!.doc)).toBe(outlineOf(doc))
  })

  it('rejects a payload from a different schema version', () => {
    const doc = docFromOutline('a')
    expect(reviveEnvelope({ version: SCHEMA_VERSION + 1, doc })).toBeNull()
    expect(reviveEnvelope({ doc })).toBeNull()
  })

  it('rejects values that are not envelopes', () => {
    for (const bad of [null, 42, 'x', [], {}]) {
      expect(reviveEnvelope(bad)).toBeNull()
    }
  })

  it('rejects a document with a dangling child reference', () => {
    const doc = docFromOutline('a')
    const raw = wire(doc) as {
      doc: { items: Record<string, { children: string[] }> }
    }
    raw.doc.items['i1']?.children.push('ghost')
    expect(reviveEnvelope(raw)).toBeNull()
  })

  it('rejects a document whose parent link is one-way', () => {
    const doc = docFromOutline('a\nb')
    const raw = wire(doc) as { doc: { items: Record<string, { parent: string }> } }
    const item = raw.doc.items['i2']
    if (item) item.parent = 'i1'
    expect(reviveEnvelope(raw)).toBeNull()
  })

  it('rejects an item whose key disagrees with its id', () => {
    const doc = docFromOutline('a')
    const raw = wire(doc) as { doc: { items: Record<string, unknown> } }
    raw.doc.items['mismatch'] = raw.doc.items['i1']
    delete raw.doc.items['i1']
    expect(reviveEnvelope(raw)).toBeNull()
  })

  it('rejects malformed item fields', () => {
    const base = docFromOutline('a')
    const mutate = (change: (item: Record<string, unknown>) => void) => {
      const raw = wire(base) as { doc: { items: Record<string, unknown> } }
      const item = raw.doc.items['i1'] as Record<string, unknown>
      change(item)
      return reviveEnvelope(raw)
    }

    expect(mutate((i) => (i['text'] = 7))).toBeNull()
    expect(mutate((i) => (i['collapsed'] = 'yes'))).toBeNull()
    expect(mutate((i) => (i['children'] = 'nope'))).toBeNull()
    expect(mutate((i) => (i['children'] = [1, 2]))).toBeNull()
    expect(mutate((i) => (i['parent'] = 5))).toBeNull()
  })

  it('rejects a non-root item claiming a null parent', () => {
    // Otherwise it would be an orphan that renders nowhere.
    const doc = docFromOutline('a')
    const raw = wire(doc) as { doc: { items: Record<string, { parent: null }> } }
    const item = raw.doc.items['i1']
    if (item) item.parent = null
    expect(reviveEnvelope(raw)).toBeNull()
  })
})

describe('createDocStorage', () => {
  it('persists and reloads an edited document', () => {
    const backend = createMemoryStorage()
    const storage = createDocStorage({ backend })

    const store = new DocStore(docFromOutline('a\nb'), {
      newId: createSequentialIds('n'),
    })
    store.indent('i2')
    store.setText('i2', 'bee')
    storage.save(envelope(store.doc))
    storage.flush()

    const fallback = envelope(docFromOutline('fallback'))
    const loaded = storage.load(fallback)
    expect(outlineOf(loaded.doc)).toBe('a\n  bee')
  })

  it('falls back to a fresh document when storage holds junk', () => {
    const backend = createMemoryStorage({
      'outliner:doc': '{"version":1,"doc":{}}',
    })
    const onRecover = vi.fn()
    const storage = createDocStorage({ backend, onRecover })

    const fallback = envelope(docFromOutline('fresh'))
    expect(outlineOf(storage.load(fallback).doc)).toBe('fresh')
    expect(onRecover).toHaveBeenCalledOnce()
  })
})
