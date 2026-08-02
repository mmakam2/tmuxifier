import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentSampler, readAgentMarks, LOCAL_BOX_ID } from '../src/server/localAgent.js';
import { sampleOf } from '../src/server/healthHistory.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-localagent-'));
}

test('LOCAL_BOX_ID matches the client pane id', () => {
  expect(LOCAL_BOX_ID).toBe('__local__');
});

test('readAgentMarks parses a valid marker through the probe allowlist', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000\n');
  expect(await readAgentMarks(home)).toEqual({ local: { state: 'working', ts: 1722600000 } });
});

test('readAgentMarks returns null for a missing dir, malformed content, and bad state', async () => {
  expect(await readAgentMarks(tmpHome())).toBeNull();

  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'a'), 'not a marker at all');
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'b'), 'local:reticulating:1722600000');
  expect(await readAgentMarks(home)).toBeNull();
});

test('readAgentMarks caps an oversized marker at 200 bytes (same as the on-box probe)', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  // 300 bytes of junk: the 200-byte cap truncates it and the parser drops it.
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'big'), 'x'.repeat(300));
  expect(await readAgentMarks(home)).toBeNull();
});

// The 200-byte cap above is applied to the bytes AFTER the whole file has been
// read, so it bounds what is parsed, not what is read. A stat() guard bounds
// the read itself: only regular files, only small ones. It follows symlinks,
// matching the on-box probe's `[ -f "$f" ]`, and keeps readFile away from
// entries it would block on or slurp.
test('readAgentMarks skips directory and oversized entries, keeping the valid marker', async () => {
  const home = tmpHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1722600000\n');
  fs.writeFileSync(path.join(dir, 'huge'), 'x'.repeat(2000)); // past the read guard
  fs.mkdirSync(path.join(dir, 'subdir'));                     // not a regular file
  expect(await readAgentMarks(home)).toEqual({ local: { state: 'working', ts: 1722600000 } });
});

test('sample() reads tmux sessions via the shared STATUS_FMT parser', async () => {
  const home = tmpHome();
  const calls = [];
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async (args) => {
      calls.push(args);
      return { code: 0, stdout: 'local:1:0:1722600000:claude\n' };
    },
  });
  const s = await sampler.sample();
  expect(calls[0][0]).toBe('ls');
  expect(s.reachable).toBe(true);
  expect(s.tmux).toBe(true);
  expect(s.sessions).toEqual([{ name: 'local', windows: 1, attached: false, activity: 1722600000, paneCmd: 'claude' }]);
});

test('sample() degrades to no sessions when tmux is absent or has no server', async () => {
  const noServer = createLocalAgentSampler({ home: tmpHome(), runTmux: async () => ({ code: 1, stdout: '' }) });
  expect(await noServer.sample()).toMatchObject({ reachable: true, sessions: [] });

  const throwing = createLocalAgentSampler({ home: tmpHome(), runTmux: async () => { throw new Error('ENOENT'); } });
  expect(await throwing.sample()).toMatchObject({ reachable: true, sessions: [] });
});

test('the sample shape drives sampleOf exactly like a box probe result', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000');
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async () => ({ code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  const sample = sampleOf(await sampler.sample(), 123, { sessionName: 'local' });
  expect(sample.up).toBe(true);
  expect(sample.agentPresent).toBe(true);
  expect(sample.agent).toBe('working');
  expect(sample.agentAttached).toBe(false);
});
