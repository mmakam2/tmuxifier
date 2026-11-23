import { test, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerBench } from './helpers/workerBench.js';

// The agent hook's ownership check against real processes: a real, private tmux server (never
// the operator's, see workerBench.js), the kernel's own /proc, and stand-in Claude Codes
// (helpers/fakeClaude.mjs) that start the real hook the way Claude Code does. The replay of the
// recorded trace (agentHooksNestedReplay.test.js) feeds the hook a recorded /proc; this suite is
// where the hook reads a live one, and where tmux itself answers `#{pane_pid}` for $TMUX_PANE.

const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fakeClaude.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bench;
beforeAll(() => { bench = createWorkerBench({ defaultShell: 'sh' }); });
afterAll(async () => { await bench?.cleanup(); });

// Runs `steps` in a new pane of a new session and returns the snapshots it took. `shape`:
//   'shell'   the stand-in is a child of the pane's shell, in a second pane that is not the
//             active one (so `#{pane_pid}` must come from $TMUX_PANE, not from the active pane)
//   'first'   the stand-in is the pane's first process, as a worker's `exec claude` is
// `before` is a shell command the pane's shell runs first ('shell' shape only).
async function play(session, steps, { shape = 'shell', shell = 'dash', before = '' } = {}) {
  const out = path.join(bench.home, 'out', session);
  mkdirSync(out, { recursive: true });
  const node = process.execPath;
  let pane;
  if (shape === 'first') {
    pane = bench.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, 'sleep 600').trim();
  } else {
    bench.tmux('new-session', '-d', '-s', session, 'sleep 600');
    pane = bench.tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `=${session}:`, 'sleep 600').trim();
  }
  const prog = path.join(out, 'prog.json');
  writeFileSync(prog, JSON.stringify({ hook: HOOK, shell, marker: path.join(bench.home, '.tmuxifier-agent', `${session}${pane}`), out, steps: [...steps, ['touch', 'finished']] }));
  const run = `'${node}' '${FAKE}' '${prog}'`;
  // respawn-pane -k replaces the placeholder with the real command once the program file exists.
  bench.tmux('respawn-pane', '-k', '-t', pane, shape === 'first' ? `exec ${run}` : `${before ? `${before}; ` : ''}${run}; sleep 600`);
  for (let i = 0; i < 1500 && !existsSync(path.join(out, 'finished')); i++) await sleep(10);
  expect(existsSync(path.join(out, 'finished')), `${session}: the pane program finished`).toBe(true);
  const snap = (name) => readFileSync(path.join(out, name), 'utf8');
  const state = (name) => { const p = snap(name).split(':'); return p.length > 3 ? `${p[1]}/${p[3]}` : snap(name); };
  const owner = () => { const f = path.join(bench.home, '.tmuxifier-agent', 'owner', `${session}${pane}`); return existsSync(f) ? readFileSync(f, 'utf8').trim() : ''; };
  return { snap, state, owner, pane };
}

const INNER = [['hook', 'start'], ['hook', 'prompt'], ['hook', 'stop'], ['hook', 'end']];

test('the pane\'s own Claude Code writes its marker from a pane that is not the active one', async () => {
  const r = await play('own', [['hook', 'start'], ['snap', 'a'], ['hook', 'prompt'], ['snap', 'b'], ['hook', 'stop'], ['snap', 'c'], ['hook', 'end'], ['snap', 'd']]);
  expect([r.state('a'), r.state('b'), r.state('c'), r.state('d')]).toEqual(['ready/start', 'working/prompt', 'ready/stop', '(none)']);
});

for (const shell of ['dash', 'bash']) {
  test(`a Claude Code run under the pane's own leaves the marker alone (hook started through ${shell} -c)`, async () => {
    const r = await play(`sync-${shell}`, [['hook', 'start'], ['hook', 'prompt'], ['snap', 'before'], ['nested', INNER], ['snap', 'after'], ['hook', 'stop'], ['snap', 'end']], { shell });
    expect(r.state('before')).toBe('working/prompt');
    expect(r.snap('after')).toBe(r.snap('before'));
    expect(r.state('end')).toBe('ready/stop');
  });
}

test('a Claude Code left behind and re-parented away from the pane leaves the marker alone', async () => {
  const r = await play('detached', [['hook', 'start'], ['hook', 'prompt'], ['hook', 'stop'], ['snap', 'before'], ['detached', [...INNER, ['touch', 'inner-done']]], ['await', 'inner-done'], ['snap', 'after']]);
  expect(r.state('before')).toBe('ready/stop');
  expect(r.snap('after')).toBe(r.snap('before'));
});

test('a Claude Code outside the pane\'s process tree that has a terminal of its own is not refused (screen, dtach)', async () => {
  // Under a multiplexer started in the pane, an interactive Claude Code hangs off init too. It
  // has a terminal, which a `claude -p` left in the background has not: no evidence, so the
  // hook acts as it always did.
  const r = await play('terminal', [['hook', 'start'], ['hook', 'prompt'], ['hook', 'stop'], ['snap', 'before'], ['terminal', [['hook', 'prompt'], ['touch', 'inner-done']]], ['await', 'inner-done'], ['snap', 'after']]);
  expect(r.state('before')).toBe('ready/stop');
  expect(r.state('after')).toBe('working/prompt');
});

test('both hold when Claude Code is the pane\'s first process', async () => {
  const r = await play('first', [
    ['hook', 'start'], ['hook', 'prompt'], ['snap', 'before'],
    ['nested', INNER], ['snap', 'after-nested'],
    ['detached', [...INNER, ['touch', 'inner-done']]], ['await', 'inner-done'], ['snap', 'after-detached'],
    ['hook', 'stop'], ['snap', 'end'],
  ], { shape: 'first' });
  expect(r.state('before')).toBe('working/prompt');
  expect(r.snap('after-nested')).toBe(r.snap('before'));
  expect(r.snap('after-detached')).toBe(r.snap('before'));
  expect(r.state('end')).toBe('ready/stop');
});

test('a hook run by hand from the pane\'s shell does not claim the pane for that shell', async () => {
  // The shell runs the hook itself, with the pane's terminal, and only then starts Claude Code.
  // Were the shell recorded as the owner, every Claude Code in the pane would read as nested.
  const r = await play('byhand', [['hook', 'prompt'], ['snap', 'a'], ['hook', 'stop'], ['snap', 'b']], { before: `sh '${HOOK}' start </dev/null` });
  expect([r.state('a'), r.state('b')]).toEqual(['working/prompt', 'ready/stop']);
  const panePid = bench.tmux('display-message', '-p', '-t', r.pane, '#{pane_pid}').trim();
  expect(r.owner()).not.toBe('');
  expect(r.owner().split(' ')[0]).not.toBe(panePid);
});
