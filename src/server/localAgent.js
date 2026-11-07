// The Host Shell's stand-in for the SSH status probe: reads the host's OWN
// tmux sessions and ~/.tmuxifier-agent/ markers (written by the locally
// installed Claude Code hook — see claudeAgentHooks.js) and shapes them
// exactly like a box probe result, so healthHistory.sampleOf() and everything
// downstream (badge, pane chip, agent-input/agent-done events) work
// unchanged. Fed to healthHistory by statusPoller as the `__local__`
// pseudo-box; never part of the /api/status snapshot.
//
// Marker files and tmux output are input, not trusted: both only ever pass
// through the same allowlisting parsers the SSH probe output goes through.
// The sample is always `reachable` (this host IS the server) and never
// carries metrics, so classifyTransitions can structurally never emit
// down/up/needs-auth/threshold events for it — only the agent edges.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { STATUS_FMT, parseTmuxSessions, parseAgentMarks } from './status.js';

// Matches LOCAL_GROUP in sessions.js and the client's pane id. Defined here
// rather than imported from sessions.js so statusPoller's import chain stays
// free of node-pty.
export const LOCAL_BOX_ID = '__local__';

const MARK_MAX_BYTES = 200; // same cap the on-box probe applies (head -c 200)
const TMUX_TIMEOUT_MS = 5000;

function runTmuxDefault(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: TMUX_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        // A spawn failure carries a string errno (ENOENT = tmux not installed);
        // a non-zero exit carries a numeric code and no errno.
        errno: err && typeof err.code === 'string' ? err.code : undefined,
      });
    });
  });
}

// tmux's own wording when there is no server to list: `no server running on
// <socket>` (nothing started) or `error connecting to <socket> (No such file
// or directory)` (a stale socket path). Those, and tmux not being installed at
// all, are a genuine EMPTY listing. Anything else — a timeout, a wedged or
// crashing server, a permission error — is "listing unknown", which must not
// read as "every session ended".
const NO_SERVER_RE = /no server running|error connecting to/i;
function isNoServer(res) {
  return res.errno === 'ENOENT' || NO_SERVER_RE.test(String(res.stderr || ''));
}

// Mirror of the on-box AGENT_PROBE shell fragment: each marker file becomes
// one `__AGENT__ <content>` line — capped, newline-stripped — then the same
// parser that handles probe stdout applies its closed state set and numeric
// timestamp allowlist.
export async function readAgentMarks(home) {
  const dir = path.join(home, '.tmuxifier-agent');
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const lines = [];
  for (const name of names) {
    try {
      // Read regular files only, and only small ones. stat() follows symlinks,
      // matching the on-box probe's `[ -f "$f" ]`; the size cap is what closes
      // the read-it-all-then-truncate gap — readFile on a FIFO would block
      // forever, and the 200-byte cap below is applied only after the whole
      // file is already in memory.
      const st = await fs.promises.stat(path.join(dir, name));
      if (!st.isFile() || st.size > MARK_MAX_BYTES * 8) continue;
      const buf = await fs.promises.readFile(path.join(dir, name));
      lines.push('__AGENT__ ' + buf.subarray(0, MARK_MAX_BYTES).toString('utf8').replace(/\n/g, ''));
    } catch { /* unreadable marker: skip it, keep the rest */ }
  }
  return parseAgentMarks(lines.join('\n'));
}

export function createLocalAgentSampler({ home = os.homedir(), runTmux = runTmuxDefault } = {}) {
  return {
    // Never rejects: a sampler failure must never disturb the poll loop.
    async sample() {
      const out = { reachable: true };
      try {
        const res = await runTmux(['ls', '-F', STATUS_FMT]);
        // Exit 1 is ambiguous on its own: tmux uses it for "no server
        // running" AND for real failures, and a timed-out execFile reports
        // a non-zero code too. The message resolves it. Only a genuine
        // no-server (or tmux absent) is an empty listing; any other failure
        // leaves `sessions` OUT of the sample, which sampleOf and record()
        // treat as "not observed" — so a slow tmux cannot read as every
        // session having exited, nor prune the Host Shell's seen watermark.
        // The tmux flag is only asserted when the listing actually succeeded.
        if (res.code === 0) {
          out.tmux = true;
          out.sessions = parseTmuxSessions(res.stdout);
        } else if (isNoServer(res)) {
          out.sessions = [];
        }
      } catch (err) {
        if (err && err.code === 'ENOENT') out.sessions = []; // tmux not installed
      }
      try {
        const marks = await readAgentMarks(home);
        if (marks) out.agentMarks = marks;
      } catch { /* marker dir unreadable: no agent state */ }
      return out;
    },
  };
}
