<script lang="ts">
  import { tick } from 'svelte'
  import Row from './Row.svelte'
  import KeyboardBar from './KeyboardBar.svelte'
  import type { DocStore } from './store'
  import type { ItemId } from './model'
  import { findItem, nextVisible, previousSibling, previousVisible } from './model'
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
    /** Called after anything that changes the document. */
    onchange?: () => void
  }

  let { store, onchange }: Props = $props()

  const plaintextOnly = supportsPlaintextOnly()
  const rows = $derived(store.rows())

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

  const canIndent = $derived.by(() => {
    if (activeId === null || findItem(store.doc, activeId) === undefined)
      return false
    return previousSibling(store.doc, activeId) !== undefined
  })

  const canOutdent = $derived.by(() => {
    if (activeId === null) return false
    const item = findItem(store.doc, activeId)
    if (item === undefined || item.parent === null) return false
    return item.parent !== store.doc.rootId
  })

  function indentActive(): void {
    runOnActive((id) => store.indent(id))
  }

  function outdentActive(): void {
    runOnActive((id) => store.outdent(id))
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

  function handleToggle(id: ItemId): void {
    store.toggleCollapsed(id)
    // Deliberately no caret restore: tapping a bullet should not drag focus
    // back to whichever row was last edited, and so pop the keyboard open.
    onchange?.()
  }

  /**
   * Tapping the empty space below the list continues it, the way tapping below
   * a note does. Only fires for the container itself, not for rows.
   */
  function handleBackgroundPointerDown(event: PointerEvent): void {
    if (event.target !== event.currentTarget) return
    const last = rows[rows.length - 1]
    if (last === undefined) return

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
        if (event.shiftKey) store.outdent(id)
        else store.indent(id)
        void afterEdit()
        return
      }

      case 'Backspace': {
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== 0) return
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
        if (target === undefined) return
        event.preventDefault()
        moveToRow(el, target)
        return
      }

      case 'ArrowDown': {
        if (!hasCollapsedSelection() || !isOnLastVisualLine(el)) return
        const target = nextVisible(store.doc, id)
        if (target === undefined) return
        event.preventDefault()
        moveToRow(el, target)
        return
      }

      case 'ArrowLeft': {
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== 0) return
        const target = previousVisible(store.doc, id)
        if (target === undefined) return
        event.preventDefault()
        focusRow(target, store.textOf(target).length)
        return
      }

      case 'ArrowRight': {
        const length = (el.textContent ?? '').length
        if (!hasCollapsedSelection() || caretOffsetIn(el) !== length) return
        const target = nextVisible(store.doc, id)
        if (target === undefined) return
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
  onkeydown={handleKeydown}
  oninput={handleInput}
  onpaste={handlePaste}
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
    />
  {/each}
</div>

<KeyboardBar
  editing={activeId !== null}
  {canIndent}
  {canOutdent}
  onindent={indentActive}
  onoutdent={outdentActive}
/>

<style>
  .outline {
    /* Room below the last row to tap for a new item. */
    min-height: 60vh;
    padding: 0.25rem 1rem calc(4rem + env(safe-area-inset-bottom));
    width: 100%;
    max-width: 44rem;
    margin-inline: auto;
  }
</style>
