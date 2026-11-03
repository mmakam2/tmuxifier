import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEnsureTmuxRemote, NODE_MAJOR } from '../src/server/boxActions.js';

// Ticking a catalog tool installs it when missing and never touches a copy the
// box already has. These run the REAL generated script under each login shell a
// box can have, against a hermetic PATH of recording stubs: every binary that
// could change the machine is a stub and PATH holds nothing else.
const SHELLS = ['/bin/sh', '/usr/bin/bash', '/usr/bin/zsh'].filter((s) => existsSync(s));
const CATALOG = ['curl', 'git', 'gh', 'node', 'bubblewrap', 'codex', 'claude', 'agy'];
const REAL = ['sed', 'grep', 'rm', 'mktemp', 'touch', 'env'];
const ALWAYS = ['tmux', 'chsh', 'install', 'tee', 'mkdir', 'bash', 'sudo', 'id'];

let dir;
let bin;
let home;
let log;

const stub = (name, body) => fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const recorder = (name) => stub(name, [
  `printf '%s %s\\n' '${name}' "$*" >> "$STUB_LOG"`,
  `case " \${STUB_FAIL:-} " in *' ${name} '*) exit 100 ;; esac`,
  'exit 0',
].join('\n'));

async function box({ present = [], pm = 'apt-get' } = {}) {
  for (const b of REAL) {
    await fs.symlink([`/usr/bin/${b}`, `/bin/${b}`].find((p) => existsSync(p)), path.join(bin, b));
  }
  for (const b of [...ALWAYS, ...present, pm]) await recorder(b);
  await stub('id', 'echo "${STUB_UID:-0}"');
  await stub('sudo', `printf 'sudo %s\\n' "$*" >> "$STUB_LOG"\nexec "$@"`);
  if (present.includes('node')) await stub('node', 'echo "v${STUB_NODE}"');
  if (pm === 'apt-get') {
    await stub('dpkg', 'if [ "$1" = --print-architecture ]; then echo amd64; exit 0; fi\nexit 1');
  }
}

function run(shell, tools, env = {}) {
  const script = buildEnsureTmuxRemote('web', undefined, { tools, createSession: false });
  return new Promise((resolve) => {
    execFile(shell, ['-c', script], {
      cwd: home,
      timeout: 10000,
      env: { PATH: bin, HOME: home, TMPDIR: dir, STUB_LOG: log, ...env },
    }, async (err, stdout, stderr) => {
      const calls = await fs.readFile(log, 'utf8').catch(() => '');
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stderr,
        calls: calls.split('\n').filter(Boolean),
      });
    });
  });
}

const NPM_LATEST = 'npm install -g npm@latest --engine-strict';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-tools-'));
  bin = path.join(dir, 'bin');
  home = path.join(dir, 'home');
  log = path.join(dir, 'calls.log');
  await fs.mkdir(bin);
  await fs.mkdir(home);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe.each(SHELLS)('catalog tools under %s', (shell) => {
  test('a box with every tool gets no install, upgrade or update of any kind', async () => {
    await box({ present: ['curl', 'git', 'gh', 'node', 'npm', 'bwrap', 'codex', 'claude', 'agy', 'arecord'] });
    const r = await run(shell, CATALOG, { STUB_NODE: `${NODE_MAJOR}.1.0` });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test('a Node older than the pin is left alone, along with its npm', async () => {
    await box({ present: ['curl', 'node', 'npm'] });
    const r = await run(shell, ['node'], { STUB_NODE: '18.20.4' });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test('a fresh Node install moves npm to its newest release afterwards', async () => {
    await box({ present: ['curl', 'npm'] });
    const r = await run(shell, ['node']);
    expect(r.code).toBe(0);
    const node = r.calls.indexOf('apt-get install -y --no-install-recommends nodejs');
    expect(node).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf(NPM_LATEST)).toBeGreaterThan(node);
  });

  test('npm refusing its newest release keeps the bundled npm and the setup going', async () => {
    await box({ present: ['curl', 'npm'] });
    const r = await run(shell, ['node'], { STUB_FAIL: 'npm' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/keeping the npm bundled with Node/);
  });

  test('a failed Node install aborts before npm is touched', async () => {
    await box({ present: ['curl', 'npm'] });
    const r = await run(shell, ['node'], { STUB_FAIL: 'apt-get' });
    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain(NPM_LATEST);
  });

  test('a non-root box moves npm through sudo, like the install before it', async () => {
    await box({ present: ['curl', 'npm'] });
    const r = await run(shell, ['node'], { STUB_UID: '1000' });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`sudo ${NPM_LATEST}`);
  });

  test('codex installs with the newest npm on a fresh box', async () => {
    await box({ present: ['curl', 'npm'] });
    const r = await run(shell, ['codex']);
    expect(r.code).toBe(0);
    expect(r.calls.indexOf('npm install -g @openai/codex')).toBeGreaterThan(r.calls.indexOf(NPM_LATEST));
    expect(r.calls).toContain(NPM_LATEST);
  });
});

describe('npm on a fresh Node install, by package manager', () => {
  test.each(['dnf', 'yum'])('%s installs NodeSource, so npm moves to its newest release', async (pm) => {
    await box({ present: ['curl', 'npm'], pm });
    const r = await run('/bin/sh', ['node']);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(NPM_LATEST);
  });

  test.each(['pacman', 'apk', 'zypper'])('%s owns its npm package, so npm stays with it', async (pm) => {
    await box({ present: ['curl', 'npm'], pm });
    const r = await run('/bin/sh', ['node']);
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain(NPM_LATEST);
  });
});
