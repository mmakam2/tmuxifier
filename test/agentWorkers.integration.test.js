import { test, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupLocalBox } from './helpers/localBox.js';
import { writeWorkerRcFiles, writeWorkerToken, writeStandIn, readStandInLog } from './helpers/workerBench.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createAgentWorkerStore } from '../src/server/agentWorkerStore.js';
import { createAgentWorkers } from '../src/server/agentWorkers.js';

// The starter over real ssh (design section 5.2): localBox.js's isolated sshd and the real
// createBoxActions, as test/sessionCreate.integration.test.js wires them. The script runs
// under the account's own login shell (bash or zsh), and the stand-in `claude` is found only
// through the rc line in the fixture home, as on a real box.
//
// Isolation: localBox's sshd sets HOME, ZDOTDIR and TMUX_TMPDIR into its fixture, so the
// box's tmux server is private to lb.tmp. The stand-in's `sleep 600` would keep that server
// alive after the fixture is removed, so teardown kills it, by the exact socket path under
// lb.tmp and with TMUX unset, never through the default server.

let teardown = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

test('starts a worker on a real box over ssh, found through the rc line, with its token', async () => {
  const lb = await setupLocalBox();
  teardown.push(lb.cleanup);
  const socket = path.join(lb.tmp, `tmux-${process.getuid()}`, 'default');
  teardown.push(() => {
    if (!existsSync(socket)) return;
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env, stdio: 'ignore' });
  });

  const tmuxBin = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
  writeWorkerRcFiles(lb.home);
  writeWorkerToken(lb.home);
  writeStandIn(lb.home, { tmux: tmuxBin });
  const dir = path.join(lb.home, 'billing-api');
  mkdirSync(dir, { recursive: true });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-workers-int-'));
  teardown.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = createAgentWorkerStore({ dataDir });
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  await store.set(box.id, { projects: [{ name: 'api', dir }] });

  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  const workers = createAgentWorkers({
    execCommand: (b, remote, opts) => boxActions.execCommand(b, remote, opts),
    workerStore: store,
    setupRunning: () => false,
    sessionsOf: () => [],
  });

  const r = await workers.start(box);
  expect(r).toEqual({ ok: true, session: 'worker-api-1', project: 'api', trust: null });

  const has = await boxActions.execCommand(box, "tmux has-session -t '=worker-api-1'", { timeoutMs: 12000 });
  expect(has.code).toBe(0);
  // The socket the box's tmux used is the private one under lb.tmp.
  expect(existsSync(socket)).toBe(true);

  const end = Date.now() + 10000;
  let log = null;
  while (!(log = readStandInLog(lb.home, 'worker-api-1')) && Date.now() < end) {
    await new Promise((res) => setTimeout(res, 100));
  }
  expect(log).toBe(`token=set cwd=${dir} tty=yes`);
}, 30000);
