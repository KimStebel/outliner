/**
 * Document persistence.
 *
 * The stored blob is versioned and fully revalidated on load. A document that
 * fails its structural check is rejected rather than repaired: a half-valid
 * tree would produce confusing renders and could lose items silently, so the
 * honest options are "load it" or "start fresh".
 */

import type { Doc, Item, ItemId } from './model'
import { ROOT_ID } from './model'
import { validateDoc } from './ops'
import type { PersistedStore, StorageLike } from './storage'
import { createPersistedStore } from './storage'

export const STORAGE_KEY = 'outliner:doc'
export const SCHEMA_VERSION = 1

export interface Envelope {
  version: number
  doc: Doc
}

export interface CreateDocStorageOptions {
  backend: StorageLike
  key?: string
  debounceMs?: number
  onRecover?: (error: unknown) => void
}

export function createDocStorage(
  options: CreateDocStorageOptions,
): PersistedStore<Envelope> {
  return createPersistedStore<Envelope>({
    key: options.key ?? STORAGE_KEY,
    backend: options.backend,
    debounceMs: options.debounceMs ?? 400,
    revive: reviveEnvelope,
    ...(options.onRecover ? { onRecover: options.onRecover } : {}),
  })
}

export function envelope(doc: Doc): Envelope {
  return { version: SCHEMA_VERSION, doc }
}

/**
 * Validate an untrusted parsed blob. Returns `null` for anything unusable, so
 * the caller falls back to a fresh document.
 */
export function reviveEnvelope(raw: unknown): Envelope | null {
  if (!isRecord(raw)) return null
  if (raw['version'] !== SCHEMA_VERSION) return null

  const doc = reviveDoc(raw['doc'])
  return doc === null ? null : { version: SCHEMA_VERSION, doc }
}

function reviveDoc(raw: unknown): Doc | null {
  if (!isRecord(raw)) return null

  const rootId = raw['rootId']
  if (typeof rootId !== 'string') return null

  const rawItems = raw['items']
  if (!isRecord(rawItems)) return null

  const items: Record<ItemId, Item> = {}
  for (const [key, value] of Object.entries(rawItems)) {
    const item = reviveItem(key, value)
    if (item === null) return null
    items[key] = item
  }

  const doc: Doc = { rootId, items }
  // Field-level checks cannot catch cycles, orphans, or broken parent/child
  // back-references; the structural pass can.
  return validateDoc(doc).length === 0 ? doc : null
}

function reviveItem(key: string, raw: unknown): Item | null {
  if (!isRecord(raw)) return null

  const { id, text, parent, children, collapsed } = raw
  if (id !== key) return null
  if (typeof text !== 'string') return null
  if (parent !== null && typeof parent !== 'string') return null
  if (typeof collapsed !== 'boolean') return null
  if (!Array.isArray(children)) return null
  if (!children.every((child): child is string => typeof child === 'string')) {
    return null
  }
  if (parent === null && id !== ROOT_ID) return null

  return { id, text, parent, children: [...children], collapsed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
