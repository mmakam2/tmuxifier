# Pi-hole service integration — design

Date: 2026-07-27
Status: approved

## Summary

A service tile whose check kind is `pihole` stops being a liveness ping and becomes a
readout. It authenticates against the Pi-hole v6 REST API with a stored app password and
renders, on the standby dashboard, a double-width card carrying blocking status, queries
today, blocked share, active/total clients, gravity domain count, version (with an
update marker), and uptime.

The integration extends the existing service record rather than becoming a first-class
subsystem like Proxmox or NetBox. A Pi-hole is already expressible as a tile — a name, a
link, a group — and the only thing missing is that its check returns numbers instead of a
status line. Reusing `servicesStore.js`, `serviceCheck.js`, `serviceChecker.js` and the
dashboard's tile pipeline keeps the change to one new server module plus edits, and leaves
a seam any later HTTP-API-backed tile can use.

Read-only. The integration never mutates the Pi-hole.

## Decisions (from brainstorming)

- **Placement: service-record enrichment**, not a `data/pihole.json` store with its own
  settings tab and poll loop. The NetBox/Proxmox mold buys a dedicated infrastructure
  group and per-instance modules, at the cost of roughly five new files and a second way
  to describe a thing the services store already describes. Rejected as machinery without
  a matching gain.
- **Display: a double-width stat card in place of the tile.** Six metrics do not fit a
  tile's one-line readout. A compact tile plus a click-through detail panel was the
  alternative; the standby dashboard exists to be looked at, not clicked through, so the
  numbers belong on the surface. A detail panel with top domains, top clients and a query
  sparkline remains available as later work.
- **Read-only.** `POST /api/dns/blocking` is never called. Every other dashboard module is
  a readout, the app password's blast radius stays at reads, and disabling blocking is one
  click away in the Pi-hole web UI the card already links to.
- **Pi-hole v6 only.** v6 replaced `admin/api.php` with a session-authenticated REST API
  under `/api/`; supporting v5's `auth=<token>` query parameter as well would mean two
  clients and a probe to decide between them, for an EOL release.

## API surface used

All four are `GET`, all require a session:

| Endpoint | Supplies |
|---|---|
| `/api/stats/summary` | `queries.total`, `queries.blocked`, `queries.percent_blocked`, `clients.active`, `clients.total`, `gravity.domains_being_blocked` |
| `/api/info/version` | `version.{core,web,ftl}.{local,remote}.version` |
| `/api/info/system` | `system.uptime` (host uptime, seconds) |
| `/api/dns/blocking` | `blocking` (`enabled`/`disabled`), `timer` |

`POST /api/auth` with `{"password": "…"}` returns `{session: {valid, sid, validity, …}}`.
`DELETE /api/auth` revokes it.

`system.uptime` is the host's uptime, not FTL's. `/api/info/ftl` carries FTL's own uptime
and would be the more precise reading of "how long has the Pi-hole been serving", at the
cost of a fifth request per sweep; host uptime is the colloquial meaning and is what the
card shows.

## Data model

`data/services.json` records gain an optional Pi-hole shape. Existing records remain valid
and are untouched by the change.

```jsonc
{
  "id": "svc-…",
  "name": "pihole",
  "url": "https://pihole.example.com",
  "group": "DNS Filtering",
  "check": {
    "kind": "pihole",       // fourth kind, alongside http | tcp | none
    "target": "",           // optional API base URL; defaults to `url`
    "insecure": false       // allow a self-signed certificate (default: verify)
  },
  "secret": { "alg": "…", "iv": "…", "ct": "…", "tag": "…" }
}
```

`secret` is the app password sealed with `secretBox.js` (AES-256-GCM, key derived from
`cookieSecret` via HKDF), the same treatment `proxmoxStore.js` and `netboxStore.js` give
their tokens. `createServicesStore` therefore gains a `cookieSecret` argument, injected in
`index.js`.

Reads redact: the API returns `hasPassword: true|false` and never the sealed blob. Writes
follow the store's existing optional-field convention — an absent `password` keeps the
stored one, `null` clears it, a string replaces it.

The credential is a Pi-hole **app password** (Settings → Web interface / API → Configure
app password), not the web login password. App passwords are the documented programmatic
credential and are unaffected by TOTP; a web password on a Pi-hole with 2FA enrolled
cannot complete `POST /api/auth` without a one-time code.

### Validation

`normalizeCheck` in `servicesStore.js` gains a `pihole` branch:

- `target`, when present, must pass the existing `assertHttpUrl` (http/https only).
- `insecure` is coerced to a boolean, defaulting to `false`.
- An empty `target` is legal and means "use the service's `url`".

## Server

### `piholeApi.js` (new)

A dependency-free client over `node:http`/`node:https`, in the mold of `netboxApi.js`.
`createPiholeClient({ baseUrl, password, insecure, timeoutMs })` returns
`{ fetchSummary(), close() }`.

Session lifecycle is the load-bearing detail. Pi-hole v6 caps concurrent sessions, so
minting one per sweep would exhaust the pool within the hour:

- The sid is held in memory only, never persisted, and reused until 80% of the reported
  `validity` has elapsed.
- Authentication is single-flighted: concurrent `fetchSummary()` calls that find no valid
  session await one shared `POST /api/auth`.
- A `401` on a data request triggers exactly one re-authentication and one retry; a second
  failure resolves as an auth error for that tick rather than looping.
- `close()` issues `DELETE /api/auth`, wired into the existing shutdown flush.

`fetchSummary()` issues the four GETs in parallel and returns:

```js
{
  blocking: 'enabled' | 'disabled',
  blockingTimer: number | null,   // seconds until automatic re-enable
  queriesTotal, queriesBlocked, percentBlocked,
  clientsActive, clientsTotal,
  gravityDomains,
  versionCore, versionWeb, versionFtl,
  updateAvailable: boolean,       // any component's remote version differs from local
  uptimeSec,
}
```

Failures never throw out of the client; they resolve as a tagged error so one bad Pi-hole
cannot poison a sweep — the same contract `serviceCheck.js` already holds.

### `piholeRegistry.js` (new)

Sessions must outlive a single check, so clients cannot be constructed per call.
`createPiholeRegistry({ store, cookieSecret })` owns one client per service id, keyed by a
fingerprint of that service's base URL, password and `insecure` flag. A configuration
change discards the old client (closing its session) and builds a new one; a removed
service's client is closed on the next sweep. `closeAll()` is the shutdown seam.

### `serviceCheck.js`

`checkService(service, opts)` gains a `pihole` branch delegating to the registry supplied
in `opts`. The result shape grows one optional field and one new state:

```js
{ state: 'up',   latencyMs: 41, metrics: { … } }                    // healthy
{ state: 'auth', latencyMs: 38, error: 'app password rejected' }    // reachable, bad creds
{ state: 'down', error: 'timeout' }                                 // unreachable
```

`auth` maps onto the violet `.dot.auth` lamp that already exists for boxes whose SSH
credentials fail. The semantics match exactly, and a rotated app password reads as "needs
credentials" rather than a false "Pi-hole is down".

### `serviceChecker.js`

Unchanged except for threading the registry into `check()`. Interval, concurrency cap,
sweep coalescing and cached-snapshot serving all stay as they are.

### Routes

`POST /api/services/pihole/test` (authenticated) accepts `{ url, password, insecure }`,
authenticates, reads `/api/info/version`, revokes the session, and returns
`{ ok: true, version }` or `{ ok: false, error }`. It exists because the
app-password-versus-web-password distinction is the standard v6 trip hazard, and
discovering it through a silently red tile is a poor trade for forty lines of route.

`GET /api/services` and the create/update routes carry `hasPassword` and accept
`password`, per the redaction rule above.

## Client

### `api.ts`

`ServiceCheckKind` gains `'pihole'`; `Service` gains `hasPassword` and `check.insecure`;
the status result type gains `metrics` and the `auth` state.

### `settingsServices.ts`

A fourth check radio, **Pi-hole**, revealing three fields:

- **API base URL** — optional, placeholder explaining it defaults to the link URL.
- **App password** — `type=password`. When editing, a "leave blank to keep the stored
  password" placeholder; the field sends nothing unless typed into. A Clear control sends
  `null`.
- **Allow self-signed certificate** — unchecked by default.

Plus a **Test connection** button calling the route above and reporting inline.

The default differs deliberately from the `http`/`tcp` checks, which always set
`rejectUnauthorized: false`: those send no credentials, so tolerating a bad certificate
costs nothing. This check sends a password, so TLS is verified unless the operator opts
out per service — the same posture as NetBox's insecure mode.

`buildServicePayload` stays pure and grows the new fields.

### `dashboard.ts`

The existing pure `serviceLamp()` gains `'auth'` as a fourth return value, so ordinary
tiles and Pi-hole cards classify a lamp through one function. A pure
`piholeCardModel(svc, snapshot)` returns `{ lamp, chip, rows, error }` — testable in node
with no DOM — and `paintTile` branches on the check kind to render a `.dash-tile-wide`
(`grid-column: span 2`) card:

```
┌─ DNS FILTERING ────────────────────┐
│ ● pihole               blocking on │
│ QUERIES   48,132   BLOCKED   22.4% │
│ CLIENTS    31/54   DOMAINS   1.28M │
│ VERSION  v6.2.1↑   UPTIME   14d 3h │
└────────────────────────────────────┘
```

Formatting lives entirely in the pure model: thousands separators on queries, `1.28M`
compaction on gravity domains, one decimal on the blocked percentage, `14d 3h` / `3h 12m`
/ `8m` on uptime, and a `↑` appended to VERSION when `updateAvailable`. A disabled-blocking
chip shows the remaining timer when the Pi-hole reports one (`off · 28m left`).

Degraded states replace the three stat rows with a single line — violet lamp plus
`app password rejected` for `auth`, red lamp plus the error text for `down`. The existing
stale-poll behaviour is unchanged: a failed sweep dims the section and leaves the last good
numbers painted rather than blanking the card.

The card keeps the tile's in-place update contract — poll ticks mutate text nodes, never
rebuild the element — so hover and focus survive repaints.

### `style.css`

`.dash-tile-wide` (column span, stat grid) and the row label/value typography, following
`DESIGN.md`'s existing readout treatment.

## Error handling

| Condition | Result |
|---|---|
| Host unreachable / timeout | `state: 'down'`, red lamp, error text on the card |
| `POST /api/auth` rejects the password | `state: 'auth'`, violet lamp, `app password rejected` |
| Pi-hole requires TOTP | `state: 'auth'`, message naming the app password as the fix |
| No password stored on a `pihole` check | `state: 'auth'`, `no app password configured` |
| A data request fails after one re-auth | `state: 'auth'` for the tick; the next sweep retries |
| Malformed JSON / unexpected shape | `state: 'down'` with a parse error; never throws |
| Certificate rejected (verify mode) | `state: 'down'` with the TLS error; the insecure toggle is the documented remedy |

## Testing

TDD, real code and no mocks, per the repo convention. A local `http.createServer` fake
Pi-hole speaking the v6 envelope backs the server tests.

- `test/piholeApi.test.js` (new) — auth yields a sid; the sid is reused across calls;
  concurrent calls share one authentication; `401` triggers exactly one re-auth and one
  retry; `close()` issues `DELETE /api/auth`; timeout, malformed JSON and rejected-password
  shapes.
- `test/piholeRegistry.test.js` (new) — one client per service; a changed password or URL
  replaces the client and closes the old session; a removed service's client is closed;
  `closeAll()` closes everything.
- `test/servicesStore.test.js` — seal/redact round trip; PATCH without a password keeps the
  stored one; `null` clears it; a legacy record with no `secret` loads unchanged;
  `normalizeCheck` accepts and rejects the new fields correctly.
- `test/serviceCheck.test.js` — the `pihole` kind produces metrics; auth failure produces
  `state: 'auth'`.
- `test/serviceChecker.test.js` — a sweep containing a Pi-hole service populates metrics in
  the snapshot.
- `test/serviceRoutes.test.js` — the test route's success and failure paths;
  `GET /api/services` never leaks the sealed blob.
- `test/dashboard.test.js` — `piholeCardModel` number/uptime formatting, the update marker,
  the blocking-timer chip, and all three degraded states.
- `test/settingsServices.test.js` — `buildServicePayload` with the pihole kind, password
  omission versus explicit clear, and the insecure flag.

## Documentation

- `CLAUDE.md` / `AGENTS.md` — `piholeApi.js` and `piholeRegistry.js` in the architecture
  list; the `pihole` check kind in the services entry; `data/services.json` moved into the
  "can hold a secret" class in the self-contained-principle section.
- `README.md` — how to create a Pi-hole app password and add the tile.
- Security notes — the app password joins the sealed-secret class; the session id is
  memory-only and revoked on shutdown; TLS is verified by default with an explicit
  per-service opt-out.

## Out of scope

- Pi-hole v5 (`admin/api.php`).
- Any write action, including enable/disable blocking.
- A click-through detail panel with top domains, top clients, and a query-history
  sparkline. The card is the deliverable; the panel is a plausible follow-up.
- Multi-instance aggregation. Two Pi-holes are two records and two cards; no combined
  rollup module.
- Notifications or health events derived from Pi-hole metrics.
