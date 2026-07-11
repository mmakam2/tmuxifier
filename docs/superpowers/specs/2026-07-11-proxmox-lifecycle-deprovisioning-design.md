# Proxmox linked-container state and lifecycle — design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-06-26-proxmox-lxc-provisioning-design.md` and
`2026-07-10-preset-master-detail-design.md`

## Goal

Make boxes with a verified Proxmox LXC association state-aware and manageable from Tmuxifier.
Externally stopped containers must appear grey as **Stopped**, not red as an SSH connection
failure. The Proxmox hub gains a central Containers view with Start, Shutdown, Stop, Reboot, and
Deprovision actions. Every action is a persisted job. Deprovisioning gracefully shuts down a
running container, destroys it and its attached volumes, preserves independent backup archives,
then removes the linked Tmuxifier box.

Both Tmuxifier-provisioned boxes and boxes manually associated through Edit Box receive the same
lifecycle capabilities. Automatic hostname/IP inference is deliberately excluded.

## Decisions

- Use dedicated inventory and lifecycle services; do not generalize the stable provisioning state
  machine or its persisted job shape.
- A box's stored `proxmox: { hostId, node, vmid, endpoint }` association is the lifecycle source of
  truth. Automatically provisioned and manually associated boxes use the same shape.
- Only provisioning and a dedicated, server-verified association route may create or change this
  linkage. Generic box PATCH/import input cannot grant lifecycle control.
- Grey means PVE has recently and successfully confirmed `stopped`. PVE lookup failure plus SSH
  failure remains a red connection issue.
- Full lifecycle controls live in a central Proxmox **Containers** tab, not in Edit Box. Edit Box
  owns association, reassociation, and unlink only.
- Every lifecycle action is a persisted job. Browser closure does not affect execution; an active
  job becomes `interrupted` after a server restart, matching provision-job reconciliation.
- Deprovision uses graceful shutdown with no automatic force escalation. After a shutdown failure,
  the operator must deliberately run Stop and then retry Deprovision.
- Deprovision requires typing the current box label exactly. On successful PVE destruction, the
  linked Tmuxifier box is removed automatically.
- Destroy the container and its attached volumes. Keep independent Proxmox backup archives.
- Keep Provision and its manager/store unchanged. The existing History tab becomes Activity and
  displays both provision and lifecycle job sources.

## Architecture

### `src/server/proxmoxInventory.js` — inventory and state authority

Create an injected factory responsible only for reading and indexing PVE LXC inventory:

```js
createProxmoxInventory({
  proxmoxStore,
  makeClient,
  now,
  freshnessMs,
}) -> {
  refreshLinked(boxes),
  getLinkedContainers(boxes),
  listNodeContainers(hostId, node),
  stateFor(box),
}
```

`refreshLinked(boxes)` extracts verified `box.proxmox` links, groups them by `hostId + node`, and
issues one `client.listLxc(node)` request for each distinct group. A node response is indexed by
numeric VMID and joined back to boxes. Concurrent refresh calls coalesce so status polling and a
browser refresh do not duplicate PVE traffic.

An inventory record contains only non-secret operational data:

```js
{
  boxId, boxLabel,
  hostId, hostName,
  node, vmid,
  containerName,
  state: 'running' | 'stopped' | 'missing' | 'unknown',
  fetchedAt,
  error: null | string,
}
```

The inventory may retain the last successful snapshot for display, but only data newer than
`freshnessMs` may override SSH state as confirmed stopped. A failed refresh immediately makes the
management state `unknown` for status-merging purposes; stale `stopped` data must not suppress a
real outage.

`listNodeContainers(hostId, node)` is the manual-association browse path. It resolves the redacted
host to its server-side token, lists that node's LXCs, and annotates each result with
`linkedBoxId | null`. The server, not the browser, decides whether a container is already linked.

### Status integration

Extend `createStatusPoller` with one injected enrichment step rather than teaching the SSH status
checker about Proxmox:

```js
createStatusPoller({
  ...,
  enrichSnapshot: async ({ boxes, snapshot }) => enrichedSnapshot,
})
```

Each poll starts the inventory refresh and bounded SSH probes in the same cycle. After both settle,
`enrichSnapshot` projects recent PVE state into the cached `/api/status` snapshot. Health history
records the enriched snapshot so a planned stop does not generate a false box-down event.

Add optional status fields:

```ts
proxmoxState?: 'running' | 'stopped' | 'missing' | 'unknown';
proxmoxNode?: string;
proxmoxVmid?: number;
```

Merge truth table:

| PVE result | SSH result | Dashboard result |
| --- | --- | --- |
| Fresh `stopped` | any | Grey **Stopped**; do not present an SSH error |
| `running` | reachable | Existing green state |
| `running` | unreachable | Existing red connection issue |
| `unknown` / PVE failure | unreachable | Existing red connection issue |
| `missing` | reachable | Existing reachable state plus **PVE link missing** metadata |
| `missing` | unreachable | Red **Container missing** |

Selecting a confirmed-stopped box does not attempt to open a terminal. The stage shows a compact
Stopped message and a command that opens the Proxmox Containers tab focused on that box.

### `src/server/proxmoxLifecycle.js` — persisted action state machine

Create a separate injected lifecycle manager:

```js
createProxmoxLifecycleManager({
  boxStore,
  proxmoxStore,
  inventory,
  makeClient,
  removeLinkedBox,
  load,
  save,
  now,
  makeId,
  sleep,
  pollMs,
  taskTimeoutMs,
  shutdownTimeoutMs,
  maxPollFailures,
  maxJobs,
  maxLogBytes,
}) -> {
  createJob({ boxId, action, confirmName }),
  getJob(id),
  listJobs(),
  hasActiveJob(boxId),
  _settled(id),
}
```

Supported actions are `start`, `shutdown`, `stop`, `reboot`, and `deprovision`. `createJob` resolves
the box and its current verified link server-side. It never accepts a host id, node, or VMID from
the lifecycle request body. Only one running lifecycle job may target a linked container; a second
request returns a conflict.

The manager copies the provision manager's bounded task-log polling behavior, including consecutive
poll-failure tolerance and timeouts, without importing or modifying the provision manager.

### `src/server/proxmoxLifecycleStore.js`

Persist lifecycle jobs to `data/proxmox-lifecycle-jobs.json` using the debounced atomic-write
pattern in `provisionStore.js`. The file is already covered by the gitignored `data/` directory and
contains operational history, never tokens or passwords. Retention and log sizes are bounded by the
manager.

### Shared linked-box removal

Extract the existing box deletion orchestration into one injected operation used by both
`DELETE /api/boxes/:id` and lifecycle deprovision cleanup. It must:

1. Close interactive and `provision:<boxId>` session entries.
2. Best-effort dispose relevant SSH/tmux resources without making local deletion depend on an
   already-destroyed container being reachable.
3. Remove the box from `boxes.json`.

The lifecycle manager invokes this operation only after PVE destruction is confirmed.

## Link security and data ownership

Association grants permission to destroy a real container, so linkage is trusted server state, not
ordinary editable box metadata.

- Add a pure validator for `{ hostId, node, vmid }`: configured host id, safe node identifier, and
  integer VMID in the existing `100..999999999` range.
- `PUT /api/boxes/:boxId/proxmox` resolves the host with its secret, confirms the node/container via
  PVE, and rejects a target linked to a different box.
- `DELETE /api/boxes/:boxId/proxmox` removes association only. It never changes PVE state.
- Reassociation performs the same live checks and atomically replaces the old link.
- Generic `PATCH /api/boxes/:id` must reject or ignore `proxmox` and `source` mutations from the
  browser.
- Box import strips `proxmox` linkage and cannot import `source: 'proxmox'` as lifecycle authority.
  An imported box must be re-associated through Edit Box.
- Provisioning remains a trusted internal link writer after PVE create succeeds.
- Removing a Proxmox host profile does not delete containers or boxes. Existing links become
  unavailable until the host is restored or the box is reassociated/unlinked.

The stored `endpoint` remains a diagnostic snapshot for provisioned legacy boxes, but lifecycle
operations always resolve the current host profile by `hostId`; they never send tokens or actions
to the snapshot endpoint.

## Lifecycle behavior

### State gates

Every action refreshes inventory before issuing a mutation:

| Action | Required state | PVE sequence | Expected final state |
| --- | --- | --- | --- |
| Start | stopped | start → poll task | running |
| Shutdown | running | graceful shutdown → poll task/state | stopped |
| Stop | running | immediate stop → poll task/state | stopped |
| Reboot | running | reboot → poll task/state | running |
| Deprovision | running, stopped, or missing cleanup | shutdown when needed → destroy/verify | missing, then local box removed |

Invalid transitions fail with an HTTP/job conflict rather than silently becoming success. Unknown
management state disables mutations until a refresh succeeds. Stop is explicitly labeled as an
immediate/forceful power action in the UI.

### Deprovision state machine

Deprovision requires `confirmName` to equal the linked box's current label exactly. The server
performs this comparison again when creating the job; client-side button disabling is only an
affordance.

Phases:

1. `resolve` — re-read box/link/host and refresh target state.
2. `shutdown` — if running, request graceful shutdown, poll its UPID, and wait for confirmed
   stopped until `shutdownTimeoutMs`. If already stopped, skip this phase.
3. `destroy` — issue the supported PVE LXC delete operation for the container and its configured
   attached volumes. Do not enumerate or delete backup archives.
4. `verify` — poll the destroy task and refresh until the VMID is absent.
5. `unlink` — invoke shared linked-box removal.
6. `done` — persist successful completion.

Shutdown failure or timeout ends the job in error. Deprovision never calls the forceful Stop API
automatically. The operator can inspect the error, deliberately run Stop, and retry Deprovision.

Destroy failure preserves the Tmuxifier box/link. If PVE reports the linked VMID already absent,
the same typed confirmation permits idempotent local cleanup. If destroy succeeded but local box
removal failed, retry resumes the missing-container cleanup path rather than trying to destroy a
different target.

### Job model

```jsonc
{
  "id": "uuid",
  "action": "start | shutdown | stop | reboot | deprovision",
  "boxId": "uuid",
  "boxLabel": "snapshot",
  "hostId": "uuid",
  "hostName": "snapshot",
  "node": "pve",
  "vmid": 100,
  "status": "running | done | error | interrupted",
  "phase": "resolve | request | shutdown | destroy | verify | unlink | done",
  "log": "bounded task log",
  "error": null,
  "createdAt": "ISO",
  "finishedAt": null
}
```

The target snapshot makes history useful after the box is removed. Tokens, passwords, and raw host
objects are never persisted. Startup reconciliation converts `running` jobs to `interrupted`; it
does not blindly replay destructive operations after a restart. Inventory shows the actual current
container state, after which an operator can safely retry.

## Proxmox client surface

Add narrowly named methods to `createProxmoxClient`:

```js
listLxc(node)
startLxc(node, vmid)
shutdownLxc(node, vmid)
stopLxc(node, vmid)
rebootLxc(node, vmid)
destroyLxc(node, vmid)
taskStatus(node, upid)       // existing
taskLog(node, upid, start)   // existing
```

`destroyLxc` uses PVE's supported LXC delete semantics to remove the container configuration and
attached container volumes. It must not enumerate or delete independent backup archives. All path
segments remain `encodeURIComponent` encoded, requests use the existing TLS pin/CA/insecure modes,
and PVE error details flow through the existing sanitized error path.

The configured token documentation must add the PVE audit/power-management/deletion privileges
required by inventory and lifecycle actions. Tokens remain server-only.

## REST API

All routes use `requireAuth`, the existing trusted-origin/CSRF hook, and `no-store` behavior.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/proxmox/containers` | — | linked container views for the Containers tab |
| GET | `/api/proxmox/hosts/:hostId/nodes/:node/containers` | — | node LXCs with `linkedBoxId` annotation |
| PUT | `/api/boxes/:boxId/proxmox` | `{ hostId, node, vmid }` | verified updated box/link |
| DELETE | `/api/boxes/:boxId/proxmox` | — | unlinked box; PVE unchanged |
| POST | `/api/proxmox/lifecycle-jobs` | `{ boxId, action, confirmName? }` | created running job (201) |
| GET | `/api/proxmox/lifecycle-jobs` | — | newest-first job summaries |
| GET | `/api/proxmox/lifecycle-jobs/:id` | — | full lifecycle job |

Error mapping:

- 400: malformed link/action/confirmation input.
- 404: box, host profile, container, or job not found where absence is not the deprovision cleanup
  case.
- 409: duplicate association, invalid state transition, confirmation mismatch, or active job for
  the same container.
- 502: PVE authentication, TLS, API, or network failure before a job can be created.

Once a valid asynchronous job exists, operational failure is persisted on the job as `status:
'error'` and observed through polling rather than changing the already-returned HTTP response.

## Web client

### Proxmox hub

Change the hub tabs to:

```text
Containers | Presets | Provision | Activity
```

Containers is the default operational view and belongs in a focused `proxmoxContainers.ts`
module. Each linked-container row shows box label, host name, node/VMID, state, and any active job.
Controls are stable and state-aware:

- Stopped: Start, Deprovision.
- Running: Shutdown, Stop, Reboot, Deprovision.
- Missing: Start/Shutdown/Stop/Reboot disabled; allow typed-confirmation Deprovision cleanup plus
  refresh and navigation to Edit Box for unlink/change.
- Unknown: all mutations disabled until a live PVE refresh succeeds.

Stop is visually marked as immediate/forceful. Deprovision is the destructive action and opens a
dedicated confirmation modal. The modal shows box, host, node, VMID, the shutdown→destroy→remove
sequence, attached-volume loss, backup retention, and automatic box removal. Its submit control is
disabled until the exact current box label is typed.

Activity replaces provision-only History. It fetches provision and lifecycle summaries in parallel,
adds a source/action discriminator, merges by `createdAt`, and routes detail clicks to the existing
provision panel or a lifecycle job detail renderer. Lifecycle detail polling follows the existing
1.5-second job-panel pattern and stops at a terminal status.

### Edit Box association

Add a Proxmox association section to Edit Box:

- Unlinked: Link button reveals Host → Node → Container dependent selects.
- Linked: show host, node, VMID, container name/state plus Change association and Unlink commands.
- Container options show VMID, name, state, and exclude/disable targets linked to another box.
- Changing a select invalidates and reloads all dependent choices.
- Loader errors render inline and cannot save a guessed target.
- Unlink confirmation states explicitly that the container is not stopped or destroyed.

### Dashboard state

Extend `Status` and the pure `statusDot`/metadata helpers. Fresh `proxmoxState: 'stopped'` maps to a
grey dot and **Stopped** tooltip/meta. A missing link with unreachable SSH maps to red **Container
missing**; if SSH remains reachable, retain the reachable dot and add **PVE link missing** metadata.
Unknown does not hide the existing SSH error. Selecting stopped does not create a
terminal/WebSocket; it renders a stopped-state stage with an **Open Proxmox** command that selects
Containers and focuses the linked box.

## Error handling and concurrency

- Inventory requests are grouped by host/node and coalesced in flight; browser tab count never
  multiplies PVE traffic.
- Inventory timeout/failure cannot blank `/api/status`; it removes management authority from that
  sweep and preserves SSH-derived availability.
- Lifecycle task polling tolerates a configured number of consecutive request failures, then records
  an error. Logs and job count are bounded.
- Active-job exclusion is keyed by canonical `hostId/node/vmid`, not only box id, so a reassociation
  race cannot start two operations on one container.
- Association changes/unlink are rejected while that target has an active lifecycle job.
- Lifecycle jobs re-read box/link/host before mutation. A changed link makes the job fail safely
  before issuing a PVE action.
- Box removal is after verified destroy only. PVE failure never silently deletes local state.
- The Containers UI refreshes after every terminal job and after association changes.

## Testing

All server work is TDD with injected dependencies and real module behavior.

### Unit tests

- `proxmoxInventory`: grouping by host/node, exactly one request per group, in-flight coalescing,
  VMID indexing, missing containers, duplicate links, freshness expiry, and failed-query fallback.
- `statusPoller` and `statusDot`: the complete merge truth table, history receives enriched state,
  stopped suppresses false down events, and PVE failure does not produce grey.
- Association validation/store behavior: dedicated trusted link writes, live target verification,
  duplicate rejection, reassociation, unlink, generic PATCH rejection, and import stripping.
- `proxmoxApi`: list/start/shutdown/stop/reboot/destroy method/path/body contracts and PVE errors.
- `proxmoxLifecycle`: every state gate; single-active-job exclusion; task/log polling; bounded logs
  and history; restart reconciliation; target/link revalidation; and terminal error states.
- Deprovision: exact-name confirmation, already-stopped shortcut, graceful shutdown sequence,
  timeout without force escalation, destroy/verify/unlink ordering, attached-volume destroy request,
  no backup enumeration, local preservation on PVE failure, automatic removal after success,
  missing-container cleanup, and cleanup retry idempotency.

### Route/client tests

- 401 auth, trusted-origin rejection, 400/404/409/502 mapping, redacted responses, and lifecycle
  request bodies that never accept target coordinates.
- Node container browse and linked-container views never return host secrets.
- TypeScript fetch methods send exact verbs/paths/bodies and surface server errors.

### UI verification

- `npm run typecheck`, `npm test`, and `npm run build` remain green.
- Desktop/mobile browser walkthrough: manual association, duplicate prevention, stopped grey state,
  terminal suppression, all state-gated controls, Activity merging/polling, typed deprovision
  confirmation, graceful failure recovery, Stop-then-retry, automatic box removal, missing target,
  and PVE-unavailable fallback.

## Documentation and configuration

- Update `AGENTS.md` and `CLAUDE.md` with the new inventory/lifecycle/store and web modules.
- Update README/DEPLOY guidance with the added Proxmox token privileges and lifecycle safety model.
- Add `data/proxmox-lifecycle-jobs.json` to the documented runtime-state inventory; it is created at
  runtime under the existing gitignored `data/` directory.
- Add no configuration knobs in this phase. Lifecycle task polling uses `pvePollMs`; individual PVE
  HTTP calls use `pveTimeoutMs`; task and graceful-shutdown deadlines use
  `pveProvisionTimeoutMs`; lifecycle retention uses `pveMaxJobs`; bounded lifecycle logs default to
  the provision manager's existing 65,536-byte limit. Inventory display freshness is injected as
  `statusPollMs * 2`, while only a successful current sweep may override SSH as stopped. Tests inject
  shorter values directly into the factories.

## Out of scope

- Automatic association by hostname, IP, MAC address, or VMID guessing.
- Inventory/lifecycle management for unlinked Proxmox containers.
- VM/QEMU lifecycle management; this design is LXC-only.
- Deleting independent backup archives.
- Automatically force-stopping a guest during Deprovision.
- Resuming/replaying an in-flight destructive PVE task after a Tmuxifier process restart.
- Migrating or merging `provision-jobs.json` with lifecycle history.
