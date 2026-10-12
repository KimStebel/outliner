import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpTransport, DOC_URL } from './httpSync'

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
