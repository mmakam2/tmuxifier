# UniFi service integration — design

Date: 2026-07-28
Status: approved

## Summary

A service tile whose check kind is `unifi` stops being a liveness ping and becomes a
network readout. It authenticates against the UniFi Network **Integration API v1** with a
stored API key and renders, on the standby dashboard, a double-width card carrying a
six-cell client/WAN census above a per-device-class rollup — the gateway named with its own
load, switches and access points tallied — under a summary chip that reports WAN state and
the adopted-device online count.

The integration extends the existing service record rather than becoming a first-class
subsystem like Proxmox or NetBox, for the same reason the Pi-hole and TrueNAS integrations
did: a UniFi controller is already expressible as a tile — a name, a link, a group — and
the only thing missing is that its check returns numbers instead of a status line. Any
Tmuxifier user can add their own controller by pasting an API key into the service form; no
new settings tab, no new config knob, no host profile. It reuses `servicesStore.js`,
`serviceCheck.js`, `serviceChecker.js`, `serviceClientRegistry.js`, `tlsPin.js` and the
dashboard's tile pipeline.

Read-only. The integration never mutates the network.

## Decisions (from brainstorming)

- **A generic service-tile kind, not a first-class integration.** The alternative — a
  `data/unifi.json` host profile with its own settings tab and its own `GET /api/unifi/…`
  route, mirroring NetBox and Proxmox — was considered and rejected. It would have bought a
  native INFRASTRUCTURE group whose WAN and client tallies rendered as module rows
  alongside the Proxmox node rows, but at the cost of a subsystem that only serves one
  vendor's controller. The tile path is the shape that generalizes: whatever the user's
  controller is and wherever they file it, it is one record in `services.json` with a
  sealed credential, exactly like the two credential-bearing kinds that precede it.

- **Transport: the Network Integration API v1, not the legacy `/proxy/network/api/s/…`
  endpoints.** The legacy stats endpoints are richer per call — `stat/health` alone reports
  WAN status and per-subsystem health, and `stat/device` returns every device's
  `system-stats` in one request — and they do answer an API key on current UniFi OS
  firmware. They are also undocumented, unversioned, and have changed shape across
  releases. The integration API is the surface Ubiquiti documents and versions, it is
  reachable with the same key, and a live probe confirmed it answers device detail with
  `state: "ONLINE"` and populated `interfaces.ports[].speedMbps`. Shipping on the legacy
  surface would mean shipping a client with an unknown expiry date.

- **All three TLS modes: CA-verified, TOFU fingerprint pinning, and explicit insecure.**
  The Pi-hole and TrueNAS tiles offer only verified-with-an-insecure-opt-out, and copying
  that here would have been consistent. It was rejected because a UniFi controller serves a
  self-signed certificate by default, so in practice nearly every operator would tick the
  insecure box — and unlike a Pi-hole app password, a UniFi API key inherits its admin
  account's role and can therefore *write* to the network. Pinning (already implemented in
  `tlsPin.js` for Proxmox and NetBox) makes the common self-signed case safe: the settings
  form's Test button captures the fingerprint, the operator accepts it once, and every
  later request verifies against that pin on its own connection. The insecure mode remains
  available and explicit for operators who want it.

- **`https` is required for the tile URL.** Not because a plain-HTTP request destroys the
  credential the way it does on TrueNAS, but because the credential is write-capable and
  UniFi controllers always serve TLS — so an `http:` target is a misconfiguration with no
  legitimate case behind it. Validation reuses the existing `assertHttpsUrl` helper — which
  currently hardcodes a TrueNAS-specific rejection message ("TrueNAS permanently revokes any
  API key sent over plain HTTP") and must therefore take the reason as a parameter, so each
  kind explains its own refusal. That is the one pre-existing change this design makes to
  code it does not otherwise touch.

- **Display: a census grid plus a per-device-class rollup**, not one row per device. The
  richer alternative — every adopted device listed with its own lamp, CPU, memory and
  uptime — shows more, but the card's height then grows with the site, and a fifty-device
  network would dominate the section it sits in. The rollup keeps the card a fixed height
  at any site size while still naming the gateway (the one device whose individual load
  matters) and still surfacing failure by name: an offline device is named in an exception
  line rather than being reduced to a smaller tally.

- **The client owns a snapshot TTL.** The shared
  service sweep defaults to 30 seconds, which is comfortable, but `TMUXIFIER_SERVICE_POLL_MS`
  is configurable down to five — and the sweep interval is global, so it cannot be relaxed
  for this kind alone without introducing a per-kind cadence concept the sweep does not
  have. A full refresh is ten requests. Instead the client serves a cached snapshot until it ages past its own TTL (30s)
  and only then refetches, so the cost of a UniFi tile is bounded by the client regardless
  of how the operator tunes the sweep. This mirrors how `piholeApi.js` owns its session
  reuse rather than pushing that concern into the sweep.

- **Severity is derived on the client, from metrics.** The server's `ServiceResult.state`
  stays a reachability verdict (`up`/`down`/`auth`), unchanged for every existing check
  kind. Whether a controller with one offline access point reads as green or amber is a
  pure exported function over the metrics object — the same split the TrueNAS card uses,
  which keeps the wire contract stable and the threshold rules trivially testable.

- **Read-only.** No adoption, restart, port-override, firewall, or client-blocking method
  is ever called. The API key's blast radius stays at reads, and the card links to the
  controller's own web UI for anything actionable.

## Data model

`KINDS` in `servicesStore.js` gains `unifi`, and `SECRET_KINDS` gains it too, so the API
key seals on write (AES-256-GCM, key from `cookieSecret`) and every read redacts it to
`hasPassword`. The record:

```jsonc
{
  "id": "svc-…",
  "name": "UniFi",
  "url": "https://unifi.example.com",       // the link the tile opens; https enforced
  "section": "infrastructure",              // operator's choice, as with any tile
  "group": "Network",                       // free text, as with any tile
  "check": {
    "kind": "unifi",
    "target": "https://192.168.1.1",        // optional API base; empty = use `url`
    "site": "default",                      // optional internalReference; empty = first site
    "tls": "pin",                           // "verify" (default) | "pin" | "insecure"
    "fingerprint": "ab:cd:…"                // required iff tls === "pin"
  },
  "secret": "…"                             // sealed API key; never returned to the browser
}
```

Validation rules, all in `normalizeCheck`:

- `target`, when present, must parse and be `https`. When absent the tile's own `url` is
  used, which must therefore clear the same bar — the same coupling the `truenas` kind
  already enforces.
- `site` is optional, at most 64 characters, and matched against the controller's
  `internalReference`. Empty means "the first site the controller reports", which is
  correct for the single-site case that dominates.
- `tls` must be one of the three literals; anything else is rejected rather than coerced.
- `fingerprint` is required when `tls === 'pin'` and dropped otherwise, normalized through
  `tlsPin.js`'s `normFp`.
- Changing the kind away from `unifi` drops the sealed key, per the existing
  `SECRET_KINDS` rule.

## API surface used

Base: `https://<host>/proxy/network/integration/v1`. Every request carries `X-API-KEY:
<key>` and is a `GET`. The client exposes no method that issues any other verb.

| Request | Used for | Cadence |
|---|---|---|
| `/sites` | resolve the site id from `site`, or take the first | once per client, cached |
| `/sites/{siteId}/devices` | names, models, `state`, device classes | every refresh |
| `/sites/{siteId}/devices/{deviceId}/statistics/latest` | CPU, memory, uptime, uplink rates | every refresh, once per adopted device |
| `/sites/{siteId}/clients` | client census and per-AP attribution | every refresh, paginated |
| `/sites/{siteId}/networks` | the NETWORKS count | every refresh, if the firmware exposes it |

A refresh is therefore one devices call, one clients call (one page at `limit=200` for a
typical site), one networks call, and one statistics call per adopted device. On the
reference site — seven devices, ninety-six clients — that is ten requests per refresh, at
most once per 30 seconds.

### Unverified endpoints

Two of the five could not be confirmed from outside the implementation: `/statistics/latest`
and `/networks`. The direct probe was blocked by the sandbox, and the UniFi MCP server's own
response models mismatch the live payloads, so its errors confirmed field *shapes* but could
not enumerate available routes. **The first implementation task is a live field probe** that
either fills the dependent cells or marks them permanently unavailable. The card is designed
so this is a cost of one number each: see the degradation rule below.

## Server modules

- **`src/server/unifiApi.js`** — dependency-free client over `node:https`, in the mold of
  `netboxApi.js`. Responsibilities: build the request with the API key header and the
  TLS mode's socket (`pinnedSocket` for `pin`, `rejectUnauthorized: false` for `insecure`,
  the default agent for `verify`); resolve and cache the site id; fetch and assemble a
  snapshot; hold that snapshot until its TTL expires. Two public methods:
  - `probe()` — used by the settings Test button. Returns the served certificate's
    fingerprint and the controller's site list, so the form can both offer the fingerprint
    for acceptance and let the operator pick a site.
  - `snapshot()` — used by the sweep. Returns the cached metrics object, refreshing first
    if it has aged out.
- **`src/server/unifiRegistry.js`** — a thin wrapper over the existing
  `serviceClientRegistry.js`, matching `piholeRegistry.js` and `truenasRegistry.js`: one
  client per service id, rebuilt when the API base, key, site, TLS mode, or fingerprint
  changes, and closed when the service goes away. Because the registry fingerprints the
  whole options object, the new `site` and `tls` options participate automatically.
- **`src/server/serviceCheck.js`** — a `unifi` branch that calls `snapshot()` and returns
  `{ state, latencyMs, unifi: { … } }`, exactly as the `pihole` and `truenas` branches
  attach their own metric objects.
- **`src/server/server.js`** — `POST /api/services/unifi/test`, auth-gated, in the mold of
  the TrueNAS test route: takes an unsaved form payload, runs `probe()`, and returns the
  fingerprint and site list (never the key).

### Metrics object

```jsonc
{
  "clientsTotal": 96, "clientsWired": 61, "clientsWireless": 35,
  "networks": 16,                                  // null when unavailable
  "wanState": "up",                                // "up" | "down" | "unknown"
  "wanTxBps": 940000000, "wanRxBps": 45000000,     // null when unavailable
  "gateway":  { "name": "…", "cpuPct": 12, "memPct": 48, "uptimeSec": 353702 },
  "switches": { "online": 3, "total": 3, "cpuPct": 4 },
  "aps":      { "online": 3, "total": 3, "clients": 35 },
  "offline":  [ { "name": "…", "model": "…" } ]    // named exceptions, may be empty
}
```

Every field is independently nullable. A missing endpoint costs the cells it feeds and
nothing else — the card renders `—` in those cells and stays otherwise intact.

## Web modules

- **`src/web/unifiCard.ts`** — a new module beside `truenasCard.ts` rather than more weight
  in `dashboard.ts`, following the precedent set when the TrueNAS card was extracted. It
  exports the pure card model (stat cells, rollup rows, chip text, exception line), the
  pure `unifiLamp` severity function with its thresholds as named exported constants, and
  the in-place-updating `buildUnifiCard` DOM layer whose `update()` rewrites text nodes so
  a sweep never disturbs hover or selection.
- **`src/web/dashboard.ts`** — `paintTile` gains a third card branch and `repaint` a third
  retirement pass, alongside the existing `cardEls` and `truenasEls` maps.
- **`src/web/settingsServices.ts`** — the `unifi` kind's fields: API base, site, API key,
  a TLS mode radio, and a Test button. In `pin` mode the Test result shows the served
  fingerprint for explicit acceptance; the site field becomes a picker once a probe
  succeeds, and stays free text before that.
- **`src/web/api.ts`** — the `UnifiMetrics` type on `ServiceCheckResult`.

## Card layout

```
┌────────────────────────────────────────────────┐
│ ● UniFi                    wan up · 7/7 online │
│   CLIENTS   96        WIRED      61            │
│   WIRELESS  35        NETWORKS   16            │
│   WAN  940/45 Mbps    UPTIME     4d            │
│   ──────────────────────────────────────────   │
│   GATEWAY   <name> · cpu 12% · mem 48%         │
│   SWITCHES  3/3 online · cpu 4%                │
│   APS       3/3 online · 35 clients            │
└────────────────────────────────────────────────┘
```

Degraded, with the exception named rather than merely counted:

```
┌────────────────────────────────────────────────┐
│ ● UniFi                    wan up · 6/7 online │
│   ⚠ <ap name> offline                          │
│   CLIENTS   89        WIRED      61            │
│   …                                            │
└────────────────────────────────────────────────┘
```

Numbers use the shared formatters in `fmt.ts` — `fmtCount`, `fmtCompact`, `fmtUptime`, and
`fmtBytes` for the WAN rates.

## States and error handling

| Condition | State | Rendering |
|---|---|---|
| Reachable, authenticated | `up` | green lamp, metrics |
| `401`/`403` — key rotated or revoked | `auth` | violet `.dot.auth` lamp, "authentication failed" |
| Connection refused, timeout, DNS failure | `down` | red lamp, the error text |
| TLS verification failure (`verify` mode) | `down` | red lamp, the TLS error |
| Fingerprint mismatch (`pin` mode) | `down` | red lamp, an explicit mismatch message — never silently accepted, and never auto-repinned |
| Never swept yet | `unknown` | dim lamp |
| Reachable, one device offline | `up` | green or amber per `unifiLamp`, exception line naming the device |

A rotated key reads as `auth`, not as an outage — the same distinction the Pi-hole card
draws, and for the same reason: an operator who rotated a credential should see that, not a
false outage. A dead access point likewise does not make the controller dead; the tile stays
`up` and the severity function decides the lamp colour.

## Testing

Real code, no mocks, per the repo's TDD convention.

- `test/helpers/fakeUnifi.js` — an HTTPS fixture controller in the mold of
  `test/helpers/fakePihole.js`, serving canned integration-API payloads, able to return
  `401`, to omit the optional endpoints, and to present a known self-signed certificate so
  the three TLS modes are exercisable.
- `test/servicesStore.test.js` — the `unifi` record's validation: https enforcement, TLS
  mode literals, fingerprint required in `pin` mode, key sealed and redacted, key dropped
  on kind change.
- `test/unifiApi.test.js` — site resolution and its caching, snapshot assembly, TTL
  behaviour (a second call inside the window issues no requests), `auth` versus `down`
  classification, graceful degradation when the optional endpoints 404.
- `test/unifiRegistry.test.js` — client rebuilt on option change, retained otherwise,
  closed on removal.
- `test/unifiCard.test.js` — the pure model: cell values, rollup arithmetic, exception
  line, lamp thresholds, and the all-null degraded case.
- `test/serviceRoutes.test.js` — the test route returns a fingerprint and site list and
  never echoes the key.

## Documentation

`CLAUDE.md`, `AGENTS.md` and `README.md` gain the `unifi` kind alongside `pihole` and
`truenas`, including the security note below. The card and its module get one line each in
the architecture list.

## Security notes

- The API key is the third credential class stored in `data/services.json`: sealed with
  AES-256-GCM under a key derived from `cookieSecret`, written `0o600`, redacted to
  `hasPassword` on every read, and never returned to the browser.
- **UniFi local API keys inherit their admin account's role — there is no read-only key
  scope on the local API.** The documentation will therefore recommend creating the key
  under a **View Only** admin account. Independently, the client is read-only by
  construction: it exposes no method that issues anything but `GET`.
- TLS is verified by default. The `pin` mode verifies the pinned fingerprint on each
  request's own connection rather than rebuilding a CA store, which is what lets a
  controller's self-signed chain work without trusting an unverified connection. The
  `insecure` mode is explicit, per-tile, and off by default.
- A fingerprint mismatch is a hard failure. Tmuxifier never re-pins automatically on
  mismatch — the operator must re-run the Test and accept the new fingerprint, the same
  posture the repo takes toward a changed SSH host key.

## Out of scope

- **Fleet cross-linking.** Matching Tmuxifier boxes to their UniFi client record by IP, to
  show each box's VLAN, switch port, or wireless signal in its fleet row, was considered
  and deliberately deferred. It is a genuinely different feature — it changes the fleet
  rows, not the services section — and it is well worth revisiting once this lands.
- **ISP and internet-health metrics** (WAN latency, packet loss, speedtest history, uptime
  percentage). These live behind Ubiquiti's cloud Site Manager API, not the local
  integration API, and would require a second credential and a call out to `api.ui.com`.
  The local WAN readout is limited to link state and uplink throughput.
- **Per-WAN detail on a dual-WAN gateway.** The local integration API does not clearly
  distinguish WAN1 from WAN2 for throughput; the card reports the gateway's uplink in
  aggregate. Failover visibility would need the legacy `stat/health` endpoint.
- **Any write action** — restart, adopt, block a client, toggle a rule. Out of scope
  permanently, not merely for this iteration.
