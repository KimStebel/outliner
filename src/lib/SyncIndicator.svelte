<script lang="ts">
  /**
   * What sync is doing, stated plainly and persistently.
   *
   * Transient notices are the wrong shape here: a message you happen to miss
   * reads as "saved". Anything that needs attention stays until it resolves.
   */
  import type { SyncStatus } from './sync'
  import { SIGN_IN_URL } from './httpSync'

  interface Props {
    status: SyncStatus
    onacknowledge: () => void
  }

  let { status, onacknowledge }: Props = $props()

  const label = $derived.by(() => {
    if (status.state === 'unauthorized') return 'Sign in'
    if (status.state === 'offline') return 'Offline'
    if (status.state === 'error') return 'Sync failed'
    if (status.state === 'saving') return 'Saving'
    if (status.state === 'pending') return 'Unsaved'
    return status.replacedFromServer ? 'Updated' : 'Saved'
  })

  const tone = $derived.by(() => {
    if (status.state === 'unauthorized' || status.state === 'error') return 'bad'
    if (status.state === 'offline') return 'muted'
    if (status.state === 'saving' || status.state === 'pending') return 'busy'
    return 'good'
  })

  // A navigation, not a fetch: that is what makes the browser show its
  // basic-auth prompt.
  function signIn(): void {
    window.open(SIGN_IN_URL, '_blank', 'noopener,noreferrer')
  }
</script>

{#if status.state === 'unauthorized'}
  <button
    class="status {tone}"
    onclick={signIn}
    title="The server rejected the stored credentials"
  >
    <span class="dot"></span>{label}
  </button>
{:else if status.replacedFromServer}
  <button
    class="status {tone}"
    onclick={onacknowledge}
    title="This device was behind, so the server's version was loaded"
  >
    <span class="dot"></span>{label}
  </button>
{:else}
  <span class="status {tone}" title={status.message ?? ''} aria-live="polite">
    <span class="dot"></span>{label}
  </span>
{/if}

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--fg-dim);
    background: none;
    border: 0;
    padding: 0;
    white-space: nowrap;
  }

  button.status {
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  .good {
    color: var(--fg-dim);
  }
  .busy {
    color: var(--accent);
  }
  .muted {
    color: var(--bullet);
  }
  .bad {
    color: var(--danger);
  }
</style>
