// Pane header bar: the pure view-model (unit-tested) plus the DOM layer
// (covered by the split e2e — same split as stagePanes.ts). Never imports
// main.ts; everything arrives via PaneHeaderInput / PaneHeaderActions.
import { dotClassFor, dotTitleFor } from './statusDot';
import { buildClawd } from './clawd';
import type { Status } from './api';

export type ConnKind = 'connecting' | 'open' | 'retrying' | 'setup';
export interface PaneConn { kind: ConnKind; attempt?: number }

export interface PaneHeaderInput {
  local: boolean;
  label: string;
  user?: string;
  host?: string;
  status?: Status;
  agent?: 'working' | 'waiting';
  conn?: PaneConn;
  state: 'terminal' | 'stopped' | 'setup';
}

export interface PaneChip { kind: 'state' | 'conn' | 'agent'; text: string; cls: string; sprite?: boolean }
export interface PaneHeaderModel { title: string; target: string; dotClass: string; dotTitle: string; chip: PaneChip | null }

// One slot, strict precedence: a pane-level state (stopped container, box
// mid-setup) outranks connection churn, which outranks the agent read — a
// disconnected pane has no live agent worth reporting on. A claude with no
// hook marker carries no `agent` at all, so it renders no chip: the silence
// is the cue that the box needs a setup rerun, not a state to invent.
export function paneHeaderChip(i: PaneHeaderInput): PaneChip | null {
  if (i.state === 'stopped') return { kind: 'state', text: 'stopped', cls: 'chip-state' };
  if (i.state === 'setup') return { kind: 'state', text: 'setting up', cls: 'chip-state' };
  if (i.conn?.kind === 'retrying') return { kind: 'conn', text: `reconnecting ×${i.conn.attempt ?? 1}`, cls: 'chip-conn' };
  if (i.conn?.kind === 'connecting') return { kind: 'conn', text: 'connecting…', cls: 'chip-conn' };
  if (i.conn?.kind === 'setup') return { kind: 'conn', text: 'setting up…', cls: 'chip-conn' };
  if (i.agent === 'working' || i.agent === 'waiting') {
    const chip: PaneChip = { kind: 'agent', text: i.agent, cls: `chip-agent-${i.agent}` };
    if (i.agent === 'working') chip.sprite = true; // Clawd rides working only
    return chip;
  }
  return null;
}

export function paneHeaderModel(i: PaneHeaderInput): PaneHeaderModel {
  // The local shell has no Status entry — its dot tracks the WebSocket the
  // way the sidebar's local dot does, not an SSH probe it will never have.
  const dotClass = i.local ? (i.conn?.kind === 'open' ? 'green' : 'gray') : dotClassFor(i.status);
  const dotTitle = i.local ? (i.conn?.kind === 'open' ? 'Connected' : 'Not connected') : dotTitleFor(i.status);
  return {
    title: i.label,
    target: i.local ? 'this host' : (i.user ? `${i.user}@${i.host ?? ''}` : i.host ?? ''),
    dotClass,
    dotTitle,
    chip: paneHeaderChip(i),
  };
}

export interface PaneHeaderActions {
  // Ask for the Reconnect cap. Deliberately not a callback: the action is
  // destructive (it kills the pane's tmux session), so the caller wires the
  // arm-then-fire policy onto the returned `refreshBtn` instead of getting a
  // handler that fires on the first click.
  wantRefresh?: boolean;
  onUndock?: () => void;
  undockLabel?: string;
}

// update() rewrites text/classes only — the voice button lives inside
// voiceSlot across updates, and rebuilding children would kill an in-flight
// recording. Action buttons are fixed at build time: refresh/undock
// availability changes only on a full stage repaint, never mid-poll.
export function buildPaneHeader(model: PaneHeaderModel, actions: PaneHeaderActions = {}): {
  el: HTMLElement; voiceSlot: HTMLElement; lifecycleSlot: HTMLElement; refreshBtn: HTMLButtonElement | null; update(m: PaneHeaderModel): void;
} {
  const el = document.createElement('div');
  el.className = 'pane-header';

  const dot = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'pane-title';
  const target = document.createElement('span');
  target.className = 'pane-target';
  // Mount point for the Proxmox lifecycle keys (paneLifecycle.ts), filled by
  // main.ts for linked boxes only — the same seam as voiceSlot, and for the
  // same reason: its contents own their own update cycle, so update() below
  // must never rebuild them.
  const lifecycleSlot = document.createElement('span');
  lifecycleSlot.className = 'pane-lifecycle-slot';
  const identity = document.createElement('div');
  identity.className = 'pane-header-id';
  identity.append(dot, title, target, lifecycleSlot);

  const chip = document.createElement('span');
  const voiceSlot = document.createElement('span');
  voiceSlot.className = 'pane-voice-slot';
  const acts = document.createElement('div');
  acts.className = 'pane-header-actions';
  acts.append(chip, voiceSlot);

  // Reconnect kills the pane's tmux session, so its click policy is arm-then-fire
  // and lives with the caller (main.ts owns the armed id, which has to survive a
  // header rebuild). This only builds the cap and hands it back: no listener is
  // attached here, and `wantRefresh` is the request for the button, not for a
  // behaviour. The glyph and labels are set by whoever wires it.
  let refreshBtn: HTMLButtonElement | null = null;
  if (actions.wantRefresh) {
    refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'pane-act pane-refresh';
    acts.append(refreshBtn);
  }
  if (actions.onUndock) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-act pane-undock';
    btn.textContent = '✕';
    btn.title = 'Undock';
    btn.setAttribute('aria-label', actions.undockLabel ?? 'Undock');
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.onUndock!(); });
    acts.append(btn);
  }

  el.append(identity, acts);

  const update = (m: PaneHeaderModel) => {
    dot.className = `dot ${m.dotClass}`;
    dot.title = m.dotTitle;
    title.textContent = m.title;
    target.textContent = m.target;
    if (m.chip) {
      chip.hidden = false;
      chip.className = `pane-chip ${m.chip.cls}`;
      // Rebuilding the chip's own children is safe: the voice button lives in
      // voiceSlot and the lifecycle keys in lifecycleSlot, both outside this
      // span — the "text/classes only" rule protects those slots, not these
      // text nodes.
      chip.textContent = '';
      if (m.chip.sprite) chip.append(buildClawd());
      chip.append(document.createTextNode(m.chip.text));
    } else {
      chip.hidden = true;
      chip.className = 'pane-chip';
      chip.textContent = '';
    }
  };
  update(model);
  return { el, voiceSlot, lifecycleSlot, refreshBtn, update };
}
