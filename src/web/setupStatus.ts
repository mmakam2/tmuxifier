import type { SeedResult, SetupJob, SetupStatus } from './api';

export function setupStatusText(job: Pick<SetupJob, 'status' | 'phase' | 'error'>): string {
  switch (job.status) {
    case 'running':
      return job.phase === 'waiting-ssh' ? 'Waiting for SSH…'
        : job.phase === 'seeding' ? 'Seeding AI credentials…'
        : job.phase === 'statusline' ? 'Configuring statusline…'
        : 'Running setup…';
    case 'done': return 'Setup complete ✓';
    case 'error': return `Setup failed${job.error ? ` — ${job.error}` : ''}`;
    case 'needs-interactive': return 'Needs sudo password — finish interactively';
    case 'interrupted': return 'Setup interrupted (server restarted) — retry';
    default: return String(job.status);
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

export function setupBadge(status: SetupStatus): { text: string; cls: string } | null {
  switch (status) {
    case 'running': return { text: 'setting up', cls: 'badge-info' };
    case 'error':
    case 'interrupted': return { text: 'setup failed', cls: 'badge-warn' };
    case 'needs-interactive': return { text: 'needs sudo', cls: 'badge-warn' };
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

// One-line summary of a job's statusline-push outcome, e.g.
// "statusline ✓" / "statusline skipped (no Claude on the box)".
// Empty string when nothing was pushed, so callers test it for truthiness and
// old jobs without a statusline field render nothing.
export function formatStatuslineResult(statusline: SeedResult | null | undefined): string {
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
