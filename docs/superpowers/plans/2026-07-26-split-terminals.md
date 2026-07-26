# Split Terminals (Stage Panes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dock two box terminals side by side (or stacked) on the stage so the operator can watch/work in both without switching.

**Architecture:** A pure, N-capable layout model (`stageLayout.ts`) describes which boxes occupy the stage; a DOM renderer (`stagePanes.ts`) paints it as a CSS grid with ARIA-splitter dividers; `main.ts` replaces its single `activeBoxId` stage model with the layout + a `focusedBoxId`. The existing `tabs` Map (terminals stay mounted and connected even when hidden) is reused unchanged — undocked tabs park in a hidden div exactly as `display:none` tabs do today. No server changes.

**Tech Stack:** TypeScript (web client), vitest (imports `.ts` directly), Playwright e2e, plain CSS in `src/web/style.css`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-split-terminal-design.md`

## Global Constraints

- **No server changes.** Everything in this plan lives under `src/web/`, `test/`, and docs.
- **No new dependencies** (runtime or dev). DOM behavior not coverable by pure functions is covered by the Playwright e2e task, not by adding a DOM test lib.
- **`MAX_PANES = 2` lives in `main.ts` (gesture layer) only.** `stageLayout.ts` must never reference a pane cap.
- localStorage key: exactly `tmuxifier.stageLayout` (naming matches `tmuxifier.sidebarCollapsed`).
- Every pointer gesture has a keyboard path: dock button on box rows, arrow keys on the divider (`role="separator"`), `Ctrl+Shift+Arrow` focus chord.
- Design tokens (DESIGN.md): interactive cyan washes only from the ladder `rgba(36,211,232, 0.05 | 0.12 | 0.22 | 0.45 | 0.65)`; pane nameplate uses the HUD register (10.5px, 600, uppercase, 0.09em tracking, `var(--muted)`); no new animations.
- House style: ESM, client is TS, tests are real-code-no-mocks, conventional-commit messages, comments state constraints not narration.
- Run `npm test` (typecheck + vitest) before every commit; it must be green.

---

### Task 1: stageLayout model — core transitions

**Files:**
- Create: `src/web/stageLayout.ts`
- Test: `test/stageLayout.test.js`

**Interfaces:**
- Produces (later tasks import these exact names from `./stageLayout`):
  `type Orientation = 'row' | 'column'`, `type Edge = 'left' | 'right' | 'top' | 'bottom'`,
  `interface StageLayout { orientation: Orientation; panes: string[]; ratios: number[] }`,
  `MIN_RATIO = 0.2`, `emptyLayout(): StageLayout`, `singleLayout(id: string): StageLayout`,
  `dockPane(layout, boxId, edge): StageLayout`, `undockPane(layout, boxId): StageLayout`.

- [ ] **Step 1: Write the failing test**

```js
import { test, expect } from 'vitest';
import { emptyLayout, singleLayout, dockPane, undockPane } from '../src/web/stageLayout.ts';

test('emptyLayout and singleLayout are the degenerate cases', () => {
  expect(emptyLayout()).toEqual({ orientation: 'row', panes: [], ratios: [] });
  expect(singleLayout('a')).toEqual({ orientation: 'row', panes: ['a'], ratios: [1] });
});

test('docking on a horizontal edge makes a row split; the edge picks the position', () => {
  const l = singleLayout('a');
  expect(dockPane(l, 'b', 'right')).toEqual({ orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] });
  expect(dockPane(l, 'b', 'left')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking on a vertical edge makes a column split', () => {
  const l = singleLayout('a');
  expect(dockPane(l, 'b', 'bottom')).toEqual({ orientation: 'column', panes: ['a', 'b'], ratios: [0.5, 0.5] });
  expect(dockPane(l, 'b', 'top')).toEqual({ orientation: 'column', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking an already-docked box moves it instead of duplicating', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] };
  expect(dockPane(l, 'a', 'right')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking onto the empty stage yields a single pane', () => {
  expect(dockPane(emptyLayout(), 'a', 'left')).toEqual({ orientation: 'row', panes: ['a'], ratios: [1] });
});

test('undocking removes the pane and re-evens the rest; unknown id is a no-op', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(undockPane(l, 'a')).toEqual({ orientation: 'row', panes: ['b'], ratios: [1] });
  expect(undockPane(l, 'zz')).toEqual(l);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stageLayout.test.js`
Expected: FAIL — `Cannot find module '../src/web/stageLayout.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// Pure stage-layout model: which boxes occupy the stage, in what orientation,
// at what ratios. N-capable by construction — the two-pane cap is a gesture-
// layer rule in main.ts (MAX_PANES), never enforced here.
export type Orientation = 'row' | 'column';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface StageLayout {
  orientation: Orientation;
  panes: string[];   // boxIds in visual order ('__local__' allowed)
  ratios: number[];  // parallel to panes; sums to 1
}

export const MIN_RATIO = 0.2;

const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

export function emptyLayout(): StageLayout { return { orientation: 'row', panes: [], ratios: [] }; }
export function singleLayout(id: string): StageLayout { return { orientation: 'row', panes: [id], ratios: [1] }; }

export function dockPane(layout: StageLayout, boxId: string, edge: Edge): StageLayout {
  const rest = layout.panes.filter((p) => p !== boxId);
  const orientation: Orientation = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const panes = edge === 'left' || edge === 'top' ? [boxId, ...rest] : [...rest, boxId];
  return { orientation, panes, ratios: even(panes.length) };
}

export function undockPane(layout: StageLayout, boxId: string): StageLayout {
  if (!layout.panes.includes(boxId)) return layout;
  const panes = layout.panes.filter((p) => p !== boxId);
  return { ...layout, panes, ratios: even(panes.length) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stageLayout.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/stageLayout.ts test/stageLayout.test.js
git commit -m "feat(web): stage-layout model core (dock/undock)"
```

---

### Task 2: stageLayout model — replace, swap, ratio, orientation

**Files:**
- Modify: `src/web/stageLayout.ts`
- Test: `test/stageLayout.test.js` (append)

**Interfaces:**
- Produces: `replacePane(layout, oldId, newId)`, `swapPanes(layout, a, b)`,
  `setRatio(layout, divider: number, firstShare: number)` — divider `i` sits between panes `i` and `i+1`; `firstShare` is pane `i`'s share (0..1) of the pair's combined ratio — and `toggleOrientation(layout)`.

- [ ] **Step 1: Append the failing tests**

```js
import { replacePane, swapPanes, setRatio, toggleOrientation, MIN_RATIO } from '../src/web/stageLayout.ts';

const split = () => ({ orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] });

test('replacePane substitutes in place; replacing with a docked box swaps instead', () => {
  expect(replacePane(split(), 'a', 'c').panes).toEqual(['c', 'b']);
  expect(replacePane(split(), 'a', 'b').panes).toEqual(['b', 'a']);
  expect(replacePane(split(), 'zz', 'c')).toEqual(split());
});

test('swapPanes exchanges positions and keeps ratios by position', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(swapPanes(l, 'a', 'b')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.7, 0.3] });
  expect(swapPanes(l, 'a', 'zz')).toEqual(l);
});

test('setRatio moves the divider and clamps both sides at MIN_RATIO', () => {
  expect(setRatio(split(), 0, 0.7).ratios).toEqual([0.7, 0.3]);
  expect(setRatio(split(), 0, 0.05).ratios).toEqual([MIN_RATIO, 1 - MIN_RATIO]);
  expect(setRatio(split(), 0, 0.99).ratios).toEqual([1 - MIN_RATIO, MIN_RATIO]);
  expect(setRatio(split(), 5, 0.7)).toEqual(split()); // no such divider: no-op
});

test('toggleOrientation flips row/column and nothing else', () => {
  expect(toggleOrientation(split()).orientation).toBe('column');
  expect(toggleOrientation(toggleOrientation(split()))).toEqual(split());
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/stageLayout.test.js`
Expected: FAIL — `replacePane is not a function` (or equivalent import error)

- [ ] **Step 3: Implement**

```ts
export function replacePane(layout: StageLayout, oldId: string, newId: string): StageLayout {
  if (!layout.panes.includes(oldId)) return layout;
  if (layout.panes.includes(newId)) return swapPanes(layout, oldId, newId);
  return { ...layout, panes: layout.panes.map((p) => (p === oldId ? newId : p)) };
}

export function swapPanes(layout: StageLayout, a: string, b: string): StageLayout {
  const i = layout.panes.indexOf(a);
  const j = layout.panes.indexOf(b);
  if (i === -1 || j === -1 || i === j) return layout;
  const panes = [...layout.panes];
  [panes[i], panes[j]] = [panes[j], panes[i]];
  return { ...layout, panes };
}

// Divider `divider` sits between panes divider and divider+1. firstShare is the
// first pane's share of the pair's combined ratio (what a pointer position or
// aria-valuenow naturally produces). Both sides clamp at MIN_RATIO of the stage.
export function setRatio(layout: StageLayout, divider: number, firstShare: number): StageLayout {
  const j = divider + 1;
  if (divider < 0 || j >= layout.panes.length) return layout;
  const pair = layout.ratios[divider] + layout.ratios[j];
  const first = Math.min(pair - MIN_RATIO, Math.max(MIN_RATIO, firstShare * pair));
  const ratios = [...layout.ratios];
  ratios[divider] = first;
  ratios[j] = pair - first;
  return { ...layout, ratios };
}

export function toggleOrientation(layout: StageLayout): StageLayout {
  return { ...layout, orientation: layout.orientation === 'row' ? 'column' : 'row' };
}
```

- [ ] **Step 4: Run tests, expect PASS.** `npx vitest run test/stageLayout.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/web/stageLayout.ts test/stageLayout.test.js
git commit -m "feat(web): stage-layout replace/swap/ratio/orientation"
```

---

### Task 3: stageLayout model — serialize and restore

**Files:**
- Modify: `src/web/stageLayout.ts`
- Test: `test/stageLayout.test.js` (append)

**Interfaces:**
- Produces: `serialize(layout, focusedId: string | null): string` and
  `restore(raw: string | null, knownIds: string[]): { layout: StageLayout; focusedId: string | null }`.

- [ ] **Step 1: Append the failing tests**

```js
import { serialize, restore, emptyLayout } from '../src/web/stageLayout.ts';

test('serialize/restore round-trips a split, ratios and focus included', () => {
  const l = { orientation: 'column', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(restore(serialize(l, 'b'), ['a', 'b', 'c'])).toEqual({ layout: l, focusedId: 'b' });
});

test('restore prunes vanished boxes, re-evens ratios, and moves focus to the first survivor', () => {
  const l = { orientation: 'row', panes: ['a', 'gone'], ratios: [0.7, 0.3] };
  expect(restore(serialize(l, 'gone'), ['a'])).toEqual({
    layout: { orientation: 'row', panes: ['a'], ratios: [1] },
    focusedId: 'a',
  });
});

test('restore falls back to the empty layout on null, garbage, or wrong shape', () => {
  const fallback = { layout: emptyLayout(), focusedId: null };
  expect(restore(null, ['a'])).toEqual(fallback);
  expect(restore('not json', ['a'])).toEqual(fallback);
  expect(restore(JSON.stringify({ v: 99 }), ['a'])).toEqual(fallback);
  expect(restore(JSON.stringify({ v: 1, layout: { panes: 'nope' } }), ['a'])).toEqual(fallback);
});

test('restore rejects corrupt ratios by re-evening them', () => {
  const raw = JSON.stringify({ v: 1, layout: { orientation: 'row', panes: ['a', 'b'], ratios: [2, -1] }, focusedId: 'a' });
  expect(restore(raw, ['a', 'b']).layout.ratios).toEqual([0.5, 0.5]);
});
```

- [ ] **Step 2: Run to verify the new tests fail.** `npx vitest run test/stageLayout.test.js`

- [ ] **Step 3: Implement**

```ts
export function serialize(layout: StageLayout, focusedId: string | null): string {
  return JSON.stringify({ v: 1, layout, focusedId });
}

// Ratios survive only when every persisted pane survived (a prune changes the
// geometry, so evens are honest) and the numbers are sane; otherwise re-even.
export function restore(raw: string | null, knownIds: string[]): { layout: StageLayout; focusedId: string | null } {
  const fallback = { layout: emptyLayout(), focusedId: null };
  if (!raw) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  const p = parsed as { v?: unknown; layout?: Partial<StageLayout>; focusedId?: unknown };
  if (p?.v !== 1 || !p.layout || !Array.isArray(p.layout.panes)) return fallback;
  const known = new Set(knownIds);
  const persisted = p.layout.panes.filter((id): id is string => typeof id === 'string');
  const panes = persisted.filter((id) => known.has(id));
  const orientation: Orientation = p.layout.orientation === 'column' ? 'column' : 'row';
  const r = p.layout.ratios;
  const ratiosSane = Array.isArray(r) && r.length === panes.length && panes.length === persisted.length
    && r.every((x) => typeof x === 'number' && x >= MIN_RATIO - 0.001)
    && Math.abs(r.reduce((a, b) => a + b, 0) - 1) < 0.01;
  const ratios = ratiosSane ? (r as number[]) : Array.from({ length: panes.length }, () => 1 / (panes.length || 1)).slice(0, panes.length);
  const focusedId = typeof p.focusedId === 'string' && panes.includes(p.focusedId) ? p.focusedId : panes[0] ?? null;
  return { layout: { orientation, panes, ratios }, focusedId };
}
```

- [ ] **Step 4: Run tests, expect PASS.** `npx vitest run test/stageLayout.test.js`

- [ ] **Step 5: Run the whole suite and commit**

```bash
npm test
git add src/web/stageLayout.ts test/stageLayout.test.js
git commit -m "feat(web): stage-layout serialize/restore with pruning"
```

---

### Task 4: stagePanes pure helpers (grid template, divider ARIA, keyboard, drop targets, focus move)

**Files:**
- Create: `src/web/stagePanes.ts` (pure helpers only in this task)
- Test: `test/stagePanes.test.js`

**Interfaces:**
- Consumes: `StageLayout`, `Edge` from `./stageLayout`.
- Produces: `DIVIDER_PX = 6`, `gridTemplate(layout): string`,
  `dividerAria(layout, divider): { orientation: 'vertical' | 'horizontal'; valuenow: number }`,
  `keyboardRatioStep(layout, divider, key): number | null` (new firstShare or null),
  `type DropTarget = { kind: 'edge'; edge: Edge } | { kind: 'pane'; index: number }`,
  `dropTargets(layout, draggedId, maxPanes): DropTarget[]`,
  `focusMove(layout, focusedId, key): string | null`.

- [ ] **Step 1: Write the failing test**

```js
import { test, expect } from 'vitest';
import { gridTemplate, dividerAria, keyboardRatioStep, dropTargets, focusMove, DIVIDER_PX } from '../src/web/stagePanes.ts';

const split = (ratios = [0.5, 0.5], orientation = 'row') => ({ orientation, panes: ['a', 'b'], ratios });

test('gridTemplate interleaves fr tracks with fixed dividers', () => {
  expect(gridTemplate(split([0.7, 0.3]))).toBe(`0.7fr ${DIVIDER_PX}px 0.3fr`);
  expect(gridTemplate({ orientation: 'row', panes: ['a'], ratios: [1] })).toBe('1fr');
});

test('dividerAria reports splitter orientation and percentage', () => {
  expect(dividerAria(split([0.7, 0.3]), 0)).toEqual({ orientation: 'vertical', valuenow: 70 });
  expect(dividerAria(split([0.5, 0.5], 'column'), 0)).toEqual({ orientation: 'horizontal', valuenow: 50 });
});

test('keyboardRatioStep grows/shrinks by 5% along the split axis only', () => {
  expect(keyboardRatioStep(split(), 0, 'ArrowRight')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(split(), 0, 'ArrowLeft')).toBeCloseTo(0.45);
  expect(keyboardRatioStep(split(), 0, 'ArrowDown')).toBeNull();
  expect(keyboardRatioStep(split([0.5, 0.5], 'column'), 0, 'ArrowDown')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(split(), 0, 'Enter')).toBeNull();
});

test('dropTargets: edges gated by the cap, pane targets exclude the dragged box', () => {
  const single = { orientation: 'row', panes: ['a'], ratios: [1] };
  expect(dropTargets(single, 'b', 2)).toEqual([
    { kind: 'edge', edge: 'left' }, { kind: 'edge', edge: 'right' },
    { kind: 'edge', edge: 'top' }, { kind: 'edge', edge: 'bottom' },
    { kind: 'pane', index: 0 },
  ]);
  // full stage, foreign box: replace-only (no edges)
  expect(dropTargets(split(), 'c', 2)).toEqual([{ kind: 'pane', index: 0 }, { kind: 'pane', index: 1 }]);
  // full stage, docked box: edges (move) + the other pane (swap)
  expect(dropTargets(split(), 'a', 2)).toEqual([
    { kind: 'edge', edge: 'left' }, { kind: 'edge', edge: 'right' },
    { kind: 'edge', edge: 'top' }, { kind: 'edge', edge: 'bottom' },
    { kind: 'pane', index: 1 },
  ]);
});

test('focusMove walks panes along the split axis and returns null at the rim', () => {
  expect(focusMove(split(), 'a', 'ArrowRight')).toBe('b');
  expect(focusMove(split(), 'b', 'ArrowRight')).toBeNull();
  expect(focusMove(split(), 'b', 'ArrowLeft')).toBe('a');
  expect(focusMove(split([0.5, 0.5], 'column'), 'a', 'ArrowDown')).toBe('b');
  expect(focusMove({ orientation: 'row', panes: ['a'], ratios: [1] }, 'a', 'ArrowRight')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run test/stagePanes.test.js` — FAIL (module missing)

- [ ] **Step 3: Implement (top of the new `src/web/stagePanes.ts`)**

```ts
// Stage-pane rendering: pure geometry/ARIA helpers (unit-tested) plus the DOM
// renderer (Task 5, covered by e2e). Never imports main.ts — everything the
// renderer needs arrives via PaneHooks.
import { type StageLayout, type Edge } from './stageLayout';

export const DIVIDER_PX = 6;

export function gridTemplate(layout: StageLayout): string {
  return layout.ratios.map((r) => `${r}fr`).join(` ${DIVIDER_PX}px `);
}

export function dividerAria(layout: StageLayout, divider: number): { orientation: 'vertical' | 'horizontal'; valuenow: number } {
  const pair = layout.ratios[divider] + layout.ratios[divider + 1];
  return {
    orientation: layout.orientation === 'row' ? 'vertical' : 'horizontal',
    valuenow: Math.round((layout.ratios[divider] / pair) * 100),
  };
}

export function keyboardRatioStep(layout: StageLayout, divider: number, key: string): number | null {
  const grow = layout.orientation === 'row' ? 'ArrowRight' : 'ArrowDown';
  const shrink = layout.orientation === 'row' ? 'ArrowLeft' : 'ArrowUp';
  if (key !== grow && key !== shrink) return null;
  const { valuenow } = dividerAria(layout, divider);
  return (valuenow + (key === grow ? 5 : -5)) / 100;
}

export type DropTarget = { kind: 'edge'; edge: Edge } | { kind: 'pane'; index: number };

export function dropTargets(layout: StageLayout, draggedId: string, maxPanes: number): DropTarget[] {
  const docked = layout.panes.includes(draggedId);
  const edges: Edge[] = docked || layout.panes.length < maxPanes ? ['left', 'right', 'top', 'bottom'] : [];
  const panes = layout.panes
    .map((id, index) => ({ kind: 'pane' as const, index }))
    .filter((t) => layout.panes[t.index] !== draggedId);
  return [...edges.map((edge) => ({ kind: 'edge' as const, edge })), ...panes];
}

export function focusMove(layout: StageLayout, focusedId: string | null, key: string): string | null {
  if (layout.panes.length < 2 || !focusedId) return null;
  const next = layout.orientation === 'row' ? 'ArrowRight' : 'ArrowDown';
  const prev = layout.orientation === 'row' ? 'ArrowLeft' : 'ArrowUp';
  const i = layout.panes.indexOf(focusedId);
  if (i === -1) return null;
  if (key === next && i < layout.panes.length - 1) return layout.panes[i + 1];
  if (key === prev && i > 0) return layout.panes[i - 1];
  return null;
}
```

- [ ] **Step 4: Run tests, expect PASS.** `npx vitest run test/stagePanes.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/web/stagePanes.ts test/stagePanes.test.js
git commit -m "feat(web): stage-pane geometry/aria/drop-target helpers"
```

---

### Task 5: stagePanes DOM renderer + CSS

**Files:**
- Modify: `src/web/stagePanes.ts` (append renderer)
- Modify: `src/web/style.css` (append a `/* --- Stage panes (split terminals) --- */` block after the `.stage` rules, near line 351)

**Interfaces:**
- Produces:

```ts
export interface PaneHooks {
  contentFor(id: string): HTMLElement;   // terminal el OR stopped/setting-up panel el
  labelFor(id: string): string;
  onFocus(id: string): void;
  onUndock(id: string): void;
  onRatio(divider: number, firstShare: number, phase: 'drag' | 'commit'): void;
  onToggleOrientation(): void;
}
export function renderStagePanes(grid: HTMLElement, layout: StageLayout, focusedId: string | null, hooks: PaneHooks): void;
export function applyRatios(grid: HTMLElement, layout: StageLayout): void; // cheap ratio-only update mid-drag
```

- Consumed by Task 6's `repaintStage()`.

**No unit test for this task** (Global Constraints: DOM behavior rides the e2e task). The gate is `npm run typecheck` + the existing suite staying green; behavior is exercised in Task 10.

- [ ] **Step 1: Append the renderer to `src/web/stagePanes.ts`**

```ts
export interface PaneHooks {
  contentFor(id: string): HTMLElement;
  labelFor(id: string): string;
  onFocus(id: string): void;
  onUndock(id: string): void;
  onRatio(divider: number, firstShare: number, phase: 'drag' | 'commit'): void;
  onToggleOrientation(): void;
}

export function applyRatios(grid: HTMLElement, layout: StageLayout): void {
  if (layout.orientation === 'row') {
    grid.style.gridTemplateColumns = gridTemplate(layout);
    grid.style.gridTemplateRows = '';
  } else {
    grid.style.gridTemplateRows = gridTemplate(layout);
    grid.style.gridTemplateColumns = '';
  }
  grid.querySelectorAll<HTMLElement>('.stage-divider').forEach((d, i) => {
    d.setAttribute('aria-valuenow', String(dividerAria(layout, i).valuenow));
  });
}

function buildDivider(layout: StageLayout, divider: number, grid: HTMLElement, hooks: PaneHooks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stage-divider';
  const aria = dividerAria(layout, divider);
  el.setAttribute('role', 'separator');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-orientation', aria.orientation);
  el.setAttribute('aria-label', 'Resize split');
  el.setAttribute('aria-valuemin', '20');
  el.setAttribute('aria-valuemax', '80');
  el.setAttribute('aria-valuenow', String(aria.valuenow));

  el.addEventListener('keydown', (e) => {
    const current = Number(el.getAttribute('aria-valuenow')) / 100;
    const live: StageLayout = { ...layout, ratios: [...layout.ratios] };
    live.ratios[divider] = current; live.ratios[divider + 1] = 1 - current; // 2-pane fast path; N uses stored layout
    const share = keyboardRatioStep(live, divider, e.key);
    if (share == null) return;
    e.preventDefault();
    hooks.onRatio(divider, share, 'commit');
  });
  el.addEventListener('dblclick', () => hooks.onRatio(divider, 0.5, 'commit'));

  // Pointer drag: firstShare = pointer position across the two adjacent panes.
  el.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    el.setPointerCapture(down.pointerId);
    const prev = el.previousElementSibling as HTMLElement;
    const next = el.nextElementSibling as HTMLElement;
    const move = (ev: PointerEvent) => {
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      const share = layout.orientation === 'row'
        ? (ev.clientX - a.left) / (b.right - a.left)
        : (ev.clientY - a.top) / (b.bottom - a.top);
      hooks.onRatio(divider, share, 'drag');
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      const share = layout.orientation === 'row'
        ? (ev.clientX - a.left) / (b.right - a.left)
        : (ev.clientY - a.top) / (b.bottom - a.top);
      hooks.onRatio(divider, share, 'commit');
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
  rotate.addEventListener('click', (e) => { e.stopPropagation(); hooks.onToggleOrientation(); });
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
  if (split) {
    const plate = document.createElement('div');
    plate.className = 'pane-nameplate';
    plate.textContent = hooks.labelFor(id);
    const undock = document.createElement('button');
    undock.type = 'button';
    undock.className = 'pane-undock';
    undock.title = 'Undock';
    undock.setAttribute('aria-label', `Undock ${hooks.labelFor(id)}`);
    undock.textContent = '✕';
    undock.addEventListener('click', () => hooks.onUndock(id));
    pane.append(plate, undock);
  }
  pane.append(hooks.contentFor(id));
  return pane;
}

export function renderStagePanes(grid: HTMLElement, layout: StageLayout, focusedId: string | null, hooks: PaneHooks): void {
  grid.classList.toggle('stage-grid-column', layout.orientation === 'column');
  grid.replaceChildren();
  const split = layout.panes.length > 1;
  layout.panes.forEach((id, i) => {
    if (i > 0) grid.append(buildDivider(layout, i - 1, grid, hooks));
    grid.append(buildPane(id, split, split && id === focusedId, hooks));
  });
  applyRatios(grid, layout);
}
```

- [ ] **Step 2: Append the CSS block to `src/web/style.css`** (after the `.empty-kbd` rules)

```css
/* --- Stage panes (split terminals) --- */
/* The grid owns the stage rectangle; undocked tabs park unseen (same contract
   as the old display:none toggling — terminals stay live while parked). */
.stage-grid { position: absolute; inset: 0; display: grid; }
.stage-parking { display: none; }
.stage-pane { position: relative; overflow: hidden; min-width: 0; min-height: 0; border: 1px solid transparent; }
.stage-pane.focused { border-color: rgba(36, 211, 232, 0.45); }
/* HUD-register nameplate: which box is this pane. Dim when unfocused. */
.pane-nameplate {
  position: absolute; top: 8px; left: 12px; z-index: 5;
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--muted); opacity: 0.4; pointer-events: none;
}
.stage-pane.focused .pane-nameplate { opacity: 1; }
/* Undock sits left of the voice button (right: 12px) in the same corner idiom. */
.pane-undock {
  position: absolute; top: 6px; right: 44px; z-index: 5;
  font: inherit; font-size: 12px; padding: 2px 8px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--panel-2); color: var(--text);
  cursor: pointer; opacity: 0;
}
.stage-pane:hover .pane-undock, .pane-undock:focus-visible { opacity: 0.55; }
.pane-undock:hover { opacity: 1; }
.stage-divider { position: relative; background: var(--panel-2); cursor: col-resize; touch-action: none; }
.stage-grid-column > .stage-divider { cursor: row-resize; }
.stage-divider:hover, .stage-divider:focus-visible { background: rgba(36, 211, 232, 0.22); }
.divider-rotate {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 6;
  width: 20px; height: 20px; padding: 0; border-radius: 4px;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  cursor: pointer; font-size: 12px; line-height: 1; opacity: 0;
}
.stage-divider:hover .divider-rotate, .stage-divider:focus-visible .divider-rotate, .divider-rotate:focus-visible { opacity: 1; }
/* Drop zones: shown only while a box row is dragged over the stage. */
.drop-zones { position: absolute; inset: 0; z-index: 30; display: none; }
.stage.dragging .drop-zones { display: block; }
.drop-zone { position: absolute; border: 1px dashed rgba(36, 211, 232, 0.45); border-radius: 8px; background: rgba(36, 211, 232, 0.05); }
.drop-zone.hover { background: rgba(36, 211, 232, 0.12); }
.drop-zone-left { left: 4px; top: 4px; bottom: 4px; width: 22%; }
.drop-zone-right { right: 4px; top: 4px; bottom: 4px; width: 22%; }
.drop-zone-top { top: 4px; left: 26%; right: 26%; height: 22%; }
.drop-zone-bottom { bottom: 4px; left: 26%; right: 26%; height: 22%; }
.drop-zone-pane { top: 30%; bottom: 30%; }
```

- [ ] **Step 3: Verify.** Run: `npm test` — typecheck + full suite must pass (nothing consumes the renderer yet).

- [ ] **Step 4: Commit**

```bash
git add src/web/stagePanes.ts src/web/style.css
git commit -m "feat(web): stage-pane DOM renderer, dividers, and pane CSS"
```

---

### Task 6: main.ts migration — layout model drives the stage (single-pane parity)

This task rewires the stage plumbing with **no visible behavior change**: after it, the app still shows one thing at a time, but through the layout model. The existing suite green + a manual smoke is the gate.

**Files:**
- Modify: `src/web/main.ts` —
  state at ~line 30 (`activeBoxId`), `renderDashboard` stage markup (~line 660), `openLocalShell` (~925), `showSettingUpBox` (~987), `showStoppedBox` (~1033), `openBox` (~1062), `closeTab` (~1096), `pollStatus` reconcile (~448–462), logout teardown (~609), `refitActiveTerminals` (~278).

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces (later tasks call these):
  `stageLayout: StageLayout` and `focusedBoxId: string | null` (module state),
  `repaintStage(): void`, `persistStage(): void`, `ensureTab(id: string): void`,
  `dockBox(id: string, edge: Edge): void`, `undockBox(id: string): void`,
  `STAGE_LAYOUT_KEY = 'tmuxifier.stageLayout'`, `MAX_PANES = 2`.
  `openBox(b: Box, opts?)` keeps its signature (Proxmox hub passes it as a callback).

- [ ] **Step 1: Add imports and module state** (replace `let activeBoxId: string | null = null;` at line 30)

```ts
import { type StageLayout, type Edge, emptyLayout, singleLayout, dockPane, undockPane, replacePane, setRatio, toggleOrientation, serialize, restore } from './stageLayout';
import { renderStagePanes, applyRatios, focusMove, type PaneHooks } from './stagePanes';

const STAGE_LAYOUT_KEY = 'tmuxifier.stageLayout';
const MAX_PANES = 2; // gesture-layer cap; the model itself is N-capable
let stageLayout: StageLayout = emptyLayout();
let focusedBoxId: string | null = null;
```

Then mechanically update every remaining `activeBoxId` read: it means "the focused pane" (`focusedBoxId`) where the code asks *where am I typing / which row is highlighted*, and "is on stage" (`stageLayout.panes.includes(id)`) where the code asks *is this box showing*. The compiler finds every site (`npm run typecheck`); the notable ones are rewritten in the steps below.

- [ ] **Step 2: New stage plumbing** (add after `emptyStagePanel()`, ~line 570)

```ts
function persistStage() {
  localStorage.setItem(STAGE_LAYOUT_KEY, serialize(stageLayout, focusedBoxId));
}

// Terminals are created into the parking div and MOVED into panes by the
// renderer; undocked tabs return to parking. Parking is display:none — the
// same keep-alive contract as the old display:none tab toggling.
function stageGrid(): HTMLElement { return app.querySelector('.stage-grid') as HTMLElement; }
function stageParking(): HTMLElement { return app.querySelector('.stage-parking') as HTMLElement; }

function ensureTab(id: string) {
  if (tabs.has(id)) return;
  const el = document.createElement('div');
  el.className = 'term';
  stageParking().appendChild(el);
  const box = allBoxes.find((b) => b.id === id);
  const term = openTerminal(el, id, id === '__local__' ? 'local shell' : box?.label);
  tabs.set(id, { el, term });
  if (id === '__local__') updateLocalDot();
}

function paneHooks(): PaneHooks {
  return {
    contentFor: (id) => paneContentFor(id),
    labelFor: (id) => (id === '__local__' ? 'Host Shell' : allBoxes.find((b) => b.id === id)?.label ?? id),
    onFocus: (id) => { if (focusedBoxId !== id) { focusedBoxId = id; syncPaneFocus(); persistStage(); } },
    onUndock: (id) => undockBox(id),
    onRatio: (divider, firstShare, phase) => {
      stageLayout = setRatio(stageLayout, divider, firstShare);
      applyRatios(stageGrid(), stageLayout);
      if (phase === 'commit') { refitActiveTerminals(); persistStage(); }
      else requestAnimationFrame(refitActiveTerminals);
    },
    onToggleOrientation: () => { stageLayout = toggleOrientation(stageLayout); repaintStage(); },
  };
}

// Focus paint without a full re-render (a re-render moves terminal DOM).
function syncPaneFocus() {
  const split = stageLayout.panes.length > 1;
  stageGrid().querySelectorAll<HTMLElement>('.stage-pane').forEach((p) => {
    p.classList.toggle('focused', split && p.dataset.paneId === focusedBoxId);
  });
  highlightStage();
}

function repaintStage() {
  const grid = stageGrid();
  // Every docked pane needs live content before render; parking keeps the rest.
  for (const id of stageLayout.panes) {
    if (paneState(id) === 'terminal') ensureTab(id);
  }
  // Panels that lost their pane must stop polling (see clearSettingUpPanel).
  for (const [id] of settingUpPollers) {
    if (!stageLayout.panes.includes(id) || paneState(id) !== 'setup') clearSettingUpPanel(id);
  }
  // Park every tab first so replaceChildren() can't orphan a live terminal.
  for (const t of tabs.values()) stageParking().appendChild(t.el);
  if (stageLayout.panes.length === 0) {
    grid.replaceChildren();
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    if (!grid.querySelector('.empty')) grid.append(emptyStagePanel());
  } else {
    renderStagePanes(grid, stageLayout, focusedBoxId, paneHooks());
  }
  refitActiveTerminals();
  highlightStage();
  persistStage();
  if (focusedBoxId) tabs.get(focusedBoxId)?.term.focus();
  filterAndPaint(); // dock-button visibility tracks the layout
}

function dockBox(id: string, edge: Edge) {
  stageLayout = dockPane(stageLayout, id, edge);
  focusedBoxId = id;
  repaintStage();
}

function undockBox(id: string) {
  stageLayout = undockPane(stageLayout, id);
  if (focusedBoxId === id) focusedBoxId = stageLayout.panes[0] ?? null;
  repaintStage();
}
```

- [ ] **Step 3: Pane content states** — replace `showSettingUpBox` / `showStoppedBox` / `clearSettingUpPanel` (~lines 975–1060) with per-pane builders. The single module-level `settingUpPoller` becomes a Map.

```ts
// Content states a pane can show instead of a terminal.
function paneState(id: string): 'terminal' | 'stopped' | 'setup' {
  if (id === '__local__') return 'terminal';
  if (latestStatus[id]?.proxmoxState === 'stopped') return 'stopped';
  if (blocksTerminal(latestSetups.find((s) => s.boxId === id)?.status)) return 'setup';
  return 'terminal';
}

const settingUpPollers = new Map<string, { start: () => void; stop: () => void }>();

function clearSettingUpPanel(id: string) {
  settingUpPollers.get(id)?.stop();
  settingUpPollers.delete(id);
}

function paneContentFor(id: string): HTMLElement {
  const state = paneState(id);
  const box = allBoxes.find((b) => b.id === id);
  if (state === 'stopped' && box) { closeTab(id, { keepPane: true }); return buildStoppedPanel(box); }
  if (state === 'setup' && box) { closeTab(id, { keepPane: true }); return buildSettingUpPanel(box); }
  ensureTab(id);
  return tabs.get(id)!.el;
}
```

`buildStoppedPanel(box)` is the old `showStoppedBox` body from `const state = latestStatus[box.id]` through `panel.append(title, detail, manage)` — unchanged except it **returns `panel`** instead of touching `activeBoxId`/`highlightBox`/the stage. `buildSettingUpPanel(box)` is likewise the old `showSettingUpBox` body from `const panel = document.createElement('div')` onward, with the poller stored via `settingUpPollers.set(box.id, poller)`, and its settle branch becoming:

```ts
      clearSettingUpPanel(box.id);
      void refresh();
      repaintStage(); // paneState(box.id) is now 'terminal'; the pane re-resolves
      return null;
```

(the `openBox(box, { fromSetupGate: true })` call and the `fromSetupGate` option die — pane-state resolution replaces the gate; delete the option from `openBox`'s signature and its one use).

- [ ] **Step 4: Collapse `openBox` / `openLocalShell` / `closeTab` onto the model**

```ts
function openBox(b: Box) { openPane(b.id); }
function openLocalShell() { openPane('__local__'); }

// Plain activation (sidebar click): replace the focused pane, or become the
// single pane when the stage is empty/single — the confirmed "C replaces the
// focused pane" semantics.
function openPane(id: string) {
  if (stageLayout.panes.includes(id)) {
    focusedBoxId = id;
    syncPaneFocus();
    persistStage();
    tabs.get(id)?.term.focus();
    return;
  }
  stageLayout = stageLayout.panes.length <= 1 || !focusedBoxId
    ? singleLayout(id)
    : replacePane(stageLayout, focusedBoxId, id);
  focusedBoxId = id;
  repaintStage();
}

function closeTab(id: string, opts?: { keepPane?: boolean }) {
  const t = tabs.get(id);
  if (t) { t.term.dispose(); t.el.remove(); tabs.delete(id); }
  if (id === '__local__') updateLocalDot();
  if (!opts?.keepPane && stageLayout.panes.includes(id)) undockBox(id);
}
```

Note: `closeTab(id, { keepPane: true })` (used by `paneContentFor`) tears down the terminal but leaves the pane in the layout — the pane is about to show a stopped/setting-up panel instead. `undockBox` → `repaintStage` replaces the old empty-stage logic at the end of `closeTab`; delete lines ~1099–1114 wholesale. Also delete the singular `showSettingUpBox`/`showStoppedBox` and the old `settingUpPoller` variable; the Proxmox hub's `openBox` callback keeps working since `openBox(b)` survives.

- [ ] **Step 5: Sidebar highlight, stage markup, reconcile, logout**

`highlightBox(boxId)` (~line 957) becomes layout-aware `highlightStage()`:

```ts
// Docked = on stage (dimmed beacon); active = the focused pane (full beacon).
function highlightStage() {
  app.querySelectorAll('.box').forEach((element) => {
    const row = element as HTMLElement;
    const id = row.dataset.id ?? '';
    row.classList.toggle('docked', stageLayout.panes.includes(id) && id !== focusedBoxId);
    row.classList.toggle('active', id === focusedBoxId);
  });
  app.querySelectorAll('.box-group').forEach((element) => {
    const group = element as HTMLElement;
    group.classList.toggle('active-child', !!focusedBoxId && !!group.querySelector(`.box[data-id="${CSS.escape(focusedBoxId)}"]`));
  });
  const ls = app.querySelector('.local-shell');
  if (ls) {
    ls.classList.toggle('docked', stageLayout.panes.includes('__local__') && focusedBoxId !== '__local__');
    ls.classList.toggle('active', focusedBoxId === '__local__');
  }
}
```

Add the row CSS next to `.box.active` (style.css ~line 244):

```css
.box.docked, .local-shell.docked { background: rgba(36, 211, 232, 0.05); box-shadow: inset 3px 0 0 rgba(36, 211, 232, 0.45); }
```

`renderDashboard` stage markup (~line 660) changes from `<main id="stage" class="stage"></main>` + `append(emptyStagePanel())` to:

```html
<main id="stage" class="stage"><div class="stage-grid"></div><div class="stage-parking"></div></main>
```

followed by `repaintStage();` (which paints the empty panel itself).

`pollStatus` reconcile (~448–462): the "selected box was removed" block collapses to — for each tab id no longer in `allBoxes` (and not `__local__`), `closeTab(id)` (which undocks). Additionally, a docked box whose `paneState` changed (running→stopped, setup→done) must re-resolve: after the caches update, compute `stageLayout.panes.map(paneState).join()` and `repaintStage()` when it differs from the previous tick's value (store the string in a module `let lastPaneStates = ''`).

Logout teardown (~line 609–611) additionally resets the in-memory model (persisted copy survives on purpose — re-login restores it):

```ts
stageLayout = emptyLayout();
focusedBoxId = null;
```

- [ ] **Step 6: Boot restore** — in `start()` after the first `refresh()` resolves (the box list must exist for pruning):

```ts
const restored = restore(localStorage.getItem(STAGE_LAYOUT_KEY), [...allBoxes.map((b) => b.id), '__local__']);
stageLayout = restored.layout;
focusedBoxId = restored.focusedId;
repaintStage();
```

- [ ] **Step 7: Verify parity.** Run: `npm test` (full suite + typecheck) — green. Then `npm run dev` and manually: click a box → terminal; click another → replaces; Host Shell works; remove a box while open → empty stage panel returns; reload → last single terminal restored (persistence now applies even to singles — accepted upgrade over the old always-empty boot, per spec's "restore the split" decision).

- [ ] **Step 8: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "refactor(web): stage driven by the pane-layout model (single-pane parity)"
```

---

### Task 7: dock button + focus chord (split becomes reachable)

**Files:**
- Modify: `src/web/main.ts` — `createBoxRow` action cluster (~line 754, next to `refreshBtn`), document-level keydown near the other global listeners in `renderDashboard`.

**Interfaces:**
- Consumes: `dockBox`, `stageLayout`, `MAX_PANES`, `focusMove` (Task 4), `focusedBoxId`, `syncPaneFocus`.

- [ ] **Step 1: Dock button in the box-row action cluster** (insert before `refreshBtn` in `createBoxRow`; also update `paint`'s call sites not at all — visibility is computed here and `repaintStage` triggers `filterAndPaint`)

```ts
  const dock = document.createElement('button');
  dock.className = 'dock';
  dock.title = 'Dock beside current terminal';
  dock.setAttribute('aria-label', `Dock ${b.label} beside current terminal`);
  dock.textContent = '◫';
  // Visible only when exactly one *other* pane is on stage and the cap allows
  // a second — the keyboard-path equivalent of dragging onto the trailing edge.
  dock.hidden = !(stageLayout.panes.length === 1 && !stageLayout.panes.includes(b.id) && MAX_PANES > 1);
  dock.addEventListener('click', (e) => {
    e.stopPropagation();
    dockBox(b.id, stageLayout.orientation === 'row' ? 'right' : 'bottom');
  });
```

Append `dock` into the same actions container as `refreshBtn` (first in the cluster). Add CSS next to `.box .edit` (~style.css line 271):

```css
.box .dock { background: none; border: none; color: #6e7681; cursor: pointer; font-size: 13px; }
```

- [ ] **Step 2: Focus chord** — add once in `renderDashboard` (document capture, so xterm never sees it; the same swallow-the-chord pattern as the voice hotkey):

```ts
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey) || stageLayout.panes.length < 2) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = focusMove(stageLayout, focusedBoxId, e.key);
    if (target) {
      focusedBoxId = target;
      syncPaneFocus();
      persistStage();
      tabs.get(target)?.term.focus();
    }
  }, true);
```

(Register it alongside `renderDashboard`'s other document-level wiring so logout's re-render doesn't stack duplicates — guard with a module-level `let chordWired = false;` set on first wire.)

- [ ] **Step 3: Verify.** `npm test` green. Manual: open box A, press A's row ◫ on box B → two panes, B focused (cyan hairline, nameplate); plain-click box C → C replaces B; `Ctrl+Shift+ArrowLeft` → focus A; undock ✕ → single view.

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(web): dock button and Ctrl+Shift+Arrow pane focus"
```

---

### Task 8: drag-to-dock with drop zones

**Files:**
- Modify: `src/web/main.ts` — `createBoxRow` (drag source), local-shell row in `renderDashboard`, stage drag wiring in `renderDashboard`.

**Interfaces:**
- Consumes: `dropTargets` (Task 4), `dockBox`, `replacePane`, `swapPanes`, `repaintStage`, `MAX_PANES`.

- [ ] **Step 1: Drag sources.** In `createBoxRow`: `li.draggable = true;` plus

```ts
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/x-tmuxifier-box', b.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
```

Same two lines on the `.local-shell` container in `renderDashboard` with id `'__local__'`.

- [ ] **Step 2: Stage drop wiring** (in `renderDashboard`, after the stage markup exists)

```ts
  const stage = app.querySelector('#stage') as HTMLElement;
  const zones = document.createElement('div');
  zones.className = 'drop-zones';
  stage.append(zones);

  function buildZones(draggedId: string) {
    zones.replaceChildren();
    for (const t of dropTargets(stageLayout, draggedId, MAX_PANES)) {
      const z = document.createElement('div');
      if (t.kind === 'edge') {
        z.className = `drop-zone drop-zone-${t.edge}`;
        z.dataset.edge = t.edge;
      } else {
        z.className = 'drop-zone drop-zone-pane';
        z.dataset.paneIndex = String(t.index);
        // Center the zone over its pane: mirror the pane's grid extent.
        const rect = stageGrid().querySelectorAll('.stage-pane')[t.index]?.getBoundingClientRect();
        const host = stage.getBoundingClientRect();
        if (rect) {
          z.style.left = `${rect.left - host.left + rect.width * 0.3}px`;
          z.style.width = `${rect.width * 0.4}px`;
          z.style.top = `${rect.top - host.top + rect.height * 0.3}px`;
          z.style.height = `${rect.height * 0.4}px`;
        }
      }
      zones.append(z);
    }
  }

  stage.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('text/x-tmuxifier-box')) return;
    // dragenter can't read the payload (data is drop-only in the DnD spec), so
    // zones are gated by *type* and the id is resolved on drop.
    stage.classList.add('dragging');
    buildZones(dragSourceId ?? '');
  });
  stage.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('text/x-tmuxifier-box')) return;
    e.preventDefault(); // required, or the browser refuses the drop
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-zone');
    zones.querySelectorAll('.drop-zone').forEach((z) => z.classList.toggle('hover', z === over));
  });
  stage.addEventListener('dragleave', (e) => {
    if (e.target === stage) stage.classList.remove('dragging');
  });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragging');
    const id = e.dataTransfer?.getData('text/x-tmuxifier-box');
    if (!id) return;
    const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-zone') as HTMLElement | null;
    if (!zone) return;
    if (zone.dataset.edge) {
      dockBox(id, zone.dataset.edge as Edge);
    } else if (zone.dataset.paneIndex != null) {
      const target = stageLayout.panes[Number(zone.dataset.paneIndex)];
      if (target && target !== id) {
        stageLayout = replacePane(stageLayout, target, id); // swaps when id is docked
        focusedBoxId = id;
        repaintStage();
      }
    }
  });
```

`dragSourceId` is a module-level `let dragSourceId: string | null = null;` set in each `dragstart` handler (`dragSourceId = b.id;`) and cleared on `dragend` — the DnD spec hides the payload until drop, and `dropTargets` needs the id at dragenter time to gate edge zones by the cap.  Add `li.addEventListener('dragend', () => { dragSourceId = null; stage.classList.remove('dragging'); });` to each source.

- [ ] **Step 3: Verify.** `npm test` green. Manual: drag box B over the stage → zones appear; drop right edge → side-by-side; drag B onto A's center → swap; drag box C (cap reached) → only pane centers, no edges; Escape mid-drag cancels.

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(web): drag-to-dock with edge and replace drop zones"
```

---

### Task 9: Playwright e2e

**Files:**
- Create: `test/e2e/split.spec.ts`

The e2e env (see `test/e2e/global-setup.js`) seeds password `e2e` and boxes `localhost` (real sshd, terminals work), `db-primary`, `untagged-worker` (rows only; their terminals show connect-retry text, which is fine — pane mechanics are what's under test).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('dock a second box, type into the focused pane, resize, and survive reload', async ({ page }) => {
  await login(page);

  // Open localhost full-stage, then dock db-primary beside it via the keyboard path.
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-nameplate').first()).toHaveText(/localhost/i);

  // Focus the localhost pane and prove keystrokes land there.
  await page.locator('.stage-pane[data-pane-id]').first().click();
  await page.keyboard.type('echo SPLIT_E2E_MARKER');
  await page.keyboard.press('Enter');
  await expect(page.locator('.stage-pane').first()).toContainText('SPLIT_E2E_MARKER', { timeout: 15000 });

  // Divider: keyboard resize follows the ARIA splitter pattern.
  const divider = page.locator('.stage-divider');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');

  // The split (panes + ratio) survives a reload.
  await page.reload();
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('.stage-divider')).toHaveAttribute('aria-valuenow', '55');

  // Undock returns to a single full pane.
  await page.locator('.stage-pane').nth(1).hover();
  await page.getByRole('button', { name: /^Undock/ }).nth(1).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
});

test('plain-clicking a third box replaces the focused pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  // db-primary is focused (it was just docked); clicking untagged-worker replaces it.
  await page.locator('.box .name', { hasText: 'untagged-worker' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-nameplate', { hasText: 'untagged-worker' })).toBeVisible();
  await expect(page.locator('.pane-nameplate', { hasText: 'db-primary' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it.** `npx playwright test test/e2e/split.spec.ts`
Expected: PASS. If the marker assertion is flaky, mirror the retry idiom in `test/e2e/tmuxifier.spec.ts` rather than inventing waits.

- [ ] **Step 3: Run everything.** `npm test && npm run test:e2e` — all green.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/split.spec.ts
git commit -m "test(e2e): split terminals — dock, focus, resize, persistence"
```

---

### Task 10: documentation

**Files:**
- Modify: `README.md` (feature list), `CLAUDE.md` and `AGENTS.md` (web-client module inventory — the two stay in sync per house rules).

- [ ] **Step 1: README** — add one feature bullet where the terminal features are described (match the existing voice/upload bullets' tone):

```markdown
- **Split terminals** — drag a box onto the stage (or use the row's ◫ button) to dock two
  terminals side by side or stacked; draggable divider, `Ctrl+Shift+Arrow` to move focus,
  and the split survives reloads. Plain-clicking another box replaces the focused pane.
```

- [ ] **Step 2: CLAUDE.md + AGENTS.md** — in the `src/web/` inventory sentence listing feature modules, add:

```
`stageLayout.ts` (the pure, N-capable stage pane model — panes/orientation/ratios,
dock/undock/replace/swap/setRatio, serialize/restore with vanished-box pruning; the
two-pane cap is main.ts's MAX_PANES, not the model's), `stagePanes.ts` (pure grid/ARIA
helpers plus the DOM renderer for panes, WAI-ARIA splitter dividers, nameplates, and
drop targets; terminals park in a hidden div when undocked so they stay connected)
```

and note in the main.ts description that the stage is driven by `stageLayout` +
`focusedBoxId` (persisted under `tmuxifier.stageLayout`) instead of a single active box.

- [ ] **Step 3: Verify + commit.** `npm test` green (docs don't break it, but the habit holds).

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: split terminals (stage panes) feature and module inventory"
```

---

## Self-review notes (already applied)

- **Spec coverage:** every spec section maps to a task — model (1–3), gestures (5, 7, 8), focus/sidebar (6, 7), pane content states (6), persistence/edge cases (3, 6), testing (1–4, 9), out-of-scope items untouched.
- **`fromSetupGate` removal** (Task 6) supersedes the spec's mention of that option — pane-state resolution replaces the gate; behavior (setup panel auto-opens terminal on settle) is preserved via `repaintStage()`.
- **Type consistency:** `setRatio(layout, divider, firstShare)`, `PaneHooks.onRatio(divider, firstShare, phase)`, and `keyboardRatioStep` all speak "firstShare of the pair"; `Edge`/`Orientation` names match across tasks.
