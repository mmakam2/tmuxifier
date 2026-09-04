import { test, expect, afterEach } from 'vitest';
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
    // ensure.sh exits at once on its no-op path — before this stdin write
    // lands — and that EPIPE must not surface as an unhandled error.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}
const HOOK_ENTRY = { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-voice/ensure.sh"' }] };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function readPid(dir) {
  try { return Number((await fs.readFile(path.join(dir, '.tmuxifier-voice', 'writer.pid'), 'utf8')).trim()) || 0; } catch { return 0; }
}
// The install starts a resident feeder (ensure.sh); each test stops it the
// way a shutdown would, and a sweep makes sure none outlives the run.
async function stopFeeder(dir) {
  const pid = await readPid(dir);
  if (pid > 0 && alive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 300 && alive(pid); i++) await tick(10);
    expect(alive(pid)).toBe(false);
  }
  settled.add(dir);
  return pid;
}
const boxes = [];
const settled = new Set();
// Every run of the install script goes through here: an install (re)starts a
// feeder, so the box is no longer settled whatever a test did before.
function install(env) {
  settled.delete(env.HOME);
  return runShell(buildVoiceLinkInstallScript(), env);
}
afterEach(async () => {
  for (const d of boxes.splice(0)) {
    if (settled.has(d)) continue;
    // An install that ran ensure.sh has a feeder starting in the background;
    // give it a moment to claim its pidfile, then stop it like a shutdown.
    let pid = 0;
    for (let i = 0; i < 100 && !(pid > 0 && alive(pid)); i++) { pid = await readPid(d); await tick(10); }
    if (pid > 0 && alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 300 && alive(pid); i++) await tick(10);
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  settled.clear();
});
// A temp HOME with a stub `claude` on PATH — how the presence check is made to pass.
async function claudeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  boxes.push(dir);
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { dir, cfg: path.join(dir, '.claude'), env: () => ({ HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: `${bin}:/usr/bin:/bin` }) };
}
const isFifo = async (p) => (await fs.stat(p)).isFIFO();
// What the box-side layout must look like after a run: the real FIFO under
// mic.fifo; the writer program and ensure.sh beside it; and `mic` — the path
// ~/.asoundrc names — a symlink that the resident feeder the install just
// started points at the FIFO (paced silence while nothing is linked). Stopping
// that feeder the way a shutdown would parks the symlink on an ABSENT path:
// never a writerless FIFO (open blocks forever) and never /dev/zero (alsa-lib's
// null slave has no clock, so a source that never blocks spins capture at CPU
// speed and the reader buffers it until the box is out of memory — v1.24.59).
async function expectIdleDevice(dir) {
  const d = path.join(dir, '.tmuxifier-voice');
  expect(await isFifo(path.join(d, 'mic.fifo'))).toBe(true);
  expect((await fs.lstat(path.join(d, 'mic'))).isSymbolicLink()).toBe(true);
  expect((await fs.stat(path.join(d, 'writer.py'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(d, 'ensure.sh'))).mode & 0o777).toBe(0o700);
  let pid = 0;
  for (let i = 0; i < 300; i++) {
    pid = await readPid(dir);
    if (pid > 0 && alive(pid) && (await fs.readlink(path.join(d, 'mic')).catch(() => '')) === path.join(d, 'mic.fifo')) break;
    await tick(10);
  }
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(true);
  expect(await fs.readlink(path.join(d, 'mic'))).toBe(path.join(d, 'mic.fifo'));
  await stopFeeder(dir);
  expect(await fs.readlink(path.join(d, 'mic'))).toBe(path.join(d, 'mic.absent'));
  await expect(fs.access(path.join(d, 'mic.absent'))).rejects.toBeTruthy();
}

test('the script interpolates nothing and carries the marker and the plug/file/null recipe', () => {
  const s = buildVoiceLinkInstallScript();
  expect(s).toContain("MARK='# tmuxifier-voice-link'");
  expect(s).toContain('type plug');
  expect(s).toContain('type file');
  expect(s).toContain('slave.pcm "null"');
  // Both recipes are carried; the box picks one from its pipe capacity: the
  // direct one (no fixed slave rate, so no rate plugin — over a clock-less
  // slave that plugin loses most of every read larger than a frame) when a
  // 19200-byte read can be trusted to fit, else the v1.24.60 rate recipe.
  expect(s).toContain('slave.pcm "tmuxifier_mic"');
  expect(s).toContain('format S16_LE rate 16000 channels 1');
  expect(s).toContain('pipe-user-pages-soft');
  expect(s).toContain('$VDIR/format');
  expect(s).toContain('command -v claude');
  // The idle device: a symlink to an absent path, so a capture open with
  // nothing linked fails instead of blocking (writerless FIFO) or spinning
  // (/dev/zero, EOF — alsa-lib's null slave has no clock).
  expect(s).toContain('ln -sfn "$ABSENT" "$DEV"');
  expect(s).not.toContain('ln -sfn /dev/zero');
  expect(s).toContain('command -v python3');
  // The resident feeder: the writer program lands on the box as a file, with
  // ensure.sh to (re)start it, and a SessionStart hook runs ensure.sh so a
  // reboot never leaves Claude with a device nobody feeds.
  expect(s).toContain("<<'TMUXIFIER_WRITER_EOF'");
  expect(s).toContain('ensure.sh');
  expect(s).toContain('SessionStart');
  expect(s).toContain('tmuxifier-voice');
  expect(s).toContain('mkfifo -m 600 "$FIFO"');
  expect(s).toContain('FIFO="$VDIR/mic.fifo"');
  expect(s).not.toMatch(/\$\{[^}]*(box|host|user|session)/i);
});

test('no Claude on the box: touches nothing and reports skipped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  const res = await install({ HOME: dir, PATH: '/usr/bin:/bin' });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.asoundrc'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
});

test('fresh box: writes ~/.asoundrc with the absolute FIFO path, makes the FIFO, and turns voice on', async () => {
  const b = await claudeBox();
  const res = await install(b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: applied settings=applied');
  const rc = await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8');
  expect(rc.startsWith('# tmuxifier-voice-link\n')).toBe(true);
  expect(rc).toContain(`infile "${path.join(b.dir, '.tmuxifier-voice', 'mic')}"`);
  expect(rc).toContain('pcm.!default {');
  // The recipe and the writer's mode are decided together, from the pipe.
  const mode = (await fs.readFile(path.join(b.dir, '.tmuxifier-voice', 'format'), 'utf8')).trim();
  expect(['auto', 's16le-rate']).toContain(mode);
  expect(rc.includes('rate 16000')).toBe(mode === 's16le-rate');
  expect(res.stdout).toContain(mode === 'auto' ? 'pipe=direct' : 'pipe=rate');
  expect((await fs.stat(path.join(b.dir, '.asoundrc'))).mode & 0o777).toBe(0o600);
  await expectIdleDevice(b.dir);
  expect((await fs.stat(path.join(b.dir, '.tmuxifier-voice', 'mic.fifo'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(b.dir, '.tmuxifier-voice'))).mode & 0o777).toBe(0o700);
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(settings).toEqual({ voice: { enabled: true }, hooks: { SessionStart: [HOOK_ENTRY] } });
});

test('rerun is idempotent: a marked ~/.asoundrc is rewritten, the FIFO kept, settings kept', async () => {
  const b = await claudeBox();
  await install(b.env());
  await fs.writeFile(path.join(b.dir, '.asoundrc'), '# tmuxifier-voice-link\nstale\n');
  const res = await install(b.env());
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
  const res = await install(b.env());
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
  const res = await install(b.env());
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
  const res = await install(b.env());
  expect(res.code).toBe(0);
  expect(await fs.readFile(path.join(d, 'mic'), 'utf8')).toBe('not ours\n');
  expect(await isFifo(path.join(d, 'mic.fifo'))).toBe(true);
});

test('a foreign ~/.asoundrc is never touched: skipped, no FIFO, no settings change', async () => {
  const b = await claudeBox();
  await fs.writeFile(path.join(b.dir, '.asoundrc'), 'pcm.!default { type hw card 0 }\n');
  const res = await install(b.env());
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
  const res = await install(b.env());
  expect(res.stdout).toContain('settings=applied');
  const s = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(s).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [] }], SessionStart: [HOOK_ENTRY] }, voice: { enabled: true } });
});

test('reruns leave exactly one voice hook entry, and an operator SessionStart hook survives beside it', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [mine] } }, null, 2));
  await install(b.env());
  await stopFeeder(b.dir);
  await install(b.env());
  const s = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(s.hooks.SessionStart).toEqual([mine, HOOK_ENTRY]);
  expect(s.voice).toEqual({ enabled: true });
});

test('an operator who ran /voice off stays off: an existing voice key is kept verbatim (the hook is still merged)', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  const before = { voice: { enabled: false, mode: 'tap' } };
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify(before, null, 2));
  const res = await install(b.env());
  expect(res.stdout).toContain('settings=kept');
  const s = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(s.voice).toEqual(before.voice);
  expect(s.hooks).toEqual({ SessionStart: [HOOK_ENTRY] });
});

test('ensure.sh is a no-op while a feeder is alive and restarts one after it is gone', async () => {
  const b = await claudeBox();
  await install(b.env());
  const d = path.join(b.dir, '.tmuxifier-voice');
  let first = 0;
  for (let i = 0; i < 300 && !(first > 0 && alive(first)); i++) { first = await readPid(b.dir); await tick(10); }
  expect(alive(first)).toBe(true);
  await runShell(`sh "${path.join(d, 'ensure.sh')}"`, b.env());
  await tick(300);
  expect(await readPid(b.dir)).toBe(first);
  await stopFeeder(b.dir);
  expect(await fs.readlink(path.join(d, 'mic'))).toBe(path.join(d, 'mic.absent'));
  await runShell(`sh "${path.join(d, 'ensure.sh')}"`, b.env());
  let second = 0;
  for (let i = 0; i < 300; i++) {
    second = await readPid(b.dir);
    if (second > 0 && alive(second) && (await fs.readlink(path.join(d, 'mic')).catch(() => '')) === path.join(d, 'mic.fifo')) break;
    await tick(10);
  }
  expect(second).not.toBe(first);
  expect(alive(second)).toBe(true);
  expect(await fs.readlink(path.join(d, 'mic'))).toBe(path.join(d, 'mic.fifo'));
  await stopFeeder(b.dir);
});

test('malformed settings.json: merge parse failure is reported, device installed anyway', async () => {
  const b = await claudeBox();

  // Build a custom tools bin with node/python3/claude/essential-commands but NOT jq
  const toolsToLink = ['node', 'python3', 'claude', 'sh', 'mkdir', 'chmod', 'mkfifo', 'rm', 'mv', 'ln', 'echo', 'cat', 'grep', 'printf', 'setsid'];
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

  const res = await install({ HOME: b.dir, CLAUDE_CONFIG_DIR: b.cfg, PATH: customPath });
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
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=kept pipe=direct\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'kept', pipe: 'direct' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=applied pipe=rate\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'applied', pipe: 'rate' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=error-settings-parse\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'error-settings-parse' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-no-claude\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'no Claude on the box' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-asoundrc-exists\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'the box has its own ~/.asoundrc' });
  expect(await mk({ code: 1, stdout: '' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, error: 'voice link push failed' });
  let seen;
  await createVoiceLinkPusher({ runStdin: async (box, script, input) => { seen = { box, script, input }; return { code: 0, stdout: 'VOICELINK: applied settings=applied\n' }; } }).push({ id: 'b' });
  expect(seen.script).toBe(buildVoiceLinkInstallScript());
  expect(seen.input.length).toBe(0);
});

test('a v1.24.59 layout (mic -> /dev/zero) is re-pointed at the absent path', async () => {
  const b = await claudeBox();
  const d = path.join(b.dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', path.join(d, 'mic.fifo')]);
  await fs.symlink('/dev/zero', path.join(d, 'mic'));
  const res = await install(b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: applied');
  await expectIdleDevice(b.dir);
});

test('no python3 on the box: nothing is installed and the phase reports skipped', async () => {
  // The writer is a python3 program and nothing else can honour the
  // reader-hold rule, so a box without python3 gets no shadowing device at
  // all: a device with no safe writer is a hazard, not a feature.
  const b = await claudeBox();
  const res = await install({ ...b.env(), PATH: path.join(b.dir, 'bin') });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-no-python3');
  await expect(fs.access(path.join(b.dir, '.asoundrc'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(b.dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
});

test('pusher maps the no-python3 skip', async () => {
  const p = createVoiceLinkPusher({ runStdin: async () => ({ code: 0, stdout: 'VOICELINK: skipped-no-python3\n' }) });
  expect(await p.push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'no python3 on the box' });
});
