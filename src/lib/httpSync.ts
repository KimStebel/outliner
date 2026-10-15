/**
 * The HTTP side of sync.
 *
 * A bearer token is attached when there is one. When there is not, the request
 * still goes out without one rather than being refused here: the server is the
 * one that decides, and a backend running with authentication switched off —
 * which is how it runs in local development with no provider — accepts it.
 * Against the real deployment that costs one 401 before the user is asked to
 * sign in.
 *
 * `401` stays its own result rather than a failure, because the fix is for the
 * user to act, not for us to retry.
 */

import type { TokenResult } from './auth'
import type { SyncTransport } from './sync'

export const DOC_URL = '/api/doc'

/** What this needs of `Auth`, which is all a test has to stand in for. */
export interface TokenSource {
  token(): Promise<TokenResult>
  forceRenew(): Promise<TokenResult>
}

export interface TransportOptions {
  url?: string
  /** Omitted before the user has ever signed in, and in tests. */
  auth?: TokenSource
}

type Attempt =
  | { kind: 'response'; response: Response }
  | { kind: 'unauthorized' }
  | { kind: 'offline'; message: string }

/**
 * Make a request with whatever authorization is available.
 *
 * A `401` while holding a token that looked current is retried once after a
 * forced renewal: the local view of when a token expires can be wrong — a
 * clock that moved, a device resumed from sleep — and one extra round trip is
 * cheaper than sending the user to a login page needlessly.
 */
async function send(
  auth: TokenSource | undefined,
  run: (headers: Record<string, string>) => Promise<Response>,
): Promise<Attempt> {
  const held =
    auth === undefined ? ({ kind: 'none' } as TokenResult) : await auth.token()

  if (held.kind === 'signInRequired') return { kind: 'unauthorized' }
  if (held.kind === 'unreachable') {
    return { kind: 'offline', message: 'the sign-in service could not be reached' }
  }

  const bearer = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  })

  let response: Response
  try {
    response = await run(held.kind === 'token' ? bearer(held.value) : {})
  } catch (error) {
    return { kind: 'offline', message: describe(error) }
  }

  if (response.status !== 401 || held.kind !== 'token' || auth === undefined) {
    return { kind: 'response', response }
  }

  const renewed = await auth.forceRenew()
  if (renewed.kind !== 'token') return { kind: 'unauthorized' }
  try {
    return { kind: 'response', response: await run(bearer(renewed.value)) }
  } catch (error) {
    return { kind: 'offline', message: describe(error) }
  }
}

export function createHttpTransport(options: TransportOptions = {}): SyncTransport {
  const url = options.url ?? DOC_URL
  const auth = options.auth

  return {
    async load(etag) {
      const attempt = await send(auth, (extra) =>
        fetch(url, {
          method: 'GET',
          // Belt and braces with the service worker's /api bypass: the HTTP
          // cache must not answer a sync request either.
          cache: 'no-store',
          headers: etag === null ? extra : { ...extra, 'If-None-Match': etag },
        }),
      )
      if (attempt.kind === 'unauthorized') return { kind: 'unauthorized' }
      if (attempt.kind === 'offline') {
        return { kind: 'failed', offline: true, message: attempt.message }
      }
      const response = attempt.response

      if (response.status === 304) return { kind: 'unchanged' }
      if (response.status === 404) return { kind: 'absent' }
      if (response.status === 401) return { kind: 'unauthorized' }
      if (!response.ok) {
        return {
          kind: 'failed',
          offline: false,
          message: `the server answered ${response.status}`,
        }
      }

      const next = response.headers.get('ETag')
      if (next === null) {
        // Without one there is no way to make the next write conditional,
        // and an unconditional write is how a stale copy erases everything.
        return {
          kind: 'failed',
          offline: false,
          message: 'the server sent no ETag',
        }
      }

      try {
        return { kind: 'document', body: await response.text(), etag: next }
      } catch (error) {
        return { kind: 'failed', offline: true, message: describe(error) }
      }
    },

    async store(body, etag) {
      const attempt = await send(auth, (extra) => {
        const headers: Record<string, string> = {
          ...extra,
          'Content-Type': 'application/json',
        }
        // Omitted only for the very first write; the server accepts that just
        // once, when it holds nothing.
        if (etag !== null) headers['If-Match'] = etag
        return fetch(url, { method: 'PUT', cache: 'no-store', headers, body })
      })
      if (attempt.kind === 'unauthorized') return { kind: 'unauthorized' }
      if (attempt.kind === 'offline') {
        return { kind: 'failed', offline: true, message: attempt.message }
      }
      const response = attempt.response

      // Reached when there was no token to retry with, or the retry was
      // refused too.
      if (response.status === 401) return { kind: 'unauthorized' }
      // 412: the version being replaced is no longer current.
      // 428: a precondition was required and none was sent, which means the
      // server has a document this client did not know about.
      if (response.status === 412 || response.status === 428) {
        return { kind: 'stale' }
      }
      if (!response.ok) {
        return {
          kind: 'failed',
          offline: false,
          message: `the server answered ${response.status}`,
        }
      }

      const next = response.headers.get('ETag')
      if (next === null) {
        return {
          kind: 'failed',
          offline: false,
          message: 'the server sent no ETag',
        }
      }
      return { kind: 'stored', etag: next }
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
