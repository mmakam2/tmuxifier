import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Boot failures must exit nonzero: the systemd unit uses Restart=on-failure,
// which treats exit 0 as a deliberate stop and leaves the service down.
test('a corrupt config.json makes boot exit nonzero, with the parse error on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-boot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{ definitely not json');
  const entry = path.resolve('src/server/index.js');
  const r = spawnSync(process.execPath, [entry], {
    cwd: dir, // config.json/.env are read from cwd; the temp dir isolates us from the repo's real config
    env: { PATH: process.env.PATH },
    timeout: 15000,
    encoding: 'utf8',
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Invalid JSON');
  fs.rmSync(dir, { recursive: true, force: true });
});
