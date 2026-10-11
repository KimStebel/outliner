import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryStorage,
  createPersistedStore,
  type StorageLike,
} from './storage'

interface Shape {
  n: number
}

const revive = (raw: unknown): Shape | null =>
  typeof raw === 'object' && raw !== null && typeof (raw as Shape).n === 'number'
    ? { n: (raw as Shape).n }
    : null

function setup(backend: StorageLike = createMemoryStorage()) {
  const onRecover = vi.fn()
  const store = createPersistedStore<Shape>({
    key: 'k',
    backend,
    revive,
    onRecover,
    debounceMs: 100,
  })
  return { store, backend, onRecover }
}

describe('createPersistedStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the fallback when nothing is stored', () => {
    const { store } = setup()
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
  })

  it('round-trips a saved value', () => {
    const { store } = setup()
    store.save({ n: 42 })
    store.flush()
    expect(store.load({ n: 0 })).toEqual({ n: 42 })
  })

  it('coalesces rapid saves into a single write', () => {
    const backend = createMemoryStorage()
    const setItem = vi.spyOn(backend, 'setItem')
    const { store } = setup(backend)

    store.save({ n: 1 })
    store.save({ n: 2 })
    store.save({ n: 3 })
    expect(setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(store.load({ n: 0 })).toEqual({ n: 3 })
  })

  it('does not write before the debounce window elapses', () => {
    const { store } = setup()
    store.save({ n: 7 })
    vi.advanceTimersByTime(99)
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
    vi.advanceTimersByTime(1)
    expect(store.load({ n: 0 })).toEqual({ n: 7 })
  })

  it('cancel() discards a queued write', () => {
    const { store } = setup()
    store.save({ n: 5 })
    store.cancel()
    vi.advanceTimersByTime(1000)
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
  })

  it('flush() is a no-op when nothing is queued', () => {
    const backend = createMemoryStorage()
    const setItem = vi.spyOn(backend, 'setItem')
    const { store } = setup(backend)
    store.flush()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('falls back and reports when stored JSON is malformed', () => {
    const backend = createMemoryStorage({ k: '{not json' })
    const { store, onRecover } = setup(backend)
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
    expect(onRecover).toHaveBeenCalledOnce()
  })

  it('falls back and reports when stored JSON fails validation', () => {
    const backend = createMemoryStorage({ k: '{"n":"not a number"}' })
    const { store, onRecover } = setup(backend)
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
    expect(onRecover).toHaveBeenCalledOnce()
  })

  it('survives a backend that throws on write', () => {
    const backend: StorageLike = {
      ...createMemoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const { store, onRecover } = setup(backend)
    expect(() => {
      store.save({ n: 1 })
      store.flush()
    }).not.toThrow()
    expect(onRecover).toHaveBeenCalledOnce()
  })

  it('survives a backend that throws on read', () => {
    const backend: StorageLike = {
      ...createMemoryStorage(),
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    const { store, onRecover } = setup(backend)
    expect(store.load({ n: 9 })).toEqual({ n: 9 })
    expect(onRecover).toHaveBeenCalledOnce()
  })

  it('clear() removes the stored value and cancels queued writes', () => {
    const { store } = setup()
    store.save({ n: 3 })
    store.flush()
    store.save({ n: 4 })
    store.clear()
    vi.advanceTimersByTime(1000)
    expect(store.load({ n: 0 })).toEqual({ n: 0 })
  })
})
