import { test, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOscReporterInstallScript, createOscReporterPusher, AGY_ATTACH_RC_LINE } from '../src/server/oscReporter.js';

const TAG = 'export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi';
const AGY_TAG = 'export AGY_CLI_OSC7501=on # tmuxifier-osc-agy';
const dirs = [];
const zshPath = await realPath('zsh').catch(() => null);
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop(), { recursive: true, force: true }); });

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

async function realPath(tool) {
  for (const d of (process.env.PATH || '').split(':')) {
    const p = path.join(d, tool);
    try { await fs.access(p, 1); return p; } catch { /* next */ }
  }
  throw new Error(`no ${tool}`);
}

// A temp HOME plus a tools bin holding only what the installer needs; python3
// and tmux are stubs the test opts into.
async function box({ python3 = true, tmux = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osc-rep-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  await fs.mkdir(bin);
  await fs.mkdir(home);
  for (const t of ['mkdir', 'cat', 'chmod', 'mv', 'sed', 'touch']) await fs.symlink(await realPath(t), path.join(bin, t));
  const log = path.join(dir, 'python3.log');
  if (python3) {
    await fs.writeFile(path.join(bin, 'python3'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  }
  if (tmux) await fs.writeFile(path.join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, log, env: { PATH: bin, HOME: home } };
}
const run = (b, input = 'print(1)\n') => runShell(buildOscReporterInstallScript(), b.env, input);

test('script text: static, checks python3 and tmux, interpolates nothing', () => {
  const s = buildOscReporterInstallScript();
  expect(s).toContain('command -v python3');
  expect(s).toContain('command -v tmux');
  expect(s).toContain('tmuxifier-osc-pi');
  expect(s).toContain('tmuxifier-osc-agy');
  expect(s).toContain('tmuxifier-osc-agy-attach');
  expect(s.match(/\$\{[^}]*\}/g)).toEqual(['${TMUX_PANE:-}']);
  const vars = new Set(s.match(/\$[A-Za-z_$]+/g));
  for (const v of vars) expect(['$HOME', '$DIR', '$$', '$rc', '$TMUX_PANE']).toContain(v);
});

test('applies: writes stdin exactly (mode 644), panes dir, one rc line after two runs, sweep invoked', async () => {
  const b = await box();
  await fs.writeFile(path.join(b.home, '.zshrc'), 'alias a=b\n');
  const input = 'print(1)\n';
  const r1 = await run(b, input);
  expect(r1.code).toBe(0);
  expect(r1.stdout).toContain('OSCREPORTER: applied');
  const r2 = await run(b, input);
  expect(r2.stdout).toContain('OSCREPORTER: applied');
  const f = path.join(b.home, '.tmuxifier-osc', 'reporter.py');
  expect(await fs.readFile(f, 'utf8')).toBe(input);
  expect((await fs.stat(f)).mode & 0o777).toBe(0o644);
  expect((await fs.stat(path.join(b.home, '.tmuxifier-osc', 'panes'))).isDirectory()).toBe(true);
  const left = (await fs.readdir(path.join(b.home, '.tmuxifier-osc'))).filter((n) => n.includes('.tmp'));
  expect(left).toEqual([]);
  const zshrc = await fs.readFile(path.join(b.home, '.zshrc'), 'utf8');
  expect(zshrc).toBe(`alias a=b\n${TAG}\n${AGY_TAG}\n${AGY_ATTACH_RC_LINE}\n`);
  const profile = await fs.readFile(path.join(b.home, '.profile'), 'utf8');
  expect(profile.split('\n').filter((l) => l === TAG).length).toBe(1);
  expect(profile.split('\n').filter((l) => l === AGY_TAG).length).toBe(1);
  expect(profile.split('\n').filter((l) => l === AGY_ATTACH_RC_LINE).length).toBe(1);
  await expect(fs.access(path.join(b.home, '.bashrc'))).rejects.toBeTruthy();
  const log = await fs.readFile(b.log, 'utf8');
  expect(log).toContain(`${f} sweep`);
});

test("an operator's own untagged AGY_CLI_OSC7501 line is left alone", async () => {
  const b = await box();
  await fs.writeFile(path.join(b.home, '.zshrc'), 'export AGY_CLI_OSC7501=off\n');
  await run(b);
  await run(b);
  expect(await fs.readFile(path.join(b.home, '.zshrc'), 'utf8')).toBe(`export AGY_CLI_OSC7501=off\n${TAG}\n${AGY_TAG}\n${AGY_ATTACH_RC_LINE}\n`);
});

test("an operator's own untagged agy function line is kept", async () => {
  const b = await box();
  const mine = 'agy() { command agy --mine "$@"; }\n';
  await fs.writeFile(path.join(b.home, '.zshrc'), mine);
  await run(b);
  await run(b);
  const z = await fs.readFile(path.join(b.home, '.zshrc'), 'utf8');
  expect(z.startsWith(mine)).toBe(true);
  expect(z.split('\n').filter((l) => l === AGY_ATTACH_RC_LINE).length).toBe(1);
});

// The installed agy function, run under real shells. A stub agy logs its argv and
// exits 7; the stub python3 logs, and writes to stdout and stderr to prove the
// function silences it.
const SHELLS = [
  ['sh', '/bin/sh'],
  ['bash', await realPath('bash').catch(() => '/bin/bash')],
];
async function fn(shellPath, { tmuxPane, first = '', python3 = true } = {}) {
  const b = await box();
  await run(b);
  await fs.writeFile(path.join(b.env.PATH, 'python3'),
    `#!/bin/sh\necho "$@" >> "${b.log}"\necho py-out\necho py-err >&2\n`, { mode: 0o755 });
  await fs.writeFile(path.join(b.env.PATH, 'agy'),
    `#!/bin/sh\necho "agy $# [$1]" >> "${b.log}"\nexit 7\n`, { mode: 0o755 });
  if (!python3) await fs.rm(path.join(b.env.PATH, 'python3'));
  const script = path.join(b.home, 'run.sh');
  await fs.writeFile(script, `${first}\n. "$HOME/.profile"\n. "$HOME/.profile"\nagy "a b" c\necho rc=$?\n`);
  const env = { ...b.env, ...(tmuxPane ? { TMUX_PANE: tmuxPane } : {}) };
  const r = await new Promise((resolve) => {
    execFile(shellPath, [script], { env }, (err, stdout, stderr) => resolve({ stdout, stderr }));
  });
  const lines = (await fs.readFile(b.log, 'utf8')).split('\n').filter(Boolean);
  return { b, r, lines: lines.slice(lines.findIndex((l) => l.endsWith(' sweep')) + 1) };
}
const cases = [...SHELLS.map(([n, p]) => [n, p, false]), ['zsh', zshPath, true]];
for (const [name, shellPath, optional] of cases) {
  const t = optional && !shellPath ? test.skip : test;
  const aliasFirst = name === 'bash' ? "shopt -s expand_aliases\nalias agy='agy --aliased'" : "alias agy='agy --aliased'";
  t(`agy function (${name}): inside tmux attaches the pane, then runs agy`, async () => {
    const { b, r, lines } = await fn(shellPath, { tmuxPane: '%5' });
    expect(lines).toEqual([`${path.join(b.home, '.tmuxifier-osc', 'reporter.py')} attach %5`, 'agy 2 [a b]']);
    expect(r.stdout).toBe('rc=7\n');
    expect(r.stderr).toBe('');
  });
  for (const [label, first] of [['outside tmux', ''], ['outside tmux under set -u', 'set -u']]) {
    t(`agy function (${name}): ${label} runs agy alone`, async () => {
      const { lines, r } = await fn(shellPath, { first });
      expect(lines).toEqual(['agy 2 [a b]']);
      expect(r.stdout).toBe('rc=7\n');
      expect(r.stderr).toBe('');
    });
  }
  t(`agy function (${name}): an earlier alias agy defines nothing and prints nothing`, async () => {
    const { lines, r } = await fn(shellPath, { tmuxPane: '%5', first: aliasFirst });
    expect(lines).toEqual(['agy 3 [--aliased]']);
    expect(r.stderr).toBe('');
  });
  t(`agy function (${name}): python3 missing still runs agy`, async () => {
    const { lines, r } = await fn(shellPath, { tmuxPane: '%5', python3: false });
    expect(lines).toEqual(['agy 2 [a b]']);
    expect(r.stdout).toBe('rc=7\n');
    expect(r.stderr).toBe('');
  });
}

test('a failing sweep never fails the install', async () => {
  const b = await box();
  await fs.writeFile(path.join(b.env.PATH, 'python3'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r = await run(b);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('OSCREPORTER: applied');
});

test('no python3: skipped, nothing written', async () => {
  const b = await box({ python3: false });
  const r = await run(b);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('OSCREPORTER: skipped-no-python3');
  await expect(fs.access(path.join(b.home, '.tmuxifier-osc'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(b.home, '.profile'))).rejects.toBeTruthy();
});

test('no tmux: skipped, nothing written', async () => {
  const b = await box({ tmux: false });
  const r = await run(b);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('OSCREPORTER: skipped-no-tmux');
  await expect(fs.access(path.join(b.home, '.tmuxifier-osc'))).rejects.toBeTruthy();
});

test('pusher maps every outcome and never throws', async () => {
  const mk = (res) => createOscReporterPusher({ readAsset: async () => Buffer.from('x'), runStdin: async () => res });
  expect(await mk({ code: 0, stdout: 'OSCREPORTER: applied\n' }).push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: true });
  expect(await mk({ code: 0, stdout: 'OSCREPORTER: skipped-no-python3\n' }).push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, skipped: 'no python3 on the box' });
  expect(await mk({ code: 0, stdout: 'OSCREPORTER: skipped-no-tmux\n' }).push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, skipped: 'no tmux on the box' });
  expect(await mk({ code: 1, stdout: '' }).push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, error: 'osc reporter push failed' });
  expect(await mk({ code: 0, stdout: 'garbage' }).push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, error: 'osc reporter push failed' });
  const noAsset = createOscReporterPusher({ readAsset: async () => { throw new Error('x'); }, runStdin: async () => ({ code: 0, stdout: '' }) });
  expect(await noAsset.push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, error: 'osc reporter asset unavailable' });
  const boom = createOscReporterPusher({ readAsset: async () => Buffer.from('x'), runStdin: async () => { throw new Error('x'); } });
  expect(await boom.push({ id: 'b' })).toEqual({ target: 'osc-reporter', ok: false, error: 'osc reporter push failed' });
  let seen;
  await createOscReporterPusher({ readAsset: async () => Buffer.from('abc'), runStdin: async (box, script, input) => { seen = { script, input }; return { code: 0, stdout: 'OSCREPORTER: applied' }; } }).push({ id: 'b' });
  expect(seen.script).toBe(buildOscReporterInstallScript());
  expect(seen.input.toString()).toBe('abc');
});
