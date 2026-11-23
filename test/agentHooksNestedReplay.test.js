import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookArgsFor, hookCommand } from '../src/server/claudeAgentHooks.js';

// Replays a recording of a real Claude Code session in whose pane three `claude -p` ran
// (test/fixtures/claude-nested-trace.jsonl, see README-claude-nested-trace.md) through the real
// hook script. Each line carries the payload AND the process chain that fired it, read from
// /proc at the time; the hook reads that chain back through its test-only /proc root. Lines are
// 1-based to match the README. REPLAY_TRAIL=1 prints the marker per line. HOOK_TEST_SHELL picks
// the shell that runs the hook (default /bin/sh), e.g. HOOK_TEST_SHELL='bash --posix' or
// HOOK_TEST_SHELL='busybox sh'.

const SHELL = (process.env.HOOK_TEST_SHELL || '/bin/sh').split(' ');
const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));
const TRACE = fileURLToPath(new URL('./fixtures/claude-nested-trace.jsonl', import.meta.url));

// Fake tmux on PATH. It answers the hook's one call: the session, and the pane's first process
// when the format asks for it.
const TMUX_STUB = `#!/bin/sh
for a in "$@"; do f=$a; done
case $f in
  *pane_pid*) printf 'rec:%s\\n' "$FAKE_PANE_PID" ;;
  *) printf 'rec\\n' ;;
esac
`;

async function env() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nestedreplay-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), TMUX_STUB, { mode: 0o755 });
  return { dir, proc: path.join(dir, 'proc'), agent: path.join(dir, '.tmuxifier-agent') };
}

// The /proc the hook saw when Claude Code fired this event. The recorder stood where the hook
// stands (a child of the `/bin/sh -c` Claude Code runs a hook command through), so its chain is
// the hook's: [0] the hook itself, [1] that shell, [2] the Claude Code, then its parents. The
// hook starts from its real $PPID, which here is this test process, so the shell's entry goes
// under this pid, with the command line the installer writes for `arg`.
async function writeProc(root, line, arg) {
  await fs.rm(root, { recursive: true, force: true });
  const put = async (name, stat, cmdline) => {
    await fs.mkdir(path.join(root, String(name)), { recursive: true });
    await fs.writeFile(path.join(root, String(name), 'stat'), `${stat}\n`);
    await fs.writeFile(path.join(root, String(name), 'cmdline'), cmdline.map((a) => `${a}\0`).join(''));
  };
  const [self, wrapper, ...rest] = line.proc.chain;
  for (const c of rest) await put(c.pid, c.stat, c.cmdline);
  await put('self', self.stat, self.cmdline);
  await put(process.pid, wrapper.stat, ['/bin/sh', '-c', hookCommand(arg)]);
}

function run(arg, e, stdin) {
  return new Promise((resolve) => {
    const child = execFile(SHELL[0], [...SHELL.slice(1), HOOK, arg], { env: e }, (err) => resolve(err ? 1 : 0));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

// Everything under ~/.tmuxifier-agent: path, content and modification time. A hook that rewrote
// a file with the same text still shows here.
async function snapshot(root) {
  const out = [];
  const walk = async (dir) => {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      const st = await fs.stat(p, { bigint: true });
      if (st.isDirectory()) { out.push(`${path.relative(root, p)}/`); await walk(p); } else out.push(`${path.relative(root, p)} ${st.mtimeNs} ${(await fs.readFile(p, 'utf8')).trim()}`);
    }
  };
  await walk(root);
  return out.join('\n');
}

const readTrace = async () => (await fs.readFile(TRACE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

// Replays the whole trace; `opts.panePid` overrides the recorded pane pid, `opts.proc` false
// leaves the hook with an empty /proc.
async function replay(opts = {}) {
  const { dir, proc, agent } = await env();
  const lines = await readTrace();
  const states = [];
  for (const line of lines) {
    const before = await snapshot(agent);
    const e = {
      HOME: dir,
      TMUX: '/tmp/tmux-0/default,123,0',
      TMUX_PANE: line.proc.pane_id,
      PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
      FAKE_PANE_PID: String(opts.panePid ? opts.panePid(lines) : line.proc.pane_pid),
      TMUXIFIER_AGENT_TEST_PROC: proc,
    };
    for (const arg of hookArgsFor(line.payload)) {
      if (opts.proc === false) await fs.rm(proc, { recursive: true, force: true }); else await writeProc(proc, line, arg);
      // Every dispatch must exit 0: a non-zero hook exit surfaces into the Claude session.
      expect(await run(arg, e, JSON.stringify(line.payload)), `line ${states.length + 1} ${arg}`).toBe(0);
    }
    const m = await fs.readFile(path.join(agent, 'rec%0'), 'utf8').catch(() => '');
    const parts = m.trim().split(':');
    states.push({
      line: states.length + 1,
      event: line.payload.hook_event_name,
      session: line.payload.session_id,
      marker: m.trim() ? `${parts[1]}/${parts[3]}` : '',
      owner: (await fs.readFile(path.join(agent, 'owner', 'rec%0'), 'utf8').catch(() => '')).trim(),
      touched: (await snapshot(agent)) !== before,
    });
  }
  if (process.env.REPLAY_TRAIL) for (const s of states) console.log(`${s.line}\t${s.session}\t${s.event}\t${s.marker}${s.touched ? '' : '\t(untouched)'}`);
  await fs.rm(dir, { recursive: true, force: true });
  return { states, lines, at: (n) => states[n - 1] };
}

// "<pid> <start time>" of a recorded process: start time is field 22 of its stat line.
const identity = (c) => `${c.pid} ${c.stat.slice(c.stat.lastIndexOf(') ') + 2).split(' ')[19]}`;

// What the pane's own session must read at each point, whatever ran beside it.
function expectOwnSessionTrail(at) {
  expect(at(1).marker).toBe('ready/start');
  expect(at(2).marker).toBe('working/prompt');
  expect(at(3).marker).toBe('ready/stop');
  // (a) `claude -p` from the Bash tool: the turn reads working until its own Stop.
  expect(at(5).event).toBe('PreToolUse');
  for (const n of [4, 5, 6, 7, 8, 9, 10]) expect(at(n).marker, `line ${n}`).toBe('working/prompt');
  expect(at(11).event).toBe('Stop');
  expect(at(11).marker).toBe('ready/stop');
  // (b) a detached `claude -p` that starts 12 s after the turn ended: still the finished turn.
  expect(at(16).event).toBe('Stop');
  for (const n of [16, 17, 18, 19, 20, 21]) expect(at(n).marker, `line ${n}`).toBe('ready/stop');
  // (c) a detached `claude -p` while a permission dialog is open: still blocked, then approved.
  expect(at(24).event).toBe('PermissionRequest');
  for (const n of [24, 25, 26, 27, 28, 29]) expect(at(n).marker, `line ${n}`).toBe('blocked/permission');
  expect(at(30).event).toBe('PostToolUse');
  expect(at(30).marker).toBe('working/unblock');
  expect(at(31).marker).toBe('ready/stop');
  // A background subagent turn afterwards: the session's own hooks all still land.
  expect(at(36).event).toBe('SubagentStart');
  expect(at(37).marker).toBe('working/prompt'); // Stop held open by the subagent's token
  expect(at(42).marker).toBe('working/resume');
  expect(at(43).marker).toBe('ready/stop');
  expect(at(45).event).toBe('SessionEnd');
  expect(at(45).marker).toBe('');
}

test('a claude -p in the pane never writes the session marker, busy tokens or block record', async () => {
  const { states, lines, at } = await replay();
  const nested = states.filter((s) => s.session !== 'sess');
  // Three claude -p, four events each: SessionStart, UserPromptSubmit, Stop, SessionEnd.
  expect(nested.map((s) => s.line)).toEqual([6, 7, 8, 9, 18, 19, 20, 21, 26, 27, 28, 29]);
  for (const s of nested) expect(s.touched, `line ${s.line} ${s.event} of ${s.session}`).toBe(false);
  expectOwnSessionTrail(at);
  // The pane's owner is the interactive Claude Code from its first hook to its SessionEnd.
  const interactive = lines[0].proc.chain[2];
  expect(interactive.comm).toBe('claude');
  for (const s of states.slice(0, 44)) expect(s.owner, `line ${s.line}`).toBe(identity(interactive));
  expect(at(45).owner).toBe('');
});

test('the same holds when Claude Code is the pane\'s first process (a worker, `exec claude`)', async () => {
  // Not recorded: the recorded chain with the pane pid moved down to the interactive Claude Code.
  const outer = (lines) => lines[0].proc.chain[2].pid;
  const { states, at } = await replay({ panePid: outer });
  for (const s of states.filter((x) => x.session !== 'sess')) expect(s.touched, `line ${s.line} ${s.event} of ${s.session}`).toBe(false);
  expectOwnSessionTrail(at);
});

test('without a readable /proc every hook acts as before (fails open)', async () => {
  const { states, at } = await replay({ proc: false });
  // The session's own events land, and so do the nested ones: nothing is refused on no evidence.
  expect(at(1).marker).toBe('ready/start');
  expect(at(2).marker).toBe('working/prompt');
  expect(at(6).marker).toBe('ready/start');
  expect(at(6).touched).toBe(true);
  expect(states.filter((s) => s.session === 'sess' && s.event === 'UserPromptSubmit').every((s) => s.marker.startsWith('working/'))).toBe(true);
});
