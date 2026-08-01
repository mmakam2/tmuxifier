import { test, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { PROBE_REMOTE, parseAgentMarks } from '../src/server/status.js';

let lb; let teardown;
afterEach(async () => {
  if (lb) {
    try { await sshRun(['-F', lb.sshConfigFile, lb.box.host, 'tmux kill-session -t agenthooks 2>/dev/null || true'], { env: lb.env }); } catch {}
  }
  if (teardown) await teardown();
  teardown = null;
});

test('hook script → marker file → PROBE_REMOTE → parseAgentMarks round trip', async () => {
  lb = await setupLocalBox();
  teardown = lb.cleanup;
  // Install the real asset into the box home (the same bytes setup pushes).
  const asset = await fs.readFile(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url), 'utf8');
  await fs.writeFile(path.join(lb.home, 'tmuxifier-agent-hook.sh'), asset, { mode: 0o755 });
  // Real tmux session; run the hook INSIDE the pane so $TMUX and the session
  // name resolve exactly as they do under a live claude. </dev/null because
  // send-keys gives the script a tty stdin the drain would otherwise block on.
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, 'tmux new-session -d -s agenthooks'], { env: lb.env });
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, "tmux send-keys -t agenthooks 'sh ~/tmuxifier-agent-hook.sh stop </dev/null' Enter"], { env: lb.env });
  // Poll for the marker (send-keys is asynchronous).
  const marker = path.join(lb.home, '.tmuxifier-agent', 'agenthooks');
  let content = '';
  for (let i = 0; i < 30 && !content; i++) {
    await new Promise((r) => setTimeout(r, 200));
    content = await fs.readFile(marker, 'utf8').catch(() => '');
  }
  expect(content).toMatch(/^agenthooks:waiting:\d+\n$/);
  // Full probe over real ssh: the marker line and the session line coexist.
  const res = await sshRun(['-F', lb.sshConfigFile, lb.box.host, PROBE_REMOTE], { env: lb.env });
  const marks = parseAgentMarks(res.stdout);
  expect(marks).toBeTruthy();
  expect(marks.agenthooks).toMatchObject({ state: 'waiting' });
});
