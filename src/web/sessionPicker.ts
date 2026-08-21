// The session/window picker: a trigger button plus an anchored popup whose rows
// each carry a kill ×. Replaces the native <select> both surfaces used, which
// could not host a per-row control — an <option> takes no markup, no click
// handler and no styling.
//
// Split like paneHeader.ts and stagePanes.ts: the pure half below is
// unit-tested, the DOM half is covered by Playwright (vitest runs
// environment: 'node' with no jsdom).
import type { SessionTarget, SessionTargetList } from './paneHeader';
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';

// tmux destroys a session when its last window is killed. This does not
// special-case that — it just refuses to let it be a surprise, by letting the
// arm legend say so.
export function isSoleWindow(targets: SessionTarget[], t: SessionTarget): boolean {
  if (t.kind !== 'window') return false;
  return targets.filter((x) => x.kind === 'window' && x.session === t.session).length === 1;
}

// What the armed × states before the second click commits. The row's own label
// carries the indent used to draw the tree; strip it so the sentence reads.
export function killLegend(t: SessionTarget, sole: boolean): string {
  const name = t.label.replace(/^[\s ]*→[\s ]*/, '').trim();
  if (t.kind === 'session') return `kill session ${name}?`;
  return sole ? `kill ${name}? last window — the session goes too` : `kill ${name}?`;
}

// The identity an arm is held against. SessionTarget.value already carries the
// session for exactly this class of reason: a grouped session shares its window
// objects, so '@7' alone names two rows, and an arm keyed by id could migrate
// onto a different session between the arming click and the firing one.
export function rowKey(t: SessionTarget): string {
  return t.value;
}

// How long the open path waits for a fresh probe before showing the list it
// already has. Long enough for a healthy box over the ControlMaster, short
// enough that a box that has gone away is a slightly-late list, not a dead click.
export const OPEN_REFRESH_WAIT_MS = 700;

export interface SessionPickerDeps {
  onSelect: (t: SessionTarget) => void;
  // Rejects on failure. The row is NOT removed optimistically: the list is a
  // report of what is on the box, not a wish.
  onKill: (t: SessionTarget) => Promise<void>;
  onWillOpen?: (opts?: { waitMs?: number }) => Promise<void>;
  // Whether a row may be killed at all. Defaults to true. The Edit Box modal
  // uses it to exempt its synthetic Create New Session… row, which names no
  // session on the box and so has nothing to kill.
  canKill?: (t: SessionTarget) => boolean;
  className?: string;
}

export interface SessionPicker {
  el: HTMLElement;
  update(list: SessionTargetList | null): void;
  close(): void;
  // Tears down the document-level listener close()/the popup itself cannot
  // remove on their own. Distinct from close(): close() is called routinely —
  // including from inside the outside-click handler this removes — and must
  // never rip out the listener that makes it work. Callers that stop using a
  // picker instance (a repaint that rebuilds the pane header, an undocked
  // pane) must call this or the listener, and the detached popup subtree it
  // closes over, outlive the DOM they were built for.
  destroy(): void;
}

export function buildSessionPicker(deps: SessionPickerDeps): SessionPicker {
  const el = document.createElement('div');
  el.className = `session-picker${deps.className ? ' ' + deps.className : ''}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'session-picker-trigger';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.title = 'Active tmux session and window';
  trigger.setAttribute('aria-label', 'Active tmux session and window');

  const pop = document.createElement('div');
  pop.className = 'session-picker-pop';
  pop.hidden = true;
  const list = document.createElement('ul');
  list.className = 'session-picker-list';
  pop.append(list);

  el.append(trigger, pop);

  let current: SessionTargetList | null = null;
  let open = false;
  let arm: ArmState = IDLE;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingList: SessionTargetList | null | undefined;

  // Rows are never rebuilt while a row is armed. A status poll landing between
  // the arming click and the committing one could otherwise reorder or re-key
  // the list and migrate the arm onto a different session — the arm-then-fire
  // equivalent of the stale-index bug that made this codebase address windows
  // by @id instead of index. A refresh that arrives meanwhile is held here and
  // applied when the arm clears.
  function disarm() {
    clearTimeout(armTimer);
    arm = IDLE;
    if (pendingList !== undefined) { const held = pendingList; pendingList = undefined; update(held); return; }
    render();
  }

  function fire(t: SessionTarget) {
    disarm();
    void deps.onKill(t).catch(() => { /* the surface reports; the row stays */ });
  }

  function clickKill(t: SessionTarget) {
    const { state, fire: id } = armReduce(arm, { type: 'click', id: rowKey(t), armable: true });
    clearTimeout(armTimer);
    arm = state;
    if (id) { fire(t); return; }
    armTimer = setTimeout(disarm, ARM_MS);
    render();
    // render() itself now restores focus onto the row/button it was called
    // with — see focusedRowButton()/the restore at the end of render(). The
    // just-clicked kill button is document.activeElement when render() runs
    // above, so this is no longer a bespoke case: it is the same mechanism
    // that also covers a status poll landing mid-arm, Escape, and the arrow
    // keys, all of which used to go dead the moment any render() rebuilt the
    // row out from under the focused button.
  }

  // The row (by data-key) and which of its two buttons held focus, captured
  // BEFORE a rebuild so it can be restored after — but only when focus was
  // genuinely inside `list` to begin with. render() rebuilds every row via
  // replaceChildren, which unconditionally destroys whatever was focused
  // (focus reverts to `body`), taking the popup's keydown handler (bound to
  // `pop`) down with it: Escape and the arrow keys go dead until the next
  // mouse click. This used to only be patched around for the arm/disarm
  // render in clickKill; a poll-driven render() via update() got no such
  // treatment, so ArrowUp/Down/Home/End and Escape died on every status-poll
  // tick while the popup was open, not just after arming a kill.
  function focusedRowButton(): { key: string; cls: '.session-picker-pick' | '.session-picker-kill' } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !list.contains(active)) return null;
    const row = active.closest<HTMLElement>('.session-picker-row');
    const key = row?.dataset.key;
    if (!key) return null;
    const cls = active.classList.contains('session-picker-kill') ? '.session-picker-kill' : '.session-picker-pick';
    return { key, cls };
  }

  // Content-key memo, mirroring the content-key the native <select> this
  // replaced used to skip its own rebuild (`sessionSel.dataset.opts`, keyed on
  // the option list's own join). Render's output is fully determined by the
  // options list, which row is current, and which row (if any) is armed, so a
  // poll that reports the same sessions/windows — the overwhelming common
  // case — need not touch the DOM at all. That makes the focus-preserving
  // dance above unnecessary for most renders rather than merely correct for
  // the rest.
  let lastKey: string | null = null;

  function render() {
    const opts = current?.options ?? [];
    const key = JSON.stringify([
      current?.value ?? null,
      arm.armed ?? null,
      opts.map((t) => [t.value, t.label, t.disabled ?? false, t.title ?? '']),
    ]);
    if (key === lastKey) return;
    lastKey = key;
    const focused = focusedRowButton();
    trigger.textContent = (opts.find((t) => t.value === current?.value)?.label ?? '').replace(/^[\s ]*→[\s ]*/, '').trim() || '—';
    list.replaceChildren(...opts.map((t) => {
      const li = document.createElement('li');
      li.className = 'session-picker-row';
      li.dataset.key = rowKey(t);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'session-picker-pick';
      pick.textContent = t.label;
      pick.tabIndex = -1;
      if (t.value === current?.value) { pick.setAttribute('aria-current', 'true'); li.classList.add('current'); }
      // A live session name outside SESSION_NAME_RE cannot round-trip a switch
      // (store.js's sanitizeSession would rewrite the PATCHed name). Offered
      // disabled rather than hidden — the session is real, only unswitchable.
      if (t.disabled) { pick.disabled = true; if (t.title) pick.title = t.title; }
      pick.addEventListener('click', () => { closePop(); deps.onSelect(t); });

      // A row the caller exempts renders with no × at all, rather than a
      // disabled one: there is nothing on the box for it to name.
      if (deps.canKill && !deps.canKill(t)) { li.append(pick); return li; }

      const kill = document.createElement('button');
      kill.type = 'button';
      kill.className = 'session-picker-kill';
      kill.tabIndex = -1;
      const armed = arm.armed === rowKey(t);
      // The × stays enabled on a disabled row: an unswitchable NAME is about
      // PATCH round-tripping, which the kill path does not do at all.
      if (armed) {
        kill.classList.add('armed');
        kill.textContent = killLegend(t, isSoleWindow(opts, t));
      } else {
        kill.textContent = '×';
        kill.title = killLegend(t, isSoleWindow(opts, t));
      }
      kill.setAttribute('aria-label', killLegend(t, isSoleWindow(opts, t)));
      kill.addEventListener('click', (e) => { e.stopPropagation(); clickKill(t); });

      li.append(pick, kill);
      return li;
    }));
    // Restore focus to the equivalent button in the freshly-built row, if any
    // — never to a button focus was not already on, so a render() triggered
    // while focus sits elsewhere on the page (the trigger, the terminal,
    // another modal) can never steal it. A row that no longer exists (just
    // killed, or aged out of the list) simply gets no restore, same as a
    // disabled replacement.
    if (focused) {
      const row = list.querySelector<HTMLElement>(`.session-picker-row[data-key="${CSS.escape(focused.key)}"]`);
      const btn = row?.querySelector<HTMLButtonElement>(focused.cls);
      if (btn && !btn.disabled) btn.focus();
    }
  }

  function focusables(): HTMLButtonElement[] {
    return Array.from(list.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  }

  function openPop() {
    if (open) return;
    open = true;
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Unlike the native <select> this replaces, the popup can be repopulated
    // while it is open — so it opens IMMEDIATELY and the probe lands
    // underneath. That retires the showPicker()/preventDefault dance and the
    // focused-select guard the old control needed.
    void deps.onWillOpen?.({ waitMs: OPEN_REFRESH_WAIT_MS });
    const first = list.querySelector<HTMLButtonElement>('.current .session-picker-pick') ?? focusables()[0];
    first?.focus();
  }

  function closePop(focusTrigger = true) {
    if (!open) return;
    open = false;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    disarm();
    if (focusTrigger) trigger.focus();
  }

  trigger.addEventListener('click', (e) => { e.stopPropagation(); if (open) closePop(); else openPop(); });
  // Mouse-only prefetch: by the time the click lands the list is already
  // current. A finger never sends this, which is why openPop() probes too.
  trigger.addEventListener('pointerenter', (e) => {
    if ((e as PointerEvent).pointerType === 'mouse') void deps.onWillOpen?.();
  });

  pop.addEventListener('keydown', (e) => {
    const keys = focusables();
    const at = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.stopPropagation(); closePop(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rowPicks = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-picker-pick:not([disabled])'));
      const here = rowPicks.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = here < 0 ? 0 : (here + step + rowPicks.length) % rowPicks.length;
      rowPicks[next]?.focus();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rowPicks = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-picker-pick:not([disabled])'));
      (e.key === 'Home' ? rowPicks[0] : rowPicks[rowPicks.length - 1])?.focus();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      keys[Math.min(Math.max(at + step, 0), keys.length - 1)]?.focus();
    }
  });

  // Any click outside closes, which also disarms — the arm-then-fire contract
  // says everything that is not the second click disarms.
  const onDoc = (e: MouseEvent) => { if (open && !el.contains(e.target as Node)) closePop(false); };
  document.addEventListener('click', onDoc);

  // Tab needs a way to leave an open popup. Every row button is tabIndex=-1
  // (focus moves between them programmatically — arrow keys, openPop's initial
  // focus — not via native Tab order), so nothing here stops Tab from moving
  // focus out on its own, and Escape is bound to `pop`, unreachable once focus
  // has already left it. Without this a keyboard user could Tab past the
  // trigger and be left looking at a popup with no keyboard way to close it.
  // Guarded exactly like paneLifecycle.ts's own focusout handler, for the same
  // reason: `next == null` covers a focused button being REMOVED by render()
  // (arming a kill re-renders every row, and the browser reports that as focus
  // leaving to nowhere) — treating that as "focus left" would close the popup
  // in the very repaint that just armed a row. `el.contains(next)` covers
  // every WITHIN-popup move — row-to-row via the arrow keys, a row's pick to
  // its own kill button, and the trigger to the popup's first row when
  // openPop() calls first?.focus() — none of which are "leaving".
  el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next == null || el.contains(next)) return;
    closePop(false);
  });

  const update = (l: SessionTargetList | null) => {
    if (arm.armed) { pendingList = l; return; }
    current = l;
    el.hidden = !l || l.options.length === 0;
    render();
  };

  const destroy = () => {
    document.removeEventListener('click', onDoc);
    clearTimeout(armTimer);
  };

  update(null);
  return { el, update, close: () => closePop(false), destroy };
}
