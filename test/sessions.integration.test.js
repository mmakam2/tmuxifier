import { test, expect, afterEach } from 'vitest';
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
afterEach(async () => { if (active) await active(); active = null; });

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
