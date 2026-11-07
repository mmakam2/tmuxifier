import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentHooksInstallScript, createAgentHooksPusher, hookArgsFor } from '../src/server/claudeAgentHooks.js';

const HOOK_ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));

// Run the real asset under /bin/sh with a controlled env. stdin carries a
// fake event JSON, as Claude Code does; the script must drain and ignore it.
function runHook(arg, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK_ASSET, arg], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    // The script exits without draining stdin on its no-op paths (outside tmux,
    // unblock over a non-blocked marker); Claude Code tolerates that, so EPIPE is fine.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '{"session_id":"x","hook_event_name":"Stop"}');
  });
}

const marker = (dir, name = 'web') => fs.readFile(path.join(dir, '.tmuxifier-agent', name), 'utf8');
const busyDir = (dir, name = 'web') => path.join(dir, '.tmuxifier-agent', 'busy', name);

// A fake tmux on PATH: the hook only calls `tmux display-message -p '#S'`.
async function hookEnv(sessionName) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthook-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' '${sessionName}'\n`, { mode: 0o755 });
  return { dir, env: { HOME: dir, TMUX: '/tmp/tmux-0/default,123,0', PATH: `${bin}:/usr/bin:/bin` } };
}

test('outside tmux: exits 0 and writes nothing', async () => {
  const { dir, env } = await hookEnv('web');
  delete env.TMUX;
  const res = await runHook('prompt', env);
  expect(res.code).toBe(0);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent'))).rejects.toBeTruthy();
});

test('prompt writes a working marker named after the session', async () => {
  const { dir, env } = await hookEnv('web');
  const res = await runHook('prompt', env);
  expect(res.code).toBe(0);
  const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'web'), 'utf8');
  expect(content).toMatch(/^web:working:\d+:prompt\n$/);
});

test('stop writes ready/stop; a typeless notify writes nothing; start writes ready/start', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
  await runHook('prompt', env);
  const before = await marker(dir);
  await runHook('notify', env);
  expect(await marker(dir)).toBe(before);
  await runHook('start', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:start\n$/);
});

test('end deletes the marker', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('stop', env);
  await runHook('end', env);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent', 'web'))).rejects.toBeTruthy();
});

// ---------------------------------------------------------------------------
// The background-work gate. `Stop` fires whenever the main agent finishes
// responding — INCLUDING a turn that ended only to await a background subagent
// or shell, which the harness resumes on its own. That is not the operator's
// turn, so it must not read as `waiting`. Outstanding work is tracked as token
// files under .tmuxifier-agent/busy/<session>/ and the gate consults them.
// ---------------------------------------------------------------------------

const SUBAGENT = (id) => `{"hook_event_name":"SubagentStart","agent_id":"${id}","agent_type":"Explore"}`;
const BG_TOOL = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sleep 60","run_in_background":true}}';
const FG_TOOL = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls","run_in_background":false}}';
const NOTIFY = (type) => `{"hook_event_name":"Notification","notification_type":"${type}","message":"hi"}`;
// The two kinds of UserPromptSubmit, told apart by the prompt text itself. The
// harness announces a resume with a <task-notification> block; anything else is
// the operator at the keyboard. Confirmed against Claude Code 2.1.232, whose
// resume payload carries the block in `prompt` (not `user_input`).
const RESUME = '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\\n<task-id>abc123</task-id>\\n<status>completed</status>\\n</task-notification>"}';
const OPERATOR = '{"hook_event_name":"UserPromptSubmit","prompt":"fix the failing test please"}';

test('stop with a live subagent token writes working, not waiting', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);
});

test('subagent-stop clears only its own token, by agent_id', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('subagent-start', env, SUBAGENT('sub-2'));
  await runHook('subagent-stop', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/); // sub-2 still outstanding
  await runHook('subagent-stop', env, SUBAGENT('sub-2'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('a backgrounded tool call gates stop; a foreground one does not', async () => {
  const fg = await hookEnv('web');
  await runHook('pretool', fg.env, FG_TOOL);
  await runHook('stop', fg.env);
  expect(await marker(fg.dir)).toMatch(/^web:ready:\d+:stop\n$/);

  const bg = await hookEnv('web');
  await runHook('pretool', bg.env, BG_TOOL);
  await runHook('stop', bg.env);
  expect(await marker(bg.dir)).toMatch(/^web:working:\d+:prompt\n$/);
});

test('a resume clears outstanding shell tokens — a re-invocation is the only completion signal a background shell gives', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('pretool', env, BG_TOOL);
  await runHook('prompt', env, RESUME);
  expect(await marker(dir)).toMatch(/^web:working:\d+:resume\n$/);
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

// The defect this pair pins down: every background subagent that finishes
// resumes the main agent with a synthetic prompt, so a blanket clear on
// UserPromptSubmit destroys the tokens of the siblings STILL RUNNING — and the
// next Stop then reads waiting for their whole remaining runtime. A `sub.`
// token is bracketed by its own SubagentStop and must outlive a resume; only
// the operator's own prompt is a clean slate.
test('a harness resume leaves a live subagent token alone', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('subagent-start', env, SUBAGENT('sub-2'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);

  await runHook('subagent-stop', env, SUBAGENT('sub-1')); // one finishes...
  await runHook('prompt', env, RESUME); // ...and the harness resumes the main agent
  expect(await fs.readdir(busyDir(dir))).toEqual(['sub.sub-2']);

  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/); // sub-2 is still running

  await runHook('subagent-stop', env, SUBAGENT('sub-2'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/); // now it really is the operator's turn
});

test('the operator’s own prompt is a clean slate, so no token can go stale across turns', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('pretool', env, BG_TOOL);
  await runHook('prompt', env, OPERATOR);
  await expect(fs.readdir(busyDir(dir))).rejects.toBeTruthy();
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('a background-shell token expires on a far shorter clock than a subagent one', async () => {
  // The asymmetry is the point: SubagentStop always fires, so a `sub.` token is
  // cleared by its own event. A backgrounded shell has NO completion hook — if
  // it finishes mid-turn the token silently goes stale — so its TTL is the only
  // thing keeping it from suppressing a real `Stop`.
  const { dir, env } = await hookEnv('web');
  await runHook('pretool', env, BG_TOOL);
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  const aged = new Date(Date.now() - 10 * 60 * 1000); // 10min: past bg's TTL, far inside the subagent's
  for (const f of await fs.readdir(busyDir(dir))) await fs.utimes(path.join(busyDir(dir), f), aged, aged);
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/); // the subagent still gates
  expect(await fs.readdir(busyDir(dir))).toEqual(['sub.sub-1']); // the shell token is gone

  const solo = await hookEnv('web');
  await runHook('pretool', solo.env, BG_TOOL);
  for (const f of await fs.readdir(busyDir(solo.dir))) await fs.utimes(path.join(busyDir(solo.dir), f), aged, aged);
  await runHook('stop', solo.env);
  expect(await marker(solo.dir)).toMatch(/^web:ready:\d+:stop\n$/); // stale shell token cannot suppress
});

test('a token past its TTL cannot suppress waiting forever', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const f of await fs.readdir(busyDir(dir))) await fs.utimes(path.join(busyDir(dir), f), stale, stale);
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('idle_prompt is gated by outstanding work; every other notification still means the operator', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  await runHook('notify', env, NOTIFY('idle_prompt'));
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/); // the +60s timer must not ping
  await runHook('notify', env, NOTIFY('permission_prompt'));
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:permission\n$/); // a real request still does
});

// agent_completed announces that ONE background agent finished. While siblings
// are still running that is not the operator's turn, so it is gated exactly
// like idle_prompt — and lands as waiting once nothing is outstanding.
test('agent_completed is gated by outstanding work, and lands once nothing is', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('subagent-start', env, SUBAGENT('sub-2'));
  await runHook('stop', env); // turn ends with both live -> working
  await runHook('subagent-stop', env, SUBAGENT('sub-1'));
  await runHook('notify', env, NOTIFY('agent_completed'));
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/); // sub-2 still running

  await runHook('subagent-stop', env, SUBAGENT('sub-2'));
  await runHook('notify', env, NOTIFY('agent_completed'));
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('agent_needs_input is never gated — a background agent asking for the operator is real', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('notify', env, NOTIFY('agent_needs_input'));
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:question\n$/);
});

test('newline-terminated and multi-line JSON payloads keep exact notification_type and agent_id tokens', async () => {
  // Real Claude Code hook stdin and POSIX/BusyBox sed emit newline-terminated
  // lines; without stripping \r\n before tr -c, the trailing newline became `_`
  // (`idle_prompt_`, `sub.sub-1_`), bypassing busy_live and breaking pairing.
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, '{\n  "hook_event_name": "SubagentStart",\n  "agent_id": "sub-1",\n  "agent_type": "Explore"\n}\n');
  await runHook('subagent-start', env, '{"hook_event_name":"SubagentStart","agent_id":"sub-2"}\r\n');
  expect((await fs.readdir(busyDir(dir))).sort()).toEqual(['sub.sub-1', 'sub.sub-2']);

  await runHook('stop', env, '{"hook_event_name":"Stop"}\n');
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);

  await runHook('notify', env, '{\n  "hook_event_name": "Notification",\n  "notification_type": "idle_prompt",\n  "message": "Claude is waiting"\n}\n');
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);

  // Pair multi-line SubagentStart with compact single-line SubagentStop.
  await runHook('subagent-stop', env, SUBAGENT('sub-1'));
  expect(await fs.readdir(busyDir(dir))).toEqual(['sub.sub-2']);

  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"agent_completed"}\r\n');
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);

  await runHook('subagent-stop', env, SUBAGENT('sub-2'));
  await runHook('notify', env, '{\n  "hook_event_name": "Notification",\n  "notification_type": "agent_completed"\n}\n');
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('gate events write no marker of their own, and the busy dir stays invisible to the probe', async () => {
  const { dir, env } = await hookEnv('web');
  for (const [ev, stdin] of [['subagent-start', SUBAGENT('s')], ['subagent-stop', SUBAGENT('s')], ['pretool', BG_TOOL]]) {
    const res = await runHook(ev, env, stdin);
    expect(res.code).toBe(0);
  }
  // status.js enumerates .tmuxifier-agent/* and reads each `[ -f "$f" ]` entry.
  await expect(marker(dir)).rejects.toBeTruthy();
  expect((await fs.stat(path.join(dir, '.tmuxifier-agent', 'busy'))).isDirectory()).toBe(true);
});

test('end clears the busy tokens along with the marker', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('end', env);
  await expect(fs.access(busyDir(dir))).rejects.toBeTruthy();
});

test('outside tmux the gate events write nothing', async () => {
  const { dir, env } = await hookEnv('web');
  delete env.TMUX;
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await expect(fs.access(path.join(dir, '.tmuxifier-agent'))).rejects.toBeTruthy();
});

test('unknown event is a no-op; session name is sanitized in the filename but exact in the content', async () => {
  const { dir, env } = await hookEnv('a b/c');
  await runHook('bogus', env);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent'))).rejects.toBeTruthy();
  await runHook('stop', env);
  const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'a_b_c'), 'utf8');
  expect(content).toMatch(/^a b\/c:ready:\d+:stop\n$/);
});

// ---------------------------------------------------------------------------
// Lifecycle states: ready / working / blocked, each with a cause.
// ---------------------------------------------------------------------------

test('start is idle-not-done: ready/start', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('start', env, '{"hook_event_name":"SessionStart","source":"startup"}');
  expect(await marker(dir)).toMatch(/^web:ready:\d+:start\n$/);
});

test('permission and ask write blocked with their cause; the notify backstop agrees', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env, '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:permission\n$/);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"permission_prompt"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:permission\n$/);
  await runHook('ask', env, '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:question\n$/);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"elicitation_dialog"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:elicitation\n$/);
});

// Real Claude Code 2.1.319 fires PermissionRequest(tool_name AskUserQuestion) and a
// permission_prompt Notification right after the ask's PreToolUse; neither may
// downgrade the question.
test('ask, then its PermissionRequest and permission_prompt, stays blocked/question', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('ask', env, '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}');
  await runHook('permission', env, '{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:question\n$/);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"permission_prompt"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:question\n$/);
});

test('unblock clears only a blocked marker, and leaves every other state alone', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  const before = await marker(dir);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Read"}');
  expect(await marker(dir)).toBe(before);
  await runHook('permission', env);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Read"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:unblock\n$/);
});

test('unblock is owner-scoped: a subagent tool call cannot clear the main agent block', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env, '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}');
  const before = await marker(dir);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Bash","agent_id":"sub1"}');
  expect(await marker(dir)).toBe(before);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Bash"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:unblock\n$/);
});

test('unblock is owner-scoped: a subagent block is cleared only by that subagent', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env, '{"hook_event_name":"PermissionRequest","tool_name":"Bash","agent_id":"sub1"}');
  const before = await marker(dir);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Bash"}');
  expect(await marker(dir)).toBe(before);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Bash","agent_id":"sub1"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:unblock\n$/);
});

test('the blocked-owner record never outlives the block', async () => {
  const { dir, env } = await hookEnv('web');
  const rec = path.join(dir, '.tmuxifier-agent', 'blocked', 'web');
  await runHook('permission', env);
  await fs.access(rec);
  await runHook('prompt', env);
  await expect(fs.access(rec)).rejects.toBeTruthy();
});

test('unblock with no marker at all writes nothing', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('unblock', env);
  await expect(marker(dir)).rejects.toBeTruthy();
});

test('a typed denial takes blocked to working through prompt', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env);
  await runHook('prompt', env, '{"hook_event_name":"UserPromptSubmit","prompt":"no, stop"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);
});

test('timers never mint a new ts: idle_prompt over a ready marker is a no-op', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('stop', env);
  const before = await marker(dir);
  await new Promise((r) => setTimeout(r, 1100));
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  expect(await marker(dir)).toBe(before);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"agent_completed"}');
  expect(await marker(dir)).toBe(before);
});

test('idle_prompt still lands over a working marker once nothing is busy', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

// Timers never clear `blocked`: an open dialog nobody has answered, or a plain
// "No" (which fires nothing afterwards), still owes the operator. The marker
// stays blocked until the operator's next prompt or Claude's next tool call.
test('idle_prompt and agent_completed leave a blocked marker unchanged', async () => {
  const { dir, env } = await hookEnv('web');
  await fs.mkdir(path.join(dir, '.tmuxifier-agent'), { recursive: true });
  await fs.writeFile(path.join(dir, '.tmuxifier-agent', 'web'), 'web:blocked:1718000000:permission\n');
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  expect(await marker(dir)).toBe('web:blocked:1718000000:permission\n');
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"agent_completed"}');
  expect(await marker(dir)).toBe('web:blocked:1718000000:permission\n');
});

test('idle_prompt over an absent marker writes nothing', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  await expect(marker(dir)).rejects.toThrow();
});

test('auth and quota notifications write nothing', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  const before = await marker(dir);
  for (const nt of ['auth_success', 'quota_auto_resume_fired', 'plugin_notification']) {
    await runHook('notify', env, `{"hook_event_name":"Notification","notification_type":"${nt}"}`);
    expect(await marker(dir)).toBe(before);
  }
});

test('resume writes working/resume', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env, '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>done</task-notification>"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:resume\n$/);
});

// ---------------------------------------------------------------------------
// Installer + pusher (claudeAgentHooks.js)
// ---------------------------------------------------------------------------

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}

async function claudeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { dir, cfg: path.join(dir, '.claude'), env: () => ({ HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: `${bin}:/usr/bin:/bin` }) };
}

const TMUXIFIER_CMD = 'tmuxifier-agent-hook.sh';

test('builder emits the presence check and the literal config-dir command', () => {
  const s = buildAgentHooksInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('AGENTHOOKS: skipped-no-claude');
  expect(s).toContain('AGENTHOOKS: applied');
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh');
});

test('builder wires every lifecycle event, with matchers only where a hook would otherwise fork per tool call', () => {
  const s = buildAgentHooksInstallScript();
  const json = JSON.parse(s.match(/TMUXIFIER_HOOKS_EOF'\n([\s\S]*?)\nTMUXIFIER_HOOKS_EOF/)[1]);
  expect(Object.keys(json).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  expect(json.PreToolUse.map((e) => e.matcher)).toEqual(['Bash', 'AskUserQuestion']);
  expect(json.PostToolUse.map((e) => e.matcher)).toEqual(['AskUserQuestion', undefined]);
  expect(json.SessionStart[0].matcher).toBe('startup|resume|clear|fork');
  expect(json.Stop[0]).not.toHaveProperty('matcher');
  expect(json.PermissionRequest[0].hooks[0].command).toMatch(/tmuxifier-agent-hook\.sh" permission$/);
});

test('hookArgsFor dispatches a payload the way Claude Code would', () => {
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'Read' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual(['pretool']);
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })).toEqual(['ask']);
  expect(hookArgsFor({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' })).toEqual(['unblock', 'unblock']);
  expect(hookArgsFor({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })).toEqual(['unblock']);
  expect(hookArgsFor({ hook_event_name: 'SessionStart', source: 'compact' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual(['start']);
  expect(hookArgsFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).toEqual(['notify']);
  expect(hookArgsFor({ hook_event_name: 'Elicitation' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'PreToolUse' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'SessionStart' })).toEqual([]);
});

test('installer without claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-'));
  const res = await runShell(buildAgentHooksInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: '/usr/bin:/bin' }, 'HOOK-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.claude'))).rejects.toBeTruthy();
});

test('installer with claude, no settings.json: writes hook script + fresh settings with every wired event', async () => {
  const b = await claudeBox();
  const res = await runShell(buildAgentHooksInstallScript(), b.env(), '#!/bin/sh\necho hook\n');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: applied');
  const hook = await fs.readFile(path.join(b.cfg, 'tmuxifier-agent-hook.sh'), 'utf8');
  expect(hook).toContain('echo hook');
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd', 'PermissionRequest', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']) {
    expect(settings.hooks[ev]).toHaveLength(1);
    expect(settings.hooks[ev][0].hooks[0].command).toContain(TMUXIFIER_CMD);
  }
  expect(settings.hooks.PreToolUse).toHaveLength(2);
  expect(settings.hooks.PostToolUse).toHaveLength(2);
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/ prompt$/);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/ end$/);
  expect(settings.hooks.SubagentStart[0].hooks[0].command).toMatch(/ subagent-start$/);
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
  expect(settings.hooks.PreToolUse[1].matcher).toBe('AskUserQuestion');
  // Stop and UserPromptSubmit support no matcher at all — Claude Code ignores
  // one silently, so carrying a dead field would only mislead a reader.
  expect(settings.hooks.Stop[0]).not.toHaveProperty('matcher');
  expect(settings.hooks.UserPromptSubmit[0]).not.toHaveProperty('matcher');
});

test('installer merge preserves foreign keys and foreign hooks, and is idempotent across reruns', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-hook.sh' }] }] },
  }, null, 2));
  await runShell(buildAgentHooksInstallScript(), b.env(), 'H');
  await runShell(buildAgentHooksInstallScript(), b.env(), 'H'); // rerun: must not duplicate
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(settings.model).toBe('opus');
  const stopCmds = settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
  expect(stopCmds.filter((c) => c.includes('my-own-stop-hook'))).toHaveLength(1);
  expect(stopCmds.filter((c) => c.includes(TMUXIFIER_CMD))).toHaveLength(1);
  expect(settings.hooks.UserPromptSubmit.flatMap((e) => e.hooks).filter((h) => h.command.includes(TMUXIFIER_CMD))).toHaveLength(1);
});

test('pusher maps applied → ok, skipped → skipped, failure → error, and pipes the asset bytes', async () => {
  const ok = createAgentHooksPusher({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: applied\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await ok.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: true });
  const skip = createAgentHooksPusher({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: skipped-no-claude\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await skip.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' });
  let piped = null;
  const fail = createAgentHooksPusher({
    runStdin: async (_box, _script, input) => { piped = input; return { code: 4, stdout: 'AGENTHOOKS: error-no-json-tool\n' }; },
    readAsset: async () => Buffer.from('ASSET-BYTES'),
  });
  expect(await fail.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: false, error: 'agent hooks push failed' });
  expect(piped.toString()).toBe('ASSET-BYTES');
});
