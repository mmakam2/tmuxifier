import { test, expect, beforeAll, afterAll } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';

let lb, boxActions;
beforeAll(async () => {
  lb = await setupLocalBox();
  boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, opts),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, opts),
    hostKeyPolicy: 'accept-new',
    sshConfigFile: lb.sshConfigFile,
  });
  // A detached session with a predictable pane. cat keeps the pane open.
  const mk = await boxActions.execCommand(lb.box, "tmux new-session -d -s snap 'printf snapshot-marker\\\\n; exec cat'");
  expect(mk.code).toBe(0);
}, 60_000);
afterAll(async () => {
  if (boxActions && lb) await boxActions.execCommand(lb.box, 'tmux kill-session -t =snap').catch(() => {});
  if (lb) await lb.cleanup();
});

test('paneSnapshot reads real tmux content and geometry', async () => {
  const snap = await boxActions.paneSnapshot(lb.box, 'snap');
  expect(snap.ok).toBe(true);
  expect(snap.width).toBeGreaterThan(0);
  expect(snap.height).toBeGreaterThan(0);
  expect(snap.content).toContain('snapshot-marker');
});

test('sendKeys text lands in the pane; a named key is accepted', async () => {
  expect((await boxActions.sendKeys(lb.box, 'snap', { text: 'typed-by-test' })).ok).toBe(true);
  expect((await boxActions.sendKeys(lb.box, 'snap', { key: 'Enter' })).ok).toBe(true);
  // cat echoes the line back, so it appears twice (input + echo) — either
  // occurrence proves delivery end-to-end.
  await new Promise((r) => setTimeout(r, 500));
  const snap = await boxActions.paneSnapshot(lb.box, 'snap');
  expect(snap.content).toContain('typed-by-test');
});

test('a missing session is an error, not a half-snapshot', async () => {
  const snap = await boxActions.paneSnapshot(lb.box, 'no-such-session');
  expect(snap.ok).toBe(false);
});
