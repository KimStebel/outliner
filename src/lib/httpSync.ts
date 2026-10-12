/**
 * The HTTP side of sync.
 *
 * Credentials are never handled here. The API sits behind HTTP basic auth, so
 * the browser attaches them itself once it has them — which is also why a
 * `401` is reported as its own result rather than a failure: the fix is for
 * the user to sign in, not for us to retry.
 */

import type { SyncTransport } from './sync'

export const DOC_URL = '/api/doc'
/**
 * Visiting this as a *navigation* makes the browser show its basic-auth
 * prompt. A `fetch` that gets a 401 does not reliably raise it, so this is
 * what the "sign in" action opens.
 */
export const SIGN_IN_URL = '/api/health'

export function createHttpTransport(url: string = DOC_URL): SyncTransport {
  return {
    async load(etag) {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          // Belt and braces with the service worker's /api bypass: the HTTP
          // cache must not answer a sync request either.
          cache: 'no-store',
          headers: etag === null ? {} : { 'If-None-Match': etag },
        })
      } catch (error) {
        return { kind: 'failed', offline: true, message: describe(error) }
      }

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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      // Omitted only for the very first write; the server accepts that just
      // once, when it holds nothing.
      if (etag !== null) headers['If-Match'] = etag

      let response: Response
      try {
        response = await fetch(url, {
          method: 'PUT',
          cache: 'no-store',
          headers,
          body,
        })
      } catch (error) {
        return { kind: 'failed', offline: true, message: describe(error) }
      }

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
