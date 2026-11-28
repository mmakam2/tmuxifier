import { test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTmuxSessions, parseMeta, parsePaneMarks, createStatusChecker, PROBE_REMOTE, OSC_SWEEP, parseTmuxWindows, attachWindows, parseTmuxPanes, PANE_FMT, PANE_ROWS_MAX, SESSION_NAME_MAX, SESSION_ROWS_MAX, STATUS_ERROR_MAX } from '../src/server/status.js';

test('parseTmuxSessions maps fields', () => {
  const out = 'web:3:1:1718000000\nbuild:1:0:1718000100\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 3, attached: true, activity: 1718000000, paneCmd: '' },
    { name: 'build', windows: 1, attached: false, activity: 1718000100, paneCmd: '' },
  ]);
});

test('parseTmuxSessions treats #{session_attached} >= 2 as attached (multi-viewer panes)', () => {
  // tmux's #{session_attached} is the count of attached clients (0, 1, 2, ...),
  // not a 0/1 flag. Two open browser panes or browser + Android sizing viewer
  // produce 2+, which must stay attached: true so agent notifications stay suppressed.
  const out = 'none:1:0:1718000000:claude\none:1:1:1718000000:claude\ntwo:2:2:1718000000:claude\nthree:1:3:1718000000:zsh\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'none', windows: 1, attached: false, activity: 1718000000, paneCmd: 'claude' },
    { name: 'one', windows: 1, attached: true, activity: 1718000000, paneCmd: 'claude' },
    { name: 'two', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
    { name: 'three', windows: 1, attached: true, activity: 1718000000, paneCmd: 'zsh' },
  ]);
});

test('the probe reads the active window last-output time, not the session key-input time', () => {
  // `#{session_activity}` is bumped by KEY INPUT and attach, not by pane output:
  // a claude that has been thinking for minutes without a keystroke reads as
  // idle, and merely attaching fabricates a fresh "active" reading. Verified on
  // a live box: session_activity froze 109s behind while the pane was repainting
  // its spinner every second. `#{window_activity}` is the output clock — it
  // tracks the repaint and stays frozen at an idle claude prompt, which is
  // exactly the working-vs-waiting distinction healthHistory needs.
  expect(PROBE_REMOTE).toContain('#{window_activity}');
  expect(PROBE_REMOTE).not.toContain('#{session_activity}');
});

test('parseTmuxSessions ignores the __META__ health line and still parses sessions after it', () => {
  const out = '__META__ load1=0.42 cpus=4 diskPct=61\nweb:2:1:1718000000\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: '' },
  ]);
});

test('parseMeta extracts a full KEY=VALUE health line into numbers', () => {
  const out = '__META__ load1=0.42 load5=0.31 load15=0.20 cpus=4 memTotalKb=8160000 memAvailKb=3120000 diskTotalKb=51474912 diskUsedKb=31200000 diskPct=61 uptimeSec=183942\nweb:1:0:1\n';
  expect(parseMeta(out)).toEqual({
    load1: 0.42, load5: 0.31, load15: 0.20, cpus: 4,
    memTotalKb: 8160000, memAvailKb: 3120000,
    diskTotalKb: 51474912, diskUsedKb: 31200000, diskPct: 61, uptimeSec: 183942,
  });
});

test('parseMeta tolerates a partial line (missing sources just drop their field)', () => {
  expect(parseMeta('__META__ load1=0.5 diskPct=10\nweb:1:0:1\n')).toEqual({ load1: 0.5, diskPct: 10 });
});

test('parseMeta returns null when the line is absent', () => {
  expect(parseMeta('web:1:0:1\n')).toBeNull();
});

test('parseMeta captures the cgroup cpu counter (cpuUsageUsec)', () => {
  expect(parseMeta('__META__ cpus=2 cpuUsageUsec=123456789\nweb:1:0:1\n')).toEqual({ cpus: 2, cpuUsageUsec: 123456789 });
});

test('parseMeta returns null when the line carries no numeric fields and ignores junk tokens', () => {
  expect(parseMeta('__META__ load1=NaN cpus= junk notakey=5\n')).toBeNull();
});

test('parseMeta keeps the OS identity fields as strings (the only non-numeric keys)', () => {
  expect(parseMeta('__META__ osId=debian osVer=12 cpus=4\nweb:1:0:1\n')).toEqual({
    osId: 'debian', osVer: '12', cpus: 4,
  });
});

test('parseMeta drops an OS field that is not a bare token (spaces split it; junk is refused)', () => {
  // A crafted /etc/os-release could carry anything; the value is a display
  // string, so it is allowlisted here rather than trusted from the box.
  expect(parseMeta('__META__ osId=deb<script> osVer=' + 'x'.repeat(33) + '\n')).toBeNull();
});

test('parseMeta accepts an OS line on its own (a box that reports nothing numeric)', () => {
  expect(parseMeta('__META__ osId=alpine osVer=3.19\n')).toEqual({ osId: 'alpine', osVer: '3.19' });
});

test('checkBox: unreachable when ssh fails with no stdout', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'timeout' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: false, error: 'timeout' });
});

test('checkBox: auth failure is reported as needsAuth (so the UI can prompt a re-login)', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.needsAuth).toBe(true);
});

test('checkBox: connection failure stays plain unreachable (not needsAuth)', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host h port 22: Connection refused' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.needsAuth).toBeFalsy();
});

test('checkBox: changed host key is reported as hostKeyChanged', async () => {
  const stderr = '@@@@@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@@@@@@@@@\nHost key verification failed.';
  const run = async () => ({ code: 255, stdout: '', stderr });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.hostKeyChanged).toBe(true);
  expect(status.needsAuth).toBeFalsy();
});

test('checkBox: auth failure stays needsAuth, not hostKeyChanged', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.needsAuth).toBe(true);
  expect(status.hostKeyChanged).toBeFalsy();
});

test('checkBox: tmux missing', async () => {
  const run = async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: false, sessions: [], panes: [] });
});

test('checkBox: reports sessions', async () => {
  const run = async () => ({ code: 0, stdout: 'web:2:1:1718000000\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(true);
  expect(status.tmux).toBe(true);
  expect(status.sessions[0].name).toBe('web');
});

test('checkBox: passes controlDir through to the probe argv (multiplexing)', async () => {
  let seen;
  const run = async (argv) => { seen = argv; return { code: 0, stdout: '', stderr: '' }; };
  await createStatusChecker({ run, controlDir: '/run/cm' }).checkBox({ host: 'h' });
  expect(seen).toContain('ControlMaster=auto');
  expect(seen).toContain('ControlPath=/run/cm/%C');
});

test('checkBox: threads controlPersist into the probe argv so probe-established masters stay warm', async () => {
  let seen;
  const run = async (argv) => { seen = argv; return { code: 0, stdout: '', stderr: '' }; };
  await createStatusChecker({ run, controlDir: '/run/cm', controlPersist: 600 }).checkBox({ host: 'h' });
  expect(seen).toContain('ControlPersist=600');
});

test('checkBox: reaps the stale socket when ssh reports disabling multiplexing (password box stuck red)', async () => {
  const reaped = [];
  const run = async () => ({
    code: 255,
    stdout: '',
    stderr: 'ControlSocket /run/cm/abc already exists, disabling multiplexing\nme@h: Permission denied (publickey,password).',
  });
  const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
  const status = await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h', user: 'me' });
  expect(reaped).toHaveLength(1);
  expect(reaped[0]).toMatchObject({ host: 'h' });
  expect(status.needsAuth).toBe(true); // still surfaced as needs-login until the user re-auths
});

test('checkBox: reaps the stale socket even when the probe still succeeds (key box that silently lost multiplexing)', async () => {
  const reaped = [];
  const run = async () => ({
    code: 0,
    stdout: 'web:1:0:1718000000\n',
    stderr: 'ControlSocket /run/cm/abc already exists, disabling multiplexing',
  });
  const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
  const status = await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h' });
  expect(reaped).toHaveLength(1);
  expect(status.reachable).toBe(true); // box works; we just restore mux for next time
});

test('checkBox: still reaps on the other real stale-mux messages (muxclient fallback, case-insensitive)', async () => {
  for (const stderr of [
    'muxclient: master hello exchange failed, disabling multiplexing',
    'banner line\r\ncontrolsocket /run/cm/abc ALREADY EXISTS\r\n',
  ]) {
    const reaped = [];
    const run = async () => ({ code: 0, stdout: 'web:1:0:1718000000\n', stderr });
    const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
    await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h' });
    expect(reaped, stderr).toHaveLength(1);
  }
});

test('checkBox: the stale-mux check stays the same line, so a later "already exists" line does not reap', async () => {
  const reaped = [];
  const run = async () => ({ code: 0, stdout: 'web:1:0:1718000000\n', stderr: 'ControlSocket\nfile already exists\nControlSocket /x\n already exists' });
  const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
  await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h' });
  expect(reaped).toHaveLength(0);
});

test('checkBox: box-controlled stderr cannot make the stale-mux check backtrack quadratically', async () => {
  // The box's login shell writes to the probe's stderr (up to execFile's 1 MB
  // maxBuffer). One line of `ControlSocket ` with no ` already exists` made the
  // old `ControlSocket .* already exists` regex rescan to end-of-line from every
  // occurrence -- ~14s of main-thread work per status poll at this size.
  const hostile = 'ControlSocket '.repeat(70000);
  for (const [stderr, reaps] of [
    [hostile, 0],
    [`${hostile}\nControlSocket /run/cm/abc already exists, disabling multiplexing`, 1],
  ]) {
    const reaped = [];
    const run = async () => ({ code: 0, stdout: 'web:1:0:1718000000\n', stderr });
    const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
    const started = performance.now();
    await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(reaped).toHaveLength(reaps);
  }
});

test('checkBox: does not reap when multiplexing is healthy', async () => {
  const reaped = [];
  const run = async () => ({ code: 0, stdout: 'web:1:0:1718000000\n', stderr: '' });
  const reapStaleMaster = async (box) => { reaped.push(box); return { ok: true, reaped: true }; };
  await createStatusChecker({ run, controlDir: '/run/cm', reapStaleMaster }).checkBox({ host: 'h' });
  expect(reaped).toHaveLength(0);
});

test('checkBox: returns unreachable instead of throwing for an unsafe box', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: '-oProxyCommand=x' });
  expect(status.reachable).toBe(false);
});

function writeFakeTmux(dir, body) {
  const p = path.join(dir, 'tmux');
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
}
// The probe now also emits a leading `__META__` health line; these tests assert
// the tmux/session portion, so strip it (parseMeta is covered separately above).
function runProbe(pathDir) {
  return execFileSync('/bin/sh', ['-c', PROBE_REMOTE], { env: { PATH: pathDir }, encoding: 'utf8' })
    .split(/\r?\n/).filter((l) => !l.startsWith('__META__')).join('\n').trim();
}

test('PROBE_REMOTE: tmux present with sessions prints the format lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-tmux-'));
  // The fake binary is invoked twice now (`ls` for sessions, `list-windows -a`
  // for windows); stay silent on the second so this fixture still asserts only
  // the session line, as before the window probe existed.
  writeFakeTmux(dir, `[ "$1" = "list-windows" ] && exit 0\necho 'web:2:1:123'`);
  expect(runProbe(dir)).toBe('web:2:1:123');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PROBE_REMOTE: tmux present with no sessions prints nothing (not __NO_TMUX__)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-tmux-'));
  writeFakeTmux(dir, `exit 1`);
  expect(runProbe(dir)).toBe('');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PROBE_REMOTE: tmux absent prints __NO_TMUX__', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-empty-'));
  expect(runProbe(dir)).toBe('__NO_TMUX__');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PROBE_REMOTE: emits a leading __META__ health line (best-effort, never blocks status)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-meta-'));
  writeFakeTmux(dir, `echo 'web:1:0:1'`);
  const raw = execFileSync('/bin/sh', ['-c', PROBE_REMOTE], { env: { PATH: dir }, encoding: 'utf8' });
  const meta = raw.split(/\r?\n/).find((l) => l.startsWith('__META__'));
  expect(meta).toBeDefined();
  // On Linux /proc/loadavg is readable even with a bare PATH, so at least load1 is present.
  expect(parseMeta(raw)).toMatchObject({ load1: expect.any(Number) });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PROBE_REMOTE: reports the distro id/version using shell built-ins only (bare PATH, no awk)', () => {
  // The probe runs with a bare PATH in this test, so an /etc/os-release reader
  // built on awk would silently yield nothing — hence the `read`/`case` loop.
  if (!fs.existsSync('/etc/os-release')) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-os-'));
  const raw = execFileSync('/bin/sh', ['-c', PROBE_REMOTE], { env: { PATH: dir }, encoding: 'utf8' });
  expect(parseMeta(raw)).toMatchObject({ osId: expect.stringMatching(/^[a-z0-9._-]+$/) });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkBox: surfaces host metrics from the __META__ line when present', async () => {
  const run = async () => ({ code: 0, stdout: '__META__ load1=0.7 memTotalKb=1000 memAvailKb=400 diskPct=55\nweb:1:0:1718000000\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(true);
  expect(status.tmux).toBe(true);
  expect(status.sessions).toEqual([{ name: 'web', windows: 1, attached: false, activity: 1718000000, paneCmd: '' }]);
  expect(status.metrics).toEqual({ load1: 0.7, memTotalKb: 1000, memAvailKb: 400, diskPct: 55 });
});

test('checkBox: metrics attach even when tmux is not installed (reachable box, __NO_TMUX__)', async () => {
  const run = async () => ({ code: 0, stdout: '__META__ load1=0.1\n__NO_TMUX__\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: false, sessions: [], panes: [], metrics: { load1: 0.1 } });
});

test('checkBox: omits metrics when the probe carries no __META__ line', async () => {
  const run = async () => ({ code: 0, stdout: 'web:1:0:1718000000\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.metrics).toBeUndefined();
});

test('checkBox: derives true CPU% from the cgroup counter delta across two polls (no first-sample value)', async () => {
  let clock = 0;
  let usage = 1_000_000; // µs of CPU time so far
  const run = async () => ({ code: 0, stdout: `__META__ cpus=1 cpuUsageUsec=${usage}\n__NO_TMUX__\n`, stderr: '' });
  const sc = createStatusChecker({ run, now: () => clock });
  const first = await sc.checkBox({ host: 'h' });
  expect(first.metrics.cpuPct).toBeUndefined();          // one sample isn't a rate
  clock = 30_000; usage = 1_000_000 + 15_000_000;        // +15s CPU over a 30s wall window on 1 core
  const second = await sc.checkBox({ host: 'h' });
  expect(second.metrics.cpuPct).toBe(50);                // 15s / 30s / 1 core = 50%
});

test('checkBox: normalizes CPU% by the core count (matches Proxmox per-container %)', async () => {
  let clock = 0;
  let usage = 0;
  const run = async () => ({ code: 0, stdout: `__META__ cpus=4 cpuUsageUsec=${usage}\n__NO_TMUX__\n`, stderr: '' });
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });
  clock = 30_000; usage = 30_000_000;                    // a full core busy for 30s, but 4 cores allocated
  const second = await sc.checkBox({ host: 'h' });
  expect(second.metrics.cpuPct).toBe(25);                // 1 of 4 cores = 25%
});

test('checkBox: a counter reset (container restart) does not produce a bogus CPU%', async () => {
  let clock = 0;
  let usage = 50_000_000;
  const run = async () => ({ code: 0, stdout: `__META__ cpus=1 cpuUsageUsec=${usage}\n__NO_TMUX__\n`, stderr: '' });
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });
  clock = 30_000; usage = 2_000_000;                     // counter went backwards
  const second = await sc.checkBox({ host: 'h' });
  expect(second.metrics.cpuPct).toBeUndefined();
});

test('checkBox: tmux installed with zero sessions reports reachable + tmux:true + empty sessions', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: true, sessions: [], panes: [] });
});

test('checkBox: skips the SSH probe while inside the backoff window (failing box not re-probed every poll)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // 1st probe: fail #1 -> next allowed in 30s
  expect(calls).toBe(1);
  clock = 10_000;                             // 10s later, still inside the 30s window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(1);                      // skipped, returned last-known
  clock = 31_000;                            // past the window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                      // probed again
});

test('checkBox: the second failure waits 60s, not 30s (interval escalates by 30s)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail #1 -> due at 30s
  clock = 31_000; await sc.checkBox({ host: 'h' }); // fail #2 -> due at 31s + 60s = 91s
  expect(calls).toBe(2);
  clock = 61_000; await sc.checkBox({ host: 'h' }); // 30s after #2: still inside the 60s window
  expect(calls).toBe(2);                      // skipped -> interval really grew to 60s
  clock = 92_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(3);
});

test('checkBox: interval caps at the 5m floor and marks the box paused, never fully stopping', async () => {
  let clock = 0;
  const run = async () => ({ code: 255, stdout: '', stderr: 'timeout' });
  const sc = createStatusChecker({ run, now: () => clock });
  let due = 0;
  let last;
  for (let n = 1; n <= 10; n++) {             // 30*10 = 300 reaches the cap
    clock = due;
    last = await sc.checkBox({ host: 'h' });
    due = clock + Math.min(30 * n, 300) * 1000;
  }
  expect(last.paused).toBe(true);             // at the 5m floor
  expect(last.nextProbeAt).toBe(clock + 300_000);
  clock = due;                                // one more window later
  const next = await sc.checkBox({ host: 'h' });
  expect(next.paused).toBe(true);             // stays at the floor, still probing
});

test('checkBox: needsAuth jumps straight to the 5m floor (paused immediately, no escalation)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  const st = await sc.checkBox({ host: 'h' });
  expect(st.needsAuth).toBe(true);
  expect(st.paused).toBe(true);               // paused on the very first needsAuth
  clock = 299_000; await sc.checkBox({ host: 'h' }); // just under 5m
  expect(calls).toBe(1);                       // not re-probed inside the 5m window
  clock = 301_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                       // re-probed at the 5m cadence
});

test('checkBox: a successful probe clears backoff (next probe happens immediately)', async () => {
  let clock = 0;
  let mode = 'fail';
  let calls = 0;
  const run = async () => {
    calls++;
    return mode === 'fail'
      ? { code: 255, stdout: '', stderr: 'timeout' }
      : { code: 0, stdout: 'web:1:0:1', stderr: '' };
  };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail #1 -> 30s window
  mode = 'ok';
  clock = 31_000;
  const ok = await sc.checkBox({ host: 'h' });
  expect(ok.reachable).toBe(true);
  expect(ok.paused).toBeUndefined();          // success returns the plain result
  mode = 'fail';
  clock = 31_500;                            // immediately after, no leftover window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(3);                       // probed every call: backoff was cleared by success
});

test('resetBackoff: clears a box so the next checkBox probes immediately despite an open window', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail -> 30s window
  clock = 5_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(1);                       // throttled
  sc.resetBackoff({ host: 'h' });             // user engaged the box
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                       // probed immediately
  sc.resetBackoff('h');                        // string-id form is also accepted (no throw)
});

test('checkBox: coalesces concurrent probes of the same box into one ssh call (no per-tab amplification)', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20)); // probe is in-flight while a 2nd poll arrives
    return { code: 0, stdout: 'web:1:0:1', stderr: '' };
  };
  const sc = createStatusChecker({ run });
  // Five dashboard tabs each poll /api/status at the same instant -> one box.
  const results = await Promise.all(Array.from({ length: 5 }, () => sc.checkBox({ host: 'h' })));
  expect(calls).toBe(1);                       // a single shared ssh probe, not five
  for (const st of results) expect(st.reachable).toBe(true); // every caller still gets the answer
});

test('checkBox: concurrent probes of different boxes are not coalesced (each box probed once)', async () => {
  let calls = 0;
  const run = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { code: 0, stdout: '', stderr: '' }; };
  const sc = createStatusChecker({ run });
  await Promise.all([sc.checkBox({ host: 'h1' }), sc.checkBox({ host: 'h2' })]);
  expect(calls).toBe(2);                       // de-dup is per-box, not global
});

test('checkBox: a fresh probe runs after the in-flight one settles (de-dup does not pin a stale result)', async () => {
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: 'web:1:0:1', stderr: '' }; };
  const sc = createStatusChecker({ run });
  await sc.checkBox({ host: 'h' });            // 1st probe settles, in-flight cleared
  await sc.checkBox({ host: 'h' });            // backoff cleared on success -> probes again
  expect(calls).toBe(2);
});

test('checkBox: live session with a live master probes over the multiplexed socket for live metrics (ignoring backoff)', async () => {
  let clock = 0;
  let mode = 'down';
  const run = async () => (mode === 'down'
    ? { code: 255, stdout: '', stderr: 'timeout' }
    : { code: 0, stdout: '__META__ load1=0.5 cpus=4\nweb:1:1:1718000000\n', stderr: '' });
  let live = false;
  const sc = createStatusChecker({ run, now: () => clock, hasLiveSession: () => live, masterAlive: async () => true });
  await sc.checkBox({ host: 'h' });                   // no session, unreachable -> backoff engaged
  live = true; mode = 'up';                           // user opens a terminal; master up; box now answers
  clock = 10 * 60 * 1000;                             // even though the backoff window is still open
  const st = await sc.checkBox({ host: 'h' });
  expect(st.reachable).toBe(true);                    // probes over the live master, ignoring backoff
  expect(st.tmux).toBe(true);
  expect(st.sessions[0].name).toBe('web');
  expect(st.metrics).toEqual({ load1: 0.5, cpus: 4 }); // the box you're working in now gets metrics
});

test('checkBox: live session WITHOUT a live master reports needs-auth (purple), not a fake green', async () => {
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: 'web:1:0:1', stderr: '' }; };
  const sc = createStatusChecker({ run, hasLiveSession: () => true, masterAlive: async () => false });
  const st = await sc.checkBox({ host: 'h' });
  expect(calls).toBe(0);                              // still no BatchMode probe
  expect(st.reachable).toBe(false);
  expect(st.needsAuth).toBe(true);                    // session exists but not authed -> purple
});

test('listSessions: returns parsed sessions when tmux is running', async () => {
  const run = async () => ({ code: 0, stdout: 'web:3:1:1718000000\nmain:1:0:1718000100\n', stderr: '' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({
    reachable: true,
    tmux: true,
    sessions: [
      { name: 'web', windows: 3, attached: true, activity: 1718000000, paneCmd: '' },
      { name: 'main', windows: 1, attached: false, activity: 1718000100, paneCmd: '' },
    ],
  });
});

test('listSessions: tmux not running yields an empty list', async () => {
  const run = async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: false, sessions: [], panes: [] });
});

test('listSessions: unreachable surfaces the error', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'timeout' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({ reachable: false, error: 'timeout' });
});

test('listSessions: auth failure reports needsAuth', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result.reachable).toBe(false);
  expect(result.needsAuth).toBe(true);
});

test('listSessions: skips the probe mid-login (live session, master not up yet)', async () => {
  let called = false;
  const run = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  const result = await createStatusChecker({ run, hasLiveSession: () => true, masterAlive: () => false })
    .listSessions({ id: 'b1', host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: true, inUse: true, sessions: [] });
  expect(called).toBe(false);
});

test('listSessions: probes over the live master when a session is live but the master is alive', async () => {
  let called = false;
  const run = async () => { called = true; return { code: 0, stdout: 'web:1:1:1718000000\nmine:2:0:1718000100\n', stderr: '' }; };
  const result = await createStatusChecker({ run, hasLiveSession: () => true, masterAlive: () => true })
    .listSessions({ id: 'b1', host: 'h' });
  expect(called).toBe(true);
  expect(result).toEqual({
    reachable: true,
    tmux: true,
    sessions: [
      { name: 'web', windows: 1, attached: true, activity: 1718000000, paneCmd: '' },
      { name: 'mine', windows: 2, attached: false, activity: 1718000100, paneCmd: '' },
    ],
  });
});

test('listSessions: skips the probe when a session is live and masterAlive is not wired (conservative default)', async () => {
  let called = false;
  const run = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  const result = await createStatusChecker({ run, hasLiveSession: () => true })
    .listSessions({ id: 'b1', host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: true, inUse: true, sessions: [] });
  expect(called).toBe(false);
});

// A user-triggered listSessions that reaches the box proves it is back up, but
// it never cleared the poll backoff — a user-confirmed-up box stayed red until
// the (up to 5m) pause expired on its own.
test('listSessions: a reachable probe clears the poll backoff (confirmed-up box goes green now)', async () => {
  let clock = 0;
  let mode = 'fail';
  let calls = 0;
  const run = async () => {
    calls++;
    return mode === 'fail'
      ? { code: 255, stdout: '', stderr: 'timeout' }
      : { code: 0, stdout: 'web:1:0:1', stderr: '' };
  };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });            // fail -> 30s backoff window opens
  mode = 'ok';
  clock = 5_000;                               // still inside the window
  const res = await sc.listSessions({ host: 'h' }); // user hits the ⟳ button
  expect(res.reachable).toBe(true);
  const st = await sc.checkBox({ host: 'h' }); // next poll tick, window still open
  expect(st.reachable).toBe(true);             // probed fresh — backoff was cleared
  expect(calls).toBe(3);
});

test('listSessions: a failed probe leaves the backoff window alone', async () => {
  let clock = 0;
  let calls = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });            // fail -> 30s window
  clock = 5_000;
  await sc.listSessions({ host: 'h' });        // user probe also fails
  await sc.checkBox({ host: 'h' });            // still inside the window
  expect(calls).toBe(2);                       // poll stayed throttled
});

test('a bare "Host key verification failed" (jump-host failure) is NOT classified hostKeyChanged', async () => {
  // proxyJump: the JUMP host's key failing produces this line without the
  // REMOTE HOST IDENTIFICATION banner — the ⚷ forget-key action must not
  // point at the target box.
  const run = async () => ({ code: 255, stdout: '', stderr: 'Host key verification failed.' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.hostKeyChanged).toBeFalsy();
});

test('forgetBox clears the backoff window so a re-added box probes immediately', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return { code: 255, stdout: '', stderr: 'Connection refused' }; };
  const checker = createStatusChecker({ run });
  await checker.checkBox({ host: 'h' });
  expect(calls).toBe(1);
  await checker.checkBox({ host: 'h' }); // inside the backoff window — cached
  expect(calls).toBe(1);
  checker.forgetBox('h');
  await checker.checkBox({ host: 'h' }); // state forgotten — probes again
  expect(calls).toBe(2);
});

test('parseTmuxSessions captures the active pane command as paneCmd', () => {
  const out = 'web:1:1:1721350000:claude\nscratch:2:0:1721349000:zsh\n';
  const s = parseTmuxSessions(out);
  expect(s).toEqual([
    { name: 'web', windows: 1, attached: true, activity: 1721350000, paneCmd: 'claude' },
    { name: 'scratch', windows: 2, attached: false, activity: 1721349000, paneCmd: 'zsh' },
  ]);
});

test('parseTmuxSessions tolerates a missing pane command (older format / no panes)', () => {
  expect(parseTmuxSessions('web:1:1:1721350000\n')[0].paneCmd).toBe('');
});

test('parseMeta reads boxNowSec (the box clock) when present', () => {
  expect(parseMeta('__META__ boxNowSec=1721350123 memTotalKb=100 memAvailKb=40\n').boxNowSec).toBe(1721350123);
});

test('PROBE_REMOTE emits __AGENT__ lines from the marker dir, statically', () => {
  expect(PROBE_REMOTE).toContain('.tmuxifier-agent');
  expect(PROBE_REMOTE).toContain('__AGENT__');
  expect(PROBE_REMOTE).toContain('head -c 200');
});

// The marker allowlist, through parsePaneMarks. `agentPane` lists one agent pane per session so a
// session-wide (four-field or legacy three-field) marker has a pane to speak for.
const agentPane = (session, pane, cmd = 'claude') => `__PANE__ ${session}:@0:${pane}:1:1:0:${cmd}`;
const marksOf = (...lines) => { const out = parsePaneMarks(lines.join('\n')); return out && { ...out }; };

test('parsePaneMarks extracts allowlisted marker lines, the legacy three-field ones mapped', () => {
  const out = marksOf('__META__ cpus=2', '__AGENT__ web:working:1718000000', '__AGENT__ ops:waiting:1718000001', 'web:2:1:1718000000:claude', agentPane('web', '%1'), agentPane('ops', '%2'));
  expect(out).toEqual({
    '%1': { session: 'web', state: 'working', cause: 'prompt', ts: 1718000000, wide: true },
    '%2': { session: 'ops', state: 'ready', cause: 'stop', ts: 1718000001, wide: true },
  });
});

test('parsePaneMarks reads four- and five-field markers', () => {
  const out = marksOf('__AGENT__ web:blocked:1718000000:permission', '__AGENT__ dev:ready:1718000001:start:%2', '__AGENT__ old:waiting:1718000002', '__AGENT__ old2:working:1718000003', agentPane('web', '%1'), agentPane('dev', '%2'), agentPane('old', '%3'), agentPane('old2', '%4'));
  expect(out).toEqual({
    '%1': { session: 'web', state: 'blocked', cause: 'permission', ts: 1718000000, wide: true },
    '%2': { session: 'dev', state: 'ready', cause: 'start', ts: 1718000001 },
    '%3': { session: 'old', state: 'ready', cause: 'stop', ts: 1718000002, wide: true },
    '%4': { session: 'old2', state: 'working', cause: 'prompt', ts: 1718000003, wide: true },
  });
});

test('parsePaneMarks drops unknown states and causes, and over-long lines', () => {
  const p = agentPane('web', '%1');
  expect(marksOf('__AGENT__ web:waiting:1718000000:stop', p)).toBeNull();   // legacy word with a cause
  expect(marksOf('__AGENT__ web:blocked:1718000000:sleepy', p)).toBeNull();
  expect(marksOf('__AGENT__ web:blocked:1718000000:permission:%1:extra', p)).toBeNull();
  expect(marksOf('__AGENT__ web:done:1718000000:stop:%1', p)).toBeNull();      // displayed states are not marker states
});

test('parsePaneMarks drops bad state, bad ts, malformed lines, and returns null when nothing survives', () => {
  const p = agentPane('web', '%1');
  expect(marksOf('__AGENT__ web:running:1718000000', p)).toBeNull();   // state not in allowlist
  expect(marksOf('__AGENT__ web:working:soon', p)).toBeNull();          // non-numeric ts
  expect(marksOf('__AGENT__ web:working:0', p)).toBeNull();             // non-positive ts
  expect(marksOf('__AGENT__ web:working', p)).toBeNull();               // missing field
  expect(marksOf('__AGENT__ :working:5:prompt:%1', agentPane('', '%1'))).toBeNull(); // empty session
  expect(marksOf('web:2:1:1718000000:claude', p)).toBeNull();           // no marker line at all
});

test('parsePaneMarks keeps __proto__ and constructor as own keys and session names, never the prototype', () => {
  const out = parsePaneMarks(['__AGENT__ __proto__:blocked:1718000000:permission:%1', '__AGENT__ constructor:ready:1718000001:stop:%2', agentPane('__proto__', '%1'), agentPane('constructor', '%2')].join('\n'));
  expect(Object.getPrototypeOf(out)).toBeNull();
  expect(out['%1']).toEqual({ session: '__proto__', state: 'blocked', cause: 'permission', ts: 1718000000 });
  expect(out['%2']).toEqual({ session: 'constructor', state: 'ready', cause: 'stop', ts: 1718000001 });
  expect(parsePaneMarks('__AGENT__ web:working:5:prompt:%1\n' + agentPane('web', '%1')).constructor).toBeUndefined();
});

test('parseTmuxSessions ignores __AGENT__ lines', () => {
  const out = '__AGENT__ web:working:1718000000\nweb:2:1:1718000000:claude\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
  ]);
});

test('checkBox: attaches paneMarks when the probe carries a usable marker, omits them otherwise; no session-keyed map', async () => {
  const run = async () => ({ code: 0, stdout: '__AGENT__ web:working:1718000000:prompt:%1\nweb:1:0:1718000000:claude\n__PANE__ web:@0:%1:1:1:0:claude\n', stderr: '' });
  const st = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect({ ...st.paneMarks }).toEqual({ '%1': { session: 'web', state: 'working', cause: 'prompt', ts: 1718000000 } });
  expect(st.sessions).toEqual([{ name: 'web', windows: 1, attached: false, activity: 1718000000, paneCmd: 'claude' }]);
  expect(st).not.toHaveProperty('agentMarks');
  const without = async () => ({ code: 0, stdout: 'web:1:0:1718000000:claude\n', stderr: '' });
  expect((await createStatusChecker({ run: without }).checkBox({ host: 'h' })).paneMarks).toBeUndefined();
});

test('parseTmuxWindows maps one row per window and rejoins a colon-bearing name', () => {
  // Verified on tmux 3.5a: window names may contain colons ("we:ird name"),
  // session names may not — so the name is the LAST field and the tail rejoins.
  const out = [
    '__META__ load1=0.4',
    'web:2:1:1718000000:claude',
    '__WIN__ web:1:@0:0:zsh',
    '__WIN__ web:2:@3:1:we:ird name',
  ].join('\n');
  expect(parseTmuxWindows(out)).toEqual([
    { session: 'web', index: 1, id: '@0', active: false, name: 'zsh' },
    { session: 'web', index: 2, id: '@3', active: true, name: 'we:ird name' },
  ]);
});

test('parseTmuxWindows drops rows that fail the allowlist', () => {
  const out = [
    '__WIN__ web:1:nope:0:bad-id',
    '__WIN__ web:x:@1:0:bad-index',
    '__WIN__ web:1:@2:2:bad-active',
    '__WIN__ :1:@3:0:no-session',
    '__WIN__ web:1:@4',
    '__WIN__ web:1:@5:1:ok',
  ].join('\n');
  expect(parseTmuxWindows(out)).toEqual([
    { session: 'web', index: 1, id: '@5', active: true, name: 'ok' },
  ]);
});

test('parseTmuxWindows strips control characters and caps the name (box input reaching the UI)', () => {
  const out = `__WIN__ web:1:@1:0:a\x1b[31mb\n__WIN__ web:2:@2:0:${'x'.repeat(90)}`;
  const w = parseTmuxWindows(out);
  expect(w[0].name).toBe('a[31mb');
  expect(w[1].name).toHaveLength(64);
});

test('cleanWindowName strips bidi controls, not only C0/C1 (a row could reorder itself)', () => {
  // U+202E (RIGHT-TO-LEFT OVERRIDE) and U+2066-2069 (the isolates) are not
  // control characters, so they survived the C0/C1 strip while still being able
  // to visually rearrange a window's dropdown row against the rows around it.
  const out = '__WIN__ web:1:@1:0:a\u202eb\u202cc\n'
    + '__WIN__ web:2:@2:0:x\u2066y\u2069z';
  const w = parseTmuxWindows(out);
  expect(w[0].name).toBe('abc');
  expect(w[1].name).toBe('xyz');
});

test('parseTmuxSessions ignores __WIN__ lines', () => {
  const out = 'web:2:1:1718000000:claude\n__WIN__ web:1:@0:1:zsh\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
  ]);
});

test('attachWindows nests windows under their session and drops orphans', () => {
  const sessions = [{ name: 'web', windows: 2 }, { name: 'build', windows: 1 }];
  const windows = [
    { session: 'web', index: 1, id: '@0', active: true, name: 'zsh' },
    { session: 'gone', index: 1, id: '@9', active: true, name: 'orphan' },
  ];
  expect(attachWindows(sessions, windows)).toEqual([
    { name: 'web', windows: 2, windowList: [{ id: '@0', index: 1, name: 'zsh', active: true }] },
    { name: 'build', windows: 1 },
  ]);
});

test('the probe asks for windows by id, not index (indexes renumber between poll and click)', () => {
  expect(PROBE_REMOTE).toContain('list-windows -a');
  expect(PROBE_REMOTE).toContain('#{window_id}');
});

test('the probe bounds the window rows on the BOX, as AGENT_PROBE bounds each marker', () => {
  // The row count is box-controlled: hundreds of windows would otherwise ship to
  // every open tab on every poll. Capped at the source, before the wire.
  expect(PROBE_REMOTE).toMatch(/list-windows[^;]*\| head -n 200/);
});

test('checkBox nests each session\'s windows into the snapshot', async () => {
  const stdout = [
    'web:2:1:1718000000:claude',
    '__WIN__ web:1:@0:0:zsh',
    '__WIN__ web:2:@1:1:claude',
  ].join('\n');
  const run = async () => ({ code: 0, stdout, stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: '192.168.1.10' });
  expect(status.sessions[0].windowList).toEqual([
    { id: '@0', index: 1, name: 'zsh', active: false },
    { id: '@1', index: 2, name: 'claude', active: true },
  ]);
});

test('a window NAMED __NO_TMUX__ does not make the box report tmux: false', async () => {
  // The sentinel is a line the probe emits on its own; window names are freely
  // set on the box (tmux's automatic-rename copies the running process name), so
  // matching it anywhere in stdout let one window blank the whole box's tmux
  // state -- no sessions, no windows, no agent chip.
  const stdout = [
    'web:1:1:1718000000:zsh',
    '__WIN__ web:1:@0:1:__NO_TMUX__',
  ].join('\n');
  const run = async () => ({ code: 0, stdout, stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: '192.168.1.10' });
  expect(status.tmux).toBe(true);
  expect(status.sessions[0].windowList).toEqual([{ id: '@0', index: 1, name: '__NO_TMUX__', active: true }]);
});

test('the real sentinel line is still honoured', async () => {
  const run = async () => ({ code: 0, stdout: '__META__ load1=0.4\n__NO_TMUX__\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: '192.168.1.10' });
  expect(status).toMatchObject({ reachable: true, tmux: false, sessions: [] });
});

// Session rows and the ssh error are written by the box: a login banner or a
// stray rc echo lands in the probe's stdout, and stderr carries sshd banners
// and shell noise. Neither may reach /api/status (and from there the browser,
// health events, the app and the MCP server) unshaped or unbounded.
test('parseTmuxSessions keeps only rows in the tmux status shape', () => {
  const out = [
    'Welcome to Ubuntu 26.04 LTS',
    'Last login: Sat Oct 24 14:00:00 2026 from 192.168.1.5',
    'web:2:1:1718000000:claude',
    'not:a:row',
    'x:1:0:notanumber',
    ':1:0:1718000000',
  ].join('\n');
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
  ]);
});

test('parseTmuxSessions drops names carrying control or bidi characters, or over the length cap', () => {
  const out = [
    'ok name:1:0:1718000000',
    'bad\u001b[31m:1:0:1718000000',
    'bad\u0085c1:1:0:1718000000',
    'evil‮:1:0:1718000000',
    `${'n'.repeat(SESSION_NAME_MAX + 1)}:1:0:1718000000`,
    `${'n'.repeat(SESSION_NAME_MAX)}:1:0:1718000000`,
  ].join('\n');
  expect(parseTmuxSessions(out).map((s) => s.name)).toEqual(['ok name', 'n'.repeat(SESSION_NAME_MAX)]);
});

test('parseTmuxSessions cleans the pane command and caps the row count', () => {
  const rows = Array.from({ length: SESSION_ROWS_MAX + 50 }, (_, i) => `s${i}:1:0:1718000000:cmd\u0007${'x'.repeat(100)}`);
  const sessions = parseTmuxSessions(rows.join('\n'));
  expect(sessions).toHaveLength(SESSION_ROWS_MAX);
  expect(sessions[0].paneCmd).toBe(`cmd${'x'.repeat(61)}`);
});

test('checkBox: a long ssh error keeps its last line and loses control characters', async () => {
  const banner = `\u001b[1mWARNING\u001b[0m\r\n${'#'.repeat(5000)}\n`;
  const run = async () => ({ code: 255, stdout: '', stderr: `${banner}ssh: connect to host h port 22: Connection refused\u0007\n` });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.error.length).toBeLessThanOrEqual(STATUS_ERROR_MAX + 1);
  expect(status.error.startsWith('…')).toBe(true);
  expect(status.error.endsWith('Connection refused')).toBe(true);
  expect(status.error).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test('checkBox: host-key and auth detection still see the full stderr before it is capped', async () => {
  const noise = 'x'.repeat(STATUS_ERROR_MAX * 3);
  const hk = async () => ({ code: 255, stdout: '', stderr: `@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\n${noise}` });
  expect((await createStatusChecker({ run: hk }).checkBox({ host: 'h' })).hostKeyChanged).toBe(true);
  const auth = async () => ({ code: 255, stdout: '', stderr: `me@h: Permission denied (publickey,password).\n${noise}` });
  expect((await createStatusChecker({ run: auth }).checkBox({ host: 'h' })).needsAuth).toBe(true);
});

test('parseTmuxSessions keeps sessions from tmux < 2.1, which expands #{window_activity} to empty', () => {
  expect(parseTmuxSessions('main:1:0::bash\n')).toEqual([
    { name: 'main', windows: 1, attached: false, activity: 0, paneCmd: 'bash' },
  ]);
});

test('OSC_SWEEP: static, silenced, never fails the probe', () => {
  expect(PROBE_REMOTE).toContain(OSC_SWEEP);
  expect(OSC_SWEEP).toContain('>/dev/null 2>&1 || true');
  expect(OSC_SWEEP.replace(/\$HOME/g, '')).not.toContain('$');
  expect(PROBE_REMOTE.indexOf(OSC_SWEEP)).toBeGreaterThan(PROBE_REMOTE.indexOf('__AGENT__'));
  expect(PROBE_REMOTE.indexOf(OSC_SWEEP)).toBeLessThan(PROBE_REMOTE.indexOf('if command -v tmux'));
});

test('PROBE_REMOTE: a failing noisy python3 reporter changes neither stdout nor stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-osc-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-oschome-'));
  writeFakeTmux(dir, `[ "$1" = "list-windows" ] && exit 0\necho 'web:2:1:123'`);
  const py = path.join(dir, 'python3');
  fs.writeFileSync(py, '#!/bin/sh\necho NOISE >&2\necho NOISE\nexit 7\n');
  fs.chmodSync(py, 0o755);
  const run = () => {
    const r = spawnSync('/bin/sh', ['-c', PROBE_REMOTE], { env: { PATH: dir, HOME: home }, encoding: 'utf8' });
    return { out: r.stdout.split(/\r?\n/).filter((l) => !l.startsWith('__META__')).join('\n').trim(), err: r.stderr };
  };
  const before = run();
  fs.mkdirSync(path.join(home, '.tmuxifier-osc'));
  fs.writeFileSync(path.join(home, '.tmuxifier-osc', 'reporter.py'), '# stub\n');
  const after = run();
  expect(after.out).toBe(before.out);
  expect(after.out).toBe('web:2:1:123');
  expect(after.err).toBe('');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// --- panes: one row per tmux pane, with its window and focus flags ---------

const PANE_OUT = [
  'main:2:1:1700000000:zsh',
  '__WIN__ main:1:@0:0:api',
  '__WIN__ main:2:@1:1:we:ird',
  '__PANE__ main:@0:%0:1:1:0:claude',
  '__PANE__ main:@1:%1:1:0:1:node:with:colons',
  '__PANE__ main:@1:%2:2:1:1:zsh',
].join('\n');

const PANE_ROWS = [
  { session: 'main', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' },
  { session: 'main', windowId: '@1', pane: '%1', index: 1, active: false, zoomed: true, cmd: 'node:with:colons' },
  { session: 'main', windowId: '@1', pane: '%2', index: 2, active: true, zoomed: true, cmd: 'zsh' },
];

test('parseTmuxPanes reads one row per pane, command last', () => {
  expect(parseTmuxPanes(PANE_OUT)).toEqual({ complete: true, panes: PANE_ROWS });
});

test('parseTmuxPanes drops a row with a bad id, index or flag instead of the listing', () => {
  const bad = [
    '__PANE__ main:@x:%0:1:1:0:claude',
    '__PANE__ main:@0:%0:1:2:0:claude',
    '__PANE__ main:@0:0:1:1:0:claude',
    '__PANE__ main:@0:%4:x:1:0:claude',
    '__PANE__ main:@0:%5:1:1:2:claude',
    '__PANE__ main:@0:%6:1:1:0',
    '__PANE__ :@0:%7:1:1:0:claude',
    `__PANE__ ${'s'.repeat(SESSION_NAME_MAX + 1)}:@0:%8:1:1:0:claude`,
    '__PANE__ ma‮in:@0:%9:1:1:0:claude',
    '__PANE__ main:@0:%3:1:1:0:claude',
  ].join('\n');
  expect(parseTmuxPanes(bad).panes.map((p) => p.pane)).toEqual(['%3']);
});

test('parseTmuxPanes cleans the command like a window name (controls and bidi stripped, 64 chars)', () => {
  const out = `__PANE__ main:@0:%0:1:1:0:a\u001b[31mb‮c\n__PANE__ main:@0:%1:2:0:0:${'x'.repeat(90)}`;
  const { panes } = parseTmuxPanes(out);
  expect(panes[0].cmd).toBe('a[31mbc');
  expect(panes[1].cmd).toHaveLength(64);
});

test('parseTmuxPanes is not complete with no rows or at the row cap', () => {
  expect(parseTmuxPanes('main:1:0::zsh').complete).toBe(false);
  expect(parseTmuxPanes('').complete).toBe(false);
  const rows = (n) => Array.from({ length: n }, (_, i) => `__PANE__ main:@0:%${i}:${i}:0:0:zsh`).join('\n');
  expect(parseTmuxPanes(rows(PANE_ROWS_MAX)).complete).toBe(false);
  expect(parseTmuxPanes(rows(PANE_ROWS_MAX - 1)).complete).toBe(true);
});

test('parseTmuxPanes counts rows before validation, so a capped listing of junk is still incomplete', () => {
  const junk = Array.from({ length: PANE_ROWS_MAX }, () => '__PANE__ garbage').join('\n');
  expect(parseTmuxPanes(junk)).toEqual({ panes: [], complete: false });
});

test('parseTmuxPanes keeps a session named __proto__ as an ordinary row', () => {
  expect(parseTmuxPanes('__PANE__ __proto__:@0:%0:1:1:0:claude').panes).toEqual([
    { session: '__proto__', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' },
  ]);
});

test('the probes list every pane with its window and focus flags, capped at the source', async () => {
  const { AGENT_REMOTE } = await import('../src/server/status.js');
  expect(PANE_FMT).toBe('#{session_name}:#{window_id}:#{pane_id}:#{pane_index}:#{pane_active}:#{window_zoomed_flag}:#{pane_current_command}');
  for (const remote of [PROBE_REMOTE, AGENT_REMOTE]) {
    expect(remote).toContain(`list-panes -a -F '__PANE__ ${PANE_FMT}'`);
    expect(remote).toMatch(/list-panes[^;]*\| head -n 400/);
  }
});

test('checkBox carries every pane when the listing is complete', async () => {
  const run = async () => ({ code: 0, stdout: PANE_OUT, stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.panes).toEqual(PANE_ROWS);
});

test('checkBox: no tmux and no sessions both report an empty pane list', async () => {
  const noTmux = await createStatusChecker({ run: async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' }) }).checkBox({ host: 'h' });
  expect(noTmux.panes).toEqual([]);
  const noSessions = await createStatusChecker({ run: async () => ({ code: 0, stdout: '', stderr: '' }) }).checkBox({ host: 'h' });
  expect(noSessions.panes).toEqual([]);
});

test('checkBox: sessions without a pane listing, or with a capped one, carry no panes key', async () => {
  const none = await createStatusChecker({ run: async () => ({ code: 0, stdout: 'main:1:0:1700000000:zsh\n', stderr: '' }) }).checkBox({ host: 'h' });
  expect(none.sessions).toHaveLength(1);
  expect(none).not.toHaveProperty('panes');
  const capped = ['main:1:0:1700000000:zsh', ...Array.from({ length: PANE_ROWS_MAX }, (_, i) => `__PANE__ main:@0:%${i}:${i}:0:0:zsh`)].join('\n');
  const full = await createStatusChecker({ run: async () => ({ code: 0, stdout: capped, stderr: '' }) }).checkBox({ host: 'h' });
  expect(full).not.toHaveProperty('panes');
});

test('checkAgents carries panes exactly as checkBox does', async () => {
  const checker = (stdout) => createStatusChecker({ run: async () => ({ code: 0, stdout, stderr: '' }) });
  expect((await checker(PANE_OUT).checkAgents({ id: 'b1', host: 'h' })).panes).toEqual(PANE_ROWS);
  expect((await checker('__NO_TMUX__\n').checkAgents({ id: 'b1', host: 'h' })).panes).toEqual([]);
  expect((await checker('').checkAgents({ id: 'b1', host: 'h' })).panes).toEqual([]);
  const bare = await checker('main:1:0:1700000000:zsh\n').checkAgents({ id: 'b1', host: 'h' });
  expect(bare.sessions).toHaveLength(1);
  expect(bare).not.toHaveProperty('panes');
});

// --- checkAgents: the light probe behind the real-time agent watch ---------

test('AGENT_REMOTE is the probe without the metrics block or the OSC sweep', async () => {
  const { AGENT_REMOTE, PROBE_REMOTE, OSC_SWEEP } = await import('../src/server/status.js');
  expect(AGENT_REMOTE).toContain('.tmuxifier-agent');
  expect(AGENT_REMOTE).toContain('tmux ls -F');
  expect(AGENT_REMOTE).toContain('__WIN__');
  // No /proc reads: a triggered probe must not disturb the cgroup CPU delta the
  // sweep derives, and must stay cheap enough to run on every marker change.
  expect(AGENT_REMOTE).not.toContain('__META__');
  expect(AGENT_REMOTE).not.toContain(OSC_SWEEP);
  // The full probe carries both halves verbatim — the marker fragment and the
  // tmux fragment it ends with — so the two read markers, sessions and windows
  // from the very same text.
  const cut = AGENT_REMOTE.indexOf('if command -v tmux');
  expect(cut).toBeGreaterThan(0);
  expect(AGENT_REMOTE.slice(0, cut)).toContain('__AGENT__');
  expect(PROBE_REMOTE).toContain(AGENT_REMOTE.slice(0, cut));
  expect(PROBE_REMOTE.endsWith(AGENT_REMOTE.slice(cut))).toBe(true);
});

test('checkAgents returns sessions, windows and markers from one light probe', async () => {
  const seen = [];
  const run = async (argv) => {
    seen.push(argv[argv.length - 1]);
    return {
      code: 0, stderr: '',
      stdout: '__AGENT__ main:blocked:1700000000:permission:%0\nmain:1:0:1700000001:claude\n__WIN__ main:0:@1:1:work\n__PANE__ main:@1:%0:0:1:0:claude\n',
    };
  };
  const { AGENT_REMOTE } = await import('../src/server/status.js');
  const res = await createStatusChecker({ run }).checkAgents({ id: 'b1', host: 'h' });
  expect(seen).toEqual([AGENT_REMOTE]);
  expect(res.tmux).toBe(true);
  expect(res.sessions).toHaveLength(1);
  expect(res.sessions[0]).toMatchObject({ name: 'main', paneCmd: 'claude' });
  expect(res.sessions[0].windowList).toEqual([{ index: 0, id: '@1', active: true, name: 'work' }]);
  expect(res.paneMarks['%0']).toEqual({ session: 'main', state: 'blocked', ts: 1700000000, cause: 'permission' });
  expect(res).not.toHaveProperty('agentMarks');
  expect(res).not.toHaveProperty('metrics');
});

test('checkAgents carries paneMarks exactly as checkBox does', async () => {
  const stdout = '__AGENT__ main:blocked:1700000000:permission:%0\n__AGENT__ main:working:1700000005:prompt\n' + PANE_OUT + '\n';
  const res = await createStatusChecker({ run: async () => ({ code: 0, stdout, stderr: '' }) }).checkAgents({ id: 'b1', host: 'h' });
  expect({ ...res.paneMarks }).toEqual({ '%0': { session: 'main', state: 'blocked', cause: 'permission', ts: 1700000000 } });
  const bare = await createStatusChecker({ run: async () => ({ code: 0, stdout: 'main:1:0:1700000000:zsh\n', stderr: '' }) }).checkAgents({ id: 'b1', host: 'h' });
  expect(bare).not.toHaveProperty('paneMarks');
});

test('checkAgents reports a box without tmux and one with no markers', async () => {
  const none = await createStatusChecker({ run: async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' }) })
    .checkAgents({ id: 'b1', host: 'h' });
  expect(none).toEqual({ tmux: false, sessions: [], panes: [] });
  const idle = await createStatusChecker({ run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    .checkAgents({ id: 'b1', host: 'h' });
  expect(idle).toEqual({ tmux: true, sessions: [], panes: [] });
});

test('checkAgents answers null on any failure and never touches the sweep backoff', async () => {
  let fail = true;
  let calls = 0;
  const run = async () => {
    calls += 1;
    return fail
      ? { code: 255, stdout: '', stderr: 'ssh: connect to host h port 22: Connection refused' }
      : { code: 0, stdout: 'main:1:0:1:zsh\n', stderr: '' };
  };
  const checker = createStatusChecker({ run });
  expect(await checker.checkAgents({ id: 'b1', host: 'h' })).toBeNull();
  // A failed light probe must not open a backoff window: reachability is the
  // sweep's call, and the very next checkBox still probes for real.
  fail = false;
  const status = await checker.checkBox({ id: 'b1', host: 'h' });
  expect(status.reachable).toBe(true);
  expect(calls).toBe(2);
  // A thrown run and an unsafe box are null too, never an exception.
  expect(await createStatusChecker({ run: async () => { throw new Error('x'); } }).checkAgents({ id: 'b1', host: 'h' })).toBeNull();
  expect(await createStatusChecker({ run }).checkAgents({ id: 'b1', host: 'h; rm -rf /' })).toBeNull();
});

test('checkAgents stands down while an interactive login holds the box', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; };
  // Session open but no master yet: a BatchMode probe would race the password
  // prompt on the shared socket, exactly as checkBox refuses to.
  const midLogin = createStatusChecker({ run, hasLiveSession: () => true, masterAlive: async () => false });
  expect(await midLogin.checkAgents({ id: 'b1', host: 'h' })).toBeNull();
  expect(calls).toBe(0);
  const connected = createStatusChecker({ run, hasLiveSession: () => true, masterAlive: async () => true });
  expect(await connected.checkAgents({ id: 'b1', host: 'h' })).toEqual({ tmux: true, sessions: [], panes: [] });
  expect(calls).toBe(1);
});

test('checkAgents flags a probe that fell off the saturated shared connection, and still returns its data', async () => {
  // ssh does not fail when the ControlMaster is out of session slots: it says
  // so on stderr and opens a connection of its own. The answer is good; the
  // flag is what lets the caller stop adding to the pressure.
  const refused = 'mux_client_request_session: session request failed: Session open refused by peer\r\nControlSocket /x/cm/abc already exists, disabling multiplexing\r\n';
  const run = async () => ({ code: 0, stdout: 'main:1:0:1:zsh\n', stderr: refused });
  const res = await createStatusChecker({ run }).checkAgents({ id: 'b1', host: 'h' });
  expect(res.muxRefused).toBe(true);
  expect(res.sessions).toHaveLength(1);
  const fine = await createStatusChecker({ run: async () => ({ code: 0, stdout: 'main:1:0:1:zsh\n', stderr: 'Warning: Permanently added\n' }) })
    .checkAgents({ id: 'b1', host: 'h' });
  expect(fine).not.toHaveProperty('muxRefused');
});

// --- the probe text under the shells it actually runs in ---------------------
// The remote command runs under the box's LOGIN shell, which is often zsh. A
// green run under sh says nothing about zsh: an unmatched glob is a fatal
// error there, and it aborts the whole command line, not just the loop.

{
  const { execFileSync, spawnSync } = await import('node:child_process');
  const fsSync = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const { AGENT_REMOTE, PROBE_REMOTE } = await import('../src/server/status.js');
  const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
  const shells = ['sh', 'bash', 'zsh'].filter(has);

  // A fixture HOME plus a stub `tmux` first on PATH, so "the rest of the probe
  // still ran" is observable as the stub's session row.
  function fixture(prepare) {
    const home = fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-probe-'));
    const bin = pathMod.join(home, 'bin');
    fsSync.mkdirSync(bin);
    fsSync.writeFileSync(pathMod.join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = ls ] && echo "main:1:0:1700000000:zsh"\nexit 0\n', { mode: 0o755 });
    prepare(pathMod.join(home, '.tmuxifier-agent'));
    const run = (shell, remote) => spawnSync(shell, ['-c', remote], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 10000,
    });
    return { home, run, cleanup: () => fsSync.rmSync(home, { recursive: true, force: true }) };
  }
  const cases = {
    'no marker directory': () => {},
    'an empty marker directory': (d) => { fsSync.mkdirSync(d); },
    'only subdirectories': (d) => { fsSync.mkdirSync(pathMod.join(d, 'busy'), { recursive: true }); },
  };

  for (const shell of shells) {
    for (const [name, prepare] of Object.entries(cases)) {
      test(`${shell}: with ${name} the probe still lists sessions and reports no markers`, () => {
        const f = fixture(prepare);
        try {
          for (const remote of [AGENT_REMOTE, PROBE_REMOTE]) {
            const res = f.run(shell, remote);
            expect(res.status).toBe(0);
            expect(res.stderr).toBe('');
            expect(parseTmuxSessions(res.stdout).map((s) => s.name)).toEqual(['main']);
            expect(parsePaneMarks(res.stdout)).toBeNull();
          }
        } finally { f.cleanup(); }
      });
    }

    test(`${shell}: markers are read capped, and a FIFO or directory beside them is skipped`, () => {
      const f = fixture((d) => {
        fsSync.mkdirSync(pathMod.join(d, 'blocked'), { recursive: true });
        fsSync.writeFileSync(pathMod.join(d, 'main%1'), 'main:blocked:1700000001:permission:%1\n');
        fsSync.writeFileSync(pathMod.join(d, 'two%2'), 'two:ready:1700000002:stop:%2\n');
        fsSync.writeFileSync(pathMod.join(d, 'huge%3'), `huge:working:1700000003:prompt:%3${'x'.repeat(5000)}\n`);
        execFileSync('mkfifo', [pathMod.join(d, 'trap')]);
      });
      try {
        for (const remote of [AGENT_REMOTE, PROBE_REMOTE]) {
          const res = f.run(shell, remote);
          expect(res.status).toBe(0);
          expect(res.stderr).toBe('');
          // The stub lists no panes, so no pane marker is ruled out for being absent.
          const marks = parsePaneMarks(res.stdout);
          expect(Object.keys(marks).sort()).toEqual(['%1', '%2']); // `huge` overflows its pane field and drops
          expect(marks['%1']).toEqual({ session: 'main', state: 'blocked', cause: 'permission', ts: 1700000001 });
          const longest = Math.max(...res.stdout.split('\n').filter((l) => l.startsWith('__AGENT__ ')).map((l) => l.length));
          expect(longest).toBeLessThanOrEqual('__AGENT__ '.length + 200);
          expect(parseTmuxSessions(res.stdout).map((s) => s.name)).toEqual(['main']);
        }
      } finally { f.cleanup(); }
    });
  }

  test('the probe text was exercised under zsh, the usual login shell', () => {
    expect(shells).toContain('zsh');
  });
}

// --- numbers and names from box output are bounded: a bad row drops, never rewritten -----

test('parseTmuxWindows drops a row whose index is not a plain decimal of at most 6 digits, and keeps its neighbour', () => {
  const out = [
    '__WIN__ main:1e30:@1:1:big',
    '__WIN__ main:1234567:@2:0:seven',
    '__WIN__ main:+1:@3:0:plus',
    '__WIN__ main: 1:@4:0:space',
    '__WIN__ main:1.0:@5:0:dot',
    '__WIN__ main:0x1:@6:0:hex',
    '__WIN__ main::@7:0:empty',
    '__WIN__ main:999999:@8:0:six',
    '__WIN__ main:2:@9:0:two',
  ].join('\n');
  expect(parseTmuxWindows(out).map((w) => [w.id, w.index])).toEqual([['@8', 999999], ['@9', 2]]);
});

test('parseTmuxPanes drops a row whose pane index is not a plain decimal of at most 6 digits, and keeps its neighbour', () => {
  const out = [
    '__PANE__ main:@0:%1:9007199254740991:1:0:claude',
    '__PANE__ main:@0:%2:1234567:0:0:claude',
    '__PANE__ main:@0:%3:999999:0:0:claude',
    '__PANE__ main:@0:%4:1:0:0:claude',
  ].join('\n');
  const { panes, complete } = parseTmuxPanes(out);
  expect(panes.map((p) => [p.pane, p.index])).toEqual([['%3', 999999], ['%4', 1]]);
  expect(complete).toBe(true);
});

test('parsePaneMarks drops a marker whose ts is not a positive safe integer, and keeps its neighbour', () => {
  const rows = ['%1', '%2', '%3', '%4', '%5', '%6'].map((p) => agentPane('web', p));
  const out = marksOf(
    '__AGENT__ web:ready:1700000000.5:stop:%1',
    '__AGENT__ web:ready:9007199254740993:stop:%2',
    '__AGENT__ web:ready:1e9:stop:%3',
    '__AGENT__ web:ready:-5:stop:%4',
    '__AGENT__ web:ready: 1700000000:stop:%5',
    '__AGENT__ web:ready:1700000000:stop:%6',
    ...rows,
  );
  expect(out).toEqual({ '%6': { session: 'web', state: 'ready', cause: 'stop', ts: 1700000000 } });
  // The same for a session-wide marker: a fractional ts speaks for nothing.
  expect(marksOf('__AGENT__ web:ready:1700000000.5:stop', agentPane('web', '%1'))).toBeNull();
});

test('parsePaneMarks drops a marker whose session name breaks the session-row rules, listed or not', () => {
  const long = 's'.repeat(SESSION_NAME_MAX + 1);
  // With no pane listing (fail open) every pane marker is kept, so these reach the result unless the name rule drops them.
  const unlisted = marksOf(
    '__AGENT__ we\u0007b:working:1700000000:prompt:%1',
    '__AGENT__ we‮b:working:1700000000:prompt:%2',
    `__AGENT__ ${long}:working:1700000000:prompt:%3`,
    '__AGENT__ we\u0085b:working:1700000000:prompt:%4',
    `__AGENT__ ${'s'.repeat(SESSION_NAME_MAX)}:working:1700000000:prompt:%5`,
  );
  expect(Object.keys(unlisted)).toEqual(['%5']);
  // A session-wide marker with a control character speaks for nothing, even for a listed pane of that name.
  expect(marksOf('__AGENT__ we\u0007b:working:1700000000:prompt', '__PANE__ we\u0007b:@0:%1:1:1:0:claude', agentPane('web', '%2'))).toBeNull();
});

// --- pane rows with no session rows: a contradictory listing is unknown, not empty --------

test('checkBox and checkAgents: pane rows with no session rows carry no panes key; a truly empty box still does', async () => {
  const checker = (stdout) => createStatusChecker({ run: async () => ({ code: 0, stdout, stderr: '' }) });
  const contradictory = ['__PANE__ main:@0:%1:0:1:0:claude', '__AGENT__ main:ready:1700000000:stop:%1'].join('\n');
  for (const probe of ['checkBox', 'checkAgents']) {
    const s = await checker(contradictory)[probe]({ id: 'b1', host: 'h' });
    expect(s.sessions, probe).toEqual([]);
    expect(s, probe).not.toHaveProperty('panes');
    const empty = await checker('').checkBox({ id: 'b1', host: 'h' });
    expect(empty.panes, probe).toEqual([]);
  }
  // Even a pane row that fails validation contradicts "no sessions".
  expect(await checker('__PANE__ garbage').checkBox({ host: 'h' })).not.toHaveProperty('panes');
});
