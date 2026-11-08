import { writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

// A fake `tmux` (sh script) for the OSC 7501 reporter tests. Behaviour is
// driven by env vars pointing at files the test can rewrite between calls:
//   STUB_TMUX_LOG       every call's argv, one line per call (appended)
//   STUB_TMUX_SESSIONS  `N=name` lines; display-message -p -t %N prints name
//   STUB_TMUX_PANES     printed verbatim by list-panes
//   STUB_TMUX_NOSERVER  =1 -> every call fails "no server running"
// pipe-pane / run-shell print nothing and succeed (they are only logged).
const SCRIPT = `#!/bin/sh
echo "$*" >> "$STUB_TMUX_LOG"
if [ "$STUB_TMUX_NOSERVER" = 1 ]; then
  echo "no server running on /tmp/x" >&2
  exit 1
fi
case "$1" in
  display-message)
    pane=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      shift
    done
    n="\${pane#%}"
    if [ -f "$STUB_TMUX_SESSIONS" ]; then
      while IFS= read -r line; do
        case "$line" in
          "$n="*) printf '%s\\n' "\${line#*=}"; exit 0 ;;
        esac
      done < "$STUB_TMUX_SESSIONS"
    fi
    echo "can't find pane: $pane" >&2
    exit 1 ;;
  list-panes)
    [ -f "$STUB_TMUX_PANES" ] && cat "$STUB_TMUX_PANES"
    exit 0 ;;
  pipe-pane|run-shell)
    exit 0 ;;
  *)
    echo "no server running on /tmp/x" >&2
    exit 1 ;;
esac
`;

/** Write dir/tmux and its state files; returns the env to merge into a child. */
export function makeStubTmux(dir, { sessionOf = {}, panes = [] } = {}) {
  const sessionsFile = path.join(dir, 'stub-sessions');
  const panesFile = path.join(dir, 'stub-panes');
  const logFile = path.join(dir, 'stub-log');
  writeFileSync(path.join(dir, 'tmux'), SCRIPT);
  chmodSync(path.join(dir, 'tmux'), 0o755);
  writeFileSync(sessionsFile, Object.entries(sessionOf).map(([n, s]) => `${n}=${s}\n`).join(''));
  writeFileSync(panesFile, panes.join(''));
  writeFileSync(logFile, '');
  return {
    sessionsFile, panesFile, logFile,
    setSessions: (map) => writeFileSync(sessionsFile, Object.entries(map).map(([n, s]) => `${n}=${s}\n`).join('')),
    env: { STUB_TMUX_LOG: logFile, STUB_TMUX_SESSIONS: sessionsFile, STUB_TMUX_PANES: panesFile },
  };
}
