# Container re-address: move a linked LXC container to a new NetBox-managed VLAN/IP

**Date:** 2026-09-02
**Status:** approved design, awaiting implementation plan

## Problem

A container provisioned with an `auto-static` preset gets its address from the NetBox prefix of
the preset's VLAN, and keeps it for life. Moving that container to another VLAN today means
deprovisioning it and provisioning again, or editing `net0` in the Proxmox UI and then fixing the
box's host, the NetBox record, and `known_hosts` by hand. The manual path leaks the old NetBox
record (it stays `active` on an address nothing uses) and leaves the new address unregistered.

## Decisions

- **Eligibility: any linked LXC container**, however it was provisioned or linked. The old address
  is released by stamped `netboxIpId` when the link carries one, and any NetBox record matching
  the old address is deleted otherwise, exactly the rule deprovision already applies. A hand-built
  container is the one most likely to need moving onto a managed VLAN.
- **Running containers are re-addressed live.** Proxmox hot-applies a `net0` change to a running
  container (re-plugs the veth with the new tag, sets the new address and gateway in the
  container's namespace) and regenerates the container's own persistent network config from
  `net0` at its next start. Open terminals drop and reconnect at the new address. A stopped
  container takes the change at its next start. No reboot.
- **A new `readdress` action in the existing lifecycle job manager**, not a separate manager or a
  synchronous route. The lifecycle manager already owns job persistence and pruning, the
  interrupted-on-boot reconcile, the mismatch/template/active-job guards, the NetBox release
  logic, the `known_hosts` wiring, and the `onContainerUp` hook; the Activity tab and the Guests
  tab's "View job" button render it with no new plumbing.

## Out of scope

- QEMU VMs (re-addressing one needs cloud-init).
- Changing the bridge. The container keeps its current bridge; only the VLAN tag, address and
  gateway change.
- IPv6. `ip6`/`gw6` keys on `net0` are preserved verbatim, never rewritten.
- Moving a container to `static` or `dhcp` mode. This feature only moves a container onto a
  NetBox-managed VLAN, allocating from that VLAN's prefix.
- Renaming the box or the container hostname.

## Server building blocks

Each addition lives in the module that already owns the concern.

### `proxmoxParams.js` — pure `net0` parsing and rebuilding

- `parseNet0(str)` splits a PVE interface string (`name=eth0,bridge=vmbr0,firewall=1,gw=…,
  hwaddr=…,ip=…,tag=20,type=veth`) into an ordered list of `[key, value]` pairs. A value-less
  token or a malformed string throws.
- `buildNet0Readdress(pairs, { vlan, ip, gateway })` rewrites only `tag`, `ip` and `gw`, keeping
  every other pair in its original order and value (`hwaddr`, `bridge`, `firewall`, `mtu`,
  `rate`, `ip6`, `gw6`, …), so the MAC and bridge never change and IPv6 is untouched. A missing
  `tag` is appended; the three managed keys are emitted at the position of the existing key when
  one exists.
- Both are pure and unit-tested (`test/proxmoxParams.test.js`).

### `proxmoxApi.js` — two client methods

- `guestConfig(kind, node, vmid)` — `GET /nodes/{node}/{kind}/{vmid}/config`. Kind re-validated
  through `guestKind()` like every other kind-parameterized method.
- `setLxcConfig(node, vmid, params)` — `PUT /nodes/{node}/lxc/{vmid}/config`. Synchronous on PVE
  for containers (no UPID), hot-applies to a running guest. Deliberately LXC-only, like
  `createLxc`.

### `netboxApi.js` — `listVlanPrefixes()`

`GET /ipam/prefixes/?limit=100`, filtered to IPv4 prefixes carrying a VLAN, shaped as
`{ vid, name, prefix, allocatable }`. A VLAN with more than one prefix is listed with
`allocatable: false` and a reason, matching the rule `findPrefixByVlan` already enforces at
allocation time. Unit-tested against a recorded fake request.

### `store.js` — `readdressBox(id, { host, netboxIpId })`

One serialized read-modify-write that sets the box `host` and `proxmox.netboxIpId` together,
leaving every other field and link key as it was, through the same `assertBoxSafe` and
`assertUniqueBox` checks as every other mutation. Two separate writes would leave a window where
the host and the allocation disagree, and `updateBox` refuses link fields by design. A `null`
`netboxIpId` is not accepted: this feature always produces an allocation.

### `proxmoxLifecycle.js` — shared NetBox release helper

The `releaseNetboxIp(job, box)` routine deprovision uses (release by stamped id, then delete
every record matching an address) is generalized to take the id and address explicitly, so the
readdress routine calls the same code with the *old* id and *old* address.

## The job

### Request and guards

`POST /api/proxmox/lifecycle-jobs` with `{ boxId, action: 'readdress', vlan }`. In `createJob`:

- `vlan` must be an integer 1..4094 (400). It is rejected (400) on every other action.
- 409 when the link's kind is `qemu`, the guest is a template or a `mismatch`, the observed state
  is anything but `running` or `stopped`, another lifecycle job is active on the target, or a
  setup job is `running` on the box (a setup streams over the SSH master this job is about to
  sever). The setup check is an injected `setupRunning(boxId)` predicate wired in `index.js` to
  `setupManager.currentForBox(id)?.status === 'running'`, the same test the `/term` gate applies.
- NetBox must be configured, checked up front the way provisioning's `requireNetboxSettings`
  does, so a misconfigured integration is a 400 with no job record.

The job record carries `vlan` (target), and as the phases fill them in: `oldIp`, `oldVlan`,
`oldNetboxIpId`, `hostname`, `ip`, `gateway`, `netboxIpId`.

### Phases

Each phase is persisted before it starts.

1. **inspect** — `guestConfig`, `parseNet0(config.net0)`; record the old IPv4 address (null for
   a dhcp interface), tag and hostname. No `net0` fails here before anything changes. A dhcp
   interface is fine: the old address used for the release sweep and the `known_hosts` removal
   is then the box's `host`, when it is an IP literal — the same source deprovision uses.
2. **allocate-ip** — `findPrefixByVlan(vlan)`, then `allocateIp` with the provisioning rule for
   `description` (`tmuxifier: <name>`) and `dns_name` (`<name>[.<dnsSuffix>]`), where `<name>` is
   the container's PVE hostname when it is a valid DNS label, else the box label for the
   description and no `dns_name`. Stamp `job.netboxIpId`, `job.ip`, `job.gateway`. Then
   `boxStore.uniquenessConflict({ host: <new address> })`: another box already at that address
   fails the job here, and the allocation just made is released.
3. **apply** — `setLxcConfig(node, vmid, { net0: buildNet0Readdress(...) })`. Any failure
   releases the new allocation and leaves the old one untouched; the container is still at the
   old address.
4. **relink** — `boxStore.readdressBox(boxId, { host, netboxIpId })`. A failure here, the only
   one after the container has moved, is reported verbatim ("container is now at X but the box
   still points at Y — edit the box host by hand") and releases nothing: both addresses are now
   genuinely in use somewhere.
5. **release** — best-effort, logged, never fails the job: the shared release helper with the old
   stamped id and the old address.
6. **verify** — `knownHosts.forget` for the new address (a NetBox-recycled IP, the provisioning
   rule) and for the old one (now free in NetBox, so its entry names an identity that has left
   that address), both best-effort and only when the value `isIP`. An injected
   `onReaddress({ before, after })` hook, wired in `index.js`, exits the old SSH ControlMaster
   (built from the old record), closes the box's terminal group so every viewer reconnects at the
   new host, and resets the status backoff; never awaited into the job's success. If the
   container was running, the existing `onContainerUp(boxId)` hook fires so the status layer
   watches for it rather than waiting out its poll interval.

### Interrupted jobs

On boot, a job left `interrupted` at phase `allocate-ip` with a stamped `netboxIpId` is an
orphaned allocation and is released (fire-and-forget, awaited by `_reconciled()` in tests),
mirroring the provision manager's reconcile. A job interrupted at `apply` or later is left alone
and its log states the allocation id as chaseable: the server cannot know whether PVE wrote the
config, and releasing an address a container is using is worse than a stale record.

## Routes

- `GET /api/boxes/:id/proxmox/net` — `{ hostname, bridge, vlan, ip, gateway }` parsed from the
  live config. 404 unknown box, 409 unlinked box or VM, 502 when PVE cannot be read.
- `GET /api/netbox/vlans` — `listVlanPrefixes()`, result-shaped like `next-ip`: unconfigured,
  undecryptable or unreachable NetBox is an `ok: false` payload the dialog renders inline, never
  a 500.
- `POST /api/proxmox/lifecycle-jobs` — existing route; the body gains `vlan` for this action.
  The route's existing refusal of `hostId`/`node`/`vmid` in the body is unchanged.
- `GET /api/netbox/next-ip?vlan=` — existing, reused for the preview.

## Web client

- `proxmox.ts`: `LifecycleAction` gains `'readdress'`; new `PveGuestNet` and `NetboxVlan` types;
  `pve.guestNet(boxId)`. `netbox.ts` gains `vlans()`.
- `proxmoxGuests.ts`: `actionsForGuest` offers `readdress` on a running or stopped LXC
  container — never on a VM, template, mismatch, missing or unknown guest. The button reads
  **Re-address** and opens the dialog rather than firing, since a VLAN must be chosen.
- `proxmoxReaddress.ts` (new; the guests file should not grow a second modal): the dialog.
  Shows the current line (`vmbr0 · VLAN 20 · 10.0.20.5/24 · gw 10.0.20.1`), a VLAN `<select>`
  built from the vlans route (`20 · servers · 10.0.20.0/24`, non-allocatable rows disabled with
  the reason), and a non-binding next-free preview from `next-ip` refreshed on every selection
  change. One warning paragraph states what happens: eth0 is re-plugged live, open terminals
  reconnect at the new address, the old address goes back to NetBox. Apply creates the job and
  hands off to the existing `showLifecycleJob` view. NetBox unconfigured or unreachable renders
  the reason with no Apply. Pure parts (`vlanOptionLabel`, `currentNetLine`, the eligibility
  rule) are unit-tested; the DOM half registers through `registerModal` like the deprovision
  dialog so logout teardown reaches it.
- When the job settles, the hub's lifecycle view already calls `onBoxLinked`, which `main.ts`
  wires to `refresh()` (a box-list refetch plus a status re-read), so the sidebar shows the new
  host without a reload. No change needed there; the plan only verifies it.

## Testing

Real code over fakes, as the repo does:

- `proxmoxParams`: `parseNet0` round-trips a real PVE line; `buildNet0Readdress` changes only
  `tag`/`ip`/`gw`, keeps `hwaddr` and IPv6 keys verbatim, appends a missing `tag`.
- `netboxApi`: `listVlanPrefixes` marks a two-prefix VLAN non-allocatable and drops IPv6 and
  VLAN-less prefixes.
- `proxmoxLifecycle`: a readdress run against recorded fake PVE and NetBox clients asserts the
  call ordering (allocate before apply, release strictly after relink), each failure point
  (uniqueness conflict, apply failure, relink failure) and what it releases, the boot reconcile
  of an interrupted `allocate-ip` job and the non-release of an interrupted `apply` job, the
  hooks fired, and every `createJob` refusal (VM, template, mismatch, active job, setup running,
  bad or missing `vlan`, `vlan` on a power action, NetBox unconfigured).
- `store`: `readdressBox` writes host and id together, keeps the rest of the link, refuses a
  taken host and an unknown id.
- `server`: the two GET routes' status codes and the POST's validation.
- Web pure helpers: eligibility, option labels, disabled reasons.
- No Playwright coverage: e2e has no Proxmox. The feature is validated on the live app against a
  disposable container before merge, per the standing workflow.

## Docs

- `docs/proxmox.md`: a "Re-addressing a container" subsection — what it does, what it does not
  (bridge, IPv6, VMs), the live re-plug behaviour, and that the token needs `VM.Config.Network`
  (already in `PVEVMAdmin`).
- `README.md`: one line in the Proxmox section.
- `CLAUDE.md` / `AGENTS.md`: entries for `proxmoxLifecycle.js` (the `readdress` action, its
  phase order and release rules), `proxmoxParams.js`, `proxmoxApi.js`, `netboxApi.js`,
  `store.js`, `proxmoxGuests.ts`, `proxmoxReaddress.ts`; a Security-notes bullet for the two
  `known_hosts` removals and their justification.

## Security notes

- Both `known_hosts` removals fit the existing rule (remove only when Tmuxifier can prove the
  old identity is gone or new): the new address was just handed out by NetBox as free, so any
  entry for it is a recycled-IP leftover; the old address has just been released to NetBox, so
  the container's identity has verifiably left it.
- `vlan` is the only new client-supplied value that reaches an external system, and it reaches
  NetBox only as a filter and PVE only through `buildNet0Readdress` after integer range
  validation. The address and gateway written to PVE come from NetBox, re-validated with
  `isCidr`/`isIp` as provisioning does.
- The PVE hostname is box-side content: it is used as a NetBox `dns_name` only when it passes the
  same `DNS_LABEL` check provisioning applies to a user-typed hostname.
