import { test, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { PROBE_REMOTE, parseAgentMarks, parseTmuxWindows } from '../src/server/status.js';

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
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, "tmux send-keys -t agenthooks 'sh ~/tmuxifier-agent-hook.sh stop </dev/null; exec sleep 300' Enter"], { env: lb.env });
  // Poll for the marker (send-keys is asynchronous).
  const pane = (await sshRun(['-F', lb.sshConfigFile, lb.box.host, "tmux list-panes -t agenthooks -F '#{pane_id}'"], { env: lb.env })).stdout.trim();
  const marker = path.join(lb.home, '.tmuxifier-agent', `agenthooks${pane}`);
  let content = '';
  for (let i = 0; i < 30 && !content; i++) {
    await new Promise((r) => setTimeout(r, 200));
    content = await fs.readFile(marker, 'utf8').catch(() => '');
  }
  expect(content).toMatch(new RegExp(`^agenthooks:ready:\\d+:stop:${pane}\\n$`));
  // `exec sleep` has to land first: a pane still at its shell is the stale case.
  for (let i = 0; i < 30; i++) {
    const cmd = (await sshRun(['-F', lb.sshConfigFile, lb.box.host, "tmux list-panes -t agenthooks -F '#{pane_current_command}'"], { env: lb.env })).stdout.trim();
    if (cmd === 'sleep') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  // Full probe over real ssh: the marker line and the session line coexist.
  const res = await sshRun(['-F', lb.sshConfigFile, lb.box.host, PROBE_REMOTE], { env: lb.env });
  const marks = parseAgentMarks(res.stdout);
  expect(marks).toBeTruthy();
  expect(marks.agenthooks).toMatchObject({ state: 'ready', cause: 'stop' });
  // The same probe pins WINDOW_FMT against REAL tmux. Every other window test
  // feeds parseTmuxWindows a hand-written __WIN__ line, so a wrong field order or
  // a specifier that expands differently from what we assume would pass all of
  // them -- this repo's own recorded lesson being that thousands of green tests
  // over a fake transport proved nothing about the real one.
  const windows = parseTmuxWindows(res.stdout).filter((w) => w.session === 'agenthooks');
  expect(windows.length).toBeGreaterThan(0);
  const w = windows[0];
  expect(Number.isInteger(w.index)).toBe(true);
  expect(w.id).toMatch(/^@\d+$/);
  // A session's only window is always its active one, so this pins the
  // #{window_active} field's position and its 0/1 spelling as well.
  expect(w.active).toBe(true);
  expect(typeof w.name).toBe('string');
});

test('real tmux split: a working pane holds the session at working until the other side finishes too', async () => {
  lb = await setupLocalBox();
  teardown = lb.cleanup;
  const asset = await fs.readFile(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url), 'utf8');
  await fs.writeFile(path.join(lb.home, 'tmuxifier-agent-hook.sh'), asset, { mode: 0o755 });
  const ssh = (cmd) => sshRun(['-F', lb.sshConfigFile, lb.box.host, cmd], { env: lb.env });
  await ssh('tmux new-session -d -s agenthooks -x 120 -y 40');
  await ssh('tmux split-window -d -t agenthooks');
  const panes = (await ssh("tmux list-panes -t agenthooks -F '#{pane_id}'")).stdout.trim().split('\n');
  expect(panes).toHaveLength(2);
  // `sleep` stands in for the agent still running in the pane: a pane back at
  // its shell is the stale case and must not count.
  const fire = (pane, ev) => ssh(`tmux send-keys -t '${pane}' 'sh ~/tmuxifier-agent-hook.sh ${ev} </dev/null; exec sleep 300' Enter`);
  const waitFor = async (pane, re) => {
    const file = path.join(lb.home, '.tmuxifier-agent', `agenthooks${pane}`);
    for (let i = 0; i < 40; i++) {
      const c = await fs.readFile(file, 'utf8').catch(() => '');
      if (re.test(c)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`no marker matching ${re} for ${pane}`);
  };
  await fire(panes[0], 'prompt');
  await waitFor(panes[0], /:working:/);
  await fire(panes[1], 'stop');
  await waitFor(panes[1], /:ready:/);
  let cmds = '';
  for (let i = 0; i < 40; i++) {
    cmds = (await ssh("tmux list-panes -t agenthooks -F '#{pane_current_command}'")).stdout;
    if (cmds.trim().split('\n').every((c) => c === 'sleep')) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  expect(cmds.trim().split('\n')).toEqual(['sleep', 'sleep']);
  const res = await ssh(PROBE_REMOTE);
  expect(parseAgentMarks(res.stdout).agenthooks).toMatchObject({ state: 'working', cause: 'prompt' });
  // Close the working pane: only the finished one is left.
  await ssh(`tmux kill-pane -t '${panes[0]}'`);
  const after = await ssh(PROBE_REMOTE);
  expect(parseAgentMarks(after.stdout).agenthooks).toMatchObject({ state: 'ready', cause: 'stop' });
});
