# Deprovision NetBox cleanup by current IP — design

**Date:** 2026-07-12
**Status:** implemented same-session (autonomous run); pending owner review

## Problem

Deprovision's NetBox cleanup (`releaseNetboxIp` in `src/server/proxmoxLifecycle.js`) only acts
when the box link carries `netboxIpId` — the record id stamped by auto-static provisioning.
Boxes linked manually to an existing LXC (or provisioned with `dhcp`/`static` presets) have no
stamp, so a manually created NetBox ip-address record for the box outlives the destroyed
container and goes stale in IPAM.

## Goal

After a deprovision completes, no NetBox ip-address record for the box's current IP remains —
whether Tmuxifier allocated it or the operator created it by hand.

## Approaches considered

1. **Fallback-only** — address-match only when `netboxIpId` is absent. Simplest diff, but the
   cleanup rule differs by box origin, and a stale stamp (record recreated by hand, host edited)
   still leaks records.
2. **Union sweep (chosen)** — always release the stamped id first (exact, provenance-known),
   then look up every record matching the box's current IP and delete those too. One rule for
   all boxes; self-heals stamp/host drift; costs one extra GET per deprovision.
3. **Stamp-at-link-time** — resolve and store the record id when a box is manually linked.
   New UI/store surface, does nothing for already-linked boxes; belongs to the future
   enrichment/sync phase, not this fix.

## Design

### `netboxApi.js` — one new client method

`createNetboxClient(...).findIpsByAddress(address)` → `GET /api/ipam/ip-addresses/?address=<address>`,
returns `[{ id, address }]` from `results` (empty array when none). NetBox matches a mask-less
`address` filter on the **host address regardless of prefix length** (netfields `net_in`), so one
query catches a record stored as `/24`, `/32`, etc. Pagination is ignored: more than a page of
records for a single host address is pathological.

### `proxmoxLifecycle.js` — extend `releaseNetboxIp(job, box)`

Both deprovision paths (destroy and already-missing container) already funnel through this
helper; ordinary box removal continues to never touch NetBox.

1. Gather `ipId = box.proxmox.netboxIpId` and `hostIp = box.host` when `net.isIP(box.host)`
   (SAFE_HOST forbids `:` so in practice IPv4; `isIP` keeps it correct if that ever loosens).
   Neither → return silently.
2. Load NetBox settings. Absent → keep today's behavior: logged skip when `ipId` exists,
   silent return otherwise (boxes without NetBox involvement must not add log noise).
3. If `ipId`: release by id (existing code, existing log lines).
4. If `hostIp`: `findIpsByAddress(hostIp)`, then `releaseIp(id)` for **every** match, logging
   each as `# released NetBox ip <id> (<address>)`. The GET runs after the id release, so a
   successfully released stamped record no longer appears; if the id release failed transiently
   the sweep retries it by address.
5. Zero matches **and** no `ipId` → log `# no NetBox ip record matches <hostIp>` (the signal
   for the manual-link case). After a stamped release, no such line (noise).
6. Every step stays best-effort: lookup/delete failures append to the job log and never fail a
   deprovision whose container is already destroyed (existing invariant).

**Multiple matches are all deleted.** NetBox can hold several records with the same host address
(different masks or VRFs); once the container is destroyed, any record for that IP is stale in a
single-user homelab. VRF-duplicated addresses shared with *other* machines are the theoretical
casualty — accepted and visible in the job log.

### Unchanged

- Provision-failure rollback in `proxmoxProvision.js` (releases the record it just created,
  id-exact).
- Ordinary box removal (`boxRemoval.js`) — the machine still exists; its IPAM record stays.
- Hostname-hosted boxes: skipped (no DNS resolution in scope).

## Testing

- `test/netboxApi.test.js`: `findIpsByAddress` issues the right path/query/encoding, maps
  `results` to `[{id, address}]`, returns `[]` on empty.
- `test/proxmoxLifecycle.test.js`: manual link (no stamp) deletes the matching record and logs;
  multiple matches all deleted; stamped release + sweep union (stamp released, second same-IP
  record swept); zero matches logs the no-match line; lookup failure logs and the job still
  completes `done`; hostname host + no stamp touches nothing; unconfigured NetBox stays silent
  (existing tests extended with `findIpsByAddress` stubs).
- Live read-only check against the real NetBox to confirm the mask-less `address` filter
  semantics before shipping.

## Docs

`CLAUDE.md`/`AGENTS.md` module list and `README.md` provisioning section: deprovision deletes
the NetBox record(s) matching the box's current IP — allocated **or manually created** —
best-effort.
