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
