import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildClaudeSeedScript, buildCodexSeedScript, createAiAuthSeeder, CLAUDE_TOKEN_FILE, CLAUDE_TOKEN_RC_LINE } from '../src/server/aiAuthSeed.js';

function runShell(script, env) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

test('claude script reads token from stdin, writes it to its own file, and tags rc lines', () => {
  const s = buildClaudeSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('token="$(cat)"');
  expect(s).toContain(CLAUDE_TOKEN_FILE);
  expect(s).toContain('# tmuxifier-claude-token');
  expect(s).toContain('hasCompletedOnboarding');
  expect(s).toContain('.claude.json');
  // The rc line is static text: no secret, nothing interpolated.
  expect(CLAUDE_TOKEN_RC_LINE).not.toContain('$token');
  expect(CLAUDE_TOKEN_RC_LINE.endsWith('# tmuxifier-claude-token')).toBe(true);
});

test('codex script writes ~/.codex/auth.json from stdin with 0600', () => {
  const s = buildCodexSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('mkdir -p "$HOME/.codex"');
  expect(s).toContain('cat > "$HOME/.codex/auth.json"');
  expect(s).toContain('chmod 600 "$HOME/.codex/auth.json"');
});

const TOKEN = 'sk-ant-oat-EXAMPLE';
const seedCmd = (script) => `printf %s '${TOKEN}' | ( ${script} )`;
const modeOf = async (p) => (await fs.stat(p)).mode & 0o777;

async function expectTokenFile(dir, label = '') {
  const file = path.join(dir, CLAUDE_TOKEN_FILE);
  expect(await fs.readFile(file, 'utf8'), label).toBe(`${TOKEN}\n`);
  expect(await modeOf(file), label).toBe(0o600);
  expect(await modeOf(path.dirname(file)), label).toBe(0o700);
}

test('claude rc line is delete-then-append idempotent and onboarding file is guarded (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-'));
  await fs.writeFile(path.join(dir, '.bashrc'), '# existing\n');
  const script = buildClaudeSeedScript();
  const env = { HOME: dir };
  for (let i = 0; i < 2; i++) {
    const res = await runShell(seedCmd(script), env);
    expect(res.code).toBe(0);
  }
  const rc = await fs.readFile(path.join(dir, '.bashrc'), 'utf8');
  expect(rc.split('\n').filter((l) => l.includes('tmuxifier-claude-token'))).toEqual([CLAUDE_TOKEN_RC_LINE]);
  expect(rc).not.toContain(TOKEN);
  await expectTokenFile(dir);
  const onboarding = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  expect(onboarding.hasCompletedOnboarding).toBe(true);
  // A pre-existing .claude.json must be preserved, with the onboarding flag
  // MERGED in. The claude installer's own first run (the claude provision
  // tool) creates this file during setup — before seeding — so an
  // only-if-absent guard would silently skip the flag and interactive claude
  // would show the login picker despite a valid token in the environment.
  await fs.writeFile(path.join(dir, '.claude.json'), '{"custom":true}');
  await runShell(seedCmd(script), env);
  const merged = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  expect(merged.custom).toBe(true);
  expect(merged.hasCompletedOnboarding).toBe(true);
  // Re-running must not corrupt it (idempotent merge).
  await runShell(seedCmd(script), env);
  const merged2 = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  expect(merged2).toEqual(merged);
});

test('claude rc append is safe when rc file lacks a trailing newline (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-nonl-'));
  await fs.writeFile(path.join(dir, '.bashrc'), "alias ll='ls -la'");
  const script = buildClaudeSeedScript();
  const env = { HOME: dir };
  for (let i = 0; i < 2; i++) {
    const res = await runShell(seedCmd(script), env);
    expect(res.code).toBe(0);
  }
  const rc = await fs.readFile(path.join(dir, '.bashrc'), 'utf8');
  const lines = rc.split('\n');
  expect(lines).toContain("alias ll='ls -la'");
  const tagged = lines.filter((l) => l.includes('tmuxifier-claude-token'));
  expect(tagged).toEqual([CLAUDE_TOKEN_RC_LINE]);
});

// The script text reaches the box through ssh argv, so it executes under the
// box's login shell (often zsh), and the rc line it writes is later read by
// every shell the box starts. Both are exercised under each shell present.
const SEED_SHELLS = ['/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh'];
async function presentShells() {
  const shells = [];
  for (const sh of SEED_SHELLS) {
    try { await fs.access(sh); shells.push(sh); } catch { /* not installed */ }
  }
  expect(shells).toContain('/bin/sh');
  return shells;
}
function runUnder(sh, cmd, home) {
  return new Promise((resolve) => {
    execFile(sh, ['-c', cmd], { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

test('claude seed keeps the token out of every rc file, which still exports it (real shells)', async () => {
  const script = buildClaudeSeedScript();
  for (const sh of await presentShells()) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-file-'));
    const rcs = ['.profile', '.bashrc', '.zshrc'].map((f) => path.join(dir, f));
    // A box seeded before the token moved: the plaintext line is in a 0644 file.
    for (const p of rcs) {
      await fs.writeFile(p, `# mine\nexport CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-OLD' # tmuxifier-claude-token\n`);
      await fs.chmod(p, 0o644);
    }
    expect(await runUnder(sh, seedCmd(script), dir), sh).toMatchObject({ code: 0 });
    await expectTokenFile(dir, sh);
    for (const p of rcs) {
      const text = await fs.readFile(p, 'utf8');
      expect(text, `${sh} ${p}`).not.toContain('sk-ant-oat');
      expect(text.split('\n'), `${sh} ${p}`).toEqual(['# mine', CLAUDE_TOKEN_RC_LINE, '']);
      // No secret in the file any more, so its mode is the operator's own.
      expect(await modeOf(p), `${sh} ${p}`).toBe(0o644);
      const read = await runUnder(sh, `. '${p}'; printf %s "$CLAUDE_CODE_OAUTH_TOKEN"`, dir);
      expect(read, `${sh} sources ${p}`).toMatchObject({ code: 0, stdout: TOKEN });
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the rc line is inert and exits 0 when the token file is gone (real shells)', async () => {
  for (const sh of await presentShells()) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-gone-'));
    const rc = path.join(dir, '.profile');
    await fs.writeFile(rc, `${CLAUDE_TOKEN_RC_LINE}\n`);
    const read = await runUnder(sh, `. '${rc}'; s=$?; printf '%s:%s' "$s" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}"`, dir);
    expect(read, sh).toMatchObject({ code: 0, stdout: '0:unset', stderr: '' });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a re-seed replaces the token file in place and never leaves a temp file behind (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-rotate-'));
  await runShell(seedCmd(buildClaudeSeedScript()), { HOME: dir });
  await runShell(`printf %s 'sk-ant-oat-NEW' | ( ${buildClaudeSeedScript()} )`, { HOME: dir });
  const authDir = path.dirname(path.join(dir, CLAUDE_TOKEN_FILE));
  expect(await fs.readdir(authDir)).toEqual([path.basename(CLAUDE_TOKEN_FILE)]);
  expect(await fs.readFile(path.join(dir, CLAUDE_TOKEN_FILE), 'utf8')).toBe('sk-ant-oat-NEW\n');
  await fs.rm(dir, { recursive: true, force: true });
});

test('claude seed does not create or touch rc files beyond ~/.profile (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-absent-'));
  const res = await runShell(seedCmd(buildClaudeSeedScript()), { HOME: dir });
  expect(res.code).toBe(0);
  // Only ~/.profile is created (owner-only via umask 077); .bashrc/.zshrc stay absent.
  expect(await modeOf(path.join(dir, '.profile'))).toBe(0o600);
  await expect(fs.access(path.join(dir, '.bashrc'))).rejects.toThrow();
  await expect(fs.access(path.join(dir, '.zshrc'))).rejects.toThrow();
  // ~/.claude.json holds no secret and keeps the umask-derived mode it always had.
  expect(await modeOf(path.join(dir, '.claude.json'))).toBe(0o600);
  await fs.rm(dir, { recursive: true, force: true });
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

test('status reports per-CLI readiness with the seeder skip reasons, no secret material', async () => {
  const ready = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: 'sk-ant-oat-EXAMPLE', readLocal: async () => Buffer.from('{"codex":true}') });
  expect(await ready.status()).toEqual({ claude: { ready: true }, codex: { ready: true } });
  expect(JSON.stringify(await ready.status())).not.toContain('EXAMPLE');

  const none = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: null, readLocal: async () => { throw new Error('ENOENT'); } });
  expect(await none.status()).toEqual({
    claude: { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  });

  const bad = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: "bad'token", readLocal: async () => Buffer.from('') });
  expect(await bad.status()).toEqual({
    claude: { ready: false, reason: 'unsupported token characters' },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  });
});

test('the rc line is inert under set -eu when HOME is unset (real shells)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-nohome-'));
  const rc = path.join(dir, 'rc');
  await fs.writeFile(rc, `${CLAUDE_TOKEN_RC_LINE}\n`);
  for (const sh of await presentShells()) {
    const res = await new Promise((resolve) => {
      execFile(sh, ['-c', `set -eu; . '${rc}'; printf ok`], { env: { PATH: process.env.PATH } }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      });
    });
    expect(res, sh).toMatchObject({ code: 0, stdout: 'ok', stderr: '' });
  }
  await fs.rm(dir, { recursive: true, force: true });
});
