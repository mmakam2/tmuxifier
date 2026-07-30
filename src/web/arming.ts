// Arm-then-fire: a control whose action cannot be undone is clicked twice — the
// first click arms it and states its consequence, the second commits.
//
// Extracted from paneLifecycle.ts when the Reconnect buttons needed the same
// guard (they kill the box's tmux session, and a misclick costs whatever was
// running in it). The reducer IS the policy, so sharing it means the next
// armable control inherits the behaviour instead of re-deriving it — and the
// disarm cases, which are the easy half to get subtly wrong, exist once.
export interface ArmState { armed: string | null }
export const IDLE: ArmState = { armed: null };

export type ArmEvent =
  // `armable: false` is a control with nothing to lose (Start), which fires on
  // the first click but still disarms whatever else was armed.
  | { type: 'click'; id: string; armable: boolean }
  | { type: 'timeout' }
  | { type: 'dismiss' }
  | { type: 'reset' };

export interface ArmOutcome { state: ArmState; fire: string | null }

// How long an armed control stays armed. Long enough to read the legend and
// click again deliberately; short enough that an arm forgotten mid-thought
// cannot be committed by an unrelated click a minute later.
export const ARM_MS = 3000;

export function armReduce(state: ArmState, event: ArmEvent): ArmOutcome {
  // Everything that is not a click disarms: the timeout, Escape, focus leaving
  // the control, or the control's own key set changing underneath it.
  if (event.type !== 'click') return { state: IDLE, fire: null };
  // Nothing to confirm.
  if (!event.armable) return { state: IDLE, fire: event.id };
  // Second click on the same control: commit, and disarm in the same step so a
  // third click cannot fire again.
  if (state.armed === event.id) return { state: IDLE, fire: event.id };
  // First click — or a click on a sibling, which MOVES the arm rather than
  // firing either one.
  return { state: { armed: event.id }, fire: null };
}
