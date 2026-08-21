// Pane header bar: the pure view-model (unit-tested) plus the DOM layer
// (covered by the split e2e — same split as stagePanes.ts). Never imports
// main.ts; everything arrives via PaneHeaderInput / PaneHeaderActions.
import { dotClassFor, dotTitleFor } from './statusDot';
import { buildClawd } from './clawd';
import type { Status, TmuxWindow } from './api';

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
  sessionName?: string;
}

export interface PaneChip { kind: 'state' | 'conn' | 'agent'; text: string; cls: string; sprite?: boolean }
export interface PaneHeaderModel {
  title: string; target: string; dotClass: string; dotTitle: string; chip: PaneChip | null;
  // Session dropdown contents: null hides it (local shell, stopped/setup pane).
  targets: SessionTargetList | null;
}

// Client mirror of the server's session-name rule (SESSION_NAME_RE in
// sshCommand.js), locked together by test/paneHeader.test.js. Live tmux names
// outside it exist legitimately (spaces, '@', …) but cannot round-trip a
// switch: store.js's sanitizeSession would silently rewrite the PATCHed name
// and the reattach would create a fresh mangled-name session instead of
// attaching — a rename behind the user's back. The dropdown offers such names
// disabled rather than hiding them: the session is real, only unswitchable.
export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isSwitchableSession(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

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
    // Only a live terminal pane on a real box offers the switch: the local
    // shell's session is config, and a stopped/setting-up pane has no attach to
    // move.
    targets: !i.local && i.state === 'terminal' ? sessionTargetList(i.status, i.sessionName) : null,
  };
}

// One row of the session dropdown. A row is either a session or one of its
// windows; `value` is the <option> value and `session` is the session the row
// resolves to, so a caller never has to re-derive which session a window is in.
export interface SessionTarget {
  kind: 'session' | 'window';
  value: string;        // 's:<session>' | 'w:<@id>'
  label: string;
  session: string;
  windowId?: string;
  disabled?: boolean;
  title?: string;       // why it is disabled
}
export interface SessionTargetList { options: SessionTarget[]; value: string }

// <option> cannot be styled, so the hierarchy is text — the same concession the
// unswitchable-name rule already makes. Non-breaking spaces: a native select
// collapses ordinary leading whitespace.
export const WINDOW_INDENT = '  → ';

const UNSWITCHABLE = 'name not switchable from here (allowed: letters, digits, _ -)';

// The dropdown's rows: the box's configured session first (always present — it
// is the selected value, and it must stay offered even when tmux no longer
// lists it), its windows indented beneath it, then every other live session
// followed by its own windows.
export function sessionTargets(status: Status | undefined, sessionName: string | undefined): SessionTarget[] {
  const current = sessionName || 'web'; // store.js defaults an absent name to 'web'
  const live = (status?.sessions ?? []).filter((s) => s.name);
  const currentLive = live.find((s) => s.name === current);
  const rows: { name: string; windowList?: TmuxWindow[] }[] = [
    currentLive ?? { name: current },
    ...live.filter((s) => s.name !== current),
  ];
  const out: SessionTarget[] = [];
  for (const s of rows) {
    // Switching to a live session whose name is outside the charset would
    // silently rename it: store.js's sanitizeSession rewrites the PATCHed name
    // and the reattach then creates a fresh mangled-name session. Offered but
    // disabled — the session is real, only unswitchable from here. Windows
    // inherit that, EXCEPT the current session's, which need no PATCH at all.
    const locked = s.name !== current && !isSwitchableSession(s.name);
    const lock = locked ? { disabled: true, title: UNSWITCHABLE } : {};
    out.push({ kind: 'session', value: `s:${s.name}`, label: s.name, session: s.name, ...lock });
    for (const w of s.windowList ?? []) {
      out.push({
        kind: 'window',
        value: `w:${w.id}`,
        label: `${WINDOW_INDENT}${w.index}: ${w.name || 'window'}`,
        session: s.name,
        windowId: w.id,
        ...lock,
      });
    }
  }
  return out;
}

// The rows plus the one that is selected: the current session's ACTIVE window
// when the snapshot knows it, else the session row. This is what makes the
// header answer "which window am I looking at" rather than only naming the
// session the pane belongs to.
export function sessionTargetList(status: Status | undefined, sessionName: string | undefined): SessionTargetList {
  const current = sessionName || 'web';
  const active = (status?.sessions ?? []).find((s) => s.name === current)?.windowList?.find((w) => w.active);
  return { options: sessionTargets(status, sessionName), value: active ? `w:${active.id}` : `s:${current}` };
}

export interface PaneHeaderActions {
  // Ask for the Reconnect cap. Deliberately not a callback: the action is
  // destructive (it kills the pane's tmux session), so the caller wires the
  // arm-then-fire policy onto the returned `refreshBtn` instead of getting a
  // handler that fires on the first click.
  wantRefresh?: boolean;
  onUndock?: () => void;
  undockLabel?: string;
  // Switch the box's active tmux session. Non-destructive (the old session
  // keeps running on the box), so unlike Reconnect this is a plain callback:
  // no arm-then-fire.
  onSelectSession?: (name: string) => void;
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
  // The session dropdown sits with the identity: which session this pane shows
  // is part of what the pane IS, not an action on it. Built only when the
  // caller can act on a pick; options are populated by update() below.
  let sessionSel: HTMLSelectElement | null = null;
  if (actions.onSelectSession) {
    sessionSel = document.createElement('select');
    sessionSel.className = 'pane-session';
    sessionSel.title = 'Active tmux session';
    sessionSel.setAttribute('aria-label', 'Active tmux session');
    sessionSel.addEventListener('click', (e) => e.stopPropagation());
    // Blur before acting: a native select keeps focus after `change`, and the
    // focused-select guard in update() below (rightly) refuses to touch a
    // focused select — so without this, a failed switch could never snap the
    // value back and the header would keep showing a switch that never
    // happened. On success the repaint rebuilds the header anyway.
    sessionSel.addEventListener('change', () => {
      const name = sessionSel!.value;
      sessionSel!.blur();
      actions.onSelectSession!(name);
    });
  }
  const identity = document.createElement('div');
  identity.className = 'pane-header-id';
  identity.append(dot, title, target, ...(sessionSel ? [sessionSel] : []), lifecycleSlot);

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
    if (sessionSel) {
      const list = m.sessions ?? [];
      sessionSel.hidden = list.length === 0;
      // Never rebuild under the user: this runs on every status poll, and
      // repopulating a native select while its dropdown is open slams it shut
      // mid-pick. The focused select keeps its current options until blur.
      if (document.activeElement !== sessionSel) {
        const key = list.join('\n');
        if (sessionSel.dataset.opts !== key) {
          sessionSel.dataset.opts = key;
          sessionSel.replaceChildren(...list.map((n) => {
            const o = document.createElement('option');
            o.value = n;
            o.textContent = n;
            if (!isSwitchableSession(n)) {
              o.disabled = true;
              o.title = 'name not switchable from here (allowed: letters, digits, _ -)';
            }
            return o;
          }));
        }
        // The configured session is sessionOptions' element 0 by construction.
        sessionSel.value = list[0] ?? '';
      }
    }
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
