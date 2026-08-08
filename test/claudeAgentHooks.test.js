import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentHooksInstallScript, createAgentHooksPusher } from '../src/server/claudeAgentHooks.js';

const HOOK_ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));

// Run the real asset under /bin/sh with a controlled env. stdin carries a
// fake event JSON, as Claude Code does; the script must drain and ignore it.
function runHook(arg, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK_ASSET, arg], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
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
  expect(content).toMatch(/^web:working:\d+\n$/);
});

test('stop, notify and start all write waiting', async () => {
  const { dir, env } = await hookEnv('web');
  for (const ev of ['stop', 'notify', 'start']) {
    await runHook(ev, env);
    const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'web'), 'utf8');
    expect(content).toMatch(/^web:waiting:\d+\n$/);
  }
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

test('stop with a live subagent token writes working, not waiting', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+\n$/);
});

test('subagent-stop clears only its own token, by agent_id', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('subagent-start', env, SUBAGENT('sub-2'));
  await runHook('subagent-stop', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+\n$/); // sub-2 still outstanding
  await runHook('subagent-stop', env, SUBAGENT('sub-2'));
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:waiting:\d+\n$/);
});

test('a backgrounded tool call gates stop; a foreground one does not', async () => {
  const fg = await hookEnv('web');
  await runHook('pretool', fg.env, FG_TOOL);
  await runHook('stop', fg.env);
  expect(await marker(fg.dir)).toMatch(/^web:waiting:\d+\n$/);

  const bg = await hookEnv('web');
  await runHook('pretool', bg.env, BG_TOOL);
  await runHook('stop', bg.env);
  expect(await marker(bg.dir)).toMatch(/^web:working:\d+\n$/);
});

test('prompt clears outstanding tokens — a re-invocation is the only completion signal a background shell gives', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('pretool', env, BG_TOOL);
  await runHook('prompt', env);
  expect(await marker(dir)).toMatch(/^web:working:\d+\n$/);
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:waiting:\d+\n$/);
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
  expect(await marker(dir)).toMatch(/^web:working:\d+\n$/); // the subagent still gates
  expect(await fs.readdir(busyDir(dir))).toEqual(['sub.sub-1']); // the shell token is gone

  const solo = await hookEnv('web');
  await runHook('pretool', solo.env, BG_TOOL);
  for (const f of await fs.readdir(busyDir(solo.dir))) await fs.utimes(path.join(busyDir(solo.dir), f), aged, aged);
  await runHook('stop', solo.env);
  expect(await marker(solo.dir)).toMatch(/^web:waiting:\d+\n$/); // stale shell token cannot suppress
});

test('a token past its TTL cannot suppress waiting forever', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const f of await fs.readdir(busyDir(dir))) await fs.utimes(path.join(busyDir(dir), f), stale, stale);
  await runHook('stop', env);
  expect(await marker(dir)).toMatch(/^web:waiting:\d+\n$/);
});

test('idle_prompt is gated by outstanding work; every other notification still means the operator', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('subagent-start', env, SUBAGENT('sub-1'));
  await runHook('stop', env);
  await runHook('notify', env, NOTIFY('idle_prompt'));
  expect(await marker(dir)).toMatch(/^web:working:\d+\n$/); // the +60s timer must not ping
  await runHook('notify', env, NOTIFY('permission_prompt'));
  expect(await marker(dir)).toMatch(/^web:waiting:\d+\n$/); // a real request still does
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
  expect(content).toMatch(/^a b\/c:waiting:\d+\n$/);
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

test('builder emits the presence check, the literal config-dir command, and only the one matcher it needs', () => {
  const s = buildAgentHooksInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('AGENTHOOKS: skipped-no-claude');
  expect(s).toContain('AGENTHOOKS: applied');
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh');
  // PreToolUse is the one event that fires per tool call; the matcher keeps the
  // hook from forking on every non-Bash call it can never care about.
  expect(s.match(/"matcher"/g)).toHaveLength(1);
  expect(s).toContain('"matcher":"Bash"');
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
  for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd', 'PreToolUse', 'SubagentStart', 'SubagentStop']) {
    expect(settings.hooks[ev]).toHaveLength(1);
    expect(settings.hooks[ev][0].hooks[0].command).toContain(TMUXIFIER_CMD);
  }
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/ prompt$/);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/ end$/);
  expect(settings.hooks.SubagentStart[0].hooks[0].command).toMatch(/ subagent-start$/);
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
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
