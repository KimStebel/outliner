/**
 * Signing in, and keeping a usable access token.
 *
 * The authorization code flow with PKCE, against a provider on this same
 * origin. No secret is involved: a browser cannot keep one, so the client is
 * public and proves itself with a one-time verifier instead.
 *
 * Two of the provider's rules shape everything here:
 *
 * - An access token cannot last longer than 24 hours. A month between logins
 *   comes from a 30 day refresh token, not from a long-lived access token.
 * - A refresh token is not valid when it is issued. Its `nbf` is
 *   `issued + access_token_lifetime - 60s`, so it can only be redeemed in the
 *   last minute of the access token's life or after it has expired. Renewing
 *   at half-life — the usual advice — gets a 401 every time.
 *
 * Nothing here touches the DOM, so the whole lifecycle is testable.
 */

const DEFAULT_CLIENT_ID = 'outliner'
const AUTH_BASE = '/auth/v1'

const TOKENS_KEY = 'outliner:auth'
const PENDING_KEY = 'outliner:auth-pending'

/**
 * How long before expiry to renew.
 *
 * Must be under the provider's 60 second window, or the refresh is rejected as
 * too early; far enough inside it to survive the clocks disagreeing.
 */
const RENEW_WITHIN_MS = 30_000

/** A started sign-in is abandoned after this, rather than kept forever. */
const PENDING_TTL_MS = 10 * 60 * 1000

export interface Tokens {
  access: string
  refresh: string
  /** Epoch milliseconds. */
  expiresAt: number
}

export type TokenResult =
  /** Send this as the bearer token. */
  | { kind: 'token'; value: string }
  /** No session at all. Make the request without one — during the move from
   *  basic auth the proxy may still accept it, and if it does not the 401
   *  comes back and the user is asked to sign in. */
  | { kind: 'none' }
  /** There was a session but it cannot be renewed. */
  | { kind: 'signInRequired' }
  /** The renewal could not be attempted. The existing token, if any, is kept. */
  | { kind: 'unreachable' }

export interface AuthOptions {
  clientId?: string
  /** This origin, as the provider has it registered. */
  origin?: string
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** Random bytes, injectable so a test can be deterministic. */
  randomBytes?: (length: number) => Uint8Array
}

interface Pending {
  verifier: string
  state: string
  startedAt: number
}

export class Auth {
  private readonly clientId: string
  private readonly origin: string
  private readonly storage: AuthOptions['storage']
  private readonly request: typeof globalThis.fetch
  private readonly now: () => number
  private readonly randomBytes: (length: number) => Uint8Array

  /** The one renewal in flight, so concurrent callers share it. */
  private renewing: Promise<TokenResult> | null = null

  constructor(options: AuthOptions = {}) {
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.origin =
      options.origin ?? (typeof location === 'undefined' ? '' : location.origin)
    this.storage =
      options.storage ??
      (typeof localStorage === 'undefined' ? undefined : localStorage)
    // Bound deliberately. A browser's `fetch` refuses to run with anything
    // but the window as its receiver — calling it as a method of this object
    // throws "Illegal invocation" — while Node does not care, so leaving it
    // unbound works in every test and fails only in a real browser.
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? (() => Date.now())
    this.randomBytes =
      options.randomBytes ??
      ((length) => crypto.getRandomValues(new Uint8Array(length)))
  }

  /** The registered redirect target: the app itself, with no path. */
  get redirectUri(): string {
    return `${this.origin}/`
  }

  get signedIn(): boolean {
    return this.read<Tokens>(TOKENS_KEY) !== null
  }

  /**
   * Where to send the browser to sign in.
   *
   * The verifier is written down first: it has to survive leaving the page and
   * coming back, and it is what proves the code belongs to this client.
   */
  async signInUrl(): Promise<string> {
    const verifier = base64url(this.randomBytes(32))
    const state = base64url(this.randomBytes(16))
    this.write<Pending>(PENDING_KEY, {
      verifier,
      state,
      startedAt: this.now(),
    })

    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
      ),
    )

    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    return `${AUTH_BASE}/oidc/authorize?${query}`
  }

  /**
   * Finish a sign-in, if this page load is the redirect back from one.
   *
   * Returns true when a code was present, whether or not it worked, so the
   * caller knows to tidy the address bar either way — leaving `?code=` there
   * means a reload tries to redeem a code that is already spent.
   */
  async completeSignIn(search: string): Promise<boolean> {
    const params = new URLSearchParams(search)
    const code = params.get('code')
    const error = params.get('error')
    if (code === null && error === null) return false

    const pending = this.read<Pending>(PENDING_KEY)
    this.remove(PENDING_KEY)

    if (error !== null) {
      console.warn('[outliner] sign-in was refused', error)
      return true
    }
    if (pending === null) {
      console.warn('[outliner] a sign-in came back with nothing pending')
      return true
    }
    if (this.now() - pending.startedAt > PENDING_TTL_MS) {
      console.warn('[outliner] a sign-in came back too late to be used')
      return true
    }
    // Guards against a code being planted by someone else's request.
    if (params.get('state') !== pending.state) {
      console.warn('[outliner] a sign-in came back with the wrong state')
      return true
    }

    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: pending.verifier,
    })
    if (tokens !== null) this.write(TOKENS_KEY, tokens)
    return true
  }

  /**
   * A token to send, renewing first if the one held is nearly out.
   */
  async token(): Promise<TokenResult> {
    const tokens = this.read<Tokens>(TOKENS_KEY)
    if (tokens === null) return { kind: 'none' }
    if (this.now() < tokens.expiresAt - RENEW_WITHIN_MS) {
      return { kind: 'token', value: tokens.access }
    }
    return this.renew(tokens)
  }

  /**
   * Renew even though the held token looks current.
   *
   * For a 401 that arrives anyway: the bookkeeping here can be wrong — a
   * clock that has moved, a device resumed from sleep — and one forced
   * attempt is cheaper than making the user sign in to find out.
   */
  async forceRenew(): Promise<TokenResult> {
    const tokens = this.read<Tokens>(TOKENS_KEY)
    if (tokens === null) return { kind: 'none' }
    return this.renew(tokens)
  }

  signOut(): void {
    this.remove(TOKENS_KEY)
    this.remove(PENDING_KEY)
  }

  // -- internals -------------------------------------------------------------

  private renew(tokens: Tokens): Promise<TokenResult> {
    // Several requests can notice an expiring token at once; they should cost
    // one renewal, not one each. The provider rotates the refresh token on
    // use, so a second concurrent attempt would be redeeming a spent one.
    this.renewing ??= this.renewOnce(tokens).finally(() => {
      this.renewing = null
    })
    return this.renewing
  }

  private async renewOnce(tokens: Tokens): Promise<TokenResult> {
    let response: Response
    try {
      response = await this.post({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: this.clientId,
      })
    } catch {
      // No network. The held token may still be good, and if it is not, the
      // next attempt will try again.
      return this.now() < tokens.expiresAt
        ? { kind: 'token', value: tokens.access }
        : { kind: 'unreachable' }
    }

    if (!response.ok) {
      // The refresh token is spent, revoked, or past its month. Nothing to be
      // done but sign in again, so stop presenting a token that will only be
      // refused.
      this.remove(TOKENS_KEY)
      return { kind: 'signInRequired' }
    }

    const renewed = await this.parse(response)
    if (renewed === null) return { kind: 'signInRequired' }
    this.write(TOKENS_KEY, renewed)
    return { kind: 'token', value: renewed.access }
  }

  private async exchange(body: Record<string, string>): Promise<Tokens | null> {
    try {
      const response = await this.post(body)
      if (!response.ok) {
        console.warn('[outliner] the token exchange failed', response.status)
        return null
      }
      return await this.parse(response)
    } catch (error) {
      console.warn('[outliner] the token exchange could not be made', error)
      return null
    }
  }

  private post(body: Record<string, string>): Promise<Response> {
    return this.request(`${AUTH_BASE}/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      cache: 'no-store',
      body: new URLSearchParams(body),
    })
  }

  private async parse(response: Response): Promise<Tokens | null> {
    try {
      const payload = (await response.json()) as {
        access_token?: unknown
        refresh_token?: unknown
        expires_in?: unknown
      }
      if (
        typeof payload.access_token !== 'string' ||
        typeof payload.refresh_token !== 'string' ||
        typeof payload.expires_in !== 'number'
      ) {
        // Without a refresh token there is no way back from expiry, so a
        // response missing one is not worth storing.
        console.warn('[outliner] the token response was not usable')
        return null
      }
      return {
        access: payload.access_token,
        refresh: payload.refresh_token,
        expiresAt: this.now() + payload.expires_in * 1000,
      }
    } catch {
      return null
    }
  }

  private read<T>(key: string): T | null {
    try {
      const raw = this.storage?.getItem(key) ?? null
      return raw === null ? null : (JSON.parse(raw) as T)
    } catch {
      return null
    }
  }

  private write<T>(key: string, value: T): void {
    try {
      this.storage?.setItem(key, JSON.stringify(value))
    } catch {
      // A full or blocked store means the session does not survive a reload,
      // which is worth nobody's error dialog.
    }
  }

  private remove(key: string): void {
    try {
      this.storage?.removeItem(key)
    } catch {
      // As above.
    }
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
