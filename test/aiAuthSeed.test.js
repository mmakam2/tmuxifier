import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildClaudeSeedScript, buildCodexSeedScript, createAiAuthSeeder } from '../src/server/aiAuthSeed.js';

function runShell(script, env) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

test('claude script reads token from stdin, tags rc lines, and skips existing ~/.claude.json', () => {
  const s = buildClaudeSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('token="$(cat)"');
  expect(s).toContain('# tmuxifier-claude-token');
  expect(s).toContain('hasCompletedOnboarding');
  expect(s).toContain('.claude.json');
});

test('codex script writes ~/.codex/auth.json from stdin with 0600', () => {
  const s = buildCodexSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('mkdir -p "$HOME/.codex"');
  expect(s).toContain('cat > "$HOME/.codex/auth.json"');
  expect(s).toContain('chmod 600 "$HOME/.codex/auth.json"');
});

test('claude rc line is delete-then-append idempotent and onboarding file is guarded (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-'));
  await fs.writeFile(path.join(dir, '.bashrc'), '# existing\n');
  const script = buildClaudeSeedScript();
  const env = { HOME: dir };
  for (let i = 0; i < 2; i++) {
    const res = await runShell(`printf %s 'sk-ant-oat-EXAMPLE' | ( ${script} )`, env);
    expect(res.code).toBe(0);
  }
  const rc = await fs.readFile(path.join(dir, '.bashrc'), 'utf8');
  expect(rc.split('\n').filter((l) => l.includes('tmuxifier-claude-token'))).toHaveLength(1);
  expect(rc).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-EXAMPLE'");
  const onboarding = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  expect(onboarding.hasCompletedOnboarding).toBe(true);
  // guarded: pre-existing .claude.json must never be overwritten
  await fs.writeFile(path.join(dir, '.claude.json'), '{"custom":true}');
  await runShell(`printf %s 'sk-ant-oat-EXAMPLE' | ( ${script} )`, env);
  expect(await fs.readFile(path.join(dir, '.claude.json'), 'utf8')).toBe('{"custom":true}');
});

test('claude rc append is safe when rc file lacks a trailing newline (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-nonl-'));
  await fs.writeFile(path.join(dir, '.bashrc'), "alias ll='ls -la'");
  const script = buildClaudeSeedScript();
  const env = { HOME: dir };
  for (let i = 0; i < 2; i++) {
    const res = await runShell(`printf %s 'sk-ant-oat-EXAMPLE' | ( ${script} )`, env);
    expect(res.code).toBe(0);
  }
  const rc = await fs.readFile(path.join(dir, '.bashrc'), 'utf8');
  const lines = rc.split('\n');
  expect(lines).toContain("alias ll='ls -la'");
  const tagged = lines.filter((l) => l.includes('tmuxifier-claude-token'));
  expect(tagged).toHaveLength(1);
  expect(tagged[0]).toBe("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-EXAMPLE' # tmuxifier-claude-token");
});

test('codex script round-trips bytes with 0600 (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-cx-'));
  const payload = JSON.stringify({ tokens: { refresh: 'r-EXAMPLE' } });
  const res = await runShell(`printf %s '${payload.replace(/'/g, "'\\''")}' | ( ${buildCodexSeedScript()} )`, { HOME: dir });
  expect(res.code).toBe(0);
  const out = path.join(dir, '.codex', 'auth.json');
  expect(await fs.readFile(out, 'utf8')).toBe(payload);
  expect(((await fs.stat(out)).mode & 0o777)).toBe(0o600);
});

test('seeder routes secrets via stdin, never into script text', async () => {
  const calls = [];
  const seeder = createAiAuthSeeder({
    runStdin: async (box, script, input) => { calls.push({ script, input: String(input) }); return { ok: true }; },
    token: 'sk-ant-oat-EXAMPLE',
    readLocal: async () => Buffer.from('{"codex":true}'),
  });
  const results = await seeder.seed({ id: 'b1', host: 'h1' });
  expect(results).toEqual([{ target: 'claude', ok: true }, { target: 'codex', ok: true }]);
  expect(calls).toHaveLength(2);
  for (const c of calls) expect(c.script).not.toContain('EXAMPLE');
  expect(calls[0].input).toBe('sk-ant-oat-EXAMPLE');
  expect(calls[1].input).toBe('{"codex":true}');
});

test('seeder skips per target: no token, missing local codex auth, quote in token', async () => {
  const none = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: null, readLocal: async () => { throw new Error('ENOENT'); } });
  expect(await none.seed({ host: 'h1' })).toEqual([
    { target: 'claude', ok: false, skipped: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ]);
  const quoted = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: "bad'token", readLocal: async () => { throw new Error('ENOENT'); } });
  expect((await quoted.seed({ host: 'h1' }))[0]).toEqual({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
  const newlined = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: 'tok\nen', readLocal: async () => { throw new Error('ENOENT'); } });
  expect((await newlined.seed({ host: 'h1' }))[0]).toEqual({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
  const creturned = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: 'tok\ren', readLocal: async () => { throw new Error('ENOENT'); } });
  expect((await creturned.seed({ host: 'h1' }))[0]).toEqual({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
});

test('seeder reports transport failure without secret material', async () => {
  const seeder = createAiAuthSeeder({
    runStdin: async () => ({ ok: false, error: 'ssh exited 255' }),
    token: 'sk-ant-oat-EXAMPLE',
    readLocal: async () => Buffer.from('x'),
  });
  const results = await seeder.seed({ host: 'h1' });
  expect(results[0]).toEqual({ target: 'claude', ok: false, error: 'seed failed' });
  expect(results[1]).toEqual({ target: 'codex', ok: false, error: 'seed failed' });
});
