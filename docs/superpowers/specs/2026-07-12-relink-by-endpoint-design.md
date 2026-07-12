# Relink-by-endpoint heal — design

Date: 2026-07-12
Status: design agreed in conversation (owner: "yes build it"); implemented same-session

## Problem

Removing a Proxmox host profile leaves every linked box with a dangling `proxmox.hostId`
(`removeHost` doesn't cascade), and re-adding the host — even with the identical endpoint and
token — mints a new random id, so nothing reconnects. The box sits in "host profile missing /
unknown" with no lifecycle actions until the user manually re-links each box, and a manual
re-link additionally drops the stamped `netboxIpId`.

## Goal

When a linked box's host profile is gone but exactly one current host profile has the same
endpoint as the one stamped on the link, the inventory sweep re-homes the link to that host
automatically — verified, guarded, and logged.

## Key enabler

Every stored link carries `endpoint: host.endpoint` (stamped by both the provision path and the
manual link route, `server.js:463`), and `addHost` normalizes endpoints to `host:port` — so
exact string equality identifies "the same server" across profile generations.

## Approaches considered

1. **Heal inside the inventory sweep's missing-host path (chosen).** Runs continuously (first
   status poll after the re-add, or a Containers-tab Refresh), reuses the existing
   trusted-write machinery (active-job guard + CAS re-read) the node auto-follow uses, and
   needs no new triggers, routes, or UI.
2. Heal on `addHost` (one-shot scan at add time). Deterministic but a second code path with its
   own guards, and it misses links that become healable later (e.g. a box import).
3. Match hosts by endpoint at read time without rewriting the link. Leaves permanent
   ambiguity in the data and every consumer (lifecycle, association editor) would need the
   same resolution logic. Rejected.

## Design (`src/server/proxmoxInventory.js`)

`fetchHost` currently returns `error: 'host profile missing'` records when the group's hostId
resolves to no host. That branch instead calls `healGroup(hostBoxes)`:

1. Without a `boxStore` (read-only wiring), report all boxes orphaned as today — a heal is a
   store write.
2. `proxmoxStore.listHosts()` (redacted list: id/name/endpoint is all that's needed; a listing
   failure degrades to no candidates). For each box, candidate = hosts whose `endpoint` equals
   the link's stamped endpoint. **Exactly one match required**; zero, two-plus, a missing
   stamped endpoint, or an active lifecycle job on the box (`activeJobGuard`) → the box stays
   orphaned this poll.
3. Per candidate host: `getHost(id, { withSecret: true })` + one `clusterResources()` call.
   Only boxes whose `vmid` exists as an `lxc` in that cluster heal; the rest stay orphaned
   (an endpoint match with no such container must not mislink).
4. Per healing box, the same CAS discipline as the node auto-follow: re-read the box, proceed
   only if the fresh link still has the old hostId and same vmid (a link the user changed or
   cleared mid-poll is never resurrected). Write `setProxmoxLink(box.id, { ...freshLink,
   hostId: candidate.id })` — hostId changes in place, so `node`, `vmid`, `endpoint`, and
   `netboxIpId` all survive. Log one line per healed box. A write failure logs and reports the
   box orphaned (best-effort, like the drift write).
5. Healed boxes then flow through the normal `fetchHost` for the candidate host, so the same
   sweep returns live records (state, hostName, node auto-follow) — at the cost of one extra
   `clusterResources` call per heal event, which is rare by construction.

## Error handling

Every failure mode degrades to today's behavior (orphaned record with `error: 'host profile
missing'`): listing failure, candidate fetch/cluster failure, CAS mismatch, guard block, write
failure. The heal never throws out of the sweep.

## Testing

`test/proxmoxInventory.test.js`: heal happy path (hostId rewritten in place, `netboxIpId`
preserved, healthy record with the new hostName, log line); ambiguous endpoint (two matches) →
no write; vmid absent from the candidate cluster → no write; active-job guard → no write; CAS
mismatch (user re-linked mid-poll) → no write; link without a stamped endpoint → no write; no
`boxStore` → plain orphan report. Guard tests pass against current code by design; the happy
path is the failing test.

## Out of scope

- Preset healing: a preset's host dropdown already offers the `(saved)` re-pick, and silently
  retargeting what future provisions land on is a user decision, not drift repair.
- Fuzzy endpoint matching (DNS name vs IP): only the exact normalized `host:port` heals;
  anything else remains a manual re-link.
