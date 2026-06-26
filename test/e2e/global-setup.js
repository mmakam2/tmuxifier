import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setupLocalBox } from '../helpers/localBox.js';
import { hashPassword } from '../../src/server/auth.js';
import { createStore } from '../../src/server/store.js';

export default async function globalSetup() {
  const lb = await setupLocalBox();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-e2e-'));
  const sshConfigText = await fs.readFile(lb.sshConfigFile, 'utf8');
  const aliasOptions = sshConfigText
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('Host '))
    .join('\n');
  await fs.appendFile(
    lb.sshConfigFile,
    `\nHost tmuxifierlocal-db\n${aliasOptions}\n\nHost tmuxifierlocal-worker\n${aliasOptions}\n`,
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
      TMUXIFIER_TLS_CERT: '',
      TMUXIFIER_TLS_KEY: '',
      TMUXIFIER_BASE_EXTERNAL_URL: '',
      TMUXIFIER_PUBLIC_URL: '',
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
