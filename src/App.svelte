<script lang="ts">
  import Outline from './lib/Outline.svelte'
  import { createReactiveStore } from './lib/editor.svelte'
  import { createDocStorage, envelope } from './lib/persist'
  import { createBrowserStorage } from './lib/storage'
  import { welcomeDoc } from './lib/welcome'
  import { randomId } from './lib/id'
  import ImportDialog from './lib/ImportDialog.svelte'
  import Breadcrumb from './lib/Breadcrumb.svelte'
  import type { ItemId } from './lib/model'
  import SyncIndicator from './lib/SyncIndicator.svelte'
  import { SyncEngine, type SyncStatus } from './lib/sync'
  import { createHttpTransport } from './lib/httpSync'
  import { reviveEnvelope } from './lib/persist'

  const storage = createDocStorage({
    backend: createBrowserStorage(),
    onRecover: (error) =>
      console.warn('[outliner] ignored unusable stored document', error),
  })

  const store = createReactiveStore(
    storage.load(envelope(welcomeDoc(randomId))).doc,
  )

  /**
   * Bumped on every edit. The store's history is plain (non-reactive) state, so
   * this is what lets the undo/redo buttons reflect whether they would do
   * anything.
   */
  let revision = $state(0)

  const canUndo = $derived.by(() => {
    void revision
    return store.canUndo
  })
  const canRedo = $derived.by(() => {
    void revision
    return store.canRedo
  })

  const foldable = $derived.by(() => {
    void revision
    return store.foldable
  })
  /**
   * Once everything foldable is folded, the same control unfolds. A
   * collapse-only button would leave no way back except opening every row by
   * hand.
   */
  const allFolded = $derived(
    foldable.total > 0 && foldable.collapsed === foldable.total,
  )

  function toggleFoldAll(): void {
    store.setAllCollapsed(!allFolded)
    handleChange()
  }

  let importing = $state(false)

  /**
   * The item the outline is rooted at, or null for the whole document.
   *
   * Deliberately not persisted: a stored zoom could point at an item deleted
   * in another tab, and opening to an unexpected subtree is more disorienting
   * than always starting at the top.
   */
  let zoomId = $state<ItemId | null>(null)

  /** Drop the zoom if whatever it pointed at is gone. */
  const zoomedInto = $derived.by(() => {
    void revision
    return zoomId !== null && store.exists(zoomId) ? zoomId : null
  })

  function handleImport(markdown: string): void {
    store.importMarkdown(markdown)
    importing = false
    handleChange()
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  const ETAG_KEY = 'outliner:etag'
  /** The last local document that the server's copy replaced. */
  const REPLACED_KEY = 'outliner:replaced-backup'

  let syncStatus = $state<SyncStatus>({
    state: 'idle',
    message: null,
    replacedFromServer: false,
  })

  const sync = new SyncEngine({
    transport: createHttpTransport(),
    snapshot: () => JSON.stringify(envelope(store.doc)),
    adopt: adoptFromServer,
    initialEtag: readEtag(),
    persistEtag: writeEtag,
    onStatus: (status) => (syncStatus = status),
  })

  /**
   * Take the server's document. Validated with the same reviver the local
   * store uses, so a corrupt file on the server cannot replace a good local
   * copy — returning false leaves everything untouched.
   */
  function adoptFromServer(body: string): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(body) as unknown
    } catch {
      return false
    }
    const incoming = reviveEnvelope(parsed)
    if (incoming === null) return false

    // Server-wins means the local copy is discarded, which is the agreed
    // policy but is not reversible — undo history is cleared too. Keep the
    // displaced version aside so a surprise is recoverable by hand.
    keepDisplacedCopy()
    store.replaceAll(incoming.doc)
    // Keep the offline copy in step, so a reload without a network shows what
    // was just adopted rather than reverting.
    storage.save(incoming)
    storage.flush()
    revision += 1
    return true
  }

  /**
   * Stash whatever is about to be overwritten. Only the most recent is kept;
   * this is a safety net for the moment a device syncs for the first time
   * and finds a document it has never seen, not a version history.
   */
  function keepDisplacedCopy(): void {
    try {
      const current = JSON.stringify(envelope(store.doc))
      const empty =
        store.rows().length === 1 && store.textOf(store.rows()[0]?.id ?? '') === ''
      if (empty) return
      window.localStorage.setItem(REPLACED_KEY, current)
    } catch {
      // A full or unavailable store must not stop the sync itself.
    }
  }

  function readEtag(): string | null {
    try {
      return window.localStorage.getItem(ETAG_KEY)
    } catch {
      return null
    }
  }

  function writeEtag(etag: string | null): void {
    try {
      if (etag === null) window.localStorage.removeItem(ETAG_KEY)
      else window.localStorage.setItem(ETAG_KEY, etag)
    } catch {
      // Storage being unavailable costs an extra upload next launch, nothing
      // worse, so it is not worth surfacing.
    }
  }

  function handleChange(): void {
    revision += 1
    storage.save(envelope(store.doc))
    sync.markDirty()
  }

  // A phone can discard the tab without ever firing `unload`, so flush the
  // debounced write at the last reliable moments instead.
  //
  // The upload is a plain fetch rather than a `keepalive` one: keepalive
  // bodies are capped at 64KB, which this document can exceed, so it would
  // fail exactly when it matters. The page is normally still alive long
  // enough for an ordinary request. If it is not, nothing is lost — the edit
  // is in localStorage and uploads on next launch.
  $effect(() => {
    const flush = (): void => {
      storage.flush()
      void sync.flush()
    }
    const onVisibility = (): void => {
      const hidden = document.visibilityState === 'hidden'
      sync.setActive(!hidden)
      if (hidden) flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    void sync.start()
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      sync.stop()
      flush()
    }
  })
</script>

<header>
  <h1>Outliner</h1>
  <SyncIndicator
    status={syncStatus}
    onacknowledge={() => {
      sync.acknowledgeReplacement()
      syncStatus = sync.current
    }}
  />
  <div class="actions">
    <button
      class="icon"
      onclick={toggleFoldAll}
      disabled={foldable.total === 0}
      aria-label={allFolded ? 'Expand all' : 'Collapse all'}
      title={allFolded ? 'Expand all' : 'Collapse all'}
    >
      <!-- Shallow, well-separated chevrons: steeper ones meet in the middle
           and read as a close cross rather than fold/unfold. -->
      {#if allFolded}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 9l7-4 7 4" />
          <path d="M5 15l7 4 7-4" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 5l7 4 7-4" />
          <path d="M5 19l7-4 7 4" />
        </svg>
      {/if}
    </button>
    <button onclick={() => (importing = true)}>Import</button>
    <button onclick={() => (store.undo(), handleChange())} disabled={!canUndo}>
      Undo
    </button>
    <button onclick={() => (store.redo(), handleChange())} disabled={!canRedo}>
      Redo
    </button>
  </div>
</header>

{#if zoomedInto !== null}
  <Breadcrumb {store} zoomId={zoomedInto} onnavigate={(id) => (zoomId = id)} />
{/if}

<ImportDialog
  open={importing}
  onimport={handleImport}
  onclose={() => (importing = false)}
/>

<Outline
  {store}
  zoomId={zoomedInto}
  onzoom={(id) => (zoomId = id)}
  onchange={handleChange}
/>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    /* The sync label's width varies with what it has to say ("Saved" versus
       "Sync failed"), so rather than budget for the worst case, let the row
       wrap on a very narrow screen. Nothing gets hidden and nothing
       overflows. */
    flex-wrap: wrap;
    padding: 0.5rem 1rem calc(0.5rem + 1px);
    /* `margin-inline: auto` alone would make this flex item shrink to fit its
       content instead of stretching, so set the width explicitly. */
    width: 100%;
    max-width: 44rem;
    margin-inline: auto;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  h1 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--fg-dim);
  }

  .actions {
    display: flex;
    gap: 0.375rem;
    margin-left: auto;
  }

  /* The title is the only thing in the header that carries no function, so it
     is the first to go when space is short — now that the sync status is
     competing for the same row. */
  @media (max-width: 34rem) {
    h1 {
      display: none;
    }
  }

  button {
    font: inherit;
    font-size: 0.875rem;
    /* 36px minimum so these stay usable as touch targets. */
    min-height: 2.25rem;
    padding-inline: 0.625rem;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }

  button:disabled {
    opacity: 0.4;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    padding-inline: 0;
  }

  .icon svg {
    width: 1.125rem;
    height: 1.125rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
