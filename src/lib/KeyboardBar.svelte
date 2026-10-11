<script lang="ts">
  /**
   * Actions docked above the on-screen keyboard while a row is being edited.
   *
   * A phone keyboard has no Tab key, so indent and outdent are otherwise
   * unreachable on mobile. This is the only place they live there.
   */

  interface Props {
    /** True while a row has focus. */
    editing: boolean
    canIndent: boolean
    canOutdent: boolean
    onindent: () => void
    onoutdent: () => void
  }

  let { editing, canIndent, canOutdent, onindent, onoutdent }: Props = $props()

  /**
   * Bottom edge of the *visual* viewport, in layout-viewport pixels.
   *
   * `position: fixed` resolves against the layout viewport, which does not
   * shrink when the keyboard opens — a bar pinned to `bottom: 0` ends up
   * behind the keyboard. The visual viewport does track it, so the bar is
   * placed by making a full-height, click-through wrapper end exactly here and
   * aligning the bar to its bottom. Doing it that way avoids having to measure
   * the bar's own height.
   */
  let viewportBottom = $state(0)
  let keyboardHeight = $state(0)

  $effect(() => {
    const viewport = window.visualViewport

    const update = (): void => {
      if (viewport === null) {
        viewportBottom = window.innerHeight
        keyboardHeight = 0
        return
      }
      viewportBottom = viewport.offsetTop + viewport.height
      keyboardHeight = Math.max(0, window.innerHeight - viewport.height)
    }

    update()
    if (viewport === null) {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  })

  /**
   * Touch devices are the ones lacking a Tab key. Checking for an open
   * keyboard as well means an unusual device that reports a fine pointer still
   * gets the bar rather than silently losing the only way to indent.
   */
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const visible = $derived(editing && (coarsePointer || keyboardHeight > 120))

  /**
   * Run the action on pointerdown, with the default suppressed.
   *
   * Letting the default through moves focus to the button, which blurs the
   * row, closes the keyboard, and unmounts this bar — all before a click could
   * arrive. Suppressing it keeps the caret exactly where it was.
   */
  let handledByPointer = false

  function press(event: PointerEvent, action: () => void): void {
    event.preventDefault()
    handledByPointer = true
    // Cleared on a timer because a suppressed pointerdown may produce no click
    // at all, and the flag must not outlive this interaction.
    setTimeout(() => (handledByPointer = false), 400)
    action()
  }

  function activate(action: () => void): void {
    // Only reached without a preceding pointerdown: assistive technology, or
    // a keyboard activation of the button.
    if (handledByPointer) return
    action()
  }
</script>

{#if visible}
  <div class="dock" style="height: {viewportBottom}px">
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
    </div>
  </div>
{/if}

<style>
  .dock {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: flex-end;
    /* The wrapper only positions the bar; it must not swallow taps or block
       scrolling over the rest of the page. */
    pointer-events: none;
    z-index: 2;
  }

  .bar {
    pointer-events: auto;
    display: flex;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
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
