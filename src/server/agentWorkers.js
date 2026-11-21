// Agent workers: the remote script that starts an interactive agent on a box in its own
// detached tmux session, and the parser for its one result line (design section 5.2).
//
// The script runs over ssh under the box's LOGIN shell (sh, bash or zsh, bare PATH) and ends
// every run with one `WORKER: <code>` line and exit 0, in this order:
//
//   tmux resolved (command -v, then the fallback sweep)   else  WORKER: no-tmux
//   [ -d '<dir>' ]                                        else  WORKER: no-dir
//   the agent is installed (on PATH or ~/.local/bin)      else  WORKER: no-agent-binary
//   no session named exactly '=<session>'                 else  WORKER: exists
//   new-session ... (the launch line below)               then  WORKER: started
//
// `set -eu`: a tmux failure on the launch exits non-zero with no `WORKER:` line, so the caller
// never reads a failed launch as `started`.
//
// The launch line (spike of 2026-11-19, design section 4; Claude Code 2.1.328, tmux 3.6):
//
//   | How the session is created                                         | Result                |
//   |--------------------------------------------------------------------|-----------------------|
//   | new-session -d -s <name> -c <dir> 'claude'                         | Fails                 |
//   | new-session -d -s <name> -c <dir>, then send-keys `claude`         | Works, leaves a shell |
//   | new-session -d -s <name> -c <dir> "exec <shell> -ic 'exec claude'" | Works, zsh and bash   |
//   | the same with -lic                                                 | Works                 |
//
// The plain command fails because tmux runs it with `default-shell -c`, a non-interactive
// shell that reads no rc file: the rc lines setup wrote are what put ~/.local/bin on PATH and
// export the Claude token, so `claude` is not found (and would have no token), and the session
// ends at once with no trace. `exec "$SHELL" -ic 'exec claude'` makes the pane an interactive
// shell that reads its rc files and then becomes the agent, so `pane_current_command` is the
// agent and `/exit` ends the session instead of leaving a shell behind. `"$SHELL"` is single-
// quoted in this script, so it is expanded inside tmux, where tmux sets SHELL to its own
// default-shell for the command it runs: the pane's shell is the one an operator's own panes
// get, whatever the login shell running this script is
// (test/agentWorkerScript.integration.test.js pins every pairing of sh/bash/zsh script shell
// and bash/zsh default-shell).
//
// Everything interpolated is checked here, immediately before it is single-quoted: the session
// against SESSION_NAME_RE (validated, never rewritten: no sanitizeSession), the directory
// against isWorkerDir (a stored record is a file, not proof), and the launch word comes from
// the closed WORKER_AGENTS table by an own-key lookup. Nothing a lead sent is in the script.

import { SESSION_NAME_RE, shSingleQuote } from './sshCommand.js';
import { WORKER_AGENTS, isWorkerDir } from './agentWorkerRules.js';

export const WORKER_CODES = Object.freeze(['started', 'exists', 'no-tmux', 'no-dir', 'no-agent-binary']);

// The launch word is a table constant, re-checked anyway: it reaches the script unquoted
// inside `command -v`, the ~/.local/bin test and the launch line.
const LAUNCH_WORD_RE = /^[a-z][a-z0-9-]{0,31}$/;

const RESULT_LINE_RE = /^WORKER: ([a-z-]+)$/;

// `trust` is accepted for the caller's sake; the folder-trust write (design section 5.5) is
// not part of this script yet.
export function buildWorkerStartRemote({ session, dir, agent = 'claude', trust = false } = {}) {
  void trust;
  if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) throw new Error('bad worker session name');
  if (!isWorkerDir(dir)) throw new Error('bad worker directory');
  if (typeof agent !== 'string' || !Object.hasOwn(WORKER_AGENTS, agent)) throw new Error('unknown worker agent');
  const word = WORKER_AGENTS[agent].launch;
  if (typeof word !== 'string' || !LAUNCH_WORD_RE.test(word)) throw new Error('bad worker launch word');

  const sess = shSingleQuote(session);
  const exact = shSingleQuote(`=${session}`);
  const qdir = shSingleQuote(dir);
  const launch = shSingleQuote(`exec "$SHELL" -ic 'exec ${word}'`);
  return [
    'set -eu',
    // Same resolution as buildEnsureSessionRemote: the login shell's PATH is not an
    // interactive shell's.
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    "if [ -z \"$TMUX_BIN\" ]; then echo 'WORKER: no-tmux'; exit 0; fi",
    `if [ ! -d ${qdir} ]; then echo 'WORKER: no-dir'; exit 0; fi`,
    // The same presence test as the hook installer.
    `if ! command -v ${word} >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/${word}" ]; then echo 'WORKER: no-agent-binary'; exit 0; fi`,
    // Exact target: a bare name prefix-matches (`worker-api-1` would hit `worker-api-10`).
    `if "$TMUX_BIN" has-session -t ${exact} 2>/dev/null; then echo 'WORKER: exists'; exit 0; fi`,
    `"$TMUX_BIN" new-session -d -s ${sess} -c ${qdir} ${launch}`,
    "echo 'WORKER: started'",
  ].join('\n');
}

// The code of the last line that is exactly `WORKER: <code>` with a known code; else null.
// The script's output is box output: nothing is trimmed into a match.
export function parseWorkerResult(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = RESULT_LINE_RE.exec(lines[i]);
    if (m && WORKER_CODES.includes(m[1])) return m[1];
  }
  return null;
}
