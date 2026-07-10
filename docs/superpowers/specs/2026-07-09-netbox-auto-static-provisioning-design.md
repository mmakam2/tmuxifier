# NetBox-backed `auto-static` IP allocation for provisioning

**Drafted:** 2026-07-09 · **Revised:** 2026-07-10 to build on the shipped NetBox settings
integration (see `2026-07-10-settings-modal-netbox-design.md`). The original draft configured the
NetBox connection through `.env` and created `netboxApi.js` from scratch; both are superseded —
the connection now comes from the in-app settings (⚙ modal → sealed `data/netbox.json` via
`netboxStore.js`), and `netboxApi.js` already exists with the `testNetbox` probe and
ca/pin/insecure TLS handling. This phase extends them.

## Summary

Add a third preset IP mode, **`auto-static`**, alongside the existing `dhcp` and `static`. When a
preset is `auto-static`, provisioning asks **NetBox** (the IPAM system of record) for the next free
IP in the prefix that backs the preset's VLAN, reserves it atomically, and configures the container
with that static address. If the container fails to create, the reservation is released so the
address is never leaked.

The NetBox connection (URL, encrypted token, TLS mode) is whatever the user configured in the
settings modal; `netboxApi.js` gains allocate/release client methods next to `testNetbox`; and
`proxmoxProvision.js` gains an `allocate-ip` phase before `create`.

## Configuration

None new. The connection comes from the phase-1 settings store:

- `netboxStore.getSettings({ withSecret: true })` is the server-internal decrypting read —
  `{ url, tlsMode, fingerprint256, token }`. `getSettings()` returning `null` (or a decrypt
  failure after a `TMUXIFIER_COOKIE_SECRET` rotation) means NetBox is unconfigured.
- When unconfigured, `auto-static` provisioning fails fast with a clear message pointing at the
  settings modal; `dhcp` and `static` are unaffected.
- No `TMUXIFIER_NETBOX_*` keys, no `config.js`/`.env.example` changes. The token stays AES-256-GCM
  sealed at rest and never reaches the browser or the job log.

## Preset model & validation

`net.ipMode` becomes one of **`dhcp` | `static` | `auto-static`**.

- **`auto-static`** stores `net.vlan` (the 802.1q tag, 1–4094) and `net.gateway` (an IP). It does
  **not** store `net.cidr` — the host address is allocated at provision time and its mask comes from
  the NetBox prefix.
- `assertPresetInput` (`proxmoxValidate.js`):
  - `ipMode` must be one of the three values.
  - `static` — unchanged: requires a valid `cidr` and `gateway`.
  - `auto-static` — requires `net.vlan` set (integer 1–4094) **and** a valid `gateway` IP; `cidr`
    is ignored/omitted.
- `proxmoxStore.js` `normalizePreset` carries `net.ipMode` through the new value and keeps
  `cidr: null` for `auto-static`.
- `proxmoxParams.js` `buildNet0`/`buildCreateParams` need **no change**: once the provision flow has
  set `j.ip` to the allocated `A.B.C.D/len`, `auto-static` takes the same branch as `static`
  (`ip=<addr>/len,gw=<gateway>`).

## VLAN → prefix resolution

The preset's VLAN tag is resolved to a NetBox prefix at provision time via
`GET /api/ipam/prefixes/?vlan_vid=<vlan>`:

- **0 matches** → fail: `no NetBox prefix for VLAN <n>`.
- **exactly 1 match** → use it.
- **>1 matches** → fail: `VLAN <n> maps to multiple NetBox prefixes; cannot auto-allocate`
  (v1 does not guess).
- **`net.vlan` unset** → rejected at preset validation, so this cannot reach provisioning. Untagged
  networks use `static`/`dhcp` in v1.

Example: preset `net.vlan = 30` resolves to NetBox prefix `192.168.30.0/24`; allocation yields
`192.168.30.50/24`.

## NetBox client — extend `src/server/netboxApi.js`

`netboxApi.js` already holds `testNetbox` plus the private `jsonRequest` (http/https) and the
TLS-mode resolution built on `tlsPin.js` (`tlsProbe`/`derToPem`/`normFp`). This phase refactors
that TLS resolution into a shared internal helper and adds a client factory beside `testNetbox`:

`createNetboxClient(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs } = {})` —
`settings` is the decrypted shape from `getSettings({ withSecret: true })`.

- **Auth:** the same `Authorization: Token <token>` + `Accept: application/json` headers
  `testNetbox` already sends (proven against the live instance by Test Connection).
- **TLS:** honors the stored `tlsMode` exactly like `testNetbox` — CA-verified default, pin mode
  does the token-less probe-then-pin (fingerprint verified **before** any authenticated request;
  the pinned chain becomes the `ca` with `rejectUnauthorized: true`), explicit insecure only if
  the user chose it. Plain `http://` URLs work as configured. No new TLS surface.
- **Methods** (all reject with descriptive errors; unlike `testNetbox`, callers handle throws —
  the provision runner's catch block is the consumer):
  - `findPrefixByVlan(vid)` → `GET /api/ipam/prefixes/?vlan_vid=<vid>`; returns `{ id, prefix }`,
    throwing on 0 or >1 (see resolution rules).
  - `allocateIp(prefixId, { status, description, dns_name })` →
    `POST /api/ipam/prefixes/{id}/available-ips/`; NetBox picks the next free address, creates the
    `ipam.ipaddress` record, and returns `{ id, address }` (e.g. `192.168.30.50/24`). Empty/no-address
    response (prefix full) throws `prefix <cidr> has no available IPs`.
  - `releaseIp(id)` → `DELETE /api/ipam/ip-addresses/{id}/` (best-effort; used for rollback).
- `jsonRequest` grows `method`/`body` support (it is GET-only today); POST bodies are JSON with a
  fixed `Content-Length`, mirroring `proxmoxApi.js`'s lesson about chunked encoding.

## Provisioning flow — `src/server/proxmoxProvision.js`

`createProvisionManager` gains injected `netboxStore` and `makeNetboxClient` (defaulting to
`createNetboxClient`), parallel to `makeClient` for Proxmox, so the flow is testable with fakes.

A new **`allocate-ip` phase runs before `create`**, only when `preset.net.ipMode === 'auto-static'`:

1. `settings = await netboxStore.getSettings({ withSecret: true })`; `null` (or decrypt throw) →
   fail: `auto-static requires the NetBox integration — configure it in Settings (⚙)`.
2. `netbox = makeNetboxClient(settings)`.
3. `prefix = await netbox.findPrefixByVlan(preset.net.vlan)`.
4. `res = await netbox.allocateIp(prefix.id, { status: 'active',
   description: 'tmuxifier: ' + j.hostname })`.
5. `j.ip = res.address; j.netboxIpId = res.id;` persist.

Then `create` proceeds exactly as `static` (`buildCreateParams` sees `j.ip` with its mask). The
`discover` phase's host-derivation guard, today `if (preset.net.ipMode === 'static')`, widens to
cover `auto-static` — i.e. derive `boxHost` from `j.ip` whenever `j.ip` is set (both `static` and
`auto-static`), and only fall back to lease discovery for `dhcp`.

**Rollback:** the existing `catch (e)` block gains a best-effort
`if (j.netboxIpId) await netbox.releaseIp(j.netboxIpId).catch(() => {})` so any failure after
reservation (create, start, timeout) releases the address. Because allocation is step 1 of `run`, a
NetBox/prefix failure aborts **before** any container is created.

`createProvision` leaves `j.ip = null` for `auto-static` (allocation happens inside `run`); a manual
provision-time `ip` override is ignored for `auto-static` in v1. `j.netboxIpId` is added to the
persisted job shape (nullable) for rollback across restarts.

## UI — web client (`.ts`)

- **Preset editor (`proxmoxUi.ts`, `proxmox.ts`):** `ipMode` becomes a 3-way toggle. `auto-static`
  reveals `vlan` + `gateway`, hides `cidr`, and shows a hint: *"IP auto-allocated from the NetBox
  prefix for VLAN N."* `PvePreset` net type widens `ipMode` to the three values. If
  `nbx.get()` reports no settings, the `auto-static` option shows *"configure NetBox in Settings
  first"* (informational — the server still enforces it).
- **Provision modal:** for an `auto-static` preset, the IP input is replaced by static text
  *"IP: auto (NetBox)"*.
- Verified by `npm run typecheck` + `npm run build`.

## Failure handling (summary)

| Condition | Result |
|---|---|
| NetBox unconfigured (or token undecryptable), preset `auto-static` | fail fast, no container created |
| NetBox unreachable / auth / TLS-pin failure | job `error` in `allocate-ip`, no container created |
| VLAN maps to 0 or >1 prefixes | job `error`, clear message, no container created |
| Prefix full | job `error`, no container created |
| Reserved IP, then create/start fails | reservation released (`releaseIp`), job `error` |

Never silently falls back to DHCP — a surprising address is worse than an explicit error. Error
messages must not embed the token (they surface in the persisted job log and the browser).

## Testing (TDD on the server; real code + injected fakes)

- `netboxApi.test.js` (extend) — `createNetboxClient`: `findPrefixByVlan` for 0/1/many;
  `allocateIp` returns `{id,address}`, sends `Token` auth + JSON body, throws when the prefix is
  full; `releaseIp` issues DELETE; pin mode still withholds the request on fingerprint mismatch
  (same invariant `testNetbox` locks, asserted for a client method too).
- `proxmoxValidate.test.js` — `auto-static` accepted with `vlan`+`gateway`; rejected without `vlan`,
  without `gateway`, and with an invalid `ipMode`; `static`/`dhcp` cases unchanged.
- `proxmoxProvision.test.js` — with fake NetBox client + store + Proxmox client: (a) `auto-static`
  allocates, sets `j.ip`, creates with the allocated CIDR, links the box; (b) create failure calls
  `releaseIp` and ends `error`; (c) `findPrefixByVlan` throwing aborts before any `createLxc` call;
  (d) unconfigured store (`getSettings` → null) fails fast with the settings-modal message.
- Web verified by `npm run typecheck` + `npm run build`.

## Build order

1. `netboxApi.js`: shared TLS-resolution helper + `jsonRequest` method/body support +
   `createNetboxClient` with the three methods + tests.
2. `proxmoxValidate.js` `auto-static` rules + tests; `proxmoxStore.js` normalize.
3. `proxmoxProvision.js` `allocate-ip` phase + rollback + tests (DI `netboxStore`,
   `makeNetboxClient`).
4. UI: preset editor 3-way + provision modal note.
5. Docs: `README.md` (`auto-static` mode), `CLAUDE.md`/`AGENTS.md` (extend the netbox
   architecture bullet — no longer "settings-only").

## Out of scope (v1)

- Writing box **tags** back onto the NetBox record (would need tag-ensure logic); v1 sets only
  `status` + `description` at allocation.
- Explicit-prefix override on the preset (v1 derives the prefix from the VLAN only).
- Untagged / no-VLAN `auto-static`.
- A "preview next available IP" button in the provision modal (read-only `GET available-ips`).
- Reconciling the NetBox record's `dns_name`/tags after the box gets its final identity.
- Releasing the IP when a box is **decommissioned** (needs the decommissioning workflow first;
  `j.netboxIpId` persisting on the job — and the box's `proxmox` metadata — is the seam it will use).
- Per-Proxmox-host NetBox instances (v1 is the single global connection from the settings modal).
