import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshStream } from '../src/server/sshRun.js';
import { buildSetupArgv } from '../src/server/sshCommand.js';
import { createSetupManager } from '../src/server/setupManager.js';

// Every setupManager unit test drives a FAKE sshStream, so none of them proves
// that a saved script body actually executes on a box. These run the real
// transport against the isolated sshd from test/helpers/localBox.js — its own
// sshd, host key, authorized_keys and fixture HOME, so nothing here touches the
// developer's account or shell config.

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function harness({ script, buildScript = () => 'true' }) {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const m = createSetupManager({
    sshStream: (argv, opts) => sshStream(argv, { ...opts, env: lb.env }),
    buildSetupArgv,
    // The real install script is minutes of apt; this test is about the script
    // PHASE, so the setup run itself is a no-op that exits 0.
    buildScript,
    sshConfigFile: lb.sshConfigFile,
    getScript: async (id) => (id === 'fs-1' ? { id: 'fs-1', name: 'bootstrap', script } : null),
    load: () => [],
    save: () => {},
    taskTimeoutMs: 30000,
  });
  return { m, box, home: lb.home };
}

test('a saved script really runs on the box and its output lands in the job log', async () => {
  const { m, box, home } = await harness({
    script: 'echo SCRIPT-RAN > "$HOME/.provision-marker"\necho bootstrap-ok\n',
  });
  const s = m.start(box, { tools: [], scriptId: 'fs-1', scriptName: 'bootstrap' });
  await m._settled(s.id);

  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.postScript).toEqual({ target: 'bootstrap', ok: true });
  expect(job.log).toContain('bootstrap-ok');
  // The side effect is the real proof: the body reached a shell on the box.
  expect(await fs.readFile(path.join(home, '.provision-marker'), 'utf8')).toContain('SCRIPT-RAN');
}, 60000);

// A multi-line body is the normal case — the editor exists precisely so a saved
// script can be a script. It rides ssh argv as one final element, exactly as
// Fleet Command's command already does.
test('a multi-line script body executes as a script, not just its first line', async () => {
  const { m, box, home } = await harness({
    script: [
      'set -e',
      'mkdir -p "$HOME/.bootstrap"',
      'for i in 1 2 3; do echo "line $i" >> "$HOME/.bootstrap/out"; done',
      'echo done-multiline',
    ].join('\n'),
  });
  const s = m.start(box, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);

  expect(m.getJob(s.id).postScript).toEqual({ target: 'bootstrap', ok: true });
  const out = await fs.readFile(path.join(home, '.bootstrap', 'out'), 'utf8');
  expect(out.trim().split('\n')).toEqual(['line 1', 'line 2', 'line 3']);
}, 60000);

// The rule the whole feature rests on: setup succeeded, so the box is usable and
// the job must not go red over the operator's own script.
test('a failing script leaves the job done, with the real exit code recorded', async () => {
  const { m, box } = await harness({ script: 'echo about-to-fail >&2\nexit 3\n' });
  const s = m.start(box, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);

  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.error).toBe(null);
  expect(job.postScript).toEqual({ target: 'bootstrap', ok: false, error: 'exited 3' });
  expect(job.log).toContain('about-to-fail');
}, 60000);
