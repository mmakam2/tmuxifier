# Cross-cluster link follow: keep a box linked when its guest moves to another cluster

**Date:** 2026-10-05
**Status:** approved design, awaiting implementation plan

## Problem

A box's Proxmox link is keyed on `hostId` (the host profile) + `vmid`, with `node` stored but
drift-followed: `proxmoxInventory.js` finds the vmid in the profile's `/cluster/resources` and
rewrites the link's node when a guest migrates *within* its cluster. A guest moved to a
*different* cluster — Proxmox Datacenter Manager's remote migration, `qm remote-migrate` — is a
new guest on a cluster the link does not point at, possibly under a new vmid. The link reads
`missing` and stays that way until the operator re-links it by hand, even though Tmuxifier
already holds a token for the destination cluster and can see the guest there.

A vmid alone cannot carry identity across clusters: every cluster numbers its guests
independently, so the same vmid on another cluster is usually a stranger, and a remote migration
may assign a new vmid anyway. Following by vmid would repoint boxes at other people's guests —
the exact outcome the existing `mismatch` rule exists to prevent.

## Decisions

- **Workflow supported: migrate with delete-source.** The operator moves guests with PDM's remote
  migration with the source deleted, so the old link reads `missing` the moment the move
  completes. That is the only trigger. A migration that keeps the source (the `qm remote-migrate`
  default, `--delete 0`, leaves it stopped) leaves the link reading `stopped` on a guest that
  still exists, and is deliberately not followed: two live configs share one identity, and
  Tmuxifier cannot tell which one the operator means.
- **Auto-follow, no confirmation.** Exactly one fingerprint match re-homes the link on the next
  status poll and logs it, the same as the in-cluster node auto-follow. No health event.
- **Identity is a fingerprint stamped on the link: kind + guest name + `net0` MAC.** Once the
  source is deleted its config is gone, so the fingerprint cannot be read at follow time — it has
  to have been recorded while the guest existed. All three must match; kind is the link's existing
  `kind`.
- **Read-only toward PVE.** The alternative — writing a `tmuxifier-<boxid>` tag into every linked
  guest's config — was rejected: it makes Tmuxifier a writer to every linked guest (today only
  provisioning and re-address write), needs `VM.Config.Options` on every token, is operator-
  deletable in the PVE UI, and is copied by a backup restored as a copy, so it would not remove
  the collision case it was meant to.
- **Fail closed everywhere.** Zero matches, two or more matches, a link without a fingerprint, or
  an unreadable host profile, or anything malformed: the link stays `missing` and nothing is written.

## Prerequisite: verify the fingerprint survives (gates the plan)

Proxmox does not document whether a remote migration preserves a guest's MAC address. Before any
code is written, PDM-migrate a throwaway container from `cluster-a` to `cluster-b` with
delete-source and record:

1. the `net0` value on both sides — the MAC must be identical;
2. the guest name on both sides;
3. whether `/cluster/resources?type=vm` reports a `lock` on the target during the migration, and
   whether the target is still locked at the moment the source disappears.

If the MAC does not survive, this design is void and the fingerprint must be redesigned. If
`/cluster/resources` carries no `lock` field, the lock filter below is dropped (PVE unlocks the
target before deleting the source, so the window it guards is expected to be empty anyway).

## Design

### Data model

The link (`box.proxmox`) gains an optional fingerprint:

```js
proxmox: { hostId, node, vmid, kind, endpoint, netboxIpId?, fp?: { name, mac } }
```

- `fp.name` — the guest's PVE name, allowlisted (`^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`, the
  shape PVE itself enforces on a guest name).
- `fp.mac` — the `net0` MAC, normalized to uppercase colon form and matched against
  `^([0-9A-F]{2}:){5}[0-9A-F]{2}$`.

Both are optional, so every existing link stays valid. `linkKey` (`hostId` + `node` + `vmid`) is
unchanged — the fingerprint is identity evidence, not a uniqueness key.

### Extracting the MAC: `macOfNet0(kind, net0)` (`proxmoxParams.js`, pure)

The two guest kinds write their MAC differently:

- LXC: `name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=…` — the `hwaddr` key.
- QEMU: `virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1` — the MAC is the *value* of the NIC
  model key (`virtio`, `e1000`, `e1000e`, `rtl8139`, `vmxnet3`, …), which is the first pair.

Built on the existing `parseNet0` pair parser (which throws on empty or unparseable input —
`macOfNet0` catches and returns `null`). For QEMU it takes the first pair's value when that value
matches the MAC pattern rather than allowlisting model names, so a new PVE NIC model needs no
code change. Returns the normalized MAC, or `null` for anything absent or malformed — a `null`
fingerprint half means the guest can never be followed, never that it matches anything.

### Stamping the fingerprint

- **The inventory is the only writer of `fp`.** During a status-poll refresh, a link whose guest is
  present (`running`/`stopped`, not `mismatch`) but which lacks a complete `fp` gets one config
  read (`guestConfig(kind, node, vmid)`) and a stamp, through the same CAS re-read + active-job
  guard the node auto-follow uses. This covers a fresh manual link and a freshly provisioned box
  on the first poll after they are made (≤ `statusPollMs`), so neither `PUT /api/boxes/:id/proxmox`
  nor `proxmoxProvision.js` changes. A manual re-link already builds a brand-new link object, so it
  can never inherit the previous guest's fingerprint — the backfill re-stamps the new guest.
  Bounded concurrency (the existing `mapWithConcurrency`, 4 at a time) so the first poll after
  deploy does not fire ~60 config reads at once. A failed read stamps nothing and is retried on a
  later poll; a read that succeeds but yields no usable name/MAC is remembered in memory for the
  life of the process (keyed by host + vmid), so a guest with no `net0` costs one read, not one
  per poll. `PVEAuditor` already carries `VM.Audit`, which is all a config read needs.
- **Name kept current.** `fp.name` is rewritten when `/cluster/resources` (already fetched every
  poll) reports a different name for the linked guest — free, and it keeps a renamed guest
  followable. `fp.mac` is never re-read once stamped: a MAC changed after linking makes the guest
  unfollowable (fail closed), and re-linking via Edit link re-stamps it.

### The follow step (`proxmoxInventory.js`)

After `doRefresh` has every profile's records, a `followAcrossClusters` step considers each record
whose state is `missing`:

1. **Eligible links only:** the link has a complete `fp`, and `activeJobGuard(box.id)` is false.
2. **Search space: every host profile, including the link's own.** A guest restored under a new
   vmid on its own cluster is the same identity (the vmid that went missing is by definition
   absent from its own cluster's list). Profiles are de-duplicated by identical `endpoint` before
   searching. `/cluster/resources` results are cached per refresh: a profile already fetched for
   its own linked boxes is not fetched again, and a profile with no linked boxes is fetched once.
   **A profile that cannot be read makes the search incomplete, and an incomplete search never
   follows** — the unreadable cluster could hold a second match.
3. **Candidates from the resource list:** same `type` as the link's `kind`, same `name` as
   `fp.name`, not a template, no `lock` (see prerequisite), a node passing `SAFE_NODE`, a vmid in
   `100..999999999`, and not currently linked to another box.
4. **MAC confirmation:** `guestConfig` for each surviving candidate only; keep those whose
   `macOfNet0` equals `fp.mac`. In the common case — a guest that was deleted for good — step 3
   leaves no candidates and no config is read.
5. **Ambiguity across boxes:** if two `missing` boxes in the same refresh resolve to the same
   candidate, neither follows.
6. **Exactly one match:** CAS re-read the box (still linked to the same `hostId` + `vmid`, still
   no active job), then `setProxmoxLink` with the new `hostId`, `node`, `vmid` and `endpoint`,
   keeping `kind`, `fp` and `netboxIpId`. Log
   `box <label>: guest moved <oldProfile>/<oldVmid> -> <newProfile>/<newVmid> (fingerprint <name> <mac>)`.
   The record returned for this refresh is rebuilt from the new cluster's data, so the poll that
   follows also reports the right state.
7. **Zero or 2+ matches:** the record stays `missing`, nothing is written. Two-or-more is logged
   once per state change (not every poll) naming the profiles involved.

`setProxmoxLink` throwing `already linked` (a race with a manual link) is treated as "no follow"
and logged, never surfaced.

`healGroup` is unchanged. A box it re-homes goes through `fetchHost` and so reaches the follow
step like any other record.

### `refreshBox(box, { follow })`

`refreshBox` gains `{ follow = true }`. With `follow: false` it writes neither a cross-cluster
re-home nor a fingerprint stamp. The node auto-follow inside `fetchHost` is unaffected — it stays
exactly as today. `createJob` passes `follow: false` (below); every other caller keeps the default,
and those all run while their own job holds the active-job guard, which already blocks both writes.

A new `findFollowCandidates(box)` runs steps 2-4 for one box and returns
`{ found: [{ hostId, hostName, vmid, node }], unreachable: [hostName] }` without writing — the
deprovision guard's query. A link without a complete `fp` returns both lists empty.

Step 3's "not linked to another box" test needs the whole fleet, so it always reads
`boxStore.listBoxes()` rather than trusting the box list the refresh was called with (a single-box
refresh is handed one box). A failing read makes the search incomplete.

### Deprovision guard (`proxmoxLifecycle.js`)

Deprovision from `missing` today skips PVE and then forgets the box's `known_hosts` entry,
releases its NetBox IP (by stamped id and by address) and removes the box. After a PDM migration
there is a window — up to one `statusPollMs` — in which the box reads `missing` while the guest
is alive on another cluster with the same address; deprovisioning then would release a live
guest's NetBox record and forget a live host key.

- `createJob`'s pre-check calls `refreshBox(box, { follow: false })`. A cross-cluster re-home
  there would leave the job snapshotting the old `hostId` against the new link and abort at
  `resolveTarget`; the existing comment ("only the node may follow") becomes true by construction.
- When `action === 'deprovision'`, the state is `missing`, and the link carries a complete `fp`,
  `createJob` calls `findFollowCandidates(box)` and refuses with `409` when anything turned up:
  - one candidate: `guest found on <hostName> as vmid <vmid> — Tmuxifier will re-link it on the next poll`;
  - several: `<N> guests match this box's fingerprint — re-link it with Edit link`;
  - an unreadable profile: `cannot rule out that this guest moved: <names> unreachable — retry, or remove the box instead`.

  A link without `fp` was never followable and keeps today's behaviour exactly — which is also why
  every existing lifecycle test fixture is unaffected.
- `runDeprovision`'s `missing` branch repeats the check before touching `known_hosts` or NetBox
  and fails the job with the same message, because the migration can land between `createJob` and
  the job running.
- Plain box removal (`DELETE /api/boxes/:id`) is unchanged and remains the escape hatch for an
  operator who knowingly wants the box gone.

### What follow does not touch

- **The box's `host`.** If the guest's address changed on the destination cluster, the box reads
  "PVE running, SSH unreachable" and the operator fixes the host with Edit box. Tmuxifier has not
  proven the new address and does not guess one.
- **`netboxIpId`** travels with the link unchanged: the NetBox record describes an address, not a
  cluster.
- **`known_hosts`.** A migrated guest keeps its host key; nothing is forgotten.
- The `mismatch` rule, template refusal, in-cluster node auto-follow and `healGroup` behave
  exactly as before.

### UI

One wording change, in `proxmoxGuests.ts`'s deprovision dialog for a `missing` guest:

> Proxmox reports this guest missing on its linked cluster. If it moved to another cluster,
> Tmuxifier re-links it automatically and deprovision will be refused. Otherwise only the stale
> linked box is removed.

The 409 renders in the dialog's existing error line. No other web change; a followed guest simply
shows its new host profile, node and vmid in the Guests tab on the next poll.

### Untrusted input

Everything read from a cluster is treated as input, the posture `status.js` takes toward box
output: candidate node via `SAFE_NODE`, vmid range-checked, name allowlisted before it is compared
or stamped, MAC normalized and pattern-checked, a missing or malformed `net0` never matching.
The stamped value is never client-supplied — no route accepts `fp`, and `PUT /api/boxes/:id/proxmox`
builds its link object field by field — so the shape check lives where the value is produced
(`fingerprintComplete` in `proxmoxParams.js`) and is re-applied on every read of it.

## Files touched

- `src/server/proxmoxParams.js` — `normalizeMac`, `macOfNet0`, `cleanGuestName`, `fingerprintComplete`.
- `src/server/proxmoxInventory.js` — per-refresh resource cache, `followAcrossClusters`, `fp`
  backfill and name refresh, `refreshBox({ follow })`, `findFollowCandidates`.
- `src/server/proxmoxLifecycle.js` — `follow: false` pre-check, deprovision-from-`missing` guard in
  `createJob` and `runDeprovision`.
- `src/web/proxmoxGuests.ts` — the dialog wording.
- `docs/proxmox.md` — a "Moving guests between clusters" section: the delete-source PDM workflow,
  what follows and what does not (the box address), and why deprovision may refuse.
- `CLAUDE.md` / `AGENTS.md` — the `proxmoxInventory.js` and `proxmoxLifecycle.js` entries.

## Testing

TDD with real code. The inventory tests get a `makeClient(host)` returning per-cluster fake
`clusterResources`/`guestConfig`, keyed by host id.

- `macOfNet0`: LXC `hwaddr`; QEMU model-key form for `virtio`, `e1000`, `vmxnet3` and an unknown
  model; lowercase normalized; empty, unparseable, missing and malformed values → `null`.
- Follow, positive: exactly one match on another profile re-homes `hostId`/`node`/`vmid`/
  `endpoint` and keeps `kind`/`fp`/`netboxIpId`; a match on the link's own profile under a new
  vmid also follows; the refresh's returned record reflects the new cluster.
- Follow, negative — each writes nothing: zero matches; two matches; a locked candidate; a
  template; a candidate linked to another box; a kind mismatch; a name mismatch; a MAC mismatch;
  a link without `fp` or with half an `fp`; an active lifecycle job; the box re-linked between
  snapshot and write (CAS); `setProxmoxLink` throwing `already linked`.
- De-duplication: the same guest seen through two profiles with identical endpoints counts once;
  two `missing` boxes sharing one candidate both stay put.
- Cost: a `missing` link with no name-matching candidate triggers no `guestConfig` call; a profile
  fetched for its own boxes is not fetched again for the search.
- Backfill: stamps `fp` once and never re-reads config once complete; refreshes `fp.name` on a
  rename without reading config; a failed config read stamps nothing and retries next refresh;
  respects the active-job guard and CAS; a guest with no usable `net0` is read once, not per poll.
- An unreadable host profile: no follow, and `findFollowCandidates` names it in `unreachable`.
- `refreshBox(box, { follow: false })` writes neither a re-home nor a stamp.
- Deprovision guard: `createJob` 409s with one candidate, with several, and with an unreachable
  profile; a link without `fp` never calls `findFollowCandidates`; `runDeprovision`'s
  `missing` branch fails the job without calling `knownHosts.forget`, the NetBox release, or box
  removal when a candidate appears after the job was created; with no candidate, today's
  behaviour is unchanged.
- Untrusted input: malformed node, out-of-range vmid, disallowed name characters and malformed
  MAC in candidate data are never matched or stamped.

## Live validation

Before merge, on the live app (the standing validate-on-live workflow):

1. Link a throwaway container on `cluster-a`; confirm the next poll's backfill stamped `fp`.
2. PDM-migrate it to `cluster-b` with delete-source.
3. During the window before the next poll, a Deprovision attempt is refused with the found-on
   message.
4. On the next poll the inventory log shows the move and the Guests tab shows the guest on
   `cluster-b`; its terminal still connects.
5. Clean up: deprovision the guest from its new cluster.

## Out of scope

- Following when the source is kept (`stopped` twin).
- Proxmox Datacenter Manager as a host profile type (one PDM token instead of per-cluster tokens).
- Rewriting the box's address after a move.
- NICs other than `net0`.
- Health events or notifications for a move.

## Amendments (final review, 2026-10-05)

The whole-branch review found gaps in the design above; the sections above are left as written and
these amend them.

- **A(a) Endpoint exclusion.** "Already linked to another box" is keyed by the other link's stamped
  `endpoint`+vmid as well as `hostId`+vmid. A second host profile for the same cluster (an alias,
  same endpoint) otherwise names a linked guest under a different id, and two boxes could end up on
  one guest — deprovisioning either would destroy the other's.
- **A(b) Fingerprint twins.** Another box whose link carries a complete `fp` with the same kind and
  MAC makes the guest contested, whatever that box is linked to — this is what covers an alias
  profile reached through a *different* node endpoint, which no id or endpoint key can see. The
  follow does not follow and logs the twin's label; `findFollowCandidates` returns it as `twins`,
  and deprovision from missing refuses with `box <label> carries the same fingerprint — re-link or
  remove one of them first`. Because the search reads the whole fleet, this also holds for a
  single-box refresh, which never sees the per-refresh claims check.
- **A(c) Stamp before follow.** Each refresh runs the stamp step before the follow, so a box linked
  in the same poll already carries its `fp` when another box checks for twins.
- **B Locked guests.** A same-kind, same-name, otherwise valid guest carrying a PVE `lock` is
  reported as `locked: [{ hostId, hostName, vmid }]` rather than skipped silently. The follow
  treats any as "do not follow" (it could be the real target, mid-migration), and deprovision from
  missing refuses with `guest may be mid-migration: <hostName> vmid <vmid> is locked — retry
  shortly, or remove the box instead`. Refusal precedence: one match, several matches, twins,
  unreachable, locked.
- **C Concurrency.** After the endpoint de-duplication, every profile's resource list is read
  concurrently, then every candidate's config, so an unreachable profile costs one API timeout per
  sweep instead of one per profile in turn. Result order is unchanged.
- **D2 Node auto-follow writes from the fresh link.** The same-cluster node follow writes
  `{ ...freshLink, node }` (the link it already re-reads for its CAS), not the poll's snapshot, so a
  concurrently stamped `fp` is never erased.
