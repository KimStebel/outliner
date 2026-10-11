/**
 * Randomised round-trip test for the undo journal.
 *
 * The journal is the component where a bug is both most likely and least
 * visible — a dropped record only shows up as "undo lost my work" much later.
 * So rather than trust hand-written sequences, apply long random op sequences
 * and assert the two properties that must always hold:
 *
 *   1. undoing everything returns the document to its exact starting state;
 *   2. redoing everything returns it to the state it had reached.
 *
 * The document is also structurally validated after every single step, so a
 * corrupt intermediate tree fails immediately rather than surviving to the end.
 */

import { describe, expect, it } from 'vitest'
import { DocStore } from './store'
import { validateDoc } from './ops'
import { visibleRows } from './model'
import { docFromOutline, outline, outlineOf } from './test-utils'

/** mulberry32 — small seeded PRNG, so any failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const START = outline`
  alpha
    beta
      gamma
    delta
  epsilon
    zeta
  eta
`

const OP_NAMES = [
  'setText',
  'splitItem',
  'indent',
  'outdent',
  'remove',
  'mergeWithPrevious',
  'toggleCollapsed',
  'insertAfter',
] as const

function runSession(seed: number, steps: number): void {
  const random = rng(seed)
  let clock = 0
  let nextId = 0

  const store = new DocStore(docFromOutline(START), {
    newId: () => {
      nextId += 1
      return `f${nextId}`
    },
    now: () => clock,
    coalesceWindowMs: 600,
    maxHistory: 10_000,
  })

  const original = outlineOf(store.doc)
  const trace: string[] = []

  for (let step = 0; step < steps; step += 1) {
    const rows = visibleRows(store.doc)
    expect(rows.length).toBeGreaterThan(0)

    const row = rows[Math.floor(random() * rows.length)]
    if (row === undefined) continue
    const id = row.id
    const op = OP_NAMES[Math.floor(random() * OP_NAMES.length)]
    trace.push(`${op}(${id})`)

    switch (op) {
      case 'setText':
        store.setText(id, `t${step}`)
        break
      case 'splitItem':
        store.splitItem(id, Math.floor(random() * (store.textOf(id).length + 1)))
        break
      case 'indent':
        store.indent(id)
        break
      case 'outdent':
        store.outdent(id)
        break
      case 'remove':
        store.remove(id)
        break
      case 'mergeWithPrevious':
        store.mergeWithPrevious(id)
        break
      case 'toggleCollapsed':
        store.toggleCollapsed(id)
        break
      case 'insertAfter':
        store.insertAfter(id)
        break
    }

    const problems = validateDoc(store.doc)
    if (problems.length > 0) {
      throw new Error(
        `seed ${seed} corrupted the document after ${trace.join(' -> ')}\n` +
          problems.join('\n'),
      )
    }
    // Advance the clock unevenly so some keystrokes coalesce and some do not.
    clock += Math.floor(random() * 900)
  }

  const final = outlineOf(store.doc)

  while (store.canUndo) {
    store.undo()
    expect(validateDoc(store.doc)).toEqual([])
  }
  expect(outlineOf(store.doc), `seed ${seed}: ${trace.join(' -> ')}`).toBe(original)

  while (store.canRedo) {
    store.redo()
    expect(validateDoc(store.doc)).toEqual([])
  }
  expect(outlineOf(store.doc), `seed ${seed}: ${trace.join(' -> ')}`).toBe(final)
}

describe('undo journal round-trip', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1)

  it.each(seeds)('returns to the original state after undoing seed %i', (seed) => {
    runSession(seed, 60)
  })

  it('survives a long session', () => {
    runSession(9001, 600)
  })
})
