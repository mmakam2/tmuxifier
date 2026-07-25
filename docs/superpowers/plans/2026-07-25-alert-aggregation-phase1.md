# Alert Aggregation Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect the failures that currently arrive as silence — dead backups, expired integrations, unhealthy web surfaces, sustained WAN outages — and deliver only the ones that clear an explicit bar, with an auditable record of everything withheld.

**Architecture:** A check runner in the existing dashboard process probes targets on a schedule and appends failures to an append-only NDJSON log. A pure policy engine folds that log into alerts by key and decides — deterministically — whether each one may interrupt the operator, recording a reason for every decision. A separate minimal daemon receives heartbeat check-ins on a LAN bind and holds no credentials. Each process is the sole writer of the files it writes, so there is no locking, no IPC, and no shared-store library.

**Tech Stack:** Node 20 ESM, Fastify 5 (dashboard only; the ingest daemon uses bare `node:http`), vitest, TypeScript + Vite for the web client. No new runtime dependencies.

## Global Constraints

- **Node 20, no `node:sqlite`.** `require('node:sqlite')` throws `ERR_UNKNOWN_BUILTIN_MODULE` on this runtime. Storage is append-only NDJSON plus the existing atomic-JSON helpers.
- **No new runtime dependencies.** The SMTP client is hand-rolled on `node:net`/`node:tls`, in the tradition of `googleAuth.js` and `webauthn.js`.
- **Factory functions with injected dependencies.** Every new server module is `createX({...deps})`. Never read `process.env`, `Date.now()`, or `process.cwd()` inside a module — inject `now`, `setIntervalFn`, `clearIntervalFn`.
- **Tests use real code, not mocks.** Real sockets, real files under a temp dir, real HTTP servers started by the test. No `vi.mock`.
- **Single writer per file.** The dashboard writes `checks-*.ndjson`, `decisions-*.ndjson`, `checks.json`, `alert-rules.json`, `alert-triage.json`. The ingest daemon writes `inbound-*.ndjson` and `ingest-heartbeat.json`. Neither writes the other's files.
- **Secrets sealed, never returned to the browser.** Use `createSecretBox(config.cookieSecret)` and redact to a `hasSecret` boolean on read, exactly as `netboxStore.js` does.
- **All `data/` files are `0o600`, gitignored, created at runtime.** New `.env` knobs are added to `.env.example` in the same task that introduces them.
- **Public repo — no real PII.** Tests and docs use `example.com` and RFC1918 addresses only.
- **Conventional commits** (`feat(alerts): …`, `test(alerts): …`, `docs(alerts): …`).
- **Reason codes are a closed set**, used verbatim across policy, decision log, and UI: `notified`, `held:below-persistence`, `suppressed:cooldown`, `suppressed:muted`, `skipped:info`, `skipped:resolved`, `notify:failed`.

---

## File Structure

**New server modules (`src/server/`):**

| File | Responsibility |
| --- | --- |
| `eventLog.js` | Generic append-only NDJSON day-partitioned log. Used three times: checks, inbound, decisions. |
| `alertFold.js` | Pure. Folds occurrence events into alerts keyed by `key`. |
| `alertPolicy.js` | Pure. Decides notify/withhold and returns a reason code. |
| `checkStore.js` | `data/checks.json` CRUD; seals per-check secrets, redacts on read. |
| `checkTypes.js` | Pure validation and normalization of check definitions. |
| `checks/httpCheck.js` | HTTP status/body/TLS-expiry probe. |
| `checks/tcpCheck.js` | TCP connect probe. |
| `checks/jsonCheck.js` | Fetch + JSON field assertion. |
| `checks/execCheck.js` | Command on a box over the existing ControlMaster. |
| `checks/heartbeatCheck.js` | Absence detection against the inbound log. |
| `checks/index.js` | `createCheckDispatcher` — maps type to executor. |
| `checkRunner.js` | Scheduling, jitter, in-flight guard, emits occurrences. |
| `alertStateStore.js` | `data/alert-rules.json` + `data/alert-triage.json` (mutes, overrides, acks). |
| `alertManager.js` | Evaluation loop: fold → decide → record decision → deliver. |
| `mailer.js` | Minimal SMTP client (EHLO/STARTTLS/AUTH LOGIN/DATA). |
| `alertMail.js` | Pure mail formatting + the mail delivery channel. |
| `ingest/heartbeatServer.js` | `node:http` server: `POST /hb/:token`, liveness stamp. |
| `ingest/index.js` | Ingest daemon entrypoint. |

**New web modules (`src/web/`):** `alerts.ts` (fetch layer), `alertFormat.ts` (pure formatters), `alertsUi.ts` (hub panel), `checkForm.ts` (per-type forms).

**Modified:** `src/server/config.js` (knobs), `src/server/server.js` (routes), `src/server/index.js` (wiring), `src/web/main.ts` (sidebar entry), `.env.example`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/DEPLOY.md`, `deploy/tmuxifier-ingest.service` (new).

**Canonical types** (referenced by every task):

```js
// Occurrence event — one line in checks-*.ndjson / inbound-*.ndjson
{ id: '1784976000123-0', ts: 1784976000123, via: 'check', source: 'check:abc',
  key: 'check:abc', norm: null, severity: 'critical', state: 'firing',
  title: 'HTTP 502 from https://invoices.example.com/health', body: '' }

// Alert — produced by foldEvents, consumed by decideAlert and the UI
{ key, source, severity, state, count, recentCount, firstTs, lastTs, title, body }

// Decision — one line in decisions-*.ndjson
{ id, ts, key, reason, notify: false, error: null }

// Check definition — one entry in data/checks.json
{ id, label, type, target, assert, intervalSec, timeoutMs, severity,
  failuresBeforeNotify, enabled, secret }

// Check result — returned by every executor
{ ok: true|false, detail: 'string', latencyMs: 12 }
```

---

# Slice A — The spine, end to end with one check type

## Task 1: Append-only event log

**Files:**
- Create: `src/server/eventLog.js`
- Test: `test/eventLog.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic` is *not* used here — appends use `fsp.appendFile`.
- Produces: `createEventLog({ dir, prefix, now })` returning `{ append(event), readSince(sinceMs), readDay(dayKey), prune(maxAgeDays), dayKey(ms) }`. `append` returns the stored event with `id` and `ts` filled in. `readSince`/`readDay` return arrays of parsed events, skipping unparseable lines.

- [ ] **Step 1: Write the failing test**

```js
// test/eventLog.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'evlog-'));

test('append writes one NDJSON line per event into a day-partitioned file', async () => {
  const dir = await tmpDir();
  const log = createEventLog({ dir, prefix: 'checks', now: () => 1784976000123 });
  const stored = await log.append({ key: 'check:a', severity: 'critical', title: 'down' });
  expect(stored.id).toBe('1784976000123-0');
  expect(stored.ts).toBe(1784976000123);
  const raw = await fs.readFile(path.join(dir, 'checks-2026-07-25.ndjson'), 'utf8');
  expect(raw.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(raw)).toMatchObject({ key: 'check:a', title: 'down' });
});

test('ids stay unique within a millisecond', async () => {
  const dir = await tmpDir();
  const log = createEventLog({ dir, prefix: 'checks', now: () => 5 });
  const a = await log.append({ key: 'k' });
  const b = await log.append({ key: 'k' });
  expect(a.id).not.toBe(b.id);
});

test('readSince returns events across day boundaries in time order', async () => {
  const dir = await tmpDir();
  let t = Date.parse('2026-07-24T23:59:00Z');
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  await log.append({ key: 'a' });
  t = Date.parse('2026-07-25T00:01:00Z');
  await log.append({ key: 'b' });
  const got = await log.readSince(Date.parse('2026-07-24T00:00:00Z'), Date.parse('2026-07-25T12:00:00Z'));
  expect(got.map((e) => e.key)).toEqual(['a', 'b']);
});

test('a corrupt line is skipped, not fatal — one bad line never costs a day of history', async () => {
  const dir = await tmpDir();
  const log = createEventLog({ dir, prefix: 'checks', now: () => Date.parse('2026-07-25T10:00:00Z') });
  await log.append({ key: 'good1' });
  await fs.appendFile(path.join(dir, 'checks-2026-07-25.ndjson'), '{not json\n');
  await log.append({ key: 'good2' });
  const got = await log.readDay('2026-07-25');
  expect(got.map((e) => e.key)).toEqual(['good1', 'good2']);
});

test('prune deletes day files older than the retention window and reports them', async () => {
  const dir = await tmpDir();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  await log.append({ key: 'old' });
  t = Date.parse('2026-07-25T00:00:00Z');
  await log.append({ key: 'new' });
  const removed = await log.prune(90);
  expect(removed).toEqual(['checks-2026-01-01.ndjson']);
  expect(await log.readDay('2026-01-01')).toEqual([]);
  expect(await log.readDay('2026-07-25')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eventLog.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/eventLog.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/eventLog.js
import fs from 'node:fs/promises';
import path from 'node:path';

// Append-only, day-partitioned NDJSON. Deliberately not jsonFile.js: that module
// quarantines a whole corrupt file, which is right for a state document and wrong
// for an append log, where one bad line must not cost a day of history. Appends of
// modest lines under O_APPEND are atomic, which is what lets one process append
// while another tails without locking.
const DAY_MS = 86400000;

export function createEventLog({ dir, prefix, now = () => Date.now() }) {
  let seq = 0;
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fileFor = (key) => path.join(dir, `${prefix}-${key}.ndjson`);

  async function readFileLines(key) {
    let raw;
    try {
      raw = await fs.readFile(fileFor(key), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip the bad line only */ }
    }
    return out;
  }

  return {
    dayKey,
    async append(event) {
      const ts = typeof event.ts === 'number' ? event.ts : now();
      const stored = { id: `${ts}-${seq++}`, ts, ...event };
      stored.ts = ts;
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(fileFor(dayKey(ts)), `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      return stored;
    },
    readDay: readFileLines,
    async readSince(sinceMs, untilMs = now()) {
      const keys = [];
      for (let t = sinceMs; t <= untilMs + DAY_MS; t += DAY_MS) {
        const k = dayKey(t);
        if (!keys.includes(k)) keys.push(k);
      }
      const all = [];
      for (const k of keys) all.push(...await readFileLines(k));
      return all
        .filter((e) => e.ts >= sinceMs && e.ts <= untilMs)
        .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    },
    async prune(maxAgeDays) {
      const cutoff = now() - maxAgeDays * DAY_MS;
      let names;
      try { names = await fs.readdir(dir); } catch { return []; }
      const removed = [];
      for (const name of names) {
        const m = name.match(new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`));
        if (!m) continue;
        if (Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
          await fs.unlink(path.join(dir, name));
          removed.push(name);
        }
      }
      return removed.sort();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eventLog.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/eventLog.js test/eventLog.test.js
git commit -m "feat(alerts): append-only day-partitioned NDJSON event log"
```

---

## Task 2: Fold occurrences into alerts

**Files:**
- Create: `src/server/alertFold.js`
- Test: `test/alertFold.test.js`

**Interfaces:**
- Consumes: occurrence events from Task 1.
- Produces: `foldEvents(events, { nowMs, windowMs })` returning `Alert[]` sorted by `lastTs` descending. An `Alert` is `{ key, source, severity, state, count, recentCount, firstTs, lastTs, title, body }`. `count` counts firing events since the last `resolved`; `recentCount` counts firing events within `windowMs` of `nowMs`.

- [ ] **Step 1: Write the failing test**

```js
// test/alertFold.test.js
import { test, expect } from 'vitest';
import { foldEvents } from '../src/server/alertFold.js';

const ev = (over) => ({
  id: `${over.ts}-0`, via: 'check', source: 'check:a', key: 'check:a', norm: null,
  severity: 'warning', state: 'firing', title: 't', body: '', ...over,
});

test('repeated occurrences of one key collapse into a single alert with a count', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 200 }), ev({ ts: 300 })], { nowMs: 300, windowMs: 1000 });
  expect(alert.count).toBe(3);
  expect(alert.firstTs).toBe(100);
  expect(alert.lastTs).toBe(300);
  expect(alert.state).toBe('firing');
});

test('the newest occurrence supplies the alert title and severity', () => {
  const [alert] = foldEvents(
    [ev({ ts: 100, title: 'old', severity: 'warning' }), ev({ ts: 200, title: 'new', severity: 'critical' })],
    { nowMs: 200, windowMs: 1000 },
  );
  expect(alert.title).toBe('new');
  expect(alert.severity).toBe('critical');
});

test('a resolved event closes the alert and restarts the count', () => {
  const [alert] = foldEvents(
    [ev({ ts: 100 }), ev({ ts: 200, state: 'resolved' }), ev({ ts: 300 })],
    { nowMs: 300, windowMs: 1000 },
  );
  expect(alert.state).toBe('firing');
  expect(alert.count).toBe(1);      // the pre-resolution occurrences do not carry over
  expect(alert.firstTs).toBe(300);
});

test('an alert whose last event is a resolution reports state resolved', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 200, state: 'resolved' })], { nowMs: 200, windowMs: 1000 });
  expect(alert.state).toBe('resolved');
  expect(alert.count).toBe(0);
});

test('recentCount counts only occurrences inside the window', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 9000 }), ev({ ts: 9500 })], { nowMs: 10000, windowMs: 2000 });
  expect(alert.count).toBe(3);
  expect(alert.recentCount).toBe(2);
});

test('distinct keys stay distinct and sort newest-activity first', () => {
  const got = foldEvents(
    [ev({ ts: 100, key: 'check:a' }), ev({ ts: 500, key: 'check:b' })],
    { nowMs: 500, windowMs: 1000 },
  );
  expect(got.map((a) => a.key)).toEqual(['check:b', 'check:a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertFold.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/alertFold.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertFold.js
// An alert is not a stored row — it is a fold over the append-only log by key.
// This is what lets the store stay append-only: "one problem, 47 occurrences,
// first seen 03:12" is computed at read time rather than mutated in place.
export function foldEvents(events, { nowMs = Date.now(), windowMs = 3600000 } = {}) {
  const byKey = new Map();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    let a = byKey.get(e.key);
    if (!a) {
      a = { key: e.key, source: e.source, severity: e.severity, state: 'resolved',
            count: 0, recentCount: 0, firstTs: null, lastTs: null, title: e.title, body: e.body };
      byKey.set(e.key, a);
    }
    a.source = e.source;
    a.title = e.title;
    a.body = e.body;
    a.severity = e.severity;
    if (e.state === 'resolved') {
      a.state = 'resolved';
      a.count = 0;
      a.recentCount = 0;
      a.firstTs = null;
      a.lastTs = e.ts;
      continue;
    }
    a.state = 'firing';
    a.count += 1;
    if (e.ts >= nowMs - windowMs) a.recentCount += 1;
    if (a.firstTs === null) a.firstTs = e.ts;
    a.lastTs = e.ts;
  }
  return [...byKey.values()].sort((x, y) => (y.lastTs || 0) - (x.lastTs || 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertFold.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/alertFold.js test/alertFold.test.js
git commit -m "feat(alerts): fold occurrence events into keyed alerts"
```

---

## Task 3: The policy engine

**Files:**
- Create: `src/server/alertPolicy.js`
- Test: `test/alertPolicy.test.js`

**Interfaces:**
- Consumes: `Alert` from Task 2.
- Produces: `DEFAULT_THRESHOLDS` (`{ warnPersistMs: 900000, warnRepeatCount: 3, warnWindowMs: 3600000, cooldownMs: 21600000 }`) and `decideAlert({ alert, rules, nowMs, lastNotifiedAt, thresholds })` returning `{ notify: boolean, reason: string }`. `rules` is `{ mutes: string[], overrides: { [key]: { failuresBeforeNotify?, severity?, cooldownMs? } } }`.

- [ ] **Step 1: Write the failing test**

```js
// test/alertPolicy.test.js
import { test, expect } from 'vitest';
import { decideAlert, DEFAULT_THRESHOLDS } from '../src/server/alertPolicy.js';

const alert = (over) => ({
  key: 'check:a', source: 'check:a', severity: 'warning', state: 'firing',
  count: 1, recentCount: 1, firstTs: 0, lastTs: 0, title: 't', body: '', ...over,
});
const decide = (over, extra = {}) =>
  decideAlert({ alert: alert(over), rules: { mutes: [], overrides: {} }, nowMs: 0, lastNotifiedAt: null, ...extra });

test('critical notifies on the first occurrence', () => {
  expect(decide({ severity: 'critical' })).toEqual({ notify: true, reason: 'notified' });
});

test('info never notifies', () => {
  expect(decide({ severity: 'info' })).toEqual({ notify: false, reason: 'skipped:info' });
});

test('a resolved alert never notifies', () => {
  expect(decide({ severity: 'critical', state: 'resolved' })).toEqual({ notify: false, reason: 'skipped:resolved' });
});

test('a muted key is silent even at critical severity', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical' }), rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 0, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: false, reason: 'suppressed:muted' });
});

test('a muted source silences every key from it', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical', key: 'check:a', source: 'udm' }),
    rules: { mutes: ['udm'], overrides: {} }, nowMs: 0, lastNotifiedAt: null,
  });
  expect(got.reason).toBe('suppressed:muted');
});

test('a warning below both gates is held, not dropped', () => {
  expect(decide({ count: 1, recentCount: 1, firstTs: 0 }, { nowMs: 60000 }))
    .toEqual({ notify: false, reason: 'held:below-persistence' });
});

test('a warning firing longer than the persistence gate notifies', () => {
  expect(decide({ firstTs: 0 }, { nowMs: DEFAULT_THRESHOLDS.warnPersistMs }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('a warning repeating enough times inside the window notifies before the time gate', () => {
  expect(decide({ recentCount: 3, firstTs: 0 }, { nowMs: 1000 }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('a per-key failuresBeforeNotify override replaces the repeat threshold', () => {
  const got = decideAlert({
    alert: alert({ recentCount: 2, firstTs: 0 }),
    rules: { mutes: [], overrides: { 'check:a': { failuresBeforeNotify: 2 } } },
    nowMs: 1000, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: true, reason: 'notified' });
});

test('re-notify suppression holds a still-firing alert inside the cooldown', () => {
  expect(decide({ severity: 'critical' }, { nowMs: 3600000, lastNotifiedAt: 0 }))
    .toEqual({ notify: false, reason: 'suppressed:cooldown' });
});

test('once the cooldown elapses a still-firing alert notifies again', () => {
  expect(decide({ severity: 'critical' }, { nowMs: DEFAULT_THRESHOLDS.cooldownMs, lastNotifiedAt: 0 }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('mute outranks cooldown so the reason reported is the operator decision', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical' }), rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 10, lastNotifiedAt: 0,
  });
  expect(got.reason).toBe('suppressed:muted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertPolicy.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/alertPolicy.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertPolicy.js
// Deterministic and pure: this function alone decides what may interrupt the
// operator. No model, no heuristic, no I/O. Every branch returns a reason code,
// because a system that withholds silently is indistinguishable from a broken one.
export const DEFAULT_THRESHOLDS = {
  warnPersistMs: 15 * 60 * 1000,
  warnRepeatCount: 3,
  warnWindowMs: 60 * 60 * 1000,
  cooldownMs: 6 * 60 * 60 * 1000,
};

export function decideAlert({
  alert, rules = { mutes: [], overrides: {} }, nowMs, lastNotifiedAt = null,
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const mutes = rules.mutes || [];
  const override = (rules.overrides || {})[alert.key] || {};

  if (alert.state === 'resolved') return { notify: false, reason: 'skipped:resolved' };
  // Mute is an explicit operator decision, so it is reported ahead of any
  // automatic suppression — "I silenced this" beats "it is in cooldown".
  if (mutes.includes(alert.key) || mutes.includes(alert.source)) {
    return { notify: false, reason: 'suppressed:muted' };
  }
  const severity = override.severity || alert.severity;
  if (severity === 'info') return { notify: false, reason: 'skipped:info' };

  const cooldownMs = override.cooldownMs ?? thresholds.cooldownMs;
  if (lastNotifiedAt !== null && nowMs - lastNotifiedAt < cooldownMs) {
    return { notify: false, reason: 'suppressed:cooldown' };
  }
  if (severity === 'critical') return { notify: true, reason: 'notified' };

  const repeatGate = override.failuresBeforeNotify ?? thresholds.warnRepeatCount;
  const persisted = alert.firstTs !== null && nowMs - alert.firstTs >= thresholds.warnPersistMs;
  const repeated = alert.recentCount >= repeatGate;
  if (persisted || repeated) return { notify: true, reason: 'notified' };
  return { notify: false, reason: 'held:below-persistence' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertPolicy.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/alertPolicy.js test/alertPolicy.test.js
git commit -m "feat(alerts): deterministic severity x persistence policy engine"
```

---

## Task 4: Check definition validation

**Files:**
- Create: `src/server/checkTypes.js`
- Test: `test/checkTypes.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CHECK_TYPES` (`['http','tcp','json','exec','heartbeat']`), `SEVERITIES` (`['critical','warning','info']`), and `assertCheckInput(spec)` returning a normalized check without `id`, throwing `Error` with a readable message on invalid input.

- [ ] **Step 1: Write the failing test**

```js
// test/checkTypes.test.js
import { test, expect } from 'vitest';
import { assertCheckInput, CHECK_TYPES } from '../src/server/checkTypes.js';

const base = { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } };

test('a minimal http check normalizes with defaults applied', () => {
  expect(assertCheckInput(base)).toEqual({
    label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' },
    assert: {}, intervalSec: 60, timeoutMs: 10000, severity: 'warning',
    failuresBeforeNotify: 3, enabled: true,
  });
});

test('every supported type is accepted', () => {
  expect(CHECK_TYPES).toEqual(['http', 'tcp', 'json', 'exec', 'heartbeat']);
});

test('an unknown type is refused', () => {
  expect(() => assertCheckInput({ ...base, type: 'carrier-pigeon' })).toThrow(/type/);
});

test('a blank label is refused', () => {
  expect(() => assertCheckInput({ ...base, label: '   ' })).toThrow(/label/);
});

test('an http check without a url is refused', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'http', target: {} })).toThrow(/url/);
});

test('a non-http(s) url is refused so a check can never reach file: or a unix socket', () => {
  expect(() => assertCheckInput({ ...base, target: { url: 'file:///etc/passwd' } })).toThrow(/http/);
});

test('an exec check requires a boxId and a command', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'exec', target: { boxId: 'b1' } })).toThrow(/command/);
  expect(assertCheckInput({ label: 'x', type: 'exec', target: { boxId: 'b1', command: 'true' } }).target)
    .toEqual({ boxId: 'b1', command: 'true' });
});

test('a tcp check requires host and a port in range', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h' } })).toThrow(/port/);
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 70000 } })).toThrow(/port/);
});

test('a heartbeat check requires a positive window', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'heartbeat', target: {} })).toThrow(/windowSec/);
  expect(assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 3600 } }).target.windowSec).toBe(3600);
});

test('interval and timeout are clamped to sane bounds rather than trusted', () => {
  expect(assertCheckInput({ ...base, intervalSec: 1 }).intervalSec).toBe(10);
  expect(assertCheckInput({ ...base, intervalSec: 999999 }).intervalSec).toBe(86400);
  expect(assertCheckInput({ ...base, timeoutMs: 5 }).timeoutMs).toBe(1000);
});

test('an unknown severity is refused rather than silently defaulted', () => {
  expect(() => assertCheckInput({ ...base, severity: 'apocalyptic' })).toThrow(/severity/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/checkTypes.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/checkTypes.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checkTypes.js
// Pure validation for check definitions. The server stays the validation
// authority: nothing the browser sends reaches an executor unvalidated.
export const CHECK_TYPES = ['http', 'tcp', 'json', 'exec', 'heartbeat'];
export const SEVERITIES = ['critical', 'warning', 'info'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

function assertUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('target.url is required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('target.url must be a valid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('target.url must be http or https');
  }
  return parsed.toString();
}

function assertTarget(type, target) {
  const t = target && typeof target === 'object' ? target : {};
  if (type === 'http') return { url: assertUrl(t.url) };
  if (type === 'json') {
    if (typeof t.path !== 'string' || !t.path.trim()) throw new Error('target.path is required');
    return { url: assertUrl(t.url), path: t.path.trim() };
  }
  if (type === 'tcp') {
    if (typeof t.host !== 'string' || !t.host.trim()) throw new Error('target.host is required');
    const port = Number(t.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('target.port must be 1-65535');
    return { host: t.host.trim(), port };
  }
  if (type === 'exec') {
    if (typeof t.boxId !== 'string' || !t.boxId.trim()) throw new Error('target.boxId is required');
    if (typeof t.command !== 'string' || !t.command.trim()) throw new Error('target.command is required');
    return { boxId: t.boxId.trim(), command: t.command.trim() };
  }
  const windowSec = Number(t.windowSec);
  if (!Number.isInteger(windowSec) || windowSec < 1) throw new Error('target.windowSec must be a positive integer');
  return { windowSec, graceSec: clampInt(t.graceSec, 0, 86400, 0) };
}

export function assertCheckInput(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const label = typeof s.label === 'string' ? s.label.trim() : '';
  if (!label) throw new Error('label is required');
  if (!CHECK_TYPES.includes(s.type)) throw new Error(`type must be one of ${CHECK_TYPES.join(', ')}`);
  const severity = s.severity === undefined ? 'warning' : s.severity;
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  return {
    label,
    type: s.type,
    target: assertTarget(s.type, s.target),
    assert: s.assert && typeof s.assert === 'object' ? { ...s.assert } : {},
    intervalSec: clampInt(s.intervalSec, 10, 86400, 60),
    timeoutMs: clampInt(s.timeoutMs, 1000, 120000, 10000),
    severity,
    failuresBeforeNotify: clampInt(s.failuresBeforeNotify, 1, 1000, 3),
    enabled: s.enabled === undefined ? true : !!s.enabled,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/checkTypes.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/checkTypes.js test/checkTypes.test.js
git commit -m "feat(alerts): pure validation for check definitions"
```

---

## Task 5: Check definition store

**Files:**
- Create: `src/server/checkStore.js`
- Test: `test/checkStore.test.js`

**Interfaces:**
- Consumes: `assertCheckInput` (Task 4), `createSecretBox` (existing), `readJson`/`writeJson` (existing).
- Produces: `createCheckStore({ dataDir, secretBox, now, genId })` returning `{ listChecks(), getCheck(id, { withSecret }), addCheck(spec), updateCheck(id, spec), removeCheck(id) }`. Reads redact `secret` to `hasSecret: boolean`; only `getCheck(id, { withSecret: true })` decrypts.

- [ ] **Step 1: Write the failing test**

```js
// test/checkStore.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckStore } from '../src/server/checkStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

const mk = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkstore-'));
  let n = 0;
  return {
    dataDir,
    store: createCheckStore({
      dataDir, secretBox: createSecretBox('test-cookie-secret'),
      now: () => '2026-07-25T00:00:00.000Z', genId: () => `id${++n}`,
    }),
  };
};
const httpSpec = { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } };

test('addCheck assigns an id and lists it back', async () => {
  const { store } = await mk();
  const added = await store.addCheck(httpSpec);
  expect(added.id).toBe('id1');
  expect((await store.listChecks()).map((c) => c.label)).toEqual(['Invoice app']);
});

test('a secret is sealed on disk and never appears in a listing', async () => {
  const { store, dataDir } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'super-secret-token' });
  expect(added.hasSecret).toBe(true);
  expect(added.secret).toBeUndefined();
  const raw = await fs.readFile(path.join(dataDir, 'checks.json'), 'utf8');
  expect(raw).not.toContain('super-secret-token');
  expect(await store.getCheck(added.id, { withSecret: true })).toMatchObject({ secret: 'super-secret-token' });
});

test('updating without resending the secret keeps the stored one', async () => {
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'keepme' });
  await store.updateCheck(added.id, { ...httpSpec, label: 'Renamed' });
  const got = await store.getCheck(added.id, { withSecret: true });
  expect(got.label).toBe('Renamed');
  expect(got.secret).toBe('keepme');
});

test('invalid input is refused before anything is written', async () => {
  const { store } = await mk();
  await expect(store.addCheck({ ...httpSpec, type: 'nope' })).rejects.toThrow(/type/);
  expect(await store.listChecks()).toEqual([]);
});

test('removeCheck drops it and reports whether anything was removed', async () => {
  const { store } = await mk();
  const added = await store.addCheck(httpSpec);
  expect(await store.removeCheck(added.id)).toBe(true);
  expect(await store.removeCheck(added.id)).toBe(false);
  expect(await store.listChecks()).toEqual([]);
});

test('the file is written owner-only', async () => {
  const { store, dataDir } = await mk();
  await store.addCheck(httpSpec);
  const st = await fs.stat(path.join(dataDir, 'checks.json'));
  expect(st.mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/checkStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/checkStore.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checkStore.js
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCheckInput } from './checkTypes.js';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// data/checks.json. Mirrors netboxStore.js: per-check secrets are sealed before
// they touch disk and redacted to hasSecret on every read; getCheck(id,
// { withSecret: true }) is the only decrypting path and is server-internal.
export function createCheckStore({ dataDir, secretBox, now = () => new Date().toISOString(), genId = randomUUID }) {
  const file = path.join(dataDir, 'checks.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('checks' in v) || Array.isArray(v.checks));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape });
    return { version: VERSION, checks: [], ...v };
  }
  const redact = ({ secret, ...rest }) => ({ ...rest, hasSecret: !!secret });

  return {
    async listChecks() {
      return (await readAll()).checks.map(redact);
    },
    async getCheck(id, { withSecret = false } = {}) {
      const found = (await readAll()).checks.find((c) => c.id === id);
      if (!found) return null;
      if (!withSecret) return redact(found);
      return { ...found, secret: found.secret ? secretBox.open(found.secret) : null };
    },
    async addCheck(spec) {
      const norm = assertCheckInput(spec);
      const data = await readAll();
      const secret = typeof spec.secret === 'string' && spec.secret.trim()
        ? secretBox.seal(spec.secret.trim()) : null;
      const check = { id: genId(), ...norm, secret, createdAt: now(), updatedAt: now() };
      data.checks.push(check);
      await writeJson(file, data, { mode: 0o600 });
      return redact(check);
    },
    async updateCheck(id, spec) {
      const norm = assertCheckInput(spec);
      const data = await readAll();
      const i = data.checks.findIndex((c) => c.id === id);
      if (i === -1) return null;
      const existing = data.checks[i];
      // A blank secret means "leave it alone", so an edit form never has to
      // round-trip a credential through the browser to avoid clearing it.
      const secret = typeof spec.secret === 'string' && spec.secret.trim()
        ? secretBox.seal(spec.secret.trim()) : existing.secret;
      data.checks[i] = { ...existing, ...norm, secret, updatedAt: now() };
      await writeJson(file, data, { mode: 0o600 });
      return redact(data.checks[i]);
    },
    async removeCheck(id) {
      const data = await readAll();
      const before = data.checks.length;
      data.checks = data.checks.filter((c) => c.id !== id);
      if (data.checks.length === before) return false;
      await writeJson(file, data, { mode: 0o600 });
      return true;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/checkStore.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/checkStore.js test/checkStore.test.js
git commit -m "feat(alerts): sealed check definition store"
```

---

## Task 6: The HTTP check executor

**Files:**
- Create: `src/server/checks/httpCheck.js`
- Test: `test/httpCheck.integration.test.js`

**Interfaces:**
- Consumes: check definitions from Task 5.
- Produces: `runHttpCheck(check, { now, fetchImpl })` returning `{ ok, detail, latencyMs }`. `check.assert` supports `{ status: [min,max], bodyIncludes: 'string' }`, defaulting to a 200–399 status range.

- [ ] **Step 1: Write the failing test**

```js
// test/httpCheck.integration.test.js
import { test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runHttpCheck } from '../src/server/checks/httpCheck.js';

const servers = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
});

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
const check = (url, over = {}) => ({ type: 'http', target: { url }, assert: {}, timeoutMs: 2000, ...over });

test('a 200 response passes', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('ok'); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(true);
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a 502 response fails and the detail names the status', async () => {
  const url = await serve((_req, res) => { res.writeHead(502); res.end('bad gateway'); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('502');
});

test('a custom status range accepts what the default range would reject', async () => {
  const url = await serve((_req, res) => { res.writeHead(404); res.end(); });
  expect((await runHttpCheck(check(url, { assert: { status: [404, 404] } }))).ok).toBe(true);
});

test('bodyIncludes fails when the marker is absent', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('degraded'); });
  const got = await runHttpCheck(check(url, { assert: { bodyIncludes: 'healthy' } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('healthy');
});

test('bodyIncludes passes when the marker is present', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('all healthy here'); });
  expect((await runHttpCheck(check(url, { assert: { bodyIncludes: 'healthy' } }))).ok).toBe(true);
});

test('a hung server fails on the timeout rather than hanging the runner', async () => {
  const url = await serve(() => { /* never responds */ });
  const got = await runHttpCheck(check(url, { timeoutMs: 1000 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/timed out|abort/i);
});

test('a connection refused is a check failure, not a thrown error', async () => {
  const got = await runHttpCheck(check('http://127.0.0.1:1/health', { timeoutMs: 1000 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/httpCheck.integration.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/checks/httpCheck.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checks/httpCheck.js
// Probe an HTTP surface. Every failure path — bad status, missing marker,
// timeout, refused connection — returns ok:false rather than throwing, so the
// runner treats "the target is broken" and "the probe could not run" alike:
// both are the check failing, which is what the operator wants to hear about.
const DEFAULT_STATUS_RANGE = [200, 399];

export async function runHttpCheck(check, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  const started = now();
  const [min, max] = check.assert?.status || DEFAULT_STATUS_RANGE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs || 10000);
  try {
    const res = await fetchImpl(check.target.url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    const body = check.assert?.bodyIncludes ? await res.text() : '';
    if (res.status < min || res.status > max) {
      return { ok: false, detail: `HTTP ${res.status} (expected ${min}-${max})`, latencyMs: now() - started };
    }
    if (check.assert?.bodyIncludes && !body.includes(check.assert.bodyIncludes)) {
      return { ok: false, detail: `body did not contain "${check.assert.bodyIncludes}"`, latencyMs: now() - started };
    }
    return { ok: true, detail: `HTTP ${res.status}`, latencyMs: now() - started };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      detail: aborted ? `timed out after ${check.timeoutMs || 10000}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/httpCheck.integration.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/checks/httpCheck.js test/httpCheck.integration.test.js
git commit -m "feat(alerts): http check executor"
```

---

## Task 7: The check dispatcher and runner

**Files:**
- Create: `src/server/checks/index.js`, `src/server/checkRunner.js`
- Test: `test/checkRunner.test.js`

**Interfaces:**
- Consumes: `createCheckStore` (Task 5), `runHttpCheck` (Task 6), `createEventLog` (Task 1), `mapWithConcurrency` (existing).
- Produces:
  - `createCheckDispatcher({ runners })` returning `{ run(check) }`, where `runners` maps a type name to an executor.
  - `createCheckRunner({ checkStore, dispatcher, eventLog, now, setIntervalFn, clearIntervalFn, concurrency, jitter })` returning `{ runDue(), runOne(id), start(), stop(), getState() }`. `getState()` returns `{ [checkId]: { lastRunAt, nextRunAt, ok, consecutiveOk, consecutiveFail, detail, latencyMs } }`.

- [ ] **Step 1: Write the failing test**

```js
// test/checkRunner.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createCheckRunner } from '../src/server/checkRunner.js';
import { createCheckDispatcher } from '../src/server/checks/index.js';

const mk = async (checks, results) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  let t = 1000;
  const clock = { get: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => clock.get() });
  const dispatcher = createCheckDispatcher({
    runners: { http: async (c) => results[c.id].shift() ?? { ok: true, detail: 'ok', latencyMs: 1 } },
  });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => checks, getCheck: async (id) => checks.find((c) => c.id === id) },
    dispatcher, eventLog, now: () => clock.get(), jitter: () => 0,
  });
  return { runner, eventLog, clock, dir };
};
const chk = (over) => ({
  id: 'c1', label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' },
  assert: {}, intervalSec: 30, timeoutMs: 1000, severity: 'critical',
  failuresBeforeNotify: 2, enabled: true, ...over,
});

test('a failing check appends one firing occurrence per failed run', async () => {
  const { runner, eventLog } = await mk([chk()], { c1: [{ ok: false, detail: 'HTTP 502', latencyMs: 4 }] });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    via: 'check', key: 'check:c1', source: 'check:c1', severity: 'critical', state: 'firing',
  });
  expect(events[0].title).toContain('HTTP 502');
});

test('a passing check emits nothing at all — silence is the normal case', async () => {
  const { runner, eventLog } = await mk([chk()], { c1: [{ ok: true, detail: 'HTTP 200', latencyMs: 3 }] });
  await runner.runDue();
  expect(await eventLog.readSince(0)).toEqual([]);
});

test('recovery requires two consecutive successes, so a flapping check emits no resolution', async () => {
  const { runner, eventLog, clock } = await mk([chk()], {
    c1: [
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
    ],
  });
  for (let i = 0; i < 4; i++) { await runner.runDue(); clock.advance(30000); }
  const events = await eventLog.readSince(0);
  expect(events.filter((e) => e.state === 'resolved')).toHaveLength(0);
  expect(events.filter((e) => e.state === 'firing')).toHaveLength(2);
});

test('two consecutive successes after a failure emit exactly one resolution', async () => {
  const { runner, eventLog, clock } = await mk([chk()], {
    c1: [
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
    ],
  });
  for (let i = 0; i < 4; i++) { await runner.runDue(); clock.advance(30000); }
  const resolved = (await eventLog.readSince(0)).filter((e) => e.state === 'resolved');
  expect(resolved).toHaveLength(1);
});

test('a check is not run again before its interval elapses', async () => {
  let calls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  let t = 1000;
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => { calls++; return { ok: true, detail: '', latencyMs: 1 }; } } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => t }),
    now: () => t, jitter: () => 0,
  });
  await runner.runDue();
  t += 5000;
  await runner.runDue();
  expect(calls).toBe(1);
  t += 30000;
  await runner.runDue();
  expect(calls).toBe(2);
});

test('a disabled check never runs', async () => {
  const { runner, eventLog } = await mk([chk({ enabled: false })], { c1: [{ ok: false, detail: 'x', latencyMs: 1 }] });
  await runner.runDue();
  expect(await eventLog.readSince(0)).toEqual([]);
});

test('an executor that throws becomes a check failure, never an unhandled rejection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => { throw new Error('boom'); } } }),
    eventLog, now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0].title).toContain('boom');
});

test('overlapping cycles are coalesced so a slow check never runs twice at once', async () => {
  let active = 0, peak = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({
      runners: { http: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--; return { ok: true, detail: '', latencyMs: 1 };
      } },
    }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await Promise.all([runner.runDue(), runner.runDue(), runner.runDue()]);
  expect(peak).toBe(1);
});

test('getState reports the last result and the next due time', async () => {
  const { runner } = await mk([chk()], { c1: [{ ok: false, detail: 'HTTP 502', latencyMs: 7 }] });
  await runner.runDue();
  expect(runner.getState().c1).toMatchObject({
    ok: false, consecutiveFail: 1, consecutiveOk: 0, detail: 'HTTP 502', latencyMs: 7, nextRunAt: 31000,
  });
});

test('the sealed secret is resolved for a due check so executors can authenticate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const seen = [];
  const redacted = { ...chk(), hasSecret: true };
  const runner = createCheckRunner({
    checkStore: {
      // A listing is redacted, exactly as checkStore.listChecks returns it.
      listChecks: async () => [redacted],
      getCheck: async (_id, opts) => (opts?.withSecret ? { ...chk(), secret: 'tok-abc' } : redacted),
    },
    dispatcher: createCheckDispatcher({
      runners: { http: async (c) => { seen.push(c.secret); return { ok: true, detail: '', latencyMs: 1 }; } },
    }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  expect(seen).toEqual(['tok-abc']);
});

test('an unknown type fails the check with a readable detail instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk({ type: 'tcp' })], getCheck: async () => chk({ type: 'tcp' }) },
    dispatcher: createCheckDispatcher({ runners: {} }),
    eventLog, now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  expect((await eventLog.readSince(0))[0].title).toMatch(/no executor/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/checkRunner.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/checks/index.js"`

- [ ] **Step 3: Write the dispatcher**

```js
// src/server/checks/index.js
// Type-to-executor lookup, injected rather than imported, so a test can supply a
// fake executor and the runner never grows a switch statement over check types.
export function createCheckDispatcher({ runners = {} } = {}) {
  return {
    async run(check, deps = {}) {
      const fn = runners[check.type];
      if (!fn) return { ok: false, detail: `no executor for type "${check.type}"`, latencyMs: 0 };
      return fn(check, deps);
    },
  };
}
```

- [ ] **Step 4: Write the runner**

```js
// src/server/checkRunner.js
import { mapWithConcurrency } from './concurrency.js';

// Scheduling only. The runner decides *when* a check runs and translates its
// result into occurrences; it never decides whether anything is worth telling
// the operator — that is alertPolicy.js, and keeping the two apart is what makes
// the notification rules testable without a scheduler.
//
// Recovery deliberately requires two consecutive successes: a flapping check
// would otherwise emit a resolve-and-refire pair every cycle, which is its own
// kind of drowning.
const RESOLVE_AFTER_OK = 2;

export function createCheckRunner({
  checkStore, dispatcher, eventLog, deps = {},
  now = () => Date.now(), intervalMs = 5000, concurrency = 4,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  jitter = (ms) => Math.floor(Math.random() * ms),
}) {
  const state = new Map();
  let timer = null;
  let inFlight = null;

  const entry = (id) => {
    if (!state.has(id)) {
      state.set(id, { lastRunAt: null, nextRunAt: 0, ok: null, consecutiveOk: 0, consecutiveFail: 0, detail: '', latencyMs: null });
    }
    return state.get(id);
  };

  async function execute(check) {
    const s = entry(check.id);
    let result;
    try {
      result = await dispatcher.run(check, deps);
    } catch (e) {
      result = { ok: false, detail: e?.message || 'check threw', latencyMs: 0 };
    }
    const ts = now();
    s.lastRunAt = ts;
    // Jitter spreads same-interval checks so they do not all fire on the same
    // tick and stampede a shared target.
    s.nextRunAt = ts + check.intervalSec * 1000 + jitter(1000);
    s.ok = result.ok;
    s.detail = result.detail;
    s.latencyMs = result.latencyMs;

    if (result.ok) {
      s.consecutiveFail = 0;
      s.consecutiveOk += 1;
      // resolvedPending is set by any failure and cleared only once two
      // successes have landed, which is what stops a flapping check from
      // emitting a resolve-and-refire pair every cycle.
      if (s.resolvedPending && s.consecutiveOk >= RESOLVE_AFTER_OK) {
        s.resolvedPending = false;
        await eventLog.append({
          via: 'check', source: `check:${check.id}`, key: `check:${check.id}`, norm: null,
          severity: check.severity, state: 'resolved',
          title: `${check.label} recovered`, body: result.detail || '',
        });
      }
      void wasFailing;
    } else {
      s.consecutiveOk = 0;
      s.consecutiveFail += 1;
      s.resolvedPending = true;
      await eventLog.append({
        via: 'check', source: `check:${check.id}`, key: `check:${check.id}`, norm: null,
        severity: check.severity, state: 'firing',
        title: `${check.label}: ${result.detail}`, body: result.detail || '',
      });
    }
    return result;
  }

  function runDue() {
    // Coalesce, exactly as statusPoller.js does: the tick fires on a fixed
    // cadence whether or not the previous cycle finished.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const checks = (await checkStore.listChecks()).filter((c) => c.enabled);
      const due = checks.filter((c) => now() >= entry(c.id).nextRunAt);
      // Listings are redacted, so resolve the sealed secret only for the checks
      // actually about to run. The decrypted value lives in memory for the
      // duration of one probe and never enters a listing, a route response, or
      // the event log.
      await mapWithConcurrency(due, concurrency, async (c) => {
        const full = await checkStore.getCheck(c.id, { withSecret: true });
        return execute(full || c);
      });
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    runDue,
    async runOne(id) {
      const check = await checkStore.getCheck(id, { withSecret: true });
      if (!check) return null;
      return execute(check);
    },
    getState: () => Object.fromEntries([...state.entries()].map(([k, v]) => [k, { ...v }])),
    async start() {
      await runDue();
      timer = setIntervalFn(() => { runDue().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/checkRunner.test.js`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add src/server/checks/index.js src/server/checkRunner.js test/checkRunner.test.js
git commit -m "feat(alerts): check dispatcher and scheduling runner"
```

---

## Task 8: Alert rules and triage state

**Files:**
- Create: `src/server/alertStateStore.js`
- Test: `test/alertStateStore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` (existing).
- Produces: `createAlertStateStore({ dataDir, now })` returning `{ getRules(), mute(key), unmute(key), setOverride(key, patch), getTriage(), ack(key), isAcked(key, lastTs) }`. `getRules()` returns `{ mutes: string[], overrides: object }` in exactly the shape `decideAlert` consumes.

- [ ] **Step 1: Write the failing test**

```js
// test/alertStateStore.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlertStateStore } from '../src/server/alertStateStore.js';

const mk = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertstate-'));
  return { dataDir, store: createAlertStateStore({ dataDir, now: () => 5000 }) };
};

test('a fresh store returns rules in the exact shape decideAlert consumes', async () => {
  const { store } = await mk();
  expect(await store.getRules()).toEqual({ mutes: [], overrides: {} });
});

test('mute is idempotent and unmute reverses it', async () => {
  const { store } = await mk();
  await store.mute('check:a');
  await store.mute('check:a');
  expect((await store.getRules()).mutes).toEqual(['check:a']);
  await store.unmute('check:a');
  expect((await store.getRules()).mutes).toEqual([]);
});

test('setOverride merges rather than replacing, so one field does not clear another', async () => {
  const { store } = await mk();
  await store.setOverride('check:a', { failuresBeforeNotify: 5 });
  await store.setOverride('check:a', { severity: 'critical' });
  expect((await store.getRules()).overrides['check:a']).toEqual({ failuresBeforeNotify: 5, severity: 'critical' });
});

test('ack records the acknowledged timestamp for the key', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.getTriage()).toEqual({ 'check:a': { ackedAt: 5000 } });
});

test('an ack covers occurrences up to its moment but not later ones', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.isAcked('check:a', 4000)).toBe(true);
  expect(await store.isAcked('check:a', 6000)).toBe(false);
});

test('rules and triage live in separate files', async () => {
  const { store, dataDir } = await mk();
  await store.mute('check:a');
  await store.ack('check:b');
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'alert-rules.json'), 'utf8')).mutes).toEqual(['check:a']);
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'alert-triage.json'), 'utf8')).acks['check:b']).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertStateStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/alertStateStore.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertStateStore.js
import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// Operator decisions, split across two files because they have different
// lifetimes: rules are durable policy, acks are transient triage.
export function createAlertStateStore({ dataDir, now = () => Date.now() }) {
  const rulesFile = path.join(dataDir, 'alert-rules.json');
  const triageFile = path.join(dataDir, 'alert-triage.json');
  const objShape = (v) => v && typeof v === 'object' && !Array.isArray(v);

  const readRules = async () => ({
    version: VERSION, mutes: [], overrides: {},
    ...await readJson(rulesFile, { fallback: {}, validate: objShape }),
  });
  const readTriage = async () => ({
    version: VERSION, acks: {},
    ...await readJson(triageFile, { fallback: {}, validate: objShape }),
  });

  return {
    async getRules() {
      const r = await readRules();
      return { mutes: r.mutes, overrides: r.overrides };
    },
    async mute(key) {
      const r = await readRules();
      if (!r.mutes.includes(key)) r.mutes.push(key);
      await writeJson(rulesFile, r, { mode: 0o600 });
    },
    async unmute(key) {
      const r = await readRules();
      r.mutes = r.mutes.filter((k) => k !== key);
      await writeJson(rulesFile, r, { mode: 0o600 });
    },
    async setOverride(key, patch) {
      const r = await readRules();
      r.overrides[key] = { ...(r.overrides[key] || {}), ...patch };
      await writeJson(rulesFile, r, { mode: 0o600 });
    },
    async getTriage() {
      return (await readTriage()).acks;
    },
    async ack(key) {
      const t = await readTriage();
      t.acks[key] = { ackedAt: now() };
      await writeJson(triageFile, t, { mode: 0o600 });
    },
    async isAcked(key, lastTs) {
      const acked = (await readTriage()).acks[key];
      return !!acked && acked.ackedAt >= lastTs;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertStateStore.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/alertStateStore.js test/alertStateStore.test.js
git commit -m "feat(alerts): mute, override, and ack state store"
```

---

## Task 9: The alert manager

**Files:**
- Create: `src/server/alertManager.js`
- Test: `test/alertManager.test.js`

**Interfaces:**
- Consumes: `foldEvents` (Task 2), `decideAlert` + `DEFAULT_THRESHOLDS` (Task 3), `createEventLog` (Task 1), `createAlertStateStore` (Task 8).
- Produces: `createAlertManager({ eventLogs, decisionLog, stateStore, channels, now, thresholds, lookbackMs, setIntervalFn, clearIntervalFn, intervalMs })` returning `{ evaluate(), listAlerts(), start(), stop() }`. `evaluate()` returns the decisions it appended. `channels` is an array of `{ name, deliver(alert, reason) -> { ok, error } }`.

- [ ] **Step 1: Write the failing test**

```js
// test/alertManager.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createAlertStateStore } from '../src/server/alertStateStore.js';
import { createAlertManager } from '../src/server/alertManager.js';

const mk = async ({ delivers = async () => ({ ok: true }) } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  let t = 1000;
  const clock = { get: () => t, advance: (ms) => { t += ms; } };
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now: () => clock.get() });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now: () => clock.get() });
  const sent = [];
  const manager = createAlertManager({
    eventLogs: [checks], decisionLog: decisions,
    stateStore: createAlertStateStore({ dataDir, now: () => clock.get() }),
    channels: [{ name: 'mail', deliver: async (a, r) => { sent.push({ key: a.key, reason: r }); return delivers(); } }],
    now: () => clock.get(),
  });
  return { manager, checks, decisions, clock, sent, dataDir };
};
const firing = (over = {}) => ({
  via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
  severity: 'critical', state: 'firing', title: 'Invoice app: HTTP 502', body: '', ...over,
});

test('a critical alert notifies once and records the decision', async () => {
  const { manager, checks, decisions, sent } = await mk();
  await checks.append(firing());
  const got = await manager.evaluate();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ key: 'check:c1', reason: 'notified', notify: true });
  expect(sent).toEqual([{ key: 'check:c1', reason: 'notified' }]);
  expect((await decisions.readSince(0))[0].reason).toBe('notified');
});

test('a second evaluation inside the cooldown records suppression and sends nothing more', async () => {
  const { manager, checks, clock, sent, decisions } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  clock.advance(60000);
  await checks.append(firing());
  await manager.evaluate();
  expect(sent).toHaveLength(1);
  const reasons = (await decisions.readSince(0)).map((d) => d.reason);
  expect(reasons).toEqual(['notified', 'suppressed:cooldown']);
});

test('a withheld alert is still recorded, so nothing is ever silently dropped', async () => {
  const { manager, checks, decisions, sent } = await mk();
  await checks.append(firing({ severity: 'warning' }));
  await manager.evaluate();
  expect(sent).toEqual([]);
  expect((await decisions.readSince(0))[0].reason).toBe('held:below-persistence');
});

test('a delivery failure is recorded as notify:failed and does not consume the cooldown', async () => {
  const { manager, checks, decisions, clock } = await mk({ delivers: async () => ({ ok: false, error: 'relay down' }) });
  await checks.append(firing());
  await manager.evaluate();
  expect((await decisions.readSince(0))[0]).toMatchObject({ reason: 'notify:failed', error: 'relay down' });
  clock.advance(60000);
  await checks.append(firing());
  await manager.evaluate();
  // The retry is a fresh attempt rather than a cooldown suppression: a failed
  // send must not count as having reached anyone.
  expect((await decisions.readSince(0)).map((d) => d.reason)).toEqual(['notify:failed', 'notify:failed']);
});

test('decisions are re-derived after a restart without duplicate notifications', async () => {
  const { manager, checks, decisions, dataDir, clock, sent } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  const restarted = createAlertManager({
    eventLogs: [createEventLog({ dir: dataDir, prefix: 'checks', now: () => clock.get() })],
    decisionLog: decisions,
    stateStore: createAlertStateStore({ dataDir, now: () => clock.get() }),
    channels: [{ name: 'mail', deliver: async () => { sent.push('again'); return { ok: true }; } }],
    now: () => clock.get(),
  });
  clock.advance(60000);
  await restarted.evaluate();
  expect(sent).toHaveLength(1); // the pre-restart notification is honoured, not repeated
});

test('listAlerts returns folded open alerts with their latest decision reason', async () => {
  const { manager, checks } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  const [alert] = await manager.listAlerts();
  expect(alert).toMatchObject({ key: 'check:c1', count: 1, state: 'firing', reason: 'notified' });
});

test('a resolved alert stops notifying and is recorded as skipped:resolved', async () => {
  const { manager, checks, decisions, clock } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  clock.advance(60000);
  await checks.append(firing({ state: 'resolved', title: 'Invoice app recovered' }));
  await manager.evaluate();
  expect((await decisions.readSince(0)).map((d) => d.reason)).toEqual(['notified', 'skipped:resolved']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertManager.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/alertManager.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertManager.js
import { foldEvents } from './alertFold.js';
import { decideAlert, DEFAULT_THRESHOLDS } from './alertPolicy.js';

// The evaluation loop: fold the append-only logs into alerts, ask the policy
// engine about each one, record the answer, and deliver the ones that clear the
// bar. The cooldown watermark is re-derived from the decision log rather than
// held in memory, so a restart never re-notifies an alert it already sent.
export function createAlertManager({
  eventLogs, decisionLog, stateStore, channels = [],
  now = () => Date.now(), thresholds = DEFAULT_THRESHOLDS,
  lookbackMs = 7 * 86400000, intervalMs = 30000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let timer = null;
  let inFlight = null;

  async function readEvents() {
    const since = now() - lookbackMs;
    const all = [];
    for (const log of eventLogs) all.push(...await log.readSince(since, now()));
    return all;
  }

  async function lastNotifiedMap() {
    const since = now() - lookbackMs;
    const map = new Map();
    for (const d of await decisionLog.readSince(since, now())) {
      // Only a *delivered* notification starts a cooldown. A notify:failed
      // reached nobody, so treating it as a send would silence the retry.
      if (d.reason === 'notified') map.set(d.key, d.ts);
    }
    return map;
  }

  async function evaluate() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const [events, rules, notified] = await Promise.all([readEvents(), stateStore.getRules(), lastNotifiedMap()]);
      const alerts = foldEvents(events, { nowMs: now(), windowMs: thresholds.warnWindowMs });
      const out = [];
      for (const alert of alerts) {
        const { notify, reason } = decideAlert({
          alert, rules, nowMs: now(), lastNotifiedAt: notified.get(alert.key) ?? null, thresholds,
        });
        if (!notify) {
          out.push(await decisionLog.append({ key: alert.key, reason, notify: false, error: null }));
          continue;
        }
        let error = null;
        for (const ch of channels) {
          const res = await ch.deliver(alert, reason).catch((e) => ({ ok: false, error: e?.message || 'channel threw' }));
          if (!res.ok) error = res.error || 'delivery failed';
        }
        out.push(await decisionLog.append({
          key: alert.key, reason: error ? 'notify:failed' : 'notified', notify: !error, error,
        }));
      }
      return out;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    evaluate,
    async listAlerts() {
      const [events, decisions] = await Promise.all([readEvents(), decisionLog.readSince(now() - lookbackMs, now())]);
      const latest = new Map();
      for (const d of decisions) latest.set(d.key, d.reason);
      return foldEvents(events, { nowMs: now(), windowMs: thresholds.warnWindowMs })
        .map((a) => ({ ...a, reason: latest.get(a.key) || null }));
    },
    async start() {
      await evaluate();
      timer = setIntervalFn(() => { evaluate().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertManager.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/alertManager.js test/alertManager.test.js
git commit -m "feat(alerts): evaluation loop with restart-safe cooldown watermark"
```

---

## Task 10: Minimal SMTP client

**Files:**
- Create: `src/server/mailer.js`
- Create: `test/helpers/fakeSmtp.js`
- Test: `test/mailer.integration.test.js`

**Interfaces:**
- Consumes: nothing (no new dependencies — `node:net` and `node:tls` only).
- Produces: `createMailer({ host, port, from, to, user, pass, useTls, timeoutMs })` returning `{ send({ subject, text, headers }) -> { ok, error } }`. `headers` is a plain object of extra headers; the caller uses it for the loop-guard header.
- Also produces the test helper `startFakeSmtp()` returning `{ port, messages, close() }`, reused by Task 21.

- [ ] **Step 1: Write the fake SMTP server helper**

```js
// test/helpers/fakeSmtp.js
import net from 'node:net';

// A real socket server speaking just enough SMTP to accept a message. Used
// instead of a mock so the mailer is exercised over an actual TCP conversation.
export async function startFakeSmtp({ requireAuth = false, failAt = null } = {}) {
  const messages = [];
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    let current = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = { rcpt: [], data: '' };
            sock.write('250 queued\r\n');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (failAt && cmd === failAt) { sock.write('550 refused\r\n'); continue; }
        if (cmd === 'EHLO') sock.write(requireAuth ? '250-fake\r\n250 AUTH LOGIN\r\n' : '250 fake\r\n');
        else if (cmd === 'AUTH') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (cmd === 'MAIL') { current.from = line; sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { current.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('235 ok\r\n'); // AUTH continuation lines
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    messages,
    close: () => new Promise((r) => server.close(r)),
  };
}
```

- [ ] **Step 2: Write the failing test**

```js
// test/mailer.integration.test.js
import { test, expect, afterEach } from 'vitest';
import { startFakeSmtp } from './helpers/fakeSmtp.js';
import { createMailer } from '../src/server/mailer.js';

let running = null;
afterEach(async () => { if (running) { await running.close(); running = null; } });

const mailerFor = (smtp, over = {}) => createMailer({
  host: '127.0.0.1', port: smtp.port, from: 'alerts@example.com', to: 'ops@example.com',
  timeoutMs: 3000, ...over,
});

test('send delivers a message the server accepts', async () => {
  running = await startFakeSmtp();
  const got = await mailerFor(running).send({ subject: 'CRITICAL Invoice app', text: 'HTTP 502' });
  expect(got).toEqual({ ok: true, error: null });
  expect(running.messages).toHaveLength(1);
  expect(running.messages[0].data).toContain('Subject: CRITICAL Invoice app');
  expect(running.messages[0].data).toContain('HTTP 502');
});

test('extra headers ride along, which is what the loop guard depends on', async () => {
  running = await startFakeSmtp();
  await mailerFor(running).send({ subject: 's', text: 't', headers: { 'X-Tmuxifier-Alert': '1' } });
  expect(running.messages[0].data).toContain('X-Tmuxifier-Alert: 1');
});

test('a body line of a single dot is stuffed so it cannot terminate DATA early', async () => {
  running = await startFakeSmtp();
  await mailerFor(running).send({ subject: 's', text: 'before\n.\nafter' });
  expect(running.messages[0].data).toContain('before');
  expect(running.messages[0].data).toContain('after');
});

test('a rejected recipient returns ok:false rather than throwing', async () => {
  running = await startFakeSmtp({ failAt: 'RCPT' });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
});

test('a refused connection returns ok:false', async () => {
  const got = await createMailer({
    host: '127.0.0.1', port: 1, from: 'a@example.com', to: 'b@example.com', timeoutMs: 1000,
  }).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toBeTruthy();
});

test('AUTH LOGIN runs when credentials are configured', async () => {
  running = await startFakeSmtp({ requireAuth: true });
  const got = await mailerFor(running, { user: 'u', pass: 'p' }).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/mailer.integration.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/mailer.js"`

- [ ] **Step 4: Write minimal implementation**

```js
// src/server/mailer.js
import net from 'node:net';
import tls from 'node:tls';

// Hand-rolled SMTP submission, dependency-free in the spirit of googleAuth.js
// and webauthn.js. Every failure returns { ok: false, error } instead of
// throwing: a relay being down must be recorded as notify:failed, never crash
// the evaluation loop.
function readReply(sock, expectPrefix) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return; // multiline reply still in progress
      cleanup();
      if (expectPrefix && !expectPrefix.includes(last[0])) reject(new Error(last.trim()));
      else resolve(last);
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => { sock.off('data', onData); sock.off('error', onErr); };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

export function createMailer({ host, port = 25, from, to, user = null, pass = null, useTls = false, timeoutMs = 15000 }) {
  return {
    async send({ subject, text, headers = {} }) {
      let sock;
      try {
        sock = await new Promise((resolve, reject) => {
          const s = (useTls ? tls : net).connect({ host, port, servername: host }, () => resolve(s));
          s.setTimeout(timeoutMs, () => { s.destroy(new Error('smtp timed out')); });
          s.once('error', reject);
        });
        const say = async (line, expect = ['2', '3']) => {
          sock.write(`${line}\r\n`);
          return readReply(sock, expect);
        };
        await readReply(sock, ['2']);
        await say(`EHLO ${'tmuxifier'}`);
        if (user && pass) {
          await say('AUTH LOGIN');
          await say(Buffer.from(user).toString('base64'));
          await say(Buffer.from(pass).toString('base64'));
        }
        await say(`MAIL FROM:<${from}>`);
        for (const rcpt of String(to).split(',').map((r) => r.trim()).filter(Boolean)) {
          await say(`RCPT TO:<${rcpt}>`);
        }
        await say('DATA', ['3']);
        const head = [
          `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
          'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ].join('\r\n');
        // Dot-stuffing: a body line that is exactly "." would otherwise end DATA.
        const body = String(text).split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
        sock.write(`${head}\r\n\r\n${body}\r\n.\r\n`);
        await readReply(sock, ['2']);
        sock.write('QUIT\r\n');
        return { ok: true, error: null };
      } catch (e) {
        return { ok: false, error: e?.message || 'smtp send failed' };
      } finally {
        try { sock?.destroy(); } catch { /* already closed */ }
      }
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mailer.integration.test.js`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add src/server/mailer.js test/helpers/fakeSmtp.js test/mailer.integration.test.js
git commit -m "feat(alerts): dependency-free SMTP submission client"
```

---

## Task 11: Mail formatting and the delivery channel

**Files:**
- Create: `src/server/alertMail.js`
- Test: `test/alertMail.test.js`

**Interfaces:**
- Consumes: `Alert` (Task 2), `createMailer` (Task 10).
- Produces: `LOOP_GUARD_HEADER` (`'X-Tmuxifier-Alert'`), `formatAlertMail(alert, reason)` returning `{ subject, text }`, `formatDigest(alerts, { dayKey })` returning `{ subject, text }`, and `createMailChannel({ mailer })` returning `{ name: 'mail', deliver(alert, reason) }`.

- [ ] **Step 1: Write the failing test**

```js
// test/alertMail.test.js
import { test, expect } from 'vitest';
import { formatAlertMail, formatDigest, createMailChannel, LOOP_GUARD_HEADER } from '../src/server/alertMail.js';

const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'critical', state: 'firing',
  count: 47, recentCount: 12, firstTs: Date.parse('2026-07-25T03:12:00Z'),
  lastTs: Date.parse('2026-07-25T06:40:00Z'), title: 'Invoice app: HTTP 502',
  body: 'gateway timeout', ...over,
});

test('the subject leads with severity so a mail client can sort on it', () => {
  expect(formatAlertMail(alert(), 'notified').subject).toBe('[CRITICAL] Invoice app: HTTP 502');
});

test('the body carries the fold, not just the latest occurrence', () => {
  const { text } = formatAlertMail(alert(), 'notified');
  expect(text).toContain('Occurrences: 47');
  expect(text).toContain('First seen: 2026-07-25T03:12:00.000Z');
  expect(text).toContain('Last seen: 2026-07-25T06:40:00.000Z');
  expect(text).toContain('Source: check:c1');
});

test('the body states the policy reason, so the mail explains why it arrived', () => {
  expect(formatAlertMail(alert(), 'notified').text).toContain('Reason: notified');
});

test('a digest lists withheld alerts one per line and names the day', () => {
  const { subject, text } = formatDigest(
    [alert({ severity: 'info', title: 'Backup ran long', count: 2 })],
    { dayKey: '2026-07-25' },
  );
  expect(subject).toBe('[digest] Tmuxifier alerts for 2026-07-25');
  expect(text).toContain('Backup ran long');
  expect(text).toContain('x2');
});

test('an empty digest says so plainly rather than sending a blank message', () => {
  expect(formatDigest([], { dayKey: '2026-07-25' }).text).toContain('Nothing below the line');
});

test('every message carries the loop-guard header', async () => {
  const sent = [];
  const channel = createMailChannel({ mailer: { send: async (m) => { sent.push(m); return { ok: true, error: null }; } } });
  await channel.deliver(alert(), 'notified');
  expect(sent[0].headers[LOOP_GUARD_HEADER]).toBe('1');
});

test('a mailer failure surfaces as a channel failure rather than an exception', async () => {
  const channel = createMailChannel({ mailer: { send: async () => ({ ok: false, error: 'relay down' }) } });
  expect(await channel.deliver(alert(), 'notified')).toEqual({ ok: false, error: 'relay down' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertMail.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/alertMail.js"`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertMail.js
// This system both sends and receives mail (phase 2 adds the sink), so every
// outbound message is stamped with a header the sink refuses. Without it, a
// relay that bounces or forwards back produces alerts about generating alerts,
// without end.
export const LOOP_GUARD_HEADER = 'X-Tmuxifier-Alert';

const iso = (ms) => new Date(ms).toISOString();

export function formatAlertMail(alert, reason) {
  const subject = `[${alert.severity.toUpperCase()}] ${alert.title}`;
  const text = [
    alert.title,
    '',
    `Source: ${alert.source}`,
    `Key: ${alert.key}`,
    `Severity: ${alert.severity}`,
    `Occurrences: ${alert.count}`,
    alert.firstTs ? `First seen: ${iso(alert.firstTs)}` : null,
    alert.lastTs ? `Last seen: ${iso(alert.lastTs)}` : null,
    `Reason: ${reason}`,
    '',
    alert.body || '',
  ].filter((l) => l !== null).join('\n');
  return { subject, text };
}

export function formatDigest(alerts, { dayKey }) {
  const subject = `[digest] Tmuxifier alerts for ${dayKey}`;
  const lines = alerts.map((a) => `- [${a.severity}] ${a.title} (x${a.count}, ${a.source})`);
  const text = lines.length
    ? ['Below the notification line today:', '', ...lines].join('\n')
    : 'Nothing below the line today.';
  return { subject, text };
}

export function createMailChannel({ mailer }) {
  return {
    name: 'mail',
    async deliver(alert, reason) {
      const { subject, text } = formatAlertMail(alert, reason);
      return mailer.send({ subject, text, headers: { [LOOP_GUARD_HEADER]: '1' } });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertMail.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/alertMail.js test/alertMail.test.js
git commit -m "feat(alerts): mail formatting and loop-guarded delivery channel"
```

---

## Task 12: Config knobs, REST routes, and wiring

**Files:**
- Modify: `src/server/config.js` (DEFAULTS block near `agentIdleSec:45`; env map near line 144; clamp block near line 292)
- Modify: `src/server/server.js` (add routes beside the NetBox routes; extend the `buildServer` destructuring)
- Modify: `src/server/index.js` (construct and start after the `createHealthHistory` wiring, before `buildServer`)
- Modify: `.env.example`
- Test: `test/alertRoutes.test.js`, `test/config.test.js` (extend)

**Interfaces:**
- Consumes: every module from Tasks 1–11.
- Produces: config keys `alertRetentionDays`, `alertCooldownHours`, `alertMail` (`{ host, port, from, to, user, pass, useTls }`), `alertEvalMs`; and the routes `GET /api/alerts`, `POST /api/alerts/:key/ack`, `POST /api/alerts/:key/mute`, `DELETE /api/alerts/:key/mute`, `GET /api/alerts/feed`, `GET /api/alerts/decisions`, `GET/POST /api/checks`, `PUT/DELETE /api/checks/:id`, `POST /api/checks/:id/run`.

- [ ] **Step 1: Write the failing route test**

```js
// test/alertRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createCheckStore } from '../src/server/checkStore.js';
import { createAlertStateStore } from '../src/server/alertStateStore.js';
import { createEventLog } from '../src/server/eventLog.js';
import { createAlertManager } from '../src/server/alertManager.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, checkStore, alertState, checkLog, ranIds;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-alertr-'));
  const secretBox = createSecretBox('test-secret');
  checkStore = createCheckStore({ dataDir: dir, secretBox });
  alertState = createAlertStateStore({ dataDir: dir });
  checkLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const decisionLog = createEventLog({ dir, prefix: 'decisions', now: () => 1000 });
  ranIds = [];
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    checkStore, alertState, checkEventLog: checkLog, decisionLog,
    alertManager: createAlertManager({
      eventLogs: [checkLog], decisionLog, stateStore: alertState, channels: [], now: () => 1000,
    }),
    checkRunner: { runOne: async (id) => { ranIds.push(id); return { ok: false, detail: 'HTTP 502', latencyMs: 3 }; }, getState: () => ({}) },
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('every alert and check route requires auth', async () => {
  for (const [method, url] of [
    ['GET', '/api/alerts'], ['GET', '/api/alerts/feed'], ['GET', '/api/alerts/decisions'],
    ['GET', '/api/checks'], ['POST', '/api/checks'], ['POST', '/api/alerts/k/ack'],
  ]) {
    expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
  }
});

test('a check can be created, listed, run on demand, and deleted', async () => {
  const h = await headers();
  const created = await app.inject({
    method: 'POST', url: '/api/checks', headers: h,
    payload: { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } },
  });
  expect(created.statusCode).toBe(200);
  const { check } = created.json();
  expect((await app.inject({ method: 'GET', url: '/api/checks', headers: h })).json().checks).toHaveLength(1);
  const ran = await app.inject({ method: 'POST', url: `/api/checks/${check.id}/run`, headers: h });
  expect(ran.json().result).toMatchObject({ ok: false, detail: 'HTTP 502' });
  expect(ranIds).toEqual([check.id]);
  expect((await app.inject({ method: 'DELETE', url: `/api/checks/${check.id}`, headers: h })).statusCode).toBe(200);
});

test('an invalid check definition is refused with 400 and a readable message', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/checks', headers: h, payload: { label: 'x', type: 'nope' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/type/);
});

test('a secret is never echoed back by any route', async () => {
  const h = await headers();
  await app.inject({
    method: 'POST', url: '/api/checks', headers: h,
    payload: { label: 'x', type: 'http', target: { url: 'https://example.com/h' }, secret: 'tok-abc' },
  });
  const body = (await app.inject({ method: 'GET', url: '/api/checks', headers: h })).body;
  expect(body).not.toContain('tok-abc');
  expect(JSON.parse(body).checks[0].hasSecret).toBe(true);
});

test('GET /api/alerts returns folded alerts and mute/ack round-trip', async () => {
  const h = await headers();
  await checkLog.append({
    via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
    severity: 'critical', state: 'firing', title: 'Invoice app: HTTP 502', body: '',
  });
  expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: h })).json().alerts[0])
    .toMatchObject({ key: 'check:c1', count: 1 });
  expect((await app.inject({ method: 'POST', url: '/api/alerts/check:c1/mute', headers: h })).statusCode).toBe(200);
  expect((await alertState.getRules()).mutes).toEqual(['check:c1']);
  await app.inject({ method: 'DELETE', url: '/api/alerts/check:c1/mute', headers: h });
  expect((await alertState.getRules()).mutes).toEqual([]);
  await app.inject({ method: 'POST', url: '/api/alerts/check:c1/ack', headers: h });
  expect(await alertState.getTriage()).toHaveProperty('check:c1');
});

test('the feed returns raw occurrences and the decisions route filters by key', async () => {
  const h = await headers();
  await checkLog.append({
    via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
    severity: 'info', state: 'firing', title: 'noisy', body: '',
  });
  expect((await app.inject({ method: 'GET', url: '/api/alerts/feed', headers: h })).json().events).toHaveLength(1);
  const dec = await app.inject({ method: 'GET', url: '/api/alerts/decisions?key=check:c1', headers: h });
  expect(Array.isArray(dec.json().decisions)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertRoutes.test.js`
Expected: FAIL — 404 on every new route (`buildServer` does not register them yet)

- [ ] **Step 3: Add the config knobs**

In `src/server/config.js`, add to the `DEFAULTS` object beside `agentIdleSec: 45`:

```js
  // Alert aggregation. The evaluation loop is cheap (it reads append-only files
  // and runs a pure decision function), so it ticks faster than the status poll.
  alertEvalMs: 30000,
  alertRetentionDays: 90,
  alertCooldownHours: 6,
  alertMail: { host: '', port: 25, from: '', to: '', user: '', pass: '', useTls: false },
```

Add to the env map beside `agentIdleSec`:

```js
    alertEvalMs: e.TMUXIFIER_ALERT_EVAL_MS ? Number(e.TMUXIFIER_ALERT_EVAL_MS) : undefined,
    alertRetentionDays: e.TMUXIFIER_ALERT_RETENTION_DAYS ? Number(e.TMUXIFIER_ALERT_RETENTION_DAYS) : undefined,
    alertCooldownHours: e.TMUXIFIER_ALERT_COOLDOWN_HOURS ? Number(e.TMUXIFIER_ALERT_COOLDOWN_HOURS) : undefined,
    alertMail: {
      host: e.TMUXIFIER_ALERT_MAIL_HOST, port: e.TMUXIFIER_ALERT_MAIL_PORT ? Number(e.TMUXIFIER_ALERT_MAIL_PORT) : undefined,
      from: e.TMUXIFIER_ALERT_MAIL_FROM, to: e.TMUXIFIER_ALERT_MAIL_TO,
      user: e.TMUXIFIER_ALERT_MAIL_USER, pass: e.TMUXIFIER_ALERT_MAIL_PASS,
      useTls: e.TMUXIFIER_ALERT_MAIL_TLS === undefined ? undefined : e.TMUXIFIER_ALERT_MAIL_TLS === 'on',
    },
```

Add to the clamp block beside `merged.agentIdleSec`:

```js
  merged.alertEvalMs = clampInt(merged.alertEvalMs, 1000, 3600000, DEFAULTS.alertEvalMs);
  merged.alertRetentionDays = clampInt(merged.alertRetentionDays, 1, 3650, DEFAULTS.alertRetentionDays);
  merged.alertCooldownHours = clampInt(merged.alertCooldownHours, 0, 720, DEFAULTS.alertCooldownHours);
  merged.alertMail = { ...DEFAULTS.alertMail, ...Object.fromEntries(
    Object.entries(merged.alertMail || {}).filter(([, v]) => v !== undefined && v !== '')) };
  merged.alertMail.port = clampInt(merged.alertMail.port, 1, 65535, DEFAULTS.alertMail.port);
```

Add to `.env.example`:

```
# --- Alert aggregation (optional) ---
# Outbound relay for curated alert mail. Leave TMUXIFIER_ALERT_MAIL_HOST empty to
# disable email delivery; alerts are still recorded and visible in the dashboard.
#TMUXIFIER_ALERT_MAIL_HOST=192.168.1.25
#TMUXIFIER_ALERT_MAIL_PORT=25
#TMUXIFIER_ALERT_MAIL_FROM=tmuxifier-alerts@example.com
#TMUXIFIER_ALERT_MAIL_TO=you@example.com
#TMUXIFIER_ALERT_MAIL_USER=
#TMUXIFIER_ALERT_MAIL_PASS=
#TMUXIFIER_ALERT_MAIL_TLS=off
# Hours a notified alert stays silent before it may notify again.
#TMUXIFIER_ALERT_COOLDOWN_HOURS=6
#TMUXIFIER_ALERT_RETENTION_DAYS=90
#TMUXIFIER_ALERT_EVAL_MS=30000
```

- [ ] **Step 4: Add the routes**

In `src/server/server.js`, add `checkStore, alertState, checkEventLog, decisionLog, alertManager, checkRunner` to the `buildServer` destructuring, then register beside the NetBox routes:

```js
  // Alert aggregation. Every route is auth-gated like the rest of /api; the
  // check secret is sealed in the store and never round-trips to the browser.
  if (checkStore && alertManager) {
    app.get('/api/checks', { preHandler: requireAuth }, async () => ({
      checks: await checkStore.listChecks(), state: checkRunner ? checkRunner.getState() : {},
    }));
    app.post('/api/checks', { preHandler: requireAuth }, async (req, reply) => {
      try { return { check: await checkStore.addCheck(req.body || {}) }; }
      catch (e) { return reply.code(400).send({ error: e.message }); }
    });
    app.put('/api/checks/:id', { preHandler: requireAuth }, async (req, reply) => {
      try {
        const check = await checkStore.updateCheck(req.params.id, req.body || {});
        return check ? { check } : reply.code(404).send({ error: 'no such check' });
      } catch (e) { return reply.code(400).send({ error: e.message }); }
    });
    app.delete('/api/checks/:id', { preHandler: requireAuth }, async (req, reply) => {
      const ok = await checkStore.removeCheck(req.params.id);
      return ok ? { ok: true } : reply.code(404).send({ error: 'no such check' });
    });
    app.post('/api/checks/:id/run', { preHandler: requireAuth }, async (req, reply) => {
      if (!checkRunner) return reply.code(503).send({ error: 'check runner not running' });
      const result = await checkRunner.runOne(req.params.id);
      return result ? { result } : reply.code(404).send({ error: 'no such check' });
    });

    app.get('/api/alerts', { preHandler: requireAuth }, async () => ({ alerts: await alertManager.listAlerts() }));
    app.post('/api/alerts/:key/ack', { preHandler: requireAuth }, async (req) => {
      await alertState.ack(req.params.key); return { ok: true };
    });
    app.post('/api/alerts/:key/mute', { preHandler: requireAuth }, async (req) => {
      await alertState.mute(req.params.key); return { ok: true };
    });
    app.delete('/api/alerts/:key/mute', { preHandler: requireAuth }, async (req) => {
      await alertState.unmute(req.params.key); return { ok: true };
    });
    app.get('/api/alerts/feed', { preHandler: requireAuth }, async (req) => {
      const sinceMs = Number(req.query?.since) || 0;
      const events = [];
      for (const log of [checkEventLog].filter(Boolean)) events.push(...await log.readSince(sinceMs));
      return { events: events.slice(-500) };
    });
    app.get('/api/alerts/decisions', { preHandler: requireAuth }, async (req) => {
      const sinceMs = Number(req.query?.since) || 0;
      const all = decisionLog ? await decisionLog.readSince(sinceMs) : [];
      const key = req.query?.key;
      return { decisions: (key ? all.filter((d) => d.key === key) : all).slice(-500) };
    });
  }
```

- [ ] **Step 5: Wire it in `src/server/index.js`**

After the `createHealthHistory` block and before `buildServer`:

```js
const eventsDir = path.join(config.dataDir, 'events');
const checkEventLog = createEventLog({ dir: eventsDir, prefix: 'checks' });
const inboundEventLog = createEventLog({ dir: eventsDir, prefix: 'inbound' });
const decisionLog = createEventLog({ dir: eventsDir, prefix: 'decisions' });
const checkStore = createCheckStore({ dataDir: config.dataDir, secretBox });
const alertState = createAlertStateStore({ dataDir: config.dataDir });
const checkRunner = createCheckRunner({
  checkStore,
  dispatcher: createCheckDispatcher({ runners: { http: runHttpCheck } }),
  eventLog: checkEventLog,
});
// Mail delivery is optional: with no relay configured the system still records
// and displays everything, it just cannot interrupt anyone.
const alertChannels = config.alertMail.host
  ? [createMailChannel({ mailer: createMailer(config.alertMail) })]
  : [];
const alertManager = createAlertManager({
  eventLogs: [checkEventLog, inboundEventLog], decisionLog, stateStore: alertState,
  channels: alertChannels, intervalMs: config.alertEvalMs,
  thresholds: { ...DEFAULT_THRESHOLDS, cooldownMs: config.alertCooldownHours * 3600000 },
});
checkRunner.start().catch(() => {});
alertManager.start().catch(() => {});
```

Add `checkStore, alertState, checkEventLog, decisionLog, alertManager, checkRunner` to the `buildServer({ ... })` argument object, and the matching imports at the top of the file.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/alertRoutes.test.js test/config.test.js`
Expected: PASS

- [ ] **Step 7: Run the whole suite to catch wiring regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/config.js src/server/server.js src/server/index.js .env.example test/alertRoutes.test.js
git commit -m "feat(alerts): config knobs, REST routes, and server wiring"
```

---
## Task 13: Pure web formatters and the fetch layer

**Files:**
- Create: `src/web/alertFormat.ts`, `src/web/alerts.ts`
- Test: `test/alertFormat.test.js`

**Interfaces:**
- Consumes: the JSON shapes returned by Task 12's routes.
- Produces:
  - `alertFormat.ts`: `severityRank(sev)`, `laneFor(alert)` returning `'critical'|'warning'|'info'`, `reasonLabel(reason)` returning operator-facing text, `occurrenceSummary(alert)`, `relativeAge(ms, nowMs)`.
  - `alerts.ts`: `listAlerts()`, `ackAlert(key)`, `muteAlert(key)`, `unmuteAlert(key)`, `listChecks()`, `createCheck(spec)`, `updateCheck(id, spec)`, `deleteCheck(id)`, `runCheck(id)`, `listFeed(since)`, `listDecisions(key)`.

- [ ] **Step 1: Write the failing test**

```js
// test/alertFormat.test.js
import { test, expect } from 'vitest';
import { severityRank, laneFor, reasonLabel, occurrenceSummary, relativeAge } from '../src/web/alertFormat.ts';

const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'warning', state: 'firing',
  count: 1, recentCount: 1, firstTs: 0, lastTs: 0, title: 't', body: '', reason: null, ...over,
});

test('severity ranks so critical sorts above warning above info', () => {
  expect(severityRank('critical')).toBeGreaterThan(severityRank('warning'));
  expect(severityRank('warning')).toBeGreaterThan(severityRank('info'));
});

test('an unknown severity ranks lowest rather than throwing', () => {
  expect(severityRank('made-up')).toBe(0);
});

test('a resolved alert lands in no lane so it leaves the open list', () => {
  expect(laneFor(alert({ state: 'resolved' }))).toBeNull();
});

test('a firing alert lands in the lane matching its severity', () => {
  expect(laneFor(alert({ severity: 'critical' }))).toBe('critical');
});

test('every reason code has operator-facing text, including the failure case', () => {
  for (const code of ['notified', 'held:below-persistence', 'suppressed:cooldown',
    'suppressed:muted', 'skipped:info', 'skipped:resolved', 'notify:failed']) {
    expect(reasonLabel(code)).toBeTruthy();
    expect(reasonLabel(code)).not.toBe(code);
  }
});

test('an unrecognised reason falls back to the raw code rather than blank', () => {
  expect(reasonLabel('something:new')).toBe('something:new');
});

test('a null reason reads as not yet evaluated', () => {
  expect(reasonLabel(null)).toBe('not yet evaluated');
});

test('the occurrence summary collapses repeats into one readable line', () => {
  const s = occurrenceSummary(alert({ count: 47, firstTs: 1000, lastTs: 9000 }));
  expect(s).toContain('47');
});

test('a single occurrence does not say "1 occurrences"', () => {
  expect(occurrenceSummary(alert({ count: 1 }))).toContain('once');
});

test('relative age renders seconds, minutes, hours, and days', () => {
  expect(relativeAge(0, 5000)).toBe('5s ago');
  expect(relativeAge(0, 120000)).toBe('2m ago');
  expect(relativeAge(0, 7200000)).toBe('2h ago');
  expect(relativeAge(0, 172800000)).toBe('2d ago');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertFormat.test.js`
Expected: FAIL — cannot resolve `../src/web/alertFormat.ts`

- [ ] **Step 3: Write the formatters**

```ts
// src/web/alertFormat.ts
export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  key: string; source: string; severity: Severity; state: 'firing' | 'resolved';
  count: number; recentCount: number; firstTs: number | null; lastTs: number | null;
  title: string; body: string; reason: string | null;
}

const RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

export function severityRank(sev: string): number {
  return RANK[sev] ?? 0;
}

export function laneFor(alert: Alert): Severity | null {
  return alert.state === 'resolved' ? null : alert.severity;
}

// The reason a thing did or did not reach you is the trust surface: rendered on
// every row so "working quietly" is never mistaken for "broken".
const REASONS: Record<string, string> = {
  notified: 'sent',
  'held:below-persistence': 'waiting — not yet persistent or repeated enough',
  'suppressed:cooldown': 'already sent recently',
  'suppressed:muted': 'muted by you',
  'skipped:info': 'info only — never notifies',
  'skipped:resolved': 'resolved',
  'notify:failed': 'delivery failed',
};

export function reasonLabel(reason: string | null): string {
  if (reason === null || reason === undefined) return 'not yet evaluated';
  return REASONS[reason] ?? reason;
}

export function occurrenceSummary(alert: Alert): string {
  return alert.count === 1 ? 'seen once' : `seen ${alert.count} times`;
}

export function relativeAge(ms: number, nowMs: number): string {
  const d = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
```

- [ ] **Step 4: Write the fetch layer**

```ts
// src/web/alerts.ts
import type { Alert } from './alertFormat';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
const send = (url: string, method: string, body?: unknown) =>
  json<{ ok?: boolean }>(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export interface CheckSummary {
  id: string; label: string; type: string; target: Record<string, unknown>;
  intervalSec: number; timeoutMs: number; severity: string;
  failuresBeforeNotify: number; enabled: boolean; hasSecret: boolean;
}
export interface CheckRunState {
  lastRunAt: number | null; nextRunAt: number; ok: boolean | null;
  consecutiveOk: number; consecutiveFail: number; detail: string; latencyMs: number | null;
}

export const listAlerts = () => json<{ alerts: Alert[] }>('/api/alerts').then((r) => r.alerts);
export const ackAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/ack`, 'POST');
export const muteAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/mute`, 'POST');
export const unmuteAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/mute`, 'DELETE');
export const listChecks = () =>
  json<{ checks: CheckSummary[]; state: Record<string, CheckRunState> }>('/api/checks');
export const createCheck = (spec: unknown) => send('/api/checks', 'POST', spec);
export const updateCheck = (id: string, spec: unknown) => send(`/api/checks/${encodeURIComponent(id)}`, 'PUT', spec);
export const deleteCheck = (id: string) => send(`/api/checks/${encodeURIComponent(id)}`, 'DELETE');
export const runCheck = (id: string) =>
  json<{ result: { ok: boolean; detail: string; latencyMs: number } }>(
    `/api/checks/${encodeURIComponent(id)}/run`, { method: 'POST' });
export const listFeed = (since = 0) =>
  json<{ events: Array<Record<string, unknown>> }>(`/api/alerts/feed?since=${since}`).then((r) => r.events);
export const listDecisions = (key: string) =>
  json<{ decisions: Array<Record<string, unknown>> }>(
    `/api/alerts/decisions?key=${encodeURIComponent(key)}`).then((r) => r.decisions);
```

- [ ] **Step 5: Run test and typecheck**

Run: `npx vitest run test/alertFormat.test.js && npm run typecheck`
Expected: PASS, 10 tests; typecheck clean

- [ ] **Step 6: Commit**

```bash
git add src/web/alertFormat.ts src/web/alerts.ts test/alertFormat.test.js
git commit -m "feat(ui): alert formatters and fetch layer"
```

---

## Task 14: The Alerts and Checks hub panel

**Files:**
- Create: `src/web/alertsUi.ts`, `src/web/checkForm.ts`
- Modify: `src/web/main.ts` (sidebar entry), `src/web/style.css`
- Test: `test/checkForm.test.js`

**Interfaces:**
- Consumes: `alerts.ts` and `alertFormat.ts` (Task 13), `openModal`/`makeRadio` from `dom.ts` (existing), `modalRegistry.ts` (existing).
- Produces: `openAlertsHub()` from `alertsUi.ts`; `checkFormPayload(formEl)` and `checkFieldsFor(type)` from `checkForm.ts`.

- [ ] **Step 1: Write the failing test**

```js
// test/checkForm.test.js
import { test, expect } from 'vitest';
import { checkFieldsFor, checkFormPayload } from '../src/web/checkForm.ts';

test('each type declares exactly the target fields it needs', () => {
  expect(checkFieldsFor('http').map((f) => f.name)).toEqual(['url']);
  expect(checkFieldsFor('tcp').map((f) => f.name)).toEqual(['host', 'port']);
  expect(checkFieldsFor('json').map((f) => f.name)).toEqual(['url', 'path']);
  expect(checkFieldsFor('exec').map((f) => f.name)).toEqual(['boxId', 'command']);
  expect(checkFieldsFor('heartbeat').map((f) => f.name)).toEqual(['windowSec', 'graceSec']);
});

test('an unknown type yields no fields rather than throwing', () => {
  expect(checkFieldsFor('nope')).toEqual([]);
});

test('the payload nests target fields and coerces numbers', () => {
  const values = {
    label: 'Invoice app', type: 'tcp', severity: 'critical', intervalSec: '30',
    timeoutMs: '5000', failuresBeforeNotify: '2', enabled: true,
    host: '192.168.1.10', port: '443', secret: '',
  };
  expect(checkFormPayload(values)).toEqual({
    label: 'Invoice app', type: 'tcp', severity: 'critical',
    intervalSec: 30, timeoutMs: 5000, failuresBeforeNotify: 2, enabled: true,
    target: { host: '192.168.1.10', port: 443 },
  });
});

test('a blank secret is omitted so an edit never clears the stored one', () => {
  const payload = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h', secret: '   ' });
  expect('secret' in payload).toBe(false);
});

test('a supplied secret is included', () => {
  const payload = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h', secret: 'tok' });
  expect(payload.secret).toBe('tok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/checkForm.test.js`
Expected: FAIL — cannot resolve `../src/web/checkForm.ts`

- [ ] **Step 3: Write the form helpers**

```ts
// src/web/checkForm.ts
export interface CheckField { name: string; label: string; placeholder?: string; numeric?: boolean }

// The field list per type lives here rather than in the DOM code so it can be
// unit-tested; the server remains the validation authority regardless.
const FIELDS: Record<string, CheckField[]> = {
  http: [{ name: 'url', label: 'URL', placeholder: 'https://invoices.example.com/health' }],
  tcp: [
    { name: 'host', label: 'Host', placeholder: '192.168.1.10' },
    { name: 'port', label: 'Port', placeholder: '443', numeric: true },
  ],
  json: [
    { name: 'url', label: 'URL', placeholder: 'https://node.example.com/api/sno' },
    { name: 'path', label: 'JSON path', placeholder: 'quicStatus' },
  ],
  exec: [
    { name: 'boxId', label: 'Box', placeholder: 'pick a box' },
    { name: 'command', label: 'Command', placeholder: 'systemctl is-active myservice' },
  ],
  heartbeat: [
    { name: 'windowSec', label: 'Expect a check-in every (seconds)', placeholder: '86400', numeric: true },
    { name: 'graceSec', label: 'Grace period (seconds)', placeholder: '3600', numeric: true },
  ],
};

export function checkFieldsFor(type: string): CheckField[] {
  return FIELDS[type] ?? [];
}

export function checkFormPayload(values: Record<string, unknown>): Record<string, unknown> {
  const type = String(values.type || '');
  const target: Record<string, unknown> = {};
  for (const f of checkFieldsFor(type)) {
    const raw = values[f.name];
    if (raw === undefined || raw === '') continue;
    target[f.name] = f.numeric ? Number(raw) : String(raw);
  }
  const payload: Record<string, unknown> = {
    label: String(values.label || '').trim(),
    type,
    target,
  };
  if (values.severity) payload.severity = String(values.severity);
  if (values.intervalSec !== undefined && values.intervalSec !== '') payload.intervalSec = Number(values.intervalSec);
  if (values.timeoutMs !== undefined && values.timeoutMs !== '') payload.timeoutMs = Number(values.timeoutMs);
  if (values.failuresBeforeNotify !== undefined && values.failuresBeforeNotify !== '') {
    payload.failuresBeforeNotify = Number(values.failuresBeforeNotify);
  }
  if (values.enabled !== undefined) payload.enabled = !!values.enabled;
  // A blank secret means "leave the stored one alone" — omitting the key is what
  // lets an edit form avoid round-tripping a credential through the browser.
  const secret = typeof values.secret === 'string' ? values.secret.trim() : '';
  if (secret) payload.secret = secret;
  return payload;
}
```

- [ ] **Step 4: Write the hub panel**

Create `src/web/alertsUi.ts` exporting `openAlertsHub()`. Follow `proxmoxUi.ts` for the shell: a body-mounted panel built with `openModal` from `dom.ts`, registered through `modalRegistry.ts` so logout teardown closes it, and a tab strip whose key order defines the tabs. Phase 1 renders two tabs:

- **Alerts** — `listAlerts()` grouped into lanes with `laneFor`, sorted by `severityRank` then `lastTs`. Each row shows `title`, `source`, `occurrenceSummary(alert)`, `relativeAge(alert.lastTs, Date.now())`, and `reasonLabel(alert.reason)`. Two buttons per row calling `ackAlert(key)` and `muteAlert(key)`, each followed by a re-render.
- **Checks** — `listChecks()` in a table with label, type, enabled state, and from `state[id]`: `ok`, `consecutiveFail`, `detail`, `latencyMs`, and `relativeAge(lastRunAt, Date.now())`. Buttons: Run now (`runCheck`), Edit, Delete (`deleteCheck`, confirm-gated through `openModal`), plus a New check button. The create/edit form renders `checkFieldsFor(type)` reactively when the type radio changes and submits `checkFormPayload(values)` through `createCheck`/`updateCheck`.

Add a sidebar button in `src/web/main.ts` beside the existing Proxmox hub button that calls `openAlertsHub()`, and style the lanes in `style.css` reusing the existing severity colours from the status dot rules.

- [ ] **Step 5: Run tests, typecheck, and build**

Run: `npx vitest run test/checkForm.test.js && npm run typecheck && npm run build`
Expected: PASS, 5 tests; typecheck clean; build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/web/alertsUi.ts src/web/checkForm.ts src/web/main.ts src/web/style.css test/checkForm.test.js
git commit -m "feat(ui): alerts and checks hub panel"
```

---
# Slice B — The remaining probe types

Each type is an increment against a pipeline already proven end to end by Slice A.

## Task 15: TCP check executor

**Files:**
- Create: `src/server/checks/tcpCheck.js`
- Test: `test/tcpCheck.integration.test.js`
- Modify: `src/server/index.js` (add `tcp: runTcpCheck` to the dispatcher `runners`)

**Interfaces:**
- Produces: `runTcpCheck(check, { now })` returning `{ ok, detail, latencyMs }`.

- [ ] **Step 1: Write the failing test**

```js
// test/tcpCheck.integration.test.js
import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import { runTcpCheck } from '../src/server/checks/tcpCheck.js';

let server = null;
afterEach(async () => { if (server) { await new Promise((r) => server.close(r)); server = null; } });

const check = (host, port, over = {}) => ({ type: 'tcp', target: { host, port }, timeoutMs: 1500, ...over });

test('a listening port passes', async () => {
  server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await runTcpCheck(check('127.0.0.1', server.address().port));
  expect(got.ok).toBe(true);
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a closed port fails with a readable detail', async () => {
  const got = await runTcpCheck(check('127.0.0.1', 1));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});

test('an unroutable address fails on the timeout rather than hanging', async () => {
  const got = await runTcpCheck(check('192.0.2.1', 9, { timeoutMs: 800 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/timed out|EHOSTUNREACH|ENETUNREACH|ECONN/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tcpCheck.integration.test.js`
Expected: FAIL — cannot resolve `../src/server/checks/tcpCheck.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checks/tcpCheck.js
import net from 'node:net';

// Reachability only: a completed TCP handshake is the whole assertion. The
// socket is destroyed immediately so a probe never holds a connection open on
// the target.
export function runTcpCheck(check, { now = () => Date.now() } = {}) {
  const started = now();
  const timeoutMs = check.timeoutMs || 10000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ ok, detail, latencyMs: now() - started });
    };
    const sock = net.connect({ host: check.target.host, port: check.target.port });
    sock.setTimeout(timeoutMs, () => done(false, `timed out after ${timeoutMs}ms`));
    sock.once('connect', () => done(true, `connected to ${check.target.host}:${check.target.port}`));
    sock.once('error', (e) => done(false, e?.message || 'connection failed'));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tcpCheck.integration.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Register it and commit**

Add `import { runTcpCheck } from './checks/tcpCheck.js';` and `tcp: runTcpCheck` to the dispatcher in `src/server/index.js`.

```bash
git add src/server/checks/tcpCheck.js src/server/index.js test/tcpCheck.integration.test.js
git commit -m "feat(alerts): tcp reachability check executor"
```

---

## Task 16: JSON field assertion check

**Files:**
- Create: `src/server/checks/jsonCheck.js`
- Test: `test/jsonCheck.integration.test.js`
- Modify: `src/server/index.js` (add `json: runJsonCheck`)

**Interfaces:**
- Produces: `pickPath(obj, path)` (exported for its own tests) and `runJsonCheck(check, { now, fetchImpl })`. `check.target.path` is a dotted path; `check.assert` supports `{ equals, notEquals, lessThan, greaterThan }`.

- [ ] **Step 1: Write the failing test**

```js
// test/jsonCheck.integration.test.js
import { test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runJsonCheck, pickPath } from '../src/server/checks/jsonCheck.js';

const servers = [];
afterEach(async () => { while (servers.length) await new Promise((r) => servers.pop().close(r)); });

async function serveJson(payload) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/api`;
}
const check = (url, path, assert) => ({ type: 'json', target: { url, path }, assert, timeoutMs: 2000 });

test('pickPath walks dotted paths and reports missing ones as undefined', () => {
  expect(pickPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  expect(pickPath({ a: {} }, 'a.b.c')).toBeUndefined();
  expect(pickPath(null, 'a')).toBeUndefined();
});

test('greaterThan passes when the field clears the floor', async () => {
  const url = await serveJson({ onlineScore: 0.99 });
  expect((await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0.95 }))).ok).toBe(true);
});

test('greaterThan fails when the field drops below and the detail shows the value', async () => {
  const url = await serveJson({ onlineScore: 0.80 });
  const got = await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0.95 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('0.8');
});

test('equals compares as a string so "OK" and OK behave the same', async () => {
  const url = await serveJson({ quic: { status: 'OK' } });
  expect((await runJsonCheck(check(url, 'quic.status', { equals: 'OK' }))).ok).toBe(true);
  expect((await runJsonCheck(check(url, 'quic.status', { equals: 'BROKEN' }))).ok).toBe(false);
});

test('a missing field fails rather than passing vacuously', async () => {
  const url = await serveJson({ other: 1 });
  const got = await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/missing|not found/i);
});

test('a non-JSON response fails with a readable detail', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('<html>nope'); });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await runJsonCheck(check(`http://127.0.0.1:${server.address().port}/api`, 'a', { equals: 'b' }));
  expect(got.ok).toBe(false);
});

test('no assertion means the fetch itself is the check', async () => {
  const url = await serveJson({ anything: true });
  expect((await runJsonCheck(check(url, 'anything', {}))).ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jsonCheck.integration.test.js`
Expected: FAIL — cannot resolve `../src/server/checks/jsonCheck.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checks/jsonCheck.js
// Assert on one field of a JSON API response. Covers the node-dashboard cases
// (online score, QUIC status, free disk) and token-validity probes, where the
// interesting signal is a field value rather than an HTTP status.
export function pickPath(obj, path) {
  return String(path).split('.').reduce((acc, part) => (
    acc !== null && acc !== undefined && typeof acc === 'object' ? acc[part] : undefined
  ), obj);
}

function evaluate(value, assert) {
  if (value === undefined) return { ok: false, detail: `field missing from response` };
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (assert.equals !== undefined && String(value) !== String(assert.equals)) {
    return { ok: false, detail: `expected ${assert.equals}, got ${shown}` };
  }
  if (assert.notEquals !== undefined && String(value) === String(assert.notEquals)) {
    return { ok: false, detail: `expected anything but ${assert.notEquals}, got ${shown}` };
  }
  if (assert.greaterThan !== undefined && !(Number(value) > Number(assert.greaterThan))) {
    return { ok: false, detail: `expected > ${assert.greaterThan}, got ${shown}` };
  }
  if (assert.lessThan !== undefined && !(Number(value) < Number(assert.lessThan))) {
    return { ok: false, detail: `expected < ${assert.lessThan}, got ${shown}` };
  }
  return { ok: true, detail: shown };
}

export async function runJsonCheck(check, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs || 10000);
  try {
    const res = await fetchImpl(check.target.url, {
      signal: controller.signal,
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    const payload = await res.json();
    const { ok, detail } = evaluate(pickPath(payload, check.target.path), check.assert || {});
    return { ok, detail: `${check.target.path}: ${detail}`, latencyMs: now() - started };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      detail: aborted ? `timed out after ${check.timeoutMs || 10000}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jsonCheck.integration.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Register it and commit**

Add `import { runJsonCheck } from './checks/jsonCheck.js';` and `json: runJsonCheck` to the dispatcher in `src/server/index.js`.

```bash
git add src/server/checks/jsonCheck.js src/server/index.js test/jsonCheck.integration.test.js
git commit -m "feat(alerts): json field assertion check executor"
```

---

## Task 17: On-box command check

**Files:**
- Create: `src/server/checks/execCheck.js`
- Test: `test/execCheck.test.js`
- Modify: `src/server/index.js` (add `exec: runExecCheck` and pass `deps` into `createCheckRunner`)

**Interfaces:**
- Consumes: `boxActions.execCommand(box, command, { timeoutMs })` returning `{ code, stdout, stderr }`, and `store.listBoxes()` (both existing).
- Produces: `runExecCheck(check, { boxActions, store, now })`.

- [ ] **Step 1: Write the failing test**

```js
// test/execCheck.test.js
import { test, expect } from 'vitest';
import { runExecCheck } from '../src/server/checks/execCheck.js';

const deps = (result, boxes = [{ id: 'b1', host: '192.168.1.10' }]) => ({
  store: { listBoxes: async () => boxes },
  boxActions: { execCommand: async () => result },
  now: () => 0,
});
const check = (over = {}) => ({
  type: 'exec', target: { boxId: 'b1', command: 'systemctl is-active myservice' },
  assert: {}, timeoutMs: 5000, ...over,
});

test('exit code zero passes', async () => {
  expect((await runExecCheck(check(), deps({ code: 0, stdout: 'active\n', stderr: '' }))).ok).toBe(true);
});

test('a non-zero exit fails and the detail carries the code and stderr', async () => {
  const got = await runExecCheck(check(), deps({ code: 3, stdout: '', stderr: 'inactive' }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('3');
  expect(got.detail).toContain('inactive');
});

test('stdoutIncludes fails when the marker is absent even on exit zero', async () => {
  const got = await runExecCheck(
    check({ assert: { stdoutIncludes: 'active' } }),
    deps({ code: 0, stdout: 'failed\n', stderr: '' }),
  );
  expect(got.ok).toBe(false);
});

test('stdoutIncludes passes when the marker is present', async () => {
  const got = await runExecCheck(
    check({ assert: { stdoutIncludes: 'active' } }),
    deps({ code: 0, stdout: 'active\n', stderr: '' }),
  );
  expect(got.ok).toBe(true);
});

test('a box that no longer exists fails the check instead of throwing', async () => {
  const got = await runExecCheck(check(), deps({ code: 0, stdout: '', stderr: '' }, []));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/box/i);
});

test('an ssh-level failure is a check failure, not an exception', async () => {
  const got = await runExecCheck(check(), {
    store: { listBoxes: async () => [{ id: 'b1' }] },
    boxActions: { execCommand: async () => { throw new Error('ssh: connect timed out'); } },
    now: () => 0,
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('ssh');
});

test('detail is truncated so one runaway command cannot bloat the event log', async () => {
  const got = await runExecCheck(check(), deps({ code: 1, stdout: 'x'.repeat(5000), stderr: '' }));
  expect(got.detail.length).toBeLessThanOrEqual(320);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/execCheck.test.js`
Expected: FAIL — cannot resolve `../src/server/checks/execCheck.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checks/execCheck.js
// Runs a command on a box over the ControlMaster Tmuxifier already holds open.
// This is why most node-workload coverage costs nothing new: no agent to
// install, no API to expose, no credentials to store. The command text is
// operator-authored and travels the same validated argv path as every probe.
const MAX_DETAIL = 300;

const trim = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, MAX_DETAIL);

export async function runExecCheck(check, { boxActions, store, now = () => Date.now() }) {
  const started = now();
  const fail = (detail) => ({ ok: false, detail, latencyMs: now() - started });
  const box = (await store.listBoxes()).find((b) => b.id === check.target.boxId);
  if (!box) return fail(`box ${check.target.boxId} no longer exists`);
  let res;
  try {
    res = await boxActions.execCommand(box, check.target.command, { timeoutMs: check.timeoutMs || 15000 });
  } catch (e) {
    return fail(trim(e?.message || 'command failed to run'));
  }
  if (res.code !== 0) return fail(`exit ${res.code}: ${trim(res.stderr || res.stdout) || 'no output'}`);
  const marker = check.assert?.stdoutIncludes;
  if (marker && !String(res.stdout || '').includes(marker)) {
    return fail(`stdout did not contain "${marker}": ${trim(res.stdout) || 'no output'}`);
  }
  return { ok: true, detail: trim(res.stdout) || 'exit 0', latencyMs: now() - started };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/execCheck.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Register it and commit**

In `src/server/index.js` add `exec: runExecCheck` to the dispatcher and pass the executor dependencies through the runner:

```js
const checkRunner = createCheckRunner({
  checkStore,
  dispatcher: createCheckDispatcher({
    runners: { http: runHttpCheck, tcp: runTcpCheck, json: runJsonCheck, exec: runExecCheck },
  }),
  eventLog: checkEventLog,
  deps: { boxActions, store },
});
```

```bash
git add src/server/checks/execCheck.js src/server/index.js test/execCheck.test.js
git commit -m "feat(alerts): on-box command check over the shared ControlMaster"
```

---
# Slice C — Heartbeats and the ingest daemon

## Task 18: The ingest daemon

**Files:**
- Create: `src/server/ingest/heartbeatServer.js`, `src/server/ingest/index.js`, `deploy/tmuxifier-ingest.service`
- Test: `test/heartbeatServer.integration.test.js`
- Modify: `package.json` (add `"start:ingest": "node src/server/ingest/index.js"`)

**Interfaces:**
- Consumes: `createEventLog` (Task 1), `readJson` (existing).
- Produces: `createHeartbeatServer({ checkinLog, isKnownToken, heartbeatFile, now })` returning `{ listen(port, host), close(), handle(req, res) }`.

**Critical detail — which log check-ins go to.** Check-ins are appended to `checkins-*.ndjson`, **not** `inbound-*.ndjson`. `foldEvents` treats any event that is not `state: 'resolved'` as a firing occurrence, so a check-in written into a log the alert manager reads would become an alert saying the backup succeeded. The check-in log is read only by the heartbeat executor in Task 19. `inbound-*.ndjson` stays reserved for phase 2's mail and webhooks, which really are occurrences.

- [ ] **Step 1: Write the failing test**

```js
// test/heartbeatServer.integration.test.js
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createHeartbeatServer } from '../src/server/ingest/heartbeatServer.js';

let running = null;
afterEach(async () => { if (running) { await running.server.close(); running = null; } });

async function start({ known = ['tok-abc'] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-'));
  const checkinLog = createEventLog({ dir, prefix: 'checkins', now: () => 1000 });
  const heartbeatFile = path.join(dir, 'ingest-heartbeat.json');
  const server = createHeartbeatServer({
    checkinLog, heartbeatFile, now: () => 1000,
    isKnownToken: async (t) => known.includes(t),
  });
  const port = await server.listen(0, '127.0.0.1');
  running = { server, checkinLog, dir, heartbeatFile, port };
  return running;
}

test('a check-in on a known token is recorded and answered 204', async () => {
  const { port, checkinLog } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST' });
  expect(res.status).toBe(204);
  const events = await checkinLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ via: 'heartbeat', key: 'check:tok-abc', state: 'checkin' });
});

test('GET works too, because most cron jobs reach for curl without -X', async () => {
  const { port, checkinLog } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/hb/tok-abc`)).status).toBe(204);
  expect(await checkinLog.readSince(0)).toHaveLength(1);
});

test('an unknown token is refused and recorded nowhere', async () => {
  const { port, checkinLog } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/hb/nope`, { method: 'POST' })).status).toBe(404);
  expect(await checkinLog.readSince(0)).toEqual([]);
});

test('any other path is refused', async () => {
  const { port } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/api/boxes`)).status).toBe(404);
});

test('a liveness stamp is written so the dashboard can tell dead from quiet', async () => {
  const { port, heartbeatFile } = await start();
  await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST' });
  expect(JSON.parse(await fs.readFile(heartbeatFile, 'utf8')).at).toBe(1000);
});

test('an oversized request body is rejected rather than buffered', async () => {
  const { port } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST', body: 'x'.repeat(200000) });
  expect(res.status).toBe(413);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/heartbeatServer.integration.test.js`
Expected: FAIL — cannot resolve `../src/server/ingest/heartbeatServer.js`

- [ ] **Step 3: Write the server**

```js
// src/server/ingest/heartbeatServer.js
import http from 'node:http';
import { writeJson } from '../jsonFile.js';

// The only inbound surface in phase 1, and deliberately the smallest thing that
// can work: bare node:http, no framework, no cookies, no sessions, no
// credentials of any kind. The token in the URL is the whole authentication —
// it identifies one check and grants nothing else.
const MAX_BODY = 64 * 1024;

export function createHeartbeatServer({ checkinLog, isKnownToken, heartbeatFile, now = () => Date.now() }) {
  async function stampAlive() {
    // Absence of this stamp is how the dashboard distinguishes "nothing is
    // wrong" from "the receiver is dead" — the most dangerous failure here,
    // because nothing else looks broken.
    try { await writeJson(heartbeatFile, { at: now() }, { mode: 0o600 }); } catch { /* best effort */ }
  }

  async function handle(req, res) {
    const m = /^\/hb\/([A-Za-z0-9._-]{1,128})$/.exec((req.url || '').split('?')[0]);
    if (!m || (req.method !== 'POST' && req.method !== 'GET')) {
      res.writeHead(404); res.end(); return;
    }
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY && !tooBig) { tooBig = true; res.writeHead(413); res.end(); req.destroy(); }
    });
    await new Promise((r) => req.on('end', r).on('close', r));
    if (tooBig) return;
    const token = m[1];
    if (!await isKnownToken(token)) { res.writeHead(404); res.end(); return; }
    await checkinLog.append({
      via: 'heartbeat', source: `check:${token}`, key: `check:${token}`, norm: null,
      severity: 'info', state: 'checkin', title: 'check-in', body: '',
    });
    await stampAlive();
    res.writeHead(204); res.end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* socket gone */ } });
  });

  return {
    handle,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}
```

- [ ] **Step 4: Write the daemon entrypoint**

```js
// src/server/ingest/index.js
import path from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../jsonFile.js';
import { createEventLog } from '../eventLog.js';
import { createHeartbeatServer } from './heartbeatServer.js';

// Separate process on purpose: this one accepts input from the network and
// holds nothing — no SSH keys, no cookie secret, no box store, no API tokens.
// It reads data/checks.json to learn valid tokens and never writes it.
const config = loadConfig();
const eventsDir = path.join(config.dataDir, 'events');
const checksFile = path.join(config.dataDir, 'checks.json');

const server = createHeartbeatServer({
  checkinLog: createEventLog({ dir: eventsDir, prefix: 'checkins' }),
  heartbeatFile: path.join(config.dataDir, 'ingest-heartbeat.json'),
  isKnownToken: async (token) => {
    const data = await readJson(checksFile, { fallback: { checks: [] } });
    return (data.checks || []).some((c) => c.id === token && c.type === 'heartbeat' && c.enabled);
  },
});

const port = await server.listen(config.ingestPort, config.ingestBind);
console.log(`[tmuxifier-ingest] heartbeat endpoint listening on ${config.ingestBind}:${port}`);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close().finally(() => process.exit(0)); });
}
```

Add the two config knobs alongside the alert knobs from Task 12 — `ingestBind: '127.0.0.1'` and `ingestPort: 8788` in `DEFAULTS`, `e.TMUXIFIER_INGEST_BIND` / `e.TMUXIFIER_INGEST_PORT` in the env map, and a port clamp in the merge block — plus the matching commented entries in `.env.example`.

- [ ] **Step 5: Write the systemd unit**

```ini
# deploy/tmuxifier-ingest.service
#
# The alert ingest daemon. Runs as a separate unit from tmuxifier.service on
# purpose: it is the only process that accepts input from the network, and it
# holds no SSH keys, no cookie secret, and no API tokens. Install:
#   sudo cp deploy/tmuxifier-ingest.service /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now tmuxifier-ingest
[Unit]
Description=Tmuxifier alert ingest (heartbeat receiver)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/tmuxifier
Environment=HOME=/root
ExecStart=/usr/bin/node /root/tmuxifier/src/server/ingest/index.js
# Always, not on-failure: a receiver that stays down looks identical to a quiet
# network, which is the failure mode this whole system exists to prevent.
Restart=always
RestartSec=2
NoNewPrivileges=true
# Needed only if you later bind port 25 for the phase 2 SMTP sink.
#AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/heartbeatServer.integration.test.js && npm test`
Expected: PASS

```bash
git add src/server/ingest/ deploy/tmuxifier-ingest.service package.json src/server/config.js .env.example test/heartbeatServer.integration.test.js
git commit -m "feat(alerts): credential-free heartbeat ingest daemon"
```

---

## Task 19: The heartbeat check type

**Files:**
- Create: `src/server/checks/heartbeatCheck.js`
- Test: `test/heartbeatCheck.test.js`
- Modify: `src/server/index.js` (register `heartbeat: runHeartbeatCheck`, pass `checkinLog` into runner deps)

**Interfaces:**
- Consumes: the check-in log written by Task 18.
- Produces: `runHeartbeatCheck(check, { checkinLog, now })`. Fails when no check-in has arrived within `windowSec + graceSec`.

- [ ] **Step 1: Write the failing test**

```js
// test/heartbeatCheck.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { runHeartbeatCheck } from '../src/server/checks/heartbeatCheck.js';

const HOUR = 3600000;
const mk = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hbcheck-'));
  let t = Date.parse('2026-07-25T12:00:00Z');
  return { dir, clock: { get: () => t, set: (v) => { t = v; } } };
};
const check = (over = {}) => ({
  id: 'c1', type: 'heartbeat', target: { windowSec: 3600, graceSec: 300 }, ...over,
});

test('a recent check-in passes', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append({ via: 'heartbeat', source: 'check:c1', key: 'check:c1', state: 'checkin', severity: 'info', title: 'check-in', body: '' });
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(true);
});

test('a check-in inside the grace period still passes', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append({ via: 'heartbeat', source: 'check:c1', key: 'check:c1', state: 'checkin', severity: 'info', title: 'check-in', body: '' });
  clock.set(clock.get() + HOUR + 200000); // window elapsed, still inside the 300s grace
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(true);
});

test('no check-in past window plus grace fails, and the detail says how long it has been', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append({ via: 'heartbeat', source: 'check:c1', key: 'check:c1', state: 'checkin', severity: 'info', title: 'check-in', body: '' });
  clock.set(clock.get() + 3 * HOUR);
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/no check-in/i);
});

test('a heartbeat that has never checked in fails rather than passing vacuously', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/never/i);
});

test('another check-in key does not satisfy this check', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append({ via: 'heartbeat', source: 'check:other', key: 'check:other', state: 'checkin', severity: 'info', title: 'check-in', body: '' });
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/heartbeatCheck.test.js`
Expected: FAIL — cannot resolve `../src/server/checks/heartbeatCheck.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/checks/heartbeatCheck.js
// The only check that fires because nothing happened. Everything else in this
// system reacts to a signal; this one reacts to its absence, which is the only
// construction that can catch a backup that never ran.
export async function runHeartbeatCheck(check, { checkinLog, now = () => Date.now() }) {
  const started = now();
  const windowMs = (check.target.windowSec + (check.target.graceSec || 0)) * 1000;
  // Look back twice the window so a long-silent heartbeat still finds its last
  // check-in and can report how long it has been, rather than just "never".
  const events = await checkinLog.readSince(now() - Math.max(windowMs * 2, 86400000), now());
  const mine = events.filter((e) => e.key === `check:${check.id}`);
  const last = mine.length ? mine[mine.length - 1] : null;
  if (!last) {
    return { ok: false, detail: 'never checked in', latencyMs: now() - started };
  }
  const age = now() - last.ts;
  if (age > windowMs) {
    const mins = Math.floor(age / 60000);
    return { ok: false, detail: `no check-in for ${mins}m (expected every ${Math.floor(windowMs / 60000)}m)`, latencyMs: now() - started };
  }
  return { ok: true, detail: `checked in ${Math.floor(age / 1000)}s ago`, latencyMs: now() - started };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/heartbeatCheck.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Register it and commit**

In `src/server/index.js`, add `const checkinLog = createEventLog({ dir: eventsDir, prefix: 'checkins' });`, register `heartbeat: runHeartbeatCheck` in the dispatcher, and add `checkinLog` to the runner's `deps`.

```bash
git add src/server/checks/heartbeatCheck.js src/server/index.js test/heartbeatCheck.test.js
git commit -m "feat(alerts): heartbeat absence detection"
```

---
# Slice D — Completing the surface

## Task 20: Daily digest and retention pruning

**Files:**
- Create: `src/server/alertDigest.js`
- Test: `test/alertDigest.test.js`
- Modify: `src/server/index.js` (start the digest scheduler)

**Interfaces:**
- Consumes: `formatDigest` (Task 11), `createAlertManager.listAlerts` (Task 9), the event logs (Task 1).
- Produces: `createDigestScheduler({ alertManager, decisionLog, eventLogs, mailer, now, retentionDays, digestHourUtc, setIntervalFn, clearIntervalFn })` returning `{ tick(), start(), stop() }`. `tick()` sends at most one digest per UTC day and prunes on the same pass.

- [ ] **Step 1: Write the failing test**

```js
// test/alertDigest.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createDigestScheduler } from '../src/server/alertDigest.js';

const at = (iso) => Date.parse(iso);
const mk = async ({ alerts = [] } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  let t = at('2026-07-25T09:00:00Z');
  const sent = [];
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  const sched = createDigestScheduler({
    alertManager: { listAlerts: async () => alerts },
    eventLogs: [log], decisionLog: createEventLog({ dir, prefix: 'decisions', now: () => t }),
    mailer: { send: async (m) => { sent.push(m); return { ok: true, error: null }; } },
    now: () => t, retentionDays: 90, digestHourUtc: 8,
  });
  return { sched, sent, clock: { get: () => t, set: (v) => { t = v; } }, log, dir };
};
const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'info', state: 'firing',
  count: 2, recentCount: 2, firstTs: 0, lastTs: 0, title: 'Backup ran long', body: '',
  reason: 'skipped:info', ...over,
});

test('the digest sends once after the configured hour', async () => {
  const { sched, sent } = await mk({ alerts: [alert()] });
  await sched.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].subject).toContain('2026-07-25');
});

test('a second tick the same day sends nothing more', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  await sched.tick();
  clock.set(at('2026-07-25T18:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(1);
});

test('the next day sends again', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  await sched.tick();
  clock.set(at('2026-07-26T09:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(2);
});

test('before the configured hour nothing is sent', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  clock.set(at('2026-07-25T07:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(0);
});

test('notified alerts are excluded — the digest is what stayed below the line', async () => {
  const { sched, sent } = await mk({ alerts: [alert({ reason: 'notified', title: 'Already paged you' })] });
  await sched.tick();
  expect(sent[0].text).not.toContain('Already paged you');
});

test('the digest carries the loop-guard header like every other outbound message', async () => {
  const { sched, sent } = await mk({ alerts: [alert()] });
  await sched.tick();
  expect(sent[0].headers['X-Tmuxifier-Alert']).toBe('1');
});

test('the same pass prunes day files past the retention window', async () => {
  const { sched, log, clock, dir } = await mk();
  clock.set(at('2026-01-01T00:00:00Z'));
  await log.append({ key: 'old', ts: at('2026-01-01T00:00:00Z') });
  clock.set(at('2026-07-25T09:00:00Z'));
  await sched.tick();
  const names = await fs.readdir(dir);
  expect(names).not.toContain('checks-2026-01-01.ndjson');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/alertDigest.test.js`
Expected: FAIL — cannot resolve `../src/server/alertDigest.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/alertDigest.js
import { formatDigest, LOOP_GUARD_HEADER } from './alertMail.js';

// One plain list a day of everything that stayed below the notification line.
// This is what makes adding a source safe: a new check can be confirmed working
// without ever having interrupted anyone. Retention pruning rides the same pass
// so there is no separate cleanup job and no cron.
export function createDigestScheduler({
  alertManager, eventLogs = [], decisionLog = null, mailer,
  now = () => Date.now(), retentionDays = 90, digestHourUtc = 8,
  intervalMs = 900000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let lastSentDay = null;
  let timer = null;

  async function tick() {
    const d = new Date(now());
    const dayKey = d.toISOString().slice(0, 10);
    if (d.getUTCHours() < digestHourUtc || lastSentDay === dayKey) return null;
    lastSentDay = dayKey;

    const alerts = (await alertManager.listAlerts()).filter((a) => a.reason !== 'notified');
    const { subject, text } = formatDigest(alerts, { dayKey });
    const res = mailer ? await mailer.send({ subject, text, headers: { [LOOP_GUARD_HEADER]: '1' } })
      : { ok: false, error: 'no mailer configured' };

    for (const log of [...eventLogs, decisionLog].filter(Boolean)) {
      await log.prune(retentionDays).catch(() => []);
    }
    return res;
  }

  return {
    tick,
    async start() {
      await tick().catch(() => null);
      timer = setIntervalFn(() => { tick().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/alertDigest.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Wire it and commit**

In `src/server/index.js`, after `alertManager`:

```js
const digest = createDigestScheduler({
  alertManager, eventLogs: [checkEventLog, checkinLog, inboundEventLog], decisionLog,
  mailer: config.alertMail.host ? createMailer(config.alertMail) : null,
  retentionDays: config.alertRetentionDays,
});
digest.start().catch(() => {});
```

```bash
git add src/server/alertDigest.js src/server/index.js test/alertDigest.test.js
git commit -m "feat(alerts): daily below-the-line digest with retention pruning"
```

---

## Task 21: Feed and Sources tabs, plus the ingest liveness banner

**Files:**
- Create: `src/server/ingestLiveness.js`
- Modify: `src/web/alertsUi.ts` (two more tabs), `src/server/server.js` (one route), `src/web/alerts.ts` (one fetch), `src/web/alertFormat.ts` (`sourceRows`)
- Test: `test/ingestLiveness.test.js`, `test/alertFormat.test.js` (extend)

**Interfaces:**
- Produces: `createIngestLiveness({ heartbeatFile, now, staleMs })` returning `{ status() }` → `{ alive: boolean, lastSeenAt: number|null, staleFor: number|null }`; route `GET /api/alerts/ingest-status`; and `sourceRows(events)` in `alertFormat.ts` returning `[{ source, count, lastTs }]` sorted by volume.

- [ ] **Step 1: Write the failing tests**

```js
// test/ingestLiveness.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIngestLiveness } from '../src/server/ingestLiveness.js';

const mk = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
  return { file: path.join(dir, 'ingest-heartbeat.json') };
};

test('a fresh stamp reads as alive', async () => {
  const { file } = await mk();
  await fs.writeFile(file, JSON.stringify({ at: 1000 }));
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 2000, staleMs: 60000 }).status();
  expect(got).toEqual({ alive: true, lastSeenAt: 1000, staleFor: null });
});

test('a stale stamp reads as dead and reports how long', async () => {
  const { file } = await mk();
  await fs.writeFile(file, JSON.stringify({ at: 1000 }));
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 100000, staleMs: 60000 }).status();
  expect(got.alive).toBe(false);
  expect(got.staleFor).toBe(99000);
});

test('a missing stamp reads as dead rather than silently alive', async () => {
  const { file } = await mk();
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 5000, staleMs: 60000 }).status();
  expect(got).toEqual({ alive: false, lastSeenAt: null, staleFor: null });
});
```

Append to `test/alertFormat.test.js`:

```js
test('sourceRows aggregates volume per source, busiest first', async () => {
  const { sourceRows } = await import('../src/web/alertFormat.ts');
  const rows = sourceRows([
    { source: 'check:a', ts: 10 }, { source: 'check:b', ts: 20 }, { source: 'check:a', ts: 30 },
  ]);
  expect(rows).toEqual([
    { source: 'check:a', count: 2, lastTs: 30 },
    { source: 'check:b', count: 1, lastTs: 20 },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ingestLiveness.test.js test/alertFormat.test.js`
Expected: FAIL — cannot resolve `../src/server/ingestLiveness.js`; `sourceRows` is not exported

- [ ] **Step 3: Write the liveness reader**

```js
// src/server/ingestLiveness.js
import { readJson } from './jsonFile.js';

// A dead receiver and a quiet network look identical from the dashboard, and
// that ambiguity is the single most dangerous failure in this system. The
// daemon stamps a file; absence or staleness of that stamp is what the UI turns
// into a banner. Missing reads as dead, never as fine.
export function createIngestLiveness({ heartbeatFile, now = () => Date.now(), staleMs = 300000 }) {
  return {
    async status() {
      const data = await readJson(heartbeatFile, { fallback: null }).catch(() => null);
      const at = data && typeof data.at === 'number' ? data.at : null;
      if (at === null) return { alive: false, lastSeenAt: null, staleFor: null };
      const age = now() - at;
      return age > staleMs
        ? { alive: false, lastSeenAt: at, staleFor: age }
        : { alive: true, lastSeenAt: at, staleFor: null };
    },
  };
}
```

- [ ] **Step 4: Add `sourceRows` to `src/web/alertFormat.ts`**

```ts
export interface SourceRow { source: string; count: number; lastTs: number }

export function sourceRows(events: Array<{ source: string; ts: number }>): SourceRow[] {
  const by = new Map<string, SourceRow>();
  for (const e of events) {
    const row = by.get(e.source) || { source: e.source, count: 0, lastTs: 0 };
    row.count += 1;
    row.lastTs = Math.max(row.lastTs, e.ts);
    by.set(e.source, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}
```

- [ ] **Step 5: Add the route and the tabs**

In `src/server/server.js`, inside the alert route block:

```js
    app.get('/api/alerts/ingest-status', { preHandler: requireAuth }, async () => (
      ingestLiveness ? ingestLiveness.status() : { alive: null, lastSeenAt: null, staleFor: null }
    ));
```

Add `ingestLiveness` to the `buildServer` destructuring, construct it in `index.js` with `heartbeatFile: path.join(config.dataDir, 'ingest-heartbeat.json')`, and pass it through.

In `src/web/alerts.ts` add:

```ts
export const ingestStatus = () =>
  json<{ alive: boolean | null; lastSeenAt: number | null; staleFor: number | null }>('/api/alerts/ingest-status');
```

In `src/web/alertsUi.ts` add two tabs and the banner:

- **Feed** — `listFeed()` rendered newest-first: time, source, severity, title. A text input filters client-side on title and source. This is where a newly added check appears so it can be confirmed working without notifying anyone.
- **Sources** — `sourceRows(await listFeed())` in a table with source, volume, and last-seen, each row carrying a mute toggle (`muteAlert`/`unmuteAlert` on the source string, which `decideAlert` already honours as a source-level mute) and a threshold override input posting through `updateCheck`.
- **Banner** — on hub open, call `ingestStatus()`; when `alive === false`, render a prominent warning strip above the tab strip reading "Alert ingest is not running — heartbeat checks cannot detect check-ins", with the `staleFor` age rendered by `relativeAge`.

- [ ] **Step 6: Run tests, typecheck, build, commit**

Run: `npx vitest run test/ingestLiveness.test.js test/alertFormat.test.js && npm run typecheck && npm run build`
Expected: PASS, 3 + 11 tests; typecheck clean; build succeeds

```bash
git add src/server/ingestLiveness.js src/server/server.js src/server/index.js src/web/alertsUi.ts src/web/alerts.ts src/web/alertFormat.ts test/ingestLiveness.test.js test/alertFormat.test.js
git commit -m "feat(ui): feed and sources tabs plus ingest liveness banner"
```

---

## Task 22: End-to-end coverage and documentation

**Files:**
- Create: `test/e2e/alerts.spec.js`
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/DEPLOY.md`

**Interfaces:**
- Consumes: everything.
- Produces: no new code interfaces — this task proves the assembled system and records it.

- [ ] **Step 1: Write the e2e spec**

```js
// test/e2e/alerts.spec.js
import { test, expect } from '@playwright/test';

// Follow the existing login helper used by the other specs in this directory.
test('a failing check surfaces as an alert, and mute silences it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env.TMUXIFIER_E2E_PASSWORD || 'test-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.getByRole('button', { name: /alerts/i }).click();
  await page.getByRole('tab', { name: /checks/i }).click();
  await page.getByRole('button', { name: /new check/i }).click();
  await page.getByLabel('Label').fill('Unreachable surface');
  await page.getByLabel('URL').fill('http://127.0.0.1:1/health');
  await page.getByLabel('Severity').selectOption('critical');
  await page.getByRole('button', { name: /save/i }).click();

  await page.getByRole('button', { name: /run now/i }).click();
  await page.getByRole('tab', { name: /alerts/i }).click();
  await expect(page.getByText('Unreachable surface')).toBeVisible();

  await page.getByRole('button', { name: /^mute$/i }).click();
  await expect(page.getByText(/muted by you/i)).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npm run test:e2e -- alerts.spec.js`
Expected: PASS

- [ ] **Step 3: Update the documentation**

- **`README.md`** — a section covering: what a check is and the five types; heartbeats with a copy-pasteable cron line (`curl -fsS http://192.168.1.10:8788/hb/<check-id> || true` appended to a backup job); the severity × persistence policy with its defaults; re-notify suppression; where the decision log lives and how to read why something did or did not notify; the `.env` relay knobs; and the note that with no relay configured everything is still recorded and visible, just not delivered.
- **`CLAUDE.md`** and **`AGENTS.md`** — add every new module to the architecture list in the established one-line-per-module style, add `data/checks.json`, `data/alert-rules.json`, `data/alert-triage.json`, `data/events/`, and `data/ingest-heartbeat.json` to the self-contained-principle file list, and add a Security-notes bullet stating that the ingest daemon holds no credentials and that this is why it is a separate unit.
- **`docs/DEPLOY.md`** — installing and enabling `tmuxifier-ingest.service`, the bind-address choice, and the ordering note that the ingest daemon reads `data/checks.json` written by the dashboard.

- [ ] **Step 4: Full verification before committing**

Run: `npm test && npm run build`
Expected: PASS, no failures

- [ ] **Step 5: Commit**

```bash
git add test/e2e/alerts.spec.js README.md CLAUDE.md AGENTS.md docs/DEPLOY.md
git commit -m "docs(alerts): phase 1 usage, deployment, and architecture notes"
```

---

## Task 23: The two failure modes the slices did not cover

The self-review found two spec requirements with no implementing task. Both are
fail-loud guarantees, which makes them exactly the kind of thing that must not be
left implicit.

**Files:**
- Modify: `src/server/alertStateStore.js` (no behaviour change — add the guarantee test)
- Modify: `src/server/checkRunner.js` (per-source flood ceiling)
- Test: `test/alertStateStore.test.js` (extend), `test/checkRunner.test.js` (extend)

**Interfaces:**
- Produces: `createCheckRunner({ ..., maxEventsPerCheckPerHour })` defaulting to 60. Beyond the ceiling the runner stops appending individual occurrences for that key and appends one `flooding` meta-occurrence instead.

- [ ] **Step 1: Write the failing tests**

Append to `test/alertStateStore.test.js`:

```js
test('an unreadable rules file falls back to notifying, never to muting everything', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), '{ this is not json');
  // jsonFile.js quarantines the corrupt file and reads the fallback. The
  // fallback must be "no mutes" — a bug here has to produce noise, not silence.
  expect(await store.getRules()).toEqual({ mutes: [], overrides: {} });
});
```

Append to `test/checkRunner.test.js`:

```js
test('a flooding check is capped and raises one meta-occurrence instead of thousands', async () => {
  const { runner, eventLog, clock } = await mk([chk({ intervalSec: 10, failuresBeforeNotify: 1 })], {
    c1: Array.from({ length: 12 }, () => ({ ok: false, detail: 'down', latencyMs: 1 })),
  });
  const runnerCapped = createCheckRunner({
    checkStore: { listChecks: async () => [chk({ intervalSec: 10 })], getCheck: async () => chk({ intervalSec: 10 }) },
    dispatcher: createCheckDispatcher({ runners: { http: async () => ({ ok: false, detail: 'down', latencyMs: 1 }) } }),
    eventLog, now: () => clock.get(), jitter: () => 0, maxEventsPerCheckPerHour: 3,
  });
  for (let i = 0; i < 10; i++) { await runnerCapped.runDue(); clock.advance(10000); }
  const events = await eventLog.readSince(0);
  const flooding = events.filter((e) => e.title.includes('flooding'));
  expect(flooding).toHaveLength(1);
  expect(events.length).toBeLessThan(10);
  void runner;
});
```

- [ ] **Step 2: Run tests to verify the flood test fails**

Run: `npx vitest run test/alertStateStore.test.js test/checkRunner.test.js`
Expected: the rules test PASSES (the guarantee already holds — this test pins it); the flood test FAILS with more than one flooding event

- [ ] **Step 3: Add the ceiling to `src/server/checkRunner.js`**

Add `maxEventsPerCheckPerHour = 60` to the factory arguments, and in `execute`, replace the failure-append branch with:

```js
    } else {
      s.consecutiveOk = 0;
      s.consecutiveFail += 1;
      s.resolvedPending = true;
      // A check misconfigured to run every 10s against a permanently broken
      // target would otherwise append thousands of lines an hour. Past the
      // ceiling, stop appending individual occurrences and say so once: the
      // disk, the fold, and the operator's attention are all protected by the
      // same move.
      s.windowStart = s.windowStart && ts - s.windowStart < 3600000 ? s.windowStart : ts;
      if (s.windowStart === ts) s.windowCount = 0;
      s.windowCount = (s.windowCount || 0) + 1;
      const capped = s.windowCount > maxEventsPerCheckPerHour;
      // One append with a computed title: past the ceiling the runner says so
      // exactly once, then goes quiet for the rest of the hour.
      if (!capped || s.windowCount === maxEventsPerCheckPerHour + 1) {
        await eventLog.append({
          via: 'check', source: `check:${check.id}`, key: `check:${check.id}`, norm: null,
          severity: check.severity, state: 'firing',
          title: capped
            ? `${check.label} is flooding — capped at ${maxEventsPerCheckPerHour} events/hour`
            : `${check.label}: ${result.detail}`,
          body: result.detail || '',
        });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/alertStateStore.test.js test/checkRunner.test.js`
Expected: PASS, 7 + 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/checkRunner.js test/alertStateStore.test.js test/checkRunner.test.js
git commit -m "feat(alerts): per-check flood ceiling and fail-loud rules fallback"
```

---

## Verification checklist

Before declaring phase 1 done, confirm each of these by running it, not by reading the code:

- [ ] `npm test` passes with no skipped alert tests.
- [ ] `npm run typecheck` is clean.
- [ ] `npm run build` succeeds.
- [ ] `npm run test:e2e` passes.
- [ ] With `TMUXIFIER_ALERT_MAIL_HOST` unset, the dashboard still records and displays alerts (delivery disabled, nothing crashes).
- [ ] With the relay set, a deliberately failing critical check produces exactly one email, and a second evaluation inside the cooldown produces none.
- [ ] Stopping `tmuxifier-ingest` makes the dashboard banner appear within `staleMs`.
- [ ] A heartbeat check with a 60s window fires after ~60s of no check-ins and resolves on the next `curl` to its URL.
- [ ] `data/checks.json`, `data/alert-rules.json`, and `data/alert-triage.json` are all mode `0600`.
- [ ] No check secret appears in any `/api/*` response body (`grep` the browser network log).
