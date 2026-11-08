import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpencodePluginInstallScript, createOpencodePluginPusher } from '../src/server/opencodeAgentPlugin.js';

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

// A box with a fake executable `opencode` on PATH: the installer only asks
// `command -v opencode`, never runs it.
async function opencodeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocp-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
  expect([...vars].sort()).toEqual(['$', 'DIR', 'HOME', 'OPENCODE_CONFIG_DIR']);
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
  expect(await ok.push({ id: 'b' })).toEqual({ target: 'opencode-plugin', ok: true });
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
