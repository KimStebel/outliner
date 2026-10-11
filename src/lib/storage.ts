/**
 * Debounced, typed persistence over a Storage-like backend.
 *
 * The backend is injected rather than read off `globalThis` so this is
 * testable without a DOM, and so swapping localStorage for IndexedDB (or a
 * real backend) later touches only the call site.
 */

/** The subset of the DOM `Storage` interface we depend on. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PersistedStoreOptions<T> {
  key: string
  backend: StorageLike
  /** Milliseconds to coalesce writes over. Typing should not hit storage per keystroke. */
  debounceMs?: number
  /**
   * Validates and narrows whatever was parsed out of storage. Returning
   * `null` means "unusable", and the caller's fallback is used instead.
   *
   * Storage contents are untrusted: they may be from an older schema, a
   * different app on the same origin, or hand-edited.
   */
  revive: (raw: unknown) => T | null
  /** Called when stored data exists but is corrupt or fails `revive`. */
  onRecover?: (error: unknown) => void
}

export interface PersistedStore<T> {
  /** Reads and revives the stored value, or returns `fallback` if absent/corrupt. */
  load(fallback: T): T
  /** Queues a debounced write. */
  save(value: T): void
  /** Writes any queued value immediately. Safe to call when nothing is queued. */
  flush(): void
  /** Cancels a queued write without persisting it. */
  cancel(): void
  /** Clears the stored value and cancels any queued write. */
  clear(): void
}

export function createPersistedStore<T>(
  options: PersistedStoreOptions<T>,
): PersistedStore<T> {
  const { key, backend, revive, onRecover, debounceMs = 250 } = options

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null

  function writeNow(value: T): void {
    try {
      backend.setItem(key, JSON.stringify(value))
    } catch (error) {
      // Quota exhaustion or a disabled/partitioned storage backend. Losing a
      // write must not take the editor down with it.
      onRecover?.(error)
    }
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return {
    load(fallback: T): T {
      let raw: string | null
      try {
        raw = backend.getItem(key)
      } catch (error) {
        onRecover?.(error)
        return fallback
      }
      if (raw === null) return fallback

      try {
        const revived = revive(JSON.parse(raw) as unknown)
        if (revived === null) {
          onRecover?.(new Error(`Stored value at "${key}" failed validation`))
          return fallback
        }
        return revived
      } catch (error) {
        onRecover?.(error)
        return fallback
      }
    },

    save(value: T): void {
      pending = { value }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const queued = pending
        pending = null
        if (queued) writeNow(queued.value)
      }, debounceMs)
    },

    flush(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      const queued = pending
      pending = null
      if (queued) writeNow(queued.value)
    },

    cancel,

    clear(): void {
      cancel()
      try {
        backend.removeItem(key)
      } catch (error) {
        onRecover?.(error)
      }
    },
  }
}

/** In-memory `StorageLike`, for tests and for browsers that deny localStorage. */
export function createMemoryStorage(
  initial: Record<string, string> = {},
): StorageLike {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}
