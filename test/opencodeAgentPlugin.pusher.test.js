import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpencodePluginInstallScript, createOpencodePluginPusher, OPENCODE_MAIL_MIN } from '../src/server/opencodeAgentPlugin.js';
import { OPENCODE_MAIL_MIN as ASSET_MAIL_MIN } from '../src/server/assets/tmuxifier-opencode-agent.js';

const OPENCODE_MAIL_NOTE = 'agent messaging needs OpenCode 2.3.0 or later';
const ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-opencode-agent.js', import.meta.url));

// Run the installer under a real /bin/sh with a controlled env, stdin carrying
// the plugin bytes exactly as execScriptStdin delivers them.
// `stdinError` records an EPIPE: a script that exits without reading its
// stdin breaks the pipe under a writer with more than a pipe buffer to send.
function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    let stdinError = null;
    const child = execFile('/bin/sh', ['-c', script], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr, stdinError });
    });
    child.stdin.on('error', (e) => { stdinError = e.code || String(e); });
    child.stdin.end(stdin ?? '');
  });
}

// A box with a fake executable `opencode` on PATH. `script` is what it is: by default it
// prints nothing (the installer asks it for `--version`); the real binary prints `opencode v2.3.0`.
async function opencodeBox(script = '#!/bin/sh\nexit 0\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'opencode'), script, { mode: 0o755 });
  return { dir, env: (extra = {}) => ({ HOME: dir, PATH: `${bin}:/usr/bin:/bin`, ...extra }) };
}

const pluginPath = (cfg) => path.join(cfg, 'plugins', 'tmuxifier-agent.js');

test('the install script interpolates nothing and reads the plugin from stdin', async () => {
  const s = buildOpencodePluginInstallScript();
  const asset = await fs.readFile(ASSET, 'utf8');
  // None of the asset's own text is baked into the script: the bytes travel on stdin.
  const firstLine = asset.split('\n').find((l) => l.trim().length > 20);
  expect(s).not.toContain(firstLine);
  expect(s.length).toBeLessThan(asset.length);
  expect(s).toContain('set -eu');
  expect(s).toContain('DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"');
  expect(s).toContain('command -v opencode');
  expect(s).toContain('[ ! -x "$HOME/.opencode/bin/opencode" ]');
  // The only expansions are the box's own environment, never a caller value.
  const vars = new Set([...s.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*|\$)/g)].map((m) => m[1]));
  expect([...vars].sort()).toEqual(['$', 'CFG', 'DIR', 'HOME', 'OCBIN', 'OCV', 'OPENCODE_CONFIG_DIR', 'RAN', 'VF']);
  expect(s).toContain('OPENCODEPLUGIN: skipped-no-opencode');
  expect(s).toContain('OPENCODEPLUGIN: applied');
  expect(s).toContain('cat > "$DIR/tmuxifier-agent.js.$$.tmp"');
  expect(s).toContain('mv -f');
  expect(buildOpencodePluginInstallScript()).toBe(s);
});

test('without opencode on the box the script drains stdin, prints skipped-no-opencode, writes nothing, exits 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  // Large enough that an undrained pipe would EPIPE/hang the writer.
  const big = 'x'.repeat(256 * 1024);
  const res = await runShell(buildOpencodePluginInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' }, big);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('OPENCODEPLUGIN: skipped-no-opencode');
  expect(res.stdout).not.toContain('OPENCODEPLUGIN: applied');
  expect(res.stdinError).toBe(null);
  await expect(fs.access(path.join(dir, '.config'))).rejects.toBeTruthy();
});

test('with opencode present the plugin lands at <config>/plugins/tmuxifier-agent.js, mode 0644, byte-identical, and a rerun is idempotent', async () => {
  const b = await opencodeBox();
  const bytes = await fs.readFile(ASSET);
  const cfg = path.join(b.dir, '.config', 'opencode');
  const first = await runShell(buildOpencodePluginInstallScript(), b.env(), bytes);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain('OPENCODEPLUGIN: applied');
  const target = pluginPath(cfg);
  expect(Buffer.compare(await fs.readFile(target), bytes)).toBe(0);
  expect((await fs.stat(target)).mode & 0o777).toBe(0o644);

  const second = await runShell(buildOpencodePluginInstallScript(), b.env(), bytes);
  expect(second.code).toBe(0);
  expect(second.stdout).toContain('OPENCODEPLUGIN: applied');
  expect(Buffer.compare(await fs.readFile(target), bytes)).toBe(0);
  // No temp file is left behind, and nothing else appears beside the plugin.
  expect(await fs.readdir(path.join(cfg, 'plugins'))).toEqual(['tmuxifier-agent.js']);
});

test('the native-installer location counts as opencode present even off PATH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  await fs.mkdir(path.join(dir, '.opencode', 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.opencode', 'bin', 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  const res = await runShell(buildOpencodePluginInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' }, 'PLUGIN');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('OPENCODEPLUGIN: applied');
  expect(await fs.readFile(pluginPath(path.join(dir, '.config', 'opencode')), 'utf8')).toBe('PLUGIN');
});

test('OPENCODE_CONFIG_DIR overrides the target directory', async () => {
  const b = await opencodeBox();
  const custom = path.join(b.dir, 'custom-oc');
  const res = await runShell(buildOpencodePluginInstallScript(), b.env({ OPENCODE_CONFIG_DIR: custom }), 'PLUGIN-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('OPENCODEPLUGIN: applied');
  expect(await fs.readFile(pluginPath(custom), 'utf8')).toBe('PLUGIN-BYTES');
  await expect(fs.access(path.join(b.dir, '.config'))).rejects.toBeTruthy();
});

test('createOpencodePluginPusher maps applied, skipped and failures without throwing', async () => {
  let piped = null;
  let script = null;
  const ok = createOpencodePluginPusher({
    runStdin: async (_box, s, input) => { script = s; piped = input; return { code: 0, stdout: 'OPENCODEPLUGIN: applied\n' }; },
    readAsset: async () => Buffer.from('ASSET-BYTES'),
  });
  // A box that printed no version at all cannot be told to be new enough for messaging.
  expect(await ok.push({ id: 'b' })).toEqual({ target: 'opencode-plugin', ok: true, note: OPENCODE_MAIL_NOTE });
  expect(piped.toString()).toBe('ASSET-BYTES');
  expect(script).toBe(buildOpencodePluginInstallScript());

  const skip = createOpencodePluginPusher({
    runStdin: async () => ({ code: 0, stdout: 'OPENCODEPLUGIN: skipped-no-opencode\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await skip.push({ id: 'b' })).toEqual({ target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' });

  const FAILED = { target: 'opencode-plugin', ok: false, error: 'opencode plugin push failed' };
  const nonZero = createOpencodePluginPusher({
    runStdin: async () => ({ code: 1, stdout: 'OPENCODEPLUGIN: applied\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await nonZero.push({ id: 'b' })).toEqual(FAILED);
  const noMarker = createOpencodePluginPusher({
    runStdin: async () => ({ code: 0, stdout: 'something else\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await noMarker.push({ id: 'b' })).toEqual(FAILED);
  const rejects = createOpencodePluginPusher({
    runStdin: async () => { throw new Error('ssh died'); },
    readAsset: async () => Buffer.from('A'),
  });
  expect(await rejects.push({ id: 'b' })).toEqual(FAILED);

  let ran = false;
  const noAsset = createOpencodePluginPusher({
    runStdin: async () => { ran = true; return { code: 0, stdout: 'OPENCODEPLUGIN: applied\n' }; },
    readAsset: async () => { throw new Error('ENOENT'); },
  });
  expect(await noAsset.push({ id: 'b' })).toEqual({ target: 'opencode-plugin', ok: false, error: 'opencode plugin asset unavailable' });
  expect(ran).toBe(false);
});

// --- OpenCode version (design 6.8, ruling R2) --------------------------------------------------

const fakeOpencode = (out) => `#!/bin/sh\n${out === null ? 'exit 0' : `printf '%s\\n' '${out}'`}\n`;
const versionLine = (stdout) => stdout.split('\n').filter((l) => l.startsWith('OPENCODEPLUGIN: version'));

test('OPENCODE_MAIL_MIN is 2.3.0 and equals the asset\'s own export, which cannot import repo code', () => {
  expect(OPENCODE_MAIL_MIN).toBe('2.3.0');
  expect(ASSET_MAIL_MIN).toBe(OPENCODE_MAIL_MIN);
});

test('the script prints the version OpenCode reports, digits and dots only, under sh, bash and zsh', async () => {
  const cases = [
    ['opencode v2.3.0', '2.3.0'],
    ['opencode v2.2.6', '2.2.6'],
    ['2.10.1', '2.10.1'],
    ['opencode v2.4.0-beta.1 (build $(touch pwned))', '2.4.0'],
  ];
  for (const shell of ['/bin/sh', '/usr/bin/bash', '/usr/bin/zsh']) {
    for (const [out, want] of cases) {
      const b = await opencodeBox(fakeOpencode(out));
      const res = await new Promise((resolve) => {
        const child = execFile(shell, ['-c', buildOpencodePluginInstallScript()], { env: b.env() }, (err, stdout, stderr) => {
          resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
        });
        child.stdin.end('PLUGIN');
      });
      expect(res.code, `${shell} ${out} ${res.stderr}`).toBe(0);
      expect(versionLine(res.stdout), `${shell} ${out}`).toEqual([`OPENCODEPLUGIN: version ${want}`]);
      expect(res.stdout, `${shell} ${out}`).toContain('OPENCODEPLUGIN: applied');
      // The plugin still lands, and nothing the version run left stays in the plugins dir.
      expect(await fs.readdir(path.join(b.dir, '.config', 'opencode', 'plugins')), `${shell} ${out}`).toEqual(['tmuxifier-agent.js']);
      expect((await fs.readdir(path.join(b.dir, '.config', 'opencode'))).sort(), `${shell} ${out}`).toEqual(['plugins']);
    }
  }
});

test('an OpenCode that prints no version or fails prints no version line and the plugin still lands', async () => {
  const bins = {
    silent: fakeOpencode(null),
    'no digits': fakeOpencode('opencode dev'),
    failing: '#!/bin/sh\necho opencode v2.3.0\nexit 3\n',
  };
  for (const [label, script] of Object.entries(bins)) {
    const b = await opencodeBox(script);
    const res = await runShell(buildOpencodePluginInstallScript(), b.env(), 'PLUGIN');
    expect(res.code, label).toBe(0);
    expect(res.stdout, label).toContain('OPENCODEPLUGIN: applied');
    // A failing run's output is not trusted either.
    expect(versionLine(res.stdout), label).toEqual([]);
    expect(await fs.readFile(pluginPath(path.join(b.dir, '.config', 'opencode')), 'utf8'), label).toBe('PLUGIN');
  }
});

test('an OpenCode whose --version hangs is cut off: no version line, the plugin still lands', async () => {
  const b = await opencodeBox('#!/bin/sh\nexec sleep 60\n');
  const started = Date.now();
  const res = await runShell(buildOpencodePluginInstallScript(), b.env(), 'PLUGIN');
  expect(Date.now() - started).toBeLessThan(30000);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('OPENCODEPLUGIN: applied');
  expect(versionLine(res.stdout)).toEqual([]);
  expect(await fs.readFile(pluginPath(path.join(b.dir, '.config', 'opencode')), 'utf8')).toBe('PLUGIN');
}, 40000);

test('an OpenCode whose --version ignores TERM is KILLed shortly after the cut-off', async () => {
  // The ignored disposition survives exec, so `sleep` ignores TERM too: only a KILL ends it.
  const b = await opencodeBox("#!/bin/sh\ntrap '' TERM\nexec sleep 60\n");
  const started = Date.now();
  const res = await runShell(buildOpencodePluginInstallScript(), b.env(), 'PLUGIN');
  expect(Date.now() - started).toBeLessThan(25000);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('OPENCODEPLUGIN: applied');
  expect(versionLine(res.stdout)).toEqual([]);
}, 40000);

test('a `timeout` that refuses -k gets the plain form, and the version is still read once', async () => {
  const b = await opencodeBox('#!/bin/sh\necho run >> "$HOME/runs"\necho opencode v2.3.0\n');
  const bin = path.join(b.dir, 'bin');
  // An old timeout: no -k (exit 125, as a usage error), otherwise the real one.
  const realTimeout = (await new Promise((r) => execFile('/bin/sh', ['-c', 'command -v timeout'], (e, o) => r(o)))).trim();
  await fs.writeFile(path.join(bin, 'timeout'), `#!/bin/sh\n[ "$1" = -k ] && exit 125\nexec ${realTimeout} "$@"\n`, { mode: 0o755 });
  const res = await runShell(buildOpencodePluginInstallScript(), b.env(), 'PLUGIN');
  expect(res.code, res.stderr).toBe(0);
  expect(versionLine(res.stdout)).toEqual(['OPENCODEPLUGIN: version 2.3.0']);
  expect(await fs.readFile(path.join(b.dir, 'runs'), 'utf8')).toBe('run\n');
  // And with -k understood, it also runs exactly once.
  const c = await opencodeBox('#!/bin/sh\necho run >> "$HOME/runs"\necho opencode v2.3.0\n');
  const res2 = await runShell(buildOpencodePluginInstallScript(), c.env(), 'PLUGIN');
  expect(versionLine(res2.stdout)).toEqual(['OPENCODEPLUGIN: version 2.3.0']);
  expect(await fs.readFile(path.join(c.dir, 'runs'), 'utf8')).toBe('run\n');
});

test('the native-installer location is asked for its version too', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  await fs.mkdir(path.join(dir, '.opencode', 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.opencode', 'bin', 'opencode'), fakeOpencode('opencode v2.3.0'), { mode: 0o755 });
  const res = await runShell(buildOpencodePluginInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' }, 'PLUGIN');
  expect(res.code).toBe(0);
  expect(versionLine(res.stdout)).toEqual(['OPENCODEPLUGIN: version 2.3.0']);
});

test('no OpenCode: no version line either', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  const res = await runShell(buildOpencodePluginInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' }, 'x');
  expect(versionLine(res.stdout)).toEqual([]);
});

test('the pusher adds the messaging note below 2.3.0 or without a version, and not from 2.3.0 on', async () => {
  const push = (stdout) => createOpencodePluginPusher({
    runStdin: async () => ({ code: 0, stdout }),
    readAsset: async () => Buffer.from('A'),
  }).push({ id: 'b' });
  const OK = { target: 'opencode-plugin', ok: true };
  const NOTE = { ...OK, note: OPENCODE_MAIL_NOTE };
  expect(await push('OPENCODEPLUGIN: version 2.2.6\nOPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  expect(await push('OPENCODEPLUGIN: version 2.3.0\nOPENCODEPLUGIN: applied\n')).toEqual(OK);
  expect(await push('OPENCODEPLUGIN: version 2.3.1\nOPENCODEPLUGIN: applied\n')).toEqual(OK);
  expect(await push('OPENCODEPLUGIN: version 2.10.1\nOPENCODEPLUGIN: applied\n')).toEqual(OK);
  expect(await push('OPENCODEPLUGIN: version 3\nOPENCODEPLUGIN: applied\n')).toEqual(OK);
  expect(await push('OPENCODEPLUGIN: version 2.3\nOPENCODEPLUGIN: applied\n')).toEqual(OK);
  expect(await push('OPENCODEPLUGIN: version 1.99.99\nOPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  expect(await push('OPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  // Box output is untrusted: only a plain dotted number counts.
  expect(await push('OPENCODEPLUGIN: version 9.0.0; rm -rf /\nOPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  expect(await push('OPENCODEPLUGIN: version 99999999999.0.0\nOPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  expect(await push('OPENCODEPLUGIN: version vX\nOPENCODEPLUGIN: applied\n')).toEqual(NOTE);
  // A skip or a failure carries no note.
  expect(await push('OPENCODEPLUGIN: skipped-no-opencode\n')).toEqual({ target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' });
});
