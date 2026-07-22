import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStatuslineInstallScript, createStatuslinePusher } from '../src/server/claudeStatusline.js';

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}

test('builder emits the claude presence check and the status markers', () => {
  const s = buildStatuslineInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('$HOME/.local/bin/claude');
  expect(s).toContain('STATUSLINE: skipped-no-claude');
  expect(s).toContain('STATUSLINE: applied');
  // The literal command value whose ${...} is expanded only at render time.
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh');
});

test('on a box without claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  // PATH without claude, and HOME with no ~/.local/bin/claude.
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: '/usr/bin:/bin' }, 'SCRIPT-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('STATUSLINE: skipped-no-claude');
  // No statusline file created.
  await expect(fs.access(path.join(dir, '.claude', 'statusline-command.sh'))).rejects.toBeTruthy();
});

test('on a box with claude: writes the script from stdin, writes fresh settings.json, prints applied', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cfg = path.join(dir, '.claude');
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}:/usr/bin:/bin` }, '#!/bin/bash\necho hi\n');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('STATUSLINE: applied');
  const sl = await fs.readFile(path.join(cfg, 'statusline-command.sh'), 'utf8');
  expect(sl).toContain('echo hi');
  const settings = JSON.parse(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8'));
  expect(settings.statusLine.type).toBe('command');
  expect(settings.statusLine.command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh');
});

test('on a box with claude and an existing settings.json: merges .statusLine, preserving other keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cfg = path.join(dir, '.claude');
  await fs.mkdir(cfg, { recursive: true });
  await fs.writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'xhigh' }, null, 2));
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}:/usr/bin:/bin` }, 'SL');
  expect(res.code).toBe(0);
  const settings = JSON.parse(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8'));
  expect(settings.model).toBe('opus');            // preserved
  expect(settings.effortLevel).toBe('xhigh');     // preserved
  expect(settings.statusLine.command).toContain('statusline-command.sh');
});

test('pusher maps applied → ok', async () => {
  const p = createStatuslinePusher({
    runStdin: async () => ({ ok: true, code: 0, stdout: 'noise\nSTATUSLINE: applied\n', stderr: '' }),
    readAsset: async () => Buffer.from('SCRIPT'),
  });
  expect(await p.push({ id: 'b' })).toEqual({ target: 'statusline', ok: true });
});

test('pusher maps skipped-no-claude → skipped', async () => {
  const p = createStatuslinePusher({
    runStdin: async () => ({ ok: true, code: 0, stdout: 'STATUSLINE: skipped-no-claude\n', stderr: '' }),
    readAsset: async () => Buffer.from('SCRIPT'),
  });
  expect(await p.push({ id: 'b' })).toEqual({ target: 'statusline', ok: false, skipped: 'no Claude on the box' });
});

test('pusher maps non-zero exit → error, and pipes the asset bytes', async () => {
  let piped = null;
  const p = createStatuslinePusher({
    runStdin: async (_box, _script, input) => { piped = input; return { ok: false, code: 4, stdout: 'STATUSLINE: error-no-json-tool\n', stderr: '' }; },
    readAsset: async () => Buffer.from('ASSET-BYTES'),
  });
  const r = await p.push({ id: 'b' });
  expect(r).toEqual({ target: 'statusline', ok: false, error: 'statusline push failed' });
  expect(piped.toString()).toBe('ASSET-BYTES');
});
