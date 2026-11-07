import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookArgsFor } from '../src/server/claudeAgentHooks.js';

// Replays every payload recorded from a real Claude Code session
// (test/fixtures/claude-hook-trace.jsonl) through the real hook script, in
// order, dispatched exactly as the registration table says. Lines are 1-based
// to match test/fixtures/README-claude-hook-trace.md.

const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));
const TRACE = fileURLToPath(new URL('./fixtures/claude-hook-trace.jsonl', import.meta.url));

// Fake tmux on PATH: the hook only calls `tmux display-message -p '#S'`.
async function env() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentreplay-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), "#!/bin/sh\nprintf '%s\\n' 'rec'\n", { mode: 0o755 });
  return { dir, e: { HOME: dir, TMUX: '/tmp/tmux-0/default,123,0', PATH: `${bin}:/usr/bin:/bin` } };
}

function run(arg, e, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK, arg], { env: e }, (err) => resolve(err ? 1 : 0));
    // The script exits without reading stdin on its no-op paths; EPIPE is fine.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

test('the recorded trace drives the marker through blocked -> working -> ready with no stale blocked', async () => {
  const { dir, e } = await env();
  const payloads = (await fs.readFile(TRACE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const states = [];
  for (const payload of payloads) {
    for (const arg of hookArgsFor(payload)) {
      // Every dispatch must exit 0: a non-zero hook exit surfaces into the
      // Claude session, and a silently failing write would fake a green trail.
      expect(await run(arg, e, JSON.stringify(payload)), `line ${states.length + 1} ${arg}`).toBe(0);
    }
    const m = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'rec'), 'utf8').catch(() => '');
    const parts = m.trim().split(':');
    states.push({
      line: states.length + 1,
      event: payload.hook_event_name,
      type: payload.notification_type ?? payload.tool_name ?? payload.source ?? '',
      marker: m.trim() ? `${parts[1]}/${parts[3]}` : '',
    });
  }
  if (process.env.REPLAY_TRAIL) for (const s of states) console.log(`${s.line}\t${s.event}\t${s.type}\t${s.marker}`);
  const at = (n) => states[n - 1].marker;

  // Warm-up: auto-allowed Bash never blocks.
  expect(states.find((s) => s.event === 'UserPromptSubmit').marker).toBe('working/prompt');
  expect(at(5)).toBe('ready/stop');

  // (a) granted permission: blocked on PermissionRequest, notification keeps it, PostToolUse unblocks.
  const perm = states.findIndex((s) => s.event === 'PermissionRequest');
  expect(perm).toBeGreaterThan(-1);
  expect(states[perm].marker).toBe('blocked/permission');
  expect(states[perm + 1].event).toBe('Notification');
  expect(states[perm + 1].marker).toBe('blocked/permission');
  const after = states.slice(perm + 1).find((s) => s.event === 'PostToolUse');
  expect(after.marker).toBe('working/unblock');
  expect(at(13)).toBe('ready/stop');

  // (b) plain "No": nothing fires afterwards, the marker stays blocked until the next prompt.
  expect(at(15)).toBe('working/prompt');
  for (const n of [16, 17]) expect(at(n)).toBe('blocked/permission');
  expect(states[17].event).toBe('UserPromptSubmit');
  expect(at(18)).toBe('working/prompt');

  // (c) typed denial: blocked through the notification, Stop resolves it to ready.
  expect(states[18].event).toBe('PreToolUse');
  expect(at(20)).toBe('blocked/permission');
  expect(at(21)).toBe('blocked/permission');
  expect(states[21].event).toBe('Stop');
  expect(at(22)).toBe('ready/stop');

  // (d) AskUserQuestion: question blocked across PermissionRequest and its notification, unblocked by PostToolUse.
  const ask = states.findIndex((s) => s.event === 'PermissionRequest' && s.type === 'AskUserQuestion');
  expect(ask).toBe(25);
  expect(at(25)).toBe('blocked/question');
  expect(at(26)).toBe('blocked/question');
  expect(at(27)).toBe('blocked/question');
  expect(states[27].event).toBe('PostToolUse');
  expect(at(28)).toBe('working/unblock');
  expect(at(29)).toBe('ready/stop');

  // (e) background subagent: Stop is gated by the live token, resume is working/resume, final Stop is ready.
  expect(at(31)).toBe('working/prompt');
  expect(states[33].event).toBe('SubagentStart');
  expect(states[34].event).toBe('Stop');
  expect(at(35)).toBe('working/prompt');
  expect(at(37)).toBe('working/prompt');
  expect(states[39].event).toBe('UserPromptSubmit');
  expect(at(40)).toBe('working/resume');
  expect(states[40].event).toBe('Stop');
  expect(at(41)).toBe('ready/stop');

  // (f) compaction never writes ready/start: marker unchanged from the previous line.
  const compact = states.findIndex((s) => s.event === 'SessionStart' && s.type === 'compact');
  expect(compact).toBeGreaterThan(0);
  expect(states[compact].marker).not.toBe('ready/start');
  expect(states[compact].marker).toBe(states[compact - 1].marker);

  // (g) plain turn.
  expect(at(45)).toBe('working/prompt');
  expect(at(46)).toBe('ready/stop');

  // (h) /exit deletes the marker.
  expect(states.at(-1).event).toBe('SessionEnd');
  expect(states.at(-1).marker).toBe('');

  // No Stop ever leaves the marker blocked.
  for (const s of states) if (s.event === 'Stop') expect(s.marker.startsWith('blocked')).toBe(false);
});
