import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpTransport, DOC_URL, type TokenSource } from './httpSync'
import type { TokenResult } from './auth'

/**
 * This module is the seam between two halves that are each tested against a
 * mock of the other: the Rust service has its own tests, and the sync engine
 * runs against a fake transport. A mistake here — mapping 412 to "failed"
 * rather than "stale", say — would leave both suites green while sync quietly
 * did the wrong thing.
 */

interface Call {
  url: string
  init: RequestInit
}

function mockFetch(responses: Array<Response | Error>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = responses.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('no response scripted')
      return next
    }),
  )
  return calls
}

function reply(
  status: number,
  options: { etag?: string; body?: string } = {},
): Response {
  const headers = new Headers()
  if (options.etag !== undefined) headers.set('ETag', options.etag)
  return new Response(options.body ?? null, { status, headers })
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  const headers = call?.init.headers as Record<string, string> | undefined
  return headers?.[name]
}

afterEach(() => vi.unstubAllGlobals())

describe('load', () => {
  it('returns the document and its ETag', async () => {
    mockFetch([reply(200, { etag: '"v1"', body: '{"a":1}' })])
    expect(await createHttpTransport().load(null)).toEqual({
      kind: 'document',
      body: '{"a":1}',
      etag: '"v1"',
    })
  })

  it('reports 304 as unchanged', async () => {
    mockFetch([reply(304, { etag: '"v1"' })])
    expect(await createHttpTransport().load('"v1"')).toEqual({ kind: 'unchanged' })
  })

  it('reports 404 as nothing stored', async () => {
    mockFetch([reply(404)])
    expect(await createHttpTransport().load(null)).toEqual({ kind: 'absent' })
  })

  it('reports 401 as needing sign-in, not as a failure', async () => {
    // The fix is for the user to authenticate; retrying achieves nothing.
    mockFetch([reply(401)])
    expect(await createHttpTransport().load(null)).toEqual({ kind: 'unauthorized' })
  })

  it('treats a server error as a failure that is not offline', async () => {
    mockFetch([reply(500)])
    const result = await createHttpTransport().load(null)
    expect(result).toMatchObject({ kind: 'failed', offline: false })
  })

  it('treats a thrown request as being offline', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    const result = await createHttpTransport().load(null)
    expect(result).toMatchObject({ kind: 'failed', offline: true })
  })

  it('refuses a 200 that carries no ETag', async () => {
    // Without one the next write cannot be made conditional, and an
    // unconditional write is how a stale copy erases everything.
    mockFetch([reply(200, { body: '{}' })])
    const result = await createHttpTransport().load(null)
    expect(result).toMatchObject({ kind: 'failed', offline: false })
  })

  it('sends If-None-Match only when it has a tag', async () => {
    const calls = mockFetch([reply(304), reply(304)])
    await createHttpTransport().load('"v1"')
    expect(headerOf(calls[0], 'If-None-Match')).toBe('"v1"')

    await createHttpTransport().load(null)
    expect(headerOf(calls[1], 'If-None-Match')).toBeUndefined()
  })

  it('bypasses the HTTP cache', async () => {
    const calls = mockFetch([reply(304)])
    await createHttpTransport().load('"v1"')
    expect(calls[0]?.init.cache).toBe('no-store')
    expect(calls[0]?.url).toBe(DOC_URL)
  })
})

describe('store', () => {
  it('returns the new ETag on success', async () => {
    mockFetch([reply(204, { etag: '"v2"' })])
    expect(await createHttpTransport().store('{}', '"v1"')).toEqual({
      kind: 'stored',
      etag: '"v2"',
    })
  })

  it('reports 412 as stale', async () => {
    // The version being replaced is no longer current.
    mockFetch([reply(412)])
    expect(await createHttpTransport().store('{}', '"v1"')).toEqual({
      kind: 'stale',
    })
  })

  it('reports 428 as stale too', async () => {
    // The server holds a document this client did not know about, which needs
    // the same response: refetch rather than retry.
    mockFetch([reply(428)])
    expect(await createHttpTransport().store('{}', null)).toEqual({ kind: 'stale' })
  })

  it('reports 401 as needing sign-in', async () => {
    mockFetch([reply(401)])
    expect(await createHttpTransport().store('{}', '"v1"')).toEqual({
      kind: 'unauthorized',
    })
  })

  it('treats a server error as a failure that is not offline', async () => {
    mockFetch([reply(500)])
    expect(await createHttpTransport().store('{}', '"v1"')).toMatchObject({
      kind: 'failed',
      offline: false,
    })
  })

  it('treats a thrown request as being offline', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    expect(await createHttpTransport().store('{}', '"v1"')).toMatchObject({
      kind: 'failed',
      offline: true,
    })
  })

  it('refuses a success that carries no ETag', async () => {
    mockFetch([reply(204)])
    expect(await createHttpTransport().store('{}', '"v1"')).toMatchObject({
      kind: 'failed',
      offline: false,
    })
  })

  it('sends If-Match only when it has a tag', async () => {
    const calls = mockFetch([
      reply(204, { etag: '"a"' }),
      reply(204, { etag: '"b"' }),
    ])
    await createHttpTransport().store('{}', '"v1"')
    expect(headerOf(calls[0], 'If-Match')).toBe('"v1"')

    // Omitted only for a first write, which the server accepts just once.
    await createHttpTransport().store('{}', null)
    expect(headerOf(calls[1], 'If-Match')).toBeUndefined()
  })

  it('sends the body as JSON with PUT', async () => {
    const calls = mockFetch([reply(204, { etag: '"a"' })])
    await createHttpTransport().store('{"doc":1}', null)
    expect(calls[0]?.init.method).toBe('PUT')
    expect(calls[0]?.init.body).toBe('{"doc":1}')
    expect(headerOf(calls[0], 'Content-Type')).toBe('application/json')
  })
})

describe('authorization', () => {
  /** A token source scripted with what each call should return. */
  function source(
    results: TokenResult[],
    renewals: TokenResult[] = [],
  ): TokenSource {
    return {
      token: async () => results.shift() ?? { kind: 'none' },
      forceRenew: async () => renewals.shift() ?? { kind: 'signInRequired' },
    }
  }

  it('attaches the bearer token', async () => {
    const calls = mockFetch([reply(200, { etag: '"v1"', body: '{}' })])
    await createHttpTransport({
      auth: source([{ kind: 'token', value: 'abc' }]),
    }).load(null)
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer abc')
  })

  it('attaches it to a write as well, alongside the precondition', async () => {
    const calls = mockFetch([reply(204, { etag: '"v2"' })])
    await createHttpTransport({
      auth: source([{ kind: 'token', value: 'abc' }]),
    }).store('{}', '"v1"')
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer abc')
    expect(headerOf(calls[0], 'If-Match')).toBe('"v1"')
  })

  it('sends no authorization at all when there is no session', async () => {
    // Not an error while the move off basic auth is in progress: the proxy in
    // front may still accept the request, and the 401 if it does not is what
    // prompts a sign-in.
    const calls = mockFetch([reply(200, { etag: '"v1"', body: '{}' })])
    await createHttpTransport({ auth: source([{ kind: 'none' }]) }).load(null)
    expect(headerOf(calls[0], 'Authorization')).toBeUndefined()
  })

  it('needs a sign-in without even trying, once the session is unrecoverable', async () => {
    const calls = mockFetch([])
    const result = await createHttpTransport({
      auth: source([{ kind: 'signInRequired' }]),
    }).load(null)
    expect(result).toEqual({ kind: 'unauthorized' })
    // No point asking the server: there is nothing to send it.
    expect(calls).toHaveLength(0)
  })

  it('counts an unreachable sign-in service as being offline', async () => {
    // Retryable, and not something to send the user to a login page for.
    mockFetch([])
    const result = await createHttpTransport({
      auth: source([{ kind: 'unreachable' }]),
    }).load(null)
    expect(result).toMatchObject({ kind: 'failed', offline: true })
  })

  it('renews once and retries when a 401 arrives anyway', async () => {
    // The local view of expiry can be wrong — a clock that moved, a device
    // resumed from sleep — so one forced renewal beats a needless sign-in.
    const calls = mockFetch([reply(401), reply(200, { etag: '"v1"', body: '{}' })])
    const result = await createHttpTransport({
      auth: source(
        [{ kind: 'token', value: 'stale' }],
        [{ kind: 'token', value: 'fresh' }],
      ),
    }).load(null)

    expect(result).toMatchObject({ kind: 'document' })
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer stale')
    expect(headerOf(calls[1], 'Authorization')).toBe('Bearer fresh')
  })

  it('gives up after one retry rather than looping', async () => {
    const calls = mockFetch([reply(401), reply(401)])
    const result = await createHttpTransport({
      auth: source(
        [{ kind: 'token', value: 'stale' }],
        [{ kind: 'token', value: 'fresh' }],
      ),
    }).load(null)
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(calls).toHaveLength(2)
  })

  it('asks for a sign-in when the renewal itself fails', async () => {
    const calls = mockFetch([reply(401)])
    const result = await createHttpTransport({
      auth: source(
        [{ kind: 'token', value: 'stale' }],
        [{ kind: 'signInRequired' }],
      ),
    }).store('{}', '"v1"')
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(calls).toHaveLength(1)
  })

  it('does not retry a 401 when it never had a token', async () => {
    // There is nothing to renew, so the 401 is the answer.
    const calls = mockFetch([reply(401)])
    const result = await createHttpTransport({
      auth: source([{ kind: 'none' }]),
    }).load(null)
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(calls).toHaveLength(1)
  })
})
