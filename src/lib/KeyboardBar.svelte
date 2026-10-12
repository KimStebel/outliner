<script lang="ts">
  /**
   * Indent and outdent, for devices whose keyboard has no Tab key. Without
   * this there is no way to nest an item on a phone.
   *
   * Positioning above the keyboard is `Dock`'s job; this is only the bar.
   */

  interface Props {
    canIndent: boolean
    canOutdent: boolean
    onindent: () => void
    onoutdent: () => void
    onduplicate: () => void
  }

  let { canIndent, canOutdent, onindent, onoutdent, onduplicate }: Props = $props()

  /**
   * Act on pointerdown, with the default suppressed.
   *
   * Letting the default through moves focus to the button, which blurs the
   * row, closes the keyboard, and unmounts this bar — all before a click could
   * arrive, so the tap would appear to do nothing.
   */
  let handledByPointer = false

  function press(event: PointerEvent, action: () => void): void {
    event.preventDefault()
    handledByPointer = true
    // A suppressed pointerdown may produce no click at all, so the flag must
    // not outlive this interaction.
    setTimeout(() => (handledByPointer = false), 400)
    action()
  }

  function activate(action: () => void): void {
    // Reached only without a preceding pointerdown: assistive technology, or
    // keyboard activation of the button.
    if (handledByPointer) return
    action()
  }
</script>

<div class="bar">
  <button
    type="button"
    tabindex="-1"
    disabled={!canOutdent}
    aria-label="Outdent"
    onpointerdown={(event) => press(event, onoutdent)}
    onclick={() => activate(onoutdent)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M6 9l-3 3 3 3" />
    </svg>
  </button>

  <button
    type="button"
    tabindex="-1"
    disabled={!canIndent}
    aria-label="Indent"
    onpointerdown={(event) => press(event, onindent)}
    onclick={() => activate(onindent)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M3 9l3 3-3 3" />
    </svg>
  </button>

  <button
    type="button"
    class="apart"
    tabindex="-1"
    aria-label="Duplicate"
    title="Duplicate this item and its children"
    onpointerdown={(event) => press(event, onduplicate)}
    onclick={() => activate(onduplicate)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  </button>
</div>

<style>
  .bar {
    pointer-events: auto;
    display: flex;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem calc(0.375rem + env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  button {
    display: grid;
    place-items: center;
    /* 44px: the smallest comfortable touch target. */
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
  }

  /* Set apart from the indent pair, which belong together. */
  .apart {
    margin-left: 0.75rem;
  }

  button:disabled {
    opacity: 0.35;
  }

  button:active:not(:disabled) {
    background: var(--surface);
  }

  svg {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
