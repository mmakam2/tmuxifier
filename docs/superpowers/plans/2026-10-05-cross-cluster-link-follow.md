# Cross-Cluster Link Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a box linked to its Proxmox guest when PDM remote-migrates that guest to another cluster (source deleted), by matching a fingerprint stamped on the link, and refuse a deprovision that would clean up after a guest that only moved.

**Architecture:** `proxmoxInventory.js` stamps `fp: { name, mac }` onto each link from the guest's config while the guest exists (the inventory is the only writer). When a link later reads `missing`, the same refresh searches every host profile's `/cluster/resources` for exactly one same-kind, same-name, unlocked, non-template, unlinked guest whose `net0` MAC equals `fp.mac`, and re-homes the link with the existing CAS + active-job guards. `proxmoxLifecycle.js` asks the same search before a deprovision from `missing` and refuses when the guest may be alive elsewhere.

**Tech Stack:** Node 20+ ESM, vitest (`environment: 'node'`, no DOM), TypeScript web client (one string change).

**Spec:** `docs/superpowers/specs/2026-10-05-cross-cluster-link-follow-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- **Public repo: no environment-specific values.** Never write real cluster names, node names, box labels, domains or the operator's LAN subnets into any tracked file. Use `cluster-a`/`cluster-b`, `pve-a.example.com`, node names like `a1n`/`b1n`, box names like `web01`, and `192.168.1.x` addresses only.
- Server is plain `.js`, ESM, factory functions with injected dependencies; tests use real code with injected fakes, never module mocks.
- TDD: every behaviour change starts with a failing test that you run and watch fail.
- Fail closed: zero matches, 2+ matches, a link without a complete `fp`, an unreadable host profile, a failed candidate config read, or anything malformed → the link stays `missing` and nothing is written.
- Fingerprint shapes (exact): MAC `^([0-9A-F]{2}:){5}[0-9A-F]{2}$` (normalized uppercase); guest name `^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`.
- Stamp concurrency: 4 config reads at a time (`mapWithConcurrency`).
- `refreshBox(box, { follow: false })` writes neither a re-home nor a stamp; the in-cluster node auto-follow is unchanged.
- Conventional-commit messages; end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in a feature worktree on branch `cross-cluster-follow` (superpowers:using-git-worktrees). **Never commit a `node_modules` symlink** from the worktree — `node_modules/` (with slash) ignores directories only, and a committed symlink destroys the real directory on merge.
- `npm run build` in the main checkout breaks the live app until a restart (the service serves the repo's `dist/` with boot-registered asset routes). Use `npm run typecheck` / `npm test` to verify; build only in the worktree.

---

### Task 0: Prerequisite — prove the fingerprint survives a PDM migration (operator, gates everything)

This is a manual check with the operator; no code. **If step 3 fails, stop and return to brainstorming — the design is void.**

**Files:** none.

- [ ] **Step 1: Pick a throwaway container on the source cluster and record its identity**

On a source-cluster node shell (replace `<vmid>`):

```bash
pct config <vmid> | grep -E '^(hostname|net0):'
```

Record the `hostname` and the `hwaddr=` value from `net0`.

- [ ] **Step 2: PDM-migrate it to the other cluster with "delete source" ticked**

While it runs, on a destination-cluster node shell poll the resource list for the target vmid and note whether a `lock` field appears and when it clears:

```bash
pvesh get /cluster/resources --type vm --output-format json | python3 -c 'import json,sys; [print(r) for r in json.load(sys.stdin) if r.get("name")=="<hostname>"]'
```

- [ ] **Step 3: Compare**

On the destination: `pct config <new-vmid> | grep -E '^(hostname|net0):'`. Pass criteria: identical `hwaddr`, identical `hostname`, and the source vmid gone from the source cluster's `/cluster/resources`.

- [ ] **Step 4: Record the outcome in the spec's Prerequisite section**

Append one dated line under "## Prerequisite" in the spec, e.g. `**Verified 2026-10-06:** MAC and name preserved; target showed lock=… until …; source removed.` If `/cluster/resources` never reports a `lock` field, also note that the lock filter is inert (keep the code — it costs nothing). Commit:

```bash
git add docs/superpowers/specs/2026-10-05-cross-cluster-link-follow-design.md
git commit -m "docs(spec): record PDM migration fingerprint verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Fingerprint helpers in `proxmoxParams.js`

**Files:**
- Modify: `src/server/proxmoxParams.js` (add after `net0Field`, around line 65)
- Test: `test/proxmoxParams.test.js`

**Interfaces:**
- Consumes: existing `parseNet0(str)` (throws on empty/unparseable) and `net0Field(pairs, key)` from the same file.
- Produces:
  - `normalizeMac(value: unknown): string | null` — uppercase colon MAC or null.
  - `macOfNet0(kind: 'lxc'|'qemu', net0: unknown): string | null`.
  - `cleanGuestName(value: unknown): string | null` — the value itself when it matches the guest-name pattern, else null.
  - `fingerprintComplete(fp: unknown): boolean` — true only for `{ name, mac }` already in canonical form.

- [ ] **Step 1: Write the failing tests**

In `test/proxmoxParams.test.js`, extend the import on line 2 to:

```js
import { buildNet0, buildCreateParams, parseNet0, net0Field, describeNet0, buildNet0Readdress, normalizeMac, macOfNet0, cleanGuestName, fingerprintComplete } from '../src/server/proxmoxParams.js';
```

Append:

```js
test('macOfNet0 reads an LXC hwaddr and normalizes its case', () => {
  expect(macOfNet0('lxc', 'name=eth0,bridge=vmbr0,hwaddr=bc:24:11:aa:bb:cc,ip=dhcp')).toBe('BC:24:11:AA:BB:CC');
});

test('macOfNet0 reads a QEMU MAC from the leading NIC-model key, whatever the model', () => {
  for (const model of ['virtio', 'e1000', 'vmxnet3', 'some-future-nic']) {
    expect(macOfNet0('qemu', `${model}=BC:24:11:00:00:01,bridge=vmbr0,firewall=1`)).toBe('BC:24:11:00:00:01');
  }
});

test('macOfNet0 returns null for anything absent or malformed — it never throws', () => {
  expect(macOfNet0('lxc', 'name=eth0,bridge=vmbr0,ip=dhcp')).toBeNull();
  expect(macOfNet0('lxc', '')).toBeNull();
  expect(macOfNet0('lxc', undefined)).toBeNull();
  expect(macOfNet0('lxc', 'garbage')).toBeNull();
  expect(macOfNet0('lxc', 'name=eth0,hwaddr=BC:24:11:AA:BB')).toBeNull();
  expect(macOfNet0('lxc', 'name=eth0,hwaddr=BC:24:11:AA:BB:CC;touch x')).toBeNull();
  expect(macOfNet0('qemu', 'bridge=vmbr0,virtio=BC:24:11:00:00:01')).toBeNull(); // the model key must lead
  expect(macOfNet0('qemu', 'virtio=not-a-mac,bridge=vmbr0')).toBeNull();
  expect(macOfNet0('other', 'hwaddr=BC:24:11:AA:BB:CC')).toBeNull();
});

test('normalizeMac accepts only a six-octet colon MAC', () => {
  expect(normalizeMac(' bc:24:11:aa:bb:cc ')).toBe('BC:24:11:AA:BB:CC');
  expect(normalizeMac('BC-24-11-AA-BB-CC')).toBeNull();
  expect(normalizeMac(42)).toBeNull();
});

test('cleanGuestName allowlists the PVE guest-name shape', () => {
  expect(cleanGuestName('web01')).toBe('web01');
  expect(cleanGuestName('web-01.lab')).toBe('web-01.lab');
  expect(cleanGuestName('web 01')).toBeNull();
  expect(cleanGuestName('-web')).toBeNull();
  expect(cleanGuestName('a'.repeat(64))).toBeNull();
  expect(cleanGuestName(undefined)).toBeNull();
});

test('fingerprintComplete requires both halves, already canonical', () => {
  expect(fingerprintComplete({ name: 'web01', mac: 'BC:24:11:AA:BB:CC' })).toBe(true);
  expect(fingerprintComplete({ name: 'web01', mac: 'bc:24:11:aa:bb:cc' })).toBe(false); // not normalized
  expect(fingerprintComplete({ name: 'web01' })).toBe(false);
  expect(fingerprintComplete({ mac: 'BC:24:11:AA:BB:CC' })).toBe(false);
  expect(fingerprintComplete({ name: 'web 01', mac: 'BC:24:11:AA:BB:CC' })).toBe(false);
  expect(fingerprintComplete(null)).toBe(false);
  expect(fingerprintComplete('web01')).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/proxmoxParams.test.js`
Expected: FAIL — `normalizeMac is not a function` (or similar for each new export).

- [ ] **Step 3: Implement**

In `src/server/proxmoxParams.js`, directly after the `net0Field` function, add:

```js
// Cross-cluster follow fingerprint (spec 2026-10-05). Every input here is
// cluster-supplied config, so each helper returns null rather than throwing,
// and nothing it rejects can ever match.
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const GUEST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

export function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const mac = value.trim().toUpperCase();
  return MAC_RE.test(mac) ? mac : null;
}

// LXC writes the MAC as `hwaddr=`; QEMU writes it as the VALUE of the leading
// NIC-model pair (`virtio=…`, `e1000=…`). Taking the first pair's value rather
// than allowlisting model names keeps a future PVE NIC model working.
export function macOfNet0(kind, net0) {
  let pairs;
  try { pairs = parseNet0(net0); } catch { return null; }
  if (kind === 'lxc') return normalizeMac(net0Field(pairs, 'hwaddr'));
  if (kind === 'qemu') return normalizeMac(pairs[0][1]);
  return null;
}

export function cleanGuestName(value) {
  return typeof value === 'string' && GUEST_NAME_RE.test(value) ? value : null;
}

export function fingerprintComplete(fp) {
  return !!fp && typeof fp === 'object'
    && cleanGuestName(fp.name) === fp.name
    && normalizeMac(fp.mac) === fp.mac;
}
```

(`cleanGuestName(undefined)` is `null`, and `null === undefined` is false, so an absent half fails the check.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxParams.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxParams.js test/proxmoxParams.test.js
git commit -m "feat(proxmox): net0 MAC and guest-name fingerprint helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-refresh context, `refreshBox({ follow })`, and the fingerprint backfill

**Files:**
- Modify: `src/server/proxmoxInventory.js` (imports at top; `healGroup` ~line 58; `fetchHost` ~line 107; `doRefresh` ~line 177; the returned object ~line 235)
- Test: `test/proxmoxInventory.test.js` (append a new harness + tests)

**Interfaces:**
- Consumes: `macOfNet0`, `cleanGuestName`, `fingerprintComplete` (Task 1); `mapWithConcurrency(items, limit, fn)` from `src/server/concurrency.js`; the injected client's `guestConfig(kind, node, vmid)` (exists in `proxmoxApi.js:123`).
- Produces (later tasks rely on these exact names):
  - `doRefresh(boxes, { follow = true } = {})` — internal.
  - Per-refresh context object `ctx = { hosts: Map<hostId, host>, resources: Map<hostId, guest[] | null> }`; `fetchHost(hostId, hostBoxes, ctx)` fills both (`null` resources = the profile could not be read).
  - `refreshBox(box, opts = {})` on the returned inventory — `opts.follow` forwarded.
  - Link field `box.proxmox.fp = { name, mac }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxInventory.test.js`:

```js
// ── Cross-cluster follow (spec 2026-10-05) ─────────────────────────────────
// Two clusters, per-host fake clients, and a box store whose writes land back
// in `boxes`, so CAS re-reads see what a real store would.
const HOSTS = {
  H1: { id: 'H1', name: 'cluster-a', endpoint: 'pve-a.example.com:8006', tokenSecret: 's1' },
  H2: { id: 'H2', name: 'cluster-b', endpoint: 'pve-b.example.com:8006', tokenSecret: 's2' },
};
const FP = { name: 'web01', mac: 'BC:24:11:AA:BB:CC' };
const lxcNet0 = (mac) => `name=eth0,bridge=vmbr0,hwaddr=${mac},ip=dhcp`;
const linkedTo = (id, hostId, node, vmid, extra = {}) => ({
  id, label: id, host: '192.168.1.50',
  proxmox: { hostId, node, vmid, kind: 'lxc', endpoint: HOSTS[hostId].endpoint, ...extra },
});

function clusters({ boxes, resources = {}, configs = {}, hosts = HOSTS, guard, failResources = [], failLink = null }) {
  const calls = { resources: [], config: [] };
  const writes = [];
  const logs = [];
  const store = {
    getBox: async (id) => boxes.find((b) => b.id === id),
    listBoxes: async () => boxes,
    setProxmoxLink: async (id, link) => {
      if (failLink) throw new Error(failLink);
      writes.push([id, link]);
      const i = boxes.findIndex((b) => b.id === id);
      boxes[i] = { ...boxes[i], proxmox: link };
      return boxes[i];
    },
  };
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      getHost: async (id) => hosts[id],
      listHosts: async () => Object.values(hosts).map(({ tokenSecret, ...rest }) => rest),
    },
    makeClient: (host) => ({
      clusterResources: async () => {
        calls.resources.push(host.id);
        if (failResources.includes(host.id)) throw new Error('connect ETIMEDOUT');
        return resources[host.id] || [];
      },
      guestConfig: async (kind, node, vmid) => {
        calls.config.push(`${host.id}:${kind}:${node}:${vmid}`);
        const entry = configs[`${host.id}:${vmid}`];
        const cfg = typeof entry === 'function' ? entry() : entry;
        if (cfg instanceof Error) throw cfg;
        if (!cfg) throw new Error('500 no such guest');
        return cfg;
      },
    }),
    boxStore: store,
    now: () => 1000,
    log: (line) => logs.push(line),
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, writes, calls, logs };
}

test('backfill stamps the fingerprint from the guest config on the first poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0('bc:24:11:aa:bb:cc') } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([id, link]) => [id, link.fp])).toEqual([['b1', FP]]);
  expect(boxes[0].proxmox).toEqual({ hostId: 'H1', node: 'a1n', vmid: 120, kind: 'lxc', endpoint: HOSTS.H1.endpoint, fp: FP });
});

test('a stopped guest is stamped too; a missing or mismatched one is not', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120),
    linkedTo('b2', 'H1', 'a1n', 121), // the cluster reports 121 as a VM: mismatch
    linkedTo('b3', 'H1', 'a1n', 122), // absent: missing
  ];
  const net = { net0: lxcNet0(FP.mac) };
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [
      { vmid: 120, node: 'a1n', type: 'lxc', status: 'stopped', name: 'web01' },
      { vmid: 121, node: 'a1n', type: 'qemu', status: 'running', name: 'vm01' },
    ] },
    configs: { 'H1:120': net, 'H1:121': net, 'H1:122': net },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual(['H1:lxc:a1n:120']);
  expect(writes.map(([id]) => id)).toEqual(['b1']);
});

test('a complete fingerprint is never re-read', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});

test('a rename refreshes fp.name from the resource list without reading config', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01-new' }] },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes.map(([, link]) => link.fp)).toEqual([{ name: 'web01-new', mac: FP.mac }]);
});

test('a failed config read stamps nothing and is retried on the next poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const configs = { 'H1:120': new Error('500 timeout') };
  const { inventory, writes, calls } = clusters({
    boxes, configs,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
  configs['H1:120'] = { net0: lxcNet0(FP.mac) };
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toHaveLength(2);
  expect(writes.map(([, link]) => link.fp)).toEqual([FP]);
});

test('a guest with no usable net0 or name is read once, not every poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120), linkedTo('b2', 'H1', 'a1n', 121)];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [
      { vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' },
      { vmid: 121, node: 'a1n', type: 'lxc', status: 'running', name: 'bad name' },
    ] },
    configs: { 'H1:120': { hostname: 'web01' }, 'H1:121': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(calls.config.sort()).toEqual(['H1:lxc:a1n:120', 'H1:lxc:a1n:121']);
  expect(writes).toEqual([]);
});

test('stamping is skipped while a lifecycle job is active on the box', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes, calls } = clusters({
    boxes, guard: () => true,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});

test('stamping is skipped if the box was re-linked while the config was being read (CAS)', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': () => { boxes[0] = linkedTo('b1', 'H1', 'a1n', 125); return { net0: lxcNet0(FP.mac) }; } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('refreshBox with follow:false never stamps', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  const record = await inventory.refreshBox(boxes[0], { follow: false });
  expect(record.state).toBe('running');
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: the new stamping tests FAIL (no writes / no `guestConfig` calls); the `follow:false`, "never re-read", "active job" and CAS tests may already pass vacuously — that is expected, they become meaningful once stamping exists. Every pre-existing test still passes.

- [ ] **Step 3: Implement**

In `src/server/proxmoxInventory.js`:

3a. Add at the very top of the file (before `const targetKey`):

```js
import { mapWithConcurrency } from './concurrency.js';
import { macOfNet0, cleanGuestName, fingerprintComplete } from './proxmoxParams.js';
```

and after `const linkKind = …` (line 9):

```js
// The fingerprint backfill reads one guest config per unstamped link; bounded
// so the first poll after a deploy does not fire every link's read at once.
const STAMP_CONCURRENCY = 4;
const guestKey = (hostId, vmid) => `${hostId}\u0000${Number(vmid)}`;
```

3b. Inside `createProxmoxInventory`, after `let activeJobGuard = () => false;`, add:

```js
  // Guests whose config was read successfully but yielded no usable
  // fingerprint (no net0, unrecognisable MAC, disallowed name). Remembered for
  // the life of the process so such a guest costs one read, not one per poll.
  const unusable = new Set();
```

3c. Thread `ctx` through `healGroup` and `fetchHost`. Change the signature `async function healGroup(hostBoxes) {` to `async function healGroup(hostBoxes, ctx) {` and, inside it, change the line

```js
      if (healed.length) results.push(...await fetchHost(candidateId, healed));
```

to:

```js
      if (healed.length) results.push(...await fetchHost(candidateId, healed, ctx));
``` Replace the whole `fetchHost` head — from `async function fetchHost(hostId, hostBoxes) {` through `const byVmid = …` — with:

```js
  async function fetchHost(hostId, hostBoxes, ctx) {
    let host;
    try {
      host = await proxmoxStore.getHost(hostId, { withSecret: true });
    } catch (error) {
      ctx.resources.set(hostId, null);
      return hostBoxes.map((box) => record(box, { error: error.message }));
    }
    if (!host) { ctx.resources.set(hostId, null); return healGroup(hostBoxes, ctx); }
    ctx.hosts.set(hostId, host);
    let guests;
    try {
      guests = await makeClient(host).clusterResources();
    } catch (error) {
      ctx.resources.set(hostId, null);
      return hostBoxes.map((box) => record(box, { hostName: host.name, error: error.message }));
    }
    ctx.resources.set(hostId, guests || []);
    const byVmid = new Map((guests || []).filter((g) => GUEST_TYPES.has(g.type)).map((g) => [Number(g.vmid), g]));
```

The rest of `fetchHost` (the `return Promise.all(hostBoxes.map(…))` body) is unchanged.

3d. Replace `doRefresh` with:

```js
  async function doRefresh(boxes, { follow = true } = {}) {
    // Per-refresh context: every host fetched and every profile's resource
    // list read in this refresh, so later steps never ask a cluster twice.
    const ctx = { hosts: new Map(), resources: new Map() };
    const groups = new Map();
    for (const box of boxes.filter((item) => item.proxmox)) {
      const hostId = box.proxmox.hostId;
      if (!groups.has(hostId)) groups.set(hostId, []);
      groups.get(hostId).push(box);
    }
    const records = (await Promise.all(
      [...groups.entries()].map(([hostId, hostBoxes]) => fetchHost(hostId, hostBoxes, ctx)),
    )).flat();
    // follow:false (a lifecycle pre-check) is read-only beyond the node
    // auto-follow fetchHost already did: no stamp, no cross-cluster re-home.
    if (follow && boxStore) await stampFingerprints(records, boxes, ctx);
    for (const item of records) cache.set(item.boxId, item);
    return records;
  }
```

3e. Add `stampFingerprints` directly above `doRefresh`:

```js
  // Cross-cluster follow (spec 2026-10-05) matches on a fingerprint that can
  // only be read while the guest exists, so it is stamped here — on the first
  // poll after any link is made — and its name kept current for free from the
  // resource list. This is the only writer of `fp`.
  async function stampFingerprints(records, boxes, ctx) {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const work = [];
    for (const item of records) {
      if (item.state !== 'running' && item.state !== 'stopped') continue;
      const box = byId.get(item.boxId);
      if (!box || !box.proxmox || activeJobGuard(box.id)) continue;
      // A record this refresh rebuilt for a different target (a healed or
      // followed link) is not about the link the box object holds; the next
      // poll stamps it.
      if (item.hostId !== box.proxmox.hostId || item.vmid !== Number(box.proxmox.vmid)) continue;
      const name = cleanGuestName(item.containerName);
      const fp = box.proxmox.fp;
      if (fingerprintComplete(fp)) {
        if (name && name !== fp.name) work.push({ box, item, name, mac: fp.mac });
        continue;
      }
      if (unusable.has(guestKey(item.hostId, item.vmid))) continue;
      work.push({ box, item, name, mac: null });
    }
    await mapWithConcurrency(work, STAMP_CONCURRENCY, async ({ box, item, name, mac }) => {
      let stampMac = mac;
      if (!stampMac) {
        const host = ctx.hosts.get(item.hostId);
        if (!host) return;
        let config;
        // Best-effort and silent: a failed read is retried next poll.
        try { config = await makeClient(host).guestConfig(item.kind, item.node, item.vmid); } catch { return; }
        stampMac = macOfNet0(item.kind, config && config.net0);
        if (!name || !stampMac) { unusable.add(guestKey(item.hostId, item.vmid)); return; }
      }
      try {
        // CAS: re-read right before writing, same as the node auto-follow, so a
        // link the user changed mid-poll is never stamped with this guest.
        const fresh = await boxStore.getBox(box.id);
        const link = fresh && fresh.proxmox;
        if (!link || link.hostId !== item.hostId || Number(link.vmid) !== item.vmid || activeJobGuard(box.id)) return;
        await boxStore.setProxmoxLink(box.id, { ...link, fp: { name, mac: stampMac } });
      } catch (error) {
        log(`[tmuxifier] box ${box.label}: could not stamp guest fingerprint: ${error.message}`);
      }
    });
  }
```

3f. In the returned object, replace `async refreshBox(box) { return (await doRefresh([box]))[0]; },` with:

```js
    async refreshBox(box, opts = {}) { return (await doRefresh([box], opts))[0]; },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: PASS — all new tests and every pre-existing test. (Pre-existing fakes have no `guestConfig`; the stamp's read throws a TypeError that the silent `catch` absorbs, so their write counts are unchanged. If a pre-existing test now fails, the bug is in this task — do not edit the old test.)

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxInventory.js test/proxmoxInventory.test.js
git commit -m "feat(proxmox): stamp a name+MAC fingerprint on every linked guest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The cross-cluster follow and `findFollowCandidates`

**Files:**
- Modify: `src/server/proxmoxInventory.js`
- Test: `test/proxmoxInventory.test.js` (append; reuses Task 2's `HOSTS`, `FP`, `lxcNet0`, `linkedTo`, `clusters`)

**Interfaces:**
- Consumes: Task 2's `ctx`, `doRefresh(boxes, { follow })`, `record(box, fields)`, `normalizeState`, `SAFE_NODE`, `linkKind`, `activeJobGuard`; Task 1's helpers; `proxmoxStore.listHosts()` (redacted summaries carrying `id`, `name`, `endpoint`); `boxStore.listBoxes()`.
- Produces:
  - `inventory.findFollowCandidates(box) → Promise<{ found: Array<{ hostId, hostName, vmid, node }>, unreachable: string[] }>` — never writes; both lists empty for a link without a complete `fp`; throws only if `listHosts`/`listBoxes` throw.
  - Re-homed link shape: `{ ...oldLink, hostId, node, vmid, endpoint }` (keeps `kind`, `fp`, `netboxIpId`).

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxInventory.test.js`:

```js
const movedGuest = (vmid, extra = {}) => ({ vmid, node: 'b1n', type: 'lxc', status: 'running', name: 'web01', ...extra });
const NET = { net0: lxcNet0(FP.mac) };

test('a missing guest found once on another cluster re-homes the link, keeping kind, fp and netboxIpId', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP, netboxIpId: 7 })];
  const { inventory, writes, logs } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([['b1', {
    hostId: 'H2', node: 'b1n', vmid: 305, kind: 'lxc', endpoint: HOSTS.H2.endpoint, fp: FP, netboxIpId: 7,
  }]]);
  expect(record).toMatchObject({ boxId: 'b1', hostId: 'H2', hostName: 'cluster-b', node: 'b1n', vmid: 305, state: 'running', error: null });
  expect(logs.some((line) => line.includes('guest moved'))).toBe(true);
});

test('a guest restored under a new vmid on its own cluster follows too', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, resources: { H1: [movedGuest(121, { node: 'a2n' })], H2: [] }, configs: { 'H1:121': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([, link]) => [link.hostId, link.node, link.vmid])).toEqual([['H1', 'a2n', 121]]);
});

test.each([
  ['no match anywhere', [], {}],
  ['two matches', [movedGuest(305), movedGuest(306)], { 'H2:305': NET, 'H2:306': NET }],
  ['a locked candidate', [movedGuest(305, { lock: 'migrate' })], { 'H2:305': NET }],
  ['a template candidate', [movedGuest(305, { template: 1 })], { 'H2:305': NET }],
  ['a kind mismatch', [movedGuest(305, { type: 'qemu' })], { 'H2:305': { net0: `virtio=${FP.mac},bridge=vmbr0` } }],
  ['a name mismatch', [movedGuest(305, { name: 'web02' })], { 'H2:305': NET }],
  ['a MAC mismatch', [movedGuest(305)], { 'H2:305': { net0: lxcNet0('BC:24:11:00:00:99') } }],
  ['a malformed node', [movedGuest(305, { node: 'bad node' })], { 'H2:305': NET }],
  ['an out-of-range vmid', [movedGuest(42)], { 'H2:42': NET }],
  ['a candidate whose config read fails', [movedGuest(305)], { 'H2:305': new Error('500') }],
])('no follow on %s: nothing written, record stays missing', async (_label, h2, configs) => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: h2 }, configs });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ hostId: 'H1', vmid: 120, state: 'missing' });
});

test('a link without a complete fingerprint is never followed and searches nothing', async () => {
  for (const extra of [{}, { fp: { name: 'web01' } }]) {
    const boxes = [linkedTo('b1', 'H1', 'a1n', 120, extra)];
    const { inventory, writes, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
    await inventory.refreshLinked([...boxes]);
    expect(writes).toEqual([]);
    expect(calls.resources).toEqual(['H1']); // H2 was never asked
  }
});

test('a candidate already linked to another box is not a match', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }), linkedTo('b2', 'H2', 'b1n', 305, { fp: { name: 'web01', mac: 'BC:24:11:00:00:02' } })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
});

test('an unreadable host profile makes the search incomplete: no follow even with one match elsewhere', async () => {
  const hosts = { ...HOSTS, H3: { id: 'H3', name: 'cluster-c', endpoint: 'pve-c.example.com:8006', tokenSecret: 's3' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, failResources: ['H3'], resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('two profiles with the same endpoint are searched once, so one guest is one match', async () => {
  const hosts = { ...HOSTS, H2b: { id: 'H2b', name: 'cluster-b-alias', endpoint: HOSTS.H2.endpoint, tokenSecret: 's4' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, resources: { H1: [], H2: [movedGuest(305)], H2b: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2b:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([, link]) => link.hostId)).toEqual(['H2']);
});

test('two missing boxes resolving to the same guest both stay put', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }), linkedTo('b2', 'H1', 'a1n', 121, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('the follow is skipped while a lifecycle job is active on the box', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, guard: () => true, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('the follow is skipped if the box was re-linked mid-poll (CAS)', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305)] },
    configs: { 'H2:305': () => { boxes[0] = linkedTo('b1', 'H1', 'a1n', 130); return NET; } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('a store refusal (already linked) is logged, never thrown, and the record stays missing', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, logs } = clusters({
    boxes, failLink: 'proxmox guest is already linked',
    resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(record.state).toBe('missing');
  expect(logs.some((line) => line.includes('could not follow'))).toBe(true);
});

test('a missing guest with no same-name candidate costs no config read and no repeat cluster call', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305, { name: 'other' })] } });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(calls.resources).toEqual(['H1', 'H2']);
});

test('an ambiguous search is logged once, not on every poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, logs } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305), movedGuest(306)] }, configs: { 'H2:305': NET, 'H2:306': NET },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(logs.filter((line) => line.includes('not following'))).toHaveLength(1);
});

test('refreshBox with follow:false never re-homes', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  const record = await inventory.refreshBox(boxes[0], { follow: false });
  expect(record.state).toBe('missing');
  expect(writes).toEqual([]);
});

test('findFollowCandidates reports matches and unreadable profiles without writing', async () => {
  const hosts = { ...HOSTS, H3: { id: 'H3', name: 'cluster-c', endpoint: 'pve-c.example.com:8006', tokenSecret: 's3' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, failResources: ['H3'], resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({
    found: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 305, node: 'b1n' }],
    unreachable: ['cluster-c'],
  });
  expect(writes).toEqual([]);
});

test('findFollowCandidates is empty for a link without a fingerprint', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] } });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({ found: [], unreachable: [] });
  expect(calls.resources).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: FAIL — the two positive follow tests (no writes), the log tests, and both `findFollowCandidates` tests (`inventory.findFollowCandidates is not a function`). The negative table may pass vacuously until the follow exists; that is expected.

- [ ] **Step 3: Implement**

In `src/server/proxmoxInventory.js`:

3a. After the `const unusable = new Set();` added in Task 2, add:

```js
  // Box id -> signature of the last "not following" reason logged, so an
  // ambiguous missing guest is reported when its situation changes, not on
  // every poll.
  const notFollowingLogged = new Map();
```

3b. Add these functions above `stampFingerprints`:

```js
  // Cross-cluster follow (spec 2026-10-05). PDM's remote migration with the
  // source deleted leaves the link reading `missing`; if exactly one guest on
  // any profile carries the link's stamped fingerprint, the link follows it —
  // the node auto-follow's rule widened across clusters, with the mismatch
  // rule's posture: anything short of one unambiguous match writes nothing.
  async function resourcesFor(summary, ctx) {
    if (ctx.resources.has(summary.id)) return ctx.resources.get(summary.id);
    let guests = null;
    try {
      const host = await proxmoxStore.getHost(summary.id, { withSecret: true });
      if (host) {
        ctx.hosts.set(host.id, host);
        guests = (await makeClient(host).clusterResources()) || [];
      }
    } catch { guests = null; }
    ctx.resources.set(summary.id, guests);
    return guests;
  }

  async function searchFingerprint(box, ctx) {
    const fp = box.proxmox && box.proxmox.fp;
    if (!boxStore || !fingerprintComplete(fp)) return { found: [], unreachable: [] };
    const kind = linkKind(box);
    // The whole fleet, not the refresh's box list: a single-box refresh is
    // handed one box, and "already linked elsewhere" needs every link.
    const [summaries, fleet] = await Promise.all([proxmoxStore.listHosts(), boxStore.listBoxes()]);
    const linkedElsewhere = new Set((fleet || [])
      .filter((other) => other.id !== box.id && other.proxmox)
      .map((other) => guestKey(other.proxmox.hostId, other.proxmox.vmid)));
    const seen = new Set();
    const named = [];
    const unreachable = [];
    for (const summary of summaries || []) {
      if (!summary || seen.has(summary.endpoint)) continue;
      seen.add(summary.endpoint);
      const guests = await resourcesFor(summary, ctx);
      // An unreadable cluster could hold a second match: the search is incomplete.
      if (!guests) { unreachable.push(summary.name || summary.id); continue; }
      for (const g of guests) {
        if (!g || g.type !== kind || g.template || g.lock) continue;
        if (typeof g.node !== 'string' || !SAFE_NODE.test(g.node)) continue;
        const vmid = Number(g.vmid);
        if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) continue;
        if (cleanGuestName(g.name) !== fp.name) continue;
        if (linkedElsewhere.has(guestKey(summary.id, vmid))) continue;
        named.push({
          hostId: summary.id, hostName: summary.name || null, endpoint: summary.endpoint,
          node: g.node, vmid, kind, status: g.status, name: g.name,
        });
      }
    }
    const found = [];
    for (const candidate of named) {
      let config;
      try { config = await makeClient(ctx.hosts.get(candidate.hostId)).guestConfig(kind, candidate.node, candidate.vmid); }
      catch { unreachable.push(candidate.hostName || candidate.hostId); continue; } // it might have been the match
      if (macOfNet0(kind, config && config.net0) === fp.mac) found.push(candidate);
    }
    return { found, unreachable: [...new Set(unreachable)] };
  }

  function noteNotFollowing(box, signature, message) {
    if (notFollowingLogged.get(box.id) === signature) return;
    notFollowingLogged.set(box.id, signature);
    log(`[tmuxifier] box ${box.label}: guest missing; not following — ${message}`);
  }

  async function rehome(box, target, ctx) {
    try {
      // CAS: the link must still be the one this refresh found missing.
      const fresh = await boxStore.getBox(box.id);
      const link = fresh && fresh.proxmox;
      const stillOurs = link && link.hostId === box.proxmox.hostId
        && Number(link.vmid) === Number(box.proxmox.vmid)
        && fingerprintComplete(link.fp) && link.fp.mac === box.proxmox.fp.mac;
      if (!stillOurs || activeJobGuard(box.id)) return null;
      const next = { ...link, hostId: target.hostId, node: target.node, vmid: target.vmid, endpoint: target.endpoint };
      await boxStore.setProxmoxLink(box.id, next);
      const fromName = (ctx.hosts.get(link.hostId) || {}).name || link.hostId;
      log(`[tmuxifier] box ${box.label}: guest moved ${fromName}/${link.vmid} -> ${target.hostName || target.hostId}/${target.vmid} (fingerprint ${link.fp.name} ${link.fp.mac})`);
      return record({ ...box, proxmox: next }, {
        hostName: target.hostName, node: target.node, kind: target.kind,
        containerName: target.name || null, state: normalizeState(target.status), template: false,
      });
    } catch (error) {
      log(`[tmuxifier] box ${box.label}: could not follow guest to ${target.hostName || target.hostId}/${target.vmid}: ${error.message}`);
      return null;
    }
  }

  async function followAcrossClusters(records, boxes, ctx) {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const plans = [];
    for (const item of records) {
      if (item.state !== 'missing') { notFollowingLogged.delete(item.boxId); continue; }
      const box = byId.get(item.boxId);
      if (!box || !box.proxmox || !fingerprintComplete(box.proxmox.fp) || activeJobGuard(box.id)) continue;
      let result;
      try { result = await searchFingerprint(box, ctx); } catch (error) {
        noteNotFollowing(box, `error:${error.message}`, `search failed: ${error.message}`);
        continue;
      }
      const { found, unreachable } = result;
      if (found.length === 1 && unreachable.length === 0) { plans.push({ box, target: found[0] }); continue; }
      if (found.length === 0 && unreachable.length === 0) { notFollowingLogged.delete(box.id); continue; }
      const signature = [...found.map((c) => `${c.hostId}/${c.vmid}`), ...unreachable.map((n) => `!${n}`)].join(',');
      noteNotFollowing(box, signature, `${found.length} fingerprint match(es)`
        + (unreachable.length ? `; could not read: ${unreachable.join(', ')}` : ''));
    }
    const claims = new Map();
    for (const { target } of plans) {
      const key = guestKey(target.hostId, target.vmid);
      claims.set(key, (claims.get(key) || 0) + 1);
    }
    const replaced = new Map();
    for (const { box, target } of plans) {
      const key = guestKey(target.hostId, target.vmid);
      if (claims.get(key) > 1) {
        noteNotFollowing(box, `shared:${key}`, `another missing box matches the same guest (${target.hostName || target.hostId}/${target.vmid})`);
        continue;
      }
      notFollowingLogged.delete(box.id);
      const moved = await rehome(box, target, ctx);
      if (moved) replaced.set(box.id, moved);
    }
    return records.map((item) => replaced.get(item.boxId) || item);
  }
```

3c. In `doRefresh`, change `const records = (await Promise.all(` to `let records = (await Promise.all(` and replace the line

```js
    if (follow && boxStore) await stampFingerprints(records, boxes, ctx);
```

with:

```js
    if (follow && boxStore) {
      records = await followAcrossClusters(records, boxes, ctx);
      await stampFingerprints(records, boxes, ctx);
    }
```

3d. In the returned object, after the `refreshBox` line, add:

```js
    // The deprovision guard's query (proxmoxLifecycle.js): the same search the
    // follow runs, without writing anything.
    async findFollowCandidates(box) {
      const { found, unreachable } = await searchFingerprint(box, { hosts: new Map(), resources: new Map() });
      return { found: found.map(({ hostId, hostName, vmid, node }) => ({ hostId, hostName, vmid, node })), unreachable };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: PASS — every new and pre-existing test.

- [ ] **Step 5: Prove the negative table is not vacuous**

Temporarily change `if (found.length === 1 && unreachable.length === 0)` to `if (found.length >= 1)` and rerun: the `two matches`, two-missing-boxes and unreadable-profile tests must FAIL. Temporarily delete `|| g.lock` and rerun: `a locked candidate` must FAIL. Temporarily delete the MAC comparison (`if (true) found.push(candidate)`) and rerun: `a MAC mismatch` must FAIL. Revert all three edits and rerun to green. (A negative test that passes before and after its guard exists proves nothing.)

- [ ] **Step 6: Commit**

```bash
git add src/server/proxmoxInventory.js test/proxmoxInventory.test.js
git commit -m "feat(proxmox): follow a linked guest across clusters by fingerprint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Deprovision guard in `proxmoxLifecycle.js`

**Files:**
- Modify: `src/server/proxmoxLifecycle.js` (import line 6; `runDeprovision` ~line 216; `createJob` ~line 368)
- Test: `test/proxmoxLifecycle.test.js` (append)

**Interfaces:**
- Consumes: `inventory.refreshBox(box, { follow: false })` (Task 2); `inventory.findFollowCandidates(box)` (Task 3); `fingerprintComplete` (Task 1).
- Produces: `createJob` 409s / `runDeprovision` errors with these exact messages:
  - one: `guest found on <hostName> as vmid <vmid> — Tmuxifier will re-link it on the next poll`
  - several: `<N> guests match this box's fingerprint — re-link it with Edit link`
  - unreadable: `cannot rule out that this guest moved: <names, comma-joined> unreachable — retry, or remove the box instead`

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxLifecycle.test.js` (uses the file's existing `fixture`, `BOX`, `HOST`):

```js
// ── Deprovision guard (cross-cluster follow, spec 2026-10-05) ──────────────
const FP_BOX = { ...BOX, proxmox: { ...BOX.proxmox, fp: { name: 'dev-01', mac: 'BC:24:11:AA:BB:CC' } } };

function guardFixture(searches, extra = {}) {
  const searched = [];
  const refreshArgs = [];
  const removed = [];
  const forgotten = [];
  const queue = [...searches];
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => (id === 'B1' ? (extra.box || FP_BOX) : undefined) },
    inventory: {
      refreshBox: async (box, opts) => { refreshArgs.push(opts); return { boxId: 'B1', state: 'missing', node: 'pve', vmid: 131, kind: 'lxc' }; },
      findFollowCandidates: async (box) => { searched.push(box.id); return queue.length > 1 ? queue.shift() : queue[0]; },
    },
    removeLinkedBox: async (id) => removed.push(id),
    knownHosts: { forget: async (host) => forgotten.push(host) },
  });
  return { manager, searched, refreshArgs, removed, forgotten };
}
const NONE = { found: [], unreachable: [] };
const ONE = { found: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 305, node: 'b1n' }], unreachable: [] };

test('deprovision from missing is refused while the guest is found on another cluster', async () => {
  const { manager } = guardFixture([ONE]);
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: 'guest found on cluster-b as vmid 305 — Tmuxifier will re-link it on the next poll' });
  expect(manager.listJobs()).toEqual([]);
});

test('deprovision from missing is refused when several guests match', async () => {
  const two = { found: [ONE.found[0], { hostId: 'H3', hostName: 'cluster-c', vmid: 410, node: 'c1n' }], unreachable: [] };
  const { manager } = guardFixture([two]);
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: "2 guests match this box's fingerprint — re-link it with Edit link" });
});

test('deprovision from missing is refused when a cluster cannot be read', async () => {
  const { manager } = guardFixture([{ found: [], unreachable: ['cluster-b', 'cluster-c'] }]);
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: 'cannot rule out that this guest moved: cluster-b, cluster-c unreachable — retry, or remove the box instead' });
});

test('deprovision from missing proceeds when the fingerprint is found nowhere', async () => {
  const { manager, removed } = guardFixture([NONE]);
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(removed).toEqual(['B1']);
});

test('a link without a fingerprint never searches — today\'s missing-deprovision path, unchanged', async () => {
  const { manager, searched, removed } = guardFixture([ONE], { box: BOX });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(searched).toEqual([]);
  expect(removed).toEqual(['B1']);
});

test('a guest that appears elsewhere after createJob fails the job before any cleanup', async () => {
  const { manager, removed, forgotten } = guardFixture([NONE, ONE]);
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'guest found on cluster-b as vmid 305 — Tmuxifier will re-link it on the next poll' });
  expect(removed).toEqual([]);
  expect(forgotten).toEqual([]);
});

test('createJob refreshes with follow:false so its pre-check can never re-home the link', async () => {
  const { manager, refreshArgs } = guardFixture([NONE]);
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(refreshArgs[0]).toEqual({ follow: false }); // createJob's pre-check; the running job's own refreshes come later
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: FAIL — the three refusal tests resolve instead of rejecting, the after-createJob test removes the box, and `refreshArgs[0]` is `undefined`.

- [ ] **Step 3: Implement**

3a. Change line 6 of `src/server/proxmoxLifecycle.js` to:

```js
import { parseNet0, describeNet0, buildNet0Readdress, fingerprintComplete } from './proxmoxParams.js';
```

3b. Inside `createProxmoxLifecycleManager`, directly above `async function runDeprovision(job) {`, add:

```js
  // A box whose guest reads `missing` may only have been moved to another
  // cluster by PDM (spec 2026-10-05). Until the status poll re-links it, that
  // guest is alive elsewhere on the same address, and this path's cleanup would
  // release its NetBox record and forget its host key. A link without a
  // fingerprint was never followable and keeps the old behaviour.
  async function movedElsewhere(box) {
    if (!fingerprintComplete(box.proxmox && box.proxmox.fp)) return null;
    const { found, unreachable } = await inventory.findFollowCandidates(box);
    if (found.length === 1) {
      return `guest found on ${found[0].hostName || found[0].hostId} as vmid ${found[0].vmid} — Tmuxifier will re-link it on the next poll`;
    }
    if (found.length > 1) return `${found.length} guests match this box's fingerprint — re-link it with Edit link`;
    if (unreachable.length) {
      return `cannot rule out that this guest moved: ${unreachable.join(', ')} unreachable — retry, or remove the box instead`;
    }
    return null;
  }
```

3c. In `runDeprovision`, change

```js
    if (current.state === 'missing') {
      job.phase = 'unlink'; persist();
```

to

```js
    if (current.state === 'missing') {
      // Re-checked here, not only in createJob: the migration can land
      // between the job being created and it running.
      const moved = await movedElsewhere(box);
      if (moved) throw new Error(moved);
      job.phase = 'unlink'; persist();
```

3d. In `createJob`, change

```js
    const current = await inventory.refreshBox(box).catch((error) => { throw serviceError(502, error.message); });
```

to

```js
    // follow:false — a cross-cluster re-home here would leave the job below
    // snapshotting the old hostId against a new link. Only the status poll
    // re-homes links.
    const current = await inventory.refreshBox(box, { follow: false }).catch((error) => { throw serviceError(502, error.message); });
```

and, inside the `if (action === 'deprovision') {` branch, after the `if (!['running', 'stopped', 'missing'].includes(current.state)) throw …` line, add:

```js
      if (current.state === 'missing') {
        const moved = await movedElsewhere(box).catch((error) => { throw serviceError(502, error.message); });
        if (moved) throw serviceError(409, moved);
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxLifecycle.test.js test/proxmoxInventory.test.js`
Expected: PASS — all new and pre-existing tests (existing fixtures use `BOX` without `fp`, so they never reach `findFollowCandidates`).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxLifecycle.js test/proxmoxLifecycle.test.js
git commit -m "feat(proxmox): refuse deprovision of a missing guest that moved clusters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Dialog wording and living documentation

**Files:**
- Modify: `src/web/proxmoxGuests.ts:63`
- Modify: `docs/proxmox.md` (after the paragraph ending "…also powers this cluster-wide inventory lookup.", ~line 147)
- Modify: `CLAUDE.md` and `AGENTS.md` — the `proxmoxInventory.js` and `proxmoxLifecycle.js` entries (keep the two files in sync)

**Interfaces:** none (copy only).

- [ ] **Step 1: Change the dialog text**

In `src/web/proxmoxGuests.ts`, replace the string

```ts
      ? 'Proxmox already reports this guest missing. Tmuxifier will remove only the stale linked box.'
```

with

```ts
      ? 'Proxmox reports this guest missing on its linked cluster. If it moved to another cluster, Tmuxifier re-links it automatically and deprovision will be refused. Otherwise only the stale linked box is removed.'
```

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Add the operator documentation**

In `docs/proxmox.md`, after the paragraph that ends `…also powers this cluster-wide inventory lookup.`, insert:

```markdown
**Guests moved to another cluster follow their box.** When Proxmox Datacenter Manager migrates a
guest to a different cluster with *delete source*, the box's link reads **missing** on its old
cluster. On the next status poll Tmuxifier searches every host profile for exactly one guest with
the same kind, the same name and the same `net0` MAC address — a fingerprint it records on the link
from the guest's config on the first poll after the box is linked — and re-links the box to it.
Anything less certain changes nothing: no match, two or more matches, a cluster it cannot read, a
guest still locked mid-migration, or a link recorded before this feature and not yet fingerprinted
all leave the box **missing** for you to re-link with **Edit link**. Only the link moves: if the
guest's address changed on its new cluster, fix the box's host with Edit box. A migration that
*keeps* the source (`qm remote-migrate`'s default) leaves the old guest stopped where it was and is
not followed. While a moved guest is waiting for that poll, **Deprovision** on the missing box is
refused with the cluster it was found on — deprovisioning a missing guest releases its NetBox
address and forgets its host key, which would be wrong for a guest that is alive elsewhere. Plain
box removal is still available.
```

- [ ] **Step 3: Update CLAUDE.md and AGENTS.md**

In **both** files, in the `proxmoxInventory.js` entry, replace

```
  `listClusterNodes` (served by `GET /api/proxmox/nodes`) reports each physical node's health from
```

with

```
  Cross-cluster follow (spec 2026-10-05): every link carries `fp: { name, mac }` — the guest name
  and `net0` MAC (`macOfNet0` in `proxmoxParams.js`), stamped by the inventory alone on the first
  poll a guest is present, because once PDM deletes a migrated source its config is gone. A link
  reading `missing` searches every host profile (de-duplicated by endpoint, the refresh's own
  resource lists reused) for exactly one unlocked, non-template, unlinked guest of the same kind
  and name whose MAC matches, and re-homes `hostId`/`node`/`vmid`/`endpoint` under the node
  auto-follow's CAS + active-job guards. It fails closed on 0 or 2+ matches, on an unreadable
  profile (it could hold a second match), and on two missing boxes claiming one guest.
  `refreshBox(box, { follow: false })` writes neither a re-home nor a stamp — `proxmoxLifecycle.js`'s
  `createJob` uses it, since a re-home under its pre-check would desync the job's snapshot.
  `findFollowCandidates(box)` is the same search, read-only.
  `listClusterNodes` (served by `GET /api/proxmox/nodes`) reports each physical node's health from
```

and in the `proxmoxLifecycle.js` entry, replace

```
  and deletes any remaining NetBox records matching the box's current IP, so manually created
  records don't go stale (best-effort).
```

with

```
  and deletes any remaining NetBox records matching the box's current IP, so manually created
  records don't go stale (best-effort). Deprovision from `missing` of a fingerprinted link first
  asks `inventory.findFollowCandidates` — in `createJob` (409) and again in `runDeprovision`
  (the migration can land in between) — and refuses when the guest was found elsewhere or a
  cluster could not be read: that cleanup would otherwise release a live guest's NetBox record
  and forget its host key during the window before the status poll re-links it.
```

Verify both files changed identically:

```bash
diff <(git diff CLAUDE.md | grep '^[+-] ') <(git diff AGENTS.md | grep '^[+-] ')
```

Expected: no output.

- [ ] **Step 4: Scan for environment-specific values, then commit**

The real names live only in the gitignored `data/` files of the main checkout (a worktree has
none), so derive the tokens from there — never type them into a tracked file:

```bash
MAIN=<path to the main checkout>
node -e "
const b=require('$MAIN/data/boxes.json'), p=require('$MAIN/data/proxmox.json');
const t=[...b.map(x=>x.label), ...b.map(x=>x.host), ...p.hosts.map(h=>h.name), ...p.hosts.map(h=>String(h.endpoint).split(':')[0])];
console.log(t.filter(Boolean).join('\n'))" > /tmp/envtokens.txt
git diff main -- . | grep -nwF -f /tmp/envtokens.txt; echo "scan exit $?"; rm -f /tmp/envtokens.txt
```

Expected: `scan exit 1` (no matches). Also eyeball the diff for node names and for addresses
outside `192.168.1.x` — node names are not in those files.

```bash
git add src/web/proxmoxGuests.ts docs/proxmox.md CLAUDE.md AGENTS.md
git commit -m "docs(proxmox): document cross-cluster follow and the deprovision refusal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification, candidate deploy, live validation (operator)

**Files:** none (unless validation finds a defect — fix on the branch with a test first).

- [ ] **Step 1: Full suite in the worktree**

Run: `npm test`
Expected: typecheck clean, all vitest files pass. Then `npm run test:e2e` (the Proxmox path has no e2e of its own; this guards against collateral damage).

- [ ] **Step 2: Whole-branch review before deploying**

Use superpowers:requesting-code-review on the full branch diff against `main` (whole-branch reviews have caught defects per-task reviews missed on this codebase). Specifically ask the reviewer to check: every write path re-reads the box (CAS) and honours `activeJobGuard`; `follow: false` really suppresses both writes; no path can stamp `fp` from a different guest than the link names.

- [ ] **Step 3: Candidate deploy (only when no job is running)**

Confirm no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`. Then, from the worktree: `npm run build`; copy into the live checkout both the bundle (`rsync -a --delete <worktree>/dist/ ./dist/`) **and** the three changed server files (`src/server/proxmoxParams.js`, `src/server/proxmoxInventory.js`, `src/server/proxmoxLifecycle.js`) — a dist-only candidate of a server-touching feature validates the wrong code; then `sudo systemctl restart tmuxifier`. Fetch one hashed asset end-to-end and confirm its real content-type.

- [ ] **Step 4: Live validation with the operator**

1. Within one poll (~30s), confirm existing links gained `fp`: `node -e "console.log(require('./data/boxes.json').filter(b=>b.proxmox).map(b=>[b.label,!!b.proxmox.fp]))"` — expect `true` for every present guest that has a `net0`.
2. PDM-migrate a throwaway linked container to the other cluster with delete-source.
3. Before the next poll, try Deprovision on it in the Guests tab — expect the "guest found on …" refusal.
4. After the next poll: `journalctl -u tmuxifier -n 50 | grep 'guest moved'` shows the move; the Guests tab shows the guest on the new cluster; its terminal still connects.
5. Clean up: deprovision it from its new cluster.

- [ ] **Step 5: Hand off to shipping**

Only after the operator confirms the live validation: merge to `main` and run the CLAUDE.md "Shipping" checklist (version bump, build, restart, health check, PII review of the staged diff, tag, push, release).
