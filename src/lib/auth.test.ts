import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Auth, type Tokens } from './auth'

/**
 * The renewal rules are the part worth pinning down. The provider refuses a
 * refresh token until the access token is nearly expired, so "renew early" —
 * the instinct, and what most examples do — fails in a way that only shows up
 * a day after deploying.
 */

const ORIGIN = 'https://outliner.example'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

interface Call {
  url: string
  body: URLSearchParams
}

function harness(
  options: { responses?: Array<Response | Error>; at?: number } = {},
) {
  const responses = options.responses ?? []
  const calls: Call[] = []
  let clock = options.at ?? 1_700_000_000_000
  const storage = fakeStorage()

  const auth = new Auth({
    origin: ORIGIN,
    storage,
    now: () => clock,
    // Deterministic, so the challenge and state are reproducible.
    randomBytes: (length) => new Uint8Array(length).fill(3),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: new URLSearchParams(String(init.body)),
      })
      const next = responses.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('no response scripted')
      return next
    }) as unknown as typeof globalThis.fetch,
  })

  return {
    auth,
    calls,
    storage,
    advance: (ms: number) => (clock += ms),
    get clock() {
      return clock
    },
  }
}

function tokenResponse(
  overrides: Record<string, unknown> = {},
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 86_400,
      token_type: 'Bearer',
      ...overrides,
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function storedTokens(h: ReturnType<typeof harness>): Tokens | null {
  const raw = h.storage.getItem('outliner:auth')
  return raw === null ? null : (JSON.parse(raw) as Tokens)
}

beforeEach(() => vi.restoreAllMocks())

describe('starting a sign-in', () => {
  it('asks for a code with S256 PKCE and remembers the verifier', async () => {
    const h = harness()
    const url = new URL(await h.auth.signInUrl(), ORIGIN)

    expect(url.pathname).toBe('/auth/v1/oidc/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe('outliner')
    // Exactly as registered: the app root, with the trailing slash.
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/`)
    expect(h.storage.getItem('outliner:auth-pending')).not.toBeNull()
  })

  it('sends a challenge that is the hash of the verifier, not the verifier', async () => {
    const h = harness()
    const url = new URL(await h.auth.signInUrl(), ORIGIN)
    const pending = JSON.parse(
      h.storage.getItem('outliner:auth-pending') as string,
    ) as { verifier: string }

    const challenge = url.searchParams.get('code_challenge')
    expect(challenge).not.toBe(pending.verifier)
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(pending.verifier),
      ),
    )
    const expected = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })
})

describe('coming back from one', () => {
  it('does nothing when this is an ordinary page load', async () => {
    const h = harness()
    expect(await h.auth.completeSignIn('')).toBe(false)
    expect(h.calls).toHaveLength(0)
  })

  it('exchanges the code and keeps the tokens', async () => {
    const h = harness({ responses: [tokenResponse()] })
    const url = new URL(await h.auth.signInUrl(), ORIGIN)
    const state = url.searchParams.get('state') as string

    expect(await h.auth.completeSignIn(`?code=abc&state=${state}`)).toBe(true)
    expect(h.calls[0]?.url).toBe('/auth/v1/oidc/token')
    expect(h.calls[0]?.body.get('grant_type')).toBe('authorization_code')
    expect(h.calls[0]?.body.get('code')).toBe('abc')
    expect(h.calls[0]?.body.get('code_verifier')).toBeTruthy()

    expect(storedTokens(h)).toMatchObject({
      access: 'access-1',
      refresh: 'refresh-1',
      expiresAt: h.clock + 86_400_000,
    })
    expect(h.auth.signedIn).toBe(true)
  })

  it('refuses a code that comes back with the wrong state', async () => {
    const h = harness({ responses: [tokenResponse()] })
    await h.auth.signInUrl()

    expect(await h.auth.completeSignIn('?code=abc&state=not-the-one')).toBe(true)
    // Never exchanged, so a code planted by someone else buys nothing.
    expect(h.calls).toHaveLength(0)
    expect(h.auth.signedIn).toBe(false)
  })

  it('refuses a code when no sign-in was started here', async () => {
    const h = harness({ responses: [tokenResponse()] })
    expect(await h.auth.completeSignIn('?code=abc&state=whatever')).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  it('gives up on a sign-in that has gone stale', async () => {
    const h = harness({ responses: [tokenResponse()] })
    const url = new URL(await h.auth.signInUrl(), ORIGIN)
    const state = url.searchParams.get('state') as string
    h.advance(11 * 60 * 1000)

    expect(await h.auth.completeSignIn(`?code=abc&state=${state}`)).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  it('reports being handled when the provider sent an error', async () => {
    // So the caller still clears the query, rather than retrying forever.
    const h = harness()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.auth.completeSignIn('?error=access_denied')).toBe(true)
    expect(h.auth.signedIn).toBe(false)
  })

  it('does not store a response with no refresh token', async () => {
    // Without one there is no way back from expiry; better to have no session
    // than one that dies silently in a day.
    const h = harness({
      responses: [tokenResponse({ refresh_token: undefined })],
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const url = new URL(await h.auth.signInUrl(), ORIGIN)
    const state = url.searchParams.get('state') as string

    await h.auth.completeSignIn(`?code=abc&state=${state}`)
    expect(h.auth.signedIn).toBe(false)
  })
})

describe('handing out a token', () => {
  async function signedIn(responses: Array<Response | Error> = []) {
    const h = harness({ responses: [tokenResponse(), ...responses] })
    const url = new URL(await h.auth.signInUrl(), ORIGIN)
    const state = url.searchParams.get('state') as string
    await h.auth.completeSignIn(`?code=abc&state=${state}`)
    h.calls.length = 0
    return h
  }

  it('reports no session rather than failing, when there is none', async () => {
    // During the move from basic auth a request with no token may still be
    // accepted by the proxy, so this is not an error.
    const h = harness()
    expect(await h.auth.token()).toEqual({ kind: 'none' })
  })

  it('hands back the held token while it is comfortably valid', async () => {
    const h = await signedIn()
    expect(await h.auth.token()).toEqual({ kind: 'token', value: 'access-1' })
    expect(h.calls).toHaveLength(0)
  })

  it('does not renew at half life, which the provider would refuse', async () => {
    // The refresh token's nbf is 60s before the access token expires. A
    // renewal at twelve hours is exactly the mistake this guards.
    const h = await signedIn()
    h.advance(12 * 60 * 60 * 1000)
    expect(await h.auth.token()).toEqual({ kind: 'token', value: 'access-1' })
    expect(h.calls).toHaveLength(0)
  })

  it('renews once inside the provider’s window', async () => {
    const h = await signedIn([
      tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }),
    ])
    // 20s before expiry: past the 60s nbf, inside the renew margin.
    h.advance(86_400_000 - 20_000)

    expect(await h.auth.token()).toEqual({ kind: 'token', value: 'access-2' })
    expect(h.calls[0]?.body.get('grant_type')).toBe('refresh_token')
    expect(h.calls[0]?.body.get('refresh_token')).toBe('refresh-1')
    // The rotated one is kept, or the next renewal redeems a spent token.
    expect(storedTokens(h)).toMatchObject({
      access: 'access-2',
      refresh: 'refresh-2',
    })
  })

  it('renews after the token has expired outright', async () => {
    const h = await signedIn([tokenResponse({ access_token: 'access-2' })])
    h.advance(86_400_000 + 60_000)
    expect(await h.auth.token()).toEqual({ kind: 'token', value: 'access-2' })
  })

  it('renews once for concurrent callers, not once each', async () => {
    // The refresh token rotates on use, so a second concurrent attempt would
    // be redeeming one that is already spent.
    const h = await signedIn([tokenResponse({ access_token: 'access-2' })])
    h.advance(86_400_000)

    const results = await Promise.all([
      h.auth.token(),
      h.auth.token(),
      h.auth.token(),
    ])
    expect(results).toEqual([
      { kind: 'token', value: 'access-2' },
      { kind: 'token', value: 'access-2' },
      { kind: 'token', value: 'access-2' },
    ])
    expect(h.calls).toHaveLength(1)
  })

  it('asks for a new sign-in when the refresh token is spent', async () => {
    const h = await signedIn([tokenResponse({}, 400)])
    h.advance(86_400_000)

    expect(await h.auth.token()).toEqual({ kind: 'signInRequired' })
    // And the dead token is dropped, rather than being presented again.
    expect(h.auth.signedIn).toBe(false)
  })

  it('keeps using a still-valid token when the renewal cannot be made', async () => {
    const h = await signedIn([new TypeError('Failed to fetch')])
    h.advance(86_400_000 - 20_000)

    expect(await h.auth.token()).toEqual({ kind: 'token', value: 'access-1' })
    // Still signed in: being offline is not a reason to make the user log in.
    expect(h.auth.signedIn).toBe(true)
  })

  it('reports being unreachable when offline and the token has expired', async () => {
    const h = await signedIn([new TypeError('Failed to fetch')])
    h.advance(86_400_000 + 1000)

    expect(await h.auth.token()).toEqual({ kind: 'unreachable' })
    expect(h.auth.signedIn).toBe(true)
  })

  it('can be made to renew a token that still looks current', async () => {
    // For a 401 that arrives anyway, when the local clock says there was no
    // reason for it.
    const h = await signedIn([tokenResponse({ access_token: 'access-2' })])
    expect(await h.auth.forceRenew()).toEqual({
      kind: 'token',
      value: 'access-2',
    })
  })

  it('has nothing to force when there is no session', async () => {
    const h = harness()
    expect(await h.auth.forceRenew()).toEqual({ kind: 'none' })
  })

  it('forgets everything on sign-out', async () => {
    const h = await signedIn()
    h.auth.signOut()
    expect(h.auth.signedIn).toBe(false)
    expect(await h.auth.token()).toEqual({ kind: 'none' })
  })
})

describe('storage being unavailable', () => {
  it('does not throw', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    const auth = new Auth({ origin: ORIGIN, storage: blocked })
    expect(auth.signedIn).toBe(false)
    expect(await auth.token()).toEqual({ kind: 'none' })
    await expect(auth.signInUrl()).resolves.toContain('code_challenge')
  })
})

describe('the default fetch', () => {
  it('is called with the global as its receiver', async () => {
    // A browser's `fetch` throws "Illegal invocation" unless the receiver is
    // the window; Node does not mind, so this stands in for that rule. Without
    // it, every test here passes and the token exchange fails in the browser.
    const original = globalThis.fetch
    try {
      let receiver: unknown = 'never called'
      globalThis.fetch = function (this: unknown) {
        receiver = this
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'a',
              refresh_token: 'r',
              expires_in: 60,
            }),
          ),
        )
      } as unknown as typeof globalThis.fetch

      const storage = fakeStorage()
      const auth = new Auth({ origin: ORIGIN, storage })
      const url = new URL(await auth.signInUrl(), ORIGIN)
      await auth.completeSignIn(`?code=abc&state=${url.searchParams.get('state')}`)

      expect(receiver === globalThis || receiver === undefined).toBe(true)
      expect(auth.signedIn).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})
