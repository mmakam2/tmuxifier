import type { Status } from './api';

type DotClass = 'gray' | 'green' | 'amber' | 'red' | 'auth';

// Single source of truth for the box status dot. `needsAuth` wins over a plain
// unreachable result: a password-auth box whose SSH master expired is not dead,
// it just needs the user to re-open the terminal and enter the password.
export function dotClassFor(st: Status | undefined): DotClass {
  if (!st) return 'gray';
  if (st.needsAuth) return 'auth';
  if (!st.reachable) return 'red';
  return st.tmux === false ? 'amber' : 'green';
}

export function dotTitleFor(st: Status | undefined): string {
  if (!st) return 'Status unknown';
  if (st.needsAuth) return 'Needs login — click the box (or ↻) to reconnect and enter your password';
  if (!st.reachable) return st.paused
    ? 'Unreachable — retrying every 5m; click the box or ↻ to retry now'
    : 'Unreachable';
  return st.tmux === false ? 'Reachable (tmux not running)' : 'Connected';
}
