import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createAiAuthSeeder } from '../src/server/aiAuthSeed.js';

let teardown;
afterEach(async () => {
  if (teardown) await teardown();
  teardown = null;
});

// The Claude token is written in plaintext into the box's rc files. Over the
// real transport (ssh argv → the box's login shell, token on stdin), every rc
// file that ends up holding it must have no group/other access, even though
// the fixture's rc files start out at the usual 0644.
test('claude seed over real ssh leaves every token-bearing rc file owner-only', async () => {
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
  for (const p of rcFiles) {
    expect(await fs.readFile(p, 'utf8'), p).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-EXAMPLE' # tmuxifier-claude-token");
    expect((await fs.stat(p)).mode & 0o777, p).toBe(0o600);
  }
});
