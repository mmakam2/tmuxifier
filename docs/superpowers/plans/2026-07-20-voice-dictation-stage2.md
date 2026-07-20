# Voice Dictation — Stage 2 (Install Job + Settings Tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator install, enable, and choose a voice-dictation model entirely from the browser, instead of running a shell script and editing `.env`.

**Architecture:** `data/voice.json` becomes the authoritative record of whether voice is on and which model is selected — it is read per request, so changes apply immediately, whereas `.env` is parsed once at boot. A persisted, pollable install-job manager (mirroring the existing `setupManager`) runs apt → clone → build → download → verify as a single-flight background job with a streaming capped log. A sixth Settings tab drives all of it.

**Tech Stack:** Node 20+ ESM, Fastify, vitest, whisper.cpp, TypeScript + Vite on the client.

**Spec:** `docs/superpowers/specs/2026-07-20-voice-dictation-design.md` (see the "Amendment (stage 2 planning)" block for the path-resolution decision this plan implements).

**Stage 1 is already shipped, deployed, and running.** Do not re-implement any of it. The following already exist and are tested: `voiceText.js`, `voiceCatalog.js`, `voiceEngine.js`, `POST /api/voice`, `wavEncode.ts`, `voiceRecorder.ts`, `voiceUi.ts`, `voiceWorklet.js`, and `scripts/setup-voice.mjs`.

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+.
- Server code is plain `.js`; web client code is `.ts`. **Test files are plain-JavaScript `.test.js`** — `vitest.config.js` uses `include: ['test/**/*.test.js']`, so a `.test.ts` file is invisible to the runner even when passed as an explicit path.
- TDD: the failing test is written and *run* before the implementation, every task.
- Tests use real code, not mocks. Dependencies are injected via factory-function parameters.
- **No new runtime dependencies.** The project deliberately runs on 5.
- New persisted files are written `0o600` via `jsonFile.js`, and land under the repo folder.
- `loadConfig` stays pure and injectable — never read `process.env`/`process.cwd()` inside it or its tests.
- Conventional-commit messages (`feat(voice): …`).
- The repo is public: no real domains, IPs, hostnames, or emails. Use `example.com` and RFC1918 addresses.
- `npm test` runs `tsc --noEmit` before vitest — TypeScript must typecheck clean at every commit.
- **`voiceCatalog.js` is the security chokepoint and must remain so.** Every value reaching apt, git, a compiler, or a network fetch is either a hardcoded constant or resolved through `resolveModel(id)`. No caller-supplied URL or path may reach a download. Every model carries a pinned SHA-256 verified *before* the file is renamed into place.

---

### Task 1: Path resolution (`voicePaths.js`)

Pure module deciding which binary and model are in effect and whether voice is usable. Extracted from `config.js` deliberately: the precedence rules are the subtlest part of stage 2 and deserve their own unit tests.

**Files:**
- Create: `src/server/voicePaths.js`
- Test: `test/voicePaths.test.js`

**Interfaces:**
- Consumes: `resolveModel`, `DEFAULT_MODEL_ID` from `src/server/voiceCatalog.js` (stage 1).
- Produces:
  - `VENDOR_DIR = 'vendor/whisper'`, `vendorBinPath(repoRoot)`, `vendorModelPath(repoRoot, file)`
  - `resolveVoicePaths({ repoRoot, config, settings, exists }) => { bin, model, enabled, pinned: { bin: 'env'|'vendor'|null, model: 'env'|'store'|null } }`

- [ ] **Step 1: Write the failing test**

Create `test/voicePaths.test.js`:

```js
import { test, expect } from 'vitest';
import { resolveVoicePaths, vendorBinPath, vendorModelPath, VENDOR_DIR } from '../src/server/voicePaths.js';
import { DEFAULT_MODEL_ID } from '../src/server/voiceCatalog.js';

const ROOT = '/repo';
const BIN = vendorBinPath(ROOT);
const MODEL = vendorModelPath(ROOT, 'ggml-small.en.bin');

// `exists` is injected so these tests never touch a filesystem.
const existsOnly = (...paths) => (p) => paths.includes(p);
const settings = (over = {}) => ({ enabled: true, model: DEFAULT_MODEL_ID, ...over });

test('vendor paths live under the repo folder', () => {
  expect(VENDOR_DIR).toBe('vendor/whisper');
  expect(BIN.startsWith(`${ROOT}/${VENDOR_DIR}`)).toBe(true);
  expect(MODEL.startsWith(`${ROOT}/${VENDOR_DIR}`)).toBe(true);
});

test('resolves the vendored build and the selected model when both are present', () => {
  const r = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(BIN, MODEL) });
  expect(r.bin).toBe(BIN);
  expect(r.model).toBe(MODEL);
  expect(r.enabled).toBe(true);
  expect(r.pinned).toEqual({ bin: 'vendor', model: 'store' });
});

test('env vars win over the vendored paths and are reported as pinned', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT,
    config: { whisperBin: '/opt/w/whisper-server', whisperModel: '/opt/w/custom.bin' },
    settings: settings(),
    exists: existsOnly('/opt/w/whisper-server', '/opt/w/custom.bin'),
  });
  expect(r.bin).toBe('/opt/w/whisper-server');
  expect(r.model).toBe('/opt/w/custom.bin');
  expect(r.pinned).toEqual({ bin: 'env', model: 'env' });
  expect(r.enabled).toBe(true);
});

test('a pinned env path that does not exist disables voice rather than falling back', () => {
  // Silently falling back would make a typo in .env look like it worked.
  const r = resolveVoicePaths({
    repoRoot: ROOT,
    config: { whisperBin: '/opt/typo/whisper-server' },
    settings: settings(),
    exists: existsOnly(BIN, MODEL),
  });
  expect(r.bin).toBe(null);
  expect(r.enabled).toBe(false);
  expect(r.pinned.bin).toBe('env');
});

test('missing binary or missing model both disable voice', () => {
  const noBin = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(MODEL) });
  expect(noBin.bin).toBe(null);
  expect(noBin.enabled).toBe(false);

  const noModel = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(BIN) });
  expect(noModel.model).toBe(null);
  expect(noModel.enabled).toBe(false);
});

test('the stored enable flag gates usability even when everything is installed', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: {}, settings: settings({ enabled: false }), exists: existsOnly(BIN, MODEL),
  });
  expect(r.bin).toBe(BIN);
  expect(r.model).toBe(MODEL);
  expect(r.enabled).toBe(false);
});

test('TMUXIFIER_VOICE=off overrides the stored flag', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: { voiceOff: true }, settings: settings(), exists: existsOnly(BIN, MODEL),
  });
  expect(r.enabled).toBe(false);
});

test('an unknown stored model resolves to no model rather than a fabricated path', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: {}, settings: settings({ model: 'nope' }), exists: () => true,
  });
  expect(r.model).toBe(null);
  expect(r.enabled).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voicePaths.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voicePaths.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/voicePaths.js`:

```js
import path from 'node:path';
import fs from 'node:fs';
import { resolveModel } from './voiceCatalog.js';

// Where `npm run setup-voice` and the install job put whisper.cpp. Repo-local
// per the self-contained principle: nothing lands in $HOME.
export const VENDOR_DIR = 'vendor/whisper';

export function vendorBinPath(repoRoot) {
  return path.join(repoRoot, VENDOR_DIR, 'build', 'bin', 'whisper-server');
}

export function vendorModelPath(repoRoot, file) {
  return path.join(repoRoot, VENDOR_DIR, 'models', file);
}

// Decide what is actually in effect. Pure: `exists` is injected so this is
// testable without a filesystem, and so config.js stays free of I/O.
//
// data/voice.json is authoritative for the enable flag and the model choice
// because it is read per request — a Settings change applies immediately.
// TMUXIFIER_WHISPER_BIN/MODEL remain deliberate escape hatches (a custom
// whisper build, or the e2e suite pointing at a fixture); when set they win,
// and `pinned` tells the UI to explain that rather than offer a picker that
// silently does nothing.
export function resolveVoicePaths({ repoRoot, config = {}, settings = {}, exists = fs.existsSync } = {}) {
  const pinned = { bin: null, model: null };

  let bin = null;
  if (config.whisperBin) {
    pinned.bin = 'env';
    // A pinned path that does not exist disables voice rather than falling
    // back to the vendored build: silently ignoring a typo in .env would look
    // like it worked, and the operator would never find out.
    bin = exists(config.whisperBin) ? config.whisperBin : null;
  } else {
    const candidate = vendorBinPath(repoRoot);
    if (exists(candidate)) { bin = candidate; pinned.bin = 'vendor'; }
  }

  let model = null;
  if (config.whisperModel) {
    pinned.model = 'env';
    model = exists(config.whisperModel) ? config.whisperModel : null;
  } else {
    const entry = resolveModel(settings.model);
    if (entry) {
      const candidate = vendorModelPath(repoRoot, entry.file);
      if (exists(candidate)) { model = candidate; pinned.model = 'store'; }
    }
  }

  const enabled = Boolean(bin) && Boolean(model) && settings.enabled === true && config.voiceOff !== true;
  return { bin, model, enabled, pinned };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/voicePaths.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/voicePaths.js test/voicePaths.test.js
git commit -m "feat(voice): resolve effective whisper paths with data/voice.json authoritative"
```

---

### Task 2: Settings store (`voiceStore.js`)

**Files:**
- Create: `src/server/voiceStore.js`
- Test: `test/voiceStore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from `src/server/jsonFile.js`; `MODEL_IDS`, `DEFAULT_MODEL_ID` from `voiceCatalog.js`.
- Produces: `createVoiceStore({ dataDir }) => { read(): Promise<{enabled, model}>, update(patch): Promise<{enabled, model}> }`.

- [ ] **Step 1: Write the failing test**

Create `test/voiceStore.test.js`:

```js
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceStore } from '../src/server/voiceStore.js';
import { DEFAULT_MODEL_ID } from '../src/server/voiceCatalog.js';

let dataDir;
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-voice-')); });
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

test('defaults to disabled with the default model when the file is absent', async () => {
  const store = createVoiceStore({ dataDir });
  expect(await store.read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});

test('update persists and returns the merged settings', async () => {
  const store = createVoiceStore({ dataDir });
  expect(await store.update({ enabled: true })).toEqual({ enabled: true, model: DEFAULT_MODEL_ID });
  // A fresh store instance must see it — proving it actually hit disk.
  expect(await createVoiceStore({ dataDir }).read()).toEqual({ enabled: true, model: DEFAULT_MODEL_ID });
});

test('a partial update leaves the other field alone', async () => {
  const store = createVoiceStore({ dataDir });
  await store.update({ enabled: true, model: 'base.en' });
  expect(await store.update({ enabled: false })).toEqual({ enabled: false, model: 'base.en' });
});

test('rejects a model outside the catalog', async () => {
  const store = createVoiceStore({ dataDir });
  await expect(store.update({ model: '../../etc/passwd' })).rejects.toThrow(/model/i);
  await expect(store.update({ model: 'nope' })).rejects.toThrow(/model/i);
  // The rejected write must not have persisted anything.
  expect(await store.read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});

test('the file is written owner-only', async () => {
  const store = createVoiceStore({ dataDir });
  await store.update({ enabled: true });
  const st = await fs.stat(path.join(dataDir, 'voice.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

test('a corrupt file falls back to defaults instead of throwing', async () => {
  await fs.writeFile(path.join(dataDir, 'voice.json'), 'not json at all');
  expect(await createVoiceStore({ dataDir }).read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voiceStore.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/voiceStore.js`:

```js
import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import { MODEL_IDS, DEFAULT_MODEL_ID } from './voiceCatalog.js';

// data/voice.json — the authoritative record of whether voice is on and which
// model is selected. Read per request, so a Settings change applies without a
// restart (unlike .env, which is parsed once at boot).
//
// Nothing here is a secret, so unlike proxmox.json/netbox.json nothing is
// sealed — but the file is still written 0o600 via jsonFile.js, matching
// passkeys.json.
const DEFAULTS = { enabled: false, model: DEFAULT_MODEL_ID };

function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: o.enabled === true,
    // A model that has fallen out of the catalog (downgrade, edited file)
    // reads back as the default rather than propagating an unresolvable id.
    model: MODEL_IDS.includes(o.model) ? o.model : DEFAULT_MODEL_ID,
  };
}

export function createVoiceStore({ dataDir }) {
  const file = path.join(dataDir, 'voice.json');

  async function read() {
    // A corrupt file must fail open to the defaults: failing closed here would
    // only mean voice is off, but throwing would break /api/voice/status and
    // with it the UI that lets the operator fix anything.
    const raw = await readJson(file, { fallback: DEFAULTS, validate: (v) => v && typeof v === 'object' });
    return normalize(raw);
  }

  return {
    read,
    async update(patch = {}) {
      const current = await read();
      const next = { ...current };
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
      if (patch.model !== undefined) {
        // Validated against the catalog allowlist, never written through.
        if (!MODEL_IDS.includes(patch.model)) throw new Error(`unknown model: ${String(patch.model)}`);
        next.model = patch.model;
      }
      await writeJson(file, next);
      return next;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/voiceStore.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/voiceStore.js test/voiceStore.test.js
git commit -m "feat(voice): data/voice.json store for the enable flag and model choice"
```

---

### Task 3: Install job manager (`voiceInstall.js` + `voiceInstallStore.js`)

The largest task. Mirrors `setupManager.js`/`setupStore.js`: a persisted, pollable, single-flight background job with a rolling capped log.

**Files:**
- Create: `src/server/voiceInstallStore.js`
- Create: `src/server/voiceInstall.js`
- Create: `src/server/voiceDownload.js`
- Test: `test/voiceInstall.test.js`

**Interfaces:**
- Consumes: `createDebouncedJsonStore({ dataDir, filename })` from `debouncedJsonStore.js`; `resolveModel`, `WHISPER_REPO`, `WHISPER_REF` from `voiceCatalog.js`; `vendorBinPath`, `vendorModelPath`, `VENDOR_DIR` from `voicePaths.js` (Task 1); `createVoiceStore` (Task 2).
- Produces:
  - `createVoiceInstallStore({ dataDir })` — debounced `data/voice-jobs.json`
  - `createVoiceInstallManager({ repoRoot, store, voiceStore, run, download, freeBytes, totalMem, maxLogBytes })` → `{ start(modelId), getJob(id), current(), listJobs(), whenSettled(id) }` — `whenSettled` is the test seam that resolves once a job finishes
  - `downloadVerified({ url, dest, sha256, fetchImpl })` in `voiceDownload.js` — streaming download, SHA-256 verified before rename
  - Job shape: `{ id, model, status, phase, log, error, createdAt, finishedAt }` with `status` in `running|done|error|interrupted`

- [ ] **Step 1: Write the failing test**

Create `test/voiceInstall.test.js`:

```js
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceInstallStore } from '../src/server/voiceInstallStore.js';
import { createVoiceInstallManager } from '../src/server/voiceInstall.js';
import { createVoiceStore } from '../src/server/voiceStore.js';

let dataDir;
let repoRoot;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vjobs-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vroot-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

// Injected command runner: records argv and returns scripted outcomes.
function fakeRun(outcomes = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = Object.keys(outcomes).find((k) => cmd === k || args.includes(k));
    const o = key ? outcomes[key] : { code: 0 };
    if (o.code !== 0) throw new Error(o.stderr || `${cmd} exited ${o.code}`);
    return { code: 0, stdout: o.stdout || '' };
  };
  fn.calls = calls;
  return fn;
}

function makeManager(over = {}) {
  const store = createVoiceInstallStore({ dataDir });
  const voiceStore = createVoiceStore({ dataDir });
  return {
    voiceStore,
    mgr: createVoiceInstallManager({
      repoRoot,
      store,
      voiceStore,
      run: fakeRun(),
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
  const run = fakeRun();
  const { mgr } = makeManager({ run });
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
  const run = fakeRun();
  const { mgr } = makeManager({ run, totalMem: () => 4 * 1024 ** 3 });
  await mgr.whenSettled((await mgr.start('base.en')).id);
  const build = run.calls.find((c) => c.includes('--build'));
  // whisper.cpp translation units run ~1 GB each; -j4 OOMs a 4 GB container.
  expect(build[build.indexOf('-j') + 1]).toBe('2');
});

test('skips apt when cmake is already present', async () => {
  const run = fakeRun({ cmake: { code: 0 } });
  const { mgr } = makeManager({ run });
  await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(run.calls.some((c) => c[0] === 'apt-get')).toBe(false);
});

test('uses the pinned repo and tag, never a branch', async () => {
  const run = fakeRun();
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

test('the log is capped so a noisy build cannot grow unbounded', async () => {
  const { mgr } = makeManager({
    run: async () => ({ code: 0, stdout: 'x'.repeat(5000) }),
    maxLogBytes: 1000,
  });
  const settled = await mgr.whenSettled((await mgr.start('base.en')).id);
  expect(settled.log.length).toBeLessThanOrEqual(1000);
});

test('a job left running by a restart reconciles to interrupted', async () => {
  const store = createVoiceInstallStore({ dataDir });
  store.save([{ id: 'j1', model: 'base.en', status: 'running', phase: 'build', log: '', createdAt: 1 }]);
  await store.whenIdle();
  const mgr = createVoiceInstallManager({
    repoRoot, store, voiceStore: createVoiceStore({ dataDir }),
    run: fakeRun(), download: async () => ({ ok: true }),
    freeBytes: async () => 50 * 1024 ** 3, totalMem: () => 16 * 1024 ** 3,
  });
  expect(mgr.getJob('j1').status).toBe('interrupted');
  // An interrupted job must not block a fresh install.
  await expect(mgr.start('base.en')).resolves.toMatchObject({ status: 'running' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceInstall.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voiceInstallStore.js"`.

- [ ] **Step 3: Write the store wrapper**

Create `src/server/voiceInstallStore.js`, mirroring `setupStore.js` exactly:

```js
import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/voice-jobs.json (whisper install jobs).
// Persisted rather than in-memory so a browser refresh — or a reconnect
// partway through a ~2 minute build — can re-attach to the running job.
export function createVoiceInstallStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'voice-jobs.json' });
}
```

- [ ] **Step 4: Write the manager**

Create `src/server/voiceInstall.js`:

```js
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { resolveModel, WHISPER_REPO, WHISPER_REF } from './voiceCatalog.js';
import { VENDOR_DIR, vendorBinPath, vendorModelPath } from './voicePaths.js';
import { downloadVerified } from './voiceDownload.js';

// Persisted, single-flight install job: apt -> clone -> build -> download ->
// verify -> enable. Mirrors setupManager.js so the UI can poll it the same way
// box setup is polled.
//
// SECURITY: this runs apt-get, a git clone, a compiler and a large download as
// whatever user the service runs as (root, in the documented deployment). Every
// value below is a hardcoded constant or comes from voiceCatalog's allowlist.
// The caller supplies only a model ID, validated before anything executes.
const APT_PACKAGE = 'cmake';
const BUILD_OVERHEAD_BYTES = 700 * 1024 * 1024; // source + build output, on top of the model

function defaultRun(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 400)}`)); return; }
      resolve({ code: 0, stdout: String(stdout || '') + String(stderr || '') });
    });
  });
}

const defaultFreeBytes = async (dir) => {
  const st = fsSync.statfsSync(dir);
  return st.bavail * st.bsize;
};

export function createVoiceInstallManager({
  repoRoot,
  store,
  voiceStore,
  run = defaultRun,
  download = downloadVerified,
  freeBytes = defaultFreeBytes,
  totalMem = () => os.totalmem(),
  maxLogBytes = 64 * 1024,
  now = () => Date.now(),
} = {}) {
  // Restart reconciliation: a job the process was running when it died can
  // never resume, so it must not sit as 'running' forever blocking new
  // installs. Same treatment setupManager gives its own jobs.
  const jobs = (store.load() || []).map((j) => (j.status === 'running' ? { ...j, status: 'interrupted' } : j));
  store.save(jobs);

  const settled = new Map();
  let seq = 0;

  const view = (j) => ({
    id: j.id, model: j.model, status: j.status, phase: j.phase,
    log: j.log, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt,
  });
  const newestFirst = (a, b) => (b.createdAt - a.createdAt) || (b.id < a.id ? -1 : 1);
  const persist = () => store.save(jobs);
  const append = (j, text) => { if (text) j.log = (j.log + text).slice(-maxLogBytes); };

  function runningJob() {
    return jobs.find((j) => j.status === 'running') || null;
  }

  async function execute(j) {
    const vendor = path.join(repoRoot, VENDOR_DIR);
    const entry = resolveModel(j.model);

    j.phase = 'preflight';
    persist();
    const need = entry.bytes + BUILD_OVERHEAD_BYTES;
    const free = await freeBytes(repoRoot);
    if (free < need) {
      const gb = (n) => (n / 1024 ** 3).toFixed(1);
      throw new Error(`not enough disk: need ~${gb(need)} GB, ${gb(free)} GB free`);
    }
    append(j, `preflight ok: need ~${(need / 1024 ** 3).toFixed(1)} GB, have ${(free / 1024 ** 3).toFixed(1)} GB\n`);

    j.phase = 'cmake';
    persist();
    let haveCmake = true;
    try { await run('cmake', ['--version']); } catch { haveCmake = false; }
    if (!haveCmake) {
      append(j, `+ apt-get install -y ${APT_PACKAGE}\n`);
      const r = await run('apt-get', ['install', '-y', APT_PACKAGE], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      });
      append(j, r.stdout);
    } else {
      append(j, 'cmake already present\n');
    }

    j.phase = 'clone';
    persist();
    if (fsSync.existsSync(path.join(vendor, '.git'))) {
      append(j, `+ git fetch/checkout ${WHISPER_REF}\n`);
      append(j, (await run('git', ['-C', vendor, 'fetch', '--depth', '1', 'origin', 'tag', WHISPER_REF])).stdout);
      append(j, (await run('git', ['-C', vendor, 'checkout', WHISPER_REF])).stdout);
    } else {
      fsSync.mkdirSync(path.dirname(vendor), { recursive: true });
      append(j, `+ git clone ${WHISPER_REPO} @ ${WHISPER_REF}\n`);
      append(j, (await run('git', ['clone', '--depth', '1', '--branch', WHISPER_REF, WHISPER_REPO, vendor])).stdout);
    }

    j.phase = 'build';
    persist();
    // whisper.cpp translation units peak around 1 GB each, so parallelism is
    // capped by RAM as well as cores — -j4 OOMs a 4 GB container mid-build.
    const ramGb = totalMem() / 1024 ** 3;
    const jobsN = Math.max(1, Math.min(os.cpus().length || 1, 4, ramGb < 6 ? 2 : 4));
    append(j, `+ cmake --build -j ${jobsN}\n`);
    append(j, (await run('cmake', ['-B', path.join(vendor, 'build'), '-S', vendor, '-DCMAKE_BUILD_TYPE=Release'])).stdout);
    append(j, (await run('cmake', ['--build', path.join(vendor, 'build'), '--config', 'Release',
      '-j', String(jobsN), '--target', 'whisper-server'])).stdout);
    if (!fsSync.existsSync(vendorBinPath(repoRoot))) throw new Error('build finished but whisper-server is missing');

    j.phase = 'model';
    persist();
    const dest = vendorModelPath(repoRoot, entry.file);
    if (fsSync.existsSync(dest)) {
      append(j, `${entry.file} already present\n`);
    } else {
      append(j, `+ download ${entry.file} (${(entry.bytes / 1024 ** 2).toFixed(0)} MB)\n`);
      fsSync.mkdirSync(path.dirname(dest), { recursive: true });
      await download({ url: entry.url, dest, sha256: entry.sha256 });
      append(j, 'integrity check passed\n');
    }

    j.phase = 'enable';
    persist();
    await voiceStore.update({ enabled: true, model: j.model });
    append(j, 'voice enabled\n');
  }

  return {
    async start(modelId) {
      // Validated BEFORE anything executes: nothing user-supplied may reach
      // apt, git, the compiler, or a fetch.
      const entry = resolveModel(modelId);
      if (!entry) throw new Error(`unknown model: ${String(modelId)}`);
      if (runningJob()) throw new Error('an install is already running');

      const j = {
        id: `vi-${now()}-${++seq}`, model: entry.id, status: 'running',
        phase: 'preflight', log: '', error: null, createdAt: now(), finishedAt: null,
      };
      jobs.push(j);
      persist();

      const p = (async () => {
        try {
          await execute(j);
          j.status = 'done';
        } catch (e) {
          j.status = 'error';
          j.error = e?.message || 'install failed';
          append(j, `\nERROR: ${j.error}\n`);
        } finally {
          j.phase = null;
          j.finishedAt = now();
          persist();
        }
        return view(j);
      })();
      settled.set(j.id, p);
      return view(j);
    },

    getJob(id) {
      const j = jobs.find((x) => x.id === id);
      return j ? view(j) : null;
    },
    current() {
      const j = runningJob() || [...jobs].sort(newestFirst)[0];
      return j ? view(j) : null;
    },
    listJobs() {
      return [...jobs].sort(newestFirst).map(view);
    },
    // Test seam: resolves with the job's final view once it settles.
    whenSettled(id) {
      return settled.get(id) || Promise.resolve(this.getJob(id));
    },
  };
}
```

- [ ] **Step 5: Write the verified downloader**

Create `src/server/voiceDownload.js` — kept separate so the manager's tests can inject a fake without touching the network:

```js
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';

// Download to a temp path, verify the pinned digest, and only then rename into
// place. Streaming rather than buffering: the largest catalog model is ~540 MB
// and buffering it would peak near 1 GB on a 4 GB host. The temp-then-rename
// ordering means a killed download can never leave a truncated file that the
// server would later mmap, and an unverified blob never occupies the real path.
export async function downloadVerified({ url, dest, sha256, fetchImpl = fetch }) {
  const tmp = `${dest}.part`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const hash = createHash('sha256');
  const out = fsSync.createWriteStream(tmp, { mode: 0o600 });
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const got = hash.digest('hex');
    if (got !== sha256) throw new Error(`integrity check failed: expected ${sha256}, got ${got}`);
    fsSync.renameSync(tmp, dest);
    return { ok: true };
  } catch (e) {
    try { out.destroy(); } catch {}
    try { fsSync.unlinkSync(tmp); } catch {}
    throw e;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/voiceInstall.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/voiceInstall.js src/server/voiceInstallStore.js src/server/voiceDownload.js test/voiceInstall.test.js
git commit -m "feat(voice): single-flight persisted whisper install job"
```

---

### Task 4: Wire the store into config and the engine

Makes `data/voice.json` actually govern the running server. Until this task, stage 1's `.env`-derived behaviour is still in force.

**Files:**
- Modify: `src/server/index.js` (construct the stores, resolve paths, build the engine from the resolved model)
- Modify: `src/server/server.js` (`/api/ui-config` uses the resolved state)
- Modify: `scripts/setup-voice.mjs` (write `data/voice.json`, stop writing the `.env` vars)
- Test: `test/voiceRoutes.test.js` (extend)

**Interfaces:**
- Consumes: `resolveVoicePaths` (Task 1), `createVoiceStore` (Task 2), `createVoiceInstallManager` (Task 3).
- Produces: `buildServer` gains `voiceStore`, `voiceInstallManager`, and `resolveVoice()` — a zero-arg async function returning `{ bin, model, enabled, pinned }` for the current on-disk state.

- [ ] **Step 1: Write the failing test**

Append to `test/voiceRoutes.test.js`:

```js
test('/api/ui-config reports voice off when the store disables it', async () => {
  const a = makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: false, pinned: { bin: 'vendor', model: 'store' } }),
  } });
  const cookie = await login(a);
  const res = await a.inject({ method: 'GET', url: '/api/ui-config', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.json().voice).toBe(false);
});

test('/api/ui-config reports voice on when the store enables it', async () => {
  const a = makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: true, pinned: { bin: 'vendor', model: 'store' } }),
  } });
  const cookie = await login(a);
  const res = await a.inject({ method: 'GET', url: '/api/ui-config', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.json().voice).toBe(true);
});

test('transcription is refused when the store has voice disabled', async () => {
  const a = makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: false, pinned: { bin: null, model: null } }),
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceRoutes.test.js`
Expected: FAIL — the injected `resolveVoice` is ignored, so the first test sees `voice: true`.

- [ ] **Step 3: Wire the server**

In `src/server/server.js`, add `voiceStore = null`, `voiceInstallManager = null`, and `resolveVoice = null` to the `buildServer` parameter list. Replace the `voice` field in `/api/ui-config` and the enablement check in `POST /api/voice` so both consult the resolved state:

```js
  // Resolved per request rather than read from config at boot: data/voice.json
  // is authoritative and a Settings change must apply without a restart.
  async function voiceState() {
    if (resolveVoice) return resolveVoice();
    return { bin: null, model: null, enabled: Boolean(config.voiceEnabled), pinned: { bin: null, model: null } };
  }
```

In `/api/ui-config`, replace `voice: Boolean(config.voiceEnabled) && Boolean(voiceEngine)` with:

```js
      voice: (await voiceState()).enabled && Boolean(voiceEngine),
```

In `POST /api/voice`, replace `if (!config.voiceEnabled || !voiceEngine)` with:

```js
    if (!(await voiceState()).enabled || !voiceEngine) {
```

- [ ] **Step 4: Wire index.js**

In `src/server/index.js`, construct the stores and resolve paths at boot, and rebuild the engine when the selection changes:

```js
import { createVoiceStore } from './voiceStore.js';
import { createVoiceInstallStore } from './voiceInstallStore.js';
import { createVoiceInstallManager } from './voiceInstall.js';
import { resolveVoicePaths } from './voicePaths.js';

const repoRoot = process.cwd();
const voiceStore = createVoiceStore({ dataDir: config.dataDir });
const voiceInstallManager = createVoiceInstallManager({
  repoRoot,
  store: createVoiceInstallStore({ dataDir: config.dataDir }),
  voiceStore,
});

const resolveVoice = async () => resolveVoicePaths({ repoRoot, config, settings: await voiceStore.read() });

// The engine is rebuilt whenever the effective model changes, so switching
// model in Settings takes effect on the next dictation without a restart.
let voiceEngine = null;
let voiceEngineModel = null;
async function currentVoiceEngine() {
  const { bin, model, enabled } = await resolveVoice();
  if (!enabled) return null;
  if (voiceEngine && voiceEngineModel === model) return voiceEngine;
  if (voiceEngine) await voiceEngine.stop();
  voiceEngineModel = model;
  voiceEngine = createVoiceEngine({
    bin, model, idleMs: config.voiceIdleMs, threads: Math.min(4, os.cpus().length || 1),
  });
  return voiceEngine;
}
```

Pass `voiceStore`, `voiceInstallManager`, `resolveVoice`, and a `voiceEngine` accessor into `buildServer`. Keep `registerShutdownFlush` stopping whatever engine is live.

- [ ] **Step 5: Update the installer script**

In `scripts/setup-voice.mjs`, replace the `upsertEnvFile(...)` call with a write to the store, so the CLI and the UI agree on one source of truth:

```js
import { createVoiceStore } from '../src/server/voiceStore.js';

// data/voice.json is authoritative (see the spec's stage-2 amendment). Writing
// TMUXIFIER_WHISPER_* into .env would pin the paths and make the Settings
// model picker inert, since .env wins and is only read at boot.
await createVoiceStore({ dataDir: path.join(repoRoot, 'data') }).update({ enabled: true, model: modelId });

console.error('\nVoice dictation installed and enabled.');
console.error(`  model  ${finalModel}`);
console.error('\nRestart Tmuxifier, then press Ctrl+Shift+Space in a terminal to dictate.');
```

Remove the now-unused `upsertEnvFile` import.

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. Existing `/api/ui-config` and `/api/voice` tests must still pass — the default `voiceState()` falls back to `config.voiceEnabled` when no `resolveVoice` is injected.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js src/server/index.js scripts/setup-voice.mjs test/voiceRoutes.test.js
git commit -m "feat(voice): make data/voice.json govern the running server"
```

---

### Task 5: The four management routes

**Files:**
- Modify: `src/server/server.js`
- Test: `test/voiceManageRoutes.test.js`

**Interfaces:**
- Consumes: `voiceStore`, `voiceInstallManager`, `resolveVoice` (Task 4); `MODEL_IDS`, `resolveModel` from `voiceCatalog.js`.
- Produces:
  - `GET /api/voice/status` → `{ installed, enabled, model, pinned, engine, models: [{id, file, bytes, installed}], job }`
  - `POST /api/voice/install` `{ model }` → job view (409 when one is running)
  - `GET /api/voice/install/:id` → job view (404 unknown)
  - `PATCH /api/voice/settings` `{ enabled?, model? }` → `{ enabled, model }` (400 bad model)

- [ ] **Step 1: Write the failing test**

Create `test/voiceManageRoutes.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let settings;

async function makeApp(over = {}) {
  settings = { enabled: false, model: 'small.en' };
  const config = {
    authMode: 'password', passwordHash: await hashPassword('pw'),
    cookieSecret: 'c'.repeat(32), voiceMaxBytes: 1024, voiceMaxSeconds: 120,
  };
  const store = { listBoxes: async () => [], getBox: async () => null };
  const statusChecker = { checkBox: async () => ({}), listSessions: async () => ({ sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const voiceStore = {
    read: async () => ({ ...settings }),
    update: async (p) => {
      if (p.model !== undefined && !['small.en', 'base.en'].includes(p.model)) throw new Error('unknown model');
      settings = { ...settings, ...p };
      return { ...settings };
    },
  };
  const voiceInstallManager = {
    jobs: [],
    async start(model) {
      if (this.jobs.some((j) => j.status === 'running')) throw new Error('an install is already running');
      const j = { id: 'j1', model, status: 'running', phase: 'clone', log: '', error: null, createdAt: 1 };
      this.jobs.push(j); return j;
    },
    getJob(id) { return this.jobs.find((j) => j.id === id) || null; },
    current() { return this.jobs[0] || null; },
  };
  return buildServer({
    config, store, sessions, statusChecker, voiceStore, voiceInstallManager,
    resolveVoice: async () => ({
      bin: '/w', model: '/m', enabled: settings.enabled, pinned: { bin: 'vendor', model: 'store' },
    }),
    voiceEngine: { transcribe: async () => 'x', stop: async () => {}, state: () => 'stopped' },
    ...over,
  });
}

beforeEach(async () => { app = await makeApp(); });

async function login(a = app) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}
const auth = (c) => ({ cookie: `${c.name}=${c.value}` });

test('every management route requires authentication', async () => {
  for (const [method, url] of [
    ['GET', '/api/voice/status'], ['POST', '/api/voice/install'],
    ['GET', '/api/voice/install/j1'], ['PATCH', '/api/voice/settings'],
  ]) {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
  }
});

test('status reports installed state, selection, pinning and the model catalog', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/voice/status', headers: auth(await login()) });
  expect(res.statusCode).toBe(200);
  const b = res.json();
  expect(b.installed).toBe(true);
  expect(b.enabled).toBe(false);
  expect(b.model).toBe('small.en');
  expect(b.pinned).toEqual({ bin: 'vendor', model: 'store' });
  expect(Array.isArray(b.models)).toBe(true);
  expect(b.models.some((m) => m.id === 'small.en')).toBe(true);
});

test('settings can enable voice and switch model', async () => {
  const c = await login();
  const res = await app.inject({
    method: 'PATCH', url: '/api/voice/settings', headers: auth(c), payload: { enabled: true, model: 'base.en' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ enabled: true, model: 'base.en' });
});

test('settings rejects a model outside the catalog', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/voice/settings', headers: auth(await login()), payload: { model: '../../etc/passwd' },
  });
  expect(res.statusCode).toBe(400);
});

test('install starts a job and refuses a second while it runs', async () => {
  const c = await login();
  const first = await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  expect(first.statusCode).toBe(200);
  expect(first.json().status).toBe('running');

  const second = await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  expect(second.statusCode).toBe(409);
});

test('install rejects a model outside the catalog', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/voice/install', headers: auth(await login()), payload: { model: 'nope' },
  });
  expect(res.statusCode).toBe(400);
});

test('a job can be polled by id, and an unknown id is 404', async () => {
  const c = await login();
  await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  const ok = await app.inject({ method: 'GET', url: '/api/voice/install/j1', headers: auth(c) });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().id).toBe('j1');

  const missing = await app.inject({ method: 'GET', url: '/api/voice/install/nope', headers: auth(c) });
  expect(missing.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceManageRoutes.test.js`
Expected: FAIL — routes 404, so the auth test sees 404 rather than 401.

- [ ] **Step 3: Write minimal implementation**

In `src/server/server.js`, add the import and the four routes beside `POST /api/voice`:

```js
import { MODEL_IDS, resolveModel } from './voiceCatalog.js';
```

```js
  // --- Voice management (Settings -> Voice) ---------------------------------
  // Everything here is authenticated. Model ids are validated against the
  // catalog allowlist before reaching the install job, which shells out.

  app.get('/api/voice/status', { preHandler: requireAuth }, async () => {
    const state = await voiceState();
    const settings = voiceStore ? await voiceStore.read() : { enabled: false, model: null };
    const models = MODEL_IDS.map((id) => {
      const m = resolveModel(id);
      return { id, file: m.file, bytes: m.bytes, installed: id === settings.model && Boolean(state.model) };
    });
    return {
      installed: Boolean(state.bin && state.model),
      enabled: state.enabled,
      model: settings.model,
      pinned: state.pinned,
      engine: voiceEngine?.state ? voiceEngine.state() : 'stopped',
      models,
      job: voiceInstallManager ? voiceInstallManager.current() : null,
    };
  });

  app.post('/api/voice/install', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceInstallManager) return reply.code(503).send({ error: 'install manager unavailable' });
    const model = String(req.body?.model || '');
    if (!resolveModel(model)) return reply.code(400).send({ error: 'unknown model' });
    try {
      return await voiceInstallManager.start(model);
    } catch (e) {
      // Single-flight: a concurrent install is a conflict, not a server error.
      const msg = e?.message || 'install failed';
      return reply.code(/already/i.test(msg) ? 409 : 500).send({ error: msg });
    }
  });

  app.get('/api/voice/install/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceInstallManager) return reply.code(503).send({ error: 'install manager unavailable' });
    const job = voiceInstallManager.getJob(String(req.params.id));
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return job;
  });

  app.patch('/api/voice/settings', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceStore) return reply.code(503).send({ error: 'voice settings unavailable' });
    const patch = {};
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
    if (req.body?.model !== undefined) {
      if (!resolveModel(String(req.body.model))) return reply.code(400).send({ error: 'unknown model' });
      patch.model = String(req.body.model);
    }
    try {
      return await voiceStore.update(patch);
    } catch (e) {
      return reply.code(400).send({ error: e?.message || 'could not save voice settings' });
    }
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voiceManageRoutes.test.js test/voiceRoutes.test.js test/server.test.js`
Expected: PASS, 7 new tests plus the existing suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/voiceManageRoutes.test.js
git commit -m "feat(voice): status, install, and settings management routes"
```

---

### Task 6: The Settings → Voice tab

**Files:**
- Create: `src/web/voice.ts` (fetch layer)
- Create: `src/web/settingsVoice.ts` (the tab)
- Modify: `src/web/settingsUi.ts` (register the sixth tab)
- Test: `test/voiceSettings.test.js`

**Interfaces:**
- Consumes: the four routes from Task 5; `createSetupJobPoller` from `src/web/setupPoller.ts`.
- Produces: `voiceApi` in `voice.ts`; `renderVoiceSection(content: HTMLElement): Promise<void>`; `voiceStatusLine(status)` and `installPollDelay(job)` as pure, testable helpers.

- [ ] **Step 1: Write the failing test**

Create `test/voiceSettings.test.js` — plain JavaScript, testing only the pure helpers (DOM-building modules are not unit-tested in this repo; see `settingsNetbox.ts`, `proxmoxUi.ts`):

```js
import { test, expect } from 'vitest';
import { voiceStatusLine, installPollDelay } from '../src/web/settingsVoice';

test('describes an uninstalled server', () => {
  const s = voiceStatusLine({ installed: false, enabled: false, model: 'small.en', pinned: { bin: null, model: null } });
  expect(s).toMatch(/not installed/i);
});

test('describes an installed but disabled server', () => {
  const s = voiceStatusLine({ installed: true, enabled: false, model: 'small.en', pinned: { bin: 'vendor', model: 'store' } });
  expect(s).toMatch(/installed/i);
  expect(s).toMatch(/disabled|off/i);
});

test('describes a working server with its model', () => {
  const s = voiceStatusLine({ installed: true, enabled: true, model: 'small.en', pinned: { bin: 'vendor', model: 'store' } });
  expect(s).toMatch(/small\.en/);
});

test('says when the model is pinned by .env so the picker is explained, not silently inert', () => {
  const s = voiceStatusLine({ installed: true, enabled: true, model: 'small.en', pinned: { bin: 'vendor', model: 'env' } });
  expect(s).toMatch(/\.env/);
});

test('polls fast while running and stops once settled', () => {
  expect(installPollDelay({ status: 'running' })).toBeGreaterThan(0);
  expect(installPollDelay({ status: 'running' })).toBeLessThanOrEqual(2000);
  expect(installPollDelay({ status: 'done' })).toBe(null);
  expect(installPollDelay({ status: 'error' })).toBe(null);
  expect(installPollDelay({ status: 'interrupted' })).toBe(null);
  // A dropped poll must keep trying rather than silently abandoning a live build.
  expect(installPollDelay(null)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceSettings.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/settingsVoice"`.

- [ ] **Step 3: Write the fetch layer**

Create `src/web/voice.ts`, following `netbox.ts`'s shape:

```ts
// Fetch layer for the Settings -> Voice tab.
export interface VoiceModel { id: string; file: string; bytes: number; installed: boolean }
export interface VoiceJob {
  id: string; model: string; status: 'running' | 'done' | 'error' | 'interrupted';
  phase: string | null; log: string; error: string | null;
}
export interface VoiceStatus {
  installed: boolean;
  enabled: boolean;
  model: string | null;
  pinned: { bin: 'env' | 'vendor' | null; model: 'env' | 'store' | null };
  engine: string;
  models: VoiceModel[];
  job: VoiceJob | null;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const voiceApi = {
  status: () => fetch('/api/voice/status').then((r) => j<VoiceStatus>(r)),
  install: (model: string) => fetch('/api/voice/install', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
  }).then((r) => j<VoiceJob>(r)),
  job: (id: string) => fetch(`/api/voice/install/${encodeURIComponent(id)}?t=${Date.now()}`).then((r) => j<VoiceJob>(r)),
  saveSettings: (patch: { enabled?: boolean; model?: string }) => fetch('/api/voice/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  }).then((r) => j<{ enabled: boolean; model: string }>(r)),
};
```

- [ ] **Step 4: Write the tab**

Create `src/web/settingsVoice.ts`:

```ts
import { el } from './dom';
import { voiceApi, type VoiceStatus, type VoiceJob } from './voice';
import { createSetupJobPoller } from './setupPoller';

// Pure: the one-line summary at the top of the tab. Kept separate from the DOM
// so the wording is unit-testable.
export function voiceStatusLine(s: Pick<VoiceStatus, 'installed' | 'enabled' | 'model' | 'pinned'>): string {
  if (!s.installed) return 'whisper.cpp is not installed on this host.';
  const base = s.enabled
    ? `Voice dictation is on, using ${s.model}.`
    : `whisper.cpp is installed, but voice dictation is disabled.`;
  // Without this the picker would look broken: .env wins and is read only at
  // boot, so a selection here would silently do nothing.
  return s.pinned.model === 'env'
    ? `${base} The model is pinned by TMUXIFIER_WHISPER_MODEL in .env; remove it to choose here.`
    : base;
}

// Pure: poll policy for the install job. Returns milliseconds until the next
// poll, or null to stop.
export function installPollDelay(job: VoiceJob | null): number | null {
  if (!job) return 2000;            // transient fetch failure — keep trying
  return job.status === 'running' ? 1000 : null;
}

export async function renderVoiceSection(content: HTMLElement): Promise<void> {
  content.textContent = 'Loading…';
  let status: VoiceStatus;
  try {
    status = await voiceApi.status();
  } catch (e) {
    content.textContent = `Could not load voice settings: ${(e as Error).message}`;
    return;
  }

  content.textContent = '';
  const summary = el('p', { class: 'muted' }, [voiceStatusLine(status)]);
  content.appendChild(summary);

  const logBox = el('pre', { class: 'voice-log' });
  logBox.style.display = 'none';

  const refresh = async () => { await renderVoiceSection(content); };

  // --- enable toggle -------------------------------------------------------
  if (status.installed) {
    const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = status.enabled;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try { await voiceApi.saveSettings({ enabled: toggle.checked }); await refresh(); } finally { toggle.disabled = false; }
    });
    content.appendChild(el('label', {}, [toggle, ' Enable voice dictation']));
  }

  // --- model picker --------------------------------------------------------
  const pinned = status.pinned.model === 'env';
  const list = el('div', { class: 'voice-models' });
  for (const m of status.models) {
    const row = el('label', { class: 'voice-model' });
    const radio = el('input', { type: 'radio', name: 'voice-model' }) as HTMLInputElement;
    radio.checked = m.id === status.model;
    radio.disabled = pinned;
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      // Selecting a model that is not on disk is what triggers an install.
      if (m.installed) await voiceApi.saveSettings({ model: m.id });
      else await startInstall(m.id);
      await refresh();
    });
    row.append(radio, ` ${m.id} — ${(m.bytes / 1024 ** 2).toFixed(0)} MB`,
      m.installed ? ' (installed)' : ' (will download)');
    list.appendChild(row);
  }
  content.appendChild(list);

  // --- install -------------------------------------------------------------
  async function startInstall(model: string): Promise<void> {
    logBox.style.display = '';
    logBox.textContent = 'Starting…';
    let job: VoiceJob;
    try {
      job = await voiceApi.install(model);
    } catch (e) {
      logBox.textContent = `Install could not start: ${(e as Error).message}`;
      return;
    }
    watch(job.id);
  }

  function watch(id: string): void {
    logBox.style.display = '';
    const poller = createSetupJobPoller<VoiceJob>({
      fetchJob: () => voiceApi.job(id).catch(() => null),
      onJob: (job) => {
        if (job) {
          logBox.textContent = job.log || '(no output yet)';
          logBox.scrollTop = logBox.scrollHeight;
          if (job.status === 'error') logBox.textContent += `\n\nFAILED: ${job.error}`;
          if (job.status !== 'running') void refresh();
        }
        return installPollDelay(job);
      },
    });
    poller.start();
  }

  if (!status.installed) {
    const btn = el('button', { class: 'primary' }, ['Install whisper.cpp']) as HTMLButtonElement;
    btn.addEventListener('click', () => { btn.disabled = true; void startInstall(status.model || 'small.en'); });
    content.appendChild(btn);
    content.appendChild(el('p', { class: 'muted' }, [
      'Takes roughly two minutes and about 1.2 GB of disk. Installs cmake if it is missing, builds whisper.cpp from a pinned release, and downloads the model.']));
  }

  content.appendChild(logBox);
  // A build already running when the tab opens (e.g. after a refresh) is
  // re-attached rather than orphaned.
  if (status.job && status.job.status === 'running') watch(status.job.id);
}
```

- [ ] **Step 5: Register the tab**

In `src/web/settingsUi.ts`, add the import, extend the union type, and add the record entry:

```ts
import { renderVoiceSection } from './settingsVoice';

export type SettingsTab = 'boxes' | 'netbox' | 'proxmox' | 'passkeys' | 'voice' | 'notifications';
```

and in `SECTIONS`, between `passkeys` and `notifications`:

```ts
  voice: { label: 'Voice', render: (content) => renderVoiceSection(content) },
```

Add to `src/web/style.css`:

```css
.voice-log {
  max-height: 16rem;
  overflow: auto;
  background: #0b0e14;
  border: 1px solid #2a3040;
  border-radius: 4px;
  padding: 8px;
  font-size: 12px;
  white-space: pre-wrap;
}
.voice-models { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.voice-model input:disabled + * { opacity: 0.5; }
```

- [ ] **Step 6: Run tests, typecheck and build**

Run: `npx vitest run test/voiceSettings.test.js && npm run typecheck && npm run build`
Expected: PASS, 6 tests; typecheck and build clean.

- [ ] **Step 7: Commit**

```bash
git add src/web/voice.ts src/web/settingsVoice.ts src/web/settingsUi.ts src/web/style.css test/voiceSettings.test.js
git commit -m "feat(voice): Settings tab for install, enable, and model choice"
```

---

### Task 7: Migration and documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.example`
- Manual: remove the two stale lines from this deployment's `.env`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Migrate this deployment**

Stage 1's `setup-voice` wrote `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` into `.env`. Those now pin the paths and make the Settings model picker inert. Remove them and record the selection in the store instead:

```bash
grep -n 'TMUXIFIER_WHISPER_' .env          # confirm what is there before editing
node -e "
import('./src/server/voiceStore.js').then(async ({createVoiceStore}) => {
  console.log(await createVoiceStore({ dataDir: 'data' }).update({ enabled: true, model: 'small.en' }));
});
"
# then delete the two TMUXIFIER_WHISPER_* lines from .env
```

Expected: the node command prints `{ enabled: true, model: 'small.en' }`, and `data/voice.json` exists with mode `600`.

- [ ] **Step 2: Verify the picker now governs**

Run: `sudo systemctl restart tmuxifier`, then open Settings → Voice.
Expected: the summary line no longer mentions `.env` pinning, and the model radios are enabled rather than greyed out.

- [ ] **Step 3: Update the docs**

In `README.md`'s voice section, replace the "run `npm run setup-voice`" instruction as the primary path with the Settings → Voice tab, keeping the CLI as the headless equivalent. Document that installing takes roughly two minutes and 1.2 GB, that the tab performs the install as a background job you can navigate away from, and that `TMUXIFIER_WHISPER_BIN`/`MODEL` are escape hatches that pin the corresponding control when set.

In `README.md`'s configuration table, add a note to the `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` rows that setting either one pins that control in Settings → Voice.

In `CLAUDE.md` and `AGENTS.md` (kept in sync), add to the architecture list:

```
- `voiceStore.js` / `voiceInstall.js` / `voiceInstallStore.js` / `voiceDownload.js` / `voicePaths.js` —
  voice dictation stage 2: `data/voice.json` is the authoritative record of whether voice is on
  and which model is selected (read per request, so a Settings change applies without a restart,
  unlike `.env` which is parsed at boot); the single-flight persisted install job that runs
  apt → clone → build → download → verify with a streaming capped log; the debounced
  `data/voice-jobs.json` persistence; the streaming SHA-256-verified downloader (temp file,
  verify, then rename, so an unverified blob never occupies the real path); and the pure
  path-resolution rules, where `TMUXIFIER_WHISPER_BIN`/`MODEL` are escape hatches that win when
  set and are surfaced in the UI as pinned rather than silently overriding the picker.
```

Add `data/voice.json` and `data/voice-jobs.json` to the `data/` file list in the self-contained principle section of both files, and add `settingsVoice.ts`/`voice.ts` to the web-client module paragraph.

In `.env.example`, update the voice block to say the two `TMUXIFIER_WHISPER_*` variables are optional escape hatches for a custom build, that leaving them unset lets Settings → Voice manage everything, and that setting either one pins that control in the UI.

- [ ] **Step 4: Verify docs and sync**

Run: `npm test`
Expected: typecheck and the full suite pass.

Then confirm `CLAUDE.md` and `AGENTS.md` match for every section touched — diff the relevant line ranges against each other.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md .env.example
git commit -m "docs(voice): document the Settings tab and the .env escape hatches"
```

---

## Stage 2 complete

Voice dictation can now be installed, enabled, and re-modelled entirely from the browser, with `.env` reduced to an escape hatch for custom builds and the e2e fixture.
