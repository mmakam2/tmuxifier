import { describe, it, test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentMarks, parsePaneMarks, parseTmuxSessions, PROBE_REMOTE, AGENT_REMOTE } from '../src/server/status.js';

// Split panes share a tmux session, so each pane's agent keeps its own marker
// and the session reads as the fold of its live panes.

const mark = (session, state, ts, cause, pane) => `__AGENT__ ${session}:${state}:${ts}:${cause}${pane ? `:${pane}` : ''}`;
const paneRow = (session, pane, cmd = 'claude') => `__PANE__ ${session}:@0:${pane}:1:1:0:${cmd}`;
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
  expect(parseTmuxSessions('__PANE__ web:@0:%1:1:1:0:claude')).toEqual([]);
});

test('both probes list panes, capped at the source', () => {
  for (const remote of [PROBE_REMOTE, AGENT_REMOTE]) {
    expect(remote).toContain("tmux list-panes -a -F '__PANE__ #{session_name}:#{window_id}:#{pane_id}:#{pane_index}:#{pane_active}:#{window_zoomed_flag}:#{pane_current_command}' | head -n 400");
  }
});

// The per-pane reading: one entry per pane id, no per-session fold. A session-wide
// marker (four fields, or the legacy three) speaks for every agent pane of its
// session that has no marker of its own.
describe('parsePaneMarks', () => {
  const P = (rows) => rows.map((r) => `__PANE__ ${r}`).join('\n');
  const A = (rows) => rows.map((r) => `__AGENT__ ${r}`).join('\n');

  it('keys a five-field marker by its pane', () => {
    const out = [A(['main:blocked:1700000100:permission:%1', 'main:working:1700000200:prompt:%2']), P(['main:@0:%1:1:1:0:claude', 'main:@0:%2:2:0:0:claude'])].join('\n');
    expect({ ...parsePaneMarks(out) }).toEqual({
      '%1': { session: 'main', state: 'blocked', cause: 'permission', ts: 1700000100 },
      '%2': { session: 'main', state: 'working', cause: 'prompt', ts: 1700000200 },
    });
  });
  it('drops a pane marker whose pane is gone, at a shell, or listed in another session', () => {
    const out = [A(['main:ready:1700000100:stop:%1', 'main:ready:1700000100:stop:%2', 'main:ready:1700000100:stop:%3']), P(['main:@0:%2:1:1:0:zsh', 'other:@1:%3:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)).toBeNull();
  });
  it('applies a session-wide marker to every agent pane of the session with no marker of its own', () => {
    const out = [A(['main:working:1700000300:prompt', 'main:blocked:1700000100:permission:%1']),
      P(['main:@0:%1:1:1:0:claude', 'main:@0:%2:2:0:0:codex', 'main:@1:%3:1:1:0:pi', 'main:@1:%4:2:0:0:zsh', 'other:@2:%5:1:1:0:codex'])].join('\n');
    const m = parsePaneMarks(out);
    expect(Object.keys(m).sort()).toEqual(['%1', '%2', '%3']);
    expect(m['%1'].state).toBe('blocked');
    expect(m['%2']).toEqual({ session: 'main', state: 'working', cause: 'prompt', ts: 1700000300 });
    expect(m['%3']).toEqual(m['%2']);
  });
  it('reads the legacy three-field marker as session-wide', () => {
    const out = [A(['main:waiting:1700000100']), P(['main:@0:%1:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)['%1']).toEqual({ session: 'main', state: 'ready', cause: 'stop', ts: 1700000100 });
  });
  it('with no trustworthy listing keeps pane markers and applies session-wide ones to nothing', () => {
    const out = A(['main:working:1700000300:prompt', 'main:blocked:1700000100:permission:%1']);
    expect(Object.keys(parsePaneMarks(out))).toEqual(['%1']);
  });
  it('takes the newest when two markers name one pane and both sessions list it', () => {
    const out = [A(['a:ready:1700000100:stop:%1', 'b:working:1700000200:prompt:%1']), P(['a:@0:%1:1:1:0:claude', 'b:@0:%1:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)['%1']).toMatchObject({ session: 'b', state: 'working' });
  });
  it('refuses unknown states, causes, a non-positive ts and a session named __proto__ as an inherited key', () => {
    const out = [A(['main:bogus:1700000100:stop:%1', 'main:ready:0:stop:%1', 'main:ready:1700000100:nope:%1', '__proto__:ready:1700000100:stop:%2']), P(['main:@0:%1:1:1:0:claude', '__proto__:@1:%2:1:1:0:claude'])].join('\n');
    const m = parsePaneMarks(out);
    expect(Object.keys(m)).toEqual(['%2']);
    expect(Object.getPrototypeOf(m)).toBeNull();
  });

  // Beyond the spec's table: the same rules at their edges.
  it('keeps the marker whose session lists the pane when a moved pane left its old file behind', () => {
    const out = [A(['old:working:1700000900:prompt:%1', 'main:ready:1700000100:stop:%1']), P(['main:@0:%1:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)['%1']).toEqual({ session: 'main', state: 'ready', cause: 'stop', ts: 1700000100 });
  });
  it('lets a session-wide marker of a grouped session speak for a shared pane, the newer one when both do', () => {
    const out = [A(['a:ready:1700000100:stop', 'b:working:1700000200:prompt']), P(['a:@0:%1:1:1:0:claude', 'b:@0:%1:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)['%1']).toMatchObject({ session: 'b', state: 'working', ts: 1700000200 });
  });
  it('speaks for a pane whose own marker was dropped as stale', () => {
    // %1's own marker names a session that does not hold it, so %1 has no marker
    // of its own; the listing still says it is an agent pane of `main`.
    const out = [A(['main:working:1700000300:prompt', 'gone:blocked:1700000100:permission:%1']), P(['main:@0:%1:1:1:0:claude'])].join('\n');
    expect(parsePaneMarks(out)['%1']).toEqual({ session: 'main', state: 'working', cause: 'prompt', ts: 1700000300 });
  });
  it('treats a capped pane listing as untrustworthy: pane markers survive, session-wide ones apply to nothing', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `main:@0:%${i + 10}:1:0:0:claude`);
    const out = [A(['main:working:1700000300:prompt', 'gone:blocked:1700000100:permission:%1']), P(rows)].join('\n');
    expect(Object.keys(parsePaneMarks(out))).toEqual(['%1']);
  });
  it('is null with no markers, with only unusable ones, and for a malformed pane field', () => {
    expect(parsePaneMarks(P(['main:@0:%1:1:1:0:claude']))).toBeNull();
    expect(parsePaneMarks(A(['main:working:1700000100:prompt:12', 'main:working:1700000100:prompt:%1x', 'main:working:1700000100:prompt:%1:extra', 'main:working']))).toBeNull();
    expect(parsePaneMarks(A(['main:working:1700000100:prompt']))).toBeNull(); // session-wide, no panes to speak for
  });
  it('leaves parseAgentMarks alone: the per-session fold is still there', () => {
    const out = [A(['main:ready:1700000200:stop:%1', 'main:working:1700000100:prompt:%2']), P(['main:@0:%1:1:1:0:claude', 'main:@0:%2:2:0:0:claude'])].join('\n');
    expect(parseAgentMarks(out).main).toEqual({ state: 'working', cause: 'prompt', ts: 1700000100 });
    expect(Object.keys(parsePaneMarks(out)).sort()).toEqual(['%1', '%2']);
  });
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
