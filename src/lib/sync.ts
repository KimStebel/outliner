/**
 * Keeping the local document and the server's copy in step.
 *
 * The whole document is uploaded at once, which is affordable at ~100KB and
 * removes any need to describe a change. The cost is that a stale upload
 * would not merge badly — it would erase everything done elsewhere — so every
 * overwrite names the version it replaces and the server refuses it if that
 * is no longer current.
 *
 * On a refusal the server's version wins: the local copy is replaced. That is
 * a deliberate choice of predictability over preserving local work.
 *
 * Nothing here touches the DOM or Svelte, so the whole state machine is
 * testable against a fake transport.
 */

export type SyncState =
  /** Local and server agree. */
  | 'idle'
  /** Local edits are waiting for the quiet period to elapse. */
  | 'pending'
  | 'saving'
  /** The server was unreachable. Will retry. */
  | 'offline'
  /** The server refused the credentials; needs the user to sign in. */
  | 'unauthorized'
  | 'error'

export interface SyncStatus {
  state: SyncState
  /** Detail for `error`, intended to be shown. */
  message: string | null
  /** True once the server's copy has replaced the local one. */
  replacedFromServer: boolean
}

export type FetchResult =
  | { kind: 'document'; body: string; etag: string }
  /** The caller's ETag is still current. */
  | { kind: 'unchanged' }
  /** The server holds nothing yet. */
  | { kind: 'absent' }
  | { kind: 'unauthorized' }
  | { kind: 'failed'; offline: boolean; message: string }

export type PutResult =
  | { kind: 'stored'; etag: string }
  /** The version being replaced is no longer current. */
  | { kind: 'stale' }
  | { kind: 'unauthorized' }
  | { kind: 'failed'; offline: boolean; message: string }

export interface SyncTransport {
  load(etag: string | null): Promise<FetchResult>
  store(body: string, etag: string | null): Promise<PutResult>
}

export interface SyncOptions {
  transport: SyncTransport
  /** The document as it stands locally, serialised. */
  snapshot: () => string
  /**
   * Replace the local document with the server's. Returns false if the body
   * could not be understood, in which case nothing is changed — a corrupt
   * server file must not be able to destroy a good local copy.
   */
  adopt: (body: string) => boolean
  /** ETag the local document is based on, from the last run. */
  initialEtag: string | null
  persistEtag: (etag: string | null) => void
  onStatus: (status: SyncStatus) => void
  /** Quiet period after the last edit before uploading. */
  debounceMs?: number
  /** How often to ask the server whether anything changed. */
  pollMs?: number
  /** First retry delay after a failure; doubles up to a cap. */
  retryMs?: number
  maxRetryMs?: number
}

const DEFAULT_DEBOUNCE_MS = 5_000
const DEFAULT_POLL_MS = 10_000
const DEFAULT_RETRY_MS = 2_000
const DEFAULT_MAX_RETRY_MS = 60_000

export class SyncEngine {
  private readonly options: Required<SyncOptions>

  private baseEtag: string | null
  /** Local edits exist that the server has not accepted. */
  private dirty = false
  private inFlight = false
  /** The document changed while an upload was in flight. */
  private resaveQueued = false
  private started = false
  /** Polling runs only while the app is in the foreground. */
  private active = true
  private failures = 0
  private replaced = false
  /**
   * The exact bytes the server is known to hold. Used to skip uploads that
   * would change nothing — typing a character and deleting it again, or an
   * operation that turned out to be a no-op, both mark the document dirty
   * while leaving it identical.
   */
  private storedBody: string | null = null

  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private status: SyncStatus = {
    state: 'idle',
    message: null,
    replacedFromServer: false,
  }

  constructor(options: SyncOptions) {
    this.options = {
      debounceMs: DEFAULT_DEBOUNCE_MS,
      pollMs: DEFAULT_POLL_MS,
      retryMs: DEFAULT_RETRY_MS,
      maxRetryMs: DEFAULT_MAX_RETRY_MS,
      ...options,
    }
    this.baseEtag = options.initialEtag
  }

  /** Reconcile with the server, then begin polling. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.reconcile()
    this.schedulePoll()
  }

  stop(): void {
    this.started = false
    this.clearTimer('save')
    this.clearTimer('poll')
  }

  /** Call on every local edit. */
  markDirty(): void {
    this.dirty = true
    // "Your document was replaced" stops being the salient fact the moment
    // the user edits again; leaving it up would then contradict the save
    // that follows.
    this.replaced = false
    if (!this.inFlight) this.emit({ state: 'pending' })
    this.clearTimer('save')
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, this.options.debounceMs)
  }

  /**
   * Upload immediately rather than waiting out the quiet period — for the
   * moment the page is being hidden, when the timer may never fire.
   */
  async flush(): Promise<void> {
    this.clearTimer('save')
    if (!this.dirty) return
    await this.save()
  }

  /** Foreground state. Polling while hidden only drains the battery. */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (!active) {
      this.clearTimer('poll')
      return
    }
    // Returning to the app is the moment the user most wants to be current.
    void this.poll()
    this.schedulePoll()
  }

  /** Acknowledge the "replaced by the server" notice. */
  acknowledgeReplacement(): void {
    if (!this.replaced) return
    this.replaced = false
    this.emit({})
  }

  get current(): SyncStatus {
    return this.status
  }

  // -- internals ------------------------------------------------------------

  private async poll(): Promise<void> {
    // A pending upload will discover any remote change itself, by being
    // refused. Polling underneath it would only race.
    if (this.dirty || this.inFlight) return
    await this.reconcile()
  }

  private async reconcile(): Promise<void> {
    const result = await this.options.transport.load(this.baseEtag)

    switch (result.kind) {
      case 'unchanged': {
        this.failures = 0
        if (this.dirty) await this.save()
        else this.emit({ state: 'idle', message: null })
        return
      }

      case 'document': {
        this.failures = 0
        if (!this.options.adopt(result.body)) {
          this.emit({
            state: 'error',
            message: 'The server copy could not be read, so it was ignored.',
          })
          return
        }
        // The server's bytes, not a re-serialisation of them: this records
        // what the server holds, which is what a later upload is compared
        // against.
        this.storedBody = result.body
        // The local copy is gone, including anything unsaved: the server wins.
        this.replaced = true
        this.dirty = false
        this.clearTimer('save')
        this.setEtag(result.etag)
        this.emit({ state: 'idle', message: null })
        return
      }

      case 'absent': {
        this.failures = 0
        // Nothing stored yet, so whatever is here is the starting point.
        this.storedBody = null
        this.setEtag(null)
        this.dirty = true
        await this.save()
        return
      }

      case 'unauthorized': {
        this.emit({ state: 'unauthorized', message: null })
        return
      }

      case 'failed': {
        this.fail(result.offline, result.message)
        return
      }
    }
  }

  private async save(): Promise<void> {
    if (this.inFlight) {
      // Whatever changed during this upload still needs sending.
      this.resaveQueued = true
      return
    }

    const body = this.options.snapshot()
    if (body === this.storedBody) {
      // The server already holds exactly this. Sending it again would cost a
      // whole upload — the document goes up in full every time — to no end.
      this.dirty = false
      this.resaveQueued = false
      this.clearTimer('save')
      this.emit({ state: 'idle', message: null })
      return
    }

    this.inFlight = true
    this.clearTimer('save')
    // This upload covers every edit made up to now. Anything that arrives
    // while it is open sets the flag again, and is caught on completion.
    this.dirty = false
    this.emit({ state: 'saving', message: null })

    const result = await this.options.transport.store(body, this.baseEtag)
    this.inFlight = false

    switch (result.kind) {
      case 'stored': {
        this.failures = 0
        this.setEtag(result.etag)
        this.storedBody = body
        // What is on the server is now this device's own document, so any
        // earlier replacement notice no longer describes anything.
        this.replaced = false
        if (this.dirty || this.resaveQueued) {
          this.resaveQueued = false
          // Re-arm the quiet period rather than uploading at once: edits
          // during an upload mean the user is still typing.
          this.markDirty()
        } else {
          this.emit({ state: 'idle', message: null })
        }
        return
      }

      case 'stale': {
        // Someone else wrote in the meantime. Take their version, and do not
        // resend — that would undo what we are about to adopt.
        this.resaveQueued = false
        this.dirty = false
        await this.reconcile()
        return
      }

      case 'unauthorized': {
        // Still unsaved; the user has to act before this can go anywhere.
        this.dirty = true
        this.emit({ state: 'unauthorized', message: null })
        return
      }

      case 'failed': {
        // Still unsaved, so the retry resends rather than reporting success.
        this.dirty = true
        this.fail(result.offline, result.message)
        return
      }
    }
  }

  private fail(offline: boolean, message: string): void {
    this.failures += 1
    this.emit({
      state: offline ? 'offline' : 'error',
      message: offline ? null : message,
    })
    // Back off, so a server that is down is not hammered.
    const delay = Math.min(
      this.options.maxRetryMs,
      this.options.retryMs * 2 ** (this.failures - 1),
    )
    this.clearTimer('save')
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void (this.dirty ? this.save() : this.reconcile())
    }, delay)
  }

  private schedulePoll(): void {
    this.clearTimer('poll')
    if (!this.started || !this.active) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll().finally(() => this.schedulePoll())
    }, this.options.pollMs)
  }

  private setEtag(etag: string | null): void {
    this.baseEtag = etag
    this.options.persistEtag(etag)
  }

  private clearTimer(which: 'save' | 'poll'): void {
    const timer = which === 'save' ? this.saveTimer : this.pollTimer
    if (timer !== null) clearTimeout(timer)
    if (which === 'save') this.saveTimer = null
    else this.pollTimer = null
  }

  private emit(change: Partial<Omit<SyncStatus, 'replacedFromServer'>>): void {
    this.status = {
      state: change.state ?? this.status.state,
      message: change.message === undefined ? this.status.message : change.message,
      replacedFromServer: this.replaced,
    }
    this.options.onStatus(this.status)
  }
}
