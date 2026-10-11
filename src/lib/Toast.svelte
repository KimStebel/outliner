<script lang="ts">
  /**
   * Transient confirmation with a single undo action.
   *
   * Deleting a subtree by swipe is the one gesture here that can destroy work
   * without the user meaning it, so the undo has to be visible and immediate
   * rather than buried behind a keyboard shortcut no phone has.
   */

  interface Props {
    message: string
    onundo: () => void
  }

  let { message, onundo }: Props = $props()

  // Same reasoning as the keyboard bar: acting on pointerdown with the default
  // suppressed keeps focus where it was instead of blurring the row.
  function press(event: PointerEvent): void {
    event.preventDefault()
    onundo()
  }
</script>

<div class="toast" role="status">
  <span class="message">{message}</span>
  <button type="button" onpointerdown={press} onclick={onundo}>Undo</button>
</div>

<style>
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 0.875rem;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  }

  .message {
    font-size: 0.9375rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  button {
    flex: none;
    font: inherit;
    font-size: 0.9375rem;
    font-weight: 600;
    /* Stays a comfortable touch target without dominating the toast. */
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    color: var(--accent);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
</style>
