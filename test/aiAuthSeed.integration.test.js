import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createAiAuthSeeder, CLAUDE_TOKEN_FILE, CLAUDE_TOKEN_RC_LINE } from '../src/server/aiAuthSeed.js';

let teardown;
afterEach(async () => {
  if (teardown) await teardown();
  teardown = null;
});

// Over the real transport (ssh argv → the box's login shell, token on stdin):
// the token lands only in its own owner-only file, no rc file holds it (so
// dotfile sync or a world-readable rc cannot leak it), and a shell on the box
// that reads its rc files still ends up with it in the environment.
test('claude seed over real ssh keeps the token in its own file and out of every rc file', async () => {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const rcFiles = ['.profile', '.bashrc', '.zshrc'].map((f) => path.join(lb.home, f));
  for (const p of rcFiles) await fs.chmod(p, 0o644);
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  const seeder = createAiAuthSeeder({
    runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
    token: 'sk-ant-oat-EXAMPLE',
    // Never read the operator's real ~/.codex/auth.json from a test.
    readLocal: async () => { throw new Error('ENOENT'); },
  });
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const results = await seeder.seed(box);
  expect(results[0]).toEqual({ target: 'claude', ok: true });
  const tokenFile = path.join(lb.home, CLAUDE_TOKEN_FILE);
  expect(await fs.readFile(tokenFile, 'utf8')).toBe('sk-ant-oat-EXAMPLE\n');
  expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(tokenFile))).mode & 0o777).toBe(0o700);
  for (const p of rcFiles) {
    const text = await fs.readFile(p, 'utf8');
    expect(text, p).not.toContain('sk-ant-oat-EXAMPLE');
    expect(text.split('\n'), p).toContain(CLAUDE_TOKEN_RC_LINE);
  }
  const read = await boxActions.execScriptStdin(box, '. "$HOME/.profile"; printf %s "$CLAUDE_CODE_OAUTH_TOKEN"', Buffer.from(''));
  expect(read).toMatchObject({ ok: true, stdout: 'sk-ant-oat-EXAMPLE' });
});
