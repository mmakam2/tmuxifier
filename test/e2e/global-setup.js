import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setupLocalBox } from '../helpers/localBox.js';
import { hashPassword } from '../../src/server/auth.js';
import { createStore } from '../../src/server/store.js';

// Absolute (not cwd-relative) so the e2e server finds the fixture regardless
// of where `playwright test` happens to be invoked from.
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export default async function globalSetup() {
  const lb = await setupLocalBox();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-e2e-'));
  const sshConfigText = await fs.readFile(lb.sshConfigFile, 'utf8');
  const aliasOptions = sshConfigText
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('Host '))
    .join('\n');
  // tmuxifierlocal-setupjob: a fourth alias to the same fixture, deliberately
  // left unseeded below (no store.addBox call) — setup-server-side.spec.ts
  // adds its own box against it through the UI, and box hosts must be unique
  // (store.js rejects a duplicate host), so it needs a host string none of
  // the three seeded boxes below are already using.
  await fs.appendFile(
    lb.sshConfigFile,
    `\nHost tmuxifierlocal-db\n${aliasOptions}\n\nHost tmuxifierlocal-worker\n${aliasOptions}\n\nHost tmuxifierlocal-setupjob\n${aliasOptions}\n`,
  );

  // Seed the box into a temp inventory so no UI prompt is needed
  const store = createStore({ dataDir });
  await store.addBox({ host: lb.box.host, label: 'localhost', sessionName: lb.session, tags: ['Prod'] });
  await store.addBox({ host: 'tmuxifierlocal-db', label: 'db-primary', sessionName: lb.session, tags: ['Prod'] });
  await store.addBox({ host: 'tmuxifierlocal-worker', label: 'untagged-worker', sessionName: lb.session });

  const hash = await hashPassword('e2e');

  const server = spawn('node', ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUXIFIER_PASSWORD_HASH: hash,
      TMUXIFIER_COOKIE_SECRET: 'e2e-secret',
      TMUXIFIER_AUTH_MODE: 'password',
      TMUXIFIER_BIND: '127.0.0.1',
      TMUXIFIER_PORT: '7438',
      TMUXIFIER_DATA_DIR: dataDir,
      TMUXIFIER_SSH_CONFIG: lb.sshConfigFile,
      // Fast server-side poll so health samples/events accrue within e2e
      // timeouts (the health spec needs two samples for a sparkline).
      TMUXIFIER_STATUS_POLL_MS: '2000',
      TMUXIFIER_TLS_CERT: '',
      TMUXIFIER_TLS_KEY: '',
      TMUXIFIER_BASE_EXTERNAL_URL: '',
      TMUXIFIER_PUBLIC_URL: '',
      // Voice dictation, pointed at the fixture whisper-server (test/e2e/fixtures)
      // rather than a real model/binary, so the suite needs no compiler or GPU
      // and CI can run it. This is a real exported var on the spawned child's
      // env, which per config.js's precedence (.env file -> shell env) wins
      // over whatever TMUXIFIER_WHISPER_BIN/MODEL a contributor's own .env
      // happens to have set for real transcription.
      TMUXIFIER_WHISPER_BIN: path.join(fixturesDir, 'fake-whisper-server.mjs'),
      TMUXIFIER_WHISPER_MODEL: path.join(fixturesDir, 'fake-model.bin'),
    },
    stdio: 'inherit',
  });

  // Poll for server readiness instead of a fixed sleep (up to ~10s)
  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:7438/');
      if (res.status === 200 || res.status === 302 || res.status === 401) {
        ready = true;
        break;
      }
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('Tmuxifier server did not become ready within 10 seconds');

  return async () => {
    server.kill();
    await lb.cleanup();
    await fs.rm(dataDir, { recursive: true, force: true });
  };
}
