import { test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setupLocalBox } from './helpers/localBox.js';
import { createSessionManager } from '../src/server/sessions.js';
import { sshRun } from '../src/server/sshRun.js';
import { buildProbeArgv } from '../src/server/sshCommand.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return true; await delay(150); }
  throw new Error('waitFor timed out');
}

let active;
let localSessionCounter = 0;
let localSessionsTouched = new Set();

function killTmuxSession(sessionName) {
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

function createLocalTestManager({ graceSeconds = 1 } = {}) {
  const localSession = `local-test-${Date.now()}-${++localSessionCounter}`;
  localSessionsTouched.add(localSession);
  killTmuxSession(localSession);
  return {
    localSession,
    mgr: createSessionManager({ graceSeconds, localSession }),
  };
}

afterEach(async () => {
  for (const sessionName of localSessionsTouched) killTmuxSession(sessionName);
  localSessionsTouched = new Set();
  if (active) await active();
  active = null;
});

test('process started in tmux survives a killed local PTY and is visible on reattach', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };

  const e1 = mgr.open({ key: 'k1', box, session, size });
  const buf1 = [];
  const off1 = mgr.attach(e1, (d) => buf1.push(d));
  await waitFor(() => buf1.join('').length > 0);          // tmux drew something
  mgr.write(e1, `sleep 987 &\n`);                          // background marker process
  await delay(1500);

  off1();
  mgr.detach(e1);                                          // simulate WS close
  await delay(1800);                                       // grace (1s) expires -> local PTY killed
  expect(mgr._count()).toBe(0);

  const probe = await sshRun(buildProbeArgv(box, `pgrep -f 'sleep 987' | head -1`, { sshConfigFile }), { env });
  expect(probe.stdout.trim()).not.toBe('');               // still running on the box

  const e2 = mgr.open({ key: 'k2', box, session, size });  // reattach to same session
  const buf2 = [];
  mgr.attach(e2, (d) => buf2.push(d));
  await waitFor(() => buf2.join('').length > 0);
  mgr.close(e2);
});

test('provision runs a script on the box and streams output', async () => {
  const { box, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 1 });

  const entry = mgr.provision({ key: 'prov-test-1', box, script: 'echo HELLO_PROVISION; echo ERR_TEST >&2; exit 0' });
  const buf = [];
  let exitCode = null;
  const off = mgr.attach(entry, (d) => buf.push(d));
  const offExit = mgr.onExit(entry, () => { exitCode = entry.exitCode; });

  // Wait for PTY to exit
  await new Promise((resolve) => {
    const check = () => { if (entry.exited) resolve(undefined); else setTimeout(check, 100); };
    check();
  });

  expect(exitCode).toBe(0);
  const text = buf.join('');
  expect(text).toContain('HELLO_PROVISION');
  expect(text).toContain('ERR_TEST');
  off();
  offExit();
});

test('provision keyed separately from interactive sessions', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };

  const inter = mgr.open({ key: 'box-1', box, session, size });
  const prov = mgr.provision({ key: 'provision:box-1', box, script: 'echo ok' });

  expect(inter).not.toBe(prov);
  expect(mgr._count()).toBe(2);

  mgr.close(inter);
  mgr.close(prov);
});

test('reconnect within grace reuses the same PTY entry', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 30 });
  const size = { cols: 80, rows: 24 };
  const e1 = mgr.open({ key: 'tab-1', box, session, size });
  await waitFor(() => true);
  mgr.detach(e1);
  const e2 = mgr.open({ key: 'tab-1', box, session, size }); // same key within grace
  expect(e2).toBe(e1);
  mgr.close(e2);
});

test('openLocal spawns a local tmux session and streams data', async () => {
  const { mgr, localSession } = createLocalTestManager();
  const size = { cols: 80, rows: 24 };
  const key = 'local-test-' + Date.now();

  const entry = mgr.openLocal({ key, shell: 'none', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);
  expect(() => execFileSync('tmux', ['has-session', '-t', localSession], { timeout: 5000, stdio: 'ignore' })).not.toThrow();

  mgr.write(entry, 'echo LOCAL_SHELL_TEST\n');
  await waitFor(() => buf.join('').includes('LOCAL_SHELL_TEST'));

  mgr.write(entry, 'exit\n');
  await waitFor(() => entry.exited);
  off();
  mgr.close(entry);
});

test('openLocal shells: omz passes exec zsh startup command', async () => {
  const { mgr } = createLocalTestManager();
  const size = { cols: 80, rows: 24 };
  const key = 'local-omz-' + Date.now();

  // openLocal with omz should start with zsh
  const entry = mgr.openLocal({ key, shell: 'omz', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);

  // Check the running shell
  mgr.write(entry, 'echo $0\n');
  await waitFor(() => buf.join('').includes('zsh'));

  mgr.write(entry, 'exit\n');
  await waitFor(() => entry.exited);
  off();
  mgr.close(entry);
});

test('openLocal shells: omb passes exec bash startup command', async () => {
  const { mgr } = createLocalTestManager();
  const size = { cols: 80, rows: 24 };
  const key = 'local-omb-' + Date.now();

  const entry = mgr.openLocal({ key, shell: 'omb', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);

  mgr.write(entry, 'echo $0\n');
  await waitFor(() => buf.join('').includes('bash'));

  mgr.write(entry, 'exit\n');
  await waitFor(() => entry.exited);
  off();
  mgr.close(entry);
});

test('openLocal reuses existing entry within grace period', async () => {
  const { mgr } = createLocalTestManager({ graceSeconds: 30 });
  const size = { cols: 80, rows: 24 };
  const key = 'local-reuse-' + Date.now();

  const e1 = mgr.openLocal({ key, shell: 'none', size });
  await waitFor(() => true);
  mgr.detach(e1);
  const e2 = mgr.openLocal({ key, shell: 'none', size }); // same key within grace
  expect(e2).toBe(e1);

  mgr.write(e1, 'exit\n');
  await waitFor(() => e1.exited);
  mgr.close(e2);
});

// Over ssh the attach() size nudge (cols-1 then cols, back to back) usually
// collapses: ssh reads the final size once, the box's kernel sees no change,
// and tmux never redraws — so nothing re-announces mouse tracking to a freshly
// reloaded page. The replay itself has to carry it (sessions.test.js has the
// unit shape; this pins it against the real transport).
test('a reattach after mouse mode scrolled out of the replay buffer still restores mouse tracking', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 30 });
  const e = mgr.open({ key: 'km', box, session, size: { cols: 100, rows: 30 } });
  let first = '';
  const off = mgr.attach(e, (d) => { first += d; });
  await waitFor(() => first.length > 0);
  await sshRun(buildProbeArgv(box, `tmux set -g mouse on`, { sshConfigFile }), { env });
  await waitFor(() => first.includes('\x1b[?1000h'));
  mgr.write(e, `for i in $(seq 1 3000); do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done; echo FLOOD_""DONE\n`);
  await waitFor(() => /FLOOD_DONE\r?\n/.test(first.slice(-4096)), 20000);
  off();
  mgr.detach(e);                                   // reload: WS gone, PTY kept

  let replay = null;
  mgr.attach(e, (d) => { if (replay === null) replay = d; });
  expect(replay).not.toBeNull();
  const lastSet = replay.lastIndexOf('\x1b[?1000h');
  expect(lastSet).toBeGreaterThanOrEqual(0);
  expect(replay.indexOf('\x1b[?1000l', lastSet)).toBe(-1); // nothing turns it back off
  mgr.close(e);
}, 40000);
