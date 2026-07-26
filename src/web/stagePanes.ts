// Stage-pane rendering: pure geometry/ARIA helpers (unit-tested) plus the DOM
// renderer (covered by the split e2e). Never imports main.ts — everything the
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
