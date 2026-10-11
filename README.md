# Outliner

A nested to-do list for the browser — Workflowy-shaped, but smaller and faster.
Mobile-first; wider-screen affordances come later.

## Stack

- **Svelte 5** (runes) + **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Vite 8** dev server and build
- **Vitest** for the model/ops layer
- **Prettier** (`prettier-plugin-svelte`) for formatting

No UI framework and no rich-text editor dependency. Each list row is its own
`contenteditable`, which keeps caret and focus control in our hands — that
control is most of this app.

## Setup

Node 22 is installed via nvm and symlinked into `~/.local/bin` so it resolves in
non-interactive shells (`~/.bashrc` is not sourced there):

```sh
nvm install 22
ln -sf ~/.nvm/versions/node/v22.*/bin/{node,npm,npx} ~/.local/bin/
npm install
```

## Commands

| Command                | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `npm run dev`          | Dev server, exposed on the LAN (see below)  |
| `npm run build`        | Production build to `dist/`                 |
| `npm run preview`      | Serve the production build                  |
| `npm test`             | Run unit tests once                         |
| `npm run e2e`          | Build, then drive the app in a real browser |
| `npm run test:watch`   | Unit tests in watch mode                    |
| `npm run check`        | Typecheck (`svelte-check` + `tsc`)          |
| `npm run format`       | Format in place                             |
| `npm run format:check` | Verify formatting                           |

`npm run dev` serves on **port 8080**, bound to `0.0.0.0`, so it is reachable
from outside this VM as well as from a phone on the same network. The port is
`strictPort`, so a clash fails loudly rather than silently moving to 8081 and
landing on a port nothing forwards to.

Test on a real phone where you can — touch gestures, momentum scrolling, and
virtual-keyboard behaviour are not faithfully reproduced by desktop device
emulation. `npm run e2e` drives its own preview server on 4173 and is
unaffected by the dev port.

## Architecture

**Flat document model.** Items live in a `Record<ItemId, Item>` with ordered
`children` arrays, not as nested objects — indent, outdent, move, and
delete-subtree then touch only a couple of records instead of rebuilding a tree.
Rendering flattens the visible tree into an array of `(id, depth)` rows, which
is also the shape windowing would need if lists get large enough to warrant it.

**Ops layer.** Every mutation goes through an operation that can produce its own
inverse, feeding an app-level undo stack. This is load-bearing rather than
optional polish: per-item `contenteditable` means the browser's native undo does
not span structural edits, and a mis-triggered swipe deletes a whole subtree.

**Journalled inverses, not hand-written ones.** Rather than writing an undo for
each op, every op runs inside a `Tx` (`tx.ts`) that snapshots the _before_ image
of each record it touches. The inverse of any op — however many records it
rewrites — is then just "put these records back". Flat records keep each journal
entry small enough to produce on every keystroke.

**Total ops.** An operation that cannot apply (outdent at the top level, indent
of a first child) is a no-op returning `null` rather than an error, so the UI can
bind keys without pre-checking. No-ops record no history and, importantly, leave
the redo stack intact.

### Layout

| File            | Role                                                        |
| --------------- | ----------------------------------------------------------- |
| `model.ts`      | Types, plus pure tree/visible-order queries. No mutation.   |
| `tx.ts`         | Change journalling, revert/reapply, coalescing of changes.  |
| `ops.ts`        | Editing semantics. Takes a `Tx`, returns a caret or `null`. |
| `store.ts`      | `DocStore`: owns doc, caret, and undo/redo stacks.          |
| `persist.ts`    | Versioned envelope and a validating loader.                 |
| `storage.ts`    | Debounced, typed `Storage` wrapper.                         |
| `test-utils.ts` | Outline notation (`a` / `  b` / `> collapsed`) for tests.   |

Nothing below `store.ts` imports Svelte, so the whole core is testable in plain
Node. `editor.svelte.ts` is the only seam: it wraps the `Doc` in `$state`, and
because ops mutate records in place, Svelte's deep proxy invalidates only the
fields actually touched. Typing changes `item.text`, which no layout code reads,
so a keystroke does not recompute the row list.

### The UI layer

| File               | Role                                                  |
| ------------------ | ----------------------------------------------------- |
| `editor.svelte.ts` | Wraps the doc in `$state` and hands it to the store.  |
| `caret.ts`         | DOM selection <-> character offsets; line geometry.   |
| `Outline.svelte`   | Renders rows; owns all key, input and paste handling. |
| `Row.svelte`       | One row: bullet plus its `contenteditable`.           |
| `welcome.ts`       | The first-run document.                               |

Three things carry the weight here:

**The editable's text is never interpolated in the markup.** `Row.svelte` writes
it with an effect, and only when it diverges from the model. If Svelte owned the
text node it would replace it on every keystroke and destroy the caret; writing
only on divergence makes typing a no-op while still letting undo, merge and
paste land.

**Events are delegated to the container**, so adding a row costs no listeners
and handlers can find their row from `data-item-id`.

**Arrow keys consult geometry, not offsets.** Inside a row whose text wraps, the
browser should keep moving the caret and we only take over at the real first or
last visual line — an `offset === 0` test would jump rows from the middle of a
wrapped line.

### Editing semantics worth knowing

- **Enter** splits at the caret. At offset 0 of a non-empty item it pushes the
  line down (empty sibling above, caret stays). On an item with _visible_
  children the tail becomes the new first child, since the children belong to
  the head.
- **Shift-Tab** adopts any following siblings as children. Without that, outdent
  would silently reorder the document on screen.
- **Backspace at offset 0** merges into the previous _visible_ row, children and
  all. Merging a first child into its parent leaves the children in the slot the
  item vacated, so the following siblings keep their place; otherwise they are
  appended to the destination, which is the deepest row before this one and so
  preserves document order. The destination is expanded if it adopts children,
  since dropping them into a collapsed item would look like deletion.
- **Typing coalesces** into one undo step per item within a 600 ms window, so
  undo is not per-character. A structural edit or a caret move breaks the step.
- The document is never left empty; deleting the last item creates a fresh one.
- **Pasting multi-line text makes multiple rows**, in one undo step. A row holds
  one line by definition, so flattening the breaks would silently discard the
  structure that was just pasted. Paste is always intercepted and reduced to
  `text/plain`.
- **Tapping below the list** appends a sibling of the last row — the same thing
  pressing Enter there would do.

`contenteditable="plaintext-only"` is used where supported, but it is
feature-detected rather than assumed: an unrecognised value maps to `inherit`,
which would leave rows _not editable at all_. The fallback is `true` plus our
own paste interception and suppression of the bold/italic/underline shortcuts.

## Roadmap

- [x] **0** Toolchain, scaffold, base styles, debounced persistence helper
- [x] **1** Document model + ops + undo stack (headless, unit-tested)
- [x] **2** List renderer, per-item `contenteditable`, Enter/Backspace/arrows
- [ ] **3** Swipe-right to delete subtree, with undo toast
- [ ] **4** Toolbar pinned above the virtual keyboard (indent/outdent/collapse)
- [ ] **5** Collapse/expand and zoom-into-item with breadcrumb
- [ ] **6** Perf pass on large lists; PWA manifest + offline
- [ ] **7** Desktop: keyboard shortcuts, drag-reorder, wider layout
