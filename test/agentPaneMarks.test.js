import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentMarks, parseTmuxSessions, PROBE_REMOTE, AGENT_REMOTE } from '../src/server/status.js';

// Split panes share a tmux session, so each pane's agent keeps its own marker
// and the session reads as the fold of its live panes.

const mark = (session, state, ts, cause, pane) => `__AGENT__ ${session}:${state}:${ts}:${cause}${pane ? `:${pane}` : ''}`;
const paneRow = (session, pane, cmd = 'claude') => `__PANE__ ${session}:${pane}:${cmd}`;
const parse = (...lines) => parseAgentMarks(lines.join('\n'));

test('a working pane outranks a finished pane in the same session', () => {
  const out = parse(mark('web', 'ready', 200, 'stop', '%1'), mark('web', 'working', 100, 'prompt', '%2'), paneRow('web', '%1'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'working', cause: 'prompt', ts: 100 });
});

test('a blocked pane outranks a working pane', () => {
  const out = parse(mark('web', 'working', 200, 'prompt', '%1'), mark('web', 'blocked', 100, 'question', '%2'), paneRow('web', '%1'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'blocked', cause: 'question', ts: 100 });
});

test('once every pane has finished the session carries the newest finish', () => {
  const out = parse(mark('web', 'ready', 200, 'stop', '%1'), mark('web', 'ready', 300, 'stop', '%2'), paneRow('web', '%1'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'ready', cause: 'stop', ts: 300 });
});

test('a pane that just started does not hide another pane\'s finished turn', () => {
  const out = parse(mark('web', 'ready', 200, 'stop', '%1'), mark('web', 'ready', 300, 'start', '%2'), paneRow('web', '%1'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'ready', cause: 'stop', ts: 200 });
});

test('panes in different sessions fold separately', () => {
  const out = parse(mark('a', 'ready', 200, 'stop', '%1'), mark('b', 'working', 100, 'prompt', '%2'), paneRow('a', '%1'), paneRow('b', '%2'));
  expect(out.a.state).toBe('ready');
  expect(out.b.state).toBe('working');
});

test('a closed pane no longer counts', () => {
  const out = parse(mark('web', 'working', 100, 'prompt', '%1'), mark('web', 'ready', 200, 'stop', '%2'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'ready', cause: 'stop', ts: 200 });
});

test('a pane back at its shell no longer counts, so a killed agent cannot pin the session', () => {
  const out = parse(mark('web', 'working', 100, 'prompt', '%1'), mark('web', 'ready', 200, 'stop', '%2'), paneRow('web', '%1', 'zsh'), paneRow('web', '%2'));
  expect(out.web).toEqual({ state: 'ready', cause: 'stop', ts: 200 });
});

test('a session with only stale pane markers has no state', () => {
  expect(parse(mark('web', 'working', 100, 'prompt', '%1'), paneRow('other', '%9', 'bash'))).toBeNull();
});

test('a pane moved to another session stops counting for the old one', () => {
  expect(parse(mark('web', 'working', 100, 'prompt', '%1'), paneRow('elsewhere', '%1'))).toBeNull();
});

test('no pane listing at all fails open: the markers still count', () => {
  const out = parse(mark('web', 'ready', 200, 'stop', '%1'), mark('web', 'working', 100, 'prompt', '%2'));
  expect(out.web.state).toBe('working');
});

test('a pane listing at the row cap is not trusted to be complete', () => {
  const rows = Array.from({ length: 400 }, (_, i) => paneRow('other', `%${i + 10}`));
  const out = parse(mark('web', 'working', 100, 'prompt', '%1'), ...rows);
  expect(out.web.state).toBe('working');
});

test('a session-wide marker still works alone', () => {
  expect(parse(mark('web', 'working', 100, 'prompt'), paneRow('web', '%1')).web).toEqual({ state: 'working', cause: 'prompt', ts: 100 });
});

test('a pre-upgrade session-wide marker is superseded by a newer pane marker', () => {
  const out = parse(mark('web', 'working', 100, 'prompt'), mark('web', 'ready', 200, 'stop', '%1'), paneRow('web', '%1'));
  expect(out.web).toEqual({ state: 'ready', cause: 'stop', ts: 200 });
});

test('a session-wide marker newer than the pane markers still folds in', () => {
  const out = parse(mark('web', 'working', 300, 'prompt'), mark('web', 'ready', 200, 'stop', '%1'), paneRow('web', '%1'));
  expect(out.web).toEqual({ state: 'working', cause: 'prompt', ts: 300 });
});

test('a malformed pane field drops the marker', () => {
  expect(parse(mark('web', 'working', 100, 'prompt', '12'), paneRow('web', '%1'))).toBeNull();
  expect(parse(mark('web', 'working', 100, 'prompt', '%1x'), paneRow('web', '%1'))).toBeNull();
  expect(parse('__AGENT__ web:working:100:prompt:%1:extra', paneRow('web', '%1'))).toBeNull();
});

test('a session named __proto__ lands as an own key', () => {
  const out = parse(mark('__proto__', 'working', 100, 'prompt', '%1'), paneRow('__proto__', '%1'));
  expect(Object.hasOwn(out, '__proto__')).toBe(true);
});

test('pane rows are not mistaken for tmux session rows', () => {
  expect(parseTmuxSessions(paneRow('web', '%1', 'claude'))).toEqual([]);
  expect(parseTmuxSessions('__PANE__ web:1:0:5:claude')).toEqual([]);
});

test('both probes list panes, capped at the source', () => {
  for (const remote of [PROBE_REMOTE, AGENT_REMOTE]) {
    expect(remote).toContain("tmux list-panes -a -F '__PANE__ #{session_name}:#{pane_id}:#{pane_current_command}' | head -n 400");
  }
});

// The hook itself, driven per pane.
const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));

async function box() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpane-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), "#!/bin/sh\nprintf '%s\\n' 'web'\n", { mode: 0o755 });
  const envFor = (pane) => {
    const e = { HOME: dir, TMUX: '/tmp/tmux-0/default,123,0', PATH: `${bin}:/usr/bin:/bin` };
    if (pane !== undefined) e.TMUX_PANE = pane;
    return e;
  };
  const run = (arg, pane, stdin = '{}') => new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK, arg], { env: envFor(pane) }, (err) => resolve(err ? 1 : 0));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
  const read = (name) => fs.readFile(path.join(dir, '.tmuxifier-agent', name), 'utf8').catch(() => '');
  const exists = (rel) => fs.stat(path.join(dir, '.tmuxifier-agent', rel)).then(() => true, () => false);
  return { run, read, exists };
}

test('each pane writes its own marker, carrying its pane id', async () => {
  const b = await box();
  await b.run('prompt', '%1');
  await b.run('stop', '%2');
  expect(await b.read('web%1')).toMatch(/^web:working:\d+:prompt:%1\n$/);
  expect(await b.read('web%2')).toMatch(/^web:ready:\d+:stop:%2\n$/);
  expect(await b.read('web')).toBe('');
});

test('one pane ending leaves the other pane\'s marker alone', async () => {
  const b = await box();
  await b.run('prompt', '%1');
  await b.run('prompt', '%2');
  await b.run('end', '%1');
  expect(await b.read('web%1')).toBe('');
  expect(await b.read('web%2')).toMatch(/:working:/);
});

test('one pane\'s operator prompt does not clear the other pane\'s background work', async () => {
  const b = await box();
  await b.run('subagent-start', '%1', '{"agent_id":"a1"}');
  await b.run('prompt', '%2', '{"prompt":"hi"}');
  await b.run('stop', '%1');
  expect(await b.read('web%1')).toMatch(/^web:working:\d+:prompt:%1\n$/);
});

test('one pane\'s tool call does not clear the other pane\'s block', async () => {
  const b = await box();
  await b.run('permission', '%1', '{"tool_name":"Bash"}');
  await b.run('prompt', '%2', '{"prompt":"hi"}');
  await b.run('unblock', '%2', '{}');
  expect(await b.read('web%1')).toMatch(/:blocked:/);
  expect(await b.exists('blocked/web%1')).toBe(true);
});

test('without a usable TMUX_PANE the hook falls back to the session-wide marker', async () => {
  for (const pane of [undefined, '', 'bogus', '%', '%1;rm']) {
    const b = await box();
    await b.run('prompt', pane);
    expect(await b.read('web'), String(pane)).toMatch(/^web:working:\d+:prompt\n$/);
  }
});
