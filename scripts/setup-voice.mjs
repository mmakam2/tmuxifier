#!/usr/bin/env node
// Build whisper.cpp into the repo-local vendor/ directory and download a model,
// then record both paths in .env. This is the stage-1, command-line half of
// voice setup; stage 2 adds the same flow behind a Settings tab.
//
// Self-contained per the repo principle: everything lands under the repo
// folder, nothing in $HOME.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveModel, MODEL_IDS, DEFAULT_MODEL_ID, WHISPER_REPO, WHISPER_REF } from '../src/server/voiceCatalog.js';
import { createVoiceStore } from '../src/server/voiceStore.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(repoRoot, 'vendor', 'whisper');
const modelsDir = path.join(vendorDir, 'models');
const binPath = path.join(vendorDir, 'build', 'bin', 'whisper-server');

const modelId = process.argv[2] || DEFAULT_MODEL_ID;
const model = resolveModel(modelId);
if (!model) {
  console.error(`Unknown model '${modelId}'. Available: ${MODEL_IDS.join(', ')}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.error(`+ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`\nFailed: ${cmd} exited ${res.status}`);
    process.exit(res.status || 1);
  }
}

// Preflight: fail early with a real number rather than dying mid-build.
const REQUIRED_BYTES = model.bytes + 700 * 1024 * 1024; // model + source + build output
const stat = fs.statfsSync(repoRoot);
const freeBytes = stat.bavail * stat.bsize;
if (freeBytes < REQUIRED_BYTES) {
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  console.error(`Not enough disk: need ~${gb(REQUIRED_BYTES)} GB, have ${gb(freeBytes)} GB free.`);
  process.exit(1);
}

// `.status` is null when the binary is absent entirely, so !== 0 covers both
// "not installed" and "installed but broken". Note `!x === 0` would be a bug:
// it parses as `(!x) === 0`, which is never true.
if (spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('cmake not found — installing it (requires root).');
  run('apt-get', ['install', '-y', 'cmake'], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
}

if (!fs.existsSync(path.join(vendorDir, '.git'))) {
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_REF, WHISPER_REPO, vendorDir]);
} else {
  run('git', ['-C', vendorDir, 'fetch', '--depth', '1', 'origin', 'tag', WHISPER_REF]);
  run('git', ['-C', vendorDir, 'checkout', WHISPER_REF]);
}

// whisper.cpp translation units peak around 1 GB each; -j4 in a 4 GB container
// OOMs mid-build, so parallelism is capped by available RAM as well as cores.
const ramGb = os.totalmem() / 1024 ** 3;
const jobs = Math.max(1, Math.min(os.cpus().length || 1, 4, ramGb < 6 ? 2 : 4));
run('cmake', ['-B', path.join(vendorDir, 'build'), '-S', vendorDir, '-DCMAKE_BUILD_TYPE=Release']);
run('cmake', ['--build', path.join(vendorDir, 'build'), '--config', 'Release', '-j', String(jobs), '--target', 'whisper-server']);

if (!fs.existsSync(binPath)) {
  console.error(`Build finished but ${binPath} is missing.`);
  process.exit(1);
}

// Download to a temp path, verify, and only then rename into place: a killed
// download must never leave a truncated file that the server would later mmap.
fs.mkdirSync(modelsDir, { recursive: true });
const finalModel = path.join(modelsDir, model.file);
if (!fs.existsSync(finalModel)) {
  const tmp = `${finalModel}.part`;
  console.error(`+ downloading ${model.file} (${(model.bytes / 1024 ** 2).toFixed(0)} MB)`);
  const res = await fetch(model.url);
  if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== model.sha256) {
    console.error(`Integrity check failed for ${model.file}.`);
    console.error(`  expected ${model.sha256}`);
    console.error(`  got      ${digest}`);
    process.exit(1);
  }
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, finalModel);
}

// data/voice.json is authoritative, and is read per request — so this applies
// without a restart and stays in step with Settings -> Voice. Writing
// TMUXIFIER_WHISPER_* into .env instead would PIN the paths, making the
// Settings model picker inert (.env wins, and is only parsed at boot).
await createVoiceStore({ dataDir: path.join(repoRoot, 'data') }).update({ enabled: true, model: modelId });

console.error('\nVoice dictation installed and enabled.');
console.error(`  binary ${binPath}`);
console.error(`  model  ${finalModel}`);
console.error('\nRestart Tmuxifier, then tap Ctrl+Shift+Space in a terminal to start dictating and tap it again to stop.');
