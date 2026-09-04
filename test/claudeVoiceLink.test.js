import { test, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceLinkInstallScript, createVoiceLinkPusher } from '../src/server/claudeVoiceLink.js';

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}
// A temp HOME with a stub `claude` on PATH — how the presence check is made to pass.
async function claudeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { dir, cfg: path.join(dir, '.claude'), env: () => ({ HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: `${bin}:/usr/bin:/bin` }) };
}
const isFifo = async (p) => (await fs.stat(p)).isFIFO();
// What the box-side layout must look like after a run: the real FIFO under
// mic.fifo, and `mic` — the path ~/.asoundrc names — a symlink parked on
// /dev/zero. Idle it must read as silence, never block: alsa-lib opens
// `infile` O_RDONLY and a FIFO with no writer blocks that open forever.
async function expectIdleDevice(dir) {
  const d = path.join(dir, '.tmuxifier-voice');
  expect(await isFifo(path.join(d, 'mic.fifo'))).toBe(true);
  expect((await fs.lstat(path.join(d, 'mic'))).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(path.join(d, 'mic'))).toBe('/dev/zero');
}

test('the script interpolates nothing and carries the marker and the plug/file/null recipe', () => {
  const s = buildVoiceLinkInstallScript();
  expect(s).toContain("MARK='# tmuxifier-voice-link'");
  expect(s).toContain('type plug');
  expect(s).toContain('type file');
  expect(s).toContain('slave.pcm "null"');
  expect(s).toContain('format S16_LE rate 16000 channels 1');
  expect(s).toContain('command -v claude');
  // The idle device: a symlink to /dev/zero, so a capture open with nothing
  // linked returns silence instead of blocking on a writerless FIFO.
  expect(s).toContain('ln -sfn /dev/zero "$DEV"');
  expect(s).toContain('mkfifo -m 600 "$FIFO"');
  expect(s).toContain('FIFO="$VDIR/mic.fifo"');
  expect(s).not.toMatch(/\$\{[^}]*(box|host|user|session)/i);
});

test('no Claude on the box: touches nothing and reports skipped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  const res = await runShell(buildVoiceLinkInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.asoundrc'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
});

test('fresh box: writes ~/.asoundrc with the absolute FIFO path, makes the FIFO, and turns voice on', async () => {
  const b = await claudeBox();
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: applied settings=applied');
  const rc = await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8');
  expect(rc.startsWith('# tmuxifier-voice-link\n')).toBe(true);
  expect(rc).toContain(`infile "${path.join(b.dir, '.tmuxifier-voice', 'mic')}"`);
  expect(rc).toContain('pcm.!default {');
  expect((await fs.stat(path.join(b.dir, '.asoundrc'))).mode & 0o777).toBe(0o600);
  await expectIdleDevice(b.dir);
  expect((await fs.stat(path.join(b.dir, '.tmuxifier-voice', 'mic.fifo'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(b.dir, '.tmuxifier-voice'))).mode & 0o777).toBe(0o700);
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(settings).toEqual({ voice: { enabled: true } });
});

test('rerun is idempotent: a marked ~/.asoundrc is rewritten, the FIFO kept, settings kept', async () => {
  const b = await claudeBox();
  await runShell(buildVoiceLinkInstallScript(), b.env());
  await fs.writeFile(path.join(b.dir, '.asoundrc'), '# tmuxifier-voice-link\nstale\n');
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('VOICELINK: applied settings=kept');
  expect(await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8')).toContain('type plug');
  await expectIdleDevice(b.dir);
});

test('the pre-symlink layout migrates: a FIFO named `mic` becomes mic.fifo, `mic` becomes the symlink', async () => {
  // Boxes prepared before the idle-device fix have the FIFO AT ~/.tmuxifier-voice/mic.
  // Renaming it (rather than deleting and re-making it) keeps its mode and
  // any reader already blocked on it, and leaves `mic` free for the symlink.
  const b = await claudeBox();
  const d = path.join(b.dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', path.join(d, 'mic')]);
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  await expectIdleDevice(b.dir);
  expect((await fs.stat(path.join(d, 'mic.fifo'))).mode & 0o777).toBe(0o600);
});

test('the old FIFO is dropped rather than migrated when mic.fifo already exists', async () => {
  // A half-migrated box: both names are FIFOs. The new one is authoritative —
  // a second FIFO under the old name would have neither reader nor writer.
  const b = await claudeBox();
  const d = path.join(b.dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', path.join(d, 'mic')]);
  execFileSync('mkfifo', ['-m', '600', path.join(d, 'mic.fifo')]);
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  await expectIdleDevice(b.dir);
});

test('a regular file where the device belongs is never clobbered', async () => {
  // Same posture as the foreign-.asoundrc guard: Tmuxifier never creates a
  // regular file there, so one is the operator's own. The link then simply
  // does not work rather than something of theirs being destroyed.
  const b = await claudeBox();
  const d = path.join(b.dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(d, 'mic'), 'not ours\n');
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  expect(await fs.readFile(path.join(d, 'mic'), 'utf8')).toBe('not ours\n');
  expect(await isFifo(path.join(d, 'mic.fifo'))).toBe(true);
});

test('a foreign ~/.asoundrc is never touched: skipped, no FIFO, no settings change', async () => {
  const b = await claudeBox();
  await fs.writeFile(path.join(b.dir, '.asoundrc'), 'pcm.!default { type hw card 0 }\n');
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-asoundrc-exists');
  expect(await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8')).toBe('pcm.!default { type hw card 0 }\n');
  await expect(fs.access(path.join(b.dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(b.cfg, 'settings.json'))).rejects.toBeTruthy();
});

test('an existing settings.json without a voice key is merged, every other key preserved', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [] }] } }, null, 2));
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('settings=applied');
  const s = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(s).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [] }] }, voice: { enabled: true } });
});

test('an operator who ran /voice off stays off: an existing voice key is kept verbatim', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  const before = JSON.stringify({ voice: { enabled: false, mode: 'tap' } }, null, 2);
  await fs.writeFile(path.join(b.cfg, 'settings.json'), before);
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('settings=kept');
  expect(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8')).toBe(before);
});

test('malformed settings.json: merge parse failure is reported, device installed anyway', async () => {
  const b = await claudeBox();

  // Build a custom tools bin with node/python3/claude/essential-commands but NOT jq
  const toolsToLink = ['node', 'python3', 'claude', 'sh', 'mkdir', 'chmod', 'mkfifo', 'rm', 'mv', 'ln', 'echo', 'cat', 'grep', 'printf'];
  for (const tool of toolsToLink) {
    try {
      const toolPath = execFileSync('command', ['-v', tool], { shell: true, stdio: 'pipe' }).toString().trim();
      if (toolPath && toolPath !== tool) {
        await fs.symlink(toolPath, path.join(b.dir, 'bin', tool), 'file').catch(() => {});
      }
    } catch {
      // Tool not found, skip
    }
  }

  await fs.mkdir(b.cfg, { recursive: true });
  const before = '{not json';
  await fs.writeFile(path.join(b.cfg, 'settings.json'), before);

  // PATH contains only our custom bin (no jq) - all essential tools are symlinked there
  const customPath = path.join(b.dir, 'bin');

  const res = await runShell(buildVoiceLinkInstallScript(), { HOME: b.dir, CLAUDE_CONFIG_DIR: b.cfg, PATH: customPath });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: applied settings=error-settings-parse');
  const rc = await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8');
  expect(rc.startsWith('# tmuxifier-voice-link\n')).toBe(true);
  await expectIdleDevice(b.dir);
  expect(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8')).toBe(before);
});

test('pusher maps applied → ok+settings, both skips → skipped, failure → error', async () => {
  const mk = (res) => createVoiceLinkPusher({ runStdin: async () => res });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=applied\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'applied' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=kept\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'kept' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=error-settings-parse\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'error-settings-parse' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-no-claude\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'no Claude on the box' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-asoundrc-exists\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'the box has its own ~/.asoundrc' });
  expect(await mk({ code: 1, stdout: '' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, error: 'voice link push failed' });
  let seen;
  await createVoiceLinkPusher({ runStdin: async (box, script, input) => { seen = { box, script, input }; return { code: 0, stdout: 'VOICELINK: applied settings=applied\n' }; } }).push({ id: 'b' });
  expect(seen.script).toBe(buildVoiceLinkInstallScript());
  expect(seen.input.length).toBe(0);
});
