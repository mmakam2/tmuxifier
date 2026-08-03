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
    const tmp = ' swap';
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

// Structural validation for v2 payloads; per-split ratio sanity falls back to even.
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

// Phone mode shows exactly one pane. The focused pane if it is still docked,
// else the first pane in reading order, else nothing (dashboard). Pure so the
// live-flip (rotate across the breakpoint) is testable without DOM.
export function phonePaneOf(root: PaneNode | null, focusedId: string | null): string | null {
  const panes = panesOf(root);
  if (panes.length === 0) return null;
  return focusedId != null && panes.includes(focusedId) ? focusedId : panes[0];
}
