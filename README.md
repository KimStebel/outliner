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

| Command                | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | Dev server, exposed on the LAN (see below) |
| `npm run build`        | Production build to `dist/`                |
| `npm run preview`      | Serve the production build                 |
| `npm test`             | Run unit tests once                        |
| `npm run test:watch`   | Unit tests in watch mode                   |
| `npm run check`        | Typecheck (`svelte-check` + `tsc`)         |
| `npm run format`       | Format in place                            |
| `npm run format:check` | Verify formatting                          |

`npm run dev` binds to `0.0.0.0` and prints a Network URL. Open that on a real
phone — touch gestures, momentum scrolling, and virtual-keyboard behaviour are
not faithfully reproduced by desktop device emulation.

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

## Roadmap

- [x] **0** Toolchain, scaffold, base styles, debounced persistence helper
- [ ] **1** Document model + ops + undo stack (headless, unit-tested)
- [ ] **2** List renderer, per-item `contenteditable`, Enter/Backspace/arrows
- [ ] **3** Swipe-right to delete subtree, with undo toast
- [ ] **4** Toolbar pinned above the virtual keyboard (indent/outdent/collapse)
- [ ] **5** Collapse/expand and zoom-into-item with breadcrumb
- [ ] **6** Perf pass on large lists; PWA manifest + offline
- [ ] **7** Desktop: keyboard shortcuts, drag-reorder, wider layout
