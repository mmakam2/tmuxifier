// Pure half of the jump to an agent pane (spec 2026-11-26 §7.3): a sidebar
// row names a box and a pane id; everything else the jump needs comes from that
// pane's own entry in the latest health sample, never from the row's text. The
// DOM half (main.ts jumpToAgent) docks the box on `session` and, unless the
// pane is already the focused one, selects its window and pane on the box.
// No DOM access: unit-tested in node.
import type { AgentEntry } from './api';

export interface JumpTarget { boxId: string; pane: string; session: string; windowId: string; focused: boolean }

// The jump target for `pane`, or null when the box's map has no such pane. The
// map is keyed by box output (pane ids), so the lookup is own-property only: an
// inherited name such as `constructor` is not a pane.
export function jumpTargetOf(boxId: string, agents: Record<string, AgentEntry> | undefined, pane: string): JumpTarget | null {
  if (!agents || !Object.hasOwn(agents, pane)) return null;
  const e = agents[pane];
  if (!e || typeof e !== 'object' || typeof e.session !== 'string' || typeof e.windowId !== 'string') return null;
  return { boxId, pane, session: e.session, windowId: e.windowId, focused: e.focused === true };
}

// Only a pane that is already focused needs no select. A pane in the window in
// front still does: the select also moves tmux's pane focus onto it.
export function needsSelect(t: JumpTarget): boolean {
  return !t.focused;
}
