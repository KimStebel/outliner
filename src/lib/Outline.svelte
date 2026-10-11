<script lang="ts">
  import { tick } from 'svelte'
  import Row from './Row.svelte'
  import Dock from './Dock.svelte'
  import KeyboardBar from './KeyboardBar.svelte'
  import { viewport } from './viewport.svelte'
  import { projectDrop, type DragStart, type DropTarget } from './drag'
  import type { DocStore } from './store'
  import type { ItemId } from './model'
  import {
    findItem,
    isDescendantOf,
    nextVisible,
    previousSibling,
    previousVisible,
    subtreeIds,
  } from './model'
  import {
    caretOffsetIn,
    hasCollapsedSelection,
    isOnFirstVisualLine,
    isOnLastVisualLine,
    selectionRangeIn,
    setCaretIn,
    supportsPlaintextOnly,
  } from './caret'

  interface Props {
    store: DocStore
    /** The item the view is rooted at, or `null` for the whole document. */
    zoomId?: ItemId | null
    onzoom?: (id: ItemId | null) => void
    /** Called after anything that changes the document. */
    onchange?: () => void
  }

  let { store, zoomId = null, onzoom, onchange }: Props = $props()

  const plaintextOnly = supportsPlaintextOnly()
  const zoomRootId = $derived(zoomId ?? store.doc.rootId)
  const rows = $derived(store.rows(zoomRootId))

  /**
   * Whether an item is inside the zoomed view. Navigation, merging and
   * outdenting all have to stop at the zoom boundary, or they would quietly
   * act on rows the user cannot see.
   */
  function withinZoom(id: ItemId): boolean {
    if (zoomId === null) return true
    return isDescendantOf(store.doc, id, zoomId)
  }

  /**
   * Live row elements, published by each `Row`. Not reactive state — it is a
   * lookup table for imperative focus work, never something we render from.
   */
  const elements = new Map<ItemId, HTMLElement>()

  function register(id: ItemId, el: HTMLElement | null): void {
    if (el === null) elements.delete(id)
    else elements.set(id, el)
  }

  // ---------------------------------------------------------------------------
  // Caret plumbing
  // ---------------------------------------------------------------------------

  /**
   * Push the DOM's text into the model before a structural edit, and start a
   * fresh undo step so that edit records the caret to return to.
   */
  function syncText(id: ItemId, el: HTMLElement): void {
    const offset = caretOffsetIn(el)
    store.setText(id, el.textContent ?? '', { id, offset })
    store.setCaret({ id, offset })
  }

  function placeCaret(): void {
    const caret = store.caret
    if (caret === null) return
    const el = elements.get(caret.id)
    if (el === undefined) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    setCaretIn(el, caret.offset)
    el.scrollIntoView({ block: 'nearest' })
  }

  /** Let the row list re-render, then restore the caret the op asked for. */
  async function afterEdit(): Promise<void> {
    onchange?.()
    await tick()
    placeCaret()
  }

  function focusRow(id: ItemId, offset: number): void {
    store.setCaret({ id, offset })
    placeCaret()
  }

  function rowIdFor(event: Event): ItemId | null {
    const target = event.target
    if (!(target instanceof HTMLElement)) return null
    const row = target.closest<HTMLElement>('[data-item-id]')
    return row?.dataset['itemId'] ?? null
  }

  function editableFor(event: Event): { id: ItemId; el: HTMLElement } | null {
    const id = rowIdFor(event)
    if (id === null) return null
    const el = elements.get(id)
    return el === undefined ? null : { id, el }
  }

  /**
   * Keep the model's caret in step with selection the user moves themselves,
   * which is also what breaks the typing-coalesce window so that clicking
   * elsewhere and typing starts a new undo step.
   *
   * `selectionchange` fires for our own typing too, and breaking the window on
   * every keystroke would defeat coalescing entirely. Input events land before
   * the resulting selectionchange, so a flag set there marks the change as
   * "ours" and lets it pass untouched.
   */
  let selectionChangeIsOurs = false

  $effect(() => {
    const onSelectionChange = (): void => {
      if (selectionChangeIsOurs) {
        selectionChangeIsOurs = false
        return
      }
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return
      const id = active.dataset['itemId']
      if (id === undefined || !store.exists(id)) return
      store.setCaret({ id, offset: caretOffsetIn(active) })
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  })

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  function handleInput(event: Event): void {
    const found = editableFor(event)
    if (found === null) return
    const { id, el } = found

    selectionChangeIsOurs = true
    // No caret restore here on purpose: the DOM caret is already where the user
    // put it, and reasserting it would interrupt IME composition.
    store.setText(id, el.textContent ?? '', { id, offset: caretOffsetIn(el) })
    onchange?.()
  }

  function handlePaste(event: ClipboardEvent): void {
    const found = editableFor(event)
    if (found === null) return
    const { id, el } = found

    // Always intercept. In the `contenteditable="true"` fallback the browser
    // would otherwise drop markup into a model that stores only plain text.
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text === '') return

    const range = selectionRangeIn(el) ?? { start: 0, end: 0 }
    syncText(id, el)
    store.replaceRange(id, range.start, range.end, text)
    void afterEdit()
  }

  // ---------------------------------------------------------------------------
  // Which row is being edited
  //
  // Drives the keyboard bar. Tracked separately from `store.caret` because the
  // bar must appear and disappear reactively, and the store's caret is plain
  // state.
  // ---------------------------------------------------------------------------

  let activeId = $state<ItemId | null>(null)
  let blurTimer: ReturnType<typeof setTimeout> | null = null

  function handleFocusIn(event: FocusEvent): void {
    const id = rowIdFor(event)
    if (id === null) return
    if (blurTimer !== null) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    activeId = id
  }

  function handleFocusOut(): void {
    // A structural edit destroys the focused row and focuses its replacement,
    // which is a blur followed immediately by a focus. Waiting a moment before
    // believing the blur keeps the bar from flickering on every Enter.
    if (blurTimer !== null) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      activeId = null
      blurTimer = null
    }, 120)
  }

  /**
   * Touch devices are the ones lacking a Tab key. Also checking for an open
   * keyboard means a device that reports a fine pointer still gets the bar
   * rather than silently losing the only way to indent.
   */
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const showKeyboardBar = $derived(
    activeId !== null && (coarsePointer || viewport.keyboardHeight > 120),
  )

  const canIndent = $derived.by(() => {
    if (activeId === null || findItem(store.doc, activeId) === undefined)
      return false
    return previousSibling(store.doc, activeId) !== undefined
  })

  const canOutdent = $derived.by(() => {
    if (activeId === null) return false
    const item = findItem(store.doc, activeId)
    if (item === undefined || item.parent === null) return false
    // The zoom root is the shallowest level the view can express.
    return item.parent !== zoomRootId
  })

  function indentActive(): void {
    runOnActive((id) => store.indent(id))
  }

  function outdentActive(): void {
    runOnActive((id) => {
      if (findItem(store.doc, id)?.parent !== zoomRootId) store.outdent(id)
    })
  }

  function runOnActive(operation: (id: ItemId) => void): void {
    const id = activeId
    if (id === null) return
    const el = elements.get(id)
    if (el === undefined) return
    syncText(id, el)
    operation(id)
    void afterEdit()
  }

  // ---------------------------------------------------------------------------
  // Drag to move
  //
  // The bullet is the handle. Vertical travel picks the gap between rows;
  // horizontal travel picks the nesting depth, which is what makes a drag able
  // to re-parent and not merely reorder. `projectDrop` turns the pair into a
  // concrete parent and sibling.
  // ---------------------------------------------------------------------------

  /** Travel before a press on the handle becomes a drag rather than a tap. */
  const DRAG_THRESHOLD_PX = 6
  /** How close to the viewport edge before the list starts scrolling itself. */
  const AUTOSCROLL_MARGIN_PX = 72
  const FALLBACK_INDENT_PX = 22

  let outlineEl: HTMLElement | undefined = $state()
  let draggingId = $state<ItemId | null>(null)

  /** The dragged row and its descendants, which all travel together. */
  const draggingIds = $derived(
    draggingId === null || findItem(store.doc, draggingId) === undefined
      ? null
      : new Set(subtreeIds(store.doc, draggingId)),
  )
  let dropTarget = $state<DropTarget | null>(null)
  let indicatorTop = $state(0)

  let press: {
    id: ItemId
    pointerId: number
    startX: number
    startY: number
  } | null = null
  let pointerX = 0
  let pointerY = 0
  let autoScrollFrame: number | null = null
  /** Set after a real drag so the handle's click does not also fold the row. */
  let dragJustEnded = false

  function handleDragStart(id: ItemId, start: DragStart): void {
    press = {
      id,
      pointerId: start.pointerId,
      startX: start.clientX,
      startY: start.clientY,
    }
    pointerX = start.clientX
    pointerY = start.clientY
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    window.addEventListener('pointercancel', onDragEnd)
    if (start.immediate) activateDrag(id)
  }

  function activateDrag(id: ItemId): void {
    draggingId = id
    startAutoScroll()
    seizeGestures()
    updateDropTarget()
  }

  /**
   * Take the gesture away from the browser for the duration of the drag.
   *
   * Rows carry `touch-action: pan-y` so the list scrolls normally, which means
   * the browser would start scrolling the moment a held finger moves. A
   * non-passive `touchmove` listener that cancels the event is the only way to
   * stop that once the gesture is already under way — `touch-action` is read
   * when the touch begins and changing it now would be ignored.
   *
   * A hold also puts phones into text selection, so any selection made on the
   * way here is dropped and further selection suppressed until the drop.
   */
  function seizeGestures(): void {
    window.getSelection()?.removeAllRanges()
    document.body.classList.add('is-dragging-row')
    document.addEventListener('touchmove', blockEvent, { passive: false })
    document.addEventListener('contextmenu', blockEvent)
    // A short tick confirms the pick-up where the device supports it.
    navigator.vibrate?.(8)
  }

  function releaseGestures(): void {
    document.body.classList.remove('is-dragging-row')
    document.removeEventListener('touchmove', blockEvent)
    document.removeEventListener('contextmenu', blockEvent)
  }

  function blockEvent(event: Event): void {
    if (event.cancelable) event.preventDefault()
  }

  function onDragMove(event: PointerEvent): void {
    if (press === null || event.pointerId !== press.pointerId) return
    pointerX = event.clientX
    pointerY = event.clientY

    if (draggingId === null) {
      const travelled = Math.hypot(
        event.clientX - press.startX,
        event.clientY - press.startY,
      )
      if (travelled < DRAG_THRESHOLD_PX) return
      activateDrag(press.id)
    }

    if (event.cancelable) event.preventDefault()
    updateDropTarget()
  }

  function onDragEnd(event: PointerEvent): void {
    if (press === null || event.pointerId !== press.pointerId) return
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    stopAutoScroll()
    releaseGestures()

    const moved = draggingId
    const target = dropTarget
    press = null
    draggingId = null
    dropTarget = null

    if (moved === null) return

    // The same press would otherwise reach the handle's click handler and
    // fold the row that was just dropped.
    dragJustEnded = true
    setTimeout(() => (dragJustEnded = false), 400)

    if (target !== null) {
      store.moveItem(moved, target.parentId, target.afterId)
      // Dragging is not editing, so the caret is left where the user had it.
      onchange?.()
    }
  }

  /** The full row box, which is the swipe wrapper rather than the editable. */
  function rowRect(id: ItemId): DOMRect | null {
    const element = elements.get(id)?.closest('.swipe')
    return element === null || element === undefined
      ? null
      : element.getBoundingClientRect()
  }

  function indentWidth(): number {
    if (outlineEl === undefined) return FALLBACK_INDENT_PX
    const declared = getComputedStyle(outlineEl).getPropertyValue('--indent')
    const parsed = Number.parseFloat(declared)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_INDENT_PX
  }

  function updateDropTarget(): void {
    const id = draggingId
    if (id === null || press === null || outlineEl === undefined) return

    // The dragged item travels with its descendants, so none of them can be
    // a neighbour of the drop.
    const travelling = new Set(subtreeIds(store.doc, id))
    const candidates = rows.filter((row) => !travelling.has(row.id))

    let gapIndex = candidates.length
    for (let i = 0; i < candidates.length; i += 1) {
      const row = candidates[i]
      if (row === undefined) continue
      const rect = rowRect(row.id)
      if (rect === null) continue
      if (pointerY < rect.top + rect.height / 2) {
        gapIndex = i
        break
      }
    }

    const draggedDepth = rows.find((row) => row.id === id)?.depth ?? 0
    const shift = Math.round((pointerX - press.startX) / indentWidth())
    const target = projectDrop(
      store.doc,
      candidates,
      gapIndex,
      draggedDepth + shift,
    )
    dropTarget = target

    const containerTop = outlineEl.getBoundingClientRect().top
    const atGap = candidates[gapIndex]
    if (atGap !== undefined) {
      indicatorTop = (rowRect(atGap.id)?.top ?? containerTop) - containerTop
    } else {
      const last = candidates[candidates.length - 1]
      const rect = last === undefined ? null : rowRect(last.id)
      indicatorTop = (rect?.bottom ?? containerTop) - containerTop
    }
  }

  function startAutoScroll(): void {
    const step = (): void => {
      const height = window.innerHeight
      let delta = 0
      if (pointerY < AUTOSCROLL_MARGIN_PX) {
        delta = -Math.ceil((AUTOSCROLL_MARGIN_PX - pointerY) / 5)
      } else if (pointerY > height - AUTOSCROLL_MARGIN_PX) {
        delta = Math.ceil((pointerY - (height - AUTOSCROLL_MARGIN_PX)) / 5)
      }
      if (delta !== 0) {
        window.scrollBy(0, delta)
        updateDropTarget()
      }
      autoScrollFrame = requestAnimationFrame(step)
    }
    autoScrollFrame = requestAnimationFrame(step)
  }

  function stopAutoScroll(): void {
    if (autoScrollFrame !== null) cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }

  function handleZoom(id: ItemId): void {
    // A drag that ended on this control must not also zoom.
    if (dragJustEnded) return
    onzoom?.(id)
  }

  function zoomOut(): void {
    if (zoomId === null) return
    const parent = findItem(store.doc, zoomId)?.parent ?? null
    onzoom?.(parent === null || parent === store.doc.rootId ? null : parent)
  }

  function handleToggle(id: ItemId): void {
    if (dragJustEnded) return
    store.toggleCollapsed(id)
    // Deliberately no caret restore: tapping a bullet should not drag focus
    // back to whichever row was last edited, and so pop the keyboard open.
    onchange?.()
  }

  // ---------------------------------------------------------------------------
  // Deleting a subtree
  // ---------------------------------------------------------------------------

  /**
   * `refocus` is true only when the request came from the keyboard, where the
   * user is demonstrably typing and expects the caret to carry on into the row
   * below. A swipe is not an editing gesture: moving focus afterwards would
   * pop the on-screen keyboard open over a list the user was only tidying.
   */
  function handleDelete(id: ItemId, refocus: boolean): void {
    store.remove(id)
    if (refocus) {
      void afterEdit()
    } else {
      onchange?.()
    }
  }

  /**
   * Open a link rather than letting `contenteditable` swallow the click.
   */
  function handleClick(event: MouseEvent): void {
    const anchor = linkFrom(event.target)
    if (anchor === null) return
    event.preventDefault()
    const href = anchor.getAttribute('href')
    if (href !== null) window.open(href, '_blank', 'noopener,noreferrer')
  }

  function linkFrom(target: EventTarget | null): Element | null {
    return target instanceof Element ? target.closest('a[href]') : null
  }

  /**
   * Tapping the empty space below the list continues it, the way tapping below
   * a note does. Only fires for the container itself, not for rows.
   */
  function handleBackgroundPointerDown(event: PointerEvent): void {
    if (linkFrom(event.target) !== null) {
      // Suppressing the default keeps focus out of the row, so tapping a link
      // does not also open the keyboard over the page it is about to leave.
      event.preventDefault()
      return
    }
    if (event.target !== event.currentTarget) return
    const last = rows[rows.length - 1]
    if (last === undefined) {
      // A zoomed item whose children were all removed still needs somewhere
      // to type.
      event.preventDefault()
      store.appendChild(zoomRootId)
      void afterEdit()
      return
    }

    event.preventDefault()
    const text = store.textOf(last.id)
    if (text === '') {
      focusRow(last.id, 0)
      return
    }
    store.setCaret({ id: last.id, offset: text.length })
    store.insertAfter(last.id)
    void afterEdit()
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  function handleKeydown(event: KeyboardEvent): void {
    const found = editableFor(event)
    if (found === null) return
    const { id, el } = found
    const key = event.key

    if (event.metaKey || event.ctrlKey) {
      handleShortcut(event, id, el)
      return
    }
    if (event.altKey) return

    switch (key) {
      case 'Enter': {
        event.preventDefault()
        const range = selectionRangeIn(el) ?? { start: 0, end: 0 }
        syncText(id, el)
        store.splitItem(id, range.start, range.end)
        void afterEdit()
        return
      }

      case 'Tab': {
        event.preventDefault()
        syncText(id, el)
        if (event.shiftKey) {
          // Outdenting a direct child of the zoom root would lift it out of
          // the view it is being edited in.
          if (findItem(store.doc, id)?.parent !== zoomRootId) store.outdent(id)
        } else {
          store.indent(id)
        }
        void afterEdit()
        return
      }

      case 'Escape': {
        if (zoomId === null) return
        event.preventDefault()
        zoomOut()
        return
      }

      case 'Backspace': {
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== 0) return
        const into = previousVisible(store.doc, id)
        // Merging into a row outside the zoom would move text somewhere the
        // user cannot see.
        if (into === undefined || !withinZoom(into)) return
        event.preventDefault()
        syncText(id, el)
        store.mergeWithPrevious(id)
        void afterEdit()
        return
      }

      case 'ArrowUp': {
        // Geometry, not offset: inside a row whose text wraps, the browser
        // should keep moving the caret and we only take over at the real edge.
        if (!hasCollapsedSelection() || !isOnFirstVisualLine(el)) return
        const target = previousVisible(store.doc, id)
        if (target === undefined || !withinZoom(target)) return
        event.preventDefault()
        moveToRow(el, target)
        return
      }

      case 'ArrowDown': {
        if (!hasCollapsedSelection() || !isOnLastVisualLine(el)) return
        const target = nextVisible(store.doc, id)
        if (target === undefined || !withinZoom(target)) return
        event.preventDefault()
        moveToRow(el, target)
        return
      }

      case 'ArrowLeft': {
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== 0) return
        const target = previousVisible(store.doc, id)
        if (target === undefined || !withinZoom(target)) return
        event.preventDefault()
        focusRow(target, store.textOf(target).length)
        return
      }

      case 'ArrowRight': {
        const length = (el.textContent ?? '').length
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== length) return
        const target = nextVisible(store.doc, id)
        if (target === undefined || !withinZoom(target)) return
        event.preventDefault()
        focusRow(target, 0)
        return
      }
    }
  }

  function handleShortcut(event: KeyboardEvent, id: ItemId, el: HTMLElement): void {
    const key = event.key.toLowerCase()

    if (key === 'z') {
      event.preventDefault()
      syncText(id, el)
      if (event.shiftKey) store.redo()
      else store.undo()
      void afterEdit()
      return
    }
    if (key === 'y') {
      event.preventDefault()
      syncText(id, el)
      store.redo()
      void afterEdit()
      return
    }
    if (key === 'enter') {
      // The keyboard counterpart of swipe-to-delete, so removing a subtree is
      // not a touch-only capability.
      event.preventDefault()
      handleDelete(id, true)
      return
    }
    if (key === 'b' || key === 'i' || key === 'u') {
      // These would inject <b>/<i>/<u> in the `true` fallback mode.
      event.preventDefault()
    }
  }

  /** Vertical move keeps roughly the same column, clamped to the target row. */
  function moveToRow(fromEl: HTMLElement, targetId: ItemId): void {
    const offset = caretOffsetIn(fromEl)
    focusRow(targetId, Math.min(offset, store.textOf(targetId).length))
  }
</script>

<!-- Events are delegated here rather than bound per row: the editable rows are
     the interactive elements, this is just where their events are handled. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="outline"
  bind:this={outlineEl}
  onkeydown={handleKeydown}
  oninput={handleInput}
  onpaste={handlePaste}
  onclick={handleClick}
  onpointerdown={handleBackgroundPointerDown}
  onfocusin={handleFocusIn}
  onfocusout={handleFocusOut}
>
  {#each rows as row (row.id)}
    <Row
      id={row.id}
      text={store.textOf(row.id)}
      depth={row.depth}
      hasChildren={row.hasChildren}
      collapsed={row.collapsed}
      {plaintextOnly}
      {register}
      ontoggle={handleToggle}
      onzoom={handleZoom}
      ondelete={(id) => handleDelete(id, false)}
      ondragstart={handleDragStart}
      focused={activeId === row.id}
      dragging={draggingIds?.has(row.id) ?? false}
    />
  {/each}

  {#if dropTarget !== null}
    <div
      class="drop-indicator"
      style="top: {indicatorTop}px; --drop-depth: {dropTarget.depth}"
      aria-hidden="true"
    ></div>
  {/if}
</div>

<Dock>
  {#if showKeyboardBar}
    <KeyboardBar
      {canIndent}
      {canOutdent}
      onindent={indentActive}
      onoutdent={outdentActive}
    />
  {/if}
</Dock>

<style>
  .outline {
    position: relative;
    /* Room below the last row to tap for a new item. */
    min-height: 60vh;
    padding: 0.25rem 1rem calc(4rem + env(safe-area-inset-bottom));
    width: 100%;
    max-width: 44rem;
    margin-inline: auto;
  }

  .drop-indicator {
    position: absolute;
    /* Indented to the depth the item would land at, so the line shows the
       nesting as well as the position. */
    left: calc(1rem + var(--drop-depth) * var(--indent));
    right: 1rem;
    height: 2px;
    margin-top: -1px;
    background: var(--accent);
    border-radius: 1px;
    pointer-events: none;
  }

  .drop-indicator::before {
    content: '';
    position: absolute;
    left: -3px;
    top: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
