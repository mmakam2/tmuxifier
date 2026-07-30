// The lifecycle job-detail poll policy, pure so it can be tested in the node
// environment the suite runs in (the viewer itself is DOM code in proxmoxUi.ts).
//
// E4 (2026-07-29 review): the viewer did `pve.lifecycleJob(id).catch(() => null)`
// and rescheduled on every null. That collapsed two different situations into
// one — a job pruned from the history (404, never coming back) and a request
// that happened to fail (offline, restart mid-poll) — and answered both by
// polling forever behind an empty log, with nothing on screen to say so.
//
// A 404 is decided immediately: the id is gone, and no amount of waiting brings
// it back. Anything else is treated as transient and retried, but bounded, so a
// controller that has stopped answering ends in a message rather than a silent
// timer.

export const MAX_TRANSIENT_FAILURES = 5;

export type LifecyclePollStep =
  /** A job came back: paint it. `done` is false while it is still running. */
  | { action: 'render'; done: boolean }
  /** Transient failure, under the cap: poll again. */
  | { action: 'retry' }
  /** Stop, and tell the operator why. */
  | { action: 'give-up'; message: string };

export function lifecyclePollStep(
  { job, errorStatus, failures }: { job: { status: string } | null; errorStatus: number; failures: number },
): LifecyclePollStep {
  if (job) return { action: 'render', done: job.status !== 'running' };
  // 404 is the authoritative answer, not a failure to get one.
  if (errorStatus === 404) {
    return { action: 'give-up', message: 'This job is no longer in the history — it has been pruned.' };
  }
  // 401 is the session expiring. The fetch layer's seam is already tearing the
  // workspace down, so this must not keep polling behind the login screen.
  if (errorStatus === 401) {
    return { action: 'give-up', message: 'Session expired.' };
  }
  if (failures + 1 >= MAX_TRANSIENT_FAILURES) {
    return {
      action: 'give-up',
      message: `Could not load this job after ${MAX_TRANSIENT_FAILURES} attempts — close and reopen to try again.`,
    };
  }
  return { action: 'retry' };
}
