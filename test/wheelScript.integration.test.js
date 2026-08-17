import { test, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSendWheelRemote } from '../src/server/tmuxInject.js';

const execFile = promisify(execFileCb);

// The wheel script runs on the BOX, under whatever login shell ssh lands in —
// the fleet's provisioned boxes run zsh, where an unquoted $var does NOT
// word-split. The first version used `set -- $flags` and its mouse gate read
// one giant field, refusing every pane (found live: a claude pane with
// mouse_any=1/sgr=1 got 409). So this suite executes the REAL script under
// each shell against a real, isolated tmux server. zsh is required here the
// way sshd is in localBox.js: skipping silently would restore the coupling
// this suite exists to prevent.
let dir, env;

async function tmux(...args) {
  return execFile('tmux', args, { env });
}

async function shellExit(shell, script) {
  try {
    await execFile(shell, ['-c', script], { env });
    return 0;
  } catch (e) {
    return e.code;
  }
}

// Condition-based wait: the mouse pane's printf must have been processed by
// tmux before the flags read 1.
async function waitMouseFlags(session, want, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await tmux('display-message', '-p', '-t', `=${session}:`, '#{mouse_any_flag} #{mouse_sgr_flag}');
    if (r.stdout.trim() === want) return;
    if (Date.now() > until) throw new Error(`mouse flags never became "${want}" (last: "${r.stdout.trim()}")`);
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-wheel-'));
  // Own tmux server (TMUX_TMPDIR) so this never touches an operator session;
  // TMUX stripped so running inside one doesn't trip nesting protection.
  env = { ...process.env, TMUX_TMPDIR: dir };
  delete env.TMUX;
  // A pane that turns on button tracking + SGR encoding, then reads forever —
  // the terminal state a Claude Code pane is in.
  await tmux('new-session', '-d', '-s', 'mousey', 'printf \'\\033[?1002h\\033[?1006h\'; exec cat');
  await tmux('new-session', '-d', '-s', 'plain', 'exec cat');
  await waitMouseFlags('mousey', '1 1');
}, 30_000);

afterAll(async () => {
  try { await tmux('kill-server'); } catch {}
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

for (const shell of ['sh', 'bash', 'zsh']) {
  test(`wheel script under ${shell}: delivers to a mouse pane, exit 93 on a plain one`, async () => {
    expect(await shellExit(shell, buildSendWheelRemote('mousey', 'up', 2))).toBe(0);
    expect(await shellExit(shell, buildSendWheelRemote('plain', 'up', 2))).toBe(93);
  });
}
