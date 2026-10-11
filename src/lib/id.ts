import type { ItemId } from './model'

/**
 * Item ids. Random rather than sequential so that, when a backend arrives, two
 * offline clients creating items concurrently cannot collide.
 */
export function randomId(): ItemId {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

/** Deterministic ids, for tests and reproducible fixtures. */
export function createSequentialIds(prefix = 'i'): () => ItemId {
  let n = 0
  return () => {
    n += 1
    return `${prefix}${n}`
  }
}
