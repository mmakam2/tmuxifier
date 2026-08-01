// Proxmox lifecycle controls for a pane header (spec:
// docs/superpowers/specs/2026-07-27-pane-lifecycle-controls-design.md).
// House pattern: a pure, unit-tested core here, the DOM control below it.
import { pve, type LifecycleStatus, type PveGuestState } from './proxmox';
import { createSetupJobPoller } from './setupPoller';
import { armReduce as armReduceBase, ARM_MS, type ArmState as BaseArmState } from './arming';

export type PaneState = 'terminal' | 'stopped' | 'setup';
export type ArmableAction = 'shutdown' | 'reboot' | 'stop';
export type PaneLifecycleAction = 'start' | ArmableAction;

export interface LifecycleKey {
  action: PaneLifecycleAction;
  // The word drawn on the cap. These were glyphs (⏻ ↺ ■ ▶) until the reboot
  // arrow '↺' proved indistinguishable from the Reconnect button's '↻' sitting
  // in the same header — mirror images, one power-cycling a container and the
  // other destroying a tmux session. A word cannot be mistaken for its mirror.
  // It also retired two workarounds: a font-fallback dodge here (U+25A0 stood in
  // for U+23F9, absent from the bundled Meslo face) and four per-glyph optical
  // size corrections in style.css.
  face: string;
  label: string;
  // null = fires on the first click. Non-null is the legend the key shows
  // while armed, and the marker that it needs arming at all.
  armLegend: string | null;
  danger: boolean;
}

const START: LifecycleKey = { action: 'start', face: 'START', label: 'Start guest', armLegend: null, danger: false };
const RUNNING_KEYS: LifecycleKey[] = [
  { action: 'shutdown', face: 'SHUTDOWN', label: 'Shut down guest', armLegend: 'SHUTDOWN?', danger: false },
  { action: 'reboot', face: 'REBOOT', label: 'Reboot guest', armLegend: 'REBOOT?', danger: false },
  { action: 'stop', face: 'STOP', label: 'Force stop guest', armLegend: 'STOP?', danger: true },
];

// Driven by the pane's derived state first, the raw PVE read second: paneState
// (main.ts) already treats an 'unknown' read as sticky for a pane showing its
// stopped panel, so a blind probe cannot strip the Start key off a stopped box.
// Setup wins over everything — a box mid-setup is running, and every action
// here would interrupt the job that just provisioned it. 'missing', 'unknown'
// and 'mismatch' all fall through to no keys: the last of those because the
// guest at this vmid may not be ours, matching proxmoxGuests.ts's actionsForState.
export function lifecycleKeysFor(paneState: PaneState, pveState: PveGuestState | undefined): LifecycleKey[] {
  if (paneState === 'setup') return [];
  if (paneState === 'stopped') return [START];
  if (pveState === 'running') return RUNNING_KEYS;
  return [];
}

export interface ArmState { armed: ArmableAction | null }
export const IDLE: ArmState = { armed: null };

export type ArmEvent =
  | { type: 'click'; key: LifecycleKey }
  | { type: 'timeout' }
  | { type: 'dismiss' }
  | { type: 'keysChanged' };

export interface ArmOutcome { state: ArmState; fire: PaneLifecycleAction | null }

// Arm-then-fire: a destructive key must be clicked twice, anything else
// disarms. Start is never armable — starting a stopped container loses nothing.
// The policy itself lives in arming.ts, shared with the Reconnect buttons; this
// wrapper only maps a LifecycleKey onto it and re-narrows the action types.
export function armReduce(state: ArmState, event: ArmEvent): ArmOutcome {
  const base: BaseArmState = { armed: state.armed };
  const outcome = event.type === 'click'
    ? armReduceBase(base, { type: 'click', id: event.key.action, armable: event.key.armLegend != null })
    : armReduceBase(base, { type: 'dismiss' });
  return {
    state: { armed: (outcome.state.armed as ArmableAction | null) ?? null },
    fire: (outcome.fire as PaneLifecycleAction | null) ?? null,
  };
}

export type ChipStatus = LifecycleStatus | 'lost';
export interface LifecycleChip { text: string; cls: string; settled: boolean }

const IN_PROGRESS: Record<PaneLifecycleAction, string> = {
  start: 'starting…', shutdown: 'shutting down…', reboot: 'rebooting…', stop: 'stopping…',
};
const FAILED: Record<PaneLifecycleAction, string> = {
  start: 'start failed', shutdown: 'shutdown failed', reboot: 'reboot failed', stop: 'stop failed',
};

// `settled` is the authority flag: an in-flight chip owns the slot and blocks a
// key rebuild, a settled one is just the last outcome and yields to new keys.
export function chipFor(action: PaneLifecycleAction, status: ChipStatus): LifecycleChip | null {
  if (status === 'running') return { text: IN_PROGRESS[action], cls: 'chip-state', settled: false };
  if (status === 'done') return null;
  if (status === 'lost') return { text: 'lost track of job', cls: 'chip-error', settled: true };
  return { text: FAILED[action], cls: 'chip-error', settled: true };
}

export interface PaneLifecycleInput { paneState: PaneState; pveState: PveGuestState | undefined }

export interface PaneLifecycleDeps {
  boxId: string;
  // jobId is null when the job never got created (the POST itself failed), so
  // the caller opens the Containers tab instead of a log that does not exist.
  onOpenJobLog: (jobId: string | null) => void;
  onSettled: () => void;
  createJob?: (spec: { boxId: string; action: PaneLifecycleAction }) => Promise<{ id: string }>;
  fetchJob?: (id: string) => Promise<{ status: LifecycleStatus; error: string | null }>;
}

const POLL_MS = 1500;
const MAX_MISSES = 3;

export function buildPaneLifecycle(deps: PaneLifecycleDeps): {
  el: HTMLElement; update(i: PaneLifecycleInput): void; destroy(): void;
} {
  const createJob = deps.createJob ?? ((spec) => pve.createLifecycleJob(spec));
  const fetchJob = deps.fetchJob ?? ((id: string) => pve.lifecycleJob(id));

  const el = document.createElement('span');
  el.className = 'pane-lifecycle';

  let keys: LifecycleKey[] = [];
  let rendered: string | null = null; // key-set signature currently in the DOM
  let arm: ArmState = IDLE;
  let armTimer: number | null = null;
  let chip: LifecycleChip | null = null;
  let chipTitle = '';
  let chipJobId: string | null = null;
  let poller: { start: () => void; stop: () => void } | null = null;
  let misses = 0;

  const clearArmTimer = () => { if (armTimer != null) { window.clearTimeout(armTimer); armTimer = null; } };

  const disarm = () => {
    if (arm.armed == null) return;
    clearArmTimer();
    arm = armReduce(arm, { type: 'dismiss' }).state;
    paint();
  };

  // A click anywhere outside this control disarms — the "anything else" half of
  // arm-then-fire. Capture phase so it lands before the pane's own handlers.
  // A click on a sibling key is NOT outside, so it moves the arm instead.
  const onDocMouseDown = (e: MouseEvent) => { if (!el.contains(e.target as Node)) disarm(); };
  const onDocKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') disarm(); };
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  // Keyboard focus leaving the control disarms. Guarded twice, because paint()
  // replaces the buttons: a focusout caused by the focused button being removed
  // reports a null relatedTarget, and treating that as "focus left" would
  // disarm the key in the very repaint that just armed it.
  el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next == null || el.contains(next)) return;
    disarm();
  });

  function paint() {
    if (chip) {
      const span = document.createElement('span');
      span.className = `pane-chip ${chip.cls}`;
      span.textContent = chip.text;
      if (chipTitle) span.title = chipTitle;
      if (chip.settled) {
        span.setAttribute('role', 'button');
        span.tabIndex = 0;
        const open = () => { deps.onOpenJobLog(chipJobId); chip = null; chipTitle = ''; chipJobId = null; rendered = null; paint(); };
        span.addEventListener('click', (e) => { e.stopPropagation(); open(); });
        span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
      el.replaceChildren(span);
      return;
    }
    el.replaceChildren(...keys.map((key) => {
      const armed = arm.armed === key.action;
      const btn = document.createElement('button');
      btn.type = 'button';
      // The action class is now only a styling hook (the per-glyph optical size
      // corrections it used to carry died with the glyphs). Armed differs from
      // idle by one '?' and the colour, so the cap barely changes width.
      btn.className = `pane-life pane-life-${key.action}${key.danger ? ' danger' : ''}${armed ? ' armed' : ''}`;
      btn.textContent = armed ? key.armLegend! : key.face;
      btn.title = armed ? `Click again to ${key.action}` : key.label;
      btn.setAttribute('aria-label', armed ? `Confirm ${key.action}` : key.label);
      btn.addEventListener('click', (e) => { e.stopPropagation(); onKeyClick(key); });
      return btn;
    }));
  }

  function onKeyClick(key: LifecycleKey) {
    clearArmTimer();
    const outcome = armReduce(arm, { type: 'click', key });
    arm = outcome.state;
    if (outcome.fire) { void fire(outcome.fire); return; }
    armTimer = window.setTimeout(() => { armTimer = null; arm = armReduce(arm, { type: 'timeout' }).state; paint(); }, ARM_MS);
    paint();
    // paint() replaced the button that was just clicked; put focus on its
    // armed replacement so a keyboard user can confirm with Enter.
    el.querySelector<HTMLElement>('.pane-life.armed')?.focus();
  }

  async function fire(action: PaneLifecycleAction) {
    chip = chipFor(action, 'running');
    chipTitle = '';
    chipJobId = null;
    paint();
    let id: string;
    try {
      id = (await createJob({ boxId: deps.boxId, action })).id;
    } catch (error) {
      // The server's own guards land here: a 409 for an active job on the same
      // container, or for an action the container's real state cannot take.
      chip = chipFor(action, 'error');
      chipTitle = error instanceof Error ? error.message : 'Lifecycle action failed';
      paint();
      return;
    }
    chipJobId = id;
    misses = 0;
    poller?.stop();
    poller = createSetupJobPoller<{ status: LifecycleStatus; error: string | null }>({
      fetchJob: () => fetchJob(id),
      onJob: (job) => {
        if (!job) {
          // A rejected fetch reaches the policy as null (setupPoller's
          // contract). Transient until it isn't.
          misses += 1;
          if (misses < MAX_MISSES) return POLL_MS;
          chip = chipFor(action, 'lost');
          chipTitle = '';
          paint();
          return null;
        }
        misses = 0;
        if (job.status === 'running') return POLL_MS;
        chip = chipFor(action, job.status);
        chipTitle = job.error ?? '';
        // A finished job leaves the container in a new state; ask for a status
        // poll now rather than waiting out the 30s tick.
        if (chip == null) { chipJobId = null; rendered = null; }
        paint();
        deps.onSettled();
        return null;
      },
    });
    poller.start();
  }

  function update(i: PaneLifecycleInput) {
    const next = lifecycleKeysFor(i.paneState, i.pveState);
    const signature = next.map((k) => k.action).join(',');
    if (chip && !chip.settled) return; // an in-flight job owns the slot
    if (signature === rendered) return; // no change; a settled chip stays put
    keys = next;
    rendered = signature;
    chip = null;
    chipTitle = '';
    chipJobId = null;
    clearArmTimer();
    arm = armReduce(arm, { type: 'keysChanged' }).state;
    paint();
  }

  function destroy() {
    poller?.stop();
    poller = null;
    clearArmTimer();
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }

  return { el, update, destroy };
}
