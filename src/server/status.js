import { buildProbeArgv } from './sshCommand.js';

export const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';

export const PROBE_REMOTE =
  `if command -v tmux >/dev/null 2>&1; then tmux ls -F '${STATUS_FMT}' 2>/dev/null || true; else echo __NO_TMUX__; fi`;

export function parseTmuxSessions(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes('__NO_TMUX__'))
    .map((line) => {
      const [name, windows, attached, activity] = line.split(':');
      return { name, windows: Number(windows), attached: attached === '1', activity: Number(activity) };
    });
}

export function createStatusChecker({ run, hostKeyPolicy = 'accept-new' }) {
  const remote = PROBE_REMOTE;
  return {
    async checkBox(box) {
      try {
        const argv = buildProbeArgv(box, remote, { hostKeyPolicy });
        const res = await run(argv);
        if (res.code !== 0 && !String(res.stdout).trim()) {
          return { reachable: false, error: String(res.stderr || '').trim() || 'unreachable' };
        }
        if (String(res.stdout).includes('__NO_TMUX__')) {
          return { reachable: true, tmux: false, sessions: [] };
        }
        return { reachable: true, tmux: true, sessions: parseTmuxSessions(res.stdout) };
      } catch (e) {
        return { reachable: false, error: String((e && e.message) || e) };
      }
    },
  };
}
