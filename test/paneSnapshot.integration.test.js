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

// The named-pane capture against a real tmux (on the isolated box: its own sshd, TMUX_TMPDIR in a fixture
// home, so never the operator's tmux server). Session `named`: window one holds panes p1 (active) and p2,
// window two (current) holds p3, each printing its own marker. The capture must read the pane it was
// told to, whichever one the operator is looking at, say which pane that was, and move nothing.
test('a named pane is captured exactly, reports its id, and focus does not move', async () => {
  const x = async (cmd) => {
    const r = await boxActions.execCommand(lb.box, cmd);
    expect(r.code, `${cmd}: ${r.stderr}`).toBe(0);
    return String(r.stdout).trim();
  };
  const win1 = await x("tmux new-session -d -s named -x 100 -y 30 -P -F '#{window_id}' 'printf one-p1\\\\n; exec cat'");
  const p1 = await x(`tmux display-message -p -t '=named:${win1}' '#{pane_id}'`);
  const p2 = await x(`tmux split-window -d -t '=named:${win1}.${p1}' -P -F '#{pane_id}' 'printf one-p2\\\\n; exec cat'`);
  const win2 = await x("tmux new-window -d -t '=named:' -P -F '#{window_id}' 'printf two-p3\\\\n; exec cat'");
  const p3 = await x(`tmux display-message -p -t '=named:${win2}' '#{pane_id}'`);
  await x(`tmux select-window -t '=named:${win2}'`);
  const focus = () => x("tmux display-message -p -t '=named:' '#{window_id} #{pane_id}'");
  expect(await focus()).toBe(`${win2} ${p3}`);
  await new Promise((r) => setTimeout(r, 300));
  try {
    // Not the current window, and not its active pane: the default would never show this screen.
    const other = await boxActions.paneSnapshot(lb.box, 'named', { windowId: win1, paneId: p2 });
    expect(other.ok).toBe(true);
    expect(other.pane).toBe(p2);
    expect(other.content).toContain('one-p2');
    expect(other.content).not.toContain('one-p1');
    const first = await boxActions.paneSnapshot(lb.box, 'named', { windowId: win1, paneId: p1, shared: true });
    expect(first.pane).toBe(p1);
    expect(first.content).toContain('one-p1');
    // Reading a pane focuses nothing.
    expect(await focus()).toBe(`${win2} ${p3}`);
    // The default names the active pane of the current window.
    const dflt = await boxActions.paneSnapshot(lb.box, 'named');
    expect(dflt.ok).toBe(true);
    expect(dflt.pane).toBe(p3);
    expect(dflt.content).toContain('two-p3');
    // A pane that is not in the named window is a failed capture, never another pane's screen.
    const wrongWindow = await boxActions.paneSnapshot(lb.box, 'named', { windowId: win2, paneId: p2 });
    expect(wrongWindow.ok).toBe(false);
    // Nor does a prefix of the session name find it.
    const prefix = await boxActions.paneSnapshot(lb.box, 'name', { windowId: win1, paneId: p2 });
    expect(prefix.ok).toBe(false);
    expect(await focus()).toBe(`${win2} ${p3}`);
  } finally {
    await boxActions.execCommand(lb.box, 'tmux kill-session -t =named').catch(() => {});
  }
});
