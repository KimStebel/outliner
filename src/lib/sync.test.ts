import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SyncEngine,
  type FetchResult,
  type PutResult,
  type SyncStatus,
  type SyncTransport,
} from './sync'

/** A transport whose answers each call scripts in advance. */
class FakeTransport implements SyncTransport {
  loads: FetchResult[] = []
  puts: PutResult[] = []
  loadCalls: Array<string | null> = []
  putCalls: Array<{ body: string; etag: string | null }> = []

  async load(etag: string | null): Promise<FetchResult> {
    this.loadCalls.push(etag)
    return this.loads.shift() ?? { kind: 'unchanged' }
  }

  async store(body: string, etag: string | null): Promise<PutResult> {
    this.putCalls.push({ body, etag })
    return (
      this.puts.shift() ?? {
        kind: 'stored',
        etag: `"after-${this.putCalls.length}"`,
      }
    )
  }
}

function setup(options: { initialEtag?: string | null; adoptable?: boolean } = {}) {
  const transport = new FakeTransport()
  let document = 'local-v1'
  const statuses: SyncStatus[] = []
  const persisted: Array<string | null> = []

  const engine = new SyncEngine({
    transport,
    snapshot: () => document,
    adopt: (body) => {
      if (options.adoptable === false) return false
      document = body
      return true
    },
    initialEtag: options.initialEtag ?? null,
    persistEtag: (etag) => persisted.push(etag),
    onStatus: (status) => statuses.push(status),
    debounceMs: 5_000,
    pollMs: 10_000,
    retryMs: 2_000,
  })

  return {
    engine,
    transport,
    statuses,
    persisted,
    get document() {
      return document
    },
    set document(next: string) {
      document = next
    },
    get state() {
      return engine.current.state
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('starting up', () => {
  it('uploads the local document when the server has none', async () => {
    const h = setup()
    h.transport.loads.push({ kind: 'absent' })
    await h.engine.start()

    expect(h.transport.putCalls).toEqual([{ body: 'local-v1', etag: null }])
    expect(h.state).toBe('idle')
  })

  it('does nothing when the server agrees with what we have', async () => {
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'unchanged' })
    await h.engine.start()

    expect(h.transport.loadCalls).toEqual(['"v1"'])
    expect(h.transport.putCalls).toHaveLength(0)
    expect(h.state).toBe('idle')
  })

  it('takes the server version when it has moved on', async () => {
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'document', body: 'remote-v2', etag: '"v2"' })
    await h.engine.start()

    expect(h.document).toBe('remote-v2')
    expect(h.persisted).toContain('"v2"')
    expect(h.engine.current.replacedFromServer).toBe(true)
  })

  it('refuses to adopt a server copy it cannot read', async () => {
    // A corrupt file on the server must not be able to destroy good local work.
    const h = setup({ initialEtag: '"v1"', adoptable: false })
    h.transport.loads.push({ kind: 'document', body: 'garbage', etag: '"v2"' })
    await h.engine.start()

    expect(h.document).toBe('local-v1')
    expect(h.state).toBe('error')
    expect(h.persisted).not.toContain('"v2"')
  })
})

describe('saving edits', () => {
  it('waits out the quiet period before uploading', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.document = 'local-v2'
    h.engine.markDirty()
    expect(h.state).toBe('pending')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(h.transport.putCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.transport.putCalls).toEqual([{ body: 'local-v2', etag: '"v1"' }])
    expect(h.state).toBe('idle')
  })

  it('restarts the quiet period on every edit', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    for (let i = 0; i < 5; i += 1) {
      h.engine.markDirty()
      await vi.advanceTimersByTimeAsync(4_000)
    }
    expect(h.transport.putCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.transport.putCalls).toHaveLength(1)
  })

  it('sends the version it is replacing', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    h.engine.markDirty()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.transport.putCalls[0]?.etag).toBe('"v1"')
    // And the next upload is based on what the server just returned.
    h.engine.markDirty()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.transport.putCalls[1]?.etag).toBe('"after-1"')
  })

  it('flushes immediately when asked, for the page being hidden', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    h.engine.markDirty()

    await h.engine.flush()
    expect(h.transport.putCalls).toHaveLength(1)

    // The pending timer must not fire a second upload afterwards.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.transport.putCalls).toHaveLength(1)
  })

  it('does nothing on flush when there is nothing to save', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    await h.engine.flush()
    expect(h.transport.putCalls).toHaveLength(0)
  })

  it('catches edits made while an upload was in flight', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    let release: (value: PutResult) => void = () => {}
    const pending = new Promise<PutResult>((resolve) => (release = resolve))
    h.transport.store = async (body, etag) => {
      h.transport.putCalls.push({ body, etag })
      return pending
    }

    h.engine.markDirty()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.transport.putCalls).toHaveLength(1)

    // An edit lands while the first upload is still open.
    h.document = 'local-v3'
    h.engine.markDirty()

    h.transport.store = async (body, etag) => {
      h.transport.putCalls.push({ body, etag })
      return { kind: 'stored', etag: '"v3"' }
    }
    release({ kind: 'stored', etag: '"v2"' })
    await vi.advanceTimersByTimeAsync(0)

    // The edit is not sent instantly — it re-arms the quiet period, because
    // an edit during an upload means the user is still typing.
    expect(h.transport.putCalls).toHaveLength(1)
    expect(h.state).toBe('pending')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.transport.putCalls).toHaveLength(2)
    expect(h.transport.putCalls[1]).toEqual({ body: 'local-v3', etag: '"v2"' })
  })
})

describe('conflicts', () => {
  it('takes the server version when the upload is refused as stale', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.document = 'local-v2'
    h.engine.markDirty()
    h.transport.puts.push({ kind: 'stale' })
    h.transport.loads.push({ kind: 'document', body: 'remote-v9', etag: '"v9"' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.document).toBe('remote-v9')
    expect(h.persisted).toContain('"v9"')
    expect(h.engine.current.replacedFromServer).toBe(true)
    expect(h.state).toBe('idle')
  })

  it('does not retry the rejected upload afterwards', async () => {
    // Retrying would undo the server version we just adopted.
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({ kind: 'stale' })
    h.transport.loads.push({ kind: 'document', body: 'remote-v9', etag: '"v9"' })
    await vi.advanceTimersByTimeAsync(5_000)

    const after = h.transport.putCalls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.transport.putCalls).toHaveLength(after)
  })

  it('clears the replacement notice once acknowledged', async () => {
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'document', body: 'remote', etag: '"v2"' })
    await h.engine.start()
    expect(h.engine.current.replacedFromServer).toBe(true)

    h.engine.acknowledgeReplacement()
    expect(h.engine.current.replacedFromServer).toBe(false)
  })
})

describe('polling', () => {
  it('asks the server at the poll interval', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    expect(h.transport.loadCalls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.transport.loadCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.transport.loadCalls).toHaveLength(3)
  })

  it('picks up a change made elsewhere', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.transport.loads.push({ kind: 'document', body: 'from-laptop', etag: '"v2"' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.document).toBe('from-laptop')
  })

  it('does not poll underneath a pending upload', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    const before = h.transport.loadCalls.length

    h.engine.markDirty()
    await vi.advanceTimersByTimeAsync(4_000)
    // The poll would race the upload that is about to happen.
    expect(h.transport.loadCalls).toHaveLength(before)
  })

  it('stops polling in the background and checks again on return', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    const atStart = h.transport.loadCalls.length

    h.engine.setActive(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.transport.loadCalls).toHaveLength(atStart)

    h.engine.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.transport.loadCalls.length).toBeGreaterThan(atStart)
  })

  it('stops entirely once stopped', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()
    h.engine.stop()
    const after = h.transport.loadCalls.length

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.transport.loadCalls).toHaveLength(after)
  })
})

describe('failure', () => {
  it('reports being offline and keeps the edit pending', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({ kind: 'failed', offline: true, message: 'network' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.state).toBe('offline')
  })

  it('retries after a failure, backing off', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({ kind: 'failed', offline: true, message: 'network' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.transport.putCalls).toHaveLength(1)

    // First retry at 2s.
    h.transport.puts.push({ kind: 'failed', offline: true, message: 'network' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.transport.putCalls).toHaveLength(2)

    // Second at 4s, not 2s again.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.transport.putCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.transport.putCalls).toHaveLength(3)
  })

  it('recovers once the server answers again', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({ kind: 'failed', offline: true, message: 'network' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.state).toBe('offline')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.state).toBe('idle')
  })

  it('surfaces a server error with its message', async () => {
    const h = setup({ initialEtag: '"v1"' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({
      kind: 'failed',
      offline: false,
      message: 'server said 500',
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.state).toBe('error')
    expect(h.engine.current.message).toBe('server said 500')
  })

  it('asks for sign-in when the credentials are refused', async () => {
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'unauthorized' })
    await h.engine.start()
    expect(h.state).toBe('unauthorized')
  })

  it('does not keep retrying an unauthorized request', async () => {
    // Hammering with bad credentials achieves nothing; the user must act.
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'unauthorized' })
    await h.engine.start()

    h.engine.markDirty()
    h.transport.puts.push({ kind: 'unauthorized' })
    await vi.advanceTimersByTimeAsync(5_000)
    const after = h.transport.putCalls.length

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.transport.putCalls).toHaveLength(after)
  })
})

describe('the replacement notice', () => {
  it('clears once the user edits again', async () => {
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'document', body: 'remote', etag: '"v2"' })
    await h.engine.start()
    expect(h.engine.current.replacedFromServer).toBe(true)

    h.engine.markDirty()
    expect(h.engine.current.replacedFromServer).toBe(false)
  })

  it('does not outlive a successful save', async () => {
    // Otherwise a saved document keeps reporting "Updated", which reads as
    // though the edit went nowhere.
    const h = setup({ initialEtag: '"v1"' })
    h.transport.loads.push({ kind: 'document', body: 'remote', etag: '"v2"' })
    await h.engine.start()

    h.engine.markDirty()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.engine.current.replacedFromServer).toBe(false)
    expect(h.state).toBe('idle')
  })
})
