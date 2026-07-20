import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceInstallStore } from '../src/server/voiceInstallStore.js';
import { createVoiceInstallManager } from '../src/server/voiceInstall.js';
import { createVoiceStore } from '../src/server/voiceStore.js';

let dataDir;
let repoRoot;
// The job store writes on a debounce, so a test that finishes while a write is
// still queued would have its temp dir recreated under the teardown rm
// (ENOTEMPTY). Track every store and flush it before deleting anything.
const openStores = [];
function trackStore(store) { openStores.push(store); return store; }

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vjobs-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vroot-'));
  openStores.length = 0;
});
afterEach(async () => {
  await Promise.all(openStores.map((s) => s.whenIdle().catch(() => {})));
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

// Injected command runner: records argv and returns scripted outcomes. The
// build step's existence check is satisfied by createBin() below, so a
// "successful" fake run has to actually produce the binary the manager looks
// for — otherwise the happy-path tests would pass against a manager that
// never verified anything.
function fakeRun(outcomes = {}, onCall) {
  const calls = [];
  const fn = async (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (onCall) await onCall(cmd, args);
    const key = Object.keys(outcomes).find((k) => cmd === k || args.includes(k));
    const o = key ? outcomes[key] : { code: 0 };
    if (o.code !== 0) throw new Error(o.stderr || `${cmd} exited ${o.code}`);
    return { code: 0, stdout: o.stdout || '' };
  };
  fn.calls = calls;
  return fn;
}

// The manager refuses to continue if whisper-server is missing after the
// build, so the fake build has to create it.
async function createBin(root) {
  const p = path.join(root, 'vendor', 'whisper', 'build', 'bin');
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, 'whisper-server'), '#!/bin/sh\n');
}

function makeManager(over = {}) {
  const store = trackStore(createVoiceInstallStore({ dataDir }));
  const voiceStore = createVoiceStore({ dataDir });
  const run = over.run || fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  return {
    voiceStore,
    run,
    mgr: createVoiceInstallManager({
      repoRoot,
      store,
      voiceStore,
      run,
      download: async () => ({ ok: true }),
      freeBytes: async () => 50 * 1024 ** 3,
      totalMem: () => 16 * 1024 ** 3,
      ...over,
    }),
  };
}

test('a successful install ends done and enables voice with the chosen model', async () => {
  const { mgr, voiceStore } = makeManager();
  const job = await mgr.start('base.en');
  expect(job.status).toBe('running');
  const settled = await mgr.whenSettled(job.id);
  expect(settled.status).toBe('done');
  expect(settled.model).toBe('base.en');
  // The install is what turns voice on — an operator should not have to flip a
  // second switch afterwards.
  expect(await voiceStore.read()).toEqual({ enabled: true, model: 'base.en' });
});

test('rejects a model outside the catalog before running anything', async () => {
  const { mgr, run } = makeManager();
  await expect(mgr.start('../../etc/passwd')).rejects.toThrow(/model/i);
  expect(run.calls).toEqual([]);
});

test('is single-flight: a second install while one runs is refused', async () => {
  const { mgr } = makeManager({ run: async () => new Promise(() => {}) }); // never settles
  const first = await mgr.start('base.en');
  await expect(mgr.start('base.en')).rejects.toThrow(/already/i);
  expect(mgr.current().id).toBe(first.id);
});

test('preflight refuses when the disk cannot hold the install', async () => {
  const run = fakeRun();
  const { mgr } = makeManager({ run, freeBytes: async () => 10 * 1024 * 1024 });
  const job = await mgr.start('base.en');
  const settled = await mgr.whenSettled(job.id);
  expect(settled.status).toBe('error');
  expect(settled.error).toMatch(/disk/i);
  // Failing early means nothing was installed or compiled.
  expect(run.calls).toEqual([]);
});

test('caps build parallelism on a small-memory host', async () => {
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run, totalMem: () => 4 * 1024 ** 3 });
  await mgr.whenSettled((await mgr.start('base.en')).id);
  const build = run.calls.find((c) => c.includes('--build'));
  // whisper.cpp translation units run ~1 GB each; -j4 OOMs a 4 GB container.
  expect(build[build.indexOf('-j') + 1]).toBe('2');
});

test('skips apt when cmake is already present', async () => {
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(run.calls.some((c) => c[0] === 'apt-get')).toBe(false);
});

test('installs cmake when it is missing', async () => {
  // `cmake --version` throwing is how the manager detects absence.
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--version')) throw new Error('not found');
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('done');
  const apt = run.calls.find((c) => c[0] === 'apt-get');
  // Hardcoded package name — never a caller-supplied value.
  expect(apt).toEqual(['apt-get', 'install', '-y', 'cmake']);
});

test('uses the pinned repo and tag, never a branch', async () => {
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  await mgr.whenSettled((await mgr.start('base.en')).id);
  const clone = run.calls.find((c) => c.includes('clone'));
  expect(clone).toContain('https://github.com/ggerganov/whisper.cpp.git');
  expect(clone.join(' ')).toMatch(/--branch v\d+\.\d+\.\d+/);
});

test('a failed download leaves the job in error and voice untouched', async () => {
  const { mgr, voiceStore } = makeManager({
    download: async () => { throw new Error('integrity check failed'); },
  });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('error');
  expect(settled.error).toMatch(/integrity/i);
  expect(await voiceStore.read()).toEqual({ enabled: false, model: 'small.en' });
});

test('a build that does not produce the binary fails rather than reporting success', async () => {
  // No createBin() — the fake "succeeds" but leaves nothing behind.
  const { mgr } = makeManager({ run: fakeRun() });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('error');
  expect(settled.error).toMatch(/whisper-server/i);
});

test('the log is capped so a noisy build cannot grow unbounded', async () => {
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  // Every command returns 5 KB of output.
  const noisy = async (cmd, args) => { await run(cmd, args); return { code: 0, stdout: 'x'.repeat(5000) }; };
  const { mgr } = makeManager({ run: noisy, maxLogBytes: 1000 });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.log.length).toBeLessThanOrEqual(1000);
});

test('a job left running by a restart reconciles to interrupted', async () => {
  const store = trackStore(createVoiceInstallStore({ dataDir }));
  store.save([{ id: 'j1', model: 'base.en', status: 'running', phase: 'build', log: '', createdAt: 1 }]);
  await store.whenIdle();
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const mgr = createVoiceInstallManager({
    repoRoot, store, voiceStore: createVoiceStore({ dataDir }),
    run, download: async () => ({ ok: true }),
    freeBytes: async () => 50 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3,
  });
  expect(mgr.getJob('j1').status).toBe('interrupted');
  // An interrupted job must not block a fresh install.
  await expect(mgr.start('base.en')).resolves.toMatchObject({ status: 'running' });
});
