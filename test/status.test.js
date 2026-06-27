import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTmuxSessions, parseMeta, createStatusChecker, PROBE_REMOTE } from '../src/server/status.js';

test('parseTmuxSessions maps fields', () => {
  const out = 'web:3:1:1718000000\nbuild:1:0:1718000100\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 3, attached: true, activity: 1718000000 },
    { name: 'build', windows: 1, attached: false, activity: 1718000100 },
  ]);
});

test('parseTmuxSessions ignores the __META__ health line and still parses sessions after it', () => {
  const out = '__META__ load1=0.42 cpus=4 diskPct=61\nweb:2:1:1718000000\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000 },
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

test('checkBox: tmux missing', async () => {
  const run = async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: false, sessions: [] });
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
  writeFakeTmux(dir, `echo 'web:2:1:123'`);
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

test('checkBox: surfaces host metrics from the __META__ line when present', async () => {
  const run = async () => ({ code: 0, stdout: '__META__ load1=0.7 memTotalKb=1000 memAvailKb=400 diskPct=55\nweb:1:0:1718000000\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(true);
  expect(status.tmux).toBe(true);
  expect(status.sessions).toEqual([{ name: 'web', windows: 1, attached: false, activity: 1718000000 }]);
  expect(status.metrics).toEqual({ load1: 0.7, memTotalKb: 1000, memAvailKb: 400, diskPct: 55 });
});

test('checkBox: metrics attach even when tmux is not installed (reachable box, __NO_TMUX__)', async () => {
  const run = async () => ({ code: 0, stdout: '__META__ load1=0.1\n__NO_TMUX__\n', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: false, sessions: [], metrics: { load1: 0.1 } });
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
  expect(status).toEqual({ reachable: true, tmux: true, sessions: [] });
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
      { name: 'web', windows: 3, attached: true, activity: 1718000000 },
      { name: 'main', windows: 1, attached: false, activity: 1718000100 },
    ],
  });
});

test('listSessions: tmux not running yields an empty list', async () => {
  const run = async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: false, sessions: [] });
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
      { name: 'web', windows: 1, attached: true, activity: 1718000000 },
      { name: 'mine', windows: 2, attached: false, activity: 1718000100 },
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
