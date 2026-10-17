<script lang="ts">
  /**
   * The overflow menu in the header: things used rarely enough that a
   * permanent button would cost more room than it is worth.
   *
   * Items are passed as data rather than markup so that the parts that are
   * easy to get wrong — closing on an outside tap, Escape returning focus to
   * the trigger, arrow keys — live here once, and adding an entry is a line
   * in an array.
   */

  export interface MenuItem {
    label: string
    onselect: () => void
    disabled?: boolean
  }

  interface Props {
    items: MenuItem[]
    label?: string
  }

  let { items, label = 'More actions' }: Props = $props()

  let open = $state(false)
  let trigger = $state<HTMLButtonElement | null>(null)
  let panel = $state<HTMLDivElement | null>(null)

  function close(returnFocus = false): void {
    open = false
    // Only when the keyboard closed it. Doing this after a tap would summon
    // the focus ring on a device that has no keyboard.
    if (returnFocus) trigger?.focus()
  }

  function choose(item: MenuItem): void {
    if (item.disabled === true) return
    close()
    item.onselect()
  }

  /** The enabled items, which are the only ones the arrow keys visit. */
  function options(): HTMLButtonElement[] {
    return panel === null
      ? []
      : [...panel.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
  }

  function move(delta: number): void {
    const buttons = options()
    if (buttons.length === 0) return
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = at === -1 ? 0 : (at + delta + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  /**
   * Close when something outside is touched.
   *
   * `pointerdown` rather than `click`, so the menu is gone before whatever was
   * tapped reacts. The trigger is exempt because its own click toggles:
   * closing here first would let that reopen it immediately.
   */
  $effect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (trigger?.contains(target) === true) return
      if (panel?.contains(target) === true) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  })

  // Opening with the keyboard should land somewhere usable; opening with a tap
  // is harmless either way, since focusing a button raises nothing.
  $effect(() => {
    if (open && panel !== null) options()[0]?.focus()
  })
</script>

<div class="menu">
  <button
    bind:this={trigger}
    type="button"
    class="trigger"
    onkeydown={handleKeydown}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  </button>

  {#if open}
    <!-- tabindex="-1" so the menu can take focus programmatically without
         ever sitting in the tab order, as the menu-button pattern wants. -->
    <div
      bind:this={panel}
      class="panel"
      role="menu"
      aria-label={label}
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      {#each items as item (item.label)}
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled === true}
          onclick={() => choose(item)}
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
  }

  /* Matches the header's own buttons. They are styled in App.svelte, and
     Svelte scopes those rules to that component, so the look is repeated here
     rather than reached for. */
  .trigger {
    display: grid;
    place-items: center;
    width: 2.25rem;
    min-height: 2.25rem;
    padding: 0;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }

  .trigger svg {
    width: 1.125rem;
    height: 1.125rem;
    fill: currentColor;
  }

  .panel {
    position: absolute;
    top: calc(100% + 0.375rem);
    /* Anchored to the right so it opens inwards and cannot run off a narrow
       screen. */
    right: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    min-width: 11rem;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.08),
      0 8px 24px rgb(0 0 0 / 0.16);
  }

  .panel button {
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    /* 40px: comfortable to hit with a thumb without making the panel tall. */
    min-height: 2.5rem;
    padding: 0 0.75rem;
    color: var(--fg);
    background: none;
    border: 0;
    border-radius: 0.375rem;
    cursor: pointer;
  }

  .panel button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .panel button:hover:not(:disabled),
  .panel button:focus-visible {
    background: var(--bg);
  }
</style>
