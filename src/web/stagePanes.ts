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

export interface PaneHooks {
  contentFor(id: string): HTMLElement;
  headerFor(id: string, split: boolean): HTMLElement;
  onFocus(id: string): void;
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

// The divider reads the live ratio back off its own aria-valuenow so a
// keyboard step after a pointer drag starts from where the drag left off,
// not from the layout snapshot this closure rendered with.
function buildDivider(layout: StageLayout, divider: number, hooks: PaneHooks): HTMLElement {
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
    const pair = layout.ratios[divider] + layout.ratios[divider + 1];
    const live: StageLayout = { ...layout, ratios: [...layout.ratios] };
    live.ratios[divider] = current * pair;
    live.ratios[divider + 1] = (1 - current) * pair;
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
    const shareAt = (ev: PointerEvent) => {
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      return layout.orientation === 'row'
        ? (ev.clientX - a.left) / (b.right - a.left)
        : (ev.clientY - a.top) / (b.bottom - a.top);
    };
    const move = (ev: PointerEvent) => hooks.onRatio(divider, shareAt(ev), 'drag');
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      hooks.onRatio(divider, shareAt(ev), 'commit');
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
  pane.append(hooks.headerFor(id, split));
  // .term children position absolutely against the body, not the pane, so the
  // header keeps its own row instead of being painted over.
  const body = document.createElement('div');
  body.className = 'pane-body';
  body.append(hooks.contentFor(id));
  pane.append(body);
  return pane;
}

export function renderStagePanes(grid: HTMLElement, layout: StageLayout, focusedId: string | null, hooks: PaneHooks): void {
  grid.classList.toggle('stage-grid-column', layout.orientation === 'column');
  grid.replaceChildren();
  const split = layout.panes.length > 1;
  layout.panes.forEach((id, i) => {
    if (i > 0) grid.append(buildDivider(layout, i - 1, hooks));
    grid.append(buildPane(id, split, split && id === focusedId, hooks));
  });
  applyRatios(grid, layout);
}
