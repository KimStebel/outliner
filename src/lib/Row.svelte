<script lang="ts">
  import type { ItemId } from './model'

  interface Props {
    id: ItemId
    text: string
    depth: number
    hasChildren: boolean
    collapsed: boolean
    /** Resolved once by the parent; see `supportsPlaintextOnly`. */
    plaintextOnly: boolean
    register: (id: ItemId, el: HTMLElement | null) => void
    ontoggle: (id: ItemId) => void
  }

  let {
    id,
    text,
    depth,
    hasChildren,
    collapsed,
    plaintextOnly,
    register,
    ontoggle,
  }: Props = $props()

  let el: HTMLElement | undefined = $state()

  // Publish the element so the parent can focus it and place the caret.
  $effect(() => {
    const node = el
    if (node === undefined) return
    register(id, node)
    return () => register(id, null)
  })

  // The editable's content is written here rather than interpolated in the
  // markup: letting Svelte own the text node would make it replace the node on
  // every keystroke and destroy the caret. Writing only on divergence means
  // typing is a no-op here, while an external change (undo, merge, paste)
  // still lands.
  $effect(() => {
    const node = el
    if (node !== undefined && node.textContent !== text) node.textContent = text
  })
</script>

<div class="row" style="--depth: {depth}">
  {#if hasChildren}
    <button
      class="bullet interactive"
      class:collapsed
      onclick={() => ontoggle(id)}
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand' : 'Collapse'}
      tabindex="-1"
    ></button>
  {:else}
    <span class="bullet" aria-hidden="true"></span>
  {/if}

  <div
    bind:this={el}
    class="text"
    data-item-id={id}
    contenteditable={plaintextOnly ? 'plaintext-only' : 'true'}
    role="textbox"
    tabindex="0"
    aria-multiline="false"
    spellcheck="false"
    autocapitalize="sentences"
  ></div>
</div>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    /* Indentation is padding on the row, so the whole row stays a full-width
       hit target — phase 3 needs that for the swipe gesture. */
    padding-left: calc(var(--depth) * var(--indent));
    padding-block: var(--row-pad-y);
  }

  /* The bullet occupies exactly the dot's size in layout, so parents and
     leaves at the same depth align. The dot itself and the tap target are
     drawn by pseudo-elements, which take part in hit testing without
     affecting the row's geometry. */
  .bullet {
    flex: none;
    position: relative;
    width: 7px;
    height: 7px;
    /* Centre the dot on the first line of text. */
    margin-top: calc((1.45em - 7px) / 2);
    padding: 0;
    border: 0;
    background: none;
  }

  .bullet::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--bullet);
  }

  .bullet.interactive {
    cursor: pointer;
  }

  .bullet.interactive::after {
    /* A 34px tap target centred on a 7px dot. Absolutely positioned so it
       cannot push the text out of alignment. */
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 34px;
    height: 34px;
    transform: translate(-50%, -50%);
  }

  .bullet.interactive.collapsed::before {
    /* A ring marks hidden children, so a folded row is not silently
       indistinguishable from a leaf. */
    box-shadow: 0 0 0 3.5px color-mix(in srgb, var(--bullet) 30%, transparent);
  }

  .text {
    flex: 1 1 auto;
    min-width: 0;
    /* No vertical padding: the caret-geometry checks measure the first and
       last wrapped lines against this element's box. */
    padding: 0;
    outline: none;
    /* pre-wrap keeps runs of spaces the user typed, and wraps long lines. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
</style>
