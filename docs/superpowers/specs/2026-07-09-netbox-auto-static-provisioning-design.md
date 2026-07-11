# NetBox-backed `auto-static` IP allocation for provisioning

**Drafted:** 2026-07-09 · **Revised:** 2026-07-10 (build on the shipped NetBox settings store) ·
**Revised:** 2026-07-11 (align to the shipped lifecycle/deprovision feature, the master-detail
preset editor, and cluster-aware inventory; **release-on-deprovision moved into scope** — the
decommissioning workflow it was waiting on now exists).

## Summary

Add a third preset IP mode, **`auto-static`**, alongside the existing `dhcp` and `static`. When a
preset is `auto-static`, provisioning asks **NetBox** (the IPAM system of record) for the next free
IP in the prefix that backs the preset's VLAN, reserves it atomically, and configures the container
with that static address. If the container fails to create, the reservation is released so the
address is never leaked. When a container is later **deprovisioned** (graceful shutdown → destroy →
unlink), the reserved IP is released back to NetBox — closing the loop: NetBox stays the source of
truth for the address's whole lifecycle.

The NetBox connection (URL, encrypted token, TLS mode) is whatever the user configured in the
settings modal; `netboxApi.js` gains a client factory with allocate/release methods next to
`testNetbox`; `proxmoxProvision.js` gains an `allocate-ip` phase before `create`; and the
lifecycle manager's deprovision routine gains a best-effort release step.

## Configuration

None new. The connection comes from the settings store:

- `netboxStore.getSettings({ withSecret: true })` is the server-internal decrypting read —
  `{ url, tlsMode, fingerprint256, token }`. `getSettings()` returning `null` (or a decrypt
  failure after a `TMUXIFIER_COOKIE_SECRET` rotation) means NetBox is unconfigured.
- When unconfigured, `auto-static` provisioning fails fast with a clear message pointing at the
  settings modal; `dhcp` and `static` are unaffected, and deprovision's release step is skipped
  silently.
- No `TMUXIFIER_NETBOX_*` keys, no `config.js`/`.env.example` changes. The token stays AES-256-GCM
  sealed at rest and never reaches the browser or any job log.

## Preset model & validation

`net.ipMode` becomes one of **`dhcp` | `static` | `auto-static`**.

- **`auto-static`** stores `net.vlan` (the 802.1q tag, 1–4094) and `net.gateway` (an IP). It does
  **not** store `net.cidr` — the host address is allocated at provision time and its mask comes from
  the NetBox prefix.
- `assertPresetInput` (`proxmoxValidate.js:69` today allows only `['dhcp', 'static']`):
  - `ipMode` must be one of the three values.
  - `static` — unchanged: requires a valid `cidr` and `gateway`.
  - `auto-static` — requires `net.vlan` set (integer 1–4094) **and** a valid `gateway` IP; `cidr`
    is ignored/omitted.
- `proxmoxStore.js` `normalizePreset` carries `net.ipMode` through the new value and keeps
  `cidr: null` for `auto-static`. **Preset editing** (`updatePreset` + `PUT
  /api/proxmox/presets/:id`, shipped with the master-detail editor) needs no server change beyond
  this — it revalidates through the same `assertPresetInput`.
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

`netboxApi.js` holds `testNetbox` plus the private `jsonRequest` (http/https; GET-only today) and
inline TLS-mode resolution built on `tlsPin.js`. This phase refactors that TLS resolution into a
shared internal helper and adds a client factory beside `testNetbox`:

`createNetboxClient(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs } = {})` —
`settings` is the decrypted shape from `getSettings({ withSecret: true })`.

- **Auth:** the same `Authorization: Token <token>` + `Accept: application/json` headers
  `testNetbox` already sends.
- **TLS:** honors the stored `tlsMode` exactly like `testNetbox` — CA-verified default, pin mode
  does the token-less probe-then-pin (fingerprint verified **before** any authenticated request),
  explicit insecure only if the user chose it. Plain `http://` URLs work as configured. No new TLS
  surface.
- **Methods** (all reject with descriptive errors; callers — the provision runner and the
  deprovision routine — handle throws):
  - `findPrefixByVlan(vid)` → `GET /api/ipam/prefixes/?vlan_vid=<vid>`; returns `{ id, prefix }`,
    throwing on 0 or >1 (see resolution rules).
  - `allocateIp(prefixId, { status, description, dns_name })` →
    `POST /api/ipam/prefixes/{id}/available-ips/`; NetBox picks the next free address, creates the
    `ipam.ipaddress` record, and returns `{ id, address }` (e.g. `192.168.30.50/24`). Empty/no-address
    response (prefix full) throws `prefix <cidr> has no available IPs`.
  - `releaseIp(id)` → `DELETE /api/ipam/ip-addresses/{id}/` (best-effort at both call sites).
- `jsonRequest` grows `method`/`body` support; POST bodies are JSON with a fixed `Content-Length`,
  mirroring `proxmoxApi.js`'s chunked-encoding lesson.

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
`discover` phase's host-derivation guard (`proxmoxProvision.js:94`, today
`if (preset.net.ipMode === 'static')`) widens to cover `auto-static` — derive `boxHost` from
`j.ip` whenever `j.ip` is set, and only fall back to lease discovery for `dhcp`.

**Rollback:** the existing `catch (e)` block gains a best-effort
`if (j.netboxIpId) await netbox.releaseIp(j.netboxIpId).catch(() => {})` so any failure after
reservation (create, start, timeout) releases the address. Because allocation is step 1 of `run`, a
NetBox/prefix failure aborts **before** any container is created.

**Link carries the IP id:** the auto-link step (which already writes `box.proxmox` via the
server-trusted path) additionally sets `box.proxmox.netboxIpId = j.netboxIpId` for auto-static
provisions — this is what makes release-on-deprovision possible later, independent of the capped
provision-job history.

`createProvision` leaves `j.ip = null` for `auto-static` (allocation happens inside `run`); a manual
provision-time `ip` override is ignored for `auto-static` in v1. `j.netboxIpId` is added to the
persisted job shape (nullable) for rollback across restarts.

## Release on deprovision — `src/server/proxmoxLifecycle.js`

`createProxmoxLifecycleManager` gains injected `netboxStore` and `makeNetboxClient` (index.js
wiring, same instances as provisioning). In `runDeprovision`, **after the destroy is confirmed**
(and in the missing-container local-cleanup path, where the container is already gone):

- If `box.proxmox.netboxIpId` is present and NetBox is configured: best-effort
  `releaseIp(netboxIpId)` — success and failure both append one line to the job log
  (`released NetBox IP <id>` / `could not release NetBox IP <id>: <message>`); a release failure
  **never** fails the deprovision job (the container is already destroyed — local cleanup must
  complete).
- Absent id or unconfigured NetBox → skipped silently.

### `netboxIpId` semantics (trust + lifecycle)

- Written ONLY by the server-trusted auto-link path. The manual link route
  (`PUT /api/boxes/:id/proxmox`) builds its link object from validated fields and never accepts
  it; box **imports** already strip `proxmox` wholesale.
- The auto-follow drift write spreads the existing link (`{ ...box.proxmox, node }`), so it
  **preserves** `netboxIpId` across node migrations.
- A manual **re-link** (Change association) replaces the link and drops the id — after re-pointing
  a box at a different container, deprovision no longer releases the original IP (correct: the
  association Tmuxifier allocated for is gone). A plain **unlink** also drops it, and a plain
  unlink doesn't destroy the container — not releasing is correct there too (the container keeps
  using its address).
- It is a NetBox record id (integer) — metadata, never used in ssh/PVE calls, not a secret.

## UI — web client (`.ts`)

- **Preset editor (`src/web/proxmoxPresets.ts` — the master-detail form):** the IP-mode select
  (line ~131) gains `auto-static`. Selecting it reveals `vlan` (required here, unlike the optional
  tag for other modes) + `gateway`, hides `cidr`, and shows a hint: *"IP auto-allocated from the
  NetBox prefix for VLAN N."* Editing an existing auto-static preset prefills mode/vlan/gateway
  (the form's existing `editing?.net` prefill pattern). `PvePreset`'s net type in `proxmox.ts`
  widens `ipMode` to the three values. If `nbx.get()` reports no settings, the `auto-static`
  option shows *"configure NetBox in Settings first"* (informational — the server still enforces
  it).
- **Provision tab (`src/web/proxmoxUi.ts` `renderProvision`):** the existing `syncStatic` toggle
  (line ~87) extends — for an `auto-static` preset the IP override input is replaced by static
  text *"IP: auto (NetBox)"*.
- **Job phase type:** `ProvisionPhase` in `src/web/proxmox.ts` gains `'allocate-ip'` (distinct
  from the existing `'allocate'` phase, which is VMID allocation). The hub job panel and the
  Activity tab render phase strings directly, so this is the only client change they need.
- Verified by `npm run typecheck` + `npm run build`.

## Interplay with shipped features

- **Auto-follow migration:** none — the allocated IP lives inside the container; node moves don't
  touch it, and the drift write preserves `netboxIpId`.
- **Cluster-aware inventory / Containers tab:** no changes; deprovision's release step is internal
  to the lifecycle job and visible in its job log.

## Failure handling (summary)

| Condition | Result |
|---|---|
| NetBox unconfigured (or token undecryptable), preset `auto-static` | provision fails fast, no container created |
| NetBox unreachable / auth / TLS-pin failure | job `error` in `allocate-ip`, no container created |
| VLAN maps to 0 or >1 prefixes | job `error`, clear message, no container created |
| Prefix full | job `error`, no container created |
| Reserved IP, then create/start fails | reservation released (`releaseIp`), job `error` |
| Deprovision of an auto-static box | IP released after destroy, logged in the job log |
| Release fails during deprovision | job still completes; failure logged, IP left for manual cleanup |
| Deprovision of a re-linked / manually-linked box | no release (no `netboxIpId` on the link) |

Never silently falls back to DHCP — a surprising address is worse than an explicit error. Error
messages must not embed the token (they surface in persisted job logs and the browser).

## Testing (TDD on the server; real code + injected fakes)

- `netboxApi.test.js` (extend) — `createNetboxClient`: `findPrefixByVlan` for 0/1/many;
  `allocateIp` returns `{id,address}`, sends `Token` auth + JSON body with fixed Content-Length,
  throws when the prefix is full; `releaseIp` issues DELETE; pin mode still withholds the request
  on fingerprint mismatch (same invariant `testNetbox` locks, asserted for a client method too).
- `proxmoxValidate.test.js` — `auto-static` accepted with `vlan`+`gateway`; rejected without
  `vlan`, without `gateway`, and with an invalid `ipMode`; `static`/`dhcp` cases unchanged.
- `proxmoxProvision.test.js` — with fake NetBox client + store + Proxmox client: (a) `auto-static`
  allocates, sets `j.ip`, creates with the allocated CIDR, links the box **with `netboxIpId` on
  the link**; (b) create failure calls `releaseIp` and ends `error`; (c) `findPrefixByVlan`
  throwing aborts before any `createLxc` call; (d) unconfigured store fails fast with the
  settings-modal message; (e) dhcp/static presets never touch the NetBox client.
- `proxmoxLifecycle.test.js` — deprovision releases when the link carries `netboxIpId` (log line
  asserted); skips silently when absent or NetBox unconfigured; a throwing `releaseIp` still ends
  the job `done`; the missing-container path also releases.
- `proxmoxInventory.test.js` — the drift write preserves `netboxIpId` (spread already does; test
  pins it).
- Web verified by `npm run typecheck` + `npm run build`.

## Build order

1. `netboxApi.js`: shared TLS-resolution helper + `jsonRequest` method/body support +
   `createNetboxClient` with the three methods + tests.
2. `proxmoxValidate.js` `auto-static` rules + tests; `proxmoxStore.js` normalize.
3. `proxmoxProvision.js` `allocate-ip` phase + rollback + `netboxIpId` onto the auto-link + tests
   (DI `netboxStore`, `makeNetboxClient`).
4. `proxmoxLifecycle.js` deprovision release + tests; inventory drift-preserves-netboxIpId test.
5. `index.js` wiring (netboxStore + makeNetboxClient into both managers).
6. UI: preset editor 3-way (`proxmoxPresets.ts`) + provision-tab note (`proxmoxUi.ts`) +
   `ProvisionPhase`/`PvePreset` types (`proxmox.ts`).
7. Docs: `README.md` (`auto-static` mode + release-on-deprovision), `CLAUDE.md`/`AGENTS.md`
   (netbox bullet no longer "settings-only"; lifecycle bullet mentions IP release).

## Out of scope (v1)

- Writing box **tags** back onto the NetBox record; v1 sets only `status` + `description` at
  allocation.
- Explicit-prefix override on the preset (v1 derives the prefix from the VLAN only).
- Untagged / no-VLAN `auto-static`.
- A "preview next available IP" button in the provision modal.
- Reconciling the NetBox record's `dns_name`/tags after the box gets its final identity.
- Releasing IPs for boxes deleted via plain box-remove (only **deprovision** releases; plain
  remove doesn't destroy the container, so its address stays in use).
- Per-Proxmox-host NetBox instances (v1 is the single global connection from the settings modal).
