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
function runHook(arg, env) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK_ASSET, arg], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end('{"session_id":"x","hook_event_name":"Stop"}');
  });
}

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

test('builder emits the presence check, the literal config-dir command, and matcher-free entries', () => {
  const s = buildAgentHooksInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('AGENTHOOKS: skipped-no-claude');
  expect(s).toContain('AGENTHOOKS: applied');
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh');
  expect(s).not.toContain('"matcher"');
});

test('installer without claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-'));
  const res = await runShell(buildAgentHooksInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: '/usr/bin:/bin' }, 'HOOK-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.claude'))).rejects.toBeTruthy();
});

test('installer with claude, no settings.json: writes hook script + fresh settings with all five events', async () => {
  const b = await claudeBox();
  const res = await runShell(buildAgentHooksInstallScript(), b.env(), '#!/bin/sh\necho hook\n');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: applied');
  const hook = await fs.readFile(path.join(b.cfg, 'tmuxifier-agent-hook.sh'), 'utf8');
  expect(hook).toContain('echo hook');
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd']) {
    expect(settings.hooks[ev]).toHaveLength(1);
    expect(settings.hooks[ev][0].hooks[0].command).toContain(TMUXIFIER_CMD);
    expect(settings.hooks[ev][0]).not.toHaveProperty('matcher');
  }
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/ prompt$/);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/ end$/);
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
