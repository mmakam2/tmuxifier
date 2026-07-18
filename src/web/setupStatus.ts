import type { SetupJob, SetupStatus } from './api';

export function setupStatusText(job: Pick<SetupJob, 'status' | 'phase' | 'error'>): string {
  switch (job.status) {
    case 'running': return job.phase === 'waiting-ssh' ? 'Waiting for SSH…' : 'Running setup…';
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
