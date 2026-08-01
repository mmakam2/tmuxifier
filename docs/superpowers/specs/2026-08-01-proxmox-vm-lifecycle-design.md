# Proxmox VM (qemu) lifecycle support — design

**Date:** 2026-08-01
**Status:** approved, not yet implemented

## Problem

Tmuxifier's Proxmox integration treats "linked guest" and "LXC container" as the same
thing. A box can be linked only to a container, and the lifecycle actions
(start / shutdown / stop / reboot / deprovision) can act only on a container. An operator
running VMs on the same cluster gets nothing: the VMs are invisible in the association
picker, absent from the Containers tab, and unmanageable from the dashboard.

The LXC assumption is hardcoded in four places:

- `proxmoxApi.js:85-97` — every guest endpoint is a literal `/lxc/` path
  (`startLxc`, `shutdownLxc`, `stopLxc`, `rebootLxc`, `destroyLxc`, `listLxc`).
- `proxmoxLifecycle.js:86` — dispatch is string concatenation: `` `${job.action}Lxc` ``.
- `proxmoxInventory.js:75,114` — `/cluster/resources?type=vm` already returns **both**
  qemu and lxc guests, and both call sites filter to `g.type === 'lxc'` and discard
  the rest.
- The stored link (`{ hostId, node, vmid, endpoint?, netboxIpId? }`) carries no guest
  kind, and `assertProxmoxLinkInput` (`proxmoxValidate.js:155`) does not validate one.

## Scope

**In scope:** linking a box to an existing VM, reporting VM state, and running the five
existing lifecycle actions against it.

**Out of scope:** provisioning new VMs. qemu has no `vztmpl` equivalent, so VM creation
needs clone-from-template, cloud-init, and guest-agent-based IP discovery instead of
`/lxc/:vmid/interfaces`. Presets would grow an entire second shape. `createLxc` and
`lxcInterfaces` therefore keep their LXC-specific names and remain LXC-only.

## Decisions

### The guest kind is stored on the link, not derived

The link gains `kind: 'lxc' | 'qemu'`.

The alternative — deriving the kind from the cluster payload at the moment of use — works
mechanically. `/cluster/resources?type=vm` reports `g.type` for every guest, and both
`runRoutine` and `runDeprovision` call `inventory.refreshBox(box)` before issuing anything,
so the kind is always in hand exactly when it is needed. It would need no migration and no
validator.

It is rejected because it cannot see one failure mode:

> Destroy container 105. Create VM 105. Leave the stale box link in place.

A derived kind has nothing to compare against. It refreshes, finds a guest at vmid 105,
reads its type as `qemu`, and runs the operator's Deprovision against an unrelated VM. A
stored kind disagrees with the observed one, and that disagreement is detectable.

### A kind mismatch refuses; it never auto-follows

This deliberately breaks symmetry with the existing node drift-follow. A container that
migrated is *the same guest on a new node*, so following it is correct. A vmid whose type
changed is *a different guest wearing the same number*, so following it is precisely the
"silently repoint at a stranger" bug. It gets the treatment `knownHosts.js` gives a changed
SSH host key: surface it, require the operator to re-link, never resolve it automatically.

### Deprovision escalates to a hard stop; plain shutdown does not

PVE's `shutdown` on a VM is an ACPI power-button press or a guest-agent call. A VM whose OS
ignores ACPI — no agent, sitting at a bootloader, hung kernel — never stops. With today's
`shutdownTimeoutMs` defaulting to `taskTimeoutMs` (10 minutes), `runDeprovision` would stall
for ten minutes and then fail with the guest still running.

Both `/lxc/…/status/shutdown` and `/qemu/…/status/shutdown` accept `forceStop` and `timeout`,
so PVE performs the escalation server-side in a single call. This is preferred over a
client-side grace-then-stop sequence: one task instead of a poll loop plus a second request,
no window in which Tmuxifier and PVE disagree about what is running, and the escalation is
visible in the task log the operator can already read.

- **`shutdown` action** → `forceStop: false`, no timeout override. A graceful shutdown that
  fails, fails.
- **deprovision's internal shutdown** → `forceStop: true`, `timeout: deprovisionGraceSec`
  (default 120, injectable).

This changes LXC deprovision as well as VM deprovision. That is intended: a wedged container
could already stall a deprovision for the full timeout and then fail with the guest up, and
the justification — the guest's disk is about to be purged, so a clean unmount is moot —
holds for both kinds.

### Destroy semantics are unchanged

`purge=1` and `destroy-unreferenced-disks=1` for both kinds, matching what LXC deprovision
does today and what the confirm dialog already promises.

### "Container" is renamed to "guest" throughout, including API paths

PVE's own umbrella term for both types is *guest*. Once VMs appear in it, every occurrence
of "container" in this subsystem is wrong. The rename covers routes, TypeScript types, CSS
classes, and method names.

## Design

### Data model

```
link = { hostId, node, vmid, endpoint?, netboxIpId?, kind }
kind ∈ { 'lxc', 'qemu' }
```

Migration is a no-op by construction: `store.js`'s `normalize` fills an absent `kind` with
`'lxc'`, so every link already in `boxes.json` becomes what it already is. Nothing rewrites
the file, no version bump is needed, and a downgrade to the previous release ignores the
extra field.

`assertProxmoxLinkInput` accepts an absent kind (which then defaults) and requires an
explicit kind to be one of the two. A stale client that omits kind while linking a VM
produces an `lxc` link — wrong, but detectably wrong, landing in the refuse path rather
than executing anything.

`linkKey` stays `hostId\0node\0vmid`. vmid is cluster-unique, so two links differing only
in kind necessarily point at the same guest and one of them is wrong; adding kind to the key
would let both exist.

Mismatch reporting rides the existing state machine rather than a parallel channel. The
inventory record gains an observed `kind`, and `state` gains a fifth value, `'mismatch'`.
The existing lifecycle guards then reject it for free:

- `createJob`'s `current.state !== REQUIRED[action]` refuses every routine action.
- `createJob`'s `!['running','stopped','missing'].includes(current.state)` refuses deprovision.
- `actionsForState('mismatch')` returns `[]`, and the guests tab already appends **Edit link**
  for non-actionable states.

An explicit early check is still added in `createJob`, `runRoutine`, and `runDeprovision` —
not for control flow, but for the message. Falling through to `"start requires stopped"`
when the real problem is "vmid 105 is a VM and this box is linked to a container" sends the
operator debugging the wrong thing.

### API client (`proxmoxApi.js`)

The six hardcoded `/lxc/` guest methods become kind-parameterized:

```
startGuest(kind, node, vmid)
shutdownGuest(kind, node, vmid, { forceStop = false, timeout = null } = {})
stopGuest(kind, node, vmid)
rebootGuest(kind, node, vmid)
destroyGuest(kind, node, vmid)
listGuests(kind, node)
```

Each builds `/nodes/${enc(node)}/${kind}/${enc(vmid)}/…`. `kind` is validated against the
closed two-value set **inside the client**, immediately before it becomes a path segment,
rather than trusting that every caller validated it — the same chokepoint discipline
`voiceCatalog.js` and `iconCatalog.js` apply to anything reaching a URL or a script.

No back-compat aliases: each of the six has exactly one caller. `createLxc` and
`lxcInterfaces` are unchanged.

### Inventory (`proxmoxInventory.js`)

1. **`fetchHost` stops discarding VMs.** `byVmid` is built from
   `g.type === 'lxc' || g.type === 'qemu'`. Once a guest is found, `item.type` is compared
   against `box.proxmox.kind`; unequal yields `state: 'mismatch'` with an error naming both
   kinds and the vmid.

2. **Mismatch suppresses the node drift-follow.** The drift-follow block sits above where
   the record is built, so without a guard a mismatched vmid would rewrite the stored link's
   node on its way to being refused — quietly repointing the box at the stranger's node while
   reporting that it refused to act. One condition, load-bearing: this vmid may not be our
   guest at all, so nothing about it may be written back.

3. **`record()` gains `kind`,** defaulting to the link's kind so `missing`, `unknown`, and
   error records report what we believe the guest is rather than null. When a guest is
   actually observed the observed type wins, including on mismatch — a badge reading "VM"
   beside an error saying "you linked a container" is the honest reading.

4. **`healGroup` matches on kind.** Its presence set becomes vmid → type, and re-homing an
   orphaned link to a re-added host profile requires the type to match as well as the vmid to
   exist. A vmid that came back as the other type degrades to the plain orphan record — the
   same "never guess" posture the function already takes toward zero or multiple endpoint
   matches.

5. **`listNodeContainers` becomes `listNodeGuests`,** calling `listGuests('lxc', node)` and
   `listGuests('qemu', node)` under `Promise.all`, tagging each result with its kind and
   merging sorted by vmid so the picker is not all containers followed by all VMs. Both calls
   must succeed: PVE permissions are path-based on `/vms/<vmid>` and do not distinguish guest
   type, so "can list containers but not VMs" is not a configuration a real token can have,
   and any token permitted to destroy a container can enumerate both.

6. **`mergeProxmoxStatus` carries `proxmoxKind`** alongside the existing state/node/vmid, so
   the sidebar and dashboard can badge CT vs VM without a second fetch.

### Lifecycle manager (`proxmoxLifecycle.js`)

- **Dispatch:** `` `${job.action}Guest` `` and `client[method](job.kind, job.node, job.vmid)`.
  The concat stays — `ACTIONS` validates the action and `deprovision` branches off in `run()`
  before the lookup, so only the four routine verbs reach it.
- **Kind comes from the link, not the refreshed record** — deliberately unlike `node`, which
  is snapshotted from `current.node` precisely because it drift-follows. Kind does not
  drift-follow; the link is its authority, and the refresh's role is only to have already
  proven the two agree.
- **`createJob`** gains an explicit mismatch refusal ahead of the `REQUIRED[action]` check,
  plus `kind` in the job record and in `summary()`.
- **`resolveTarget` compares kind** as well as `targetKey`. `targetKey` stays as-is — it is
  about job-collision identity, which vmid uniqueness already settles — but re-linking to the
  same hostId/node/vmid with a different kind is exactly the case `targetKey` cannot see.
  `server.js:1202` already refuses to relink a box with an active job, so this is
  belt-and-braces, which is what that check already was.
- **Deprovision** uses `{ forceStop: true, timeout: deprovisionGraceSec }` on its shutdown and
  `destroyGuest` on its destroy. The subsequent `waitForState(job, 'stopped', …)` stays:
  `forceStop` means PVE's task completes only once the guest is genuinely stopped, so the wait
  collapses to a fast confirmation — but it remains the check that PVE's task-success matches
  observable reality, the pattern used at every other phase boundary here.
- **History rows load `kind` defaulting to `'lxc'`.** Every job in an existing
  `proxmox-lifecycle-jobs.json` acted on a container, so the default states a fact rather than
  guessing. Loaded jobs are forced terminal anyway, so the value is only read for display.

New constructor knob: `deprovisionGraceSec = 120`.

### Web client and rename sweep

Touched files: `proxmoxUi.ts`, `main.ts`, `style.css`, `proxmoxContainers.ts`, `dashboard.ts`,
`proxmox.ts`, `paneLifecycle.ts`, `proxmoxAssociation.ts`, `server.js`, `proxmoxInventory.js`,
and the tests `proxmoxWebClient.test.js`, `server.test.js`, `proxmoxInventory.test.js`.

**Routes:** `/api/proxmox/containers` → `/api/proxmox/guests`;
`…/nodes/:node/containers` → `…/nodes/:node/guests`. `/api/proxmox/lifecycle-jobs` is already
kind-neutral and does not move.

**Types (`proxmox.ts`):** `PveContainerState` → `PveGuestState` (gaining `'mismatch'`);
`PveLinkedContainer` → `PveLinkedGuest` and `PveNodeContainer` → `PveNodeGuest`, both gaining
`kind`; `LifecycleJobSummary` gains `kind`; new `PveGuestKind = 'lxc' | 'qemu'`. Fetchers
become `pve.linkedGuests()` / `pve.nodeGuests()`.

**`proxmoxContainers.ts` → `proxmoxGuests.ts`:** `renderContainersTab` → `renderGuestsTab`,
`containerMatches` → `guestMatches`. Two behavioral additions beyond the rename:
`actionsForState` maps `'mismatch' → []`, and the search field list gains the kind label so
typing `vm` filters to VMs — that filter is already a plain substring sweep over displayed
fields, so a badge the operator can see but not search for would be an inconsistency.

**Badges:** `CT` and `VM`, PVE's own shorthand. Rendered in the guest row, and in the
sidebar/dashboard from `proxmoxKind`.

**`proxmoxAssociation.ts`:** `Draft` gains kind, the picker's **Container** field becomes
**Guest**, options render `${vmid} | CT|VM | ${name} | ${state}`, and `associationMutation`
treats a kind change as a real mutation. Without that last point, re-linking a box to a vmid
that changed type would compare equal on hostId/node/vmid and silently do nothing, leaving the
operator stuck in the mismatch state with a Save button that appears to work.

**Copy:** the deprovision dialog becomes "Deprovision guest", says *disks* for a VM and
*volumes* for a container, and states the force-stop grace, since the current text promises
only a graceful shutdown.

**CSS:** `.pve-container-{row,toolbar,search,list}` → `.pve-guest-*`.

## Testing

TDD with real code and injected dependencies, per repo convention. The lifecycle manager
already takes `makeClient`, so VM coverage costs a fake client reporting `type: 'qemu'` — no
new test infrastructure.

| File | New coverage |
|---|---|
| `proxmoxValidate.test.js` | kind allowlist; absent kind accepted and defaulting |
| `store.test.js` | normalize fills `kind`; pre-existing link reads as `lxc`; `linkKey` still collides on same vmid across kinds. Note `store.test.js:255` asserts a link with a strict `toEqual` and will need `kind` added |
| `proxmoxApi.test.js`, `proxmoxApi.integration.test.js` | both kinds' path construction; a kind outside the allowlist refused before it reaches a path; `forceStop`/`timeout` and destroy params encoded correctly |
| `proxmoxInventory.test.js` | VM discovery; `mismatch` state; mismatch does not drift-follow the node; `healGroup` requires matching kind; `listNodeGuests` merge and vmid sort; `proxmoxKind` in the status merge |
| `proxmoxLifecycle.test.js` | all four routine actions against a qemu guest; deprovision force-stop params; `createJob` mismatch refusal message; `resolveTarget` aborting on a kind change; history rows defaulting to `lxc` |
| `proxmoxRoutes.test.js`, `server.test.js` | renamed route paths |
| `proxmoxContainers.test.js` → `proxmoxGuests.test.js` | `actionsForState('mismatch') → []`; `guestMatches` filtering on kind |
| `proxmoxAssociation.test.js` | a kind-only change counts as a mutation |

### Checks that are not unit tests

Vitest runs `environment: 'node'` with no jsdom, so DOM layers are untested by design and
only the pure helpers above are reachable. The badge, the mismatch row, and the reworded
deprovision dialog therefore get no automated coverage and must be confirmed in a real
browser on the live app; server-side green is not evidence they render.

The Playwright suite does not close that gap either. `test/e2e`'s fixture has no Proxmox
host profile — `teardown.spec.ts` says so explicitly at lines 117-136 — so the guests tab
and the pane lifecycle keys render in no e2e run today. No e2e spec needs changing, and
none will catch a regression here. Browser verification on the live app is the only
coverage these surfaces get.

The CSS rename wants an explicit grep-for-zero-hits on `pve-container`, because a class hook
no stylesheet matches fails silently rather than at the type checker.

### Live validation safety

Start, shutdown, reboot, and stop are reversible on a throwaway VM. Deprovision is not — it
purges disks. Live validation of the deprovision path must use a VM created specifically to
be destroyed, never an existing one, and the target must be confirmed with the operator
before that path is run.

## Risks

- **The rename is wide and mostly mechanical**, mixing a sweep into a feature commit. Mitigated
  by the type checker for TS, the route tests for server paths, and an explicit grep for the
  CSS classes, which are the only part that fails silently.
- **Deprovision behavior changes for LXC**, not only for VMs. Deliberate and documented above;
  scope it to `kind === 'qemu'` if that turns out to be unwanted.
- **`state: 'mismatch'` widens a type consumed in several places.** The TS union catches web
  consumers; server-side, the lifecycle guards already reject unknown states by construction.
