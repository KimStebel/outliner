<script lang="ts">
  /**
   * Trail back out of a zoomed item, with the item's own text as the title.
   *
   * The title is read-only. Editing it would mean a second editable living
   * outside the row list, with its own caret and key handling; zooming out one
   * level and editing it as a row is the way to change it for now.
   */
  import type { DocStore } from './store'
  import type { ItemId } from './model'
  import { ancestorsOf } from './model'

  interface Props {
    store: DocStore
    /** The item being zoomed into. */
    zoomId: ItemId
    onnavigate: (id: ItemId | null) => void
  }

  let { store, zoomId, onnavigate }: Props = $props()

  const crumbs = $derived(
    ancestorsOf(store.doc, zoomId)
      // The root sentinel is never a row; it is offered as "All items".
      .filter((id) => id !== store.doc.rootId)
      .map((id) => ({ id, text: store.textOf(id) || 'Untitled' })),
  )

  const title = $derived(store.textOf(zoomId) || 'Untitled')
</script>

<nav aria-label="Breadcrumb">
  <ol>
    <li>
      <button type="button" onclick={() => onnavigate(null)}>All items</button>
    </li>
    {#each crumbs as crumb (crumb.id)}
      <li>
        <span class="sep" aria-hidden="true">›</span>
        <button type="button" onclick={() => onnavigate(crumb.id)}
          >{crumb.text}</button
        >
      </li>
    {/each}
  </ol>
  <h2>{title}</h2>
</nav>

<style>
  nav {
    width: 100%;
    max-width: 44rem;
    margin-inline: auto;
    padding: 0.625rem 1rem 0.25rem;
  }

  ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .sep {
    padding-inline: 0.125rem;
    color: var(--bullet);
  }

  button {
    font: inherit;
    font-size: 0.8125rem;
    /* Roomy enough to hit on a phone without looking like a button. */
    min-height: 1.75rem;
    max-width: 11rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: 0 0.25rem;
    color: var(--fg-dim);
    background: none;
    border: 0;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  button:hover {
    color: var(--fg);
    background: var(--surface);
  }

  h2 {
    margin: 0.125rem 0 0;
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
</style>
