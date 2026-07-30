import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { buildProbeArgv } from '../src/server/sshCommand.js';

// The isolation guarantees of the test box itself. These exist because every one
// of them was once false, and the consequences were paid for: a red suite caused
// by an oh-my-zsh update prompt in the operator's ~/.zshrc, six orphaned keys
// left in the operator's ~/.ssh/authorized_keys, and a login shell repointed at a
// deleted temp directory. If any assertion here fails, the suites have quietly
// gone back to testing against the developer's own account.

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

const runOnBox = async (lb, command) => {
  const res = await sshRun(buildProbeArgv(lb.box, command, { sshConfigFile: lb.sshConfigFile }), { env: lb.env });
  return String(res.stdout || '').trim();
};

test('the box logs into a fixture home, not the operator\'s', async () => {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;

  const boxHome = await runOnBox(lb, 'printf %s "$HOME"');
  expect(boxHome).toBe(lb.home);
  expect(boxHome).not.toBe(os.homedir());
  // Real, not just an env var: a file written to ~ on the box lands in the fixture.
  await runOnBox(lb, 'printf marker > "$HOME/.isolation-probe"');
  await expect(fs.readFile(path.join(lb.home, '.isolation-probe'), 'utf8')).resolves.toBe('marker');
});

test('the box reads the fixture rc files, so no operator config can reach the suite', async () => {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;

  // ZDOTDIR points at the fixture, and the fixture .zshrc is the minimal one this
  // helper writes — no framework, therefore no updater, no prompt, no surprises.
  expect(await runOnBox(lb, 'printf %s "$ZDOTDIR"')).toBe(lb.home);
  const rc = await fs.readFile(path.join(lb.home, '.zshrc'), 'utf8');
  expect(rc).toContain('PROMPT=');
  expect(rc).not.toMatch(/oh-my|omz/i);
});

test('setupLocalBox never touches the operator\'s authorized_keys', async () => {
  const realAk = path.join(os.homedir(), '.ssh', 'authorized_keys');
  const digest = async () => {
    try { return createHash('sha256').update(await fs.readFile(realAk)).digest('hex'); }
    catch { return 'absent'; }
  };

  const before = await digest();
  const lb = await setupLocalBox();
  // Prove the box is actually reachable on its own trust store before claiming
  // the real file was not needed.
  expect(await runOnBox(lb, 'printf ok')).toBe('ok');
  const during = await digest();
  await lb.cleanup();
  teardown = null;
  const after = await digest();

  expect(during).toBe(before);
  expect(after).toBe(before);
});

test('the box runs its own tmux server, not the operator\'s', async () => {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;

  // A shared TMUX_TMPDIR would attach `tmux new-session` to the operator's
  // already-running server and inherit ITS environment — including the real
  // HOME — which would defeat the whole arrangement while still looking green.
  expect(await runOnBox(lb, 'printf %s "$TMUX_TMPDIR"')).toBe(lb.tmp);
  await runOnBox(lb, `tmux new-session -d -s ${lb.session}`);
  const sockets = await runOnBox(lb, `ls ${lb.tmp}/tmux-$(id -u) 2>/dev/null | wc -l`);
  expect(Number(sockets)).toBeGreaterThan(0);
});

test('chsh on the box cannot repoint the operator\'s login shell', async () => {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;

  // HOME isolation does not cover /etc/passwd, so the fixture PATH shadows chsh
  // with an inert stub. Without it, a setup run that installs a shell framework
  // would change the account the tests run as.
  const which = await runOnBox(lb, 'command -v chsh');
  expect(which.startsWith(lb.home)).toBe(true);

  const shellBefore = (await fs.readFile('/etc/passwd', 'utf8'))
    .split('\n').find((l) => l.startsWith(`${os.userInfo().username}:`));
  await runOnBox(lb, 'chsh -s /nonexistent/shell "$(id -un)" || true');
  const shellAfter = (await fs.readFile('/etc/passwd', 'utf8'))
    .split('\n').find((l) => l.startsWith(`${os.userInfo().username}:`));
  expect(shellAfter).toBe(shellBefore);
});
