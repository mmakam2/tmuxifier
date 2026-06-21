import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTmuxSessions, createStatusChecker, PROBE_REMOTE } from '../src/server/status.js';

test('parseTmuxSessions maps fields', () => {
  const out = 'web:3:1:1718000000\nbuild:1:0:1718000100\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 3, attached: true, activity: 1718000000 },
    { name: 'build', windows: 1, attached: false, activity: 1718000100 },
  ]);
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
function runProbe(pathDir) {
  return execFileSync('/bin/sh', ['-c', PROBE_REMOTE], { env: { PATH: pathDir }, encoding: 'utf8' }).trim();
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

test('checkBox: tmux installed with zero sessions reports reachable + tmux:true + empty sessions', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status).toEqual({ reachable: true, tmux: true, sessions: [] });
});
