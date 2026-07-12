# Auto-static gateway inference and gateway-safe allocation — design

**Date:** 2026-07-12
**Status:** Approved (brainstorm with owner)
**Builds on / amends:** `2026-07-09-netbox-auto-static-provisioning-design.md` (the shipped
auto-static feature). Found in the owner's first live test: NetBox's `available-ips` returned
`192.168.3.1` — the network's gateway, unregistered in NetBox — so the container was created with
`ip` = `gw` = the gateway address, and a stray NetBox record was created for it.

## Goal

Two coupled changes to auto-static provisioning:

1. **The gateway is inferred, not user-entered:** gateway = the **first usable IP** of the
   NetBox prefix backing the preset's VLAN (`192.168.3.0/24` → `192.168.3.1`). The preset keeps
   only the VLAN; the gateway field disappears from the auto-static form.
2. **Allocation never selects the gateway:** the allocator picks the first *available* address
   in the prefix that is not the inferred gateway, whether or not the gateway is registered in
   NetBox.

Networks whose gateway is not the first usable address keep using the `static` mode (an explicit
override is out of scope; option declined in brainstorm).

## Allocation redesign — `src/server/netboxApi.js`

- New exported pure helper `firstUsableIp(prefixCidr)`: IPv4 integer math, network address + 1
  (`10.20.0.0/16` → `10.20.0.1`; `/30` → `.1`). Throws `prefix <cidr> is too small for
  auto-static` for `/31` and `/32`.
- `createNetboxClient`'s `allocateIp(prefix, fields)` changes strategy:
  1. `gateway = firstUsableIp(prefix.prefix)`.
  2. `GET /api/ipam/prefixes/{id}/available-ips/` (returns the available list; NetBox caps the
     page at its MAX_PAGE_SIZE — far larger than any homelab prefix's realistic need, and the
     gateway is a single entry so a non-gateway pick always exists on page one when any exists).
  3. Pick the first entry whose host part ≠ gateway; none → throw
     `prefix <prefix> has no available IPs` (same message as before — exhaustion and
     gateway-only-left are the same user-facing condition).
  4. `POST /api/ipam/ip-addresses/` with `{ address: <picked>, ...fields }` to reserve it.
  5. Return `{ id, address, gateway }`.
- **Atomicity trade-off (documented in code):** GET-then-POST replaces NetBox's atomic
  next-free POST. A concurrent allocation of the same address makes NetBox reject the duplicate
  → the job errors cleanly and a retry succeeds. Acceptable for a single-user tool.
- `releaseIp` and everything else unchanged.

## Provisioning — `src/server/proxmoxProvision.js`

- The `allocate-ip` phase consumes the new return shape: `j.ip = res.address`,
  `j.gateway = res.gateway` (new nullable persisted job field, for the log and observability),
  `j.netboxIpId = res.id`. The log line becomes
  `# allocated <address> from <prefix> (gw <gateway>, NetBox ip <id>)`.
- `buildCreateParams` is called with a `gateway` override for auto-static so net0 gets
  `ip=<allocated>,gw=<inferred>`. The `isCidr` guard on `res.address` stays; the inferred
  gateway is computed, not parsed, so it needs no guard.

## Param mapping — `src/server/proxmoxParams.js`

- `buildNet0(net, ipOverride, gwOverride)` / `buildCreateParams(preset, { …, gateway })`: the
  static/auto-static branch emits `gw=${gwOverride ?? net.gateway}`. Static presets are
  unaffected (no override passed). (Amends the original spec's erratum file again — this time by
  design.)

## Preset model — `src/server/proxmoxValidate.js` / `proxmoxStore.js`

- `assertPresetInput`: `auto-static` requires ONLY `net.vlan` (1–4094); the gateway requirement
  is dropped. `static` unchanged.
- `normalizePreset`: `gateway` forced `null` for auto-static (joining the forced-null `cidr`).
- Backward compatibility: existing auto-static presets with a stored gateway keep working —
  validation no longer requires it, provisioning ignores it (always uses the inferred value),
  and the next save normalizes it away. No migration.

## UI — `src/web/proxmoxPresets.ts`

- Auto-static hides BOTH the CIDR and Gateway fields (each field gets its own visibility toggle;
  static shows both; dhcp hides both). VLAN stays `vlan (required)` for auto-static.
- Hint becomes: `IP + gateway auto-derived from the NetBox prefix for VLAN <N>.` (with the
  existing "configure NetBox in Settings first" suffix when unconfigured).
- `PvePresetNet` type unchanged (gateway remains `string | null`).

## Failure handling

| Condition | Result |
|---|---|
| Prefix `/31` or `/32` | job `error`: prefix too small, no container created |
| Only the gateway is available | job `error`: `prefix <prefix> has no available IPs` |
| Concurrent duplicate reservation | NetBox rejects the POST → job `error`, retry succeeds |
| Existing preset with stored gateway | ignored; inferred gateway used; normalized away on next save |

The owner's stray test artifacts self-clean: deprovisioning the mis-provisioned container
releases its NetBox record (the `.1` entry) via the existing `netboxIpId` path.

## Testing (TDD, real code + injected fakes)

- `netboxApi.test.js`: `firstUsableIp` matrix (`/24`→`.1`, `/16`→`.0.1`, `/30`→`.1`, `/31`+`/32`
  throw); `allocateIp` skips the gateway (available list `[.1, .5]` → POSTs `.5`, returns
  `gateway: '.1'` form); gateway-only-left throws no-available; POST body carries
  `{ address, ...fields }`; return shape `{ id, address, gateway }`.
- `proxmoxValidate.test.js` / `proxmoxStore.test.js`: auto-static valid with vlan alone;
  gateway normalized to null.
- `proxmoxParams.test.js`: `gwOverride` emitted; static-without-override unchanged.
- `proxmoxProvision.test.js`: net0 contains `ip=<allocated>` AND `gw=<inferred>`; job log line
  shows both; `j.gateway` persisted.
- UI: scripted browser check — auto-static hides CIDR and Gateway, hint text updated; static
  still shows both.

## Out of scope

- Explicit gateway override for non-first-usable networks (use `static` mode).
- NetBox gateway-record detection (role/tag-based inference).
- Registering the gateway as a NetBox record on Tmuxifier's behalf.
- IPv6.
