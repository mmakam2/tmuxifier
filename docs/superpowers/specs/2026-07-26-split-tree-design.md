# Split tree (sub-partitioning) — design

Date: 2026-07-26
Status: approved

## Summary

The stage's flat pane list becomes a split tree, so panes can nest: two terminals side by
side above one full-width third (`column[ row[A,B], C ]`), a 2×2 grid, a pane split in place
— any shape the gestures can produce, up to **4 panes** (`MAX_PANES` raised from 2). This
also fixes the v1.16.0 bug that let a third pane bypass the old cap: a successful drag-dock
repaints the sidebar, destroying the dragged row before its `dragend` fires, so the drop-zone
overlay and `dragSourceId` were never cleared and the next drag reused stale zones from the
previous layout state.

## Decisions (from brainstorming)

- Drop semantics: **stage edges + pane edges**. A stage-edge drop splits the whole stage
  (full-width/full-height new pane); a pane-edge drop splits just that pane; a pane-center
  drop still replaces it. The tmux/VS Code model.
- Cap: **4 panes** (gesture-layer constant, model stays N-capable).
- Undock collapses its split — the sibling absorbs the space.
- Saved `v:1` flat layouts migrate transparently.
- Plain-clicking an undocked box still replaces the **focused** pane.
- `Ctrl+Shift+Arrow` becomes **spatial** focus movement (geometrically adjacent pane).

## Model (`stageLayout.ts`)

A node is a leaf (box id string) or a split:

```ts
type PaneNode = string | SplitNode;
interface SplitNode { orientation: 'row' | 'column'; children: PaneNode[]; ratios: number[] }
```

Canonical-form invariants, enforced by every operation:

- A split has ≥ 2 children (a split reduced to 1 child collapses into that child).
- A child split never shares its parent's orientation — docking along a split's own axis
  inserts a sibling (`row[A,B]` + right-edge C → `row[A,B,C]`, never `row[A,row[B,C]]`).
- `ratios` has one entry per child, sums to 1, each ≥ `MIN_RATIO` (0.2) within its split.

Operations (all pure, all return a new tree):

- `panesOf(root)` — ordered leaf ids (DFS), the universal "what's docked" query.
- `dockAtStageEdge(root, id, edge)` — new leaf beside the root along the edge's axis
  (left/top prepend, right/bottom append), wrapping the root in a new split when the root's
  orientation differs; even re-split of ratios in the receiving split.
- `dockAtPaneEdge(root, targetId, id, edge)` — the target leaf becomes a split of
  [target, id] along the edge's axis (order by edge); if the target's parent already runs
  that axis, insert as the target's adjacent sibling instead (invariant above).
- `undockPane(root, id)` — remove the leaf; collapse one-child splits upward; renormalize.
- `replacePane(root, oldId, newId)` — swap if `newId` is already docked, else substitute.
- `movePane(root, id, drop)` — atomic undock+dock for dragging an already-docked pane, so
  a move can never observe its own half-removed subtree.
- `setRatio(root, path, divider, firstShare)` / `toggleOrientation(root, path)` — splits
  are addressed by **path** (array of child indexes from the root); dividers carry their
  split's path plus their index within it.

## Gestures (`stagePanes.ts` `dropTargets` + `main.ts` drag wiring)

While dragging box X, the zone set is:

- 4 **stage-edge** zones — gated by `panesOf().length < MAX_PANES` unless X is docked.
- Per pane: 4 **pane-edge** sub-zones (same cap gate) and a **center replace** zone
  (always offered except on X itself).

`dropTargets` returns typed targets (`{kind:'stage-edge',edge}` / `{kind:'pane-edge',
paneId,edge}` / `{kind:'replace',paneId}`); the DOM overlay renders stage-edge strips at
the stage rim, and per-pane edge strips + center box from the pane rects.

**Stale-zone bug fix** (the cap bypass): the drop handler itself clears the overlay's
children and `dragSourceId` after handling the drop — it no longer relies on `dragend`,
which never fires when the drag's source row was destroyed by the post-dock sidebar
repaint. The document-level `dragend` listener stays for cancelled drags.

The sidebar ◫ dock button shows whenever the box is undocked and `panesOf().length <
MAX_PANES`; it docks at the stage's right edge. The `Ctrl+Shift+Arrow` chord and the
drag-source wiring on rows are otherwise unchanged.

## Rendering (`stagePanes.ts`)

`renderStagePanes` recurses over the tree:

- A **split** renders a `.stage-split` grid container — template from its own ratios with
  6px divider tracks, `grid-auto-flow` per orientation — containing its children and one
  divider per adjacent pair.
- A **leaf** renders the existing pane exactly as today: header bar (via `headerFor`),
  `.pane-body` content, focus class, capture-phase mousedown. The pane-header registries
  in `main.ts` are keyed by pane id and need no change.
- Dividers keep the full WAI-ARIA splitter behavior (pointer drag, arrow keys reading live
  `aria-valuenow`, double-click 50/50, ⤢ orientation toggle), each scoped to its split via
  the path it was rendered with. `applyRatios` walks the tree and updates every split
  container's template plus every divider's `aria-valuenow`.

The top-level `.stage-grid` hosts the root node (or the empty panel). Undocked terminals
still park in `.stage-parking`.

## Focus & keyboard

`focusMove` becomes spatial and rect-based: a pure helper takes `{id, rect}[]` plus the
focused id and an arrow key, and returns the pane whose rect lies in that direction with
the nearest center (Euclidean, direction-filtered by axis overlap first). `main.ts` feeds
it `getBoundingClientRect()` of the rendered panes, so the helper stays unit-testable with
fixture rects and the DOM stays out of the model.

## Persistence & migration

- `serialize` writes `{v: 2, root, focusedId}`.
- `restore` accepts `v:2`, and migrates `v:1` (`{orientation, panes, ratios}`) by building
  the equivalent single split (or bare leaf / null for 1 / 0 panes).
- Vanished box ids are pruned via `undockPane` per missing leaf, so collapses keep the tree
  canonical. Per-split ratio sanity (count matches children, each ≥ MIN_RATIO, sums to ~1)
  falls back to an even split. Focus falls back to the first leaf.

## Out of scope

- No server changes, no new endpoints.
- No layout presets/snapping, no drag-to-reorder beyond the existing move semantics.
- The pane header bar, voice adoption, and content states ship as-is (already per-pane).
- Cap stays a constant (`MAX_PANES = 4`); no user setting for it.

## Testing

- **Unit (`test/stageLayout.test.js` rewritten + extended):** both dock kinds, the
  same-orientation sibling-merge invariant, nesting to depth 3 (A | (B over (C | D))),
  undock collapse and renormalization, replace/swap, movePane atomicity, ratio clamping by
  path, v1→v2 migration, vanished-box pruning, cap-independence of the model.
- **Unit (`test/stagePanes.test.js`):** `dropTargets` typed-target gating at cap 4 (docked
  vs undocked dragged id), per-split `dividerAria`/`gridTemplate`, spatial `focusMove`
  with rect fixtures (grid, 2-up+1, no-pane-in-direction).
- **E2E (`test/e2e/split.spec.ts`):** the reported scenario — dock A, dock B beside it,
  drag C to the stage's bottom edge → two panes up top, full-width C below (assert grid
  shape via bounding boxes); a pane-edge drop (C under B only); undock collapse back to
  2-up; reload persistence of a 3-pane tree; and the stale-zone regression — the zones a
  drag shows must always be built from the *current* layout: after a successful drag-dock,
  the next drag's zones match the new layout, and once 4 panes are docked a further drag
  offers replace zones only (no edge zones), so the cap cannot be bypassed.
