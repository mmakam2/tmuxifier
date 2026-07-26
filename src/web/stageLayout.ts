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
  // Round to 4 decimals: keeps serialized layouts tidy and spares every caller
  // (tests, aria-valuenow) from IEEE dust like 1 - 0.7 = 0.30000000000000004.
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  ratios[divider] = round(first);
  ratios[j] = round(pair - first);
  return { ...layout, ratios };
}

export function toggleOrientation(layout: StageLayout): StageLayout {
  return { ...layout, orientation: layout.orientation === 'row' ? 'column' : 'row' };
}

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
  const ratios = ratiosSane ? (r as number[]) : even(panes.length);
  const focusedId = typeof p.focusedId === 'string' && panes.includes(p.focusedId) ? p.focusedId : panes[0] ?? null;
  return { layout: { orientation, panes, ratios }, focusedId };
}
