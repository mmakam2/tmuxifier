# Proxmox LXC Provisioning Design (Phase 1)

## Summary

Today Tmuxifier can only manage boxes that already exist — you add an SSH target by hand. This
feature lets Tmuxifier **create the box for you**: provision a "canned" LXC container on a Proxmox
VE host and, on success, auto-add a Tmuxifier box pointed at it so you get a browser terminal
immediately.

The flow has four moving parts the user manages, then one action:

1. **Proxmox host profiles** — endpoint + API token for one or more PVE hosts.
2. **SSH management keys** — *public* keys to inject into new containers (the private half stays in
   the user's existing SSH setup, per Tmuxifier's "stores no SSH secrets" stance).
3. **Container presets** — reusable "canned" blueprints (template, CPU/mem/disk, storage, network,
   features, which mgmt key(s) to inject).
4. **Provision** — pick a preset, type a hostname; Tmuxifier creates + starts the LXC, streaming
   the Proxmox task log live, then auto-adds a box.

Tmuxifier talks to PVE over its **HTTP API** (`https://host:8006/api2/json`) authenticated with an
**API token** (`PVEAPIToken=user@realm!id=secret`). This is the standard automation surface and
lets the UI browse nodes/templates/bridges/storage live. The token is the first credential
Tmuxifier persists; it is **encrypted at rest** (AES-256-GCM, key derived from the existing cookie
secret) inside the gitignored `data/proxmox.json`, and never sent to the browser.

A provision is modeled as a **job** held server-side and polled by the browser — the same resilient
pattern as Fleet Command: the job outlives tab closes, survives a Tmuxifier restart as history, and
streams the PVE task log as it runs.

### Phasing

This is **Phase 1 of 3**. Phase 1 builds the reusable foundation (host profiles, the PVE API
client, browse primitives, presets, mgmt keys) and the provision-with-auto-box loop. Deferred:

- **Phase 2 — container lifecycle:** list existing containers per node; start / shutdown / stop /
  reboot / **destroy**; cross-link with boxes.
- **Phase 3 — template & network management:** browse/**download** templates (`pveam`); promote
  **network profiles** to first-class reusable entities referenced by presets.

Phases 2–3 reuse the Phase 1 API client and host-profile/secret machinery unchanged.

## Behavior

A new **Proxmox** button in the sidebar header (near the existing add-box / Fleet controls) opens
the **Proxmox hub**, a modal with five tabs:

- **Hosts** — list/add/edit/remove PVE host profiles. Adding a host prompts for a name, endpoint
  (`host:port`, defaults to `:8006`), token id, and token secret. On submit Tmuxifier **inspects
  the endpoint's TLS certificate**, shows its SHA-256 fingerprint and whether it validates against
  system CAs, and pins it; it then verifies the token by calling `/version`. A **Test** button
  re-runs the reachability/auth check. The token secret is write-only — once saved it is shown as
  `••• set` and can only be replaced, never read back.
- **SSH Keys** — list/add/remove named management public keys. Add = name + paste a public key
  (`ssh-ed25519 …` / `ssh-rsa …`); validated as a single public-key line.
- **Presets** — list/add/edit/remove canned blueprints. The preset editor's dropdowns
  (node, template, rootfs storage, bridge) are **populated live from the selected host's API**;
  numeric fields (cores, memory, swap, disk) and toggles (unprivileged, nesting, start-on-boot)
  have sensible defaults. A preset must reference **at least one** mgmt key.
- **Provision** — pick a preset, then a small form: **hostname** (required), **vmid**
  (auto-allocated from `/cluster/nextid`, overridable), and — when the preset uses a static IP —
  the **IP/CIDR + gateway** (prefilled from the preset, overridable). Submitting opens the job
  panel.
- **History** — recent provision jobs (preset, hostname, vmid, status, time). Selecting one shows
  its full live log and, when finished, a link to the created box.

The **job panel** renders the provision's **phase** (`allocate → create → start → discover →
link → done`), a live **task-log** view, and a final result. While `running` it polls
`GET /api/proxmox/provisions/:id` every **1.5 s**; polling stops when finished. On success it shows
the new box and an **Open terminal** button (which opens the box exactly like clicking it in the
sidebar). On failure it shows the error and, when the container was already created, the **vmid**
for manual cleanup (destroy lands in Phase 2).

## Architecture

Factory functions with injected dependencies, matching the existing server modules. Five new server
modules; everything testable without mocks via injected fakes.

### Secret encryption — `src/server/secretBox.js`

```
createSecretBox(cookieSecret) -> { seal(plaintext) -> string, open(sealed) -> string, isSealed(v) -> boolean }
```

- Derives a 32-byte key from the already-required `cookieSecret` via
  `hkdfSync('sha256', cookieSecret, salt='', info='tmuxifier-pve-token-v1', 32)`. A distinct `info`
  label means this key can never collide with cookie signing.
- `seal` encrypts with **AES-256-GCM** and a fresh random 12-byte IV, returning
  `pvebox.v1:<iv_b64>:<ct_b64>:<tag_b64>`. `open` reverses it and **authenticates** (GCM tag), so a
  tampered or wrong-key value throws rather than returning garbage. `isSealed` tests the scheme
  prefix so the store can migrate/recognise values.
- Pure and injectable: the key material is the only input, passed by the caller (the wiring derives
  it from `config.cookieSecret`). Tests construct it with a fixed secret and round-trip.

**Threat model (documented honestly):** because the server must auto-decrypt the token to call the
PVE API non-interactively, the key necessarily lives next to the data (in `.env`). Encryption-at-
rest therefore protects against the **`data/proxmox.json` file leaking on its own** — a backup, an
errant `cat`, a screen-share, an exported copy — and keeps tokens out of plaintext at rest. It does
**not** defend against an attacker who already holds both `.env` and `data/` (they have everything).
This is the same posture as the existing scrypt hash / cookie secret sitting in a `0o600` `.env`.

### Profile/key/preset store — `src/server/proxmoxStore.js`

```
createProxmoxStore({ dataDir, secretBox }) -> {
  listHosts, getHost, addHost, updateHost, removeHost,         // getHost(id, { withSecret }) for server-side use
  listKeys, addKey, removeKey,
  listPresets, getPreset, addPreset, updatePreset, removePreset,
}
```

- Reads/writes one gitignored **`data/proxmox.json`** (`0o600`), mirroring `store.js`'s
  read-modify-write. `mkdir(dataDir, { recursive: true })` on write; `{ version: 1, hosts: [],
  keys: [], presets: [] }` when absent.
- **Hosts:** `addHost`/`updateHost` `seal` the token secret via `secretBox` before writing. Two
  read shapes: the default **redacted** host (`tokenSecret` replaced with `hasToken: true`) for
  anything that reaches a route handler / the browser, and an internal `getHost(id, { withSecret:
  true })` that `open`s the secret for the API client. The redacted shape is the only one the REST
  layer ever returns.
- **Keys / presets** hold no secrets. `addKey` validates the public key as a single key line.
  `addPreset`/`updatePreset` validate the blueprint (see Provisioning, §Validation) and that every
  `keyId` / `hostId` resolves.
- Name uniqueness is enforced per collection (host name, key name, preset name), case-insensitively,
  matching `store.js`'s `assertUnique` approach.

### PVE API client — `src/server/proxmoxApi.js`

```
createProxmoxClient({ host /* unsealed: {endpoint, tokenId, tokenSecret, fingerprint256, verifyMode} */,
                      request = httpsRequest, timeoutMs = 15000 }) -> {
  version, nodes, storages, templates, bridges, nextId,
  createLxc, taskStatus, taskLog, startLxc, lxcInterfaces,
}
inspectEndpoint(endpoint, { request }) -> { fingerprint256, subject, issuer, validTo, caValid, reachable, error }
```

- Built over **`node:https`** (not `fetch`) so we get precise TLS control and can read the peer
  certificate to capture/verify fingerprints. `request` (the low-level `https.request` wrapper) is
  injected so tests drive the client with a fake transport — no network, no mocks.
- **Base URL** = `https://<endpoint>/api2/json`. **Auth** header on every call:
  `Authorization: PVEAPIToken=<tokenId>=<tokenSecret>`. POST bodies are
  `application/x-www-form-urlencoded` (the PVE API's native encoding).
- **TLS** (per `verifyMode`): `ca` → `rejectUnauthorized: true` (cert chains to a system root —
  e.g. a Let's Encrypt cert on the PVE host); `pin` → `rejectUnauthorized: false` plus a
  `checkServerIdentity` that compares the peer `fingerprint256` to the stored one (self-signed,
  SSH-`known_hosts` style); `insecure` → `rejectUnauthorized: false` with no pin (opt-in, see
  Security).
- **Methods** map directly to PVE endpoints (see §PVE API specifics). Each returns the parsed
  `data` payload or throws a mapped error (`401 → "token rejected"`, `403 → "token lacks permission
  (needs e.g. VM.Allocate / Datastore.AllocateSpace)"`, cert-mismatch → "TLS fingerprint changed",
  ECONNREFUSED/ETIMEDOUT → reachability message).
- `inspectEndpoint` is a standalone helper (not token-authed) used by add-host: it opens a TLS
  connection, returns the peer cert's `fingerprint256` / subject / issuer / `validTo`, whether the
  cert validates against system CAs (`caValid`), and reachability. The add-host route uses it to set
  `verifyMode` (`ca` when `caValid`, else `pin`) and store the fingerprint.

### Provision manager — `src/server/proxmoxProvision.js`

```
createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save, now, makeId,
  pollMs = 1500, taskTimeoutMs = 600000, leaseTimeoutMs = 60000, maxJobs = 50, maxLogBytes = 65536,
}) -> { createProvision, getProvision, listProvisions, cancelProvision }
```

- `makeClient(host)` builds a `createProxmoxClient` from a **secret-bearing** host
  (`proxmoxStore.getHost(id, { withSecret: true })`), injected so tests pass a fake client.
  `boxStore` is the existing `store.js` (we call `addBox`). `now`/`makeId` are injected for
  deterministic tests (the repo's stores already inject these seams via defaults).
- **`createProvision({ presetId, hostname, vmid?, ip? })`** — resolves preset + host + keys,
  validates inputs, builds the job (`status:'running'`, `phase:'allocate'`, empty `log`), persists
  it, and starts the async runner. Returns the initial job immediately (does **not** await the run),
  exactly like `fleet.createJob`.
- **Runner** (fire-and-forget, wrapped so any unexpected throw finalizes the job as `error`):
  1. `allocate` — `vmid = override ?? await client.nextId()`.
  2. `create` — `client.createLxc(node, params)` → UPID; poll `taskStatus`/`taskLog` every `pollMs`
     until terminal, appending new log lines (capped at `maxLogBytes`). Non-`OK` exitstatus → fail.
  3. `start` — when `preset.startAfterCreate`, `client.startLxc(node, vmid)` → UPID; poll to done.
  4. `discover` — resolve the box host: static IP → the preset/override CIDR's address; DHCP →
     bounded poll of `client.lxcInterfaces(node, vmid)` until `eth0` reports an `inet`, up to
     `leaseTimeoutMs`.
  5. `link` — when an address was resolved, `boxStore.addBox({ host, user, sessionName, tags,
     source:'proxmox', proxmox:{ hostId, node, vmid, endpoint } })`; set `job.boxId`. If DHCP
     discovery timed out, the job still **succeeds** but defers the box (`boxId: null`,
     `needsHost: true`) and surfaces the vmid.
  6. `done` — set `status`, `finishedAt`, persist.
- `save` is called at create, each phase transition, and finish (≈O(phases) writes), with the
  in-memory registry authoritative for polling — same checkpoint discipline as `fleet.js`.
- **`cancelProvision(id)`** — best-effort: sets a flag that stops further polling/phases and marks
  the job `cancelled`. A PVE task already running on the node cannot be aborted via this path
  (documented); cancel prevents subsequent phases (e.g. start/link) and stops the poller.
- **Startup reconciliation:** on construction, any persisted job still `running` becomes
  `interrupted` (its poller died with the old process), persisted once — mirroring `fleet.js`.

### Provision-job persistence — `src/server/provisionStore.js`

`load`/`save` injected; the real implementation reads/writes **`data/provision-jobs.json`** with the
**debounced async writer** copied from `fleetStore.js` (provisioning writes are bursty during a
run), pruned to the most recent `maxJobs` by `createdAt`. `data/` is already gitignored; the file
holds only run history, so no placeholder counterpart is needed.

### Wiring — `src/server/index.js`

Construct `secretBox` from `config.cookieSecret`; `proxmoxStore` from `dataDir` + `secretBox`;
`provisionStore`; and `provisionManager` with `makeClient` (built from `proxmoxApi` +
`proxmoxStore.getHost(id,{withSecret})`), the existing `boxStore`, and config-derived options. Pass
`proxmoxStore` + `provisionManager` into `buildServer`. `requiredConfigError` already guarantees
`cookieSecret`, so the encryption key is always available.

## Data model

### `data/proxmox.json`

```jsonc
{
  "version": 1,
  "hosts": [
    {
      "id": "uuid",
      "name": "lab-pve",
      "endpoint": "pve.example.com:8006",
      "tokenId": "user@pam!tmuxifier",
      "tokenSecret": "pvebox.v1:<iv>:<ct>:<tag>",   // AES-256-GCM, never sent to the client
      "fingerprint256": "AB:CD:…:EF",
      "verifyMode": "pin",                           // pin | ca | insecure
      "defaultNode": "pve",
      "createdAt": "ISO"
    }
  ],
  "keys": [
    { "id": "uuid", "name": "mgmt", "publicKey": "ssh-ed25519 AAAA… you@example.com", "createdAt": "ISO" }
  ],
  "presets": [
    {
      "id": "uuid", "name": "debian-dev", "hostId": "uuid", "node": "pve",
      "template": "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
      "storage": "local-lvm", "diskGiB": 8,
      "cores": 2, "memoryMiB": 2048, "swapMiB": 512,
      "unprivileged": true, "features": { "nesting": true },
      "net": { "bridge": "vmbr0", "vlan": null, "ipMode": "dhcp", "cidr": null, "gateway": null },
      "dns": { "nameserver": null, "searchdomain": null },
      "keyIds": ["uuid"], "onboot": false, "startAfterCreate": true,
      "boxDefaults": { "user": "root", "sessionName": "web", "tags": [] },
      "createdAt": "ISO"
    }
  ]
}
```

The **redacted** host shape returned by the REST layer replaces `tokenSecret` with
`"hasToken": true`.

### `data/provision-jobs.json` (a job)

```jsonc
{
  "id": "uuid",
  "presetId": "uuid", "presetName": "debian-dev",   // snapshot
  "hostId": "uuid", "node": "pve",
  "hostname": "dev-01", "vmid": 100,
  "status": "running",                 // running | done | error | cancelled | interrupted
  "phase": "create",                   // allocate | create | start | discover | link | done
  "log": "…task log text, capped to maxLogBytes…",
  "boxId": "uuid | null",              // set when a box was auto-linked
  "needsHost": false,                  // true when DHCP lease discovery timed out (box deferred)
  "error": null,                       // human-readable reason on failure
  "createdAt": "ISO", "startedAt": "ISO", "finishedAt": "ISO | null"
}
```

A box created by provisioning carries `source: "proxmox"` and a `proxmox: { hostId, node, vmid,
endpoint }` block — inert in Phase 1, the cross-link Phase 2 uses for lifecycle/destroy. `addBox`'s
existing `assertBoxSafe` still validates the host/user/port it is given.

## PVE API specifics

| Purpose | Call |
| --- | --- |
| Auth/ping | `GET /version` |
| Nodes | `GET /nodes` → `[{ node, status }]` |
| Storage (rootfs / templates) | `GET /nodes/{node}/storage` → filter `content` ⊇ `rootdir` / `vztmpl` |
| Templates on a storage | `GET /nodes/{node}/storage/{storage}/content?content=vztmpl` → `[{ volid }]` |
| Bridges | `GET /nodes/{node}/network?type=bridge` → `[{ iface }]` |
| Next free vmid | `GET /cluster/nextid` → `"100"` |
| Create LXC | `POST /nodes/{node}/lxc` (params below) → UPID |
| Start LXC | `POST /nodes/{node}/lxc/{vmid}/status/start` → UPID |
| Task status | `GET /nodes/{node}/tasks/{upid}/status` → `{ status, exitstatus }` |
| Task log | `GET /nodes/{node}/tasks/{upid}/log?start=N` → `[{ n, t }]` |
| Container IPs (DHCP discovery) | `GET /nodes/{node}/lxc/{vmid}/interfaces` → `[{ name, inet }]` |

**`createLxc` param mapping** (form-encoded):

```
vmid, ostemplate=<template>, hostname,
rootfs=<storage>:<diskGiB>, cores, memory=<memoryMiB>, swap=<swapMiB>,
unprivileged=<0|1>, features=<nesting=1,…>, onboot=<0|1>,
net0=name=eth0,bridge=<bridge>[,tag=<vlan>],ip=<dhcp | <cidr>,gw=<gateway>>,
nameserver?, searchdomain?,
ssh-public-keys=<newline-joined selected public keys>
```

`start` is issued as a **separate** call after the create task completes (clearer phases, and
avoids relying on a create-time start flag). No `password` is set: access is via the injected
mgmt key(s).

## TLS verification

On **add host**, `inspectEndpoint` captures the cert. If it validates against system CAs,
`verifyMode = ca`; otherwise `verifyMode = pin` and the SHA-256 fingerprint is stored and shown to
the user for confirmation. Every later API call verifies accordingly; a **changed** pinned
fingerprint fails loudly ("TLS fingerprint changed — the host cert was replaced; re-add to accept").
An explicit per-host **`insecure`** mode (skip verification) exists for throwaway labs but is **off
by default**, never auto-selected, and labeled as insecure in the UI.

## REST API

All routes require auth (`preHandler: requireAuth` → 401) and inherit the existing
`requireTrustedOrigin` Origin/CSRF hook (→ 403) and `no-store` `/api/*` header. The token secret is
**never** returned by any route.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/proxmox/inspect` | `{ endpoint }` | `{ fingerprint256, subject, issuer, validTo, caValid, reachable }` |
| `GET` | `/api/proxmox/hosts` | — | redacted hosts |
| `POST` | `/api/proxmox/hosts` | `{ name, endpoint, tokenId, tokenSecret, verifyMode?, fingerprint256?, defaultNode? }` | redacted host (verifies token via `/version`) |
| `PATCH` | `/api/proxmox/hosts/:id` | partial (token secret optional; only replaces when present) | redacted host |
| `DELETE` | `/api/proxmox/hosts/:id` | — | `{ ok }` |
| `POST` | `/api/proxmox/hosts/:id/test` | — | `{ ok, version? , error? }` |
| `GET` | `/api/proxmox/hosts/:id/nodes` | — | `[{ node, status }]` |
| `GET` | `/api/proxmox/hosts/:id/nodes/:node/storage` | — | `{ rootdir: [...], vztmpl: [...] }` |
| `GET` | `/api/proxmox/hosts/:id/nodes/:node/templates?storage=` | — | `[{ volid }]` |
| `GET` | `/api/proxmox/hosts/:id/nodes/:node/bridges` | — | `[{ iface }]` |
| `GET` | `/api/proxmox/hosts/:id/nextid` | — | `{ vmid }` |
| `GET` | `/api/proxmox/keys` | — | keys |
| `POST` | `/api/proxmox/keys` | `{ name, publicKey }` | key |
| `DELETE` | `/api/proxmox/keys/:id` | — | `{ ok }` |
| `GET` | `/api/proxmox/presets` | — | presets |
| `POST` | `/api/proxmox/presets` | preset body | preset |
| `PATCH` | `/api/proxmox/presets/:id` | partial | preset |
| `DELETE` | `/api/proxmox/presets/:id` | — | `{ ok }` |
| `POST` | `/api/proxmox/provisions` | `{ presetId, hostname, vmid?, ip? }` | the created job (running) |
| `GET` | `/api/proxmox/provisions` | — | job summaries, newest first |
| `GET` | `/api/proxmox/provisions/:id` | — | full job (poll target) |
| `POST` | `/api/proxmox/provisions/:id/cancel` | — | updated job |

**Validation (→ 400):** host endpoint must be `host[:port]` with a safe host charset and https
scheme implied; token id matches `user@realm!name`; public key is a single valid key line; preset
numeric ranges (`cores 1–512`, `memoryMiB ≥ 16`, `swapMiB ≥ 0`, `diskGiB 1–8192`), `template`/
`storage`/`bridge` charsets, `ipMode ∈ {dhcp,static}` with a valid `cidr`+`gateway` when static,
optional `vlan 1–4094`, **≥1 `keyId`**; provision `hostname` is a DNS label, `vmid` (when given)
`100–999999999`, `ip` a valid CIDR. Unknown ids → 404.

## Config

New knobs in `src/server/config.js` (env prefix `TMUXIFIER_PVE_`), documented in `.env.example` and
`README.md`. `loadConfig` stays pure/injectable — parsed from the injected `env`, never
`process.env` directly.

| Config key | Env var | Default |
| --- | --- | --- |
| `pvePollMs` | `TMUXIFIER_PVE_POLL_MS` | `1500` |
| `pveTimeoutMs` | `TMUXIFIER_PVE_TIMEOUT_MS` | `15000` |
| `pveProvisionTimeoutMs` | `TMUXIFIER_PVE_PROVISION_TIMEOUT_MS` | `600000` |
| `pveLeaseTimeoutMs` | `TMUXIFIER_PVE_LEASE_TIMEOUT_MS` | `60000` |
| `pveMaxJobs` | `TMUXIFIER_PVE_MAX_JOBS` | `50` |

No token lives in `.env`; it is encrypted in `data/proxmox.json`. The encryption key derives from
the existing `TMUXIFIER_COOKIE_SECRET`.

## Web client (`src/web/`)

To avoid growing the already-large `main.ts` (1321 lines), the feature lives in two new modules
wired from `main.ts` via a single `openProxmoxHub()` entry point:

- **`src/web/proxmox.ts`** — TypeScript types (`PveHost`, `PveKey`, `PvePreset`, `ProvisionJob`, …)
  and a flat `pve` object of `fetch` wrappers mirroring `api.ts`'s style (`hosts()`, `addHost()`,
  `inspect()`, `nodes()`, `templates()`, `presets()`, `createProvision()`, `getProvision()`, …).
- **`src/web/proxmoxUi.ts`** — the hub modal and its five tabs, reusing the existing modal/panel DOM
  helpers and the Fleet **job-polling** pattern (`getProvision` every 1.5 s while `running`). The
  provision job panel renders phase + live log + final box link; **Open terminal** calls back into
  `main.ts`'s existing `openBox`.

`main.ts` gains only: the Proxmox header button, the `openProxmoxHub()` import/call, and a callback
so the job panel can open a freshly-created box. A small **pure** helper that builds `createLxc`
params/`net0` from a preset (mirroring how selection/recent helpers were extracted in Fleet) is
unit-tested.

## Data flow

```
Proxmox button ─▶ hub modal (Hosts · Keys · Presets · Provision · History)

add host ─▶ POST /api/proxmox/inspect {endpoint} ─▶ fingerprint + caValid
        └─▶ POST /api/proxmox/hosts {…, fingerprint, verifyMode} ─▶ verify token via GET /version

edit preset ─▶ GET …/nodes, …/storage, …/templates, …/bridges  (live dropdowns)

provision ─▶ POST /api/proxmox/provisions {presetId, hostname, vmid?, ip?}
                └─▶ provisionManager.createProvision ─▶ persists, returns job (running)
                        └─▶ runner: nextId ─▶ createLxc(UPID) ─poll task─▶ startLxc(UPID) ─poll─▶
                            discover IP (static | DHCP via interfaces) ─▶ boxStore.addBox ─▶ done
browser ◀─ poll every 1.5s ─ GET /api/proxmox/provisions/:id ◀─ in-memory registry (live)
success ─▶ Open terminal ─▶ existing openBox(newBox)
server restart ─▶ load data/provision-jobs.json ─▶ running jobs ─▶ interrupted
```

## Error handling

- **Add-host failures are explicit:** unreachable endpoint, untrusted/insecure cert the user didn't
  confirm, or a rejected token each return a clear 400 with the reason; nothing is saved until
  `/version` succeeds.
- **TLS fingerprint change** on a pinned host fails every call loudly — a replaced cert is treated
  as suspicious, not silently accepted.
- **Provision failure mid-run** finalizes the job as `error` with the PVE task log + reason. If the
  container was already created, the **vmid is surfaced** for manual cleanup (no auto-destroy in
  Phase 1). Create-task failures rely on PVE's own rollback of the partial container.
- **DHCP lease not found** within `leaseTimeoutMs` is **not** a failure: the container is up; the
  job succeeds with `needsHost: true` and the box is deferred (user fills the host, or re-links in
  Phase 2) rather than guessing an address.
- **Output is bounded** (`maxLogBytes` per job; `maxJobs` retention) so `data/provision-jobs.json`
  can't grow without limit.
- **Restart safety:** running jobs become `interrupted` on startup; a PVE task that was in flight
  keeps running on the node and can be inspected there.
- **Token never leaks:** redacted host views only; excluded from logs and any future export.

## Security notes

The Proxmox token can create (and, in later phases, destroy) containers, so it is treated with the
same care as the login gate.

- **Token at rest:** AES-256-GCM encrypted in `data/proxmox.json` (`0o600`), key derived from
  `cookieSecret` via HKDF. Never returned to the browser (redacted host views), never logged, never
  exported. See the honest threat model under `secretBox.js`.
- **TLS — pinning is the secure answer to self-signed PVE certs.** PVE ships a self-signed cert by
  default. Tmuxifier's default is **not** to disable verification but to **pin** that cert's SHA-256
  fingerprint on first add (trust-on-first-use, the same model as Tmuxifier's existing
  `StrictHostKeyChecking=accept-new` SSH default) and verify it on every later call; a changed
  fingerprint fails loudly. When the PVE host presents a CA-valid cert (e.g. Let's Encrypt),
  `verifyMode=ca` does full chain validation. The **`insecure`** mode genuinely disables
  verification and so exposes the token to a man-in-the-middle on every request — it is **off by
  default, never auto-selected, explicit opt-in only**, and the UI labels it insecure and points to
  the better fixes (add the PVE CA to the trust store, or install a properly-issued cert, or accept
  the pinned fingerprint).
- **Least privilege:** the README/DEPLOY docs recommend a **privilege-separated PVE API token**
  scoped to only the privileges provisioning needs (e.g. `VM.Allocate`, `Datastore.AllocateSpace`,
  `Datastore.Audit`, `VM.PowerMgmt`), not a root token.
- **Input validation as defense-in-depth:** although API params are sent as form fields (not
  shell-interpolated), every user value (hostname, vmid, CIDR, bridge/storage/template ids, numeric
  ranges, public-key line) is validated before reaching the API — the same belt-and-suspenders
  posture as `assertBoxSafe`.
- **Outbound target:** the endpoint is user-supplied and the server makes requests to it. This is a
  single-user authenticated app, but the endpoint is still constrained to a safe `host[:port]`
  charset and the request paths are fixed (no user-controlled path/host beyond the stored profile).

## Testing

TDD, real code + dependency injection, no mocking library (repo convention).

- **`test/secretBox.test.js`** — seal/open round-trip; GCM tamper (flip a ciphertext byte) throws;
  wrong derived key throws; `isSealed` recognises the scheme; ciphertext differs across seals (IV).
- **`test/proxmoxStore.test.js`** — host add seals the token and the redacted read hides it while
  `getHost(id,{withSecret})` reveals it; key/preset CRUD + validation (bad public key, missing key
  ref, out-of-range numbers, static without cidr) ; name uniqueness.
- **`test/proxmoxApi.test.js`** — with an injected fake `request`: correct URL/method/auth header
  and form body for `createLxc`/`startLxc`; `net0`/`ssh-public-keys`/`rootfs` assembly; task-log
  pagination; `verifyMode` drives `rejectUnauthorized`/fingerprint check (mismatch rejected); error
  mapping for 401/403/cert/conn against recorded PVE JSON shapes.
- **`test/proxmoxProvision.test.js`** — with a fake client + fake `boxStore` + injected `now`/
  `makeId`: full `allocate→create→start→discover→link→done` sequence and the box it adds (static
  path); DHCP path polls `interfaces` then links; lease-timeout → `done` + `needsHost`, no box;
  create-task non-`OK` → `error`; log capping; retention; `cancel` halts later phases; startup
  reconciliation flips a persisted `running` job to `interrupted`.
- **`test/server.test.js`** — routes via `makeApp` + `login` + `app.inject` with stubbed
  store/manager: 401 unauth + 403 bad-Origin on state-changing routes; token never present in any
  response; 400 validation cases; happy-path host add / preset CRUD / provision create; 404 unknown
  ids.
- **E2E (`test/e2e`)** — optional/gated: against a fake-PVE HTTP fixture (no real Proxmox in CI),
  walk add-host → add-key → add-preset → provision → watch the job reach `done` → box appears.

## Out of scope (deferred to Phases 2–3)

- **Container lifecycle** — listing existing containers; start/shutdown/stop/reboot/**destroy**;
  destroying a container offering to remove its linked box. (Phase 2.)
- **Template management** — browse available templates (`pveam available`) and **download** them to
  a storage (a long-running task that will reuse the provision-job model). (Phase 3.)
- **First-class network profiles** — promoting the preset's inline `net`/`dns` to reusable entities
  referenced by id. (Phase 3.)
- **Cloning / VM (qemu) support, snapshots, backups, multi-NIC** — not part of the canned-LXC loop.
- **Key generation** — Tmuxifier stores only *public* mgmt keys; generating/holding private keys
  would violate "stores no SSH secrets".
```
