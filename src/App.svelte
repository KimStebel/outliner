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

  function handleChange(): void {
    revision += 1
    storage.save(envelope(store.doc))
  }

  // A phone can discard the tab without ever firing `unload`, so flush the
  // debounced write at the last reliable moments instead.
  $effect(() => {
    const flush = (): void => storage.flush()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  })
</script>

<header>
  <h1>Outliner</h1>
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
    justify-content: space-between;
    gap: 1rem;
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
  }

  /* Four controls plus a title overflow a 320px-wide phone. The title is the
     one thing here that carries no function, so it is what gives way. */
  @media (max-width: 24rem) {
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
