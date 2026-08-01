# Standby dashboard

The dashboard that fills the stage when no terminal is docked: service tiles, fleet overview,
infrastructure readout, and the credentialed tile integrations. Part of the
[Tmuxifier docs](../README.md).

When no terminal is docked, the stage shows a standby dashboard instead of a blank screen:

- **Service tiles** — your homelab's web services (Grafana, a NAS UI, anything with a URL),
  managed under Settings (⚙) → Services. Each tile is a name, an automatically resolved logo, a
  parent section (Services or Infrastructure) with an optional category within it (e.g.
  Services → DNS Filtering; under Infrastructure, the categories "Proxmox" and "IPAM" merge
  the tile into those built-in groups), a link that opens in a new tab, and an optional
  liveness check — an HTTP(S) GET
  (2xx/3xx = up) or a bare TCP connect for non-web services (DNS, MQTT, …). Checks run
  **server-side** on one shared sweep (`TMUXIFIER_SERVICE_POLL_MS`, default 30s, min 5s) and
  the dashboard reads a cached snapshot, so check volume doesn't scale with open tabs. HTTPS
  checks tolerate self-signed certificates — they answer "is it up", not "is it authentic".
  Tiles persist in `data/services.json`; the secrets it can hold — a Pi-hole app password, a
  TrueNAS API key, a UniFi API key, an Immich API key — are all encrypted (see below).
- **Fleet overview** — one card per box: status lamp, agent working/waiting chip, and a two-line
  spec sheet — what the box *is* (distro and core count) over what it *has* (RAM, and disk used
  of total). Deliberately not the live cpu/mem/disk percentages: the sidebar rows beside these
  cards already carry those, and repeating a gauge told you nothing. Clicking a card opens that
  box's terminal.
- **Infrastructure readout** — a Proxmox group showing each physical cluster node's health
  (online lamp, cpu/mem/disk, linked-container tally) and, when NetBox is configured, an
  IPAM group with utilization for each IPv4 prefix NetBox knows (first 100).

On a fresh install (no boxes, no services) the dashboard collapses to the original standby
prompt with the `+ Add box` hint.

The tmuxifier nameplate in the sidebar's top-left is the home key: clicking it returns to the
dashboard. Docked terminals undock but keep running — clicking a box re-docks it.

## Tile icons

Tiles find their own logos. A tile's icon is resolved from its check kind first (a UniFi,
TrueNAS, Pi-hole or Immich check identifies the software outright), then from the service name, then
from the first label of its URL — so a service called "Grafana", or one living at
`https://grafana.example.com/`, gets the Grafana logo without being told.

```bash
npm run fetch-icons   # one-time; downloads the logo catalog into vendor/icons/
```

The catalog is a pinned list of common self-hosted apps, fetched once. **The running server
never contacts the internet for icons** — it reads the directory this leaves behind. Skipping
the command costs the catalog, not the feature: anything unmatched falls back to a favicon
scraped from the service's own URL, which is LAN traffic to a host you already configured.

Settings → Services can override the guess per tile — **Auto**, **Choose** (a filterable grid
of the catalog), or **None** to suppress the icon — and **Refresh icon** re-scrapes the
service's favicon on demand.

## Pi-hole tiles

A service tile whose check is **Pi-hole** reads the Pi-hole v6 API and renders a double-width
card with blocking status, queries today, blocked share, active/total clients, gravity domain
count, version, and uptime instead of a plain up/down lamp.

1. On the Pi-hole, go to **Settings → Web interface / API → Configure app password** and create
   an app password. (The web login password also authenticates, but an app password is scoped to
   the API and keeps working when two-factor authentication is enabled.)
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **Pi-hole**
   check, and paste the app password. Leave the API base URL blank unless the API lives somewhere
   other than the tile's link URL.
3. Press **Test connection** to confirm the credential before saving.

The password is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never
sent back to the browser. Unlike the plain HTTP/TCP checks, TLS is **verified** — tick "Allow a
self-signed certificate" if your Pi-hole serves one. The integration is read-only: it never
enables or disables blocking. Pi-hole v5 (`admin/api.php`) is not supported.

## TrueNAS tiles

A service tile whose check is **TrueNAS** reads your NAS over its JSON-RPC WebSocket API and
renders a double-width card with one row per ZFS pool — name, used percentage, free space —
under a chip showing the worst pool health and the active alerts by severity (`healthy ·
1 critical, 2 warnings`), with the TrueNAS version and host uptime beneath. The chip names the
severity rather than giving a bare total, so it explains the lamp colour rather than leaving you
to guess which reading caused it.

The lamp is a glance signal, not just a reachability light:

| Lamp | Meaning |
|---|---|
| green | every pool online and healthy, no active alert, every pool under 80% used |
| amber | a pool is degraded, a warning-level alert is outstanding, or a pool has passed 80% |
| red | unreachable, a pool is faulted, an error-level alert is outstanding, or a pool has passed 90% |
| violet | the API key was rejected, has expired, or the account requires a one-time password |

Onboarding needs three things — the NAS URL, the username the API key belongs to, and the key:

1. On the TrueNAS, go to **Credentials → Users → API Keys** and create a user-linked key with the
   **READONLY_ADMIN** role. Note which account it belongs to; the login call needs the username
   alongside the key.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **TrueNAS**
   check, and fill in the username and key. Leave the API base URL blank unless the API lives
   somewhere other than the tile's link URL.
3. Press **Test connection** to confirm the credential before saving.

The URL must be `https://`. TrueNAS **permanently revokes** any user-linked API key presented
over plain HTTP, so Tmuxifier refuses an `http://` TrueNAS URL outright rather than risk your
credential — this is not something you can opt out of. A self-signed certificate is fine: tick
"Allow a self-signed certificate". The key is encrypted at rest (AES-256-GCM, key derived from
the cookie secret) and is never sent back to the browser.

Requires TrueNAS 25.04 or later, which is where the JSON-RPC WebSocket API replaced the REST API
(removed outright in TrueNAS 26). The integration is read-only and never changes anything on the
NAS — not even dismissing an alert.

## UniFi tiles

A service tile whose check is **UniFi** reads your controller's Network Integration API and
renders a double-width card: a six-cell census (clients, wired, wireless, networks, WAN
throughput, gateway uptime) over one row per device class — the gateway named with its own CPU
and memory, switches and access points tallied. The chip summarises WAN state and how many
adopted devices are online; a device that goes offline is **named** on its own line rather than
being reduced to a smaller count.

1. In the UniFi Network application, go to **Control Plane → Integrations** and create an API
   key. A UniFi local API key inherits the role of the admin account that created it, and the
   local API has **no read-only key scope**, so create it under a **View Only** admin. Tmuxifier's
   client only ever issues `GET` — it can adopt nothing, restart nothing, and change no rule —
   but the key itself is only as limited as the account behind it.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **UniFi**
   check, and paste the key. Leave **Site** blank unless your controller hosts more than one.
3. Press **Test connection**. It confirms the key, lists the sites it can see, and — in pin mode
   — captures the certificate fingerprint for you.

The URL must be `https://`; an `http://` controller URL is refused, because the key can write to
your network. Because a controller serves a self-signed certificate by default, this tile offers
three TLS choices rather than the single "allow a self-signed certificate" checkbox the other
tiles use:

- **Verify certificate** — the default. Right if your controller presents a CA-trusted cert.
- **Pin this certificate** — trust on first use, like `ssh accept-new`. Test connection captures
  the fingerprint, you save it, and every later request checks it on its own connection. This is
  the recommended setting for a default self-signed controller: it works without ever trusting an
  unverified connection, and a swapped certificate fails loudly instead of silently. Tmuxifier
  never re-pins by itself — if the fingerprint changes you must Test and accept the new one.
- **Accept any certificate** — no verification at all. Available, explicit, and off by default.

The key is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never sent
back to the browser. Requires UniFi Network 9.0 or later, where the Integration API landed.

## Immich tiles

A service tile whose check is **Immich** reads your photo server's REST API and renders a
double-width card: photos, videos, library size, disk used, disk free and server version across
six cells, with rows for the job queues, the user census, and an available update when there is
one. The chip reports library size and job state.

1. In Immich, go to **Account Settings → API Keys** and create a key. Immich supports granular
   permissions, so grant only what the card reads: `server.about`, `server.storage`,
   `server.statistics`, `server.versionCheck`, `job.read` and `systemConfig.read`.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **Immich**
   check, and paste the key. Leave the probe URL blank to reuse the tile's own link.
3. Press **Test connection**. It confirms the key and names any permission it could not use.

`server.statistics` and `job.read` are admin-scoped. A key without them still produces a working
tile — the library and job readings are dropped and the card says which permission is missing,
rather than the tile going red. A wrong or revoked key is different: that shows the violet
"needs auth" lamp, the same as the other credentialed tiles.

Plain `http://` is allowed here, unlike the TrueNAS and UniFi tiles. Neither of their reasons for
refusing it applies: an Immich key is not revoked by being sent in the clear, and it can be scoped
read-only, while the usual self-hosted Immich sits on a LAN at `http://host:2283`. Over `https://`
the certificate is verified by default, with the same "allow a self-signed certificate" checkbox
the Pi-hole tile uses.

The key is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never sent
back to the browser. The integration is read-only and issues no HTTP verb but `GET`. Requires
Immich v1.118 or later, where the API moved to `/api/server/*`.
