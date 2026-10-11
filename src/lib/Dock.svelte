<script lang="ts">
  /**
   * Holds UI against the bottom of the *visual* viewport, so it stays above
   * the on-screen keyboard. Children stack upwards in source order.
   *
   * Sizing a click-through wrapper to end at the viewport bottom, and aligning
   * content to its end, avoids having to measure the content's own height.
   */
  import type { Snippet } from 'svelte'
  import { viewport } from './viewport.svelte'

  let { children }: { children: Snippet } = $props()
</script>

<div class="dock" style="height: {viewport.bottom}px">
  <div class="stack">
    {@render children()}
  </div>
</div>

<style>
  .dock {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: flex-end;
    /* Must not swallow taps or block scrolling over the page behind it;
       the docked children re-enable pointer events for themselves. */
    pointer-events: none;
    z-index: 2;
  }

  .stack {
    display: flex;
    flex-direction: column;
    width: 100%;
  }
</style>
