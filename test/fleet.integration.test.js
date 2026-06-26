import { test, expect, afterEach } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createFleetManager } from '../src/server/fleet.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const store = { getBox: async (id) => (id === 'b1' ? box : undefined) };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  const mgr = createFleetManager({
    store,
    execCommand: (b, c, o) => boxActions.execCommand(b, c, o),
    timeoutMs: 12000,
  });
  return mgr;
}

test('runs a real command on a box and captures stdout + exit 0', async () => {
  const mgr = await harness();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'echo fleet-ok' });
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(job.targets[0]).toMatchObject({ status: 'ok', code: 0 });
  expect(job.targets[0].stdout).toContain('fleet-ok');
});

test('captures a non-zero exit as an error target', async () => {
  const mgr = await harness();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'exit 3' });
  await mgr._settled(job.id);
  expect(job.targets[0]).toMatchObject({ status: 'error', code: 3 });
});
