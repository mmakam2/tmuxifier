import { test, expect } from 'vitest';
import path from 'node:path';
import { createApkBuildManager } from '../src/server/apkBuild.js';

const ROOT = '/repo';
const memStore = (initial = []) => {
  let data = initial;
  return { load: () => data, save: (v) => { data = v; }, whenIdle: async () => {} };
};

function fakeFs({ gradlew = true, localProps = true, keystore = true, output = true } = {}) {
  const copies = [];
  const made = [];
  return {
    copies,
    made,
    exists: (p) => {
      if (p.endsWith('android/gradlew')) return gradlew;
      if (p.endsWith('android/local.properties')) return localProps;
      if (p.endsWith('android/keystore.properties')) return keystore;
      if (p.includes('/outputs/apk/')) return output;
      return false;
    },
    copy: (from, to) => copies.push([from, to]),
    mkdir: (p) => made.push(p),
  };
}

test('release build: gradle assembleRelease, output published to data/app', async () => {
  const calls = [];
  const fs = fakeFs();
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store: memStore(),
    run: async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts?.cwd }); return { code: 0, stdout: 'BUILD SUCCESSFUL\n' }; },
    exists: fs.exists, copy: fs.copy, mkdir: fs.mkdir, now: () => 1000,
  });
  const started = await m.start();
  expect(started.status).toBe('running');
  const done = await m.whenSettled(started.id);
  expect(done.status).toBe('done');
  expect(done.variant).toBe('release');
  expect(calls[0].cmd).toBe(path.join(ROOT, 'android', 'gradlew'));
  expect(calls[0].args).toContain('assembleRelease');
  expect(calls[0].args).toContain('--no-daemon');
  expect(fs.copies).toEqual([[
    path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(ROOT, 'data', 'app', 'tmuxifier-console.apk'),
  ]]);
});

test('no keystore.properties falls back to a debug build', async () => {
  const fs = fakeFs({ keystore: false });
  const calls = [];
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store: memStore(),
    run: async (cmd, args) => { calls.push(args); return { code: 0, stdout: '' }; },
    exists: fs.exists, copy: fs.copy, mkdir: fs.mkdir, now: () => 1000,
  });
  const done = await m.whenSettled((await m.start()).id);
  expect(done.variant).toBe('debug');
  expect(calls[0]).toContain('assembleDebug');
  expect(fs.copies[0][0]).toContain(path.join('apk', 'debug', 'app-debug.apk'));
});

test('missing toolchain fails in preflight with a plain message', async () => {
  const fs = fakeFs({ gradlew: false });
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store: memStore(),
    run: async () => ({ code: 0, stdout: '' }),
    exists: fs.exists, copy: fs.copy, mkdir: fs.mkdir, now: () => 1000,
  });
  const done = await m.whenSettled((await m.start()).id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/gradlew/);
});

test('a build that exits 0 without producing the APK is an error, not success', async () => {
  const fs = fakeFs({ output: false });
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store: memStore(),
    run: async () => ({ code: 0, stdout: '' }),
    exists: fs.exists, copy: fs.copy, mkdir: fs.mkdir, now: () => 1000,
  });
  const done = await m.whenSettled((await m.start()).id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/missing/);
});

test('single-flight: a second start while running is refused', async () => {
  const fs = fakeFs();
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store: memStore(),
    run: async () => { await gate; return { code: 0, stdout: '' }; },
    exists: fs.exists, copy: fs.copy, mkdir: fs.mkdir, now: () => 1000,
  });
  const first = await m.start();
  await expect(m.start()).rejects.toThrow(/already running/);
  release();
  await m.whenSettled(first.id);
});

test('a running job from a dead process reloads as interrupted', () => {
  const store = memStore([{ id: 'ab-1', status: 'running', log: '', createdAt: 1 }]);
  const m = createApkBuildManager({
    repoRoot: ROOT, dataDir: path.join(ROOT, 'data'), store,
    run: async () => ({ code: 0, stdout: '' }),
    exists: () => true, copy: () => {}, mkdir: () => {}, now: () => 1000,
  });
  expect(m.current().status).toBe('interrupted');
});
