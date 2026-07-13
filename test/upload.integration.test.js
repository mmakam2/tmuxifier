import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { UPLOAD_DIR_NAME } from '../src/server/uploads.js';

let teardown;
const created = [];
afterEach(async () => {
  for (const p of created.splice(0)) { try { await fs.unlink(p); } catch {} }
  if (teardown) await teardown();
  teardown = null;
});

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

test('uploadFile lands the bytes on the box and returns the absolute path', async () => {
  const { box, boxActions } = await harness();
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const res = await boxActions.uploadFile(box, 'shot.png', payload, { timeoutMs: 15000 });
  expect(res.ok).toBe(true);
  expect(res.path).toMatch(new RegExp(`/${UPLOAD_DIR_NAME}/\\d+-[0-9a-f]{8}-shot\\.png$`));
  expect(path.isAbsolute(res.path)).toBe(true);
  created.push(res.path);
  // the "box" is this host, so the file is directly readable
  expect(await fs.readFile(res.path)).toEqual(payload);
});

test('uploadFile prunes uploads older than 24h', async () => {
  const { box, boxActions } = await harness();
  const dir = path.join(os.homedir(), UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const oldFile = path.join(dir, 'stale-test-upload.txt');
  await fs.writeFile(oldFile, 'old');
  created.push(oldFile);
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const res = await boxActions.uploadFile(box, 'fresh.txt', Buffer.from('hi'), { timeoutMs: 15000 });
  expect(res.ok).toBe(true);
  created.push(res.path);
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('uploadFile rejects an invalid filename without touching ssh', async () => {
  const boxActions = createBoxActions({
    run: async () => { throw new Error('must not run'); },
    runStdin: async () => { throw new Error('must not run'); },
  });
  const res = await boxActions.uploadFile({ host: 'example.com' }, '../etc/passwd', Buffer.from('x'));
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/invalid upload filename/);
});

test('uploadFile surfaces a failed remote write as ok:false with stderr', async () => {
  // Injected runner (DI, same style as server.test.js stubs) — no ssh needed
  // to exercise the non-zero-exit branch.
  const boxActions = createBoxActions({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runStdin: async () => ({ code: 1, stdout: '', stderr: 'disk full' }),
  });
  const res = await boxActions.uploadFile({ host: 'example.com' }, 'x.txt', Buffer.from('x'));
  expect(res).toEqual({ ok: false, error: 'disk full' });
});
