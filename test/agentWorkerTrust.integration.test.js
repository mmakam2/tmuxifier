import { test, expect, afterEach } from 'vitest';
import {
  mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, existsSync, symlinkSync,
  accessSync, rmSync, chmodSync, constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkerBench } from './helpers/workerBench.js';
import {
  WORKER_TRUST_CODES, buildWorkerStartRemote, parseWorkerResult, parseWorkerTrust,
} from '../src/server/agentWorkers.js';

// The folder-trust write (design section 5.5) against a real tmux server and a real
// ~/.claude.json, once per JSON tool. Each case runs with a PATH that holds ONLY the commands
// the script needs plus one of jq, node and python3 (symlinks in a farm directory, the
// approach of test/claudeAgentMail.test.js), so each tool's branch is the one that ran. The
// bench's own bin/ (the pinned tmux wrapper) stays first on that PATH.

const SESSION = 'worker-api-1';
const TOOLS = ['jq', 'node', 'python3'];
// What the script runs besides tmux and the JSON tool (everything else is a shell builtin),
// plus what the pane it starts runs, because that pane inherits this PATH: `cat` for the rc
// file's token line, `sleep` for the stand-in agent's `exec sleep 600` that keeps it up.
const BASE_TOOLS = ['cp', 'mv', 'rm', 'ln', 'cat', 'sleep'];

const benches = [];
const farms = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.cleanup();
  for (const f of farms.splice(0)) rmSync(f, { recursive: true, force: true });
});

function bench() {
  const b = createWorkerBench({ defaultShell: 'bash' });
  benches.push(b);
  return b;
}

// The executable file a tool resolves to on this machine's PATH.
function whichFile(t) {
  for (const d of String(process.env.PATH).split(':')) {
    const f = path.join(d, t);
    try { accessSync(f, fsConstants.X_OK); return f; } catch { /* next */ }
  }
  throw new Error(`${t} is not installed; this suite needs a real ${t} (it does not skip)`);
}

// A directory of symlinks to exactly these tools.
function farm(tools) {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-trust-farm-'));
  farms.push(dir);
  for (const t of tools) symlinkSync(whichFile(t), path.join(dir, t));
  return dir;
}

function projectDir(b) {
  const dir = path.join(b.home, 'billing-api');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const claudeJson = (b) => path.join(b.home, '.claude.json');
const mode = (f) => statSync(f).mode & 0o777;
const leftovers = (b) => readdirSync(b.home).filter((n) => n.startsWith('.claude.json.'));

// Run the start script with trust on, under `shell`, with only `tool` (or none) to hand.
function start(b, dir, tool, { shell = 'sh', trust = true } = {}) {
  const remote = buildWorkerStartRemote({ session: SESSION, dir, trust });
  return b.run(shell, remote, { path: farm(tool ? [...BASE_TOOLS, tool] : BASE_TOOLS) });
}

async function waitFor(fn, what) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const STARTED = (trust) => ({ code: 0, stdout: `WORKER-TRUST: ${trust}\nWORKER: started\n` });

for (const tool of TOOLS) {
  test(`${tool}: no ~/.claude.json is created 0600 holding only the key`, () => {
    const b = bench();
    const dir = projectDir(b);
    const r = start(b, dir, tool);
    expect(r).toEqual(STARTED('written'));
    expect(parseWorkerTrust(r.stdout)).toBe('written');
    expect(parseWorkerResult(r.stdout)).toBe('started');
    expect(JSON.parse(readFileSync(claudeJson(b), 'utf8')))
      .toEqual({ projects: { [dir]: { hasTrustDialogAccepted: true } } });
    expect(mode(claudeJson(b))).toBe(0o600);
    expect(leftovers(b)).toEqual([]);
  });

  test(`${tool}: an existing file keeps every other key and its mode`, () => {
    const b = bench();
    const dir = projectDir(b);
    const before = {
      numStartups: 12,
      userID: 'abc123',
      hasCompletedOnboarding: true,
      note: 'café ✓',
      projects: {
        '/opt/other': { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] },
        [dir]: { hasTrustDialogAccepted: false, history: [{ display: 'hello' }], lastCost: 0.25 },
      },
    };
    writeFileSync(claudeJson(b), JSON.stringify(before, null, 2));
    chmodSync(claudeJson(b), 0o644);
    const r = start(b, dir, tool);
    expect(r).toEqual(STARTED('written'));
    expect(JSON.parse(readFileSync(claudeJson(b), 'utf8'))).toEqual({
      ...before,
      projects: { ...before.projects, [dir]: { ...before.projects[dir], hasTrustDialogAccepted: true } },
    });
    expect(mode(claudeJson(b))).toBe(0o644);
    expect(leftovers(b)).toEqual([]);
  });

  test(`${tool}: a file without this project gains it and loses nothing`, () => {
    const b = bench();
    const dir = projectDir(b);
    const before = { theme: 'dark', projects: { '/opt/other': { hasTrustDialogAccepted: true } } };
    writeFileSync(claudeJson(b), JSON.stringify(before), { mode: 0o600 });
    expect(start(b, dir, tool)).toEqual(STARTED('written'));
    expect(JSON.parse(readFileSync(claudeJson(b), 'utf8'))).toEqual({
      ...before, projects: { ...before.projects, [dir]: { hasTrustDialogAccepted: true } },
    });
  });

  test(`${tool}: a key already true is not written at all (bytes and inode unchanged)`, () => {
    const b = bench();
    const dir = projectDir(b);
    // Formatting no JSON tool would produce, so a rewrite would show in the bytes.
    const bytes = `{"projects":{"${dir}":{"hasTrustDialogAccepted":true,"x":1}},   "k":[1,2]}`;
    writeFileSync(claudeJson(b), bytes, { mode: 0o644 });
    const ino = statSync(claudeJson(b)).ino;
    const r = start(b, dir, tool);
    expect(r).toEqual(STARTED('already'));
    expect(parseWorkerTrust(r.stdout)).toBe('already');
    expect(readFileSync(claudeJson(b), 'utf8')).toBe(bytes);
    expect(statSync(claudeJson(b)).ino).toBe(ino);
    expect(mode(claudeJson(b))).toBe(0o644);
    expect(leftovers(b)).toEqual([]);
  });

  test(`${tool}: malformed JSON, a top level or projects that is not an object, fail and leave the file alone`, () => {
    const b = bench();
    const dir = projectDir(b);
    const cases = [
      '{"projects": {',
      '',
      '[]',
      '{"projects": []}',
      '{"projects": null}',
      `{"projects": {"${dir}": "yes"}}`,
      '{"a": 1}{"b": 2}',
    ];
    for (const [i, bytes] of cases.entries()) {
      writeFileSync(claudeJson(b), bytes);
      const ino = statSync(claudeJson(b)).ino;
      const r = start(b, dir, tool);
      expect(r.code, bytes).toBe(0);
      expect(parseWorkerTrust(r.stdout), bytes).toBe('failed');
      // The launch still happens (the first run starts the session, later ones find it up).
      expect(parseWorkerResult(r.stdout), bytes).toBe(i === 0 ? 'started' : 'exists');
      expect(r.stdout.split('\n')[0], bytes).toBe('WORKER-TRUST: failed');
      expect(readFileSync(claudeJson(b), 'utf8'), bytes).toBe(bytes);
      expect(statSync(claudeJson(b)).ino, bytes).toBe(ino);
      expect(leftovers(b), bytes).toEqual([]);
    }
  });
}

test('the first case passes under bash and zsh too', () => {
  for (const shell of ['bash', 'zsh']) {
    for (const tool of TOOLS) {
      const b = bench();
      const dir = projectDir(b);
      expect(start(b, dir, tool, { shell }), `${shell} ${tool}`).toEqual(STARTED('written'));
      expect(JSON.parse(readFileSync(claudeJson(b), 'utf8')), `${shell} ${tool}`)
        .toEqual({ projects: { [dir]: { hasTrustDialogAccepted: true } } });
      expect(mode(claudeJson(b)), `${shell} ${tool}`).toBe(0o600);
      expect(start(b, dir, tool, { shell }), `${shell} ${tool}`)
        .toEqual({ code: 0, stdout: 'WORKER-TRUST: already\nWORKER: exists\n' });
    }
  }
});

test('no jq, node or python3: no-json-tool, nothing written, the launch still happens', async () => {
  const b = bench();
  const dir = projectDir(b);
  const r = start(b, dir, null);
  expect(r).toEqual(STARTED('no-json-tool'));
  expect(parseWorkerTrust(r.stdout)).toBe('no-json-tool');
  await waitFor(() => b.standInLog(SESSION) === `token=set cwd=${dir} tty=yes`, 'the stand-in agent');
  expect(existsSync(claudeJson(b))).toBe(false);
  expect(leftovers(b)).toEqual([]);
});

test('a ~/.claude.json that is a symlink is never replaced by a file', () => {
  const b = bench();
  const dir = projectDir(b);
  const real = path.join(b.home, 'dotfiles-claude.json');
  writeFileSync(real, '{}');
  symlinkSync(real, claudeJson(b));
  const r = start(b, dir, 'jq');
  expect(r).toEqual(STARTED('failed'));
  expect(readFileSync(real, 'utf8')).toBe('{}');
  expect(lstatSync(claudeJson(b)).isSymbolicLink()).toBe(true);
  expect(leftovers(b)).toEqual([]);
});

test('trust off: no WORKER-TRUST line and no file created', () => {
  for (const tool of TOOLS) {
    const b = bench();
    const dir = projectDir(b);
    const r = start(b, dir, tool, { trust: false });
    expect(r, tool).toEqual({ code: 0, stdout: 'WORKER: started\n' });
    expect(parseWorkerTrust(r.stdout), tool).toBeNull();
    expect(existsSync(claudeJson(b)), tool).toBe(false);
  }
  // The default is off.
  const remote = buildWorkerStartRemote({ session: SESSION, dir: '/opt/billing-api' });
  expect(remote).not.toContain('WORKER-TRUST');
  expect(remote).not.toContain('.claude.json');
});

test('the trust block comes after the agent check and before has-session, and quotes the directory', () => {
  const remote = buildWorkerStartRemote({ session: SESSION, dir: '/opt/billing-api', trust: true });
  const at = (s) => {
    const i = remote.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };
  const agent = at("echo 'WORKER: no-agent-binary'");
  const trust = at('echo "WORKER-TRUST: $TRUST"');
  const has = at('has-session');
  expect(agent).toBeLessThan(trust);
  expect(trust).toBeLessThan(has);
  // The directory appears only as one single-quoted word, never inside a program.
  const unquoted = remote.replaceAll("'/opt/billing-api'", '');
  expect(unquoted).not.toContain('/opt/billing-api');
  // The launch line is unchanged.
  expect(remote).toContain(
    `new-session -d -s '${SESSION}' -c '/opt/billing-api' 'exec "$SHELL" -ic '\\''exec claude'\\'''`,
  );
});

test('WORKER_TRUST_CODES is the closed, frozen list', () => {
  expect(WORKER_TRUST_CODES).toEqual(['written', 'already', 'failed', 'no-json-tool']);
  expect(Object.isFrozen(WORKER_TRUST_CODES)).toBe(true);
});

test('parseWorkerTrust reads only the last exact WORKER-TRUST line with a known code', () => {
  expect(parseWorkerTrust('WORKER-TRUST: written\nWORKER: started\n')).toBe('written');
  expect(parseWorkerTrust('WORKER-TRUST: already\n')).toBe('already');
  expect(parseWorkerTrust('WORKER-TRUST: no-json-tool\nWORKER: started')).toBe('no-json-tool');
  expect(parseWorkerTrust('WORKER-TRUST: written\nWORKER-TRUST: failed\n')).toBe('failed');
  expect(parseWorkerTrust('WORKER-TRUST: failed\nWORKER-TRUST: bogus\n')).toBe('failed');
  expect(parseWorkerTrust('WORKER-TRUST: written extra')).toBeNull();
  expect(parseWorkerTrust(' WORKER-TRUST: written')).toBeNull();
  expect(parseWorkerTrust('WORKER-TRUST: written\r\n')).toBeNull();
  expect(parseWorkerTrust('WORKER-TRUST: toString')).toBeNull();
  expect(parseWorkerTrust('WORKER: started\n')).toBeNull();
  expect(parseWorkerTrust('')).toBeNull();
  expect(parseWorkerTrust(undefined)).toBeNull();
  expect(parseWorkerTrust(null)).toBeNull();
});
