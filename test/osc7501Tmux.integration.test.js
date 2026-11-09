import { test, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, appendFileSync, readFileSync,
  existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The OSC 7501 reporter against a REAL tmux server. The stub-tmux suites make
// pipe-pane a no-op, so no listener process ever exists there and the
// cross-process ordering behind a version handover (loop writes the entry,
// closes the pipe, the predecessor sees EOF, the successor boots and claims)
// is unobservable; the C1/C2 defects of the first review were only visible
// here. This suite therefore drives the installed copy of the asset exactly
// as a box does: `sweep` from the probe, the loop under `run-shell -b`, the
// listener under `pipe-pane`, and a "codex" pane (a copy of /bin/bash named
// codex, so #{pane_current_command} matches the allowlist and we can type
// printf into it).
//
// Isolation, same posture as test/helpers/localBox.js: a private tmux server
// on its own socket name (-L) under a private TMUX_TMPDIR, a private HOME,
// and a child environment built from scratch (never process.env spread), so
// an operator running the suite inside tmux cannot have $TMUX redirect a
// single command at their own server. Every `tmux` the asset spawns goes
// through a wrapper in the private bin that pins the socket, which also keeps
// the reporter's own bare `tmux` calls off the operator's server if $TMUX
// handling ever changes. afterEach kills the private server and every process
// started under the private HOME, even when an assertion failed.
//
// A missing tmux or python3 FAILS this suite, loudly, instead of skipping:
// localBox.js treats a missing sshd the same way, because a suite that
// silently skips is a suite that silently stops protecting the code (this is
// the only test of the handover). Both are present on every machine this
// project is developed on.

const ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-osc-reporter.py', import.meta.url));
const shaOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function requireBinary(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const found = (r.stdout || '').trim();
  if (r.status !== 0 || !found) {
    throw new Error(`${name} is not installed; test/osc7501Tmux.integration.test.js needs a real ${name} (install it, this suite does not skip)`);
  }
  return found;
}

const harnesses = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function waitFor(fn, { ms = 10000, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function harness({ shell = false } = {}) {
  const tmuxBin = requireBinary('tmux');
  requireBinary('python3');
  const tmp = mkdtempSync(path.join(tmpdir(), 'osc-tmux-'));
  const home = path.join(tmp, 'home');
  const tmuxTmp = path.join(tmp, 'tmuxtmp');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, tmuxTmp, bin]) mkdirSync(d, { recursive: true });
  const socket = `osc7501-${randomUUID().slice(0, 8)}`;
  // The "agent": bash under the name codex. A copy, not a symlink, so
  // /proc/<pid>/cmdline (what tmux reads for pane_current_command) says codex.
  const codex = path.join(bin, 'codex');
  copyFileSync('/bin/bash', codex);
  chmodSync(codex, 0o755);
  if (shell) {
    copyFileSync('/bin/bash', path.join(bin, 'agy'));
    chmodSync(path.join(bin, 'agy'), 0o755);
  }
  writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec '${tmuxBin}' -L '${socket}' "$@"\n`);
  chmodSync(path.join(bin, 'tmux'), 0o755);
  const installed = path.join(home, '.tmuxifier-osc', 'reporter.py');
  mkdirSync(path.dirname(installed), { recursive: true });
  copyFileSync(ASSET, installed);
  const env = {
    HOME: home, TMUX_TMPDIR: tmuxTmp, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    SHELL: '/bin/bash', LANG: 'C.UTF-8', TMUXIFIER_OSC_DEBUG: '1',
  };
  const tmux = (...args) => execFileSync(path.join(bin, 'tmux'), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const h = {
    tmp, home, bin, env, installed, tmux,
    marker: path.join(home, '.tmuxifier-agent', 'web'),
    entry: path.join(home, '.tmuxifier-osc', 'panes', '0'),
    lock: path.join(home, '.tmuxifier-osc', 'loop.lock'),
    sweep() {
      const r = spawnSync('python3', [installed, 'sweep'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe('');
    },
    // The attach role as the agy shell function runs it; tmuxEnv is the $TMUX it sees.
    attachRole(paneId, tmuxEnv) {
      const r = spawnSync('python3', [installed, 'attach', paneId], { env: { ...env, TMUX: tmuxEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe('');
    },
    // Typed into the codex pane; printf turns the octal escapes into ESC/BEL.
    report(body) {
      tmux('send-keys', '-t', 'web', '-l', `printf '\\033]7501;${body}\\007'`);
      tmux('send-keys', '-t', 'web', 'Enter');
    },
    fmt(f) { return tmux('display-message', '-p', '-t', '%0', f).trim(); },
    procs(role) {
      const r = spawnSync('pgrep', ['-f', `${installed} ${role}`], { encoding: 'utf8' });
      return (r.stdout || '').split('\n').filter(Boolean).map(Number);
    },
    readEntry() { const t = readIf(h.entry); return t ? JSON.parse(t) : null; },
    async cleanup() {
      try { spawnSync(path.join(bin, 'tmux'), ['kill-server'], { env, stdio: 'ignore' }); } catch {}
      // Every process the asset spawned carries the installed path in argv.
      spawnSync('pkill', ['-9', '-f', tmp], { stdio: 'ignore' });
      for (let i = 0; i < 40 && spawnSync('pgrep', ['-f', tmp], { stdio: 'ignore' }).status === 0; i++) await sleep(50);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  harnesses.push(h);
  // -f /dev/null: no tmux.conf of any kind; the pane runs the codex "agent".
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'web', '-x', '120', '-y', '30',
    shell ? 'exec /bin/bash --norc --noprofile' : `exec '${codex}'`);
  const first = shell ? 'bash' : 'codex';
  await waitFor(() => h.fmt('#{pane_current_command}') === first, { what: `${first} pane` });
  return h;
}

test('a setup rerun hands the listener over live: marker kept, fold continues, one listener, no overlay', async () => {
  const h = await harness();
  const sha1 = shaOf(h.installed);

  // The probe's sweep attaches a listener and starts the loop.
  h.sweep();
  const first = await waitFor(() => { const e = h.readEntry(); return e && typeof e.pid === 'number' ? e : null; }, { what: 'listener claim' });
  expect(h.fmt('#{pane_pipe}')).toBe('1');
  expect(first.sha).toBe(sha1);
  expect(alive(first.pid)).toBe(true);
  await waitFor(() => h.procs('loop').length === 1, { what: 'one loop' });
  expect(readIf(h.lock)).toMatch(new RegExp(`^\\d+ ${sha1}\\n$`));

  h.report('state=working:app=codex');
  const working = await waitFor(() => { const m = readIf(h.marker); return m && /^web:working:\d+:prompt\n$/.test(m) ? m : null; }, { what: 'working marker' });

  // Setup rerun: the installed asset changes (one appended comment line), the
  // next probe sweep notices the loop's recorded sha differs and replaces it;
  // the new loop hands every listener over.
  appendFileSync(h.installed, '\n# rerun\n');
  const sha2 = shaOf(h.installed);
  expect(sha2).not.toBe(sha1);
  h.sweep();

  const second = await waitFor(() => {
    const e = h.readEntry();
    return e && e.sha === sha2 && typeof e.pid === 'number' && e.pid !== first.pid ? e : null;
  }, { what: 'successor claim' });
  expect(alive(second.pid)).toBe(true);
  expect(second.handover).toBe(false);
  expect(second.records).toEqual({ '': { state: 'working', kind: null } });
  expect(second.lastWritten).toBe(working);
  await waitFor(() => !alive(first.pid), { what: 'predecessor exit' });
  await sleep(2500); // past the new loop's next 2 s pass: a wrong heal would re-pipe there
  expect(readIf(h.marker)).toBe(working);
  expect(h.procs('listen %0')).toEqual([second.pid]);
  await waitFor(() => h.procs('loop').length === 1 && (readIf(h.lock) || '').includes(sha2), { what: 'one new loop' });
  expect(h.readEntry()).toMatchObject({ pid: second.pid, sha: sha2, handover: false });

  // C2: the SIGTERM'd loop must not have popped a view-mode overlay anywhere.
  const modes = h.tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_in_mode} [#{pane_mode}]').trim().split('\n');
  expect(modes).toEqual(['%0 0 []']);

  // The fold continues from the seeded state: idle after working is a finished
  // turn (ready:stop), not a cold first observation (ready:start).
  h.report('state=idle:app=codex');
  await waitFor(() => /^web:ready:\d+:stop\n$/.test(readIf(h.marker) || ''), { what: 'ready:stop marker' });

  // Bare clear from the program: the marker is ours, so it is removed.
  h.report('state=clear');
  await waitFor(() => !existsSync(h.marker), { what: 'marker removal' });
  expect(h.fmt('#{pane_in_mode}')).toBe('0');
});

test('a probe-only chunk is not an observation: a foreign working marker survives it and the listener exit', async () => {
  const h = await harness();
  mkdirSync(path.dirname(h.marker), { recursive: true });
  writeFileSync(h.marker, 'web:working:1:prompt\n'); // e.g. the Claude hook's
  h.sweep();
  await waitFor(() => { const e = h.readEntry(); return e && typeof e.pid === 'number'; }, { what: 'listener claim' });
  h.report('?');
  await sleep(700);
  expect(readIf(h.marker)).toBe('web:working:1:prompt\n');
  // The agent exits (the pane closes with it): EOF without handover.
  h.tmux('send-keys', '-t', 'web', '-l', 'exit');
  h.tmux('send-keys', '-t', 'web', 'Enter');
  await waitFor(() => h.procs('listen %0').length === 0, { what: 'listener exit' });
  expect(readIf(h.marker)).toBe('web:working:1:prompt\n');
});

test('pre-attach catches a report sent the moment the agent starts', async () => {
  const h = await harness({ shell: true });
  const payload = path.join(h.tmp, 'agent.sh');
  writeFileSync(payload, "printf '\\033]7501;state=blocked:kind=permission:app=antigravity\\007'; sleep 30; true\n");
  h.tmux('send-keys', '-t', 'web', '-l', `python3 "$HOME/.tmuxifier-osc/reporter.py" attach "$TMUX_PANE"; agy --norc --noprofile ${payload}`);
  h.tmux('send-keys', '-t', 'web', 'Enter');
  await waitFor(() => /^web:blocked:\d+:permission\n$/.test(readIf(h.marker) || ''), { what: 'blocked marker' });
  expect(h.fmt('#{pane_current_command}')).toBe('agy');
  expect(h.fmt('#{pane_pipe}')).toBe('1');
  const e = await waitFor(() => { const x = h.readEntry(); return x && typeof x.pid === 'number' ? x : null; }, { what: 'listener pid' });
  expect(alive(e.pid)).toBe(true);
  expect(h.procs('loop')).toEqual([]);
});

test("an operator's pipe is left alone", async () => {
  const h = await harness({ shell: true });
  const log = path.join(h.tmp, 'op.log');
  h.tmux('pipe-pane', '-t', '%0', `cat > '${log}'`);
  expect(h.fmt('#{pane_pipe}')).toBe('1');
  h.attachRole('%0', h.fmt('#{socket_path}') + ',1,0');
  expect(h.fmt('#{pane_pipe}')).toBe('1');
  expect(existsSync(h.entry)).toBe(false);
  h.tmux('send-keys', '-t', 'web', '-l', 'echo hello-operator');
  h.tmux('send-keys', '-t', 'web', 'Enter');
  await waitFor(() => (readIf(log) || '').includes('hello-operator'), { what: 'operator log' });
});

test('a pane of another tmux server is refused', async () => {
  const h = await harness({ shell: true });
  const tmuxBin = requireBinary('tmux');
  const other = `osc7501-other-${randomUUID().slice(0, 8)}`;
  const run = (...a) => execFileSync(tmuxBin, ['-L', other, ...a], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('-f', '/dev/null', 'new-session', '-d', '-s', 'elsewhere', 'sleep 60');
    const otherSock = run('display-message', '-p', '#{socket_path}').trim();
    expect(otherSock).not.toBe(h.fmt('#{socket_path}'));
    h.attachRole('%0', otherSock + ',1,0');
    expect(h.fmt('#{pane_pipe}')).toBe('0');
    expect(existsSync(h.entry)).toBe(false);
  } finally {
    try { run('kill-server'); } catch {}
  }
});
