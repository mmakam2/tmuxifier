// Proxmox lifecycle controls for a pane header (spec:
// docs/superpowers/specs/2026-07-27-pane-lifecycle-controls-design.md).
// House pattern: a pure, unit-tested core here, the DOM control below it.
import type { LifecycleStatus, PveContainerState } from './proxmox';

export type PaneState = 'terminal' | 'stopped' | 'setup';
export type ArmableAction = 'shutdown' | 'reboot' | 'stop';
export type PaneLifecycleAction = 'start' | ArmableAction;

export interface LifecycleKey {
  action: PaneLifecycleAction;
  glyph: string;
  label: string;
  // null = fires on the first click. Non-null is the legend the key shows
  // while armed, and the marker that it needs arming at all.
  armLegend: string | null;
  danger: boolean;
}

const START: LifecycleKey = { action: 'start', glyph: '▶', label: 'Start container', armLegend: null, danger: false };
const RUNNING_KEYS: LifecycleKey[] = [
  { action: 'shutdown', glyph: '⏻', label: 'Shut down container', armLegend: 'SHUTDOWN?', danger: false },
  { action: 'reboot', glyph: '↺', label: 'Reboot container', armLegend: 'REBOOT?', danger: false },
  { action: 'stop', glyph: '⏹', label: 'Force stop container', armLegend: 'STOP?', danger: true },
];

// Driven by the pane's derived state first, the raw PVE read second: paneState
// (main.ts) already treats an 'unknown' read as sticky for a pane showing its
// stopped panel, so a blind probe cannot strip the Start key off a stopped box.
// Setup wins over everything — a box mid-setup is running, and every action
// here would interrupt the job that just provisioned it.
export function lifecycleKeysFor(paneState: PaneState, pveState: PveContainerState | undefined): LifecycleKey[] {
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
export function armReduce(state: ArmState, event: ArmEvent): ArmOutcome {
  if (event.type !== 'click') return { state: IDLE, fire: null };
  const { key } = event;
  if (key.armLegend == null) return { state: IDLE, fire: key.action };
  if (state.armed === key.action) return { state: IDLE, fire: key.action };
  return { state: { armed: key.action as ArmableAction }, fire: null };
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
