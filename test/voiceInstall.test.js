import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createVoiceInstallStore } from '../src/server/voiceInstallStore.js';
import { createVoiceInstallManager } from '../src/server/voiceInstall.js';
import { createVoiceStore } from '../src/server/voiceStore.js';
import { WHISPER_COMMIT, WHISPER_REF, WHISPER_REPO } from '../src/server/voiceCatalog.js';

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
// never verified anything. Likewise `git rev-parse HEAD` answers with the
// pinned commit by default, so only a test that scripts a different answer
// exercises the refusal.
function fakeRun(outcomes = {}, onCall) {
  const calls = [];
  const fn = async (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (onCall) await onCall(cmd, args);
    const key = Object.keys(outcomes).find((k) => cmd === k || args.includes(k));
    const fallback = cmd === 'git' && args.includes('rev-parse')
      ? { code: 0, stdout: `${WHISPER_COMMIT}\n` }
      : { code: 0 };
    const o = key ? outcomes[key] : fallback;
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

// F9: a git tag can be force-moved upstream, so cloning `--branch v1.9.1`
// alone is not a pin. The checkout must resolve to the recorded commit before
// anything is configured or compiled (and later run as the service user).
const MOVED_TAG = '0123456789abcdef0123456789abcdef01234567';

function buildCalls(run) {
  return run.calls.filter((c) => c[0] === 'cmake' && (c.includes('-B') || c.includes('--build')));
}

test('a fresh clone at the pinned commit is verified before it is built', async () => {
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('done');
  const vendor = path.join(repoRoot, 'vendor', 'whisper');
  const revParse = run.calls.findIndex((c) => c[0] === 'git' && c.includes('rev-parse'));
  expect(run.calls[revParse]).toEqual(['git', '-C', vendor, 'rev-parse', 'HEAD']);
  const clone = run.calls.findIndex((c) => c[0] === 'git' && c.includes('clone'));
  const configure = run.calls.findIndex((c) => c[0] === 'cmake' && c.includes('-B'));
  expect(clone).toBeGreaterThanOrEqual(0);
  expect(revParse).toBeGreaterThan(clone);
  expect(configure).toBeGreaterThan(revParse);
});

test('a clone whose tag resolves to a different commit is refused and never built', async () => {
  const run = fakeRun({ 'rev-parse': { code: 0, stdout: `${MOVED_TAG}\n` } }, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr, voiceStore } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('error');
  expect(settled.error).toContain(WHISPER_COMMIT);
  expect(settled.error).toContain(MOVED_TAG);
  expect(settled.error).toMatch(/refusing to build/i);
  expect(buildCalls(run)).toEqual([]);
  expect(await voiceStore.read()).toEqual({ enabled: false, model: 'small.en' });
});

test('an existing checkout is re-verified after fetch/checkout and refused on a mismatch', async () => {
  const vendor = path.join(repoRoot, 'vendor', 'whisper');
  await fs.mkdir(path.join(vendor, '.git'), { recursive: true });
  const run = fakeRun({ 'rev-parse': { code: 0, stdout: `${MOVED_TAG}\n` } }, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('error');
  expect(settled.error).toMatch(/refusing to build/i);
  const checkout = run.calls.findIndex((c) => c[0] === 'git' && c.includes('checkout'));
  const revParse = run.calls.findIndex((c) => c[0] === 'git' && c.includes('rev-parse'));
  expect(checkout).toBeGreaterThanOrEqual(0);
  expect(revParse).toBeGreaterThan(checkout);
  expect(run.calls.some((c) => c.includes('clone'))).toBe(false);
  expect(buildCalls(run)).toEqual([]);
});

test('an existing checkout at the pinned commit still builds', async () => {
  await fs.mkdir(path.join(repoRoot, 'vendor', 'whisper', '.git'), { recursive: true });
  const run = fakeRun({}, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('done');
  expect(buildCalls(run).length).toBe(2);
});

test('a commit check that cannot run fails closed rather than building', async () => {
  const run = fakeRun({ 'rev-parse': { code: 128, stderr: 'fatal: not a git repository' } }, async (cmd, args) => {
    if (cmd === 'cmake' && args.includes('--build')) await createBin(repoRoot);
  });
  const { mgr } = makeManager({ run });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.status).toBe('error');
  expect(buildCalls(run)).toEqual([]);
});

test('with real git, a tag moved to another commit is refused before cmake runs', async () => {
  // A local "upstream" whose WHISPER_REF tag names some other commit. git runs
  // for real (clone over file:// so --depth applies, then rev-parse); only the
  // repo URL is redirected and cmake stays fake.
  const upstream = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vupstream-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    const git = (...a) => execFileSync('git', a, { cwd: upstream, env, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'moved tag');
    git('tag', WHISPER_REF);
    const moved = git('rev-parse', 'HEAD').trim();
    const execFileP = promisify(execFile);
    const calls = [];
    const run = async (cmd, args = []) => {
      calls.push([cmd, ...args]);
      if (cmd !== 'git') return { code: 0, stdout: '' };
      const real = args.map((a) => (a === WHISPER_REPO ? `file://${upstream}` : a));
      const { stdout, stderr } = await execFileP('git', real, { env });
      return { code: 0, stdout: String(stdout) + String(stderr) };
    };
    run.calls = calls;
    const { mgr } = makeManager({ run });
    const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
    expect(settled.status).toBe('error');
    expect(settled.error).toContain(moved);
    expect(settled.error).toMatch(/refusing to build/i);
    expect(calls.some((c) => c[0] === 'git' && c.includes('rev-parse'))).toBe(true);
    expect(buildCalls(run)).toEqual([]);
  } finally {
    await fs.rm(upstream, { recursive: true, force: true });
  }
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
  // Every command returns 5 KB of output (except the commit check, which must
  // still see the pinned commit for the run to reach the build).
  const noisy = async (cmd, args) => {
    const r = await run(cmd, args);
    return args.includes('rev-parse') ? r : { code: 0, stdout: 'x'.repeat(5000) };
  };
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

// B10 (2026-07-29 review): the reconciliation map dereferenced j.status with no
// shape guard, so a `[null]` row in voice-jobs.json threw a TypeError inside
// createVoiceInstallManager — at index.js module top level, i.e. the whole
// dashboard failed to boot. fleet.js and setupManager.js both guard this.
test('a malformed persisted job row is dropped instead of crashing boot', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vi-bad-'));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vi-badrepo-'));
  const store = createVoiceInstallStore({ dataDir });
  store.save([null, 'nope', 42, { noId: true }, { id: 'j1', model: 'base.en', status: 'running', createdAt: 1, log: '', error: null }]);
  await store.whenIdle();

  let mgr;
  expect(() => {
    mgr = createVoiceInstallManager({
      repoRoot, store, voiceStore: createVoiceStore({ dataDir }),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      download: async () => ({ ok: true }),
      freeBytes: async () => 50 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3,
    });
  }).not.toThrow();
  expect(mgr.listJobs().map((j) => j.id)).toEqual(['j1']);
  expect(mgr.getJob('j1').status).toBe('interrupted');
});
