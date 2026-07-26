# Split Tree (Sub-Partitioning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat stage-pane list with a recursive split tree so panes can nest (2-up above a full-width third, 2×2, in-place pane splits), raise the cap to 4, and fix the stale-drop-zone bug that let panes bypass the old cap.

**Architecture:** `stageLayout.ts` becomes a tree model (`PaneNode = string | SplitNode`) with canonical-form invariants (splits ≥2 children, no same-orientation nesting, per-split ratios). `stagePanes.ts` renders recursively (`.stage-split` grid containers, path-addressed dividers) and grows typed drop targets + spatial focus. `main.ts` swaps its `stageLayout` state for `stageRoot`, rebuilds the drop-zone overlay from the typed targets, and clears drag state in the drop handler itself. Serialization bumps to `v:2` with transparent `v:1` migration. Zero server changes.

**Tech Stack:** TypeScript web client (Vite), vitest, Playwright. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-split-tree-design.md`.
- Public repo — placeholders only (`example.com`, RFC1918 IPs), no real PII.
- TDD, real code no mocks; `npm test` green at every commit; full e2e green at Tasks 3–5 (e2e serves `dist/` — `npm run build` before running it).
- Production service untouched during implementation (e2e uses port 7438). After execution, the validate-on-live workflow from CLAUDE.md's Shipping section applies before any merge.
- `MAX_PANES = 4` lives in `main.ts` (gesture layer); the model never enforces a cap.
- Pane header bar, voice adoption, and pane content states are already per-pane and must not regress (e2e voice + header tests stay green).

---

### Task 1: Tree model — rewrite `stageLayout.ts` + its tests

**Files:**
- Rewrite: `src/web/stageLayout.ts`
- Rewrite: `test/stageLayout.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact names later tasks import):
  - `type Orientation = 'row' | 'column'`, `type Edge = 'left' | 'right' | 'top' | 'bottom'`, `MIN_RATIO = 0.2`
  - `interface SplitNode { orientation: Orientation; children: PaneNode[]; ratios: number[] }`
  - `type PaneNode = string | SplitNode`
  - `type DropSpec = { kind: 'stage-edge'; edge: Edge } | { kind: 'pane-edge'; paneId: string; edge: Edge }`
  - `isSplit(n: PaneNode): n is SplitNode`
  - `panesOf(root: PaneNode | null): string[]`
  - `dockAtStageEdge(root: PaneNode | null, id: string, edge: Edge): PaneNode`
  - `dockAtPaneEdge(root: PaneNode | null, targetId: string, id: string, edge: Edge): PaneNode`
  - `movePane(root: PaneNode | null, id: string, drop: DropSpec): PaneNode`
  - `undockPane(root: PaneNode | null, id: string): PaneNode | null`
  - `replacePane(root: PaneNode | null, oldId: string, newId: string): PaneNode | null`
  - `setRatio(root: PaneNode | null, path: number[], divider: number, firstShare: number): PaneNode | null`
  - `toggleOrientation(root: PaneNode | null, path: number[]): PaneNode | null`
  - `splitAt(root: PaneNode | null, path: number[]): SplitNode | null`
  - `serialize(root: PaneNode | null, focusedId: string | null): string`
  - `restore(raw: string | null, knownIds: string[]): { root: PaneNode | null; focusedId: string | null }`

- [ ] **Step 1: Rewrite the test file (failing first)**

Replace `test/stageLayout.test.js` entirely:

```js
import { test, expect } from 'vitest';
import {
  panesOf, dockAtStageEdge, dockAtPaneEdge, movePane, undockPane, replacePane,
  setRatio, toggleOrientation, splitAt, serialize, restore, MIN_RATIO,
} from '../src/web/stageLayout.ts';

const row = (children, ratios) => ({ orientation: 'row', children, ratios: ratios ?? children.map(() => 1 / children.length) });
const col = (children, ratios) => ({ orientation: 'column', children, ratios: ratios ?? children.map(() => 1 / children.length) });

test('panesOf walks leaves in DFS order', () => {
  expect(panesOf(null)).toEqual([]);
  expect(panesOf('a')).toEqual(['a']);
  expect(panesOf(col([row(['a', 'b']), 'c']))).toEqual(['a', 'b', 'c']);
});

test('stage-edge dock: empty and single grow naturally', () => {
  expect(dockAtStageEdge(null, 'a', 'right')).toBe('a');
  expect(dockAtStageEdge('a', 'b', 'right')).toEqual(row(['a', 'b']));
  expect(dockAtStageEdge('a', 'b', 'left')).toEqual(row(['b', 'a']));
  expect(dockAtStageEdge('a', 'b', 'bottom')).toEqual(col(['a', 'b']));
});

test('stage-edge dock along the root axis inserts a sibling, never nests', () => {
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'right')).toEqual(row(['a', 'b', 'c']));
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'left')).toEqual(row(['c', 'a', 'b']));
});

test('stage-edge dock across the root axis wraps: the reported 2-up + full-width case', () => {
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'bottom')).toEqual(col([row(['a', 'b']), 'c']));
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'top')).toEqual(col(['c', row(['a', 'b'])]));
});

test('pane-edge dock splits just that pane', () => {
  expect(dockAtPaneEdge(row(['a', 'b']), 'b', 'c', 'bottom')).toEqual(row(['a', col(['b', 'c'])]));
  expect(dockAtPaneEdge(row(['a', 'b']), 'b', 'c', 'top')).toEqual(row(['a', col(['c', 'b'])]));
});

test('pane-edge dock along the parent axis becomes an adjacent sibling', () => {
  expect(panesOf(dockAtPaneEdge(row(['a', 'b']), 'a', 'c', 'right'))).toEqual(['a', 'c', 'b']);
  const t = dockAtPaneEdge(row(['a', 'b']), 'a', 'c', 'right');
  expect(t.orientation).toBe('row');
  expect(t.children).toEqual(['a', 'c', 'b']);
});

test('nesting to depth 3: A | (B over (C | D))', () => {
  let t = dockAtStageEdge('a', 'b', 'right');       // row[a,b]
  t = dockAtPaneEdge(t, 'b', 'c', 'bottom');        // row[a, col[b,c]]
  t = dockAtPaneEdge(t, 'c', 'd', 'right');         // row[a, col[b, row[c,d]]]
  expect(t).toEqual(row(['a', col(['b', row(['c', 'd'])])]));
  expect(panesOf(t)).toEqual(['a', 'b', 'c', 'd']);
});

test('docking an already-docked pane is a move, not a duplicate', () => {
  const t = movePane(row(['a', 'b']), 'a', { kind: 'stage-edge', edge: 'bottom' });
  expect(t).toEqual(col(['b', 'a']));
  const u = movePane(col([row(['a', 'b']), 'c']), 'c', { kind: 'pane-edge', paneId: 'a', edge: 'right' });
  // Sibling-merge scales ratios by the parent slot ([0.25, 0.25, 0.5]) — assert
  // structure, not ratios.
  expect(u.orientation).toBe('row');
  expect(u.children).toEqual(['a', 'c', 'b']);
});

test('undock collapses one-child splits and rescales ratios proportionally', () => {
  expect(undockPane(col([row(['a', 'b']), 'c']), 'c')).toEqual(row(['a', 'b']));
  expect(undockPane(row(['a', 'b']), 'b')).toBe('a');
  expect(undockPane('a', 'a')).toBeNull();
  const t = undockPane(row(['a', 'b', 'c'], [0.5, 0.25, 0.25]), 'a');
  expect(t.ratios).toEqual([0.5, 0.5]);
});

test('replacePane substitutes an undocked id and swaps a docked one', () => {
  expect(replacePane(row(['a', 'b']), 'b', 'c')).toEqual(row(['a', 'c']));
  const swapped = replacePane(col([row(['a', 'b']), 'c']), 'a', 'c');
  expect(swapped).toEqual(col([row(['c', 'b']), 'a']));
  expect(replacePane(row(['a', 'b']), 'zz', 'c')).toEqual(row(['a', 'b']));
});

test('setRatio addresses a split by path and clamps at MIN_RATIO', () => {
  const t = col([row(['a', 'b']), 'c']);
  const inner = setRatio(t, [0], 0, 0.7);
  expect(splitAt(inner, [0]).ratios).toEqual([0.7, 0.3]);
  const outer = setRatio(t, [], 0, 0.05);
  expect(outer.ratios[0]).toBeCloseTo(MIN_RATIO);
  expect(setRatio(t, [5], 0, 0.5)).toEqual(t); // bad path: unchanged
});

test('toggleOrientation flips a split and re-normalizes the tree', () => {
  const t = toggleOrientation(row(['a', 'b']), []);
  expect(t).toEqual(col(['a', 'b']));
  // flipping an inner split to the parent orientation merges it away
  const u = toggleOrientation(row(['a', col(['b', 'c'])]), [1]);
  expect(u.orientation).toBe('row');
  expect(panesOf(u)).toEqual(['a', 'b', 'c']);
  expect(u.children).toEqual(['a', 'b', 'c']);
});

test('serialize/restore round-trips a tree (v2)', () => {
  const t = col([row(['a', 'b'], [0.6, 0.4]), 'c'], [0.7, 0.3]);
  const { root, focusedId } = restore(serialize(t, 'b'), ['a', 'b', 'c']);
  expect(root).toEqual(t);
  expect(focusedId).toBe('b');
});

test('restore migrates a v1 flat layout', () => {
  const v1 = JSON.stringify({ v: 1, layout: { orientation: 'column', panes: ['a', 'b'], ratios: [0.7, 0.3] }, focusedId: 'b' });
  expect(restore(v1, ['a', 'b'])).toEqual({ root: col(['a', 'b'], [0.7, 0.3]), focusedId: 'b' });
  const single = JSON.stringify({ v: 1, layout: { orientation: 'row', panes: ['a'], ratios: [1] }, focusedId: 'a' });
  expect(restore(single, ['a'])).toEqual({ root: 'a', focusedId: 'a' });
});

test('restore prunes vanished boxes through collapse and refocuses', () => {
  const t = col([row(['a', 'gone'], [0.6, 0.4]), 'c'], [0.7, 0.3]);
  const { root, focusedId } = restore(serialize(t, 'gone'), ['a', 'c']);
  expect(root).toEqual(col(['a', 'c'], [0.7, 0.3]));
  expect(focusedId).toBe('a');
});

test('restore rejects garbage and insane ratios', () => {
  expect(restore('not json', ['a'])).toEqual({ root: null, focusedId: null });
  expect(restore(JSON.stringify({ v: 2, root: { orientation: 'row', children: ['a'], ratios: [1] } }), ['a']).root).toBe('a');
  const bad = JSON.stringify({ v: 2, root: { orientation: 'row', children: ['a', 'b'], ratios: [0.9, 0.9] }, focusedId: 'a' });
  expect(restore(bad, ['a', 'b']).root).toEqual(row(['a', 'b']));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run stageLayout`
Expected: FAIL — the flat module exports none of the new names.

- [ ] **Step 3: Rewrite `src/web/stageLayout.ts`**

```ts
// Pure stage-layout model: a split TREE of terminal panes. A node is a leaf
// (box id) or a split with its own orientation, children, and ratios.
// N-capable and depth-capable by construction — the pane cap is a gesture-
// layer rule in main.ts (MAX_PANES), never enforced here.
//
// Canonical form, restored by normalize() after every mutation:
//   - a split has >= 2 children (1 child collapses into that child)
//   - a child split never shares its parent's orientation (it merges in as
//     siblings, ratios scaled by the parent slot) — so docking along a
//     split's own axis yields row[a,b,c], never row[a,row[b,c]]
//   - ratios parallel children and sum to 1
export type Orientation = 'row' | 'column';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface SplitNode { orientation: Orientation; children: PaneNode[]; ratios: number[] }
export type PaneNode = string | SplitNode;
export type DropSpec = { kind: 'stage-edge'; edge: Edge } | { kind: 'pane-edge'; paneId: string; edge: Edge };

export const MIN_RATIO = 0.2;

export const isSplit = (n: PaneNode): n is SplitNode => typeof n !== 'string';
const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
const round = (x: number): number => Math.round(x * 1e4) / 1e4;
const axisOf = (edge: Edge): Orientation => (edge === 'left' || edge === 'right' ? 'row' : 'column');
const isBefore = (edge: Edge): boolean => edge === 'left' || edge === 'top';

export function panesOf(root: PaneNode | null): string[] {
  if (root == null) return [];
  if (!isSplit(root)) return [root];
  return root.children.flatMap((c) => panesOf(c));
}

// Restore canonical form. Ratios rescale proportionally when they no longer
// sum to 1 (an undock grows the survivors instead of forgetting the user's
// proportions); anything non-positive falls back to an even split.
function normalize(node: PaneNode): PaneNode {
  if (!isSplit(node)) return node;
  const children: PaneNode[] = [];
  const ratios: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalize(c);
    const r = node.ratios[i] ?? 0;
    if (isSplit(n) && n.orientation === node.orientation) {
      n.children.forEach((gc, j) => { children.push(gc); ratios.push(r * n.ratios[j]); });
    } else { children.push(n); ratios.push(r); }
  });
  if (children.length === 1) return children[0];
  const sum = ratios.reduce((a, b) => a + b, 0);
  const usable = sum > 0 && ratios.every((x) => x > 0);
  return {
    orientation: node.orientation,
    children,
    ratios: usable ? ratios.map((x) => round(x / sum)) : even(children.length),
  };
}

// Remove a leaf; null means the tree emptied. Collapse/renormalize via normalize.
function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (!isSplit(node)) return node === id ? null : node;
  const children: PaneNode[] = [];
  const ratios: number[] = [];
  node.children.forEach((c, i) => {
    const n = removeLeaf(c, id);
    if (n != null) { children.push(n); ratios.push(node.ratios[i]); }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return normalize(children[0]);
  return normalize({ orientation: node.orientation, children, ratios });
}

export function undockPane(root: PaneNode | null, id: string): PaneNode | null {
  return root == null ? null : removeLeaf(root, id);
}

// Both dock operations remove `id` first, so docking a docked pane is an
// atomic move — it can never observe (or duplicate into) its own subtree.
export function dockAtStageEdge(root: PaneNode | null, id: string, edge: Edge): PaneNode {
  const base = root == null ? null : removeLeaf(root, id);
  if (base == null) return id;
  const axis = axisOf(edge);
  if (isSplit(base) && base.orientation === axis) {
    const children = isBefore(edge) ? [id, ...base.children] : [...base.children, id];
    return { orientation: axis, children, ratios: even(children.length) };
  }
  const children: PaneNode[] = isBefore(edge) ? [id, base] : [base, id];
  return { orientation: axis, children, ratios: even(2) };
}

export function dockAtPaneEdge(root: PaneNode | null, targetId: string, id: string, edge: Edge): PaneNode {
  const base = root == null ? null : removeLeaf(root, id);
  if (base == null) return id;
  if (!panesOf(base).includes(targetId)) return dockAtStageEdge(base, id, edge);
  const axis = axisOf(edge);
  const insert = (node: PaneNode): PaneNode => {
    if (!isSplit(node)) {
      if (node !== targetId) return node;
      const children: PaneNode[] = isBefore(edge) ? [id, node] : [node, id];
      return { orientation: axis, children, ratios: even(2) };
    }
    return { ...node, children: node.children.map(insert) };
  };
  return normalize(insert(base)) as PaneNode;
}

export function movePane(root: PaneNode | null, id: string, drop: DropSpec): PaneNode {
  return drop.kind === 'stage-edge'
    ? dockAtStageEdge(root, id, drop.edge)
    : dockAtPaneEdge(root, drop.paneId, id, drop.edge);
}

export function replacePane(root: PaneNode | null, oldId: string, newId: string): PaneNode | null {
  if (root == null || !panesOf(root).includes(oldId)) return root;
  const mapLeaf = (node: PaneNode, from: string, to: string): PaneNode =>
    isSplit(node) ? { ...node, children: node.children.map((c) => mapLeaf(c, from, to)) } : node === from ? to : node;
  if (panesOf(root).includes(newId)) {
    const tmp = ' swap';
    return mapLeaf(mapLeaf(mapLeaf(root, oldId, tmp), newId, oldId), tmp, newId);
  }
  return mapLeaf(root, oldId, newId);
}

// Splits are addressed by path: child indexes from the root ([] = root split).
export function splitAt(root: PaneNode | null, path: number[]): SplitNode | null {
  let node: PaneNode | null = root;
  for (const i of path) {
    if (node == null || !isSplit(node)) return null;
    node = node.children[i] ?? null;
  }
  return node != null && isSplit(node) ? node : null;
}

export function setRatio(root: PaneNode | null, path: number[], divider: number, firstShare: number): PaneNode | null {
  if (root == null) return root;
  const apply = (node: PaneNode, depth: number): PaneNode => {
    if (!isSplit(node)) return node;
    if (depth === path.length) {
      const j = divider + 1;
      if (divider < 0 || j >= node.children.length) return node;
      const pair = node.ratios[divider] + node.ratios[j];
      const first = Math.min(pair - MIN_RATIO, Math.max(MIN_RATIO, firstShare * pair));
      const ratios = [...node.ratios];
      ratios[divider] = round(first);
      ratios[j] = round(pair - first);
      return { ...node, ratios };
    }
    const i = path[depth];
    if (i == null || i < 0 || i >= node.children.length) return node;
    const children = [...node.children];
    children[i] = apply(children[i], depth + 1);
    return { ...node, children };
  };
  return apply(root, 0);
}

export function toggleOrientation(root: PaneNode | null, path: number[]): PaneNode | null {
  if (root == null) return root;
  const apply = (node: PaneNode, depth: number): PaneNode => {
    if (!isSplit(node)) return node;
    if (depth === path.length) return { ...node, orientation: node.orientation === 'row' ? 'column' : 'row' };
    const i = path[depth];
    if (i == null || i < 0 || i >= node.children.length) return node;
    const children = [...node.children];
    children[i] = apply(children[i], depth + 1);
    return { ...node, children };
  };
  return normalize(apply(root, 0));
}

export function serialize(root: PaneNode | null, focusedId: string | null): string {
  return JSON.stringify({ v: 2, root, focusedId });
}

// Structural validation for v2 payloads; sanity-per-split falls back to even.
function sanitize(node: unknown): PaneNode | null {
  if (typeof node === 'string') return node;
  const s = node as Partial<SplitNode>;
  if (!s || (s.orientation !== 'row' && s.orientation !== 'column') || !Array.isArray(s.children)) return null;
  const children: PaneNode[] = [];
  for (const c of s.children) {
    const n = sanitize(c);
    if (n == null) return null;
    children.push(n);
  }
  if (children.length === 0) return null;
  const r = s.ratios;
  const sane = Array.isArray(r) && r.length === children.length
    && r.every((x) => typeof x === 'number' && x >= MIN_RATIO - 0.001)
    && Math.abs(r.reduce((a: number, b: number) => a + b, 0) - 1) < 0.01;
  return normalize({ orientation: s.orientation, children, ratios: sane ? (r as number[]) : even(children.length) });
}

export function restore(raw: string | null, knownIds: string[]): { root: PaneNode | null; focusedId: string | null } {
  const fallback = { root: null as PaneNode | null, focusedId: null as string | null };
  if (!raw) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  const p = parsed as { v?: unknown; root?: unknown; layout?: { orientation?: unknown; panes?: unknown; ratios?: unknown }; focusedId?: unknown };
  let root: PaneNode | null = null;
  if (p?.v === 2) {
    root = p.root == null ? null : sanitize(p.root);
    if (root == null && p.root != null) return fallback;
  } else if (p?.v === 1 && p.layout && Array.isArray(p.layout.panes)) {
    const panes = (p.layout.panes as unknown[]).filter((x): x is string => typeof x === 'string');
    if (panes.length === 0) root = null;
    else if (panes.length === 1) root = panes[0];
    else {
      root = sanitize({
        orientation: p.layout.orientation === 'column' ? 'column' : 'row',
        children: panes,
        ratios: p.layout.ratios,
      });
    }
  } else return fallback;
  const known = new Set(knownIds);
  for (const id of panesOf(root)) if (!known.has(id)) root = undockPane(root, id);
  const panes = panesOf(root);
  const focusedId = typeof p.focusedId === 'string' && panes.includes(p.focusedId) ? p.focusedId : panes[0] ?? null;
  return { root, focusedId };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run stageLayout`
Expected: all 16 tests pass. `npm test` will FAIL at typecheck (stagePanes/main.ts still import the flat API) — that is expected until Tasks 2–4; do NOT run the full suite gate here.

- [ ] **Step 5: Commit**

```bash
git add src/web/stageLayout.ts test/stageLayout.test.js
git commit -m "feat(web): split-tree stage layout model"
```

---

### Task 2: Pure pane helpers — typed drop targets, per-split dividers, spatial focus

**Files:**
- Modify: `src/web/stagePanes.ts` (pure section, lines 1–48; the DOM section is Task 3)
- Rewrite: `test/stagePanes.test.js`

**Interfaces:**
- Consumes: `PaneNode`, `SplitNode`, `panesOf`, `isSplit`, `Edge` from Task 1.
- Produces:
  - `DIVIDER_PX = 6` (unchanged)
  - `type DropTarget = { kind: 'stage-edge'; edge: Edge } | { kind: 'pane-edge'; paneId: string; edge: Edge } | { kind: 'replace'; paneId: string }`
  - `dropTargets(root: PaneNode | null, draggedId: string, maxPanes: number): DropTarget[]`
  - `gridTemplate(split: SplitNode): string` (same output shape as today, from the split's ratios)
  - `dividerAria(split: SplitNode, divider: number): { orientation: 'vertical' | 'horizontal'; valuenow: number }`
  - `keyboardRatioStep(split: SplitNode, divider: number, key: string): number | null`
  - `interface PaneRect { id: string; x: number; y: number; w: number; h: number }`
  - `focusMove(rects: PaneRect[], focusedId: string | null, key: string): string | null` — spatial

- [ ] **Step 1: Rewrite the test file (failing first)**

Replace `test/stagePanes.test.js`:

```js
import { test, expect } from 'vitest';
import { gridTemplate, dividerAria, keyboardRatioStep, dropTargets, focusMove, DIVIDER_PX } from '../src/web/stagePanes.ts';

const row = (children, ratios) => ({ orientation: 'row', children, ratios: ratios ?? children.map(() => 1 / children.length) });
const col = (children, ratios) => ({ orientation: 'column', children, ratios: ratios ?? children.map(() => 1 / children.length) });

test('gridTemplate interleaves fr tracks with fixed dividers', () => {
  expect(gridTemplate(row(['a', 'b'], [0.7, 0.3]))).toBe(`0.7fr ${DIVIDER_PX}px 0.3fr`);
  expect(gridTemplate(row(['a', 'b', 'c']))).toBe(`${1 / 3}fr ${DIVIDER_PX}px ${1 / 3}fr ${DIVIDER_PX}px ${1 / 3}fr`);
});

test('dividerAria reports splitter orientation and percentage per split', () => {
  expect(dividerAria(row(['a', 'b'], [0.7, 0.3]), 0)).toEqual({ orientation: 'vertical', valuenow: 70 });
  expect(dividerAria(col(['a', 'b']), 0)).toEqual({ orientation: 'horizontal', valuenow: 50 });
});

test('keyboardRatioStep steps 5% along the split axis only', () => {
  expect(keyboardRatioStep(row(['a', 'b']), 0, 'ArrowRight')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(col(['a', 'b']), 0, 'ArrowDown')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(row(['a', 'b']), 0, 'ArrowDown')).toBeNull();
});

test('dropTargets: stage edges, pane edges, and replace, gated by the cap', () => {
  const targets = dropTargets(row(['a', 'b']), 'c', 4);
  expect(targets.filter((t) => t.kind === 'stage-edge')).toHaveLength(4);
  expect(targets.filter((t) => t.kind === 'pane-edge')).toHaveLength(8);
  expect(targets.filter((t) => t.kind === 'replace').map((t) => t.paneId)).toEqual(['a', 'b']);
});

test('dropTargets at the cap: replace only for a foreign box, edges stay for a docked one', () => {
  const four = col([row(['a', 'b']), row(['c', 'd'])]);
  expect(dropTargets(four, 'e', 4).every((t) => t.kind === 'replace')).toBe(true);
  expect(dropTargets(four, 'a', 4).some((t) => t.kind === 'stage-edge')).toBe(true);
  // dragged pane offers no zones on itself
  expect(dropTargets(four, 'a', 4).some((t) => t.kind !== 'stage-edge' && t.paneId === 'a')).toBe(false);
});

test('focusMove is spatial: 2-up + full-width bottom', () => {
  // a,b side by side on top; c full-width below
  const rects = [
    { id: 'a', x: 0, y: 0, w: 50, h: 50 },
    { id: 'b', x: 50, y: 0, w: 50, h: 50 },
    { id: 'c', x: 0, y: 50, w: 100, h: 50 },
  ];
  expect(focusMove(rects, 'a', 'ArrowRight')).toBe('b');
  expect(focusMove(rects, 'b', 'ArrowLeft')).toBe('a');
  expect(focusMove(rects, 'a', 'ArrowDown')).toBe('c');
  expect(focusMove(rects, 'b', 'ArrowDown')).toBe('c');
  expect(focusMove(rects, 'c', 'ArrowUp')).toBe('a'); // nearest center in that direction
  expect(focusMove(rects, 'a', 'ArrowUp')).toBeNull();
  expect(focusMove(rects, null, 'ArrowRight')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run stagePanes`
Expected: FAIL (old flat signatures).

- [ ] **Step 3: Rewrite the pure section of `src/web/stagePanes.ts`**

Replace lines 1–48 (imports through `focusMove`) with:

```ts
// Stage-pane rendering: pure geometry/ARIA helpers (unit-tested) plus the DOM
// renderer (covered by the split e2e). Never imports main.ts — everything the
// renderer needs arrives via PaneHooks.
import { type PaneNode, type SplitNode, type Edge, isSplit, panesOf } from './stageLayout';

export const DIVIDER_PX = 6;

export function gridTemplate(split: SplitNode): string {
  return split.ratios.map((r) => `${r}fr`).join(` ${DIVIDER_PX}px `);
}

export function dividerAria(split: SplitNode, divider: number): { orientation: 'vertical' | 'horizontal'; valuenow: number } {
  const pair = split.ratios[divider] + split.ratios[divider + 1];
  return {
    orientation: split.orientation === 'row' ? 'vertical' : 'horizontal',
    valuenow: Math.round((split.ratios[divider] / pair) * 100),
  };
}

export function keyboardRatioStep(split: SplitNode, divider: number, key: string): number | null {
  const grow = split.orientation === 'row' ? 'ArrowRight' : 'ArrowDown';
  const shrink = split.orientation === 'row' ? 'ArrowLeft' : 'ArrowUp';
  if (key !== grow && key !== shrink) return null;
  const { valuenow } = dividerAria(split, divider);
  return (valuenow + (key === grow ? 5 : -5)) / 100;
}

export type DropTarget =
  | { kind: 'stage-edge'; edge: Edge }
  | { kind: 'pane-edge'; paneId: string; edge: Edge }
  | { kind: 'replace'; paneId: string };

const EDGES: Edge[] = ['left', 'right', 'top', 'bottom'];

// Splitting zones (stage edges + pane edges) are gated by the cap unless the
// dragged pane is already docked (then it's a move, pane count unchanged).
// Replace is always offered — it never grows the pane count.
export function dropTargets(root: PaneNode | null, draggedId: string, maxPanes: number): DropTarget[] {
  const panes = panesOf(root);
  const docked = panes.includes(draggedId);
  const canSplit = docked || panes.length < maxPanes;
  const out: DropTarget[] = [];
  if (canSplit) for (const edge of EDGES) out.push({ kind: 'stage-edge', edge });
  for (const paneId of panes) {
    if (paneId === draggedId) continue;
    if (canSplit) for (const edge of EDGES) out.push({ kind: 'pane-edge', paneId, edge });
    out.push({ kind: 'replace', paneId });
  }
  return out;
}

export interface PaneRect { id: string; x: number; y: number; w: number; h: number }

// Spatial focus: nearest pane whose center lies in the arrow's direction,
// ranked by distance along the axis then by perpendicular offset.
export function focusMove(rects: PaneRect[], focusedId: string | null, key: string): string | null {
  if (!focusedId) return null;
  const from = rects.find((r) => r.id === focusedId);
  if (!from) return null;
  const cx = (r: PaneRect) => r.x + r.w / 2;
  const cy = (r: PaneRect) => r.y + r.h / 2;
  const dir: Record<string, (r: PaneRect) => [number, number] | null> = {
    ArrowRight: (r) => (cx(r) > cx(from) + 1 ? [cx(r) - cx(from), Math.abs(cy(r) - cy(from))] : null),
    ArrowLeft: (r) => (cx(r) < cx(from) - 1 ? [cx(from) - cx(r), Math.abs(cy(r) - cy(from))] : null),
    ArrowDown: (r) => (cy(r) > cy(from) + 1 ? [cy(r) - cy(from), Math.abs(cx(r) - cx(from))] : null),
    ArrowUp: (r) => (cy(r) < cy(from) - 1 ? [cy(from) - cy(r), Math.abs(cx(r) - cx(from))] : null),
  };
  const score = dir[key];
  if (!score) return null;
  let best: { id: string; d: [number, number] } | null = null;
  for (const r of rects) {
    if (r.id === focusedId) continue;
    const d = score(r);
    if (!d) continue;
    if (!best || d[0] < best.d[0] || (d[0] === best.d[0] && d[1] < best.d[1])) best = { id: r.id, d };
  }
  return best?.id ?? null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run stagePanes`
Expected: all 6 tests pass (the DOM section below still compiles against the old model — if the typecheck complains, proceed to Task 3, which rewrites it; the commit gate for `npm test` applies at the END of Task 3).

- [ ] **Step 5: Commit** (only if `npx vitest run stagePanes stageLayout` is green)

```bash
git add src/web/stagePanes.ts test/stagePanes.test.js
git commit -m "feat(web): typed drop targets, per-split dividers, spatial focus"
```

---

### Task 3: Recursive renderer (`stagePanes.ts` DOM section) + CSS

**Files:**
- Modify: `src/web/stagePanes.ts` (DOM section: `PaneHooks`, `applyRatios`, `buildDivider`, `buildPane`, `renderStagePanes`)
- Modify: `src/web/style.css` (`.stage-split` container, nested-zone classes)

**Interfaces:**
- Consumes: Task 1 tree, Task 2 helpers.
- Produces:
  - `interface PaneHooks { contentFor(id: string): HTMLElement; headerFor(id: string, split: boolean): HTMLElement; onFocus(id: string): void; onRatio(path: number[], divider: number, firstShare: number, phase: 'drag' | 'commit'): void; onToggleOrientation(path: number[]): void }`
  - `renderStagePanes(grid: HTMLElement, root: PaneNode, focusedId: string | null, hooks: PaneHooks): void`
  - `applyRatios(grid: HTMLElement, root: PaneNode): void` — updates every `.stage-split[data-path]` template and divider `aria-valuenow`
  - Split containers carry `data-path` (JSON of the index path, e.g. `[0]`; root split `[]`).

- [ ] **Step 1: Rewrite the DOM section**

Replace `PaneHooks`, `applyRatios`, `buildDivider`, `buildPane`, `renderStagePanes` with:

```ts
export interface PaneHooks {
  contentFor(id: string): HTMLElement;
  headerFor(id: string, split: boolean): HTMLElement;
  onFocus(id: string): void;
  onRatio(path: number[], divider: number, firstShare: number, phase: 'drag' | 'commit'): void;
  onToggleOrientation(path: number[]): void;
}

const pathKey = (path: number[]): string => JSON.stringify(path);

function applySplitEl(el: HTMLElement, split: SplitNode): void {
  el.classList.toggle('stage-split-column', split.orientation === 'column');
  if (split.orientation === 'row') {
    el.style.gridTemplateColumns = gridTemplate(split);
    el.style.gridTemplateRows = '';
  } else {
    el.style.gridTemplateRows = gridTemplate(split);
    el.style.gridTemplateColumns = '';
  }
  el.querySelectorAll<HTMLElement>(':scope > .stage-divider').forEach((d, i) => {
    d.setAttribute('aria-valuenow', String(dividerAria(split, i).valuenow));
    d.setAttribute('aria-orientation', dividerAria(split, i).orientation);
  });
}

export function applyRatios(grid: HTMLElement, root: PaneNode): void {
  const walk = (node: PaneNode, path: number[]): void => {
    if (!isSplit(node)) return;
    const el = grid.querySelector<HTMLElement>(`.stage-split[data-path='${pathKey(path)}']`);
    if (el) applySplitEl(el, node);
    node.children.forEach((c, i) => walk(c, [...path, i]));
  };
  walk(root, []);
}

// The divider reads the live ratio back off its own aria-valuenow so a
// keyboard step after a pointer drag starts from where the drag left off.
function buildDivider(split: SplitNode, path: number[], divider: number, hooks: PaneHooks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stage-divider';
  const aria = dividerAria(split, divider);
  el.setAttribute('role', 'separator');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-orientation', aria.orientation);
  el.setAttribute('aria-label', 'Resize split');
  el.setAttribute('aria-valuemin', '20');
  el.setAttribute('aria-valuemax', '80');
  el.setAttribute('aria-valuenow', String(aria.valuenow));

  el.addEventListener('keydown', (e) => {
    const current = Number(el.getAttribute('aria-valuenow')) / 100;
    const pair = split.ratios[divider] + split.ratios[divider + 1];
    const live: SplitNode = { ...split, ratios: [...split.ratios] };
    live.ratios[divider] = current * pair;
    live.ratios[divider + 1] = (1 - current) * pair;
    const share = keyboardRatioStep(live, divider, e.key);
    if (share == null) return;
    e.preventDefault();
    hooks.onRatio(path, divider, share, 'commit');
  });
  el.addEventListener('dblclick', () => hooks.onRatio(path, divider, 0.5, 'commit'));

  el.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    el.setPointerCapture(down.pointerId);
    const prev = el.previousElementSibling as HTMLElement;
    const next = el.nextElementSibling as HTMLElement;
    const shareAt = (ev: PointerEvent) => {
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      return split.orientation === 'row'
        ? (ev.clientX - a.left) / (b.right - a.left)
        : (ev.clientY - a.top) / (b.bottom - a.top);
    };
    const move = (ev: PointerEvent) => hooks.onRatio(path, divider, shareAt(ev), 'drag');
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      hooks.onRatio(path, divider, shareAt(ev), 'commit');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });

  const rotate = document.createElement('button');
  rotate.type = 'button';
  rotate.className = 'divider-rotate';
  rotate.title = 'Toggle split direction';
  rotate.setAttribute('aria-label', 'Toggle split direction');
  rotate.textContent = '⤢';
  rotate.addEventListener('click', (e) => { e.stopPropagation(); hooks.onToggleOrientation(path); });
  rotate.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.append(rotate);
  return el;
}

function buildPane(id: string, split: boolean, focused: boolean, hooks: PaneHooks): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'stage-pane';
  pane.dataset.paneId = id;
  pane.classList.toggle('focused', focused);
  // Capture-phase: xterm swallows bubbling mousedowns inside the terminal.
  pane.addEventListener('mousedown', () => hooks.onFocus(id), true);
  pane.append(hooks.headerFor(id, split));
  const body = document.createElement('div');
  body.className = 'pane-body';
  body.append(hooks.contentFor(id));
  pane.append(body);
  return pane;
}

function buildNode(node: PaneNode, path: number[], multi: boolean, focusedId: string | null, hooks: PaneHooks): HTMLElement {
  if (!isSplit(node)) return buildPane(node, multi, multi && node === focusedId, hooks);
  const el = document.createElement('div');
  el.className = 'stage-split';
  el.dataset.path = pathKey(path);
  node.children.forEach((c, i) => {
    if (i > 0) el.append(buildDivider(node, path, i - 1, hooks));
    el.append(buildNode(c, [...path, i], multi, focusedId, hooks));
  });
  applySplitEl(el, node);
  return el;
}

export function renderStagePanes(grid: HTMLElement, root: PaneNode, focusedId: string | null, hooks: PaneHooks): void {
  grid.replaceChildren();
  const multi = panesOf(root).length > 1;
  grid.append(buildNode(root, [], multi, focusedId, hooks));
}
```

- [ ] **Step 2: CSS**

In `src/web/style.css`, replace the `.stage-grid`/`.stage-grid-column` handling. The current `.stage-grid { position:absolute; inset:0; display:grid; }` block stays; ADD after it:

```css
.stage-grid > .stage-split, .stage-grid > .stage-pane { position: relative; }
.stage-grid { grid-template: 1fr / 1fr; }
.stage-split { display: grid; min-width: 0; min-height: 0; }
```

Remove any `.stage-grid-column` rule if present (orientation now lives per split container; `grep -n 'stage-grid-column' src/web/style.css` and delete the rule plus its toggle usage — the renderer above no longer sets it). Keep `.stage-divider` rules; add a column-cursor variant scoped to splits:

```css
.stage-split-column > .stage-divider { cursor: row-resize; }
```

(Replace the old `.stage-grid-column > .stage-divider` rule with this one.)

Zone classes for Task 4 (add now, in the drop-zones block):

```css
.drop-zone-pane-edge { position: absolute; }
.drop-zone-replace { position: absolute; }
```

(The existing `.drop-zone` base and `.drop-zone-left/right/top/bottom` stage-rim rules stay for stage edges; pane-edge/replace geometry is set inline from pane rects.)

- [ ] **Step 3: Verify typecheck of the two rewritten modules**

Run: `npx vitest run stagePanes stageLayout && npx tsc --noEmit -p . 2>&1 | grep -v 'main.ts' | head -5`
Expected: vitest green; tsc errors confined to `main.ts` (rewired in Task 4).

- [ ] **Step 4: Commit**

```bash
git add src/web/stagePanes.ts src/web/style.css
git commit -m "feat(web): recursive split renderer with path-addressed dividers"
```

(If the repo's hooks run `npm test` on commit and fail on main.ts, squash this commit into Task 4's instead — note it in the Task 4 commit message.)

---

### Task 4: `main.ts` rewiring — tree state, zone overlay, cap 4, stale-zone fix

**Files:**
- Modify: `src/web/main.ts` — state (~line 27–36), `persistStage`, `paneState` reconcile in `pollStatus` (~465), `paneHooks` (~700), `repaintStage` (~740), `dockBox`/`undockBox`, `openPane` (~1355), `closeTab`, `highlightStage` (~1290), dock-button visibility (~1087), chord handler, drag wiring (~872–950)
- Test: `test/e2e/split.spec.ts` — migrate FIRST (failing), Step 1

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: working UI. Key state renames every edit site uses: `stageLayout: StageLayout` → `stageRoot: PaneNode | null`; `stageLayout.panes` → `panesOf(stageRoot)`; `MAX_PANES = 4`.

- [ ] **Step 1: Migrate the e2e spec (failing first)**

In `test/e2e/split.spec.ts`:

1. The dock-button test (line 21): the button's visibility rule widens, no test change needed; keep as-is.
2. Replace the drag-to-dock test's zone assertion (line 65): `.drop-zone-right` → `[data-kind='stage-edge'][data-edge='right']` styled as before — keep the class assertion by giving stage-edge zones BOTH the legacy class and the data attrs (see Step 4), so this line stays `await expect(page.locator('.drop-zone-right')).toBeVisible();`. No change.
3. APPEND the new tests:

```ts
test('sub-partition: stage-bottom drop under a 2-up gives a full-width third pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  const row = page.locator('.box', { hasText: 'untagged-worker' });
  const rowBox = (await row.boundingBox())!;
  const stageBox = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height - 20, { steps: 10 });
  await expect(page.locator('.drop-zone-bottom')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('.stage-pane')).toHaveCount(3);
  const c = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'untagged-worker' }) }).boundingBox())!;
  const a = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'localhost' }) }).boundingBox())!;
  expect(c.width).toBeGreaterThan(stageBox.width * 0.9); // full-width bottom pane
  expect(a.width).toBeLessThan(stageBox.width * 0.6);    // top pair still side-by-side
  expect(c.y).toBeGreaterThan(a.y + a.height - 8);       // and below them

  // Persistence of the tree across reload.
  await page.reload();
  await expect(page.locator('.stage-pane')).toHaveCount(3, { timeout: 10000 });

  // Undock the bottom pane: collapses back to the 2-up.
  await page.getByRole('button', { name: 'Undock untagged-worker' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
});

test('pane-edge drop splits only that pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  const b = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'db-primary' }) }).boundingBox())!;

  const row = page.locator('.box', { hasText: 'untagged-worker' });
  const rowBox = (await row.boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2, { steps: 4 });
  // bottom edge strip of pane B (inset from the stage rim so the stage zone doesn't win)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.82, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator('.stage-pane')).toHaveCount(3);
  const bAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'db-primary' }) }).boundingBox())!;
  const cAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'untagged-worker' }) }).boundingBox())!;
  const aAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'localhost' }) }).boundingBox())!;
  expect(cAfter.width).toBeLessThan(bAfter.width + 8);              // C is inside B's column…
  expect(aAfter.height).toBeGreaterThan(cAfter.height + 8);         // …while A stays full height
});

test('stale-zone regression: a second drag builds zones from the current layout', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();

  // Drag-dock db-primary to the right edge (this used to leave stale zones).
  const row1 = page.locator('.box', { hasText: 'db-primary' });
  const r1 = (await row1.boundingBox())!;
  const stageBox = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(r1.x + r1.width / 2, r1.y + r1.height / 2);
  await page.mouse.down();
  await page.mouse.move(r1.x + r1.width / 2 + 12, r1.y + r1.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width - 30, stageBox.y + stageBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  // Second drag: the zones must include a pane-edge zone for db-primary —
  // impossible with the stale set, which predates db-primary being docked.
  const row2 = page.locator('.box', { hasText: 'untagged-worker' });
  const r2 = (await row2.boundingBox())!;
  await page.mouse.move(r2.x + r2.width / 2, r2.y + r2.height / 2);
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.width / 2 + 12, r2.y + r2.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2, { steps: 10 });
  await expect(page.locator(`[data-kind='pane-edge']`).first()).toBeVisible();
  const zoneCount = await page.locator('.drop-zone').count();
  expect(zoneCount).toBe(4 + 2 * 5); // 4 stage edges + 2 panes × (4 edges + replace)
  await page.mouse.up();
});
```

Run: `npm run build` — expected to FAIL (main.ts doesn't compile against the tree yet). That is the red state; proceed.

- [ ] **Step 2: State + imports**

In `src/web/main.ts`:

```ts
import { type PaneNode, type Edge, type DropSpec, panesOf, movePane, undockPane, replacePane, setRatio, toggleOrientation, serialize, restore } from './stageLayout';
import { renderStagePanes, applyRatios, focusMove, dropTargets, type PaneHooks, type PaneRect } from './stagePanes';
```

State: `let stageLayout: StageLayout = emptyLayout();` → `let stageRoot: PaneNode | null = null;` and `const MAX_PANES = 2;` → `const MAX_PANES = 4; // gesture-layer cap; the model itself is N-capable`.

- [ ] **Step 3: Mechanical call-site migration**

Every former `stageLayout` site, with its new form:

- `persistStage`: `serialize(stageRoot, focusedBoxId)`.
- `pollStatus` reconcile + `repaintStage` pane-state lines: `stageLayout.panes` → `panesOf(stageRoot)`.
- `paneHooks()`:
  - `onRatio: (path, divider, firstShare, phase) => { stageRoot = setRatio(stageRoot, path, divider, firstShare); if (stageRoot != null) applyRatios(stageGrid(), stageRoot); … }` (refit/persist branches unchanged).
  - `onToggleOrientation: (path) => { stageRoot = toggleOrientation(stageRoot, path); repaintStage(); }`.
  - `headerFor` split flag: `panesOf(stageRoot).length > 1`.
- `repaintStage()`: `if (stageRoot == null) { …empty panel branch unchanged… } else { renderStagePanes(grid, stageRoot, focusedBoxId, paneHooks()); }`; `lastPaneStates` from `panesOf(stageRoot)`.
- `dockBox(id: string, edge: Edge)` → `dockBox(id, drop: DropSpec)`: `stageRoot = movePane(stageRoot, id, drop); focusedBoxId = id; repaintStage();`. The sidebar ◫ button calls `dockBox(b.id, { kind: 'stage-edge', edge: 'right' })`; its visibility: `dock.hidden = !(panesOf(stageRoot).length >= 1 && panesOf(stageRoot).length < MAX_PANES && !panesOf(stageRoot).includes(b.id));`.
- `undockBox(id)`: `stageRoot = undockPane(stageRoot, id); if (focusedBoxId === id) focusedBoxId = panesOf(stageRoot)[0] ?? null; repaintStage();`.
- `openPane(id)`: docked → focus (unchanged shape, `panesOf(stageRoot).includes(id)`); else `stageRoot = panesOf(stageRoot).length <= 1 || !focusedBoxId ? (panesOf(stageRoot).length === 0 ? id : replacePane(stageRoot, panesOf(stageRoot)[0], id)) : replacePane(stageRoot, focusedBoxId, id);` — one-pane stage replaces that pane, empty stage becomes the leaf.
- `closeTab` keepPane checks: `panesOf(stageRoot).includes(id)`.
- `highlightStage` docked-row checks: `panesOf(stageRoot)`.
- Chord handler: build rects from the DOM and use spatial focusMove:

```ts
const rects: PaneRect[] = [...stageGrid().querySelectorAll<HTMLElement>('.stage-pane')].map((p) => {
  const r = p.getBoundingClientRect();
  return { id: p.dataset.paneId!, x: r.x, y: r.y, w: r.width, h: r.height };
});
const next = focusMove(rects, focusedBoxId, e.key);
```

- Boot restore: `const { root, focusedId } = restore(savedStage, [...allBoxes.map((b) => b.id), '__local__']); stageRoot = root; focusedBoxId = focusedId;`.

- [ ] **Step 4: Zone overlay + drop handler (the stale-zone fix lives here)**

Replace `buildZones` and the drop handler:

```ts
const buildZones = (draggedId: string) => {
  zones.replaceChildren();
  const host = stage.getBoundingClientRect();
  const paneRect = (paneId: string) => stageGrid().querySelector<HTMLElement>(`.stage-pane[data-pane-id='${paneId}']`)?.getBoundingClientRect();
  for (const t of dropTargets(stageRoot, draggedId, MAX_PANES)) {
    const z = document.createElement('div');
    if (t.kind === 'stage-edge') {
      z.className = `drop-zone drop-zone-${t.edge}`;
      z.dataset.kind = 'stage-edge';
      z.dataset.edge = t.edge;
    } else {
      const rect = paneRect(t.paneId);
      if (!rect) continue;
      const rel = { left: rect.left - host.left, top: rect.top - host.top };
      if (t.kind === 'pane-edge') {
        z.className = 'drop-zone drop-zone-pane-edge';
        z.dataset.kind = 'pane-edge';
        z.dataset.edge = t.edge;
        z.dataset.paneId = t.paneId;
        // Edge strips: outer 26% of the pane on that side, inset 8px from the
        // stage rim so the stage-edge zones keep a clean claim on the rim.
        const d = 0.26;
        if (t.edge === 'left' || t.edge === 'right') {
          z.style.top = `${rel.top + 8}px`; z.style.height = `${rect.height - 16}px`;
          z.style.width = `${rect.width * d}px`;
          z.style.left = t.edge === 'left' ? `${rel.left + 8}px` : `${rel.left + rect.width * (1 - d) - 8}px`;
        } else {
          z.style.left = `${rel.left + 8}px`; z.style.width = `${rect.width - 16}px`;
          z.style.height = `${rect.height * d}px`;
          z.style.top = t.edge === 'top' ? `${rel.top + 8}px` : `${rel.top + rect.height * (1 - d) - 8}px`;
        }
      } else {
        z.className = 'drop-zone drop-zone-replace';
        z.dataset.kind = 'replace';
        z.dataset.paneId = t.paneId;
        z.style.left = `${rel.left + rect.width * 0.34}px`;
        z.style.width = `${rect.width * 0.32}px`;
        z.style.top = `${rel.top + rect.height * 0.34}px`;
        z.style.height = `${rect.height * 0.32}px`;
      }
    }
    zones.append(z);
  }
};
```

Zone stacking: append order puts replace after pane-edge after stage-edge; give `.drop-zone-replace { z-index: 33; } .drop-zone-pane-edge { z-index: 32; }` in the CSS block from Task 3 so `elementFromPoint` resolves overlap by intent (center beats edge beats rim).

Drop handler:

```ts
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-zone') as HTMLElement | null;
  stage.classList.remove('dragging');
  const id = e.dataTransfer?.getData('text/x-tmuxifier-box');
  // Clear drag state HERE: a successful dock repaints the sidebar, destroying
  // the drag's source row, so its dragend never fires — trusting dragend is
  // exactly the stale-zone cap-bypass bug (v1.16.0).
  zones.replaceChildren();
  dragSourceId = null;
  if (!id || !zone) return;
  const kind = zone.dataset.kind;
  if (kind === 'stage-edge') {
    dockBox(id, { kind: 'stage-edge', edge: zone.dataset.edge as Edge });
  } else if (kind === 'pane-edge') {
    dockBox(id, { kind: 'pane-edge', paneId: zone.dataset.paneId!, edge: zone.dataset.edge as Edge });
  } else if (kind === 'replace') {
    const target = zone.dataset.paneId!;
    if (target !== id) {
      stageRoot = replacePane(stageRoot, target, id);
      focusedBoxId = id;
      repaintStage();
    }
  }
});
```

The document-level `dragend` listener stays (cancelled drags still need cleanup).

- [ ] **Step 5: Verify — unit, build, full e2e**

Run: `npm test` → typecheck + 1374+ unit tests green.
Run: `npm run build && npx playwright test` → all e2e green including the three new tests.

- [ ] **Step 6: Commit**

```bash
git add src/web/main.ts test/e2e/split.spec.ts src/web/style.css
git commit -m "feat(web): nested stage splits — tree state, pane-edge drops, cap 4, stale-zone fix"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md` (Split terminals section), `CLAUDE.md` + `AGENTS.md` (stageLayout/stagePanes inventory entries)

- [ ] **Step 1: README**

In the "## Split terminals" section: replace "Two boxes can share the stage." with "Up to four boxes can share the stage, and splits nest."; after the drag-gesture sentence add: "Dropping on the stage's outer edge splits the whole stage (a full-width or full-height pane); dropping near an individual pane's edge splits just that pane; dropping on a pane's center replaces it. `Ctrl+Shift+Arrow` moves focus to the geometrically adjacent pane."

- [ ] **Step 2: CLAUDE.md + AGENTS.md (identical edits)**

Update the `stageLayout.ts` entry: "the pure, N-capable stage pane model" becomes "the pure split-tree stage model — a node is a box-id leaf or a split (orientation/children/ratios) in canonical form (splits ≥2 children, no same-orientation nesting), with stage-edge/pane-edge dock, move, undock-collapse, path-addressed setRatio/toggleOrientation, and v2 serialize/restore with v1 migration and vanished-box pruning; the four-pane cap is main.ts's `MAX_PANES`, not the model's". Update the `stagePanes.ts` entry: "WAI-ARIA splitter dividers, and drop targets" becomes "recursive `.stage-split` renderer with path-addressed WAI-ARIA splitter dividers, typed drop targets (stage-edge/pane-edge/replace), and spatial `focusMove`".

- [ ] **Step 3: Full suites once more, commit**

Run: `npm test && npm run build && npx playwright test`

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: nested splits — model and gesture documentation"
```
