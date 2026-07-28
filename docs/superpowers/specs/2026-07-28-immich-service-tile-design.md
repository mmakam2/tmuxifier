# Immich service integration — design

Date: 2026-07-28
Status: approved

## Summary

A service tile whose check kind is `immich` stops being a liveness ping and becomes a photo
library readout. It authenticates against the Immich REST API with a stored, scoped API key
and renders, on the standby dashboard, a double-width card carrying a six-cell library and
storage census — photos, videos, library size, disk used, disk free, server version — above
conditional rollup rows for the job queues, the user census, and an available update, under
a summary chip reporting library size and job state.

The integration extends the existing service record rather than becoming a first-class
subsystem like Proxmox or NetBox, for the same reason the Pi-hole, TrueNAS and UniFi
integrations did: an Immich server is already expressible as a tile — a name, a link, a
group — and the only thing missing is that its check returns numbers instead of a status
line. Any Tmuxifier user can add their own server by pasting an API key into the service
form; no new settings tab, no new config knob, no host profile. It reuses
`servicesStore.js`, `serviceCheck.js`, `serviceChecker.js`, `serviceClientRegistry.js` and
the dashboard's tile pipeline.

Read-only. The integration never mutates the library.

Note that Immich already renders correctly as a plain `http` tile today: `immich` is in the
pinned `iconCatalog.js` slug list and `vendor/icons/immich.svg` ships with the catalog, so
the logo and a green/red lamp cost nothing. This design is strictly about replacing that
status line with readings.

## Verified against a live server

The API surface below was captured from a running **Immich v3.0.3** instance on 2026-07-28,
not inferred from documentation. That mattered — three assumptions carried into
brainstorming were wrong:

- `/api/spec-json` is **404** on v3. The OpenAPI document moved, so nothing here may depend
  on fetching a schema at runtime or at build time.
- `/api/server/ping` and `/api/server/version` are **public**; every other endpoint used
  here returns `401` without a key.
- `/api/server/storage` returns raw byte counts *alongside* pre-formatted human strings
  (`diskUse: "400.0 GiB"`, `diskUseRaw: 429496729600`). The integration takes the raw
  values and formats them with the repo's own `fmtBytes`, so the card reads consistently
  with the TrueNAS card rather than inheriting a second vendor's formatting conventions.

Any figures appearing in this document are illustrative placeholders. The captured
fixtures committed with the implementation are scrubbed of real host names, user names and
counts, per the repo's shipping rule.

## Decisions (from brainstorming)

- **A generic service-tile kind, not a first-class integration.** Same reasoning as the
  three credential-bearing kinds that precede it. Whatever the user's server is and wherever
  they file it, it is one record in `services.json` with a sealed credential.

- **Both library and health readings, not one or the other.** The card answers two
  questions at once — "how full is it" and "is it keeping up" — because they fail
  independently. A server with plenty of disk can have a stalled `metadataExtraction`
  queue, and a server with idle queues can be one week from full.

- **Pi-hole's TLS posture: plain `http` is allowed; `https` is verified by default with an
  explicit per-service `insecure` opt-out.** This deliberately diverges from TrueNAS and
  UniFi, which refuse `http` outright. Their reasons do not transfer. TrueNAS refuses
  because it *permanently revokes* any user-linked key presented over plain HTTP — the
  failure destroys the operator's credential. UniFi refuses because a local API key inherits
  its admin account's role and can write to the network, with no read-only scope available.
  Immich has neither property: keys survive plaintext use, and its granular permission model
  lets a key be scoped to reads only (see below). Meanwhile the standard self-hosted
  deployment is `http://192.168.1.10:2283` on a LAN, and refusing it would make the feature
  unusable for the majority case in exchange for a threat model that does not apply.

- **A `403` degrades the affected readings; it never fails the tile.** `server.statistics`
  and `job.read` are the two permissions a least-privilege key is most likely to lack. A key
  without them still reports storage, version and update availability, so the card shows
  those, renders `—` in the cells it cannot fill, omits the rows it cannot build, and prints
  one muted line naming the missing permissions. The lamp stays green: nothing is broken.
  This extends the `optional` precedent in `unifiApi.js` — which tolerates `404`/`501` from
  firmware lacking an endpoint — from "the server does not have this" to "this key may not
  read this".

- **Maintenance mode is included**, at the cost of a sixth request to
  `/api/server/config`. It is the one state that makes a server deliberately stop serving
  users while every other reading looks healthy, and nothing else on the card would reveal
  it.

- **`/api/users` is never called.** It returns email addresses. `statistics.usageByUser`
  already carries the per-user names and byte counts the card needs, so the user census
  costs no extra request and puts no email addresses on a dashboard.

## API surface

One refresh is six **concurrent** GETs — they are independent, so the tile costs one round
trip of latency rather than six:

| Endpoint | Permission | Supplies |
| --- | --- | --- |
| `GET /api/server/about` | `server.about` | `version`, `versionUrl` |
| `GET /api/server/storage` | `server.storage` | `diskUseRaw`, `diskSizeRaw`, `diskAvailableRaw`, `diskUsagePercentage` |
| `GET /api/server/statistics` | `server.statistics` | `photos`, `videos`, `usage`, `usageByUser[]` |
| `GET /api/jobs` | `job.read` | ~15 queues, each `{queueStatus:{isPaused,isActive}, jobCounts:{active,completed,failed,delayed,waiting,paused}}` |
| `GET /api/server/version-check` | `server.versionCheck` | `releaseVersion`, `checkedAt` |
| `GET /api/server/config` | `systemConfig.read` | `maintenanceMode` |

All six are GET. There is deliberately no code path in `immichApi.js` that issues another
verb, so the key's blast radius stays at reads even if the operator grants a broader key
than the docs recommend.

### Base URL normalization

An empty `check.target` means "use the tile's own `url`", the common case, as with Pi-hole.
Trailing slashes are stripped, **and so is a trailing `/api` segment** — an operator who
pastes the API base rather than the web base would otherwise generate
`/api/api/server/about` and a silent 404 storm with no indication of the cause.

### State classification

A `403` is proof that the server answered. Liveness therefore needs no separate ping call,
and there is no single anchor endpoint whose loss blanks the tile:

- every call fails at the transport layer (timeout, `ECONNREFUSED`, TLS error) → `down`, red
- any call returns `401` → `auth`, violet — the key is wrong or revoked
- otherwise → `up`; each `403`/`404` degrades only its own readings, and the metrics object
  records which permission was refused so the card can name it

`auth` is deliberately distinct from `down`, matching all three preceding kinds: a rotated
key means the server is answering perfectly well, and painting it red would cry wolf.

### Caching

The client holds a 30-second snapshot TTL, successes only — the same posture
`unifiApi.js` takes, and for the same reason: a tile's request cost must be bounded by the
client rather than by however the operator has tuned `TMUXIFIER_SERVICE_POLL_MS`. A
transient failure is never cached, so it cannot pin the tile to an error for the rest of the
window.

## Architecture

Three new server modules, mirroring the `unifiApi`/`unifiMetrics`/`unifiRegistry` split:

- **`src/server/immichApi.js`** — `createImmichClient({ baseUrl, apiKey, insecure,
  timeoutMs, ttlMs, now, request })` over `node:https`/`node:http`, dependency-free, in the
  mold of `netboxApi.js`. Exposes `probe()` (settings Test button) and `snapshot()` (the
  sweep). A thrown internal `ApiError` carries the classification `serviceCheck.js` needs;
  every public method converts it into a result object rather than letting it escape.

- **`src/server/immichMetrics.js`** — pure `buildMetrics({ about, storage, statistics,
  jobs, versionCheck, config })`. No I/O, so every aggregation the card depends on is
  testable without a server. This module is why the design uses the three-module split
  rather than Pi-hole's two: Pi-hole's metrics are close to a passthrough, whereas
  collapsing fifteen job queues into one verdict, deriving update availability from two
  endpoints, and tracking which readings were lost to a `403` is real logic. Since vitest
  runs `environment: 'node'` with no jsdom, the card's DOM layer is untestable by design,
  making this the only place that aggregation can be covered.

- **`src/server/immichRegistry.js`** — `createImmichRegistry({ store })`, a thin wrapper
  over `createServiceClientRegistry`. One client per service id, rebuilt when the API base,
  key, or TLS mode changes; `retain` closes departed services.

Touched: `servicesStore.js` (kind, `SECRET_KINDS`, `normalizeCheck` branch),
`serviceCheck.js` (`checkImmich` + dispatch), `serviceChecker.js` (registry + `retain`),
`index.js` (construct + `closeAll`), `server.js` (`POST /api/services/immich/test`),
`iconResolve.js` (`KIND_SLUGS.immich = 'immich'` — declared, not guessed from the name).

Web: `immichCard.ts` (new), `api.ts` (kind, `ImmichMetrics`, `testImmich`), `dashboard.ts`
(dispatch, element map, both cleanup paths), `settingsServices.ts` (radio, help, payload),
`style.css`.

## Metrics shape

```js
{
  version: 'v3.0.3', releaseVersion: 'v3.0.3',
  updateAvailable: false, checkedAt: '2026-07-28T23:06:00.095Z',
  photos: 48300, videos: 1200, libraryBytes: 322122547200,
  users: 3, topUser: { name: 'Example User', bytes: 311385128960 },
  diskUsedBytes: 429496729600, diskSizeBytes: 1099511627776,
  diskFreeBytes: 670014898176, diskUsedPct: 39,
  jobs: { active: 0, waiting: 0, failed: 0, paused: [] },
  maintenanceMode: false,
  denied: [],            // e.g. ['server.statistics', 'job.read']
}
```

**Job aggregation.** Sum `active` across queues, sum `waiting + delayed`, sum `failed`, and
collect the *names* of queues whose `queueStatus.isPaused` is true. Named rather than
counted, because a tally cannot tell you which queue to go restart — the same reasoning that
makes `unifiMetrics.js` name offline devices instead of counting them. `completed` is
cumulative since boot and reports nothing about current health, so it is deliberately
dropped.

**Two distinct size readings.** `libraryBytes` is `statistics.usage`; `diskUsedBytes` is
`storage.diskUseRaw`. These are different numbers with different meanings — a library
smaller than the volume's used space is normal, and the gap is exactly what an operator
wants to be able to see. Collapsing them into one figure would be a defect, not a
simplification.

## Card

Six cells:

```
PHOTOS   VIDEOS   LIBRARY
48.3k    1,200    300 GB
DISK     FREE     VERSION
39%      624 GB   v3.0.3
```

Counts use `fmtCompact`, which switches to `k` only above 10,000 — so a five-figure photo
count compacts while a four-figure video count stays grouped. Byte figures use `fmtBytes`.
Note that `fmtBytes` divides by 1024 while labelling the result `GB`/`TB`, so its output
will not match the `GiB` strings Immich returns in `storage.diskUse`; the card ignores those
strings entirely and formats the raw counts itself, which is what keeps it consistent with
the TrueNAS card beside it.

Rows, each earning its place or being omitted entirely — the `unifiCard.ts` rule that a
class the site does not have earns no row, because `0/0` is noise rather than news:

- `JOBS` — `idle` when every count is zero, otherwise `3 active · 120 waiting`, with
  `· 2 failed` appended when applicable
- `USERS` — `3 · 290 GB largest (Example User)`
- `UPDATE` — rendered only when `updateAvailable`

Two notice slots, because they are different classes of statement and one must not mask the
other:

- `exception` (amber-toned, the existing `dash-card-warn` class), by precedence:
  maintenance mode, then failed jobs, then paused queues
- `note` (muted): `needs server.statistics and job.read for library and jobs`

Chip: library size and job state — `300 GB · jobs idle`. When statistics are denied it
falls back to the version.

### Lamp

Named exported thresholds, mirroring `truenasCard.ts`:

```
DISK_WARN_PCT = 80    DISK_CRIT_PCT = 90

auth   ← 401. Outranks every metric-derived colour: the other readings are stale, not bad.
red    ← transport failure, or diskUsedPct >= DISK_CRIT_PCT
amber  ← diskUsedPct >= DISK_WARN_PCT, failed jobs, any paused queue, or maintenance mode
green  ← otherwise
```

Two deliberate non-triggers:

**An available update is never a colour.** A dashboard that turns amber every time upstream
cuts a release is a dashboard the operator stops reading. It gets a row and nothing more.

**Denied permissions are never a colour.** Green lamp, muted note. This is what makes a
least-privilege key a first-class configuration rather than a broken one.

**Maintenance mode is amber rather than red**, because the server is not serving but is
deliberately not serving. This is the same distinction that puts TrueNAS's `DEGRADED` at
amber and `FAULTED` at red: intent is precisely what the lamp exists to convey.

## Validation and settings

`servicesStore.js` gains `'immich'` in `KINDS` and in `SECRET_KINDS` — so changing a record
away from this kind drops the sealed key — and a `normalizeCheck` branch identical in shape
to Pi-hole's:

```js
if (kind === 'immich') {
  const out = { kind };
  if (target) { assertHttpUrl(target, 'check.target'); out.target = target; }
  if (merged.insecure === true) out.insecure = true;
  return out;
}
```

**A known trap this walks into.** `normalizeCheck` merges `{ ...base, ...raw }`, so a form
that *omits* `insecure` can never turn it off — a stored `true` would survive every
subsequent save. `settingsServices.ts` already states the boolean outright for Pi-hole
(`insecure: f.insecure === true`) and Immich must do the same. The implementation carries an
explicit test for the **clearing** case, not merely the setting case.

Settings form: `'immich'` joins `CREDENTIAL_KINDS`; a new radio; credential label `API key`;
placeholder `https://immich.example.com`; the `insecure` checkbox shown for `pihole |
immich`. Help text names the five permissions verbatim so scoping a key is a copy-paste
task:

```
server.about, server.storage, server.statistics, server.versionCheck, job.read
(plus systemConfig.read for maintenance-mode detection)
```

`POST /api/services/immich/test` mirrors the Pi-hole test route, and earns its keep beyond a
yes/no: `probe()` returns `{ ok, version, denied }`, so the Test button reports which
permissions are missing *before* the record is saved:

```
✓ connected — Immich v3.0.3
  missing server.statistics — library counts will be blank
```

## Targeted cleanup

`unifiCard.ts` owns `dash-unifi-rows` / `dash-unifi-row`, and the Immich card needs an
identical row list. Rather than a second private copy, both move to a shared
`dash-card-rows` / `dash-card-row`. This is a change to code the work already touches, not
unrelated refactoring, and it is safe: the DOM layers carry no tests to break, since vitest
runs with no jsdom.

## Error handling

The client never throws to its caller. Internal `ApiError`s are classified `auth` |
`denied` | `unreachable` | `unexpected`, and `checkImmich` converts every outcome into a
`{ state, latencyMs, immich }` result. One unreachable Immich server can therefore never
poison a sweep, matching the contract every other check kind honours.

The sealed API key is redacted to `hasPassword` on every read of the service record;
`getServiceSecret` remains the sole decrypting path.

## Testing

Real code, no mocks, per the repo's TDD convention.

| File | Covers |
| --- | --- |
| `test/immichMetrics.test.js` | job rollup across queues, paused-queue naming, `denied` tracking, update derivation, library-vs-disk distinction, absent payloads |
| `test/immichApi.test.js` | injected `request`: `401`→auth, per-endpoint `403`→degrade, all-transport-fail→down, 30s TTL, GET-only, `/api` suffix stripping |
| `test/immichApi.integration.test.js` + `test/helpers/fakeImmich.js` | real HTTP server over captured payloads, mirroring `fakeUnifi.js` |
| `test/immichCard.test.js` | lamp precedence, 80/90 thresholds, omitted rows, chip fallback, both notice slots |
| `test/servicesStore.test.js` | kind validation, secret sealing, **insecure-clearing** |
| `test/serviceCheck.test.js` | dispatch to `checkImmich` |
| `test/serviceRoutes.test.js` | the test route |
| `test/settingsServices.test.js` | payload builder including the clearing case |
| `test/iconResolve.test.js` | `KIND_SLUGS.immich` |

Fixtures derive from the 2026-07-28 live capture with every real value scrubbed —
placeholder user names, `immich.example.com`, rounded counts.

Server-side green is not evidence the card renders. The feature is validated in a real
browser before merge, asserting the tile actually paints readings rather than merely
existing in the DOM.

## Shipping

This is a server-side change, so validation requires a real branch checkout, build and
service restart — not the `rsync dist/` shortcut, which only covers client-only work. The
restart waits until no setup, provision, lifecycle, fleet or voice-install job is `running`.

## Out of scope

- Album counts (`/api/albums` returns full album objects including member email addresses;
  a count is not worth that payload or that exposure)
- Per-user quota tracking — `quotaSizeInBytes` is null on unquotaed instances, which is the
  common case
- Any write operation, including triggering or resuming a job queue. The Tmuxifier
  dashboard reports; it does not administer.
