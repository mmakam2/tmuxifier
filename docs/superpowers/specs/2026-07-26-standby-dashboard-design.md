# Standby Dashboard — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorm complete)

## Goal

Replace the empty-stage standby screen (the `~ $` breathing-cursor panel) with a
homepage.dev-style dashboard: status tiles for the operator's homelab web services, an
at-a-glance fleet overview, and a Proxmox/NetBox infrastructure readout — all rendered in
the Bench Instrument visual language. The dashboard shows whenever no terminal pane is
docked and yields the moment one opens.

## Decisions (from brainstorm)

- **Content:** service tiles (new entity) + fleet overview + Proxmox/NetBox summary.
- **Placement:** standby-screen replacement only. Not a dockable pane, not a hub overlay.
- **Service management:** UI CRUD (Settings → Services tab), persisted to gitignored
  `data/services.json`. No hand-edited config format.
- **Checks:** server-side HTTP(S) GET or bare TCP connect, per service. No ICMP ping.
- **Icons:** optional Nerd Font glyph per tile (bundled font, One Legend Face rule). No
  vendored image pack, no CDN.
- **Health depth:** current state only. No persisted history, no sparklines for services,
  no health-events integration, no notifications. (Boxes keep their existing sparklines —
  that data already exists.)

## Non-goals

- Service latency history, service up/down events, browser notifications for services.
- ICMP ping checks.
- Dashboard as a dockable stage pane.
- homepage.dev-style deep per-app API widgets.
- Image/logo icon packs.
- Service-list import/export (the boxes-style versioned JSON file).

## Data model

`data/services.json` (gitignored, runtime-created via the UI like `boxes.json`, written
`0o600` through `jsonFile.js` atomic writes):

```json
{
  "version": 1,
  "services": [
    {
      "id": "svc-a1b2c3",
      "name": "Grafana",
      "url": "https://192.168.1.20:3000/",
      "glyph": "󰗃",
      "group": "Monitoring",
      "check": { "kind": "http" }
    }
  ]
}
```

Field rules (validated/normalized in `servicesStore.js`, mirroring `store.js`):

- `id` — server-minted, `svc-` + random suffix. Import/export is a non-goal for v1.
- `name` — required, trimmed, 1–64 chars.
- `url` — required; must parse via `new URL` with protocol `http:` or `https:`. This is
  both the click-through link and the default HTTP check target.
- `glyph` — optional, trimmed, max 4 UTF-16 code units (covers surrogate-pair Nerd Font
  private-use glyphs). Rendered in a fixed-width cell from the bundled font.
- `group` — optional, trimmed, 1–32 chars. Groups display in order of first appearance;
  tiles in stored order within a group. Ungrouped tiles render first, under no legend.
- `check.kind` — `http` (default) | `tcp` | `none`.
  - `http`: optional `check.target` URL (http/https) overrides `url` as the probe address
    (e.g. link via hostname, probe via IP).
  - `tcp`: required `check.target` of the form `host:port` — host validated with the same
    allowlist regex family as box hosts (hostname or IP), port 1–65535.
  - `none`: link-only tile; no lamp, never probed. `check.target` must be absent.

## Server

### `serviceCheck.js` — pure check engine (dependency-free)

- **HTTP:** GET with a 5-second overall timeout (connect + response headers). Redirects
  are not followed; up = status 2xx or 3xx. Latency = ms to response headers; the body is
  discarded/aborted. TLS certificate errors are tolerated (`rejectUnauthorized: false`) —
  this is a liveness probe, not a security boundary, and it shares no code or trust
  decisions with the token-bearing Proxmox/NetBox clients, which keep their pinning.
- **TCP:** `net.connect` with a 5-second timeout. Up on successful connect; latency =
  connect time; socket destroyed immediately.
- Every failure mode (DNS, refused, timeout, handshake failure other than cert validity)
  resolves to `down` with a short reason string. A check never throws.

### `serviceChecker.js` — interval poller (models `statusPoller.js`)

- One server-side loop on `TMUXIFIER_SERVICE_POLL_MS` (default 30000, clamped to ≥5000).
- Fan-out bounded by `mapWithConcurrency` (limit 8).
- Results cached in memory as a snapshot:
  `{ checkedAt: ISO-string | null, results: { [id]: { state: 'up'|'down', latencyMs?, error? } } }`.
- A service absent from `results` (added since the last sweep, or `check: none`) reads as
  `unknown`/unprobed. Zero services = a no-op sweep. Nothing is persisted.

### Routes (all auth-gated like the rest of `/api`)

- `GET /api/services` — list definitions.
- `POST /api/services` — create; validation errors are 400 with field messages.
- `PATCH /api/services/:id` — partial update: provided fields are merged onto the stored
  service and the result re-validated as a whole; unknown id 404.
- `DELETE /api/services/:id` — remove.
- `GET /api/services/status` — the cached snapshot only; a dashboard poll never triggers
  checks.
- `GET /api/netbox/summary` — new small route: `{ configured: false }` when NetBox is not
  set up; otherwise `{ configured: true, ok, prefix, used, total }` for the configured
  provisioning prefix, computed server-side with a ~60-second in-memory cache,
  best-effort (`ok: false` + `error` on failure). The Proxmox side of the readout needs
  no new route — the client uses the existing linked-LXC inventory endpoint.

### Config

- `TMUXIFIER_SERVICE_POLL_MS` added to `config.js` (pure/injectable as ever) and
  `.env.example`.

## Client

### `dashboard.ts` — the standby dashboard

Factory `createDashboard(deps)` returning `{ el, update(data), destroy() }`. `main.ts`
keeps one instance and mounts it where `emptyStagePanel()` renders today (pane count = 0).
Poll ticks call `update()`, which mutates DOM in place — the same "the poll never rebuilds
whole rows" contract the sidebar follows, so hover states survive and nothing flickers.
(The existing `renderDashboard()` in `main.ts` renders the whole app shell; the new module
avoids that name.)

**Visual framing.** The stage remains the screen bay; the dashboard is what the display
shows in standby — *content on the recessed screen-well glass*. Flat readout typography,
LED lamp dots, engraved group legends; no extruded keycaps on the glass. Hover on
interactive cells brightens the legend and lights the cell border amber, per DESIGN.md's
existing interaction rules. Layout, top to bottom:

1. **Standby header** — the `~ $` prompt with breathing amber cursor, shrunk to a
   masthead (aria-hidden; reduced motion holds it solid). The signature is promoted, not
   deleted.
2. **Fleet strip** — one module per box: status lamp, name, agent chip (working/waiting
   from `/api/health/series`), session count, the existing amber sparkline. Click opens
   that box's terminal (the dashboard yields).
3. **Services grid** — grouped under engraved legends; each tile: glyph, name, lamp
   (green up / red down / dark ring unknown / no lamp for `check: none`), latency in
   readout type (e.g. `12ms`). Click opens `url` in a new tab with `noopener`. Down tiles
   carry the error string as a `title` tooltip.
4. **Infra readout strip** — one module per Proxmox host profile (lamp, name,
   `N running / M stopped` from the inventory endpoint) and a NetBox module (lamp +
   prefix utilization, e.g. `192.168.50.0/24 · 12/254`). Each module hidden when its
   integration isn't configured.

**Data flow.** Fleet data rides the polls `main.ts` already runs (`/api/status`,
`/api/health/series`) — the dashboard is another consumer; no new fleet traffic. New
polls run **only while the dashboard is mounted**:

- `GET /api/services` + `GET /api/services/status` every 10 seconds (both small; the list
  fetch keeps external edits and settings changes visible without a refresh event).
- `GET /api/netbox/summary` and the Proxmox inventory every 60 seconds, best-effort.

Fetch helpers live beside their siblings: services in `api.ts`, summary in `netbox.ts`,
inventory via the existing `proxmox.ts` layer.

**Degenerate states.** No boxes and no services (fresh install): the dashboard collapses
to essentially today's standby screen — large prompt, `No terminal attached`, the
`+ Add box` keycap hint — so the old signature remains the floor. Boxes but no services:
fleet strip plus an `+ add service` hint in the services section, which opens Settings
directly to the Services tab.

### `settingsServices.ts` — Settings → Services tab

Registered in `settingsUi.ts`'s `SECTIONS` after Boxes. Master-detail like the Proxmox
presets tab, scaled down: list (lamp + name + group) and an add/edit form — name, URL,
glyph, group, check-kind radio, conditional `check.target` field. Delete is confirm-gated
via the shared modal (`modalRegistry` teardown applies). The glyph field is free-form
text plus a small curated row of common Nerd Font glyphs to click (server, database,
docker, media, router, …) — a starter palette, not a full picker.

### DESIGN.md

DESIGN.md is the visual authority and currently canonizes the empty stage as the standby
prompt signature. The same change must rewrite that signature entry to describe the
standby dashboard (prompt masthead + readout content on glass), or doc and product fork.

## Error handling

- **Store:** corrupt `data/services.json` follows the `jsonFile.js` contract —
  quarantined to `.corrupt-<timestamp>`, read as empty. Nothing else depends on it, so
  failing open costs a re-add, not access.
- **Checks:** per-service failures are `down` results, never exceptions; one bad service
  cannot poison the sweep or the snapshot.
- **Client:** a failed `/api/services/status` poll keeps the last painted state and dims
  the section header to mark it stale; it never blanks the grid. NetBox summary
  unreachable: module lamp red, figures `—`. Proxmox inventory unreachable: that host's
  module lamp red, counts `—`.

## Security notes

- Check URLs are operator-supplied and fetched by the server. In a single-operator app
  that already holds SSH access to the whole fleet this is not an escalation, but the
  expressible actions are bounded: scheme restricted to http/https, TCP host restricted
  to the box-host regex, so nothing beyond a GET or a TCP connect can be encoded.
- `rejectUnauthorized: false` applies only to liveness probes; the Proxmox/NetBox API
  clients keep their fingerprint-pinning/CA verification unchanged.
- All new routes sit behind the existing auth gate. `data/services.json` holds no
  secrets but is written `0o600` like its siblings.

## Testing (TDD, real code, no mocks)

- `test/servicesStore.test.js` — normalization, validation (URL scheme, tcp target
  regex, glyph length, group rules), CRUD, corrupt-file quarantine.
- `test/serviceCheck.test.js` — HTTP against a local `http.createServer`
  (2xx/3xx/5xx/timeout), TCP against a local `net.createServer`, self-signed HTTPS via a
  throwaway cert.
- `test/serviceChecker.test.js` — sweep populates the snapshot, unknown-before-first-
  sweep, bounded concurrency, zero-services no-op.
- `test/serviceRoutes.test.js` — CRUD + status + netbox-summary routes through
  `buildServer` with auth, like `netboxRoutes.test.js`.
- Client pure parts unit-tested where logic exists (group ordering, latency formatting,
  degenerate-state selection); DOM composition validated on the live app per the
  standing validate-before-ship workflow.
- `npm run test:e2e` smoke: dashboard renders on login with no boxes (degenerate state);
  existing flows still pass.

## Docs touches

- `data/services.json` added to the self-contained file list in CLAUDE.md/AGENTS.md and
  README (runtime-created via UI; placeholder-counterpart rule satisfied the same way as
  `boxes.json`).
- `TMUXIFIER_SERVICE_POLL_MS` documented in `.env.example` and README.
- DESIGN.md signature rewrite (above).

## Shipping

Standard workflow: feature branch/worktree, validate on the live app before merge
(candidate `dist/` rsync + service restart, gated on no running jobs), then the release
checklist from CLAUDE.md.
