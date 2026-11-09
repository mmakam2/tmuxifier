import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeStubTmux } from './helpers/stubTmux.js';

const ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-osc-reporter.py', import.meta.url));
const SHA = createHash('sha256').update(readFileSync(ASSET)).digest('hex');

const tmps = [];
const kids = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill('SIGKILL');
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(panes) {
  const home = mkdtempSync(path.join(tmpdir(), 'osc-sweep-'));
  tmps.push(home);
  const stubDir = path.join(home, 'bin');
  mkdirSync(stubDir);
  const stub = makeStubTmux(stubDir, { panes });
  const oscDir = path.join(home, '.tmuxifier-osc');
  const entries = path.join(oscDir, 'panes');
  mkdirSync(entries, { recursive: true });
  const env = {
    HOME: home, PATH: `${stubDir}:${process.env.PATH}`, ...stub.env, STUB_TMUX_ENTRY_DIR: entries,
  };
  const run = (...args) => execFileSync('python3', [ASSET, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const log = () => readFileSync(stub.logFile, 'utf8').split('\n').filter(Boolean);
  const pipeLines = () => log().filter((l) => l.startsWith('pipe-pane'));
  const entryFile = (n) => path.join(entries, String(n));
  const putEntry = (n, e) => writeFileSync(entryFile(n), JSON.stringify(e));
  const runWith = (extraEnv, ...args) => spawnSync('python3', [ASSET, ...args],
    { env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { home, stub, env, run, runWith, log, pipeLines, entryFile, putEntry, oscDir };
}

const rows = (...r) => r.map((x) => x + '\n');

test('attaches by pane command and registers entries', () => {
  const t = setup(rows('%1\t0\tzsh\tweb', '%2\t0\tcodex\tweb', '%3\t0\tpi\tother proj', '%4\t1\tcodex\tweb',
    '%5\t0\tclaude\tweb', '%6\t0\topencode\tweb', '%7\t0\tpip\tweb', '%8\t0\tpi-dev\tweb'));
  t.run('sweep', '--once');
  const pipes = t.pipeLines();
  expect(pipes).toHaveLength(4);
  for (const n of [2, 3, 6, 8]) {
    expect(pipes.some((l) => l.startsWith(`pipe-pane -o -t %${n} `) && l.includes(`listen %${n}`))).toBe(true);
    expect(JSON.parse(readFileSync(t.entryFile(n), 'utf8')).sha).toBe(SHA);
  }
  for (const n of [1, 4, 5, 7]) expect(existsSync(t.entryFile(n))).toBe(false);
  expect(pipes[0]).toContain(`exec python3 '${t.home}/.tmuxifier-osc/reporter.py' listen %`);
});

test('opencode is left to its plugin when the plugin file exists', () => {
  const t = setup(rows('%6\t0\topencode\tweb'));
  mkdirSync(path.join(t.home, '.config/opencode/plugins'), { recursive: true });
  writeFileSync(path.join(t.home, '.config/opencode/plugins/tmuxifier-agent.js'), '');
  t.run('sweep', '--once');
  expect(t.pipeLines()).toHaveLength(0);
});

test('detaches after three consecutive misses, without handover', () => {
  const t = setup(rows('%4\t1\tzsh\tweb'));
  t.putEntry(4, { pid: process.pid, sha: SHA, session: 'web', records: {}, lastWritten: null, handover: false, attachedAt: 1 });
  for (let i = 1; i <= 3; i++) {
    const before = t.pipeLines().length;
    t.run('sweep', '--once');
    const added = t.pipeLines().slice(before);
    if (i < 3) expect(added).toEqual([]);
    else expect(added).toEqual(['pipe-pane -t %4']);
  }
  expect(JSON.parse(readFileSync(t.entryFile(4), 'utf8')).handover).toBe(false);
  expect(JSON.parse(readFileSync(path.join(t.oscDir, 'miss.json'), 'utf8'))).toEqual({});
});

test('a matching pane resets its miss counter', () => {
  const t = setup(rows('%4\t1\tzsh\tweb'));
  t.putEntry(4, { pid: process.pid, sha: SHA, handover: false, attachedAt: 1 });
  t.run('sweep', '--once');
  t.run('sweep', '--once');
  expect(JSON.parse(readFileSync(path.join(t.oscDir, 'miss.json'), 'utf8'))).toEqual({ '%4': 2 });
  writeFileSync(t.stub.panesFile, '%4\t1\tcodex\tweb\n');
  t.run('sweep', '--once');
  t.run('sweep', '--once');
  expect(t.pipeLines()).toEqual([]);
  expect(JSON.parse(readFileSync(path.join(t.oscDir, 'miss.json'), 'utf8'))).toEqual({});
});

test('stale entries are deleted; a dead listener on a matching pane is re-attached', () => {
  const t = setup(rows('%2\t0\tcodex\tweb'));
  t.putEntry(9, { pid: process.pid, sha: SHA, handover: false, attachedAt: 1 });
  t.putEntry(2, { pid: 999999, sha: 'old', handover: false, attachedAt: 1 });
  t.run('sweep', '--once');
  expect(existsSync(t.entryFile(9))).toBe(false);
  expect(t.pipeLines()).toHaveLength(1);
  expect(t.pipeLines()[0]).toMatch(/^pipe-pane -o -t %2 .*listen %2$/);
  expect(JSON.parse(readFileSync(t.entryFile(2), 'utf8')).sha).toBe(SHA);
});

test('an entry with no pid yet is live for 30 s; past that it is dropped and its pipe left alone', () => {
  // Our `pipe-pane -o` lost to a pipe that appeared between list-panes and the
  // attach, or python never started: either way nothing proves the pipe is
  // ours, so it is never closed (I2a).
  const t = setup(rows('%2\t1\tcodex\tweb'));
  t.putEntry(2, { sha: SHA, handover: false, attachedAt: Date.now() / 1000 });
  t.run('sweep', '--once');
  expect(existsSync(t.entryFile(2))).toBe(true);
  expect(t.pipeLines()).toEqual([]);
  t.putEntry(2, { sha: SHA, handover: false, attachedAt: Date.now() / 1000 - 60 });
  t.run('sweep', '--once');
  expect(existsSync(t.entryFile(2))).toBe(false);
  expect(t.pipeLines()).toEqual([]);
});

test('no tmux, or no server: exit 0 and silent', () => {
  const t = setup([]);
  const onlyPython = path.join(t.home, 'pyonly');
  mkdirSync(onlyPython);
  execFileSync('ln', ['-s', execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim(), path.join(onlyPython, 'python3')]);
  for (const args of [['sweep', '--once'], ['sweep'], ['loop']]) {
    const r = spawnSync(`${onlyPython}/python3`, [ASSET, ...args], { env: { HOME: t.home, PATH: onlyPython }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  }
  writeFileSync(t.stub.logFile, '');
  const r = execFileSync('python3', [ASSET, 'sweep'], { env: { ...t.env, STUB_TMUX_NOSERVER: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(r).toBe('');
  expect(t.log().some((l) => l.startsWith('run-shell'))).toBe(false);
  expect(execFileSync('python3', [ASSET, 'loop'], { env: { ...t.env, STUB_TMUX_NOSERVER: '1' }, encoding: 'utf8' })).toBe('');
});

// A child that holds the loop lock, writes `pid sha`, and records SIGTERM.
async function holdLock(t, content) {
  const termFile = path.join(t.home, 'got-term');
  const code = `
import fcntl, os, signal, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
os.write(fd, (sys.argv[2].replace('PID', str(os.getpid())) + "\\n").encode())
def h(*a):
    open(sys.argv[3], 'w').write('x'); os._exit(0)
signal.signal(signal.SIGTERM, h)
print('ready', flush=True)
time.sleep(60)
`;
  const k = spawn('python3', ['-c', code, path.join(t.oscDir, 'loop.lock'), content, termFile], { stdio: ['ignore', 'pipe', 'ignore'] });
  kids.push(k);
  await new Promise((r) => k.stdout.once('data', r));
  return { k, termFile };
}
const waitFile = async (f) => { for (let i = 0; i < 100 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 20)); };

test('sweep without --once starts the loop when no lock is held', () => {
  const t = setup([]);
  t.run('sweep');
  const l = t.log().filter((x) => x.startsWith('run-shell -b'));
  expect(l).toHaveLength(1);
  expect(l[0]).toContain(`exec python3 '${t.home}/.tmuxifier-osc/reporter.py' loop`);
});

test('sweep leaves a held loop of the same version alone', async () => {
  const t = setup([]);
  const h = await holdLock(t, `PID ${SHA}`);
  t.run('sweep');
  expect(t.log().some((x) => x.startsWith('run-shell'))).toBe(false);
  expect(existsSync(h.termFile)).toBe(false);
});

test('sweep replaces a held loop of another version', async () => {
  const t = setup([]);
  const h = await holdLock(t, 'PID deadbeef');
  t.run('sweep');
  await waitFile(h.termFile);
  expect(existsSync(h.termFile)).toBe(true);
  expect(t.log().filter((x) => x.startsWith('run-shell -b') && x.includes(' loop'))).toHaveLength(1);
});

test('loop upgrade: stale-sha listener is handed over (flag set before detach)', async () => {
  const t = setup(rows('%2\t1\tcodex\tweb'));
  const holder = spawn('sleep', ['30']);
  kids.push(holder);
  t.putEntry(2, { pid: holder.pid, sha: 'old', session: 'web', records: {}, lastWritten: null, handover: false, attachedAt: 1 });
  const out = execFileSync('python3', [ASSET, 'loop'], { env: { ...t.env, TMUXIFIER_OSC_LOOP_ONCE: '1' }, encoding: 'utf8' });
  expect(out).toBe('');
  const l = t.log().filter((x) => x.startsWith('pipe-pane') || x.startsWith('ENTRY'));
  expect(l[0]).toBe('pipe-pane -t %2');
  expect(JSON.parse(l[1].replace(/^ENTRY 2 /, '')).handover).toBe(true);
  expect(l[2]).toMatch(/^pipe-pane -o -t %2 .*listen %2$/);
  expect(JSON.parse(readFileSync(t.entryFile(2), 'utf8')).sha).toBe(SHA);
  expect(readFileSync(path.join(t.oscDir, 'loop.lock'), 'utf8')).toMatch(new RegExp(`^\\d+ ${SHA}\\n$`));
});

test('a dead listener on a still-piped pane: entry dropped, pipe untouched, re-attached once the pipe drops', () => {
  // A dead listener's pipe closes itself on the pane's next output byte; an
  // operator pipe that replaced it in that window looks identical and must
  // survive (I2b). Only a LIVE pid is proof the pipe is ours.
  const t = setup(rows('%2\t1\tcodex\tweb'));
  t.putEntry(2, { pid: 999999, sha: 'old', session: 'web', records: {}, lastWritten: null, handover: false, attachedAt: 1 });
  t.run('sweep', '--once');
  expect(existsSync(t.entryFile(2))).toBe(false);
  expect(t.pipeLines()).toEqual([]);
  writeFileSync(t.stub.panesFile, '%2\t0\tcodex\tweb\n');
  t.run('sweep', '--once');
  expect(t.pipeLines().map((l) => l.replace(/ exec python3.*/, ''))).toEqual(['pipe-pane -o -t %2']);
  const e = JSON.parse(readFileSync(t.entryFile(2), 'utf8'));
  expect(e.pid).toBeUndefined();
  expect(e.sha).toBe(SHA);
});

test('sweep never hands over; only the loop does (no ping-pong with a not-yet-replaced loop)', () => {
  const t = setup(rows('%2\t1\tcodex\tweb'));
  t.putEntry(2, { pid: process.pid, sha: 'old', session: 'web', records: {}, lastWritten: null, handover: false, attachedAt: 1 });
  t.run('sweep', '--once');
  expect(t.pipeLines()).toEqual([]);
  expect(JSON.parse(readFileSync(t.entryFile(2), 'utf8')).sha).toBe('old');
});

test('the loop hands over only a claimed entry; an unclaimed one in grace waits', () => {
  const t = setup(rows('%2\t1\tcodex\tweb'));
  t.putEntry(2, { sha: 'old', session: 'web', records: {}, lastWritten: null, handover: false, attachedAt: Date.now() / 1000 });
  execFileSync('python3', [ASSET, 'loop'], { env: { ...t.env, TMUXIFIER_OSC_LOOP_ONCE: '1' }, encoding: 'utf8' });
  expect(t.pipeLines()).toEqual([]);
  expect(existsSync(t.entryFile(2))).toBe(true);
});

test('the entry exists (pid-less, current sha) before pipe-pane -o runs', () => {
  const t = setup(rows('%2\t0\tcodex\tweb', '%3\t0\tpi\tweb'));
  t.run('sweep', '--once');
  const l = t.log();
  for (const n of [2, 3]) {
    const i = l.findIndex((x) => x.startsWith(`pipe-pane -o -t %${n} `));
    expect(i).toBeGreaterThan(-1);
    expect(l[i + 1].startsWith(`ENTRY ${n} `)).toBe(true);
    const e = JSON.parse(l[i + 1].replace(/^ENTRY \d+ /, ''));
    expect(e.pid).toBeUndefined();
    expect(e.sha).toBe(SHA);
    expect(e.handover).toBe(false);
  }
});

test('the loop upgrade entry is pid-less at both pipe-pane calls and never rewritten after the attach', async () => {
  const t = setup(rows('%2\t1\tcodex\tweb'));
  const holder = spawn('sleep', ['30']);
  kids.push(holder);
  t.putEntry(2, { pid: holder.pid, sha: 'old', session: 'web', records: { '': { state: 'working', kind: null } }, lastWritten: 'web:working:1:prompt\n', handover: false, attachedAt: 1 });
  execFileSync('python3', [ASSET, 'loop'], { env: { ...t.env, TMUXIFIER_OSC_LOOP_ONCE: '1' }, encoding: 'utf8' });
  const entries = t.log().filter((x) => x.startsWith('ENTRY 2 ')).map((x) => JSON.parse(x.replace(/^ENTRY 2 /, '')));
  expect(entries).toHaveLength(2); // one per pipe-pane call: -t then -o
  for (const e of entries) {
    expect(e.pid).toBeUndefined();
    expect(e.handover).toBe(true);
    expect(e.sha).toBe(SHA);
    expect(e.records).toEqual({ '': { state: 'working', kind: null } });
    expect(e.lastWritten).toBe('web:working:1:prompt\n');
    expect(e.session).toBe('web');
  }
  expect(entries[1].attachedAt).toBe(entries[0].attachedAt);
  expect(JSON.parse(readFileSync(t.entryFile(2), 'utf8'))).toEqual(entries[1]);
});

test('the loop command exits 0 without python3 and silences python (no run-shell overlay)', () => {
  const t = setup([]);
  t.run('sweep');
  const l = t.log().filter((x) => x.startsWith('run-shell -b'));
  expect(l).toHaveLength(1);
  const cmd = l[0].replace(/^run-shell -b /, '');
  expect(cmd).toBe(`command -v python3 >/dev/null 2>&1 || exit 0; exec python3 '${t.home}/.tmuxifier-osc/reporter.py' loop >/dev/null 2>&1`);
  const noPython = path.join(t.home, 'nopython');
  mkdirSync(noPython);
  const r = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: noPython, HOME: t.home }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
});

// ------------------------------------------------------------- attach %N role

const SOCK = '/sock/default';
const TMUX_ENV = { TMUX: `${SOCK},123,0` };
const info = (sock, pane, piped) => ({ 5: `${sock}\t${pane}\t${piped}` });

function attachCase(paneInfo, extraEnv = TMUX_ENV, args = ['attach', '%5']) {
  const t = setup([]);
  t.stub.setPaneInfo(paneInfo);
  const r = t.runWith(extraEnv, ...args);
  return { t, r };
}

test('attach opens the listener pipe on an unpiped pane of the pane\'s own server', () => {
  const { t, r } = attachCase(info(SOCK, '%5', 0));
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
  expect(t.pipeLines()).toEqual([`pipe-pane -o -t %5 exec python3 '${t.home}/.tmuxifier-osc/reporter.py' listen %5`]);
  const e = JSON.parse(readFileSync(t.entryFile(5), 'utf8'));
  expect(e.sha).toBe(SHA);
  expect(e.handover).toBe(false);
  expect(typeof e.attachedAt).toBe('number');
  expect(e).not.toHaveProperty('pid');
  const envLines = readFileSync(t.stub.envLogFile, 'utf8').split('\n').filter(Boolean);
  expect(envLines.length).toBeGreaterThan(0);
  for (const l of envLines) expect(l).toBe('TMUX=unset');
  const loops = t.log().filter((x) => x.startsWith('run-shell'));
  expect(loops).toHaveLength(1);
  expect(loops[0]).toMatch(/^run-shell -b .* loop/);
});

test('attach starts no loop while another process holds loop.lock', async () => {
  const t = setup([]);
  await holdLock(t, `PID ${SHA}`);
  t.stub.setPaneInfo(info(SOCK, '%5', 0));
  const r = t.runWith(TMUX_ENV, 'attach', '%5');
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
  expect(t.pipeLines()).toEqual([`pipe-pane -o -t %5 exec python3 '${t.home}/.tmuxifier-osc/reporter.py' listen %5`]);
  expect(t.log().some((x) => x.startsWith('run-shell'))).toBe(false);
});

test.each([
  ['a pane that already has a pipe', info(SOCK, '%5', 1)],
  ['a pane of another tmux server', info('/other/sock', '%5', 0)],
  ['a reply naming another pane', info(SOCK, '%6', 0)],
])('attach does nothing for %s', (_n, paneInfo) => {
  const { t, r } = attachCase(paneInfo);
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
  expect(t.pipeLines()).toEqual([]);
  expect(existsSync(t.entryFile(5))).toBe(false);
  expect(t.log().some((x) => x.startsWith('run-shell'))).toBe(false);
});

test('attach does nothing when tmux cannot find the pane or has no server', () => {
  const a = attachCase({});
  expect(a.r.status).toBe(0);
  expect(a.r.stdout + a.r.stderr).toBe('');
  expect(a.t.pipeLines()).toEqual([]);
  expect(a.t.log().some((x) => x.startsWith('run-shell'))).toBe(false);
  const b = attachCase(info(SOCK, '%5', 0), { ...TMUX_ENV, STUB_TMUX_NOSERVER: '1' });
  expect(b.r.status).toBe(0);
  expect(b.r.stdout + b.r.stderr).toBe('');
  expect(b.t.pipeLines()).toEqual([]);
  expect(b.t.log().some((x) => x.startsWith('run-shell'))).toBe(false);
});

test('attach outside tmux makes no tmux call', () => {
  const { t, r } = attachCase(info(SOCK, '%5', 0), {});
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
  expect(t.log()).toEqual([]);
});

test.each([
  ['5', ['5']],
  ['%5x', ['%5x']],
  ['none', []],
])('attach with a bad pane argument (%s) makes no tmux call', (_n, a) => {
  const { t, r } = attachCase(info(SOCK, '%5', 0), TMUX_ENV, ['attach', ...a]);
  expect(r.status).toBe(0);
  expect(t.log()).toEqual([]);
});
