import type { PushResult, SeedResult, SetupJob, SetupStatus } from './api';

export function setupStatusText(job: Pick<SetupJob, 'status' | 'phase' | 'error' | 'needs'>): string {
  switch (job.status) {
    case 'running':
      return job.phase === 'waiting-ssh' ? 'Waiting for SSH…'
        : job.phase === 'seeding' ? 'Seeding AI credentials…'
        : job.phase === 'statusline' ? 'Configuring statusline…'
        : job.phase === 'agent-hooks' ? 'Installing agent hooks…'
        : job.phase === 'script' ? 'Running saved script…'
        : 'Running setup…';
    case 'done': return 'Setup complete ✓';
    case 'error': return `Setup failed${job.error ? ` — ${job.error}` : ''}`;
    // `needs` records which credential the run stalled on. It defaults to the
    // sudo wording because jobs persisted before that field existed could only
    // ever have parked for sudo.
    case 'needs-interactive':
      return job.needs === 'ssh'
        ? 'Needs an SSH password — finish interactively'
        : 'Needs sudo password — finish interactively';
    case 'interrupted': return 'Setup interrupted (server restarted) — retry';
    default: return String(job.status);
  }
}

// How a status line for this job should read at a glance. `attention` is the
// load-bearing one: a `needs-interactive` job has not failed, it is parked
// waiting for the operator to type a credential. DESIGN.md gives that state to
// Safety Orange ("operator action needed"), not LED Red ("down, error"), and
// the panel used to paint it with the same class a failed run got — so an
// onboarding pause looked like a dead end rather than a prompt.
export type SetupTone = '' | 'success' | 'error' | 'attention';
export function setupStatusTone(status: SetupStatus): SetupTone {
  switch (status) {
    case 'done': return 'success';
    case 'needs-interactive': return 'attention';
    case 'error':
    case 'interrupted': return 'error';
    default: return '';
  }
}

export type SetupAction = 'finish-interactive' | 'retry' | 'remove' | 'close';
export function setupActions(status: SetupStatus): SetupAction[] {
  switch (status) {
    case 'running':
    case 'done': return ['close'];
    case 'needs-interactive': return ['finish-interactive', 'remove', 'close'];
    case 'error':
    case 'interrupted': return ['retry', 'remove', 'close'];
    default: return ['close'];
  }
}

export function setupBadge(status: SetupStatus, needs?: SetupJob['needs']): { text: string; cls: string } | null {
  switch (status) {
    case 'running': return { text: 'setting up', cls: 'badge-info' };
    case 'error':
    case 'interrupted': return { text: 'setup failed', cls: 'badge-warn' };
    case 'needs-interactive':
      return { text: needs === 'ssh' ? 'needs password' : 'needs sudo', cls: 'badge-warn' };
    default: return null;
  }
}

// One line summarising a job's seed outcome, e.g.
// "claude ✓ · codex skipped (no codex auth on the Tmuxifier host)".
// Empty string when nothing was seeded, so callers can test it for truthiness
// rather than special-casing old jobs that have no seed field at all.
export function formatSeedResults(seed: SeedResult[] | null | undefined): string {
  if (!seed || !seed.length) return '';
  return seed
    .map((r) => `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`)
    .join(' · ');
}

// One-line summary of a single post-setup step's outcome — statusline,
// agent-hooks, or the saved script, the shape is target-generic — e.g.
// "statusline ✓" / "agent-hooks skipped (no Claude on the box)" /
// "bootstrap failed (exited 2)". Empty string when the step never ran, so
// callers test it for truthiness and old jobs without the field render nothing.
export function formatStatuslineResult(statusline: PushResult | null | undefined): string {
  if (!statusline) return '';
  const r = statusline;
  return `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`;
}

// Whether a setup job in this status must prevent opening the box's terminal.
// Only `running` does. A shell reads its rc files once at startup, so one
// opened mid-setup holds an environment that predates the seeded credentials
// and the installed tools — but `needs-interactive`, `error`, and `interrupted`
// are paused or dead states where nothing is mutating the box and a shell is
// often exactly what's needed. Gating those would make a box unreachable.
export function blocksTerminal(status?: SetupStatus | null): boolean {
  return status === 'running';
}
