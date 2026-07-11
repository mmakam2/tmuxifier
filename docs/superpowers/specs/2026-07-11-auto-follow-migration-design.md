# Auto-follow container migrations — design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-11-proxmox-lifecycle-deprovisioning-design.md` (linked-container inventory,
lifecycle jobs, `box.proxmox` trusted linkage).

## Goal

A linked LXC container migrated between Proxmox nodes today goes `missing` in Tmuxifier — the
link pins `{ hostId, node, vmid }` and the inventory polls only the pinned node's guest list.
This feature makes the inventory cluster-aware: it learns each container's **current** node from
PVE's cluster-wide resource list, keeps the container's state healthy across migrations, and
**auto-updates the stored `box.proxmox.node`** so lifecycle actions keep targeting the right
node. `missing` becomes cluster-certain (the vmid is absent from the whole cluster, i.e.
genuinely destroyed).

Server-side change only; no UI changes are required (the Containers tab and status merge simply
keep working across a migration).

## Approach decision

Full switch of the inventory to `GET /cluster/resources?type=vm` — one call per Proxmox host
(cluster) instead of one per (host, node) group; migration detection falls out of the data
(reported node ≠ stored node). Rejected: keeping per-node polling with a missing-triggered
cluster lookup (two API shapes to maintain, a missing-flicker during every migration, and more
API calls in steady state).

## PVE client — `src/server/proxmoxApi.js`

New method on `createProxmoxClient`:

- `clusterResources()` → `GET /cluster/resources?type=vm` — returns every guest in the cluster
  with (at least) `{ vmid, node, type: 'lxc' | 'qemu', status, name }`.

Permissions: requires `Sys.Audit`, which the README's recommended **PVEAuditor** grant at path
`/` already provides (the same grant that populates the node/storage/bridge dropdowns). The
README notes this grant is now also load-bearing for inventory.

## Inventory — `src/server/proxmoxInventory.js`

- `doRefresh` regroups linked boxes by **hostId only** (today: hostId+node). Per host: one
  `clusterResources()` call, filtered to `type === 'lxc'`, indexed by vmid.
- Record construction per linked box:
  - vmid present in the cluster list → state normalized from `status` exactly as today; the
    record's `node` is the **reported** (current) node.
  - vmid absent from the whole cluster → `state: 'missing'` (genuinely destroyed).
  - Host profile missing / API call failed → that host's boxes get `state: 'unknown'` with the
    error, exactly as today (per-host failure isolation preserved).
- `refreshBox` (used by lifecycle `waitForState`) rides the same per-host call, filtered to the
  one vmid.
- `getNodeContainers` / the association picker's per-node listing are **unchanged** — per-node
  browsing is the right UX for choosing a container, and the PUT link route's live-target
  validation keeps using it.

## Auto-follow — the drift write

When a record's reported node differs from the stored `box.proxmox.node`:

- **Guard:** skip the write while a lifecycle job is active on that box
  (`hasActiveJob(boxId)`) — rewriting the link mid-job would trip the job's `resolveTarget`
  consistency check. The next poll (≤30s) retries; jobs are minutes-bounded.
- **Write:** update the stored link via the existing server-internal trusted mutation path (the
  same trust class as provisioning's auto-link): `node` ← reported node; `hostId`, `vmid`, and
  `endpoint` are never auto-changed. The value originates from an authenticated, TLS-pinned PVE
  API response for the pinned hostId+vmid — never from a client.
- **Audit line:** one server log per follow:
  `[tmuxifier] box <label>: container <vmid> migrated <oldNode> → <newNode>`.
- **Wiring:** `createProxmoxInventory` gains an injected `hasActiveJob` predicate defaulting to
  `() => false`, late-bound in `index.js` after the lifecycle manager is constructed (the
  manager depends on the inventory, so the predicate is attached via a mutable ref/setter —
  an `index.js` wiring detail).

## Trust boundary

This adds a second server-internal trusted mutation of `box.proxmox` (alongside provisioning's
auto-link). The client-facing surfaces are unchanged: imports still strip `proxmox`, the PUT
route still validates against live containers, and no route accepts a node update without
validation. Only the node field can drift-update, and only to a value PVE reported for the
already-linked vmid on the already-linked host.

## Lifecycle interplay

- Jobs snapshot their target (`hostId`/`node`/`vmid`) at creation; the active-job guard above
  keeps the stored link consistent with a running job's snapshot.
- A migration that starts **during** a running power job makes that job's node-scoped PVE calls
  fail and the job ends `error` — accepted (concurrent migration + power action is operator
  error); the link self-heals on the next poll and the action can be retried.
- Deprovision benefits directly: it always reads the current stored link at admission, which
  the drift write has already corrected by then.

## Error handling

- `clusterResources` failure for a host → that host's records are `unknown` with the error
  (existing shape); no drift writes happen from `unknown` data.
- The drift write itself is best-effort: a store write failure logs and leaves the old node —
  the next poll retries. State display does not depend on the write succeeding (records carry
  the reported node regardless).

## Testing (TDD, real code + injected fakes)

- `proxmoxApi`: `clusterResources()` issues `GET /cluster/resources?type=vm` and returns the
  parsed data (fake `request`).
- `proxmoxInventory`:
  - Migration drift: fake client reports the vmid on a new node → record state stays healthy
    (`running`/`stopped`), record carries the new node, and the store's link node is updated
    (real temp-dir store).
  - Drift skipped while `hasActiveJob` returns true → store unchanged; record still reports the
    new node.
  - vmid absent cluster-wide → `missing`.
  - Per-host isolation: one host's `clusterResources` throwing → its boxes `unknown`, another
    host's boxes unaffected.
  - qemu entries with the same vmid namespace are ignored (`type` filter).
- Store: the trusted node-only update preserves `hostId`/`vmid`/`endpoint` and survives reload.
- Full suite green; no client tests change (no UI surface).

## Docs

- CLAUDE.md/AGENTS.md (identical edits): the `proxmoxInventory.js` bullet gains "cluster-wide
  via `/cluster/resources`, auto-follows node migrations".
- README (Proxmox section): a sentence that migrations are followed automatically, and that the
  PVEAuditor grant powers the cluster-wide inventory.

## Out of scope

- Following a container across **Proxmox host profiles** (separate clusters) — hostId never
  auto-changes.
- QEMU VM support (inventory remains LXC-only).
- A health-events entry kind for migrations (server log line only, for now).
- Any UI change (none is needed).
