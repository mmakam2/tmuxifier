// Session choice for a DUPLICATE pane (spec: adopt-then-create). Pure — the
// caller supplies the snapshot's session list and the set of sessions other
// panes of this box already show.
import { isSwitchableSession } from './paneHeader';

export function chooseDuplicateSession(configured: string, liveSessions: string[], shown: string[]): string {
  const taken = new Set(shown);
  // Adopt first: the first live session no pane shows, in snapshot order
  // (deterministic — the probe reports `tmux ls` order). Unswitchable names
  // are skipped, not offered: /term's strict validation would refuse them.
  for (const name of liveSessions) {
    if (name && !taken.has(name) && isSwitchableSession(name)) return name;
  }
  // Create only when dry: first `<configured>-N` in neither the live list nor
  // the shown set (the union guards two quick drops against a stale snapshot).
  const all = new Set([...liveSessions, ...shown]);
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = configured.slice(0, 64 - suffix.length) + suffix;
    if (!all.has(candidate)) return candidate;
  }
}
