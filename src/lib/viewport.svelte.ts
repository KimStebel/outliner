/**
 * Reactive visual-viewport metrics.
 *
 * `position: fixed` resolves against the *layout* viewport, which does not
 * shrink when the on-screen keyboard opens — anything pinned to `bottom: 0`
 * ends up behind the keyboard. The visual viewport does track it, so docked UI
 * is positioned from these numbers instead.
 *
 * Listeners are attached once at module load and never removed: these metrics
 * are needed for the lifetime of the page, and a singleton avoids every docked
 * component installing its own pair of listeners.
 */

const metrics = $state({
  /** Bottom edge of the visual viewport, in layout-viewport pixels. */
  bottom: 0,
  /** Roughly how much height the keyboard is taking, or 0 when closed. */
  keyboardHeight: 0,
})

function update(): void {
  const visual = window.visualViewport
  if (visual === null) {
    metrics.bottom = window.innerHeight
    metrics.keyboardHeight = 0
    return
  }
  metrics.bottom = visual.offsetTop + visual.height
  metrics.keyboardHeight = Math.max(0, window.innerHeight - visual.height)
}

if (typeof window !== 'undefined') {
  update()
  const visual = window.visualViewport
  if (visual !== null) {
    visual.addEventListener('resize', update)
    visual.addEventListener('scroll', update)
  } else {
    window.addEventListener('resize', update)
  }
}

export const viewport = {
  get bottom(): number {
    return metrics.bottom
  },
  get keyboardHeight(): number {
    return metrics.keyboardHeight
  },
}
