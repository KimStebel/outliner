/**
 * The seam between the framework-agnostic core and Svelte.
 *
 * `$state` wraps the document in a deep proxy, and because every op mutates
 * records in place, Svelte invalidates only the fields actually touched.
 * Typing changes `item.text`, which no row-layout code reads, so a keystroke
 * does not recompute the visible row list.
 */

import type { Doc } from './model'
import type { DocStoreOptions } from './store'
import { DocStore } from './store'

export function createReactiveStore(
  initial: Doc,
  options: DocStoreOptions = {},
): DocStore {
  const doc = $state(initial)
  return new DocStore(doc, options)
}
