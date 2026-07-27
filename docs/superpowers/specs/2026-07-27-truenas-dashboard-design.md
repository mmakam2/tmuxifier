# TrueNAS service integration — design

Date: 2026-07-27
Status: approved

## Summary

A service tile whose check kind is `truenas` stops being a liveness ping and becomes a
storage readout. It authenticates against the TrueNAS JSON-RPC 2.0 WebSocket API with a
stored user-linked API key and renders, on the standby dashboard, a double-width card
carrying one row per ZFS pool (name, used percentage, free space) under a summary chip
that reports the worst pool health and the active alert count, with a footer line showing
the TrueNAS version and host uptime.

The integration extends the existing service record rather than becoming a first-class
subsystem like Proxmox or NetBox, for the same reason the Pi-hole integration did: a NAS
is already expressible as a tile — a name, a link, a group — and the only thing missing is
that its check returns numbers instead of a status line. It reuses `servicesStore.js`,
`serviceCheck.js`, `serviceChecker.js` and the dashboard's tile pipeline.

Read-only. The integration never mutates the NAS.

## Decisions (from brainstorming)

- **Transport: JSON-RPC 2.0 over WebSocket, not the REST API.** TrueNAS deprecated the
  REST API in 25.04 and removed it in TrueNAS 26; 25.10.1 and later raise a system alert
  whenever a deprecated REST endpoint is touched. The target deployment is 25.10.5, where
  REST still answers but complains, and would break outright on the next major upgrade.
  Building on REST would mean shipping a client with a known expiry date and a guarantee
  of nuisance alerts on the user's own NAS.
- **Authentication: `auth.login_ex` with `mechanism: "API_KEY_PLAIN"`, not
  `auth.login_with_api_key`.** The latter takes no username and is the more convenient
  onboarding, but it is deprecated and removed in TrueNAS v27. `auth.login_ex` is the
  supported path from 25.04 forward. SCRAM (`mechanism: "SCRAM"`), which never puts the
  key on the wire, exists only from TrueNAS 26; the client does not attempt it and does
  not negotiate, because the server's advertised mechanism list is unauthenticated and a
  downgrade negotiation would be strippable by a man in the middle. Adding SCRAM is
  straightforward later work once the deployment is on 26.
- **Plain `http://` targets are refused, not merely discouraged.** TrueNAS automatically
  revokes any user-linked API key presented over insecure transport. An `insecure` opt-out
  that skips certificate verification is offered — a NAS with a self-signed certificate is
  the common case — but there is no option that sends the key over cleartext HTTP, because
  the failure mode is destruction of the user's credential rather than a weakened
  connection.
- **Display: pool rows plus a summary chip**, not the Pi-hole card's fixed six-reading
  grid. A TrueNAS has a variable number of pools, and disk usage is the reading the tile
  exists for; folding several pools into one aggregate used/free pair hides exactly the
  pool that is filling up. The alternative richer layout — pool rows *plus* a
  CPU/memory/ARC strip — was rejected as more calls per sweep for readings the dashboard's
  box tiles already cover for machines that matter.
- **Severity is derived on the client, from metrics.** The server's `ServiceResult.state`
  stays a reachability verdict (`up`/`down`/`auth`), unchanged for every existing check
  kind. The green/amber/red decision is a pure exported function over the metrics object,
  which keeps the wire contract stable and the threshold rules trivially testable.
- **Poll cadence: the existing 30-second service sweep.** Pool statistics move slowly, but
  a separate slower loop would mean a second interval to configure and a second sweep to
  maintain, and the cost of staying on the shared sweep is three cheap JSON-RPC calls over
  a socket that is already open.
- **Read-only.** No pool, dataset, service, app, or alert-dismissal method is ever called.
  The API key's blast radius stays at reads, and the card links to the TrueNAS web UI for
  anything actionable.

## API surface used

The endpoint is `wss://<host>/api/current`. Every call is a JSON-RPC 2.0 request object:

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "pool.query", "params": [] }
```

Authentication is one call, made once per connection:

```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "auth.login_ex",
  "params": [{
    "mechanism": "API_KEY_PLAIN",
    "username": "truenas_admin",
    "api_key": "1-…"
  }]
}
```

The result carries a `response_type` of `SUCCESS`, `AUTH_ERR`, `EXPIRED`, `OTP_REQUIRED`,
or `REDIRECT`. Only `SUCCESS` proceeds; the rest resolve as the `auth` state with a
message specific to which one came back, so an expired key reads differently from a wrong
one.

Each sweep then issues three calls concurrently over the same socket, correlated by `id`:

| Method | Supplies |
|---|---|
| `pool.query` | per pool: `name`, `size`, `allocated`, `free`, `healthy`, `status`, `scan` |
| `system.info` | `version`, `uptime_seconds`, `hostname` |
| `alert.list` | per alert: `level`, `dismissed`, `text` |

`pool.query` does not return the boot pool (that is `boot.get_state`), so no filtering is
needed to keep `boot-pool` off the card.

The API key needs the **READONLY_ADMIN** role: `system.info` requires it, and the other
two calls are satisfied by it. The settings form says so, because a key minted with a
narrower role fails on one call out of three and would otherwise look like a partial
outage.

On shutdown the client calls `auth.logout` and closes the socket, mirroring the Pi-hole
client's session revoke.

## Data model

`data/services.json` records gain an optional TrueNAS shape. Existing records remain valid
and are untouched.

```jsonc
{
  "id": "svc-…",
  "name": "nas",
  "url": "https://nas.example.com",
  "section": "infrastructure",
  "group": "Storage",
  "glyph": "󰋊",
  "check": {
    "kind": "truenas",
    "target": "https://nas.example.com",  // optional; defaults to `url`
    "username": "truenas_admin",
    "insecure": false                      // omitted unless true
  },
  "secret": "…",                           // sealed API key, never read back out
  "createdAt": "2026-07-27T00:00:00.000Z"
}
```

`username` is not a secret and is stored in the clear alongside the rest of the check.
The API key is sealed with AES-256-GCM (key derived from `cookieSecret`) into the same
`secret` field the Pi-hole app password already uses, and is redacted on every read to the
existing boolean `hasPassword`. The field keeps its Pi-hole-era name rather than being
renamed to `hasSecret`: the rename would touch `servicesStore.js`, `api.ts`,
`serviceCheck.js`, `settingsServices.ts` and their tests to change nothing observable.

`normalizeCheck` gains a `truenas` branch that:

- accepts an optional `target`, defaulting to the tile's `url`;
- **rejects any target or url whose protocol is `http:`**, with an error naming the key
  revocation as the reason;
- requires a `username` of 1–64 characters;
- carries `insecure: true` through only when explicitly set.

`sealPassword` widens its kind test from `=== 'pihole'` to a set of kinds that can hold a
secret, so changing a tile's kind away from either still drops the stored credential.

## Modules

### New — server

- **`truenasApi.js`** — `createTruenasClient({ baseUrl, username, apiKey, insecure,
  timeoutMs })`. Owns one WebSocket. Responsibilities: connect, log in (single-flight, so
  concurrent reads that find no session await one login), issue correlated JSON-RPC calls,
  and map the three results into a flat metrics object. Like `piholeApi.js`, nothing
  throws out to the caller — every failure resolves as a tagged result (`auth`,
  `unreachable`, `parse`) so one bad service cannot poison a sweep. A socket that closes
  between sweeps is reconnected on the next call; a call that fails mid-flight with an
  authentication error re-logs-in exactly once and replays, never in a loop.
- **`truenasRegistry.js`** — one client per service id, rebuilt when the API base,
  username, key, or TLS mode changes; a thin wrapper over the shared registry below.
- **`serviceClientRegistry.js`** — the generic half of today's `piholeRegistry.js`,
  extracted: the fingerprint-keyed client cache, `retain(ids)`, `closeAll()`, and the
  best-effort `closeQuietly` that keeps a NAS that is down at shutdown from stalling the
  exit. `piholeRegistry.js` becomes a thin wrapper differing only in which inputs form the
  fingerprint. The existing `piholeRegistry.test.js` covers the extraction.

### New — web

- **`truenasCard.ts`** — the pure card model (`truenasCardModel`), the pure severity
  function (`truenasLamp`) with the capacity thresholds as named exported constants, and
  the in-place-updating DOM painter. It lives outside `dashboard.ts`, which is already 610
  lines and would otherwise take a second card layout on top of the Pi-hole one;
  `dashboard.ts` delegates on `kind === 'truenas'` exactly as it does for `pihole`.

### Edited

- `servicesStore.js` — the `truenas` kind, its validation, and the widened secret rule.
- `serviceCheck.js` — a `checkTruenas` branch alongside `checkPihole`, returning
  `up`/`down`/`auth` plus a `metrics` payload.
- `serviceChecker.js` — pass the TrueNAS registry into the sweep and `retain` the live
  TrueNAS service ids, as it already does for Pi-hole.
- `server.js` — `POST /api/services/truenas/test`, a direct analogue of the Pi-hole test
  route, so the settings form can prove a URL/username/key triple before saving it.
- `index.js` — construct the registry, wire it into the checker, and add its `closeAll` to
  the shutdown flush list.
- `api.ts` — the `truenas` member of `ServiceCheckKind`, the `TruenasMetrics` interface,
  `username` on `ServiceCheck`, and the `testTruenas` fetch wrapper.
- `dashboard.ts` — delegate `truenas` tiles to the new card painter.
- `settingsServices.ts` — the `truenas` radio and its field group.
- `style.css` — pool-row styling reusing the existing `dash-card-*` vocabulary.
- `package.json` — `ws` promoted to a direct dependency.

## Metrics shape

```ts
export interface TruenasPool {
  name: string;
  size: number | null;       // bytes
  allocated: number | null;  // bytes
  free: number | null;       // bytes
  usedPct: number | null;    // 0-100, derived; null when size is unknown or zero
  healthy: boolean;
  status: string;            // ONLINE | DEGRADED | FAULTED | …
  scanning: boolean;         // a scrub or resilver is in progress
}
export interface TruenasMetrics {
  pools: TruenasPool[];      // every pool, uncapped; the row cap is a display decision
  alerts: { critical: number; warning: number };
  version: string | null;
  hostname: string | null;
  uptimeSec: number | null;
}
```

`usedPct` is derived server-side from `allocated / size` rather than trusted from a
string, because `pool.query` reports `fragmentation` as a string and the capacity fields
are nullable.

Alert levels are folded into two counters. TrueNAS emits `INFO`, `NOTICE`, `WARNING`,
`ERROR`, `CRITICAL`, `ALERT`, and `EMERGENCY`; `ERROR` and above count as critical,
`NOTICE` and `WARNING` count as warning, and `INFO` is ignored. Alerts with
`dismissed: true` are excluded — the operator has already seen them and said so.

## Card

```
┌─ nas ─────────────────────── ●  2 alerts ┐
│ tank              68%        2.1 TB free │
│ fast              31%        410 GB free │
│ backup            91%        180 GB free │
├──────────────────────────────────────────┤
│ 25.10.5 · up 41d 6h                      │
└──────────────────────────────────────────┘
```

Pool rows are capped at 6; a seventh and beyond collapse into a `+N more pools` line, so a
NAS with many pools cannot push the rest of the dashboard off the screen.

A pool with a scrub or resilver running is marked in its row rather than in the chip,
because it is a property of that pool and the chip is already carrying the worst-of
summary.

A degraded card follows the Pi-hole precedent: when the check fails there is one error
line, not a grid of dashes. Six blank readings say less than one sentence does.

## Lamp rules

`truenasLamp(result)` is pure and exported, and its table is the test's table:

| Lamp | Condition |
|---|---|
| green | every pool `healthy` and `ONLINE`, no active alert, every pool under 80% used |
| amber | any pool `DEGRADED` or otherwise not `healthy` but still importable, or a warning-level alert, or any pool at or above 80% used |
| red | unreachable, or any pool `FAULTED`/`UNAVAIL`/`REMOVED`, or an error-level or worse alert, or any pool at or above 90% used |
| auth (violet) | the API key was rejected, expired, or requires a one-time password |

Red outranks amber; auth outranks both, because a rejected key means every other reading
is stale rather than bad. The split between the two unhealthy bands is deliberate: a
`DEGRADED` pool is still serving data and wants attention this week, while a `FAULTED`
pool is not serving data and wants attention now — collapsing them into one colour would
lose the only distinction the lamp exists to make. `auth` reuses the violet `.dot.auth` lamp that boxes already use
for failed SSH credentials, and `amber` reuses the existing `.dot.amber` class, which the
services section does not currently use.

The capacity thresholds are included at the user's request: a filling pool is the thing a
storage tile should surface, and waiting for TrueNAS to raise its own 80% alert makes the
lamp a lagging indicator of a condition the card is already displaying.

## Settings form

The `truenas` radio adds a field group: an optional API base URL (defaulting to the link
URL, as the Pi-hole form does), a username, an API key, an `insecure` checkbox for
self-signed certificates, and a **Test** button.

The API key field follows the Pi-hole password field's contract exactly: an untouched
field sends no key at all, so editing a tile's name never clears its credential; an
explicitly emptied field sends `null`, which the store reads as "clear".

Help text states that the key must carry the READONLY_ADMIN role and that it is created
under Credentials → Users → API Keys on the NAS.

The Test button calls `POST /api/services/truenas/test` with the URL, username, key, and
TLS mode, which opens a throwaway client, logs in, reads `system.info`, logs out, and
reports either the TrueNAS version it saw or the specific failure. As with the Pi-hole
route, an already-saved service may be tested by id so that the stored key is used without
the browser ever having held it.

## Error handling

Every failure resolves; none throws. The states, in the order they are checked:

| Condition | State | Card |
|---|---|---|
| `http:` target | rejected at save time | never reaches a check |
| socket refused, DNS failure, TLS failure, timeout | `down` | one error line |
| `response_type` of `AUTH_ERR` | `auth` | "API key rejected" |
| `response_type` of `EXPIRED` | `auth` | "API key expired" |
| `response_type` of `OTP_REQUIRED` | `auth` | "this account requires a one-time password — use a user-linked API key without OTP" |
| JSON-RPC error on a data call | `down` | the method name and the error message |
| unparseable frame | `down` | "unreadable response" |
| all three calls succeed | `up` | the card |

The API key never appears in an error message, a log line, or an API response.

## Testing

Test-first, real code rather than mocks, per the repository convention.

- **`test/helpers/fakeTruenas.js`** — a real WebSocket server speaking JSON-RPC 2.0, in
  the mold of `test/helpers/fakePihole.js`. It can be scripted to reject a login, expire
  mid-session, return a degraded pool, emit alerts at each level, or drop the socket.
- **`test/truenasApi.test.js`** — login success and each failure `response_type`; the
  three-call fan-out correlating by id; single-flight login under concurrent calls; one
  re-login and replay after a mid-flight auth failure, and no second attempt after that;
  reconnection after the socket closes between sweeps; `auth.logout` on close; and that
  the key never appears in any returned error string.
- **`test/truenasCard.test.js`** — the lamp table row by row, the row cap and the
  `+N more` line, byte and percentage formatting, the null-capacity path, and the
  single-error-line degraded rendering.
- **`test/serviceClientRegistry.test.js`** — cache hit on an unchanged fingerprint, rebuild
  and close on each changed input, `retain` closing departed services, and `closeAll`
  tolerating a client whose close rejects.
- **`test/servicesStore.test.js`** — additions: the `truenas` kind validates; an `http:`
  target is refused with the revocation reason; the username is required and stored in the
  clear; the key seals, redacts to `hasPassword`, survives an unrelated edit, and clears on
  an explicit null or a kind change.
- **`test/serviceCheck.test.js`** — additions: the `truenas` branch dispatches to the
  client, maps `up`/`down`/`auth` correctly, and returns metrics on success.
- **`test/serviceRoutes.test.js`** — additions: the test route's success and failure
  shapes, and that it never echoes the key.

## Out of scope

Deliberately excluded, each a plausible later feature:

- SMART data, disk temperatures, and per-disk health.
- Per-dataset usage, snapshot counts, and quota reporting.
- App, VM, replication-task, and cloud-sync status.
- Any write operation, including dismissing an alert.
- Health events and browser notifications for service tiles. The events log in
  `healthHistory.js` is keyed by box; giving services a place in it is its own feature and
  would be the natural follow-up if a filling pool should page the operator rather than
  merely colour a lamp.
- SCRAM authentication, which requires TrueNAS 26.

## References

- [Feature deprecations — REST removed in TrueNAS 26](https://www.truenas.com/docs/scale/26/gettingstarted/deprecations/)
- [JSON-RPC 2.0 over WebSocket](https://api.truenas.com/v25.10/jsonrpc.html)
- [`auth.login_ex`](https://api.truenas.com/v25.10/api_methods_auth.login_ex.html)
- [`pool.query`](https://api.truenas.com/v25.10/api_methods_pool.query.html)
- [`system.info`](https://api.truenas.com/v25.10/api_methods_system.info.html)
- [`alert.list`](https://api.truenas.com/v25.10/api_methods_alert.list.html)
- [truenas/api_client](https://github.com/truenas/api_client)
