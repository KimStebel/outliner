<script lang="ts">
  /**
   * Bring a markdown document in, by paste or by file.
   *
   * Uses a native `<dialog>` so focus trapping, the backdrop and Escape come
   * from the platform rather than being reimplemented.
   */
  import { countNodes, parseMarkdown } from './markdown'

  interface Props {
    open: boolean
    onimport: (markdown: string) => void
    onclose: () => void
  }

  let { open, onimport, onclose }: Props = $props()

  let dialog: HTMLDialogElement | undefined = $state()
  let source = $state('')
  let fileError = $state<string | null>(null)

  const itemCount = $derived(countNodes(parseMarkdown(source)))

  $effect(() => {
    const element = dialog
    if (element === undefined) return
    if (open && !element.open) {
      source = ''
      fileError = null
      element.showModal()
    } else if (!open && element.open) {
      element.close()
    }
  })

  async function handleFile(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file === undefined) return
    try {
      source = await file.text()
      fileError = null
    } catch {
      fileError = 'That file could not be read.'
    }
  }

  function submit(): void {
    if (itemCount === 0) return
    onimport(source)
  }
</script>

<dialog bind:this={dialog} {onclose} oncancel={onclose}>
  <h2>Import markdown</h2>
  <p class="hint">
    Headings and list indentation become nesting. Items are added to the end of your
    outline, and one undo removes them again.
  </p>

  <textarea
    bind:value={source}
    rows="10"
    spellcheck="false"
    placeholder={'# Trip\n- passport\n  - renew'}
    aria-label="Markdown to import"></textarea>

  <label class="file">
    <input
      type="file"
      accept=".md,.markdown,.txt,text/markdown,text/plain"
      onchange={handleFile}
    />
  </label>

  {#if fileError !== null}
    <p class="error" role="alert">{fileError}</p>
  {/if}

  <div class="actions">
    <button type="button" class="ghost" onclick={onclose}>Cancel</button>
    <button
      type="button"
      class="primary"
      disabled={itemCount === 0}
      onclick={submit}
    >
      {itemCount === 0 ? 'Nothing to import' : `Import ${itemCount} items`}
    </button>
  </div>
</dialog>

<style>
  dialog {
    width: min(34rem, calc(100vw - 2rem));
    padding: 1rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    box-shadow: 0 12px 40px rgb(0 0 0 / 28%);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 45%);
  }

  h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }

  .hint {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: var(--fg-dim);
  }

  textarea {
    display: block;
    width: 100%;
    /* 16px minimum keeps iOS from zooming when the field takes focus. */
    font:
      1rem/1.45 ui-monospace,
      Menlo,
      Consolas,
      monospace;
    padding: 0.5rem;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    resize: vertical;
  }

  .file {
    display: block;
    margin-top: 0.75rem;
    font-size: 0.875rem;
    color: var(--fg-dim);
  }

  .error {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: var(--danger);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  button {
    font: inherit;
    font-size: 0.9375rem;
    min-height: 2.5rem;
    padding-inline: 0.875rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
  }

  .ghost {
    color: var(--fg);
    background: var(--surface);
  }

  .primary {
    color: #fff;
    background: var(--accent);
    border-color: transparent;
  }

  .primary:disabled {
    opacity: 0.45;
  }
</style>
