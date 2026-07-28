# Immich Service Tile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `immich` service check kind so a tile on the standby dashboard reports an Immich server's library, storage, job queues and version instead of a bare up/down lamp.

**Architecture:** Follows the UniFi precedent exactly — a dependency-free GET-only HTTP client (`immichApi.js`), a pure metrics shaper (`immichMetrics.js`), a per-service client cache (`immichRegistry.js`), and a web card with a pure view-model plus an in-place-updating DOM layer (`immichCard.ts`). Everything else is wiring into the existing service-tile pipeline.

**Tech Stack:** Node 20+ ESM, `node:http`/`node:https`, Fastify, TypeScript + Vite for the web client, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-07-28-immich-service-tile-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+. Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first. Tests use **real code, not mocks** — dependency-injection factories make this possible.
- vitest runs `environment: 'node'` with **no jsdom**. DOM layers cannot be unit-tested; only pure functions can. Never plan a DOM-rendering test.
- `npm test` = `npm run typecheck && vitest run`. Run a single file with `npx vitest run test/<file>`.
- Conventional-commit messages (`feat(immich): …`).
- The repo is **public**. No real domains, IPs, hostnames, emails or user names in any committed file. Use `immich.example.com`, `192.168.1.10`, `Example User`.
- The integration is **read-only**: no code path may issue an HTTP verb other than `GET`.
- Immich API base is `/api`; endpoints verified against **v3.0.3**.
- Secrets: the API key is sealed by `secretBox` and redacted to `hasPassword` on every read. It must never appear in a response body, a log line, or an error message.

---

### Task 1: Pure metrics shaper

**Files:**
- Create: `src/server/immichMetrics.js`
- Create: `test/helpers/immichSamples.js`
- Test: `test/immichMetrics.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildMetrics({ about, storage, statistics, jobs, versionCheck, config, denied }) -> ImmichMetrics`, and `buildJobRollup(jobs) -> { active, waiting, failed, paused }`. Task 2 calls `buildMetrics`. The `ImmichMetrics` object shape is mirrored as a TypeScript interface in Task 5.

- [ ] **Step 1: Write the sample fixtures**

These are scrubbed shapes captured from a live Immich v3.0.3 server. Create `test/helpers/immichSamples.js`:

```js
// Response shapes captured from a live Immich v3.0.3 server, with every real
// host name, user name and count replaced. The field names are the contract —
// Immich moved these endpoints from /api/server-info/* to /api/server/* around
// v1.118, so a rename here is exactly the regression these fixtures catch.

export const ABOUT = {
  version: 'v3.0.3',
  versionUrl: 'https://github.com/immich-app/immich/releases/tag/v3.0.3',
  licensed: false,
  nodejs: 'v24.14.1',
  exiftool: '13.59',
  ffmpeg: '7.1.4-3',
};

export const STORAGE = {
  diskAvailable: '624.0 GiB',
  diskSize: '1.0 TiB',
  diskUse: '400.0 GiB',
  diskAvailableRaw: 670014898176,
  diskSizeRaw: 1099511627776,
  diskUseRaw: 429496729600,
  diskUsagePercentage: 39.06,
};

export const STATISTICS = {
  photos: 48300,
  videos: 1200,
  usage: 322122547200,
  usagePhotos: 107374182400,
  usageVideos: 214748364800,
  usageByUser: [
    { userId: 'u-1', userName: 'Example User', photos: 48000, videos: 1150, usage: 311385128960, quotaSizeInBytes: null },
    { userId: 'u-2', userName: 'Second User', photos: 300, videos: 50, usage: 10737418240, quotaSizeInBytes: null },
    { userId: 'u-3', userName: 'Third User', photos: 0, videos: 0, usage: 0, quotaSizeInBytes: null },
  ],
};

const idleQueue = () => ({
  queueStatus: { isPaused: false, isActive: false },
  jobCounts: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
});

// The live server reports fifteen queues; the rollup must sum across all of
// them rather than reading a hand-picked few.
export const JOB_NAMES = [
  'thumbnailGeneration', 'metadataExtraction', 'videoConversion', 'faceDetection',
  'facialRecognition', 'smartSearch', 'duplicateDetection', 'backgroundTask',
  'storageTemplateMigration', 'migration', 'search', 'sidecar', 'library',
  'notifications', 'backupDatabase',
];

export const JOBS_IDLE = Object.fromEntries(JOB_NAMES.map((n) => [n, idleQueue()]));

export const JOBS_BUSY = {
  ...JOBS_IDLE,
  thumbnailGeneration: {
    queueStatus: { isPaused: false, isActive: true },
    jobCounts: { active: 2, completed: 900, failed: 1, delayed: 5, waiting: 100, paused: 0 },
  },
  metadataExtraction: {
    queueStatus: { isPaused: true, isActive: false },
    jobCounts: { active: 1, completed: 40, failed: 2, delayed: 0, waiting: 20, paused: 7 },
  },
};

export const VERSION_CHECK = { checkedAt: '2026-07-28T23:06:00.095Z', releaseVersion: 'v3.0.3' };
export const VERSION_CHECK_NEWER = { checkedAt: '2026-07-28T23:06:00.095Z', releaseVersion: 'v3.1.0' };
export const CONFIG = { trashDays: 30, isInitialized: true, isOnboarded: true, maintenanceMode: false };
export const CONFIG_MAINTENANCE = { ...CONFIG, maintenanceMode: true };
```

- [ ] **Step 2: Write the failing test**

Create `test/immichMetrics.test.js`:

```js
import { test, expect } from 'vitest';
import { buildMetrics, buildJobRollup } from '../src/server/immichMetrics.js';
import {
  ABOUT, STORAGE, STATISTICS, JOBS_IDLE, JOBS_BUSY,
  VERSION_CHECK, VERSION_CHECK_NEWER, CONFIG, CONFIG_MAINTENANCE,
} from './helpers/immichSamples.js';

const build = (over = {}) => buildMetrics({
  about: ABOUT, storage: STORAGE, statistics: STATISTICS, jobs: JOBS_IDLE,
  versionCheck: VERSION_CHECK, config: CONFIG, denied: [], ...over,
});

test('buildJobRollup sums across every queue and names the paused ones', () => {
  const r = buildJobRollup(JOBS_BUSY);
  expect(r.active).toBe(3);
  // waiting folds in `delayed`: a delayed job is queued work the operator has
  // not seen run yet, and splitting the two would understate the backlog.
  expect(r.waiting).toBe(125);
  expect(r.failed).toBe(3);
  expect(r.paused).toEqual(['metadataExtraction']);
});

test('buildJobRollup ignores the cumulative completed counter', () => {
  const r = buildJobRollup(JOBS_BUSY);
  expect(r).not.toHaveProperty('completed');
});

test('buildJobRollup tolerates a malformed queue entry', () => {
  const r = buildJobRollup({ good: JOBS_BUSY.thumbnailGeneration, bad: null, worse: 'nope' });
  expect(r.active).toBe(2);
  expect(r.paused).toEqual([]);
});

test('buildMetrics separates library usage from disk usage', () => {
  const m = build();
  expect(m.libraryBytes).toBe(322122547200);
  expect(m.diskUsedBytes).toBe(429496729600);
  expect(m.diskSizeBytes).toBe(1099511627776);
  expect(m.diskFreeBytes).toBe(670014898176);
});

test('buildMetrics rounds the disk percentage', () => {
  expect(build().diskUsedPct).toBe(39);
});

test('buildMetrics reports no update when the versions match', () => {
  const m = build();
  expect(m.version).toBe('v3.0.3');
  expect(m.updateAvailable).toBe(false);
});

test('buildMetrics reports an update when the release version differs', () => {
  const m = build({ versionCheck: VERSION_CHECK_NEWER });
  expect(m.updateAvailable).toBe(true);
  expect(m.releaseVersion).toBe('v3.1.0');
});

test('buildMetrics ignores a v prefix mismatch rather than crying update', () => {
  const m = build({ versionCheck: { releaseVersion: '3.0.3', checkedAt: null } });
  expect(m.updateAvailable).toBe(false);
});

test('buildMetrics counts users and names the largest consumer', () => {
  const m = build();
  expect(m.users).toBe(3);
  expect(m.topUser).toEqual({ name: 'Example User', bytes: 311385128960 });
});

test('buildMetrics reads maintenance mode', () => {
  expect(build().maintenanceMode).toBe(false);
  expect(build({ config: CONFIG_MAINTENANCE }).maintenanceMode).toBe(true);
});

// The 403-degradation contract: a refused endpoint yields null readings, never
// zeroes. A zero would render as a real "0 photos" and read as data loss.
test('buildMetrics nulls the readings of a refused endpoint', () => {
  const m = build({ statistics: null, jobs: null, denied: ['server.statistics', 'job.read'] });
  expect(m.photos).toBeNull();
  expect(m.videos).toBeNull();
  expect(m.libraryBytes).toBeNull();
  expect(m.users).toBeNull();
  expect(m.topUser).toBeNull();
  expect(m.jobs).toBeNull();
  expect(m.denied).toEqual(['server.statistics', 'job.read']);
  // Storage came from a different endpoint and must survive.
  expect(m.diskUsedPct).toBe(39);
});

test('buildMetrics distinguishes a refused jobs endpoint from genuinely idle queues', () => {
  expect(build({ jobs: JOBS_IDLE }).jobs).toEqual({ active: 0, waiting: 0, failed: 0, paused: [] });
  expect(build({ jobs: null, denied: ['job.read'] }).jobs).toBeNull();
});

test('buildMetrics survives every payload being absent', () => {
  const m = buildMetrics({});
  expect(m.version).toBeNull();
  expect(m.diskUsedPct).toBeNull();
  expect(m.updateAvailable).toBe(false);
  expect(m.maintenanceMode).toBe(false);
  expect(m.denied).toEqual([]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/immichMetrics.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/immichMetrics.js"`

- [ ] **Step 4: Write the implementation**

Create `src/server/immichMetrics.js`:

```js
// Pure shaping of Immich API payloads into the metrics object the dashboard
// card renders. No I/O lives here, so every layout decision the card depends on
// is testable without a server — the same model/DOM split unifiMetrics.js uses.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Immich reports "v3.0.3" from /server/about but a bare "3.0.3" is a plausible
// shape from /server/version-check, and a prefix mismatch must not read as an
// available update.
const normVersion = (v) => String(v ?? '').trim().replace(/^v/i, '');
const str = (v) => (v == null || v === '' ? null : String(v));

// One rollup across every queue the server reports — fifteen on v3.0.3, and the
// list grows between releases, so this iterates rather than naming them.
export function buildJobRollup(jobs) {
  const out = { active: 0, waiting: 0, failed: 0, paused: [] };
  if (!jobs || typeof jobs !== 'object') return out;
  for (const [name, queue] of Object.entries(jobs)) {
    if (!queue || typeof queue !== 'object') continue;
    const counts = queue.jobCounts || {};
    out.active += num(counts.active) ?? 0;
    // A delayed job is queued work that has not run yet; folding it into
    // waiting is what keeps the backlog figure honest.
    out.waiting += (num(counts.waiting) ?? 0) + (num(counts.delayed) ?? 0);
    out.failed += num(counts.failed) ?? 0;
    // Named rather than counted: a tally cannot tell you which queue to restart.
    if (queue.queueStatus?.isPaused === true) out.paused.push(name);
  }
  return out;
}

export function buildMetrics({
  about = null, storage = null, statistics = null,
  jobs = null, versionCheck = null, config = null, denied = [],
} = {}) {
  const version = str(about?.version);
  const releaseVersion = str(versionCheck?.releaseVersion);
  const byUser = Array.isArray(statistics?.usageByUser) ? statistics.usageByUser : null;
  // The largest consumer, so the row points at something rather than merely
  // counting. /api/users is deliberately never called — it returns email
  // addresses, and usageByUser already carries the names.
  const top = byUser?.length
    ? byUser.reduce((best, u) => ((num(u?.usage) ?? 0) > (num(best?.usage) ?? -1) ? u : best), null)
    : null;
  const pct = num(storage?.diskUsagePercentage);

  return {
    version,
    releaseVersion,
    updateAvailable: !!(version && releaseVersion && normVersion(version) !== normVersion(releaseVersion)),
    checkedAt: str(versionCheck?.checkedAt),
    photos: num(statistics?.photos),
    videos: num(statistics?.videos),
    libraryBytes: num(statistics?.usage),
    users: byUser ? byUser.length : null,
    topUser: top ? { name: str(top.userName) ?? 'unknown', bytes: num(top.usage) } : null,
    diskUsedBytes: num(storage?.diskUseRaw),
    diskSizeBytes: num(storage?.diskSizeRaw),
    diskFreeBytes: num(storage?.diskAvailableRaw),
    // The server reports a float (39.06); a dashboard row has no use for it.
    diskUsedPct: pct == null ? null : Math.round(pct),
    // null means "this key may not read the queues", which is a different
    // statement from a rollup of zeroes meaning "the queues are idle".
    jobs: jobs == null ? null : buildJobRollup(jobs),
    maintenanceMode: config?.maintenanceMode === true,
    denied: [...denied],
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/immichMetrics.test.js`
Expected: PASS — 12 tests

- [ ] **Step 6: Commit**

```bash
git add src/server/immichMetrics.js test/immichMetrics.test.js test/helpers/immichSamples.js
git commit -m "feat(immich): shape server payloads into dashboard metrics"
```

---

### Task 2: The API client

**Files:**
- Create: `src/server/immichApi.js`
- Create: `test/helpers/fakeImmich.js`
- Test: `test/immichApi.test.js`

**Deviation from the spec, deliberate.** The spec's test table lists both an
`immichApi.test.js` (injected `request`) and a separate
`immichApi.integration.test.js` (real HTTP server). This plan consolidates them
into one file that uses the real `startFakeImmich` server throughout — the same
thing `test/unifiApi.test.js` does. The `request` injection seam still exists on
the client for callers who want it, but there is no behaviour a stub could reach
that the loopback fixture cannot, so a second file would only duplicate
coverage. If a future case genuinely needs a stub (a transport error no real
socket produces, say), add it then.

**Interfaces:**
- Consumes: `buildMetrics` from Task 1.
- Produces:
  - `normalizeBase(raw) -> string`
  - `createImmichClient({ baseUrl, apiKey, insecure, timeoutMs, ttlMs, now, request }) -> { probe(), snapshot() }`
  - `snapshot()` resolves `{ ok: true, metrics }` or `{ ok: false, kind: 'auth'|'unreachable'|'unexpected', error }`
  - `probe()` resolves `{ ok: true, version, denied }` or `{ ok: false, kind, error }`
  - Task 3 passes this as `makeClient`; Task 4 consumes `snapshot()`; Task 5 consumes `probe()`.

- [ ] **Step 1: Write the fake server**

Create `test/helpers/fakeImmich.js`:

```js
import http from 'node:http';
import {
  ABOUT, STORAGE, STATISTICS, JOBS_IDLE, VERSION_CHECK, CONFIG,
} from './immichSamples.js';

// A real HTTP server speaking the Immich REST shapes, so the client tests
// exercise the actual request path (no mocks — the repo convention). Per-path
// counters are what the snapshot-TTL test asserts against.
//
// `deny` is the list of paths that answer 403, which is how the permission-
// degradation contract is exercised without needing a scoped key.
export async function startFakeImmich({
  apiKey = 'test-key',
  about = ABOUT,
  storage = STORAGE,
  statistics = STATISTICS,
  jobs = JOBS_IDLE,
  versionCheck = VERSION_CHECK,
  config = CONFIG,
  deny = [],              // e.g. ['/api/server/statistics']
  unauthorized = false,   // every path answers 401
  malformed = false,
  status = {},            // path -> status override, e.g. { '/api/jobs': 500 }
} = {}) {
  const counts = { requests: 0 };
  const bodies = {
    '/api/server/about': about,
    '/api/server/storage': storage,
    '/api/server/statistics': statistics,
    '/api/jobs': jobs,
    '/api/server/version-check': versionCheck,
    '/api/server/config': config,
  };
  for (const p of Object.keys(bodies)) counts[p] = 0;

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(malformed ? '{not json' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    counts.requests++;
    // The integration is read-only; a fixture that answered another verb would
    // let a regression through silently.
    if (req.method !== 'GET') { send(res, 405, { error: 'read-only fixture' }); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (unauthorized || req.headers['x-api-key'] !== apiKey) { send(res, 401, { error: 'Unauthorized' }); return; }
    if (!(path in bodies)) { send(res, 404, { error: 'not found' }); return; }
    counts[path]++;
    if (deny.includes(path)) { send(res, 403, { error: 'Forbidden' }); return; }
    if (status[path]) { send(res, status[path], { error: 'boom' }); return; }
    send(res, 200, bodies[path]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/immichApi.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { createImmichClient, normalizeBase } from '../src/server/immichApi.js';
import { startFakeImmich } from './helpers/fakeImmich.js';

let fake = null;
afterEach(async () => { await fake?.stop(); fake = null; });

const client = (over = {}) => createImmichClient({ baseUrl: fake.baseUrl, apiKey: 'test-key', ttlMs: 0, ...over });

test('normalizeBase strips trailing slashes', () => {
  expect(normalizeBase('https://immich.example.com/')).toBe('https://immich.example.com');
  expect(normalizeBase('https://immich.example.com///')).toBe('https://immich.example.com');
});

// Pasting the API base rather than the web base would otherwise build
// /api/api/server/about and 404 with no clue why.
test('normalizeBase strips a trailing /api segment', () => {
  expect(normalizeBase('https://immich.example.com/api')).toBe('https://immich.example.com');
  expect(normalizeBase('https://immich.example.com/api/')).toBe('https://immich.example.com');
});

test('normalizeBase leaves a path that merely contains api alone', () => {
  expect(normalizeBase('https://example.com/apiary')).toBe('https://example.com/apiary');
});

test('snapshot assembles metrics from the live endpoints', async () => {
  fake = await startFakeImmich();
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBe('v3.0.3');
  expect(res.metrics.photos).toBe(48300);
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.jobs).toEqual({ active: 0, waiting: 0, failed: 0, paused: [] });
  expect(res.metrics.denied).toEqual([]);
});

// The fixture answers 405 to any verb but GET, and a 405 degrades its endpoint
// to null. If any call ever stopped being a GET, the reading it feeds would go
// missing here rather than failing loudly somewhere else.
test('every endpoint is fetched with GET', async () => {
  fake = await startFakeImmich();
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBe('v3.0.3');
  expect(res.metrics.photos).toBe(48300);
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.jobs).not.toBeNull();
  expect(res.metrics.maintenanceMode).toBe(false);
});

test('snapshot reports auth rather than down when the key is rejected', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
});

// The heart of the degradation contract: a 403 proves the server answered, so
// the tile stays up and only the refused readings go missing.
test('snapshot degrades a 403 endpoint instead of failing the tile', async () => {
  fake = await startFakeImmich({ deny: ['/api/server/statistics', '/api/jobs'] });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.denied).toEqual(expect.arrayContaining(['server.statistics', 'job.read']));
  expect(res.metrics.photos).toBeNull();
  expect(res.metrics.jobs).toBeNull();
  // The permitted endpoints still report.
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.version).toBe('v3.0.3');
});

// An older server that does not implement an endpoint answers 404, which must
// cost that endpoint's readings and nothing else — the same tolerance
// unifiApi.js extends to firmware without /statistics/latest.
test('snapshot degrades a 404 endpoint the same way it degrades a 403', async () => {
  fake = await startFakeImmich({ status: { '/api/server/config': 404 } });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.maintenanceMode).toBe(false);
  expect(res.metrics.denied).toContain('systemConfig.read');
  expect(res.metrics.version).toBe('v3.0.3');
});

test('snapshot reports down only when every endpoint fails at the transport layer', async () => {
  fake = await startFakeImmich();
  const dead = `http://127.0.0.1:${1}`; // port 1: connection refused
  const res = createImmichClient({ baseUrl: dead, apiKey: 'k', ttlMs: 0, timeoutMs: 1000 });
  const out = await res.snapshot();
  expect(out.ok).toBe(false);
  expect(out.kind).toBe('unreachable');
});

test('snapshot tolerates a single endpoint erroring with 500', async () => {
  fake = await startFakeImmich({ status: { '/api/jobs': 500 } });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.jobs).toBeNull();
  expect(res.metrics.photos).toBe(48300);
});

test('snapshot serves the cached result until the ttl expires', async () => {
  fake = await startFakeImmich();
  let t = 1000;
  const c = client({ ttlMs: 30000, now: () => t });
  await c.snapshot();
  const after = fake.counts['/api/server/about'];
  await c.snapshot();
  expect(fake.counts['/api/server/about']).toBe(after); // inside the window: no traffic
  t += 30001;
  await c.snapshot();
  expect(fake.counts['/api/server/about']).toBe(after + 1);
});

test('snapshot does not cache a failure', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const c = client({ ttlMs: 30000, now: () => 1000 });
  await c.snapshot();
  const after = fake.counts.requests;
  await c.snapshot();
  expect(fake.counts.requests).toBeGreaterThan(after);
});

test('probe reports the version and which permissions are missing', async () => {
  fake = await startFakeImmich({ deny: ['/api/server/statistics'] });
  const res = await client().probe();
  expect(res.ok).toBe(true);
  expect(res.version).toBe('v3.0.3');
  expect(res.denied).toEqual(['server.statistics']);
});

test('probe reports a rejected key', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const res = await client().probe();
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/API key/i);
});

test('an unparseable body degrades that endpoint rather than throwing', async () => {
  fake = await startFakeImmich({ malformed: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBeNull();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/immichApi.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/immichApi.js"`

- [ ] **Step 4: Write the implementation**

Create `src/server/immichApi.js`:

```js
import http from 'node:http';
import https from 'node:https';
import { buildMetrics } from './immichMetrics.js';

// Dependency-free client for the Immich REST API, in the mold of netboxApi.js.
// GET only: there is deliberately no code path here that issues another verb,
// so the API key's blast radius stays at reads.
//
// Verified against Immich v3.0.3. The endpoints moved from /api/server-info/*
// to /api/server/* around v1.118, so this targets the modern paths only.
const DEFAULT_TTL_MS = 30000;

// Each endpoint carries the permission Immich requires for it, so a 403 can
// tell the operator exactly what to grant rather than just failing.
const ENDPOINTS = [
  { key: 'about', path: '/api/server/about', permission: 'server.about' },
  { key: 'storage', path: '/api/server/storage', permission: 'server.storage' },
  { key: 'statistics', path: '/api/server/statistics', permission: 'server.statistics' },
  { key: 'jobs', path: '/api/jobs', permission: 'job.read' },
  { key: 'versionCheck', path: '/api/server/version-check', permission: 'server.versionCheck' },
  { key: 'config', path: '/api/server/config', permission: 'systemConfig.read' },
];

// An operator who pastes the API base rather than the web base would otherwise
// build /api/api/server/about and get a silent 404 storm.
export function normalizeBase(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

function jsonRequest({ url, headers = {}, timeoutMs = 10000, insecure = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      // Verified by default because this request carries a credential; the
      // opt-out is per-service and applies only to https.
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* reported as unexpected */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Immich request timed out')));
    req.on('error', reject);
    req.end();
  });
}

export function createImmichClient({
  baseUrl, apiKey, insecure = false,
  timeoutMs = 10000, ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(), request = jsonRequest,
} = {}) {
  const base = normalizeBase(baseUrl);
  let cached = null; // { at, metrics }

  async function fetchOne(endpoint) {
    let res;
    try {
      res = await request({
        url: `${base}${endpoint.path}`,
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        timeoutMs,
        insecure,
      });
    } catch (e) {
      return { kind: 'unreachable', error: e?.message || 'request failed' };
    }
    if (res.status === 401) return { kind: 'auth', error: 'the server rejected the API key (HTTP 401)' };
    // 403: a valid key without this permission. 404: a server version that does
    // not implement the endpoint. Both cost their own readings and nothing else.
    if (res.status === 403 || res.status === 404) return { kind: 'denied' };
    if (res.status < 200 || res.status >= 300) return { kind: 'unexpected' };
    if (res.json == null) return { kind: 'unexpected' };
    return { kind: 'ok', json: res.json };
  }

  async function refresh() {
    const settled = await Promise.all(
      ENDPOINTS.map(async (endpoint) => ({ endpoint, result: await fetchOne(endpoint) })),
    );

    // A 403 is proof the server answered, so liveness needs no separate ping
    // call: only a total transport failure means the server is actually down.
    if (settled.every(({ result }) => result.kind === 'unreachable')) {
      return { ok: false, kind: 'unreachable', error: settled[0].result.error };
    }
    const rejected = settled.find(({ result }) => result.kind === 'auth');
    if (rejected) return { ok: false, kind: 'auth', error: rejected.result.error };

    const payloads = {};
    const denied = [];
    for (const { endpoint, result } of settled) {
      if (result.kind === 'ok') payloads[endpoint.key] = result.json;
      else if (result.kind === 'denied') denied.push(endpoint.permission);
    }
    return { ok: true, metrics: buildMetrics({ ...payloads, denied }) };
  }

  return {
    // Used by the settings Test button: proves the key works and reports which
    // permissions are missing, so a scoped key can be fixed before saving.
    async probe() {
      const res = await refresh();
      if (!res.ok) return res;
      return { ok: true, version: res.metrics.version, denied: res.metrics.denied };
    },

    // Used by the sweep. Only successes are cached: a transient failure must not
    // pin the tile to an error for the rest of the TTL window.
    async snapshot() {
      if (cached && now() - cached.at < ttlMs) return { ok: true, metrics: cached.metrics };
      const res = await refresh();
      if (res.ok) cached = { at: now(), metrics: res.metrics };
      return res;
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/immichApi.test.js`
Expected: PASS — 15 tests

- [ ] **Step 6: Commit**

```bash
git add src/server/immichApi.js test/immichApi.test.js test/helpers/fakeImmich.js
git commit -m "feat(immich): add the read-only API client with per-endpoint degradation"
```

---

### Task 3: Store validation and the client registry

**Files:**
- Create: `src/server/immichRegistry.js`
- Modify: `src/server/servicesStore.js` (`KINDS`, `SECRET_KINDS`, `normalizeCheck`)
- Test: `test/servicesStore.test.js` (append), `test/immichRegistry.test.js` (create)

**Interfaces:**
- Consumes: `createImmichClient` from Task 2.
- Produces: `createImmichRegistry({ store, makeClient, timeoutMs }) -> { clientFor, retain, closeAll }`. Task 4 consumes it. `check.kind === 'immich'` records validate with optional `target` and optional `insecure`.

- [ ] **Step 1: Write the failing store tests**

Append to `test/servicesStore.test.js`:

```js
test('accepts an immich check with an http target', async () => {
  const store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('s') });
  const svc = await store.addService({
    name: 'Photos', url: 'http://192.168.1.10:2283',
    check: { kind: 'immich', target: 'http://192.168.1.10:2283' }, password: 'key-1',
  });
  expect(svc.check.kind).toBe('immich');
  expect(svc.check.target).toBe('http://192.168.1.10:2283');
  // The key never comes back out of a read.
  expect(svc.hasPassword).toBe(true);
  expect(svc).not.toHaveProperty('secret');
  expect(await store.getServiceSecret(svc.id)).toBe('key-1');
});

test('an immich check needs no target — it defaults to the tile url', async () => {
  const store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('s') });
  const svc = await store.addService({
    name: 'Photos', url: 'https://immich.example.com', check: { kind: 'immich' },
  });
  expect(svc.check).toEqual({ kind: 'immich' });
});

test('rejects an immich target that is not http(s)', async () => {
  const store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('s') });
  await expect(store.addService({
    name: 'Photos', url: 'https://immich.example.com',
    check: { kind: 'immich', target: 'ftp://immich.example.com' },
  })).rejects.toThrow(/http\(s\)/);
});

// The PATCH-merge trap: normalizeCheck spreads {...base, ...raw}, so a form that
// omits `insecure` can never turn it off. The form states it outright; this
// locks that in from the store's side.
test('an immich insecure flag can be cleared, not only set', async () => {
  const store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('s') });
  const svc = await store.addService({
    name: 'Photos', url: 'https://immich.example.com',
    check: { kind: 'immich', insecure: true },
  });
  expect(svc.check.insecure).toBe(true);
  const updated = await store.updateService(svc.id, { check: { kind: 'immich', insecure: false } });
  expect(updated.check.insecure).toBeUndefined();
});

test('changing an immich record to a kind with no credential drops the sealed key', async () => {
  const store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('s') });
  const svc = await store.addService({
    name: 'Photos', url: 'https://immich.example.com',
    check: { kind: 'immich' }, password: 'key-1',
  });
  const updated = await store.updateService(svc.id, { check: { kind: 'http' } });
  expect(updated.hasPassword).toBe(false);
  expect(await store.getServiceSecret(svc.id)).toBeNull();
});
```

> If `dir` / `createSecretBox` are not already in scope in this file under those
> names, match whatever the existing tests in `test/servicesStore.test.js` use —
> do not introduce a second setup style.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — `check.kind must be http, tcp, pihole, truenas, unifi, or none`

- [ ] **Step 3: Modify `src/server/servicesStore.js`**

Change the `KINDS` constant (line 10) to add `'immich'`:

```js
const KINDS = ['http', 'tcp', 'none', 'pihole', 'truenas', 'unifi', 'immich'];
```

Change `SECRET_KINDS` (line 14):

```js
const SECRET_KINDS = new Set(['pihole', 'truenas', 'unifi', 'immich']);
```

Update the error message inside `normalizeCheck` (line 48):

```js
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, pihole, truenas, unifi, immich, or none');
```

Add the `immich` branch immediately after the `pihole` branch (after line 73, before the `truenas` branch):

```js
  if (kind === 'immich') {
    // The Immich REST API base. Empty means "use the tile's own url", which is
    // the common case: the link and the API live on the same host.
    const out = { kind };
    if (target) { assertHttpUrl(target, 'check.target'); out.target = target; }
    // Plain http is allowed, unlike truenas and unifi — an Immich key survives
    // plaintext use and can be scoped to reads, and the standard self-hosted
    // deployment is http on a LAN. On https, verified TLS is the default and
    // this is the per-service opt-out.
    if (merged.insecure === true) out.insecure = true;
    return out;
  }
```

- [ ] **Step 4: Run to verify the store tests pass**

Run: `npx vitest run test/servicesStore.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing registry test**

Create `test/immichRegistry.test.js`:

```js
import { test, expect } from 'vitest';
import { createImmichRegistry } from '../src/server/immichRegistry.js';

const svc = (over = {}) => ({ id: 'svc-1', url: 'https://immich.example.com', check: { kind: 'immich' }, ...over });

function harness(secret = 'key-1') {
  const built = [];
  const closed = [];
  const store = { getServiceSecret: async () => secret };
  const makeClient = (options) => {
    built.push(options);
    return { options, close: async () => { closed.push(options); } };
  };
  return { built, closed, registry: createImmichRegistry({ store, makeClient }) };
}

test('builds one client per service and reuses it', async () => {
  const h = harness();
  const a = await h.registry.clientFor(svc());
  const b = await h.registry.clientFor(svc());
  expect(a).toBe(b);
  expect(h.built).toHaveLength(1);
});

test('derives the base url from the check target, falling back to the tile url', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  expect(h.built[0].baseUrl).toBe('https://immich.example.com');
  await h.registry.clientFor(svc({ id: 'svc-2', check: { kind: 'immich', target: 'http://192.168.1.10:2283' } }));
  expect(h.built[1].baseUrl).toBe('http://192.168.1.10:2283');
});

test('rebuilds the client when the insecure flag changes', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  await h.registry.clientFor(svc({ check: { kind: 'immich', insecure: true } }));
  expect(h.built).toHaveLength(2);
  expect(h.built[1].insecure).toBe(true);
});

test('retain closes the clients of services that have gone away', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  await h.registry.retain([]);
  expect(h.closed).toHaveLength(1);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/immichRegistry.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/immichRegistry.js"`

- [ ] **Step 7: Create `src/server/immichRegistry.js`**

```js
import { createImmichClient } from './immichApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One Immich client per service id. See serviceClientRegistry.js for the caching
// and lifetime rules. An Immich client is defined by its API base, the API key,
// and the TLS mode — change any of those and the cached client (with its
// snapshot) is replaced.
export function createImmichRegistry({ store, makeClient = createImmichClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || ''),
      apiKey: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/immichRegistry.test.js test/servicesStore.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/server/immichRegistry.js src/server/servicesStore.js test/immichRegistry.test.js test/servicesStore.test.js
git commit -m "feat(immich): validate the immich check kind and cache one client per service"
```

---

### Task 4: Sweep integration

**Files:**
- Modify: `src/server/serviceCheck.js` (add `checkImmich`, extend `checkService`)
- Modify: `src/server/serviceChecker.js` (accept + retain `immichRegistry`)
- Modify: `src/server/index.js` (construct the registry, pass it, close it on shutdown)
- Test: `test/serviceCheck.test.js` (append)

**Interfaces:**
- Consumes: `createImmichRegistry` from Task 3, `snapshot()` from Task 2.
- Produces: `checkImmich(service, { immichRegistry }) -> { state, latencyMs, immich?, error? }`. `checkService` dispatches `kind === 'immich'` to it. The `immich` field on the result is what Task 6's card reads.

- [ ] **Step 1: Write the failing test**

Append to `test/serviceCheck.test.js`:

```js
test('checkImmich reports metrics when the snapshot succeeds', async () => {
  const metrics = { version: 'v3.0.3', photos: 10, denied: [] };
  const immichRegistry = { clientFor: async () => ({ snapshot: async () => ({ ok: true, metrics }) }) };
  const res = await checkService({ id: 's', check: { kind: 'immich' } }, { immichRegistry });
  expect(res.state).toBe('up');
  expect(res.immich).toBe(metrics);
  expect(typeof res.latencyMs).toBe('number');
});

// auth is deliberately distinct from down: a rotated key means the server is
// answering perfectly well, and painting it red would cry wolf.
test('checkImmich reports auth rather than down when the key is rejected', async () => {
  const immichRegistry = {
    clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'auth', error: 'nope' }) }),
  };
  const res = await checkService({ id: 's', check: { kind: 'immich' } }, { immichRegistry });
  expect(res.state).toBe('auth');
  expect(res.error).toBe('nope');
});

test('checkImmich names the missing credential when none is stored', async () => {
  const immichRegistry = {
    clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'auth', error: 'nope' }) }),
  };
  const res = await checkService(
    { id: 's', hasPassword: false, check: { kind: 'immich' } },
    { immichRegistry },
  );
  expect(res.state).toBe('auth');
  expect(res.error).toMatch(/no API key configured/);
});

test('checkImmich reports down when the server is unreachable', async () => {
  const immichRegistry = {
    clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'unreachable', error: 'refused' }) }),
  };
  const res = await checkService({ id: 's', check: { kind: 'immich' } }, { immichRegistry });
  expect(res.state).toBe('down');
});

test('checkImmich reports down when no registry is wired', async () => {
  const res = await checkService({ id: 's', check: { kind: 'immich' } }, {});
  expect(res.state).toBe('down');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/serviceCheck.test.js`
Expected: FAIL — the `immich` kind falls through to `checkHttp` and reports `down`/`invalid url`, so `res.immich` is undefined

- [ ] **Step 3: Modify `src/server/serviceCheck.js`**

Add after `checkUnifi` (after line 125):

```js
// An Immich check reports the photo library, not just reachability. As with the
// other credentialed kinds the `auth` state is deliberately distinct from
// `down`. A 403 is not auth: the key is valid and the server answered, so the
// client degrades those readings and the tile stays up (see immichApi.js).
export async function checkImmich(service, { immichRegistry } = {}) {
  if (!immichRegistry) return { state: 'down', error: 'immich client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await immichRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'immich client setup failed' };
  }
  const res = await client.snapshot();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, immich: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}
```

Add the dispatch line inside `checkService`, after the `unifi` line:

```js
  if (kind === 'immich') return checkImmich(service, opts);
```

- [ ] **Step 4: Modify `src/server/serviceChecker.js`**

Add `immichRegistry = null,` to the destructured parameters (line 9), pass it through the check call (line 24), and add the retain block after the `unifiRegistry` one:

```js
      if (immichRegistry) {
        await immichRegistry.retain(services.filter((s) => s.check?.kind === 'immich').map((s) => s.id));
      }
```

The check call becomes:

```js
        next[s.id] = await check(s, { piholeRegistry, truenasRegistry, unifiRegistry, immichRegistry });
```

- [ ] **Step 5: Modify `src/server/index.js`**

Add the import beside the other registry imports (after line 14):

```js
import { createImmichRegistry } from './immichRegistry.js';
```

Construct it beside the others (after line 272) and pass it to the checker:

```js
const immichRegistry = createImmichRegistry({ store: servicesStore });
const serviceChecker = createServiceChecker({ store: servicesStore, piholeRegistry, truenasRegistry, unifiRegistry, immichRegistry, intervalMs: config.servicePollMs });
```

Add it to the shutdown flush list, after the `unifiRegistry.closeAll()` entry:

```js
        // Like UniFi, the Immich client holds no server-side session; retiring
        // it here keeps every registry on one shutdown path rather than two rules.
        () => immichRegistry.closeAll(),
```

- [ ] **Step 6: Run the full server test suite**

Run: `npx vitest run test/serviceCheck.test.js test/serviceChecker.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/serviceCheck.js src/server/serviceChecker.js src/server/index.js test/serviceCheck.test.js
git commit -m "feat(immich): sweep immich tiles and retire their clients"
```

---

### Task 5: The test route and the web fetch layer

**Files:**
- Modify: `src/server/server.js` (import, `buildServer` parameter, `POST /api/services/immich/test`)
- Modify: `src/web/api.ts` (`ServiceCheckKind`, `ImmichMetrics`, `ServiceResult.immich`, `api.testImmich`)
- Test: `test/serviceRoutes.test.js` (append)

**Interfaces:**
- Consumes: `createImmichClient` from Task 2.
- Produces: `POST /api/services/immich/test` returning `{ ok: true, version, denied }` or `{ ok: false, error }`; `api.testImmich(body)`; the `ImmichMetrics` TypeScript interface Task 6's card consumes.

- [ ] **Step 1: Write the failing route test**

Append to `test/serviceRoutes.test.js`. Unlike the UniFi and TrueNAS routes, the Immich route permits `http:`, so a loopback fixture can be probed end-to-end through the real client:

```js
test('POST /api/services/immich/test probes a real server and reports missing permissions', async () => {
  const fake = await startFakeImmich({ deny: ['/api/server/statistics'] });
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/services/immich/test', cookies: authCookie,
      payload: { url: fake.baseUrl, apiKey: 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe('v3.0.3');
    expect(body.denied).toEqual(['server.statistics']);
  } finally {
    await fake.stop();
  }
});

test('POST /api/services/immich/test rejects a non-http(s) url before building a client', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/services/immich/test', cookies: authCookie,
    payload: { url: 'ftp://immich.example.com', apiKey: 'k' },
  });
  expect(res.json()).toEqual({ ok: false, error: expect.stringMatching(/valid http\(s\) URL/) });
});

test('POST /api/services/immich/test falls back to the stored key when none is posted', async () => {
  const fake = await startFakeImmich();
  try {
    const svc = await servicesStore.addService({
      name: 'Photos', url: fake.baseUrl, check: { kind: 'immich' }, password: 'test-key',
    });
    const res = await app.inject({
      method: 'POST', url: '/api/services/immich/test', cookies: authCookie,
      payload: { url: fake.baseUrl, id: svc.id },
    });
    expect(res.json().ok).toBe(true);
  } finally {
    await fake.stop();
  }
});

test('POST /api/services/immich/test requires authentication', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/services/immich/test', payload: { url: 'http://x' } });
  expect(res.statusCode).toBe(401);
});
```

Add the import at the top of the file:

```js
import { startFakeImmich } from './helpers/fakeImmich.js';
```

> `authCookie` is whatever the existing tests in this file use to authenticate —
> reuse that exact value rather than inventing a second mechanism.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL — 404, the route does not exist

- [ ] **Step 3: Modify `src/server/server.js`**

Add the import beside the other service-client imports (after line 20):

```js
import { createImmichClient } from './immichApi.js';
```

Add the injectable seam to the `buildServer` destructured parameters, immediately after `makeUnifiClient = createUnifiClient,`:

```js
makeImmichClient = createImmichClient,
```

Add the route immediately after the UniFi test route (after line 953):

```js
  // Same rationale as the other probes: save-and-pray is a poor way to discover
  // the key is wrong. This one also reports which permissions the key is
  // missing, so a deliberately least-privilege key can be fixed before saving
  // rather than producing a card full of dashes afterwards.
  app.post('/api/services/immich/test', { preHandler: requireAuth }, async (req) => {
    const { url, apiKey, insecure, id } = req.body || {};
    const value = typeof url === 'string' ? url.trim() : '';
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('must be http(s)');
    } catch {
      return { ok: false, error: 'enter a valid http(s) URL for the Immich server' };
    }
    // A blank key on an existing service means "use the one already stored", so
    // Test works while editing without retyping the secret.
    let key = typeof apiKey === 'string' ? apiKey : '';
    if (!key && id) key = (await servicesStore.getServiceSecret(id)) || '';
    const client = makeImmichClient({ baseUrl: value, apiKey: key, insecure: insecure === true });
    const res = await client.probe();
    return res.ok ? { ok: true, version: res.version, denied: res.denied } : { ok: false, error: res.error };
  });
```

- [ ] **Step 4: Modify `src/web/api.ts`**

Change `ServiceCheckKind` (line 36):

```ts
export type ServiceCheckKind = 'http' | 'tcp' | 'none' | 'pihole' | 'truenas' | 'unifi' | 'immich';
```

Add the metrics interfaces after `UnifiMetrics` (after line 113):

```ts
export interface ImmichJobs { active: number; waiting: number; failed: number; paused: string[] }
export interface ImmichMetrics {
  version: string | null;
  releaseVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  photos: number | null;
  videos: number | null;
  libraryBytes: number | null;
  users: number | null;
  topUser: { name: string; bytes: number | null } | null;
  diskUsedBytes: number | null;
  diskSizeBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPct: number | null;
  // null means the key may not read the queues, which is a different statement
  // from a rollup of zeroes meaning the queues are idle.
  jobs: ImmichJobs | null;
  maintenanceMode: boolean;
  // Immich permissions the key lacks, e.g. 'server.statistics'.
  denied: string[];
}
```

Add to `ServiceResult` (after line 123):

```ts
  immich?: ImmichMetrics;
```

Add the fetch method after `testUnifi` (after line 242):

```ts
  async testImmich(body: { url: string; apiKey?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; denied?: string[]; error?: string }>(
      await fetch('/api/services/immich/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm run typecheck && npx vitest run test/serviceRoutes.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/web/api.ts test/serviceRoutes.test.js
git commit -m "feat(immich): add the settings test route and web fetch layer"
```

---

### Task 6: The dashboard card

**Files:**
- Create: `src/web/immichCard.ts`
- Modify: `src/web/unifiCard.ts` (rename its private row classes to the shared ones)
- Modify: `src/web/style.css` (rename `.dash-unifi-*` → `.dash-card-row*`, add `.dash-card-note`)
- Test: `test/immichCard.test.js`

**Interfaces:**
- Consumes: `ImmichMetrics`, `ServiceResult`, `ServiceStatusSnapshot`, `Service` from Task 5; `fmtBytes`, `fmtCount`, `fmtCompact` from `./fmt`; `buildServiceIcon` from `./serviceIcon`.
- Produces: `immichCardModel(svc, snap) -> ImmichCard`, `immichLamp(r) -> ImmichLamp`, `deniedNote(denied) -> string`, `immichException(m) -> string`, constants `DISK_WARN_PCT`, `DISK_CRIT_PCT`, `MAX_NAMED_PAUSED`, and `buildImmichCard() -> ImmichCardEls`. Task 7 consumes `buildImmichCard`.

- [ ] **Step 1: Write the failing test**

Create `test/immichCard.test.js`:

```js
import { test, expect } from 'vitest';
import {
  immichCardModel, immichLamp, deniedNote, immichException,
  DISK_WARN_PCT, DISK_CRIT_PCT,
} from '../src/web/immichCard.ts';

const svc = { id: 's1', name: 'Photos', url: 'https://immich.example.com', check: { kind: 'immich' }, createdAt: '' };

const metrics = (over = {}) => ({
  version: 'v3.0.3', releaseVersion: 'v3.0.3', updateAvailable: false, checkedAt: null,
  photos: 48300, videos: 1200, libraryBytes: 322122547200,
  users: 3, topUser: { name: 'Example User', bytes: 311385128960 },
  diskUsedBytes: 429496729600, diskSizeBytes: 1099511627776,
  diskFreeBytes: 670014898176, diskUsedPct: 39,
  jobs: { active: 0, waiting: 0, failed: 0, paused: [] },
  maintenanceMode: false, denied: [],
  ...over,
});

const snap = (result) => ({ checkedAt: null, results: { s1: result } });
const up = (over = {}) => snap({ state: 'up', latencyMs: 8, immich: metrics(over) });

test('lamp is green on a healthy server', () => {
  expect(immichLamp({ state: 'up', immich: metrics() })).toBe('green');
});

test('lamp is auth on a rejected key, outranking every metric', () => {
  expect(immichLamp({ state: 'auth', immich: metrics({ diskUsedPct: 99 }) })).toBe('auth');
});

test('lamp is red when the server is unreachable', () => {
  expect(immichLamp({ state: 'down' })).toBe('red');
});

test('lamp escalates with disk usage across the named thresholds', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_WARN_PCT - 1 }) })).toBe('green');
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_WARN_PCT }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_CRIT_PCT }) })).toBe('red');
});

test('lamp is amber on failed jobs, a paused queue, or maintenance mode', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ jobs: { active: 0, waiting: 0, failed: 2, paused: [] } }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused: ['smartSearch'] } }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ maintenanceMode: true }) })).toBe('amber');
});

// A dashboard that turns amber every time upstream cuts a release is one the
// operator stops reading.
test('an available update never drives the lamp', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ updateAvailable: true, releaseVersion: 'v3.1.0' }) })).toBe('green');
});

// A least-privilege key is a configuration, not a fault.
test('denied permissions never drive the lamp', () => {
  const m = metrics({ denied: ['server.statistics'], photos: null, videos: null, libraryBytes: null, users: null, topUser: null });
  expect(immichLamp({ state: 'up', immich: m })).toBe('green');
});

test('deniedNote names the permissions and the readings they cost', () => {
  expect(deniedNote([])).toBe('');
  expect(deniedNote(['server.statistics'])).toBe('needs server.statistics for library counts');
  expect(deniedNote(['server.statistics', 'job.read']))
    .toBe('needs server.statistics and job.read for library counts and jobs');
});

test('exception ranks maintenance mode above failed jobs above paused queues', () => {
  const busted = { active: 0, waiting: 0, failed: 2, paused: ['smartSearch'] };
  expect(immichException(metrics({ maintenanceMode: true, jobs: busted }))).toMatch(/maintenance mode/);
  expect(immichException(metrics({ jobs: busted }))).toBe('2 failed jobs');
  expect(immichException(metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused: ['smartSearch'] } })))
    .toBe('smartSearch paused');
  expect(immichException(metrics())).toBe('');
});

test('exception counts paused queues beyond the named cap', () => {
  const paused = ['a', 'b', 'c', 'd', 'e'];
  expect(immichException(metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused } })))
    .toBe('a, b, c +2 more paused');
});

test('model renders six cells with library and disk kept distinct', () => {
  const m = immichCardModel(svc, up());
  expect(m.cells.map((c) => c.label)).toEqual(['PHOTOS', 'VIDEOS', 'LIBRARY', 'DISK', 'FREE', 'VERSION']);
  expect(m.cells[0].value).toBe('48.3k');
  expect(m.cells[1].value).toBe('1,200');
  expect(m.cells[2].value).toBe('300 GB');   // library
  expect(m.cells[3].value).toBe('39%');       // disk
  expect(m.cells[4].value).toBe('624 GB');
  expect(m.cells[5].value).toBe('v3.0.3');
});

test('model dashes the cells a refused permission cannot fill', () => {
  const m = immichCardModel(svc, up({
    denied: ['server.statistics'], photos: null, videos: null, libraryBytes: null, users: null, topUser: null,
  }));
  expect(m.cells[0].value).toBe('—');
  expect(m.cells[2].value).toBe('—');
  expect(m.cells[3].value).toBe('39%'); // storage came from a different endpoint
  expect(m.note).toBe('needs server.statistics for library counts');
  expect(m.lamp).toBe('green');
});

test('model omits the jobs row when the key may not read the queues', () => {
  const m = immichCardModel(svc, up({ jobs: null, denied: ['job.read'] }));
  expect(m.rows.map((r) => r.label)).not.toContain('JOBS');
});

test('model reports idle queues rather than omitting the row', () => {
  const m = immichCardModel(svc, up());
  expect(m.rows.find((r) => r.label === 'JOBS').value).toBe('idle');
});

test('model summarises busy queues', () => {
  const m = immichCardModel(svc, up({ jobs: { active: 2, waiting: 125, failed: 3, paused: [] } }));
  expect(m.rows.find((r) => r.label === 'JOBS').value).toBe('2 active · 125 waiting · 3 failed');
});

test('model names the largest consumer on the users row', () => {
  const m = immichCardModel(svc, up());
  expect(m.rows.find((r) => r.label === 'USERS').value).toBe('3 · 290 GB largest (Example User)');
});

test('model shows the update row only when one is available', () => {
  expect(immichCardModel(svc, up()).rows.map((r) => r.label)).not.toContain('UPDATE');
  const m = immichCardModel(svc, up({ updateAvailable: true, releaseVersion: 'v3.1.0' }));
  expect(m.rows.find((r) => r.label === 'UPDATE').value).toBe('v3.1.0 available');
});

test('model chips the library size and job state', () => {
  expect(immichCardModel(svc, up()).chip).toBe('300 GB · jobs idle');
  expect(immichCardModel(svc, up({ jobs: { active: 4, waiting: 0, failed: 0, paused: [] } })).chip)
    .toBe('300 GB · 4 active');
});

test('model shows one error line rather than a grid of dashes when down', () => {
  const m = immichCardModel(svc, snap({ state: 'down', error: 'connect ECONNREFUSED' }));
  expect(m.cells).toEqual([]);
  expect(m.rows).toEqual([]);
  expect(m.error).toBe('connect ECONNREFUSED');
  expect(m.lamp).toBe('red');
});

test('model is blank before the first sweep result arrives', () => {
  const m = immichCardModel(svc, { checkedAt: null, results: {} });
  expect(m.lamp).toBe('');
  expect(m.error).toBe('');
  expect(m.cells).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/immichCard.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/immichCard.ts"`

- [ ] **Step 3: Create `src/web/immichCard.ts`**

```ts
// The Immich card: a service tile that reports the photo library instead of a
// status line. Pure view-model first, DOM second — same split as unifiCard.ts,
// and the reason this lives in its own file rather than growing dashboard.ts.
import type { ImmichJobs, ImmichMetrics, Service, ServiceResult, ServiceStatusSnapshot } from './api';
import { fmtBytes, fmtCompact, fmtCount } from './fmt';
import { buildServiceIcon } from './serviceIcon';

// A volume this full is what a storage reading exists to surface, so capacity
// drives the lamp rather than waiting for the operator to notice. Same
// thresholds as the TrueNAS pool rows, deliberately.
export const DISK_WARN_PCT = 80;
export const DISK_CRIT_PCT = 90;
// Beyond this the exception line would wrap the card; the rest is counted.
export const MAX_NAMED_PAUSED = 3;

// What each permission actually buys, so a refusal names the missing reading
// rather than only the scope string.
const READING_FOR: Record<string, string> = {
  'server.about': 'the version',
  'server.storage': 'disk usage',
  'server.statistics': 'library counts',
  'job.read': 'jobs',
  'server.versionCheck': 'update checks',
  'systemConfig.read': 'maintenance mode',
};

export type ImmichLamp = 'green' | 'amber' | 'red' | 'auth' | '';

export interface ImmichCell { label: string; value: string }
export interface ImmichRow { label: string; value: string }
export interface ImmichCard {
  lamp: ImmichLamp;
  chip: string;
  exception: string;
  note: string;
  cells: ImmichCell[];
  rows: ImmichRow[];
  error: string;
}

export function immichLamp(r: ServiceResult | undefined): ImmichLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.immich;
  if (r.state === 'down' || !m) return 'red';
  if (m.diskUsedPct != null && m.diskUsedPct >= DISK_CRIT_PCT) return 'red';
  if (m.diskUsedPct != null && m.diskUsedPct >= DISK_WARN_PCT) return 'amber';
  // Deliberately amber rather than red: the server is not serving, but it is
  // deliberately not serving — the same distinction that separates TrueNAS's
  // DEGRADED from FAULTED.
  if (m.maintenanceMode) return 'amber';
  if (m.jobs && (m.jobs.failed > 0 || m.jobs.paused.length > 0)) return 'amber';
  // An available update and a denied permission are both deliberately absent
  // here: neither is a fault, and colouring them would train the operator to
  // ignore the lamp.
  return 'green';
}

const joinList = (parts: string[]): string =>
  (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

export function deniedNote(denied: string[]): string {
  if (!denied.length) return '';
  const readings = denied.map((p) => READING_FOR[p] ?? p);
  return `needs ${joinList(denied)} for ${joinList(readings)}`;
}

export function immichException(m: ImmichMetrics): string {
  if (m.maintenanceMode) return 'maintenance mode — the server is not serving users';
  if (m.jobs?.failed) return `${fmtCount(m.jobs.failed)} failed job${m.jobs.failed === 1 ? '' : 's'}`;
  if (m.jobs?.paused.length) {
    // Named, not counted: a tally cannot tell you which queue to go restart.
    const named = m.jobs.paused.slice(0, MAX_NAMED_PAUSED).join(', ');
    const hidden = m.jobs.paused.length - MAX_NAMED_PAUSED;
    return hidden > 0 ? `${named} +${hidden} more paused` : `${named} paused`;
  }
  return '';
}

function jobsValue(j: ImmichJobs): string {
  const parts: string[] = [];
  if (j.active) parts.push(`${fmtCount(j.active)} active`);
  if (j.waiting) parts.push(`${fmtCount(j.waiting)} waiting`);
  if (j.failed) parts.push(`${fmtCount(j.failed)} failed`);
  return parts.length ? parts.join(' · ') : 'idle';
}

// The chip has room for one clause about the queues, so it leads with the worst
// thing true of them rather than repeating the whole rollup.
function chipJobs(j: ImmichJobs): string {
  if (j.failed) return `${fmtCount(j.failed)} failed`;
  if (j.active) return `${fmtCount(j.active)} active`;
  if (j.waiting) return `${fmtCount(j.waiting)} waiting`;
  return 'jobs idle';
}

// LIBRARY is statistics.usage and DISK is the whole volume: different numbers
// with different meanings, and collapsing them would be a defect.
function cellsFor(m: ImmichMetrics): ImmichCell[] {
  return [
    { label: 'PHOTOS', value: fmtCompact(m.photos) },
    { label: 'VIDEOS', value: fmtCompact(m.videos) },
    { label: 'LIBRARY', value: fmtBytes(m.libraryBytes) },
    { label: 'DISK', value: m.diskUsedPct == null ? '—' : `${m.diskUsedPct}%` },
    { label: 'FREE', value: fmtBytes(m.diskFreeBytes) },
    { label: 'VERSION', value: m.version ?? '—' },
  ];
}

// A reading the key cannot fetch earns no row — an empty row says less than its
// absence does, and the note already explains why it is missing.
function rowsFor(m: ImmichMetrics): ImmichRow[] {
  const rows: ImmichRow[] = [];
  if (m.jobs) rows.push({ label: 'JOBS', value: jobsValue(m.jobs) });
  if (m.users != null) {
    const parts = [fmtCount(m.users)];
    if (m.topUser?.bytes != null) parts.push(`${fmtBytes(m.topUser.bytes)} largest (${m.topUser.name})`);
    rows.push({ label: 'USERS', value: parts.join(' · ') });
  }
  if (m.updateAvailable && m.releaseVersion) {
    rows.push({ label: 'UPDATE', value: `${m.releaseVersion} available` });
  }
  return rows;
}

function chipFor(m: ImmichMetrics): string {
  const size = m.libraryBytes != null ? fmtBytes(m.libraryBytes) : (m.version ?? '');
  const jobs = m.jobs ? chipJobs(m.jobs) : '';
  return [size, jobs].filter(Boolean).join(' · ');
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded server shows one error line rather than a grid
// of dashes — blank readings say less than one sentence does.
export function immichCardModel(svc: Service, snap: ServiceStatusSnapshot | null): ImmichCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', exception: '', note: '', cells: [] as ImmichCell[], rows: [] as ImmichRow[] };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = immichLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.immich) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.immich;
  return {
    lamp,
    chip: chipFor(m),
    exception: immichException(m),
    note: deniedNote(m.denied),
    cells: cellsFor(m),
    rows: rowsFor(m),
    error: '',
  };
}

// --- DOM layer -------------------------------------------------------------

export interface ImmichCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the cell or row count changes; otherwise written in place,
// so a poll never disturbs hover or text selection (the tile contract).
export function buildImmichCard(): ImmichCardEls {
  const div = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  };
  const root = document.createElement('a');
  root.className = 'dash-tile dash-tile-wide';
  root.target = '_blank';
  root.rel = 'noopener';
  const icon = buildServiceIcon();
  const lamp = document.createElement('span');
  lamp.className = 'dot';
  const name = div('dash-tile-name');
  const chip = document.createElement('span');
  chip.className = 'dash-card-chip';
  const top = div('dash-tile-top');
  top.append(icon.root, lamp, name, chip);
  const exception = div('dash-card-warn');
  // A permission gap and an operational warning are different classes of
  // statement, so they get their own slots rather than competing for one.
  const note = div('dash-card-note');
  const grid = div('dash-card-grid');
  const rows = div('dash-card-rows');
  const error = div('dash-card-error');
  root.append(top, exception, note, grid, rows, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = immichCardModel(svc, snap);
    root.href = svc.url;
    icon.update(svc);
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    exception.textContent = model.exception;
    exception.hidden = !model.exception;
    note.textContent = model.note;
    note.hidden = !model.note;
    error.textContent = model.error;
    error.hidden = !model.error;
    root.title = model.error;

    if (grid.children.length !== model.cells.length) {
      grid.replaceChildren(...model.cells.map(() => {
        const cell = div('dash-card-cell');
        cell.append(div('dash-card-label'), div('dash-card-value'));
        return cell;
      }));
    }
    model.cells.forEach((cell, i) => {
      const el = grid.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = cell.label;
      (el.lastChild as HTMLElement).textContent = cell.value;
    });
    grid.hidden = model.cells.length === 0;

    if (rows.children.length !== model.rows.length) {
      rows.replaceChildren(...model.rows.map(() => {
        const row = div('dash-card-row');
        row.append(div('dash-card-rowlabel'), div('dash-card-rowvalue'));
        return row;
      }));
    }
    model.rows.forEach((row, i) => {
      const el = rows.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = row.label;
      (el.lastChild as HTMLElement).textContent = row.value;
    });
    rows.hidden = model.rows.length === 0;
  }

  return { root, update };
}
```

- [ ] **Step 4: Share the row classes with the UniFi card**

In `src/web/unifiCard.ts`, inside `buildUnifiCard`, rename the four private class strings so both cards use one set:

- `div('dash-unifi-rows')` → `div('dash-card-rows')`
- `div('dash-unifi-row')` → `div('dash-card-row')`
- `div('dash-unifi-label')` → `div('dash-card-rowlabel')`
- `div('dash-unifi-value')` → `div('dash-card-rowvalue')`

In `src/web/style.css`, replace the block at lines 1390-1400:

```css
/* Shared by the UniFi and Immich cards: a label/value list under the cell grid.
   Distinct from .dash-card-label/.dash-card-value, which style the grid cells. */
.dash-card-rows { display: flex; flex-direction: column; gap: 3px; margin-top: 10px; }
.dash-card-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 11px;
}
.dash-card-rowlabel { color: var(--dim); letter-spacing: 0.08em; font-size: 10px; }
.dash-card-rowvalue { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

> Preserve the exact declarations from the existing `.dash-unifi-row` rule when
> you rewrite it — copy them across rather than retyping from this plan, in case
> the file has drifted.

Add the note slot beside `.dash-card-warn` (after line 1403):

```css
/* A permission gap, not a fault — muted rather than the warn colour. */
.dash-card-note { margin-top: 6px; font-size: 12px; color: var(--dim); }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm run typecheck && npx vitest run test/immichCard.test.js test/unifiCard.test.js`
Expected: PASS — 20 Immich tests, existing UniFi tests unchanged

- [ ] **Step 6: Commit**

```bash
git add src/web/immichCard.ts src/web/unifiCard.ts src/web/style.css test/immichCard.test.js
git commit -m "feat(immich): add the dashboard card and share the card row styles"
```

---

### Task 7: Dashboard and settings wiring

**Files:**
- Modify: `src/web/dashboard.ts` (import, element map, `paintTile` dispatch, both cleanup paths)
- Modify: `src/web/settingsServices.ts` (credential kinds, payload branch, radio, help, sync, test button)
- Modify: `src/server/iconResolve.js` (`KIND_SLUGS`)
- Test: `test/settingsServices.test.js` (append), `test/iconResolve.test.js` (append)

**Interfaces:**
- Consumes: `buildImmichCard` / `ImmichCardEls` from Task 6, `api.testImmich` from Task 5.
- Produces: a rendered tile and a working settings form. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/settingsServices.test.js`:

```js
test('buildServicePayload builds an immich check', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: 'Media',
    kind: 'immich', target: '', section: 'services', password: 'key-1',
  });
  expect(p.check).toEqual({ kind: 'immich', insecure: false });
  expect(p.password).toBe('key-1');
});

test('buildServicePayload carries an immich probe target when given one', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: 'http://192.168.1.10:2283', section: 'services',
  });
  expect(p.check).toEqual({ kind: 'immich', target: 'http://192.168.1.10:2283', insecure: false });
});

// The PATCH-merge trap from the spec: `insecure` must be stated outright, never
// omitted when false, or an unchecked box can never turn a stored true off.
test('buildServicePayload states an unchecked immich insecure box outright', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: '', section: 'services', insecure: false,
  });
  expect(p.check).toHaveProperty('insecure', false);
});

test('buildServicePayload sends an explicit null to clear an immich key', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: '', section: 'services', clearPassword: true,
  });
  expect(p.password).toBeNull();
});
```

Append to `test/iconResolve.test.js`:

```js
// The kind declares the slug rather than the name guessing it, and an IP
// literal contributes no candidate — an address is not a product.
test('slugCandidates leads with immich for an immich check', () => {
  expect(slugCandidates({ name: 'Photos', url: 'https://192.168.1.10:2283', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
  expect(slugCandidates({ name: 'Photos', url: 'https://photos.example.com/', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
});
```

`slugCandidates` is already imported at the top of that file; no import change is needed.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/settingsServices.test.js test/iconResolve.test.js`
Expected: FAIL — the payload falls into the generic branch (`{ kind: 'immich' }` with no `insecure`), and `immich` is not among the icon candidates

- [ ] **Step 3: Modify `src/server/iconResolve.js`**

Change `KIND_SLUGS` (line 18):

```js
const KIND_SLUGS = { unifi: 'unifi', truenas: 'truenas', pihole: 'pi-hole', immich: 'immich' };
```

- [ ] **Step 4: Modify `src/web/settingsServices.ts`**

Add to `CREDENTIAL_KINDS` (line 9):

```ts
const CREDENTIAL_KINDS: ServiceCheckKind[] = ['pihole', 'truenas', 'unifi', 'immich'];
```

Add the payload branch inside `buildServicePayload`, immediately after the `pihole` branch (after line 30):

```ts
  } else if (f.kind === 'immich') {
    check = { kind: 'immich', ...(target ? { target } : {}), insecure: f.insecure === true };
```

Add the radio (after line 166):

```ts
    immich: makeRadio('svc-check', 'immich', 'Immich', false),
```

Add the help text beside the others (after line 214):

```ts
  const IMMICH_HELP = 'Immich v1.118 or later. Create an API key under Account Settings → API Keys and grant it these read-only permissions: server.about, server.storage, server.statistics, server.versionCheck, job.read, systemConfig.read. Library counts and job state come from admin-scoped endpoints — a key without them still reports storage and version, and the card says which are missing.';
```

Update `syncTarget` (lines 218-240). The `needsCredential` test gains `immich`, the help text gains a branch, and the placeholder gains one:

```ts
    const k = kind();
    const isUnifi = k === 'unifi';
    const needsCredential = k === 'pihole' || k === 'truenas' || k === 'immich' || isUnifi;
```

```ts
    credentialHelp.textContent = isUnifi ? UNIFI_HELP
      : k === 'truenas' ? TRUENAS_HELP
        : k === 'immich' ? IMMICH_HELP
          : PIHOLE_HELP;
```

```ts
    targetIn.placeholder = k === 'tcp' ? '192.168.1.10:53'
      : k === 'pihole' ? 'https://pihole.example.com'
        : k === 'truenas' ? 'https://nas.example.com'
          : k === 'immich' ? 'https://immich.example.com'
            : isUnifi ? 'https://192.168.1.1'
              : 'https://192.168.1.10:3000/health';
```

`credentialLabel` already resolves to `API key` for every kind but `pihole`, and
`insecureField.hidden = isUnifi` already shows the checkbox for `immich`, so
neither line changes.

Add the Test-button branch inside the click handler, before the Pi-hole fallthrough (before line 282):

```ts
      if (kind() === 'immich') {
        const res = await api.testImmich({
          url, apiKey: passwordIn.value, insecure: insecureIn.checked, id: editing?.id,
        });
        // Naming the missing permissions here is the point of the probe: a
        // scoped key gets fixed before saving rather than producing a card full
        // of dashes afterwards.
        const missing = res.denied?.length ? ` — missing ${res.denied.join(', ')}` : '';
        setStatus(
          res.ok ? `Connected — Immich ${res.version ?? ''}${missing}`.trim() : (res.error || 'Connection failed'),
          !res.ok,
        );
        return;
      }
```

Add the radio to the rendered group (line 395):

```ts
      el('div', { class: 'svc-check-radios' }, [radios.http.wrap, radios.tcp.wrap, radios.pihole.wrap, radios.truenas.wrap, radios.unifi.wrap, radios.immich.wrap, radios.none.wrap]),
```

- [ ] **Step 5: Modify `src/web/dashboard.ts`**

Add the import beside the other card imports (after line 13):

```ts
import { buildImmichCard, type ImmichCardEls } from './immichCard';
```

Add the element map (after line 297):

```ts
  const immichEls = new Map<string, ImmichCardEls>();
```

Add the dispatch inside `paintTile`, after the `unifi` block (after line 449):

```ts
    if (svc.check.kind === 'immich') {
      let card = immichEls.get(svc.id);
      if (!card) { card = buildImmichCard(); immichEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
```

Add the cleanup pass in `repaint`, after the `unifiEls` loop:

```ts
    for (const [id, card] of immichEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); immichEls.delete(id); }
    }
```

Add the teardown in `destroy`, after `unifiEls.clear();`:

```ts
    immichEls.clear();
```

Update the comment above the dispatch (line 434) so it stays true:

```ts
    // A Pi-hole reports numbers, a TrueNAS reports storage, a UniFi reports the
    // network and an Immich reports its library, so all four render as cards
    // rather than lamps; everything downstream (grouping, ordering, cleanup)
    // treats them as tiles.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — typecheck clean, every test green

- [ ] **Step 7: Commit**

```bash
git add src/web/dashboard.ts src/web/settingsServices.ts src/server/iconResolve.js test/settingsServices.test.js test/iconResolve.test.js
git commit -m "feat(immich): render immich tiles and add the settings form"
```

---

### Task 8: Documentation, live validation, release

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`
- Modify: `package.json`, `package-lock.json` (version bump)

**Interfaces:**
- Consumes: everything above.
- Produces: a released, deployed, browser-verified feature.

- [ ] **Step 1: Update the architecture docs**

In **both** `CLAUDE.md` and `AGENTS.md` (they are kept in sync), add to the
`servicesStore.js / serviceCheck.js / serviceChecker.js` bullet the new kind in
the check-kind list (`http|tcp|pihole|truenas|unifi|immich|none`), and add a new
bullet after the `unifiApi.js` one:

```markdown
- `immichApi.js` / `immichMetrics.js` / `immichRegistry.js` — the `immich` service check: a
  dependency-free **GET-only** client for the Immich REST API (`/api/server/*`, `x-api-key`)
  over `node:https`, in the mold of `netboxApi.js`. One refresh is six concurrent GETs —
  about, storage, statistics, jobs, version-check and config — behind a 30s snapshot TTL, so
  a tile's cost is bounded by the client rather than by `TMUXIFIER_SERVICE_POLL_MS`. The
  load-bearing rule is that a **`403` is proof the server answered**: it degrades only that
  endpoint's readings (recorded in `metrics.denied` so the card can name the missing
  permission) and never fails the tile, while a `401` is `auth` and only a total transport
  failure is `down`. This is what makes a least-privilege scoped key a first-class
  configuration rather than a broken one. `immichMetrics.js` is the pure shaping half —
  it rolls fifteen job queues into one verdict, **names** paused queues rather than counting
  them, and keeps `statistics.usage` (the library) distinct from `storage.diskUseRaw` (the
  volume), which are different numbers that a single "size" figure would conflate.
  `/api/users` is deliberately never called: it returns email addresses, and
  `statistics.usageByUser` already carries the names the user row needs.
```

Add to the Security notes section, after the UniFi paragraph:

```markdown
- An Immich tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key
  from `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword`
  only). Unlike TrueNAS and UniFi, plain `http` is **allowed**, with verified TLS on `https`
  and an explicit per-service `insecure` opt-out — Pi-hole's posture. Neither refusal
  rationale transfers: an Immich key survives plaintext use (TrueNAS revokes one outright)
  and can be scoped read-only (a UniFi local key cannot), while the standard self-hosted
  deployment is plain http on a LAN. Create the key under Account Settings → API Keys with
  only `server.about`, `server.storage`, `server.statistics`, `server.versionCheck`,
  `job.read` and `systemConfig.read`; the integration is read-only and issues no verb but
  `GET`.
```

In `README.md`, add `immich` to whichever list of service check kinds it documents, matching the surrounding style.

- [ ] **Step 2: Commit the docs**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs(immich): document the immich service check kind"
```

- [ ] **Step 3: Build and deploy a validation candidate**

This is a **server-side** change, so the `rsync dist/` shortcut does not apply — the running service must load the new server modules.

```bash
npm run build
# Confirm no job is running before restarting: a restart interrupts in-flight
# setup / provision / lifecycle / fleet / voice-install jobs.
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

- [ ] **Step 4: Verify in a real browser**

Server-side green is **not** evidence the card renders. Open the dashboard and confirm:

1. Add a service with kind **Immich**, the real server URL and a scoped API key.
2. **Test connection** reports `Connected — Immich v…`, and names any missing permission.
3. The tile renders as a wide card with a logo, six populated cells and the JOBS/USERS rows — not `—` everywhere, and not a bare lamp.
4. Temporarily revoke `server.statistics` on the key and reload: the card keeps its green lamp, dashes the library cells, and shows the `needs server.statistics for library counts` note. Restore the permission afterwards.
5. Enter a wrong key: the lamp turns violet (`auth`), not red.

- [ ] **Step 5: Release**

```bash
npm version patch --no-git-tag-version
npm run build
sudo systemctl restart tmuxifier
systemctl status tmuxifier
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"  # expect 200
VERSION="v$(node -p "require('./package.json').version")"
test "$(node -p "require('./package-lock.json').version")" = "${VERSION#v}"
test "$(node -p "require('./package-lock.json').packages[''].version")" = "${VERSION#v}"
git add -A
git diff --cached   # PII scrub: no real domains, IPs, emails, hostnames or user names
git commit -m "chore(release): ${VERSION} — Immich service tile"
git tag -a "$VERSION" -m "$VERSION"
git push origin main "$VERSION"
gh release create "$VERSION" --title "$VERSION" --notes "See commit history for changes."
test -n "$(git ls-remote --tags origin "$VERSION")"
test "$(gh release view "$VERSION" --json tagName --jq .tagName)" = "$VERSION"
```

---

## Notes for the implementer

**Two numbers that look like one.** `libraryBytes` (what Immich has ingested) and `diskUsedBytes` (what the volume holds) are different figures. Do not "simplify" them into a single size.

**A 403 is not an auth failure.** It is the single most important behaviour here. `401` → violet lamp, no readings. `403` → green lamp, that endpoint's readings missing, permission named. Folding them together destroys the least-privilege story.

**Do not add a `/api/server/ping` call.** It is redundant: any HTTP response, including a 403, already proves the server is alive.

**Do not call `/api/users`.** It returns email addresses. `statistics.usageByUser` has what the card needs.
