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

// Spatial focus: nearest pane whose center lies in the arrow's direction.
// Candidates whose rect overlaps the source's perpendicular span outrank the
// rest (from the top-left of a 2-up, ArrowRight must pick its neighbor, not
// the geometrically-closer full-width pane below); ties break by axis
// distance, then perpendicular center offset.
export function focusMove(rects: PaneRect[], focusedId: string | null, key: string): string | null {
  if (!focusedId) return null;
  const from = rects.find((r) => r.id === focusedId);
  if (!from) return null;
  const cx = (r: PaneRect) => r.x + r.w / 2;
  const cy = (r: PaneRect) => r.y + r.h / 2;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  const vOverlap = (r: PaneRect) => overlaps(from.y, from.y + from.h, r.y, r.y + r.h);
  const hOverlap = (r: PaneRect) => overlaps(from.x, from.x + from.w, r.x, r.x + r.w);
  const dir: Record<string, (r: PaneRect) => [number, number, number] | null> = {
    ArrowRight: (r) => (cx(r) > cx(from) + 1 ? [vOverlap(r) ? 0 : 1, cx(r) - cx(from), Math.abs(cy(r) - cy(from))] : null),
    ArrowLeft: (r) => (cx(r) < cx(from) - 1 ? [vOverlap(r) ? 0 : 1, cx(from) - cx(r), Math.abs(cy(r) - cy(from))] : null),
    ArrowDown: (r) => (cy(r) > cy(from) + 1 ? [hOverlap(r) ? 0 : 1, cy(r) - cy(from), Math.abs(cx(r) - cx(from))] : null),
    ArrowUp: (r) => (cy(r) < cy(from) - 1 ? [hOverlap(r) ? 0 : 1, cy(from) - cy(r), Math.abs(cx(r) - cx(from))] : null),
  };
  const score = dir[key];
  if (!score) return null;
  let best: { id: string; d: [number, number, number] } | null = null;
  for (const r of rects) {
    if (r.id === focusedId) continue;
    const d = score(r);
    if (!d) continue;
    if (!best || d[0] < best.d[0] || (d[0] === best.d[0] && (d[1] < best.d[1] || (d[1] === best.d[1] && d[2] < best.d[2])))) {
      best = { id: r.id, d };
    }
  }
  return best?.id ?? null;
}

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
// keyboard step after a pointer drag starts from where the drag left off,
// not from the layout snapshot this closure rendered with.
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

  // Pointer drag: firstShare = pointer position across the two adjacent panes.
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
  rotate.textContent = '\u2922';
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
  // .term children position absolutely against the body, not the pane, so the
  // header keeps its own row instead of being painted over.
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
