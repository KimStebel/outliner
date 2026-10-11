<script lang="ts">
  import type { ItemId } from './model'
  import { segmentText } from './linkify'

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
    ondelete: (id: ItemId) => void
    /** Pointer went down on the drag handle; the parent decides if it drags. */
    ondraghandle: (id: ItemId, event: PointerEvent) => void
    /** True while this row is the one being dragged. */
    dragging: boolean
    /** True while the caret is in this row. */
    focused: boolean
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
    ondelete,
    ondraghandle,
    dragging,
    focused,
  }: Props = $props()

  let el: HTMLElement | undefined = $state()

  // Publish the element so the parent can focus it and place the caret.
  $effect(() => {
    const node = el
    if (node === undefined) return
    register(id, node)
    return () => register(id, null)
  })

  /**
   * Paint the row's text, with any URLs wrapped in anchors.
   *
   * The rendered characters are exactly the model's characters — links are
   * decoration, never a substitution — so character offsets stay valid for
   * the caret code.
   */
  function paint(node: HTMLElement, value: string): void {
    node.textContent = ''
    for (const segment of segmentText(value)) {
      if (segment.kind === 'text') {
        node.appendChild(document.createTextNode(segment.text))
        continue
      }
      const anchor = document.createElement('a')
      anchor.textContent = segment.text
      anchor.href = segment.href
      anchor.target = '_blank'
      // Without noopener the opened page gets a handle on this window.
      anchor.rel = 'noopener noreferrer'
      node.appendChild(anchor)
    }
  }

  // The editable's content is written here rather than interpolated in the
  // markup: letting Svelte own the text node would make it replace the node on
  // every keystroke and destroy the caret.
  //
  // Repainting only when the text diverges keeps typing a no-op here. The
  // extra repaint on losing focus is what turns a URL you just typed into a
  // link, since during typing the DOM already matches and nothing would
  // otherwise trigger it.
  $effect(() => {
    const node = el
    if (node === undefined) return
    if (node.textContent !== text || !focused) paint(node, text)
  })

  // ---------------------------------------------------------------------------
  // Swipe right to delete
  // ---------------------------------------------------------------------------

  /** Movement before the gesture commits to being a swipe rather than a scroll. */
  const DIRECTION_LOCK_PX = 8
  /** How much further horizontal than vertical travel must be to count. */
  const HORIZONTAL_BIAS = 1.5
  const MIN_COMMIT_PX = 72
  const COMMIT_FRACTION = 0.35

  let swipeEl: HTMLElement | undefined = $state()
  let offset = $state(0)
  let sliding = $state(false)

  let activePointer: number | null = null
  let startX = 0
  let startY = 0
  let locked: 'undecided' | 'swipe' | 'scroll' = 'undecided'
  let commitAt = MIN_COMMIT_PX

  const armed = $derived(offset >= commitAt)

  function onPointerDown(event: PointerEvent): void {
    // Mouse drags inside a row are text selection, so leave them alone; swipe
    // is a touch gesture. Desktop deletes rows by other means.
    if (event.pointerType === 'mouse') return
    // The bullet is the drag handle; a gesture starting there is a move, not
    // a swipe, and the two must not both claim it.
    if (event.target instanceof Element && event.target.closest('.bullet')) return
    // Dragging a selection handle also produces pointer events here.
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed) return

    activePointer = event.pointerId
    startX = event.clientX
    startY = event.clientY
    locked = 'undecided'
    const width = swipeEl?.getBoundingClientRect().width ?? 0
    commitAt = Math.max(MIN_COMMIT_PX, width * COMMIT_FRACTION)
  }

  function onPointerMove(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return

    const dx = event.clientX - startX
    const dy = event.clientY - startY

    if (locked === 'undecided') {
      if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) {
        return
      }
      // Only a clearly rightward gesture takes over; anything else is left to
      // the browser so the list still scrolls normally.
      const horizontal = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS && dx > 0
      if (!horizontal) {
        locked = 'scroll'
        activePointer = null
        return
      }
      locked = 'swipe'
      sliding = true
      try {
        swipeEl?.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers (and pointers already released) cannot be
        // captured; the gesture still works without capture.
      }
    }

    offset = Math.max(0, dx)
    event.preventDefault()
  }

  function onPointerUp(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return
    const commit = locked === 'swipe' && offset >= commitAt
    release()
    if (commit) ondelete(id)
  }

  function onPointerCancel(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return
    release()
  }

  function release(): void {
    activePointer = null
    locked = 'undecided'
    sliding = false
    offset = 0
  }
</script>

<!-- The swipe target is the whole row by design. It is a touch-gesture
     shortcut layered over the row, not a control in its own right: the row's
     real interactive elements (the textbox and the fold button) carry their
     own roles, and the gesture is never the only way to reach an action. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="swipe"
  bind:this={swipeEl}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  {#if sliding}
    <div class="affordance" class:armed aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M4 7h16M10 11v6M14 11v6" />
        <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
      </svg>
    </div>
  {/if}

  <div
    class="row"
    class:sliding
    class:dragging
    style="--depth: {depth}; transform: translateX({offset}px)"
  >
    {#if hasChildren}
      <button
        class="bullet interactive"
        class:collapsed
        onclick={() => ontoggle(id)}
        onpointerdown={(event) => ondraghandle(id, event)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        tabindex="-1"
      >
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {:else}
      <!-- A leaf's dot is a drag handle too, even though it has nothing to
           fold. It is not focusable and carries no action of its own. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="bullet leaf"
        aria-hidden="true"
        onpointerdown={(event) => ondraghandle(id, event)}
      ></span>
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
</div>

<style>
  .swipe {
    position: relative;
    /* Clip the sliding row. Without this it travels past the right edge and
       gives the whole page horizontal overflow mid-gesture. */
    overflow: hidden;
    /* Claim horizontal gestures for the swipe while leaving vertical panning
       to the browser, so the list still scrolls at native speed. */
    touch-action: pan-y;
  }

  .affordance {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding-left: 1rem;
    color: #fff;
    background: color-mix(in srgb, var(--danger) 55%, transparent);
  }

  .affordance.armed {
    /* Full strength once releasing would actually delete, so the commit point
       is visible rather than guessed at. */
    background: var(--danger);
  }

  .affordance svg {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    /* Indentation is padding on the row, so the whole row stays a full-width
       hit target for the swipe. */
    padding-left: calc(var(--depth) * var(--indent));
    padding-block: var(--row-pad-y);
    /* `scrollIntoView` works in the layout viewport and knows nothing about
       the keyboard bar overlaying the bottom, so reserve room for it. */
    scroll-margin-block: 1rem 4.5rem;
    /* Opaque, so the affordance behind it only shows where the row has moved. */
    background: var(--bg);
    position: relative;
  }

  .row:not(.sliding) {
    /* Spring back when a swipe is abandoned. Only when not sliding, or the
       row would lag the finger. */
    transition: transform 180ms ease-out;
  }

  .row.sliding {
    will-change: transform;
  }

  .row.dragging {
    /* Ghosted while in flight, so the drop indicator reads as the real
       position rather than competing with the row's current one. */
    opacity: 0.4;
  }

  /* One fixed-size slot whatever it holds, so a parent's text and a leaf's
     text at the same depth start at the same x. Its height is one line box,
     which centres the glyph on the row's first line without magic offsets. */
  .bullet {
    flex: none;
    position: relative;
    /* The handle owns its gestures outright: panning from here is a drag, so
       the browser must not also scroll the list. */
    touch-action: none;
    cursor: grab;
    display: grid;
    place-items: center;
    width: 14px;
    height: 1.45em;
    padding: 0;
    border: 0;
    background: none;
  }

  /* A leaf has nothing to fold, so it keeps a plain dot — a chevron there
     would advertise an action that does not exist. */
  .leaf::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--bullet);
  }

  .bullet.interactive {
    cursor: pointer;
  }

  .bullet.interactive::after {
    /* A 34px tap target centred on the glyph. Absolutely positioned so it
       cannot push the text out of alignment. */
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 34px;
    height: 34px;
    transform: translate(-50%, -50%);
  }

  .chevron {
    width: 13px;
    height: 13px;
    fill: none;
    /* Darker than a leaf's dot: this one is a control, not decoration. */
    stroke: var(--fg-dim);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    /* Points right when folded; rotating to point down is the open state. */
    transition: transform 150ms ease;
  }

  .bullet:not(.collapsed) .chevron {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }

  .text :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
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
