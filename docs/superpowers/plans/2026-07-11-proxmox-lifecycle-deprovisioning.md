# Proxmox Linked-Container Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make verified Proxmox-linked boxes state-aware and add persisted Start, Shutdown, Stop, Reboot, and graceful Deprovision workflows with manual box-to-LXC association.

**Architecture:** Keep provisioning isolated. Add a trusted box-link write path, a host/node-batched Proxmox inventory service, a dedicated persisted lifecycle manager/store, and a shared box-removal operation. Enrich the existing server status snapshot with fresh PVE state, then expose focused REST/fetch contracts and new Containers/Activity/association UI modules.

**Tech Stack:** Node.js 20+ ESM, Fastify 5, dependency-injected server factories, TypeScript DOM client, Vite, Vitest, OpenSSH/tmux session management, Proxmox VE HTTPS API.

**Spec:** `docs/superpowers/specs/2026-07-11-proxmox-lifecycle-deprovisioning-design.md`

## Global Constraints

- LXC only; no QEMU/VM lifecycle work.
- Never infer association from hostname, IP, MAC address, or VMID. Only provisioning and `PUT /api/boxes/:boxId/proxmox` may write linkage.
- Lifecycle requests address a linked box id only. The browser never supplies lifecycle `hostId`, `node`, or `vmid`.
- Generic box add/PATCH/import cannot create or mutate lifecycle authority; imports strip `source: 'proxmox'` and `proxmox` metadata.
- A fresh successful PVE response confirming `stopped` is the only condition that suppresses a red SSH failure and renders grey **Stopped**.
- PVE failure plus SSH failure stays red. A missing PVE target stays reachable when SSH succeeds and becomes red **Container missing** only when SSH also fails.
- Full lifecycle controls live in Proxmox **Containers**. Edit Box owns Link/Change/Unlink only.
- Every lifecycle action is a persisted bounded job; server restart reconciles running jobs to `interrupted` and never replays a destructive task.
- One active lifecycle job per canonical `hostId/node/vmid`; association change/unlink is blocked while that target is active.
- Deprovision requires exact current box-label confirmation, gracefully shuts down without force escalation, destroys attached container volumes, preserves independent backup archives, verifies absence, then removes the linked box.
- If graceful shutdown fails, the operator explicitly uses Stop and retries Deprovision. Never call Stop implicitly from Deprovision.
- PVE failure never removes the local box. Missing-container deprovision is an idempotent typed-confirmation cleanup path.
- Tokens/passwords remain server-only and never enter lifecycle job persistence or REST responses.
- Reuse `pvePollMs`, `pveTimeoutMs`, `pveProvisionTimeoutMs`, and `pveMaxJobs`; use a 65,536-byte lifecycle log cap and `statusPollMs * 2` display freshness. Add no config knobs.
- No new npm dependency and no new DOM test framework. UI verification is typecheck/build plus the final browser walkthrough.
- Public repository: committed values use `example.com`, RFC1918 examples, and `you@example.com`; never commit real hosts, IPs, emails, tokens, box names, or screenshots containing them.
- TDD for every server and pure-client behavior: add one failing behavior, observe the intended failure, implement minimally, and rerun focused plus neighboring suites before commit.

---

### Task 1: Make Proxmox linkage trusted store state

**Files:**
- Modify: `src/server/proxmoxValidate.js`
- Modify: `src/server/store.js`
- Modify: `src/server/proxmoxProvision.js`
- Modify: `test/proxmoxValidate.test.js`
- Modify: `test/store.test.js`
- Modify: `test/proxmoxProvision.test.js`

**Interfaces:**
- Produces `assertProxmoxLinkInput(spec, { hostIds = [] } = {}): void`.
- Produces `store.addBox(spec, { trustedProxmox = false } = {}): Promise<Box>`.
- Produces `store.setProxmoxLink(boxId, link): Promise<Box>` and `store.clearProxmoxLink(boxId): Promise<Box>`.
- Stored link shape is `{ hostId: string, node: string, vmid: number, endpoint: string }`.
- Provisioning becomes the only caller of `addBox(..., { trustedProxmox: true })`.

- [ ] **Step 1: Write failing pure-validation tests**

Add `assertProxmoxLinkInput` to `test/proxmoxValidate.test.js`'s existing `proxmoxValidate.js` named import, then append:

```js
test('assertProxmoxLinkInput accepts a configured host, safe node, and VMID', () => {
  expect(() => assertProxmoxLinkInput(
    { hostId: 'H1', node: 'pve-a', vmid: 131 },
    { hostIds: ['H1'] },
  )).not.toThrow();
});

test.each([
  [{ hostId: 'NOPE', node: 'pve', vmid: 131 }, /host/],
  [{ hostId: 'H1', node: '../pve', vmid: 131 }, /node/],
  [{ hostId: 'H1', node: 'pve', vmid: 99 }, /vmid/],
  [{ hostId: 'H1', node: 'pve', vmid: 1.5 }, /vmid/],
])('assertProxmoxLinkInput rejects unsafe linkage %#', (input, message) => {
  expect(() => assertProxmoxLinkInput(input, { hostIds: ['H1'] })).toThrow(message);
});

```

- [ ] **Step 2: Run the validator tests and verify RED**

Run: `npx vitest run test/proxmoxValidate.test.js --cache=false`

Expected: FAIL because `assertProxmoxLinkInput` is not exported.

- [ ] **Step 3: Implement the pure link validator**

Add beside the other Proxmox validators in `src/server/proxmoxValidate.js`:

```js
export function assertProxmoxLinkInput(spec, { hostIds = [] } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('proxmox link is required');
  if (!nonEmpty(spec.hostId)) throw new Error('proxmox host is required');
  if (!hostIds.includes(spec.hostId)) throw new Error('proxmox host is unknown');
  if (!/^[A-Za-z0-9_.-]+$/.test(String(spec.node || ''))) throw new Error('invalid proxmox node');
  if (!intInRange(spec.vmid, 100, 999999999)) throw new Error('vmid must be 100..999999999');
}
```

Run: `npx vitest run test/proxmoxValidate.test.js --cache=false`

Expected: PASS.

- [ ] **Step 4: Write failing store tests for trusted linkage and import hardening**

Replace the current permissive `addBox carries source...` test in `test/store.test.js` and append the following:

```js
const LINK = { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' };

test('ordinary addBox cannot create lifecycle authority', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10', source: 'proxmox', proxmox: LINK });
  expect(box.source).toBe('manual');
  expect(box.proxmox).toBeUndefined();
});

test('trusted provisioning addBox persists linkage', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox(
    { host: '192.168.1.10', source: 'proxmox', proxmox: LINK },
    { trustedProxmox: true },
  );
  expect(box).toMatchObject({ source: 'proxmox', proxmox: LINK });
});

test('setProxmoxLink writes one unique verified target; clear removes authority', async () => {
  const store = createStore({ dataDir: dir });
  const first = await store.addBox({ host: '192.168.1.10', label: 'first' });
  const second = await store.addBox({ host: '192.168.1.11', label: 'second' });
  expect(await store.setProxmoxLink(first.id, LINK)).toMatchObject({ source: 'proxmox', proxmox: LINK });
  await expect(store.setProxmoxLink(second.id, LINK)).rejects.toThrow(/already linked/);
  const reassigned = await store.setProxmoxLink(first.id, { ...LINK, vmid: 132 });
  expect(reassigned.proxmox.vmid).toBe(132);
  const cleared = await store.clearProxmoxLink(first.id);
  expect(cleared.source).toBe('manual');
  expect(cleared.proxmox).toBeUndefined();
});

test('updateBox cannot mutate source or proxmox linkage', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10' });
  await expect(store.updateBox(box.id, { proxmox: LINK })).rejects.toThrow(/link route/);
  await expect(store.updateBox(box.id, { source: 'proxmox' })).rejects.toThrow(/link route/);
});

test('import strips proxmox authority and source', async () => {
  const store = createStore({ dataDir: dir });
  const result = await store.importBoxes({ boxes: [
    { host: '192.168.1.10', label: 'imported', source: 'proxmox', proxmox: LINK },
  ] });
  expect(result.added[0].source).toBe('manual');
  expect(result.added[0].proxmox).toBeUndefined();
});
```

- [ ] **Step 5: Run store tests and verify RED**

Run: `npx vitest run test/store.test.js --cache=false`

Expected: failures show ordinary add/import preserve authority, `setProxmoxLink`/`clearProxmoxLink` are missing, and `updateBox` accepts forbidden fields.

- [ ] **Step 6: Implement trusted store writes**

Update `normalize` and the returned methods in `src/server/store.js`:

```js
  function normalize(spec, base = {}, { trustedProxmox = false } = {}) {
    if (!spec.host || typeof spec.host !== 'string') throw new Error('box requires a host');
    const link = trustedProxmox ? spec.proxmox : base.proxmox;
    return {
      id: base.id || randomUUID(),
      label: spec.label || base.label || spec.host,
      host: spec.host,
      user: spec.user ?? base.user,
      port: spec.port ?? base.port,
      proxyJump: spec.proxyJump ?? base.proxyJump,
      sessionName: sanitizeSession(spec.sessionName || base.sessionName || 'web'),
      startupCommand: spec.startupCommand ?? base.startupCommand,
      tags: normalizeTags(spec.tags),
      source: link ? 'proxmox' : 'manual',
      ...(link ? { proxmox: link } : {}),
      createdAt: base.createdAt || new Date().toISOString(),
    };
  }
```

Add a canonical target helper and methods:

```js
  const linkKey = (link) => `${link.hostId}\u0000${link.node}\u0000${link.vmid}`;

    async addBox(spec, { trustedProxmox = false } = {}) {
      const boxes = await readAll();
      const box = normalize(spec, {}, { trustedProxmox });
      assertBoxSafe(box);
      assertUniqueBox(boxes, box);
      boxes.push(box);
      await writeAll(boxes);
      return box;
    },
    async updateBox(id, patch) {
      if ('source' in patch || 'proxmox' in patch) throw new Error('proxmox linkage must use the dedicated link route');
      const boxes = await readAll();
      const index = boxes.findIndex((box) => box.id === id);
      if (index === -1) throw new Error('box not found');
      boxes[index] = normalize(
        { ...boxes[index], ...patch, host: patch.host ?? boxes[index].host },
        boxes[index],
      );
      for (const key of ['user', 'port', 'proxyJump']) {
        if (key in patch && patch[key] === null) boxes[index][key] = undefined;
      }
      assertBoxSafe(boxes[index]);
      assertUniqueBox(boxes, boxes[index], id);
      await writeAll(boxes);
      return boxes[index];
    },
    async setProxmoxLink(id, link) {
      const boxes = await readAll();
      const index = boxes.findIndex((box) => box.id === id);
      if (index === -1) throw new Error('box not found');
      const key = linkKey(link);
      if (boxes.some((box) => box.id !== id && box.proxmox && linkKey(box.proxmox) === key)) {
        throw new Error('proxmox container is already linked');
      }
      boxes[index] = normalize(
        { ...boxes[index], proxmox: link },
        boxes[index],
        { trustedProxmox: true },
      );
      assertBoxSafe(boxes[index]);
      await writeAll(boxes);
      return boxes[index];
    },
    async clearProxmoxLink(id) {
      const boxes = await readAll();
      const index = boxes.findIndex((box) => box.id === id);
      if (index === -1) throw new Error('box not found');
      const { proxmox: _link, ...base } = boxes[index];
      boxes[index] = { ...base, source: 'manual' };
      await writeAll(boxes);
      return boxes[index];
    },
```

In `importBoxes`, destructure untrusted fields before `addBox`:

```js
        const { id: _id, createdAt: _createdAt, source: _source, proxmox: _proxmox, ...safeSpec } = spec || {};
        added.push(await this.addBox(safeSpec));
```

- [ ] **Step 7: Make provisioning an explicit trusted writer**

In `src/server/proxmoxProvision.js`, change the auto-link call:

```js
        const box = await boxStore.addBox({
          label: j.hostname, host: boxHost, user: bd.user || 'root',
          sessionName: bd.sessionName || 'web', tags: (j.tags && j.tags.length) ? j.tags : (bd.tags || []),
          source: 'proxmox',
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, endpoint: host.endpoint },
        }, { trustedProxmox: true });
```

Update `fakeBoxStore()` in `test/proxmoxProvision.test.js` and add the assertion to the static-preset test:

```js
function fakeBoxStore() {
  const added = [];
  const addOptions = [];
  return {
    added, addOptions,
    addBox: async (spec, options) => {
      const box = { id: `box-${added.length + 1}`, ...spec };
      added.push(box); addOptions.push(options); return box;
    },
  };
}

expect(boxStore.addOptions[0]).toEqual({ trustedProxmox: true });
```

- [ ] **Step 8: Verify and commit trusted linkage**

Run:

```bash
npx vitest run test/proxmoxValidate.test.js test/store.test.js test/proxmoxProvision.test.js --cache=false
```

Expected: all focused tests pass.

Commit:

```bash
git add src/server/proxmoxValidate.js src/server/store.js src/server/proxmoxProvision.js test/proxmoxValidate.test.js test/store.test.js test/proxmoxProvision.test.js
git commit -m "feat(proxmox): secure linked box metadata"
```

---

### Task 2: Add the Proxmox LXC inventory and lifecycle API primitives

**Files:**
- Modify: `src/server/proxmoxApi.js`
- Modify: `test/proxmoxApi.test.js`

**Interfaces:**
- Produces `client.listLxc(node)`.
- Produces `client.shutdownLxc(node, vmid)`, `stopLxc`, `rebootLxc`, and `destroyLxc` alongside existing `startLxc`.
- All mutators resolve to a PVE UPID string.
- `destroyLxc` deletes container-owned volumes through PVE and never enumerates backup archives.

Upstream contract: Proxmox documents `forceStop=0` as a clean shutdown, `force=0` as the non-running-only destroy default, and `destroy-unreferenced-disks=1` as removing additional VMID-owned disks. `purge=1` removes stale backup-job/replication/HA configuration references, but the implementation never lists or deletes independent backup archive content: <https://pve.proxmox.com/pve-docs/pct.1.html>.

- [ ] **Step 1: Write failing request-contract tests**

Append to `test/proxmoxApi.test.js`:

```js
test('listLxc and lifecycle methods encode node/vmid into exact PVE paths', async () => {
  const request = fakeRequest((opts, index) => ({
    status: 200,
    json: { data: index === 0 ? [{ vmid: 131, name: 'dev-01', status: 'running' }] : `UPID:${index}` },
  }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });

  expect(await client.listLxc('pve/a')).toEqual([{ vmid: 131, name: 'dev-01', status: 'running' }]);
  await client.startLxc('pve/a', 131);
  await client.shutdownLxc('pve/a', 131);
  await client.stopLxc('pve/a', 131);
  await client.rebootLxc('pve/a', 131);
  await client.destroyLxc('pve/a', 131);

  expect(request.calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['GET', '/api2/json/nodes/pve%2Fa/lxc'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/start'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/shutdown'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/stop'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/reboot'],
    ['DELETE', '/api2/json/nodes/pve%2Fa/lxc/131'],
  ]);
  expect(request.calls[5].body).toContain('purge=1');
  expect(request.calls[5].body).toContain('destroy-unreferenced-disks=1');
  expect(request.calls[2].body).toContain('forceStop=0');
  expect(request.calls[5].body).not.toContain('force=1');
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `npx vitest run test/proxmoxApi.test.js --cache=false`

Expected: FAIL because `listLxc`, `shutdownLxc`, `stopLxc`, `rebootLxc`, and `destroyLxc` are missing.

- [ ] **Step 3: Implement the client methods**

Add to the client return object in `src/server/proxmoxApi.js`:

```js
    listLxc: (node) => call('GET', `/nodes/${enc(node)}/lxc`),
    shutdownLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/shutdown`, { forceStop: false }),
    stopLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/stop`, {}),
    rebootLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/reboot`, {}),
    destroyLxc: (node, vmid) => call('DELETE', `/nodes/${enc(node)}/lxc/${enc(vmid)}`, {
      purge: true,
      'destroy-unreferenced-disks': true,
    }),
```

Keep existing `startLxc`, `taskStatus`, and `taskLog` unchanged.

- [ ] **Step 4: Verify and commit PVE lifecycle primitives**

Run: `npx vitest run test/proxmoxApi.test.js test/proxmoxApi.integration.test.js --cache=false`

Expected: both suites pass.

Commit:

```bash
git add src/server/proxmoxApi.js test/proxmoxApi.test.js
git commit -m "feat(proxmox): add LXC lifecycle API methods"
```

---

### Task 3: Build host/node-batched Proxmox inventory

**Files:**
- Create: `src/server/proxmoxInventory.js`
- Create: `test/proxmoxInventory.test.js`

**Interfaces:**
- Consumes `proxmoxStore.getHost(id, { withSecret: true })` and `makeClient(host).listLxc(node)`.
- Produces `createProxmoxInventory({ proxmoxStore, makeClient, now, freshnessMs })`.
- Factory methods:
  - `refreshLinked(boxes): Promise<InventoryRecord[]>`
  - `refreshBox(box): Promise<InventoryRecord>`
  - `getLinkedContainers(boxes): Promise<InventoryRecord[]>`
  - `listNodeContainers(hostId, node, boxes): Promise<NodeContainer[]>`
  - `stateFor(box): InventoryRecord | undefined`
- Produces pure `mergeProxmoxStatus(snapshot, boxes, records): object` for Task 4.

- [ ] **Step 1: Create failing inventory tests**

Create `test/proxmoxInventory.test.js` with fixtures and these cases:

```js
import { test, expect } from 'vitest';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const linked = (id, node, vmid) => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, endpoint: HOST.endpoint },
});

function setup(listByNode = {}) {
  const calls = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({ listLxc: async (node) => { calls.push(node); return listByNode[node] || []; } }),
    now: () => 1000,
    freshnessMs: 60_000,
  });
  return { inventory, calls };
}

test('refreshLinked batches exactly once per host/node and maps VMIDs', async () => {
  const { inventory, calls } = setup({
    pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'dev-02', status: 'stopped' }],
    pve2: [{ vmid: 140, name: 'db-01', status: 'running' }],
  });
  const records = await inventory.refreshLinked([
    linked('b1', 'pve', 131), linked('b2', 'pve', 132), linked('b3', 'pve2', 140),
  ]);
  expect(calls.sort()).toEqual(['pve', 'pve2']);
  expect(records.map((record) => [record.boxId, record.state])).toEqual([
    ['b1', 'running'], ['b2', 'stopped'], ['b3', 'running'],
  ]);
});

test('missing target is explicit and failed host/node becomes unknown', async () => {
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({ listLxc: async (node) => { if (node === 'bad') throw new Error('PVE down'); return []; } }),
    now: () => 1000,
  });
  expect((await inventory.refreshBox(linked('missing', 'pve', 131))).state).toBe('missing');
  expect((await inventory.refreshBox(linked('bad', 'bad', 132))).state).toBe('unknown');
});

test('overlapping refreshes coalesce', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ listLxc: async () => { calls += 1; await gate; return [{ vmid: 131, status: 'running' }]; } }),
  });
  const first = inventory.refreshLinked([box]);
  const second = inventory.refreshLinked([box]);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test('legacy duplicate links retain box-specific records while sharing one node request', async () => {
  const { inventory, calls } = setup({ pve: [{ vmid: 131, name: 'dev-01', status: 'running' }] });
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 131)];
  const records = await inventory.refreshLinked(boxes);
  expect(records.map((record) => record.boxId)).toEqual(['b1', 'b2']);
  expect(inventory.stateFor(boxes[0]).boxId).toBe('b1');
  expect(inventory.stateFor(boxes[1]).boxId).toBe('b2');
  expect(calls).toEqual(['pve']);
});

test('stateFor expires cached display authority', async () => {
  let at = 1000;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ listLxc: async () => [{ vmid: 131, status: 'stopped' }] }),
    now: () => at,
    freshnessMs: 100,
  });
  await inventory.refreshBox(box);
  expect(inventory.stateFor(box).state).toBe('stopped');
  at = 1101;
  expect(inventory.stateFor(box)).toBeUndefined();
});

test('listNodeContainers annotates existing links', async () => {
  const { inventory } = setup({ pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'free', status: 'stopped' }] });
  expect(await inventory.listNodeContainers('H1', 'pve', [linked('b1', 'pve', 131)])).toEqual([
    { hostId: 'H1', node: 'pve', vmid: 131, name: 'dev-01', state: 'running', linkedBoxId: 'b1' },
    { hostId: 'H1', node: 'pve', vmid: 132, name: 'free', state: 'stopped', linkedBoxId: null },
  ]);
});

test('mergeProxmoxStatus adds state without hiding reachable missing links', () => {
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 132)];
  const merged = mergeProxmoxStatus(
    { b1: { reachable: false, error: 'timeout' }, b2: { reachable: true, tmux: true } },
    boxes,
    [
      { boxId: 'b1', state: 'stopped', node: 'pve', vmid: 131 },
      { boxId: 'b2', state: 'missing', node: 'pve', vmid: 132 },
    ],
  );
  expect(merged.b1).toMatchObject({ reachable: false, proxmoxState: 'stopped', proxmoxVmid: 131 });
  expect(merged.b2).toMatchObject({ reachable: true, proxmoxState: 'missing' });
});
```

- [ ] **Step 2: Run inventory tests and verify RED**

Run: `npx vitest run test/proxmoxInventory.test.js --cache=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the inventory factory**

Create `src/server/proxmoxInventory.js` with these concrete helpers and factory behavior:

```js
const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const groupKey = (link) => `${link.hostId}\u0000${link.node}`;
const normalizeState = (status) => status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown';

export function mergeProxmoxStatus(snapshot, boxes, records) {
  const next = { ...snapshot };
  const byBox = new Map((records || []).map((record) => [record.boxId, record]));
  for (const box of boxes) {
    if (!box.proxmox) continue;
    const record = byBox.get(box.id);
    if (!record) continue;
    next[box.id] = {
      ...(next[box.id] || { reachable: false }),
      proxmoxState: record.state,
      proxmoxNode: record.node,
      proxmoxVmid: record.vmid,
    };
  }
  return next;
}

export function createProxmoxInventory({
  proxmoxStore,
  makeClient,
  now = () => Date.now(),
  freshnessMs = 60_000,
}) {
  const cache = new Map();
  let inFlight = null;

  async function fetchGroup(hostId, node, groupBoxes) {
    const host = await proxmoxStore.getHost(hostId, { withSecret: true });
    if (!host) return groupBoxes.map((box) => ({ boxId: box.id, boxLabel: box.label, hostId, hostName: null, node, vmid: box.proxmox.vmid, containerName: null, state: 'unknown', fetchedAt: now(), error: 'host profile missing' }));
    try {
      const list = await makeClient(host).listLxc(node);
      const byVmid = new Map((list || []).map((item) => [Number(item.vmid), item]));
      return groupBoxes.map((box) => {
        const item = byVmid.get(Number(box.proxmox.vmid));
        return {
          boxId: box.id, boxLabel: box.label, hostId, hostName: host.name, node,
          vmid: Number(box.proxmox.vmid), containerName: item?.name || null,
          state: item ? normalizeState(item.status) : 'missing', fetchedAt: now(), error: null,
        };
      });
    } catch (error) {
      return groupBoxes.map((box) => ({ boxId: box.id, boxLabel: box.label, hostId, hostName: host.name, node, vmid: Number(box.proxmox.vmid), containerName: null, state: 'unknown', fetchedAt: now(), error: error.message }));
    }
  }

  async function doRefresh(boxes) {
    const groups = new Map();
    for (const box of boxes.filter((item) => item.proxmox)) {
      const key = groupKey(box.proxmox);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(box);
    }
    const records = (await Promise.all([...groups.entries()].map(([key, groupBoxes]) => {
      const [hostId, node] = key.split('\u0000');
      return fetchGroup(hostId, node, groupBoxes);
    }))).flat();
    for (const record of records) cache.set(record.boxId, record);
    return records;
  }

  function refreshLinked(boxes) {
    if (inFlight) return inFlight;
    inFlight = doRefresh(boxes).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    refreshLinked,
    async refreshBox(box) { return (await doRefresh([box]))[0]; },
    async getLinkedContainers(boxes) { return refreshLinked(boxes); },
    async listNodeContainers(hostId, node, boxes) {
      const host = await proxmoxStore.getHost(hostId, { withSecret: true });
      if (!host) throw new Error('proxmox host not found');
      const linked = new Map(boxes.filter((box) => box.proxmox).map((box) => [targetKey(box.proxmox), box.id]));
      return (await makeClient(host).listLxc(node)).map((item) => ({
        hostId, node, vmid: Number(item.vmid), name: item.name || String(item.vmid),
        state: normalizeState(item.status),
        linkedBoxId: linked.get(targetKey({ hostId, node, vmid: item.vmid })) || null,
      }));
    },
    stateFor(box) {
      const record = box.proxmox ? cache.get(box.id) : undefined;
      return record && now() - record.fetchedAt <= freshnessMs ? record : undefined;
    },
  };
}
```

During implementation, keep `refreshLinked` coalescing scoped to one global status cycle. Lifecycle uses `refreshBox`, which bypasses that shared promise so it never receives an unrelated box's record.

- [ ] **Step 4: Verify and commit inventory**

Run: `npx vitest run test/proxmoxInventory.test.js --cache=false`

Expected: all inventory tests pass.

Commit:

```bash
git add src/server/proxmoxInventory.js test/proxmoxInventory.test.js
git commit -m "feat(proxmox): add linked container inventory"
```

---

### Task 4: Enrich status and health history with Proxmox state

**Files:**
- Modify: `src/server/statusPoller.js`
- Modify: `src/server/healthHistory.js`
- Modify: `src/web/api.ts`
- Modify: `src/web/statusDot.ts`
- Modify: `test/statusPoller.test.js`
- Modify: `test/healthHistory.test.js`
- Modify: `test/statusDot.test.js`

**Interfaces:**
- `createStatusPoller` consumes optional `statusEnricher: { collect(boxes), merge(snapshot, boxes, collected) }`.
- Status fields are `proxmoxState?: 'running' | 'stopped' | 'missing' | 'unknown'`, `proxmoxNode?: string`, and `proxmoxVmid?: number`.
- `sampleOf` emits `{ stopped: true, up: true }` for confirmed stopped boxes to suppress false down/up health edges.

- [ ] **Step 1: Write failing poller enrichment tests**

Add to `test/statusPoller.test.js`:

```js
test('pollOnce starts PVE collection in the same cycle and records the enriched snapshot', async () => {
  const boxes = [{ id: 'b1', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131 } }];
  const order = [];
  const records = [];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: { checkBox: async () => { order.push('ssh'); return { reachable: false, error: 'timeout' }; } },
    statusEnricher: {
      collect: async () => { order.push('pve'); return [{ boxId: 'b1', state: 'stopped', node: 'pve', vmid: 131 }]; },
      merge: (snapshot, bx, pve) => ({ b1: { ...snapshot.b1, proxmoxState: pve[0].state, proxmoxVmid: pve[0].vmid } }),
    },
    history: { record: (snapshot) => records.push(snapshot) },
  });
  const snapshot = await poller.pollOnce();
  expect(order).toEqual(expect.arrayContaining(['pve', 'ssh']));
  expect(snapshot.b1.proxmoxState).toBe('stopped');
  expect(records[0]).toEqual(snapshot);
});

test('a throwing PVE collector preserves the SSH snapshot', async () => {
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: false, error: 'timeout' }) },
    statusEnricher: { collect: async () => { throw new Error('PVE down'); }, merge: () => ({}) },
  });
  expect(await poller.pollOnce()).toEqual({ b1: { reachable: false, error: 'timeout' } });
});
```

- [ ] **Step 2: Run poller tests and verify RED**

Run: `npx vitest run test/statusPoller.test.js --cache=false`

Expected: the new state is absent because `statusEnricher` is ignored.

- [ ] **Step 3: Implement concurrent collection and merge**

In `src/server/statusPoller.js`, add `statusEnricher = null` to factory parameters and update the poll cycle:

```js
      const boxes = await store.listBoxes();
      const collected = statusEnricher
        ? Promise.resolve().then(() => statusEnricher.collect(boxes)).catch(() => null)
        : Promise.resolve(null);
      const next = {};
      await mapWithConcurrency(boxes, concurrency, async (box) => {
        next[box.id] = await statusChecker.checkBox(box);
      });
      const pve = await collected;
      snapshot = pve && statusEnricher
        ? statusEnricher.merge(next, boxes, pve)
        : next;
```

Keep wholesale swap, overlap coalescing, and history ordering unchanged.

- [ ] **Step 4: Write failing health and dot tests**

Add to `test/healthHistory.test.js`:

```js
test('confirmed Proxmox stopped is healthy-for-events and carries a stopped marker', () => {
  expect(sampleOf({ reachable: false, proxmoxState: 'stopped' }, 5)).toEqual({ t: 5, up: true, stopped: true });
});

test('running to stopped does not emit a false down event', () => {
  const history = createHealthHistory({});
  history.record({ b1: { reachable: true, proxmoxState: 'running' } }, [BOXES[0]]);
  history.record({ b1: { reachable: false, proxmoxState: 'stopped' } }, [BOXES[0]]);
  expect(history.getEvents({}).events).toEqual([]);
});
```

Add to `test/statusDot.test.js`:

```js
test('confirmed stopped is grey and names the managed state', () => {
  const status = { reachable: false, error: 'timeout', proxmoxState: 'stopped', proxmoxNode: 'pve', proxmoxVmid: 131 };
  expect(dotClassFor(status)).toBe('gray');
  expect(dotTitleFor(status)).toBe('Stopped on Proxmox');
  expect(metaLine(status)).toContain('Stopped');
  expect(metaLine(status)).not.toContain('timeout');
});

test('unknown PVE state does not hide an SSH failure', () => {
  expect(dotClassFor({ reachable: false, proxmoxState: 'unknown' })).toBe('red');
});

test('missing PVE target stays green when SSH works and is red when SSH fails', () => {
  expect(dotClassFor({ reachable: true, tmux: true, proxmoxState: 'missing' })).toBe('green');
  expect(metaLine({ reachable: true, tmux: true, proxmoxState: 'missing' })).toContain('PVE link missing');
  expect(dotClassFor({ reachable: false, proxmoxState: 'missing' })).toBe('red');
  expect(metaLine({ reachable: false, proxmoxState: 'missing' })).toContain('Container missing');
});
```

- [ ] **Step 5: Run health/dot tests and verify RED**

Run: `npx vitest run test/healthHistory.test.js test/statusDot.test.js --cache=false`

Expected: stopped is currently down/red and missing lacks the required metadata.

- [ ] **Step 6: Implement status types, health projection, and display precedence**

In `src/web/api.ts`, extend `Status` and `Sample`:

```ts
export type ProxmoxBoxState = 'running' | 'stopped' | 'missing' | 'unknown';
export interface Status {
  reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean;
  nextProbeAt?: number; sessions?: { name: string; windows: number; attached?: boolean; activity?: number }[];
  metrics?: BoxMetrics; error?: string;
  proxmoxState?: ProxmoxBoxState; proxmoxNode?: string; proxmoxVmid?: number;
}
export interface Sample { t: number; up: boolean; stopped?: boolean; tmux?: boolean; needsAuth?: boolean; cpuPct?: number; memPct?: number; diskPct?: number; }
```

At the start of `sampleOf` in `src/server/healthHistory.js`:

```js
  const stopped = s.proxmoxState === 'stopped';
  const sample = { t: at, up: stopped || (!!s.reachable && !s.needsAuth) };
  if (stopped) sample.stopped = true;
```

In `src/web/statusDot.ts`, replace `dotClassFor`, `dotTitleFor`, and `metaSegmentsFor`, extracting the current metric body into this complete helper:

```ts
export function dotClassFor(st: Status | undefined): DotClass {
  if (!st) return 'gray';
  if (st.proxmoxState === 'stopped') return 'gray';
  if (st.needsAuth) return 'auth';
  if (!st.reachable) return 'red';
  return st.tmux === false ? 'amber' : 'green';
}

export function dotTitleFor(st: Status | undefined): string {
  if (!st) return 'Status unknown';
  if (st.proxmoxState === 'stopped') return 'Stopped on Proxmox';
  if (st.proxmoxState === 'missing' && !st.reachable) return 'Proxmox container missing';
  if (st.needsAuth) return 'Needs login - click the box (or refresh) to reconnect and enter your password';
  if (!st.reachable) {
    const reason = classifyError(st.error);
    const base = reason && reason !== 'Unreachable' ? `Unreachable - ${reason}` : 'Unreachable';
    return st.paused ? `${base}; retrying every 5m, click the box or refresh to retry now` : base;
  }
  return st.tmux === false ? 'Reachable (tmux not running)' : 'Connected';
}

function metricSegments(m: BoxMetrics | undefined): MetaSegment[] {
  if (!m) return [];
  const segments: MetaSegment[] = [];
  const cpuIcon = { icon: CPU_ICON, iconClass: 'nf' };
  if (m.cpuPct != null) {
    segments.push({ text: `${m.cpuPct}%`, ...cpuIcon, level: cpuLevel(m.cpuPct), title: `CPU ${m.cpuPct}% utilization (cgroup - matches Proxmox)`, metric: 'cpu' });
  } else if (m.cpuUsageUsec == null) {
    const pct = cpuLoadPct(m);
    if (pct != null) {
      segments.push({ text: `${pct}%`, ...cpuIcon, level: cpuLevel(pct), title: `load ${m.load1} / ${m.cpus} cores (${pct}%) - load-based fallback, no cgroup; counts IO-waiting processes`, metric: 'cpu' });
    } else if (m.load1 != null) {
      segments.push({ text: m.load1.toFixed(2), ...cpuIcon, title: 'CPU load average (core count unknown)', metric: 'cpu' });
    }
  }
  if (m.memTotalKb && m.memAvailKb != null) {
    segments.push({ text: `${Math.round((1 - m.memAvailKb / m.memTotalKb) * 100)}%`, icon: '\u{1F9E0}', title: 'RAM used', metric: 'mem' });
  }
  const diskPct = m.diskPct != null
    ? m.diskPct
    : (m.diskTotalKb && m.diskUsedKb != null ? Math.round((m.diskUsedKb / m.diskTotalKb) * 100) : undefined);
  if (diskPct != null) segments.push({ text: `${diskPct}%`, icon: '\u{1F4BE}', title: 'Disk used (root filesystem /)', metric: 'disk' });
  return segments;
}

export function metaSegmentsFor(st: Status | undefined): MetaSegment[] {
  if (!st) return [];
  if (st.proxmoxState === 'stopped') return [{ text: `Stopped | ${st.proxmoxNode ?? 'PVE'} / ${st.proxmoxVmid ?? '?'}` }];
  if (st.proxmoxState === 'missing' && !st.reachable) return [{ text: 'Container missing', level: 'crit' }];
  if (st.needsAuth) return [{ text: 'Needs login', level: 'auth' }];
  if (!st.reachable) return [{ text: classifyError(st.error), level: 'crit' }];
  if (st.proxmoxState === 'missing') return [{ text: 'PVE link missing', level: 'warn' }, ...metricSegments(st.metrics)];
  return metricSegments(st.metrics);
}
```

- [ ] **Step 7: Verify and commit status enrichment**

Run:

```bash
npx vitest run test/statusPoller.test.js test/healthHistory.test.js test/statusDot.test.js --cache=false
npm run typecheck
```

Expected: all pass.

Commit:

```bash
git add src/server/statusPoller.js src/server/healthHistory.js src/web/api.ts src/web/statusDot.ts test/statusPoller.test.js test/healthHistory.test.js test/statusDot.test.js
git commit -m "feat(status): add Proxmox-managed box states"
```

---

### Task 5: Persist lifecycle jobs independently from provisions

**Files:**
- Create: `src/server/proxmoxLifecycleStore.js`
- Create: `test/proxmoxLifecycleStore.test.js`

**Interfaces:**
- Produces `createProxmoxLifecycleStore({ dataDir }) -> { load(), save(jobs), whenIdle() }`.
- Persists only `data/proxmox-lifecycle-jobs.json` using atomic writes.

- [ ] **Step 1: Write the failing persistence tests**

Create `test/proxmoxLifecycleStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProxmoxLifecycleStore } from '../src/server/proxmoxLifecycleStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-lifecycle-')); });

test('missing lifecycle history loads empty', () => {
  expect(createProxmoxLifecycleStore({ dataDir: dir }).load()).toEqual([]);
});

test('save/load round-trips lifecycle jobs', async () => {
  const store = createProxmoxLifecycleStore({ dataDir: dir });
  store.save([{ id: 'j1', action: 'start', status: 'done' }]);
  await store.whenIdle();
  expect(createProxmoxLifecycleStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', action: 'start', status: 'done' }]);
});

test('corrupt lifecycle history is quarantined before the next save', async () => {
  await fs.writeFile(path.join(dir, 'proxmox-lifecycle-jobs.json'), 'not json');
  const store = createProxmoxLifecycleStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j2' }]);
  await store.whenIdle();
  expect((await fs.readdir(dir)).filter((name) => name.startsWith('proxmox-lifecycle-jobs.json.corrupt-'))).toHaveLength(1);
});
```

- [ ] **Step 2: Run lifecycle-store tests and verify RED**

Run: `npx vitest run test/proxmoxLifecycleStore.test.js --cache=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the store**

Create `src/server/proxmoxLifecycleStore.js` by using the exact `provisionStore.js` state machine with only these substitutions:

```js
import path from 'node:path';
import { readJsonSync, writeFileAtomic } from './jsonFile.js';

export function createProxmoxLifecycleStore({ dataDir }) {
  const file = path.join(dataDir, 'proxmox-lifecycle-jobs.json');
  let pending = null;
  let flushing = false;
  let idleResolvers = [];
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending !== null) {
        const data = pending;
        pending = null;
        await writeFileAtomic(file, data);
      }
    } catch {
      // Persistence is best effort; lifecycle execution must keep its in-memory result.
    } finally {
      flushing = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
  return {
    load() { return readJsonSync(file, { fallback: [], validate: Array.isArray }); },
    save(jobs) {
      try { pending = JSON.stringify(jobs, null, 2); } catch { return; }
      void flush();
    },
    whenIdle() {
      if (!flushing && pending === null) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
```

- [ ] **Step 4: Verify and commit lifecycle persistence**

Run: `npx vitest run test/proxmoxLifecycleStore.test.js --cache=false`

Expected: PASS.

Commit:

```bash
git add src/server/proxmoxLifecycleStore.js test/proxmoxLifecycleStore.test.js
git commit -m "feat(proxmox): persist lifecycle jobs"
```

---

### Task 6: Implement persisted Start, Shutdown, Stop, and Reboot jobs

**Files:**
- Create: `src/server/proxmoxLifecycle.js`
- Create: `test/proxmoxLifecycle.test.js`

**Interfaces:**
- Produces `createProxmoxLifecycleManager({...})` with `createJob`, `getJob`, `listJobs`, `hasActiveJob`, `hasActiveTarget`, and `_settled`.
- `createJob({ boxId, action, confirmName? })` resolves a summary immediately; `_settled(id)` waits in tests.
- Job statuses: `running | done | error | interrupted`.
- Routine phases: `resolve | request | verify | done`.
- Service errors carry `statusCode` (`404` missing, `409` conflict, `502` PVE lookup before job creation).

- [ ] **Step 1: Write failing lifecycle-manager tests for routine actions**

Create `test/proxmoxLifecycle.test.js` with a deterministic fixture:

```js
import { test, expect } from 'vitest';
import { createProxmoxLifecycleManager } from '../src/server/proxmoxLifecycle.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const BOX = { id: 'B1', label: 'dev-01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: HOST.endpoint } };

function fixture(initialState = 'stopped', overrides = {}) {
  let state = initialState;
  const calls = [];
  const client = {
    startLxc: async () => { calls.push('start'); state = 'running'; return 'UPID:start'; },
    shutdownLxc: async () => { calls.push('shutdown'); state = 'stopped'; return 'UPID:shutdown'; },
    stopLxc: async () => { calls.push('stop'); state = 'stopped'; return 'UPID:stop'; },
    rebootLxc: async () => { calls.push('reboot'); state = 'running'; return 'UPID:reboot'; },
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'task output' }],
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: { getBox: async (id) => id === 'B1' ? BOX : undefined },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131 }) },
    makeClient: () => client,
    load: () => [], save: () => {}, sleep: async () => {}, pollMs: 0,
    now: () => '2026-07-11T00:00:00.000Z', makeId: () => 'J1',
    ...overrides,
  });
  return { manager, calls, getState: () => state };
}

test.each([
  ['start', 'stopped', 'running'],
  ['shutdown', 'running', 'stopped'],
  ['stop', 'running', 'stopped'],
  ['reboot', 'running', 'running'],
])('%s creates, polls, verifies, and persists a terminal job', async (action, initial, final) => {
  const { manager, calls, getState } = fixture(initial);
  const summary = await manager.createJob({ boxId: 'B1', action });
  expect(summary).toMatchObject({ id: 'J1', action, status: 'running', boxId: 'B1', vmid: 131 });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done', phase: 'done', error: null });
  expect(calls).toContain(action);
  expect(getState()).toBe(final);
});

test.each([
  ['start', 'running'], ['shutdown', 'stopped'], ['stop', 'stopped'], ['reboot', 'stopped'],
])('%s rejects invalid %s transition before creating a job', async (action, state) => {
  const { manager } = fixture(state);
  await expect(manager.createJob({ boxId: 'B1', action })).rejects.toMatchObject({ statusCode: 409 });
  expect(manager.listJobs()).toEqual([]);
});

test('unknown PVE state is a preflight gateway failure and target coordinates are rejected', async () => {
  const { manager } = fixture('unknown');
  await expect(manager.createJob({ boxId: 'B1', action: 'start' })).rejects.toMatchObject({ statusCode: 502 });
  await expect(manager.createJob({ boxId: 'B1', action: 'start', vmid: 999 })).rejects.toMatchObject({ statusCode: 400 });
  expect(manager.listJobs()).toEqual([]);
});

test('one active target rejects a concurrent lifecycle job', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let state = 'stopped';
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => { await gate; return { status: 'stopped', exitstatus: 'OK' }; },
      taskLog: async () => [],
    }),
  });
  const first = await manager.createJob({ boxId: 'B1', action: 'start' });
  await expect(manager.createJob({ boxId: 'B1', action: 'start' })).rejects.toMatchObject({ statusCode: 409 });
  release();
  await manager._settled(first.id);
});

test('task failure is terminal immediately and task logs stay bounded', async () => {
  const { manager } = fixture('stopped', {
    makeClient: () => ({
      startLxc: async () => 'UPID:start',
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'permission denied' }),
      taskLog: async () => [{ n: 1, t: '0123456789abcdef' }],
    }),
    maxLogBytes: 12,
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'task failed: permission denied' });
  expect(manager.getJob(job.id).log.length).toBeLessThanOrEqual(12);
});

test('task polling tolerates a transient status failure', async () => {
  let state = 'stopped';
  let attempts = 0;
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => { if (++attempts === 1) throw new Error('pveproxy restart'); return { status: 'stopped', exitstatus: 'OK' }; },
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(attempts).toBe(2);
});

test('routine action revalidates the stored target before mutating PVE', async () => {
  let reads = 0;
  const calls = [];
  const { manager } = fixture('stopped', {
    boxStore: { getBox: async () => ++reads === 1 ? BOX : { ...BOX, proxmox: { ...BOX.proxmox, vmid: 999 } } },
    makeClient: () => ({ startLxc: async () => calls.push('start') }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual([]);
});

test('startup retention keeps only the newest bounded terminal history', () => {
  const { manager } = fixture('running', {
    maxJobs: 2,
    load: () => [
      { id: 'old', action: 'reboot', status: 'done', createdAt: '2026-07-09T00:00:00Z' },
      { id: 'mid', action: 'reboot', status: 'done', createdAt: '2026-07-10T00:00:00Z' },
      { id: 'new', action: 'reboot', status: 'done', createdAt: '2026-07-11T00:00:00Z' },
    ],
  });
  expect(manager.listJobs().map((job) => job.id)).toEqual(['new', 'mid']);
});

test('startup reconciliation interrupts running jobs without replaying them', () => {
  const saved = [];
  const { manager } = fixture('running', {
    load: () => [{ id: 'old', action: 'reboot', status: 'running', phase: 'request', createdAt: 'x' }],
    save: (jobs) => saved.push(jobs),
  });
  expect(manager.getJob('old').status).toBe('interrupted');
  expect(saved[0][0].status).toBe('interrupted');
});
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npx vitest run test/proxmoxLifecycle.test.js --cache=false`

Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement manager scaffolding, state gates, polling, and routine runs**

Create `src/server/proxmoxLifecycle.js` with these exact public contracts and helpers:

```js
import { randomUUID } from 'node:crypto';

const ACTIONS = new Set(['start', 'shutdown', 'stop', 'reboot']);
const TERMINAL = new Set(['done', 'error', 'interrupted']);
const REQUIRED = { start: 'stopped', shutdown: 'running', stop: 'running', reboot: 'running' };
const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const serviceError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function createProxmoxLifecycleManager({
  boxStore, proxmoxStore, inventory, makeClient,
  load = () => [], save = () => {}, now = () => new Date().toISOString(), makeId = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1500,
  taskTimeoutMs = 600_000, maxPollFailures = 5,
  maxJobs = 50, maxLogBytes = 65_536,
}) {
  const jobs = new Map();
  const settles = new Map();
  for (const job of load() || []) {
    if (!TERMINAL.has(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || now();
    }
    jobs.set(job.id, job);
  }
  const ordered = () => [...jobs.values()].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  const prune = () => {
    const terminal = ordered().filter((job) => TERMINAL.has(job.status));
    for (const job of terminal.slice(maxJobs)) jobs.delete(job.id);
  };
  const persist = () => { prune(); save(ordered()); };
  const appendLog = (job, text) => { if (text) job.log = `${job.log}${text}`.slice(-maxLogBytes); };
  const summary = (job) => ({ id: job.id, action: job.action, boxId: job.boxId, boxLabel: job.boxLabel, hostId: job.hostId, hostName: job.hostName, node: job.node, vmid: job.vmid, status: job.status, phase: job.phase, error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt });
  persist();

  async function pollTask(client, job, upid) {
    const deadline = Date.now() + taskTimeoutMs;
    let logStart = 0;
    let failures = 0;
    for (;;) {
      const lines = await client.taskLog(job.node, upid, logStart).catch(() => []);
      if (Array.isArray(lines) && lines.length) {
        logStart += lines.length;
        appendLog(job, `${lines.map((line) => line.t).join('\n')}\n`);
        persist();
      }
      let status = null;
      try {
        status = await client.taskStatus(job.node, upid);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= maxPollFailures) throw error;
      }
      if (status?.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') throw new Error(`task failed: ${status.exitstatus}`);
        return;
      }
      if (Date.now() > deadline) throw new Error('task timed out');
      await sleep(pollMs);
    }
  }

  async function resolveTarget(job) {
    const box = await boxStore.getBox(job.boxId);
    if (!box || !box.proxmox || targetKey(box.proxmox) !== targetKey(job)) {
      throw new Error('box Proxmox link changed before lifecycle action');
    }
    const host = await proxmoxStore.getHost(job.hostId, { withSecret: true });
    if (!host) throw new Error('Proxmox host profile is unavailable');
    return { box, client: makeClient(host) };
  }

  async function waitForState(job, expected, timeoutMs = taskTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { box } = await resolveTarget(job);
      const record = await inventory.refreshBox(box);
      if (record.state === expected) return record;
      if (record.state === 'unknown') throw new Error(record.error || 'Proxmox state unavailable');
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expected}`);
      await sleep(pollMs);
    }
  }

  async function runRoutine(job) {
    const { box, client } = await resolveTarget(job);
    const current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state !== REQUIRED[job.action]) throw new Error(`${job.action} requires ${REQUIRED[job.action]}`);
    job.phase = 'request'; persist();
    const method = `${job.action}Lxc`;
    const upid = await client[method](job.node, job.vmid);
    appendLog(job, `# ${job.action} ${upid}\n`); persist();
    await pollTask(client, job, upid);
    job.phase = 'verify'; persist();
    const expected = job.action === 'start' || job.action === 'reboot' ? 'running' : 'stopped';
    await waitForState(job, expected);
  }

  async function run(job) {
    try {
      await runRoutine(job);
      job.phase = 'done'; job.status = 'done'; job.finishedAt = now(); persist();
    } catch (error) {
      job.status = 'error'; job.error = error instanceof Error ? error.message : 'lifecycle action failed'; job.finishedAt = now(); persist();
    }
  }

  async function createJob(input = {}) {
    if (['hostId', 'node', 'vmid'].some((key) => key in input)) {
      throw serviceError(400, 'lifecycle targets are resolved from the box link');
    }
    const { boxId, action } = input;
    if (typeof boxId !== 'string' || !boxId) throw serviceError(400, 'boxId is required');
    if (!ACTIONS.has(action)) throw serviceError(400, 'invalid lifecycle action');
    const box = await boxStore.getBox(boxId);
    if (!box) throw serviceError(404, 'box not found');
    if (!box.proxmox) throw serviceError(409, 'box is not linked to Proxmox');
    const key = targetKey(box.proxmox);
    if ([...jobs.values()].some((job) => job.status === 'running' && targetKey(job) === key)) throw serviceError(409, 'container already has an active lifecycle job');
    const host = await proxmoxStore.getHost(box.proxmox.hostId, { withSecret: true });
    if (!host) throw serviceError(404, 'proxmox host not found');
    const current = await inventory.refreshBox(box).catch((error) => { throw serviceError(502, error.message); });
    if (current.state === 'unknown') throw serviceError(502, current.error || 'Proxmox state unavailable');
    if (current.state !== REQUIRED[action]) throw serviceError(409, `${action} requires ${REQUIRED[action]}`);
    const job = {
      id: makeId(), action, boxId: box.id, boxLabel: box.label,
      hostId: host.id, hostName: host.name, node: box.proxmox.node, vmid: Number(box.proxmox.vmid),
      status: 'running', phase: 'resolve', log: '', error: null,
      createdAt: now(), finishedAt: null,
    };
    jobs.set(job.id, job); persist();
    const settled = run(job);
    settles.set(job.id, settled);
    return summary(job);
  }

  return {
    createJob,
    getJob: (id) => jobs.get(id),
    listJobs: () => ordered().map(summary),
    hasActiveJob: (boxId) => [...jobs.values()].some((job) => job.boxId === boxId && job.status === 'running'),
    hasActiveTarget: (link) => [...jobs.values()].some((job) => targetKey(job) === targetKey(link) && job.status === 'running'),
    _settled: (id) => settles.get(id) || Promise.resolve(),
  };
}
```

Task 7 extends this complete routine-action manager with Deprovision. Do not expose routes yet.

- [ ] **Step 4: Verify routine lifecycle behavior and commit**

Run: `npx vitest run test/proxmoxLifecycle.test.js --cache=false`

Expected: routine action, transition, conflict, and reconciliation tests pass.

Commit:

```bash
git add src/server/proxmoxLifecycle.js test/proxmoxLifecycle.test.js
git commit -m "feat(proxmox): add persisted lifecycle actions"
```

---

### Task 7: Add shared box removal and graceful deprovision

**Files:**
- Create: `src/server/boxRemoval.js`
- Create: `test/boxRemoval.test.js`
- Modify: `src/server/proxmoxLifecycle.js`
- Modify: `test/proxmoxLifecycle.test.js`
- Modify: `src/server/index.js`
- Modify: `src/server/server.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Produces `createBoxRemoval({ store, sessions, boxActions }) -> async removeBox(id)`.
- Replaces the inline `DELETE /api/boxes/:id` cleanup with injected `removeBox`.
- Extends the routine lifecycle manager with the approved shutdown -> destroy -> verify -> unlink state machine.

- [ ] **Step 1: Write failing shared-removal tests**

Create `test/boxRemoval.test.js`:

```js
import { test, expect } from 'vitest';
import { createBoxRemoval } from '../src/server/boxRemoval.js';

test('removeBox closes both session keys, best-effort kills tmux, then removes persistence', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.1.10' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async (id) => calls.push(['store', id]) },
    sessions: { closeKey: (key) => calls.push(['session', key]) },
    boxActions: {
      killSession: async () => { calls.push(['kill']); throw new Error('already down'); },
      exitMaster: async () => calls.push(['master']),
    },
  });
  await expect(removeBox('B1')).resolves.toEqual({ ok: true });
  expect(calls).toEqual([
    ['session', 'B1'], ['session', 'provision:B1'], ['kill'], ['master'], ['store', 'B1'],
  ]);
});

test('removeBox is idempotent for an absent box', async () => {
  const removeBox = createBoxRemoval({ store: { getBox: async () => undefined, removeBox: async () => {} } });
  await expect(removeBox('missing')).resolves.toEqual({ ok: true });
});
```

- [ ] **Step 2: Run removal tests and verify RED**

Run: `npx vitest run test/boxRemoval.test.js --cache=false`

Expected: FAIL because `boxRemoval.js` does not exist.

- [ ] **Step 3: Implement shared removal and use it in the ordinary box route**

Create `src/server/boxRemoval.js`:

```js
export function createBoxRemoval({ store, sessions, boxActions }) {
  return async function removeBox(id) {
    const box = await store.getBox(id);
    if (!box) return { ok: true };
    sessions?.closeKey?.(box.id);
    sessions?.closeKey?.(`provision:${box.id}`);
    if (boxActions?.killSession) {
      try { await boxActions.killSession(box); } catch { /* target may already be stopped/destroyed */ }
    }
    if (boxActions?.exitMaster) {
      try { await boxActions.exitMaster(box); } catch { /* stale or absent master */ }
    }
    await store.removeBox(box.id);
    return { ok: true };
  };
}
```

Add `removeBox = null` to `buildServer` dependencies and replace the current DELETE body in `src/server/server.js`:

```js
  app.delete('/api/boxes/:id', { preHandler: requireAuth }, async (req) => {
    if (removeBox) return removeBox(req.params.id);
    await store.removeBox(req.params.id);
    return { ok: true };
  });
```

Wire the helper in `src/server/index.js` in the same commit so ordinary deletion never temporarily loses session/tmux cleanup:

```js
import { createBoxRemoval } from './boxRemoval.js';

const removeBox = createBoxRemoval({ store, sessions, boxActions });
```

Pass `removeBox` to `buildServer`. Update the existing server box-removal tests to inject `removeBox` and assert it receives the id. The real cleanup behavior is covered by `test/boxRemoval.test.js`.

- [ ] **Step 4: Write failing deprovision tests**

Append to `test/proxmoxLifecycle.test.js`:

```js
test('deprovision running container gracefully shuts down, destroys, verifies missing, then removes box', async () => {
  let state = 'running';
  const calls = [];
  const { manager } = fixture('running', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); state = 'stopped'; return 'UPID:shutdown'; },
      destroyLxc: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    removeLinkedBox: async (id) => calls.push(`remove:${id}`),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(calls).toEqual(['shutdown', 'destroy', 'remove:B1']);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done', phase: 'done' });
});

test('deprovision already-stopped skips shutdown', async () => {
  let state = 'stopped';
  const calls = [];
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      destroyLxc: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    removeLinkedBox: async (id) => calls.push(`remove:${id}`),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(calls).not.toContain('shutdown');
  expect(calls).toEqual(['destroy', 'remove:B1']);
});

test('deprovision shutdown failure never escalates to stop or removes the box', async () => {
  const calls = [];
  const { manager } = fixture('running', {
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); throw new Error('guest did not stop'); },
      stopLxc: async () => calls.push('stop'), destroyLxc: async () => calls.push('destroy'),
    }),
    removeLinkedBox: async () => calls.push('remove'),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual(['shutdown']);
});

test('missing-container deprovision performs typed-confirmation local cleanup only', async () => {
  const removed = [];
  const { manager } = fixture('missing', { removeLinkedBox: async (id) => removed.push(id) });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(removed).toEqual(['B1']);
  expect(manager.getJob(job.id).status).toBe('done');
});

test('confirmation mismatch creates no destructive job', async () => {
  const { manager } = fixture('stopped');
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'wrong' }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(manager.listJobs()).toEqual([]);
});

test('destroy failure preserves the linked box', async () => {
  const calls = [];
  const { manager } = fixture('stopped', {
    makeClient: () => ({ destroyLxc: async () => { calls.push('destroy'); throw new Error('storage busy'); } }),
    removeLinkedBox: async () => calls.push('remove'),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'storage busy' });
  expect(calls).toEqual(['destroy']);
});

test('graceful task timeout never calls force stop, destroy, or local removal', async () => {
  const calls = [];
  const { manager } = fixture('running', {
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); return 'UPID:shutdown'; },
      taskStatus: async () => ({ status: 'running' }),
      taskLog: async () => [],
      stopLxc: async () => calls.push('stop'),
      destroyLxc: async () => calls.push('destroy'),
    }),
    removeLinkedBox: async () => calls.push('remove'),
    taskTimeoutMs: -1,
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual(['shutdown']);
});

test('failed local cleanup can be retried through the missing-container path', async () => {
  let attempts = 0;
  let sequence = 0;
  const { manager } = fixture('missing', {
    makeId: () => `J${++sequence}`,
    removeLinkedBox: async () => { attempts += 1; if (attempts === 1) throw new Error('disk write failed'); },
  });
  const first = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(first.id);
  expect(manager.getJob(first.id).status).toBe('error');
  const retry = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(retry.id);
  expect(manager.getJob(retry.id).status).toBe('done');
  expect(attempts).toBe(2);
});
```

Extend the Task 6 manager fixture by passing `removeLinkedBox: async () => {}` and `shutdownTimeoutMs: 600_000` as defaults immediately before `...overrides`; this keeps every test override authoritative.

- [ ] **Step 5: Run lifecycle tests and verify RED**

Run: `npx vitest run test/proxmoxLifecycle.test.js --cache=false`

Expected: deprovision calls are rejected as an invalid action because Task 6 intentionally supports only routine actions.

- [ ] **Step 6: Extend the manager with the complete deprovision state machine**

Add `deprovision` to `ACTIONS`, add `removeLinkedBox` to the injected dependencies, and add `shutdownTimeoutMs = taskTimeoutMs` beside `taskTimeoutMs`. Change `run(job)` to dispatch `deprovision` to this function and routine actions to `runRoutine(job)`:

```js
  async function runDeprovision(job) {
    const { box, client } = await resolveTarget(job);
    let current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'missing') {
      job.phase = 'unlink'; persist();
      await removeLinkedBox(job.boxId);
      return;
    }
    if (current.state === 'running') {
      job.phase = 'shutdown'; persist();
      const shutdown = await client.shutdownLxc(job.node, job.vmid);
      appendLog(job, `# shutdown ${shutdown}\n`); persist();
      await pollTask(client, job, shutdown);
      current = await waitForState(job, 'stopped', shutdownTimeoutMs);
    }
    if (current.state !== 'stopped') throw new Error(`deprovision requires stopped, got ${current.state}`);
    job.phase = 'destroy'; persist();
    const destroy = await client.destroyLxc(job.node, job.vmid);
    appendLog(job, `# destroy ${destroy}\n`); persist();
    await pollTask(client, job, destroy);
    job.phase = 'verify'; persist();
    await waitForState(job, 'missing', taskTimeoutMs);
    job.phase = 'unlink'; persist();
    await removeLinkedBox(job.boxId);
  }
```

Replace the Task 6 preflight gate with the following before job insertion:

```js
    if (current.state === 'unknown') throw serviceError(502, current.error || 'Proxmox state unavailable');
    if (action === 'deprovision') {
      if (input.confirmName !== box.label) throw serviceError(409, 'confirmation name does not match');
      if (!['running', 'stopped', 'missing'].includes(current.state)) throw serviceError(409, `deprovision cannot run from ${current.state}`);
    } else if (current.state !== REQUIRED[action]) {
      throw serviceError(409, `${action} requires ${REQUIRED[action]}`);
    }
```

Change `run(job)`'s execution line to:

```js
      if (job.action === 'deprovision') await runDeprovision(job);
      else await runRoutine(job);
```

- [ ] **Step 7: Verify removal/deprovision and commit**

Run:

```bash
npx vitest run test/boxRemoval.test.js test/proxmoxLifecycle.test.js test/server.test.js --cache=false
```

Expected: all pass; failure paths contain no Stop/destroy/remove calls.

Commit:

```bash
git add src/server/boxRemoval.js src/server/proxmoxLifecycle.js src/server/index.js src/server/server.js test/boxRemoval.test.js test/proxmoxLifecycle.test.js test/server.test.js
git commit -m "feat(proxmox): add graceful deprovision cleanup"
```

---

### Task 8: Wire inventory/lifecycle services and expose REST/fetch contracts

**Files:**
- Modify: `src/server/index.js`
- Modify: `src/server/server.js`
- Modify: `test/server.test.js`
- Modify: `src/web/api.ts`
- Modify: `src/web/proxmox.ts`
- Modify: `test/proxmoxWebClient.test.js`

**Interfaces:**
- Server consumes injected `proxmoxInventory`, `lifecycleManager`, and `removeBox`.
- Adds the seven approved REST routes exactly as specified.
- Produces web types `PveBoxLink`, `PveContainerState`, `PveLinkedContainer`, `PveNodeContainer`, `LifecycleAction`, `LifecycleJobSummary`, and `LifecycleJob`.
- Produces `api.setProxmoxLink`/`clearProxmoxLink` and `pve.linkedContainers`/`nodeContainers`/`createLifecycleJob`/`lifecycleJobs`/`lifecycleJob`.

- [ ] **Step 1: Extend server stubs and write failing route tests**

In `proxmoxStubs(calls)` in `test/server.test.js`, add:

```js
  const proxmoxInventory = {
    getLinkedContainers: async () => [{ boxId: 'B1', boxLabel: 'dev-01', hostId: 'H1', hostName: 'lab', node: 'pve', vmid: 131, state: 'stopped' }],
    listNodeContainers: async () => [{ hostId: 'H1', node: 'pve', vmid: 131, name: 'dev-01', state: 'stopped', linkedBoxId: null }],
  };
  const lifecycleManager = {
    createJob: async (body) => { calls.push(['createLifecycleJob', body]); return { id: 'L1', ...body, status: 'running' }; },
    listJobs: () => [{ id: 'L1', boxId: 'B1', action: 'start', status: 'running', phase: 'request' }],
    getJob: (id) => id === 'L1' ? { id: 'L1', action: 'start', status: 'done', log: '' } : undefined,
    hasActiveJob: () => false,
    hasActiveTarget: () => false,
  };
```

Return these stubs and add authenticated route tests:

```js
test('linked-container browse and lifecycle routes are auth-gated and redacted', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/containers' })).statusCode).toBe(401);
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const linked = await app.inject({ method: 'GET', url: '/api/proxmox/containers', headers });
  expect(linked.statusCode).toBe(200);
  expect(linked.payload).not.toContain('tokenSecret');
  expect(linked.json()[0]).toMatchObject({ boxId: 'B1', vmid: 131, state: 'stopped', activeJob: { id: 'L1', action: 'start' } });
  const browse = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/containers', headers });
  expect(browse.json()[0]).toMatchObject({ vmid: 131, linkedBoxId: null });
  const created = await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' } });
  expect(created.statusCode).toBe(201);
  expect(calls).toContainEqual(['createLifecycleJob', { boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }]);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs', headers })).json()).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs/L1', headers })).json().id).toBe('L1');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs/NOPE', headers })).statusCode).toBe(404);
});

test('manual association verifies the live target, prevents duplicates, and unlinks without PVE mutation', async () => {
  const stubs = proxmoxStubs();
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10', label: 'dev-01' });
  app = await makeApp({ ...stubs, store });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const linked = await app.inject({ method: 'PUT', url: `/api/boxes/${box.id}/proxmox`, headers, payload: { hostId: 'H1', node: 'pve', vmid: 131 } });
  expect(linked.statusCode).toBe(200);
  expect(linked.json().proxmox).toEqual({ hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' });
  const unlinked = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}/proxmox`, headers });
  expect(unlinked.statusCode).toBe(200);
  expect(unlinked.json().proxmox).toBeUndefined();
});
```

Add these security/error assertions to the same route suite:

```js
test.each([400, 404, 409, 502])('lifecycle service statusCode %s is preserved', async (statusCode) => {
  const stubs = proxmoxStubs();
  app = await makeApp({ ...stubs, lifecycleManager: {
    ...stubs.lifecycleManager,
    createJob: async () => { throw Object.assign(new Error(`failure-${statusCode}`), { statusCode }); },
  } });
  const cookie = await login();
  const response = await app.inject({
    method: 'POST', url: '/api/proxmox/lifecycle-jobs',
    headers: { cookie: `${cookie.name}=${cookie.value}` },
    payload: { boxId: 'B1', action: 'start' },
  });
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({ error: `failure-${statusCode}` });
});

test('generic box PATCH cannot write lifecycle authority and active jobs block removal', async () => {
  const stubs = proxmoxStubs();
  stubs.lifecycleManager.hasActiveJob = () => true;
  app = await makeApp(stubs);
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'PATCH', url: '/api/boxes/B1', headers, payload: { proxmox: { hostId: 'H1', node: 'pve', vmid: 131 } } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'DELETE', url: '/api/boxes/B1', headers })).statusCode).toBe(409);
});

test('lifecycle and association mutations reject an untrusted Origin', async () => {
  app = await makeApp(proxmoxStubs());
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://evil.example.com' };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: 'B1', action: 'start' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PUT', url: '/api/boxes/B1/proxmox', headers, payload: { hostId: 'H1', node: 'pve', vmid: 131 } })).statusCode).toBe(403);
});

test('target coordinates, browse failures, and malformed links map to safe errors', async () => {
  const calls = [];
  const stubs = proxmoxStubs(calls);
  stubs.proxmoxInventory.listNodeContainers = async () => { throw new Error('PVE unavailable'); };
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10' });
  app = await makeApp({ ...stubs, store });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const coordinates = await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: box.id, action: 'start', vmid: 999 } });
  expect(coordinates.statusCode).toBe(400);
  expect(calls.some(([name]) => name === 'createLifecycleJob')).toBe(false);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/NOPE/nodes/pve/containers', headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/containers', headers })).statusCode).toBe(502);
  expect((await app.inject({ method: 'PUT', url: `/api/boxes/${box.id}/proxmox`, headers, payload: { hostId: 'H1', node: '../pve', vmid: 99 } })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Run focused server tests and verify RED**

Run: `npx vitest run test/server.test.js -t "linked-container|manual association|lifecycle routes" --cache=false`

Expected: routes return 404 because they are not registered.

- [ ] **Step 3: Register route handlers with exact mapping**

Add `proxmoxInventory`, `lifecycleManager`, and `removeBox` to `buildServer` arguments. Add a small response helper:

```js
  const serviceFailure = (reply, error, fallback = 400) => reply
    .code(Number.isInteger(error?.statusCode) ? error.statusCode : fallback)
    .send({ error: error?.message || 'request failed' });
```

Register:

```js
  app.get('/api/proxmox/containers', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const records = await proxmoxInventory.getLinkedContainers(await store.listBoxes());
      const active = new Map(lifecycleManager.listJobs()
        .filter((job) => job.status === 'running')
        .map((job) => [job.boxId, job]));
      return records.map((record) => ({ ...record, activeJob: active.get(record.boxId) || null }));
    } catch (error) { return serviceFailure(reply, error, 502); }
  });

  app.get('/api/proxmox/hosts/:id/nodes/:node/containers', { preHandler: requireAuth }, async (req, reply) => {
    const host = await proxmoxStore.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'proxmox host not found' });
    try {
      assertProxmoxLinkInput(
        { hostId: host.id, node: req.params.node, vmid: 100 },
        { hostIds: [host.id] },
      );
    } catch (error) { return serviceFailure(reply, error, 400); }
    try { return await proxmoxInventory.listNodeContainers(req.params.id, req.params.node, await store.listBoxes()); }
    catch (error) { return serviceFailure(reply, error, 502); }
  });

  app.put('/api/boxes/:id/proxmox', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (box.proxmox && lifecycleManager.hasActiveTarget(box.proxmox)) return reply.code(409).send({ error: 'container has an active lifecycle job' });
    if (!req.body || typeof req.body.hostId !== 'string' || !req.body.hostId.trim()) {
      return reply.code(400).send({ error: 'proxmox host is required' });
    }
    const host = await proxmoxStore.getHost(req.body.hostId, { withSecret: true });
    if (!host) return reply.code(404).send({ error: 'proxmox host not found' });
    try { assertProxmoxLinkInput(req.body, { hostIds: [host.id] }); }
    catch (error) { return serviceFailure(reply, error, 400); }
    let containers;
    try { containers = await proxmoxInventory.listNodeContainers(host.id, req.body.node, await store.listBoxes()); }
    catch (error) { return serviceFailure(reply, error, 502); }
    const target = containers.find((item) => item.vmid === Number(req.body.vmid));
    if (!target) return reply.code(404).send({ error: 'proxmox container not found' });
    if (target.linkedBoxId && target.linkedBoxId !== box.id) return reply.code(409).send({ error: 'proxmox container is already linked' });
    try {
      return await store.setProxmoxLink(box.id, { hostId: host.id, node: req.body.node, vmid: Number(req.body.vmid), endpoint: host.endpoint });
    } catch (error) {
      return serviceFailure(reply, error, /already linked/i.test(error?.message || '') ? 409 : 400);
    }
  });

  app.delete('/api/boxes/:id/proxmox', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const box = await store.getBox(req.params.id);
      if (!box) return reply.code(404).send({ error: 'box not found' });
      if (box.proxmox && lifecycleManager.hasActiveTarget(box.proxmox)) return reply.code(409).send({ error: 'container has an active lifecycle job' });
      return await store.clearProxmoxLink(box.id);
    } catch (error) { return serviceFailure(reply, error); }
  });

  app.post('/api/proxmox/lifecycle-jobs', { preHandler: requireAuth }, async (req, reply) => {
    if (['hostId', 'node', 'vmid'].some((key) => key in (req.body || {}))) {
      return reply.code(400).send({ error: 'lifecycle targets are resolved from the box link' });
    }
    try { return reply.code(201).send(await lifecycleManager.createJob(req.body || {})); }
    catch (error) { return serviceFailure(reply, error); }
  });
  app.get('/api/proxmox/lifecycle-jobs', { preHandler: requireAuth }, async () => lifecycleManager.listJobs());
  app.get('/api/proxmox/lifecycle-jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = lifecycleManager.getJob(req.params.id);
    return job || reply.code(404).send({ error: 'lifecycle job not found' });
  });
```

Import `assertProxmoxLinkInput`. Replace the first two lines inside the generic PATCH route's `try` block with:

```js
      const patch = req.body || {};
      if ('source' in patch || 'proxmox' in patch) {
        return reply.code(400).send({ error: 'proxmox linkage must use the dedicated link route' });
      }
      const before = await store.getBox(req.params.id);
      const updated = await store.updateBox(req.params.id, patch);
```

Replace the ordinary box DELETE route added in Task 7 with:

```js
  app.delete('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (lifecycleManager?.hasActiveJob(req.params.id)) {
      return reply.code(409).send({ error: 'box has an active lifecycle job' });
    }
    if (removeBox) return removeBox(req.params.id);
    await store.removeBox(req.params.id);
    return { ok: true };
  });
```

- [ ] **Step 4: Wire production factories in `src/server/index.js`**

Add imports and instantiate in this dependency order:

```js
import { createProxmoxInventory, mergeProxmoxStatus } from './proxmoxInventory.js';
import { createProxmoxLifecycleStore } from './proxmoxLifecycleStore.js';
import { createProxmoxLifecycleManager } from './proxmoxLifecycle.js';

const proxmoxInventory = createProxmoxInventory({
  proxmoxStore, makeClient: makeProxmoxClient,
  freshnessMs: config.statusPollMs * 2,
});
const lifecycleStore = createProxmoxLifecycleStore({ dataDir: config.dataDir });
const lifecycleManager = createProxmoxLifecycleManager({
  boxStore: store, proxmoxStore, inventory: proxmoxInventory,
  makeClient: makeProxmoxClient, removeLinkedBox: removeBox,
  load: () => lifecycleStore.load(), save: (jobs) => lifecycleStore.save(jobs),
  pollMs: config.pvePollMs,
  taskTimeoutMs: config.pveProvisionTimeoutMs,
  shutdownTimeoutMs: config.pveProvisionTimeoutMs,
  maxJobs: config.pveMaxJobs,
});
```

Reuse the `removeBox` instance wired in Task 7; do not construct a second removal service.

Pass this status enricher to `createStatusPoller`:

```js
  statusEnricher: {
    collect: (boxes) => proxmoxInventory.refreshLinked(boxes),
    merge: (snapshot, boxes, records) => mergeProxmoxStatus(snapshot, boxes, records),
  },
```

Pass `proxmoxInventory`, `lifecycleManager`, and `removeBox` to `buildServer`.

- [ ] **Step 5: Write failing web-client request tests**

Append to `test/proxmoxWebClient.test.js`:

```js
test('lifecycle and container fetch methods use exact routes and bodies', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, statusText: 'OK', json: async () => [] };
  };
  await pve.linkedContainers();
  await pve.nodeContainers('H1', 'pve/a');
  await pve.createLifecycleJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await pve.lifecycleJobs();
  await pve.lifecycleJob('L1');
  expect(calls.map((call) => call.url)).toEqual([
    '/api/proxmox/containers',
    '/api/proxmox/hosts/H1/nodes/pve%2Fa/containers',
    '/api/proxmox/lifecycle-jobs',
    '/api/proxmox/lifecycle-jobs',
    expect.stringMatching(/^\/api\/proxmox\/lifecycle-jobs\/L1\?t=/),
  ]);
  expect(calls[2].opts.method).toBe('POST');
  expect(JSON.parse(calls[2].opts.body)).toEqual({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
});
```

Add `test/webApi.test.js` coverage for `api.setProxmoxLink('B1', link)` PUT and `api.clearProxmoxLink('B1')` DELETE.

- [ ] **Step 6: Implement web types and fetch methods**

In `src/web/api.ts`:

```ts
export interface PveBoxLink { hostId: string; node: string; vmid: number; endpoint: string; }
export interface Box {
  id: string; label: string; host: string; user?: string; port?: number;
  proxyJump?: string; sessionName: string; startupCommand?: string; tags: string[];
  source: string; proxmox?: PveBoxLink;
}
```

Add API methods:

```ts
  async setProxmoxLink(boxId: string, link: Omit<PveBoxLink, 'endpoint'>) {
    return j<Box>(await fetch(`/api/boxes/${boxId}/proxmox`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(link) }));
  },
  async clearProxmoxLink(boxId: string) {
    return j<Box>(await fetch(`/api/boxes/${boxId}/proxmox`, { method: 'DELETE' }));
  },
```

In `src/web/proxmox.ts`, add:

```ts
export type PveContainerState = 'running' | 'stopped' | 'missing' | 'unknown';
export type LifecycleAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'deprovision';
export type LifecycleStatus = 'running' | 'done' | 'error' | 'interrupted';
export interface PveLinkedContainer { boxId: string; boxLabel: string; hostId: string; hostName: string | null; node: string; vmid: number; containerName: string | null; state: PveContainerState; fetchedAt: number; error: string | null; activeJob: LifecycleJobSummary | null; }
export interface PveNodeContainer { hostId: string; node: string; vmid: number; name: string; state: PveContainerState; linkedBoxId: string | null; }
export interface LifecycleJobSummary { id: string; action: LifecycleAction; boxId: string; boxLabel: string; hostId: string; hostName: string; node: string; vmid: number; status: LifecycleStatus; phase: string; error: string | null; createdAt: string; finishedAt: string | null; }
export interface LifecycleJob extends LifecycleJobSummary { log: string; }
```

Add fetch methods:

```ts
  linkedContainers() { return jr<PveLinkedContainer[]>(fetch('/api/proxmox/containers')); },
  nodeContainers(hostId: string, node: string) { return jr<PveNodeContainer[]>(fetch(`/api/proxmox/hosts/${hostId}/nodes/${encodeURIComponent(node)}/containers`)); },
  createLifecycleJob(spec: { boxId: string; action: LifecycleAction; confirmName?: string }) { return jr<LifecycleJobSummary>(fetch('/api/proxmox/lifecycle-jobs', post(spec))); },
  lifecycleJobs() { return jr<LifecycleJobSummary[]>(fetch('/api/proxmox/lifecycle-jobs')); },
  lifecycleJob(id: string) { return jr<LifecycleJob>(fetch(`/api/proxmox/lifecycle-jobs/${id}?t=${Date.now()}`)); },
```

- [ ] **Step 7: Verify and commit contracts/wiring**

Run:

```bash
npx vitest run test/server.test.js test/proxmoxWebClient.test.js test/webApi.test.js test/statusPoller.test.js --cache=false
npm run typecheck
```

Expected: all pass.

Commit:

```bash
git add src/server/index.js src/server/server.js test/server.test.js src/web/api.ts src/web/proxmox.ts test/proxmoxWebClient.test.js test/webApi.test.js
git commit -m "feat(proxmox): expose lifecycle and association API"
```

---

### Task 9: Add manual association to Edit Box

**Files:**
- Create: `src/web/proxmoxAssociation.ts`
- Create: `test/proxmoxAssociation.test.js`
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`

**Interfaces:**
- Produces pure `associationMutation(current, draft)` returning `null | { kind: 'link', link } | { kind: 'unlink' }`.
- Produces `createProxmoxAssociationEditor(box): { element: HTMLElement; commit(): Promise<void> }`.
- The editor uses `pve.hosts()`, `pve.nodes()`, `pve.nodeContainers()`, `api.setProxmoxLink()`, and `api.clearProxmoxLink()`.

- [ ] **Step 1: Write failing pure editor-state tests**

Create `test/proxmoxAssociation.test.js`:

```js
import { test, expect } from 'vitest';
import { associationMutation } from '../src/web/proxmoxAssociation.ts';

const current = { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' };

test('unchanged association produces no API mutation', () => {
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131 })).toBeNull();
});

test('changed selection produces a verified link request without endpoint', () => {
  expect(associationMutation(current, { mode: 'linked', hostId: 'H2', node: 'pve2', vmid: 140 })).toEqual({
    kind: 'link', link: { hostId: 'H2', node: 'pve2', vmid: 140 },
  });
});

test('unlink mode produces unlink and incomplete selection throws', () => {
  expect(associationMutation(current, { mode: 'unlinked' })).toEqual({ kind: 'unlink' });
  expect(() => associationMutation(undefined, { mode: 'linked', hostId: 'H1', node: '', vmid: 0 })).toThrow(/select/);
});
```

- [ ] **Step 2: Run pure tests and verify RED**

Run: `npx vitest run test/proxmoxAssociation.test.js --cache=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure mutation logic and imperative editor**

Create `src/web/proxmoxAssociation.ts`. Start with the tested pure function:

```ts
import { api, type Box, type PveBoxLink } from './api';
import { pve, type PveNodeContainer } from './proxmox';
import { el, err, field } from './dom';

type Draft = { mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number };

export function associationMutation(current: PveBoxLink | undefined, draft: Draft) {
  if (draft.mode === 'unlinked') return current ? { kind: 'unlink' as const } : null;
  if (!draft.hostId || !draft.node || !Number.isInteger(draft.vmid) || draft.vmid < 100) throw new Error('select a Proxmox container');
  if (current && current.hostId === draft.hostId && current.node === draft.node && current.vmid === draft.vmid) return null;
  return { kind: 'link' as const, link: { hostId: draft.hostId, node: draft.node, vmid: draft.vmid } };
}
```

Implement `createProxmoxAssociationEditor(box)` as an imperative section with local `draft`:

```ts
export function createProxmoxAssociationEditor(box: Box) {
  let draft: Draft = box.proxmox
    ? { mode: 'linked', hostId: box.proxmox.hostId, node: box.proxmox.node, vmid: box.proxmox.vmid }
    : { mode: 'unlinked' };
  const section = el('section', { class: 'box-pve-association' });
  const message = el('div', { class: 'pve-err' });
  const host = el('select') as HTMLSelectElement;
  const node = el('select') as HTMLSelectElement;
  const container = el('select') as HTMLSelectElement;
  const showError = (error: unknown) => { message.textContent = error instanceof Error ? error.message : 'Could not load Proxmox containers'; };

  async function loadHosts(selected = '') {
    const hosts = await pve.hosts();
    host.replaceChildren(...hosts.map((item) => el('option', { value: item.id }, [item.name])));
    if (selected && !hosts.some((item) => item.id === selected)) {
      host.prepend(el('option', { value: selected }, [`Unavailable host (${selected})`]));
    }
    if (selected) host.value = selected;
    await loadNodes(draft.mode === 'linked' ? draft.node : '');
  }
  async function loadNodes(selected = '') {
    const nodes = await pve.nodes(host.value);
    node.replaceChildren(...nodes.map((item) => el('option', { value: item.node }, [item.node])));
    if (selected) node.value = selected;
    await loadContainers(draft.mode === 'linked' ? draft.vmid : 0);
  }
  async function loadContainers(selected = 0) {
    const containers = await pve.nodeContainers(host.value, node.value);
    container.replaceChildren(...containers.map((item: PveNodeContainer) => el('option', {
      value: item.vmid,
      disabled: !!item.linkedBoxId && item.linkedBoxId !== box.id,
    }, [`${item.vmid} | ${item.name} | ${item.state}${item.linkedBoxId && item.linkedBoxId !== box.id ? ' | linked' : ''}`])));
    if (selected) container.value = String(selected);
    syncDraft();
  }
  const syncDraft = () => { draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: Number(container.value) }; };
  host.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: '', vmid: 0 };
    node.replaceChildren(); container.replaceChildren();
    void loadNodes().catch(showError);
  });
  node.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: 0 };
    container.replaceChildren();
    void loadContainers().catch(showError);
  });
  container.addEventListener('change', syncDraft);

  async function hydrateSummary(details: HTMLElement) {
    const link = box.proxmox;
    if (!link) return;
    const hosts = await pve.hosts();
    const hostName = hosts.find((item) => item.id === link.hostId)?.name ?? link.hostId;
    const containers = await pve.nodeContainers(link.hostId, link.node);
    const target = containers.find((item) => item.vmid === link.vmid);
    details.textContent = `${hostName} | ${link.node} | VMID ${link.vmid} | ${target?.name ?? 'missing'} | ${target?.state ?? 'missing'}`;
  }

  function renderSummary() {
    if (!box.proxmox) {
      section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Not linked']), el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Link container']), message);
      return;
    }
    const details = el('div', {}, [`${box.proxmox.hostId} | ${box.proxmox.node} | VMID ${box.proxmox.vmid}`]);
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      details,
      el('div', { class: 'pve-inline' }, [
        el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Change association']),
        el('button', { type: 'button', class: 'pve-btn danger', onclick: () => {
          if (confirm('Unlink this box? The Proxmox container will not be stopped or destroyed.')) {
            draft = { mode: 'unlinked' };
            section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Will unlink when you save']));
          }
        } }, ['Unlink']),
      ]), message,
    );
    void hydrateSummary(details).catch(showError);
  }
  async function renderPicker() {
    draft = box.proxmox
      ? { mode: 'linked', hostId: box.proxmox.hostId, node: box.proxmox.node, vmid: box.proxmox.vmid }
      : { mode: 'linked', hostId: '', node: '', vmid: 0 };
    section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), field('Host', host), field('Node', node), field('Container', container), message);
    await loadHosts(box.proxmox?.hostId).catch(showError);
  }
  renderSummary();
  return {
    element: section,
    async commit() {
      const mutation = associationMutation(box.proxmox, draft);
      if (mutation?.kind === 'link') await api.setProxmoxLink(box.id, mutation.link);
      if (mutation?.kind === 'unlink') await api.clearProxmoxLink(box.id);
    },
  };
}
```

Keep loader failures inline and do not permit `commit()` with incomplete or disabled selection.

- [ ] **Step 4: Integrate the editor into Edit Box**

In `src/web/main.ts`, import `createProxmoxAssociationEditor`. Inside `openBoxDialog`, create it only for edit mode:

```ts
  const proxmoxAssociation = isEdit ? createProxmoxAssociationEditor(box!) : null;
```

In the existing `form.append(...)`, insert `...(proxmoxAssociation ? [proxmoxAssociation.element] : [])` immediately before `err`. Replace the edit branch's update/close sequence with:

```ts
        const updatedBox = await api.updateBox(box!.id, patch);
        try {
          await proxmoxAssociation?.commit();
        } catch (error) {
          await refresh();
          throw error;
        }
        close();
        await refresh();
```

Retain the existing setup-panel code after this block. The outer submit catch leaves the modal open and renders the API error if the association request fails.

Add CSS with no nested cards:

```css
.box-pve-association { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.box-pve-association .danger { color: #f85149; }
.box-pve-association select { padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: #131722; color: var(--text); }
```

- [ ] **Step 5: Verify and commit association UI**

Run:

```bash
npx vitest run test/proxmoxAssociation.test.js test/proxmoxWebClient.test.js test/webApi.test.js --cache=false
npm run typecheck
npm run build
```

Expected: all pass/build.

Commit:

```bash
git add src/web/proxmoxAssociation.ts src/web/main.ts src/web/style.css test/proxmoxAssociation.test.js
git commit -m "feat(ui): add manual Proxmox association"
```

---

### Task 10: Add the Containers tab and lifecycle job controls

**Files:**
- Create: `src/web/proxmoxContainers.ts`
- Create: `test/proxmoxContainers.test.js`
- Modify: `src/web/proxmoxUi.ts`
- Modify: `src/web/style.css`

**Interfaces:**
- Produces pure `actionsForState(state): LifecycleAction[]`.
- Produces `renderContainersTab(content, { focusBoxId, showLifecycleJob, openEditBox })`.
- Adds Containers as the default hub tab; Task 11 replaces the still-functional provision History tab with merged Activity.

- [ ] **Step 1: Write failing state/action tests**

Create `test/proxmoxContainers.test.js`:

```js
import { test, expect } from 'vitest';
import { actionsForState } from '../src/web/proxmoxContainers.ts';

test('container actions are state-gated', () => {
  expect(actionsForState('running')).toEqual(['shutdown', 'stop', 'reboot', 'deprovision']);
  expect(actionsForState('stopped')).toEqual(['start', 'deprovision']);
  expect(actionsForState('missing')).toEqual(['deprovision']);
  expect(actionsForState('unknown')).toEqual([]);
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run: `npx vitest run test/proxmoxContainers.test.js --cache=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement state actions and typed confirmation**

Create `src/web/proxmoxContainers.ts` with:

```ts
import { pve, type LifecycleAction, type PveContainerState, type PveLinkedContainer } from './proxmox';
import { el, err, input } from './dom';

export function actionsForState(state: PveContainerState): LifecycleAction[] {
  if (state === 'running') return ['shutdown', 'stop', 'reboot', 'deprovision'];
  if (state === 'stopped') return ['start', 'deprovision'];
  if (state === 'missing') return ['deprovision'];
  return [];
}

function openDeprovisionDialog(container: PveLinkedContainer, onConfirm: (name: string) => Promise<void>) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('form', { class: 'modal pve-deprovision-modal' });
  const typed = input('', { autocomplete: 'off' });
  const submit = el('button', { type: 'submit', class: 'pve-primary', disabled: true }, ['Deprovision']);
  const errorLine = el('div', { class: 'pve-err' });
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKeyDown); backdrop.remove(); };
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (event) => { pressedOnBackdrop = event.target === backdrop; });
  backdrop.addEventListener('click', (event) => { if (pressedOnBackdrop && event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeyDown);
  typed.addEventListener('input', () => { submit.disabled = typed.value !== container.boxLabel; });
  modal.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; errorLine.textContent = '';
    try { await onConfirm(typed.value); close(); }
    catch (error) { errorLine.textContent = error instanceof Error ? error.message : 'Deprovision failed'; submit.disabled = typed.value !== container.boxLabel; }
  });
  modal.append(
    el('h2', {}, ['Deprovision container']),
    el('div', {}, [`${container.boxLabel} | ${container.hostName ?? container.hostId} | ${container.node} | VMID ${container.vmid}`]),
    el('p', { class: 'pve-warning' }, [container.state === 'missing'
      ? 'Proxmox already reports this container missing. Tmuxifier will remove only the stale linked box.'
      : 'Tmuxifier will gracefully shut down the container, destroy it and its attached volumes, keep independent backups, then remove the linked box.']),
    el('label', { class: 'field' }, [el('span', {}, [`Type ${container.boxLabel} to confirm`]), typed]),
    errorLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), submit]),
  );
  backdrop.append(modal); document.body.append(backdrop); typed.focus();
}
```

Implement `renderContainersTab`:

```ts
export async function renderContainersTab(content: HTMLElement, deps: {
  focusBoxId?: string;
  showLifecycleJob: (id: string) => void;
  openEditBox: (boxId: string) => void;
}) {
  const refresh = el('button', { type: 'button', class: 'pve-btn', title: 'Refresh container state' }, ['Refresh']);
  const toolbar = el('div', { class: 'pve-container-toolbar' }, [refresh]);
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void renderContainersTab(content, deps).catch((error) => {
      content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not refresh containers'));
      refresh.disabled = false;
    });
  });
  let containers: PveLinkedContainer[];
  try { containers = await pve.linkedContainers(); }
  catch (error) {
    content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not load containers'));
    return;
  }
  const list = el('div', { class: 'pve-container-list' });
  for (const container of containers) {
    const actions = el('div', { class: 'pve-row-actions' });
    const row = el('div', { class: `pve-row pve-container-row${deps.focusBoxId === container.boxId ? ' focused' : ''}` }, [
      el('div', {}, [el('strong', {}, [container.boxLabel]), el('div', { class: 'pve-sub' }, [`${container.hostName ?? container.hostId} | ${container.node} | VMID ${container.vmid}`])]),
      el('span', { class: `pve-badge ${container.state}` }, [container.state]),
      actions,
    ]);
    if (container.activeJob) {
      actions.append(el('button', {
        type: 'button', class: 'pve-btn',
        onclick: () => deps.showLifecycleJob(container.activeJob!.id),
      }, [`View ${container.activeJob.action}`]));
    } else {
      for (const action of actionsForState(container.state)) {
        const label = action === 'deprovision' ? 'Deprovision' : action === 'stop' ? 'Stop now' : action[0].toUpperCase() + action.slice(1);
        const button = el('button', {
          type: 'button',
          class: action === 'deprovision' ? 'danger' : action === 'stop' ? 'warn' : '',
          ...(action === 'stop' ? { title: 'Force an immediate stop' } : {}),
        }, [label]);
        button.addEventListener('click', () => {
          const run = async (confirmName?: string) => {
            button.disabled = true;
            row.querySelector('.pve-err')?.remove();
            try {
              const job = await pve.createLifecycleJob({ boxId: container.boxId, action, ...(confirmName ? { confirmName } : {}) });
              deps.showLifecycleJob(job.id);
            } finally { button.disabled = false; }
          };
          if (action === 'deprovision') openDeprovisionDialog(container, run);
          else void run().catch((error) => { row.append(err(error instanceof Error ? error.message : 'Lifecycle action failed')); });
        });
        actions.append(button);
      }
    }
    if (container.state === 'unknown' || container.state === 'missing') {
      actions.append(el('button', { type: 'button', onclick: () => deps.openEditBox(container.boxId) }, ['Edit link']));
    }
    list.append(row);
    if (deps.focusBoxId === container.boxId) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
  }
  content.replaceChildren(toolbar, containers.length ? list : el('div', { class: 'pve-sub' }, ['No linked Proxmox containers.']));
}
```

The row exists before action listeners are registered, active jobs replace mutation buttons with a detail command, and create-job errors remain visible inline.

- [ ] **Step 4: Integrate Containers into the hub**

Change hub contracts:

```ts
type HubOpts = {
  openBox: (box: Box) => void;
  openEditBox: (boxId: string) => void;
  onBoxLinked: () => void;
};
type HubInitial = { tab?: Tab; focusBoxId?: string };
const TABS = ['Containers', 'Presets', 'Provision', 'History'] as const;

export function openProxmoxHub(opts: HubOpts, initial: HubInitial = {}) {
```

Set initial/default tab to Containers and route its renderer to `renderContainersTab`. Leave the existing History renderer and label intact in this commit; Task 11 replaces both atomically when merged Activity is implemented.

Pass `showLifecycleJob` to Containers. Add a lifecycle detail poller beside provision `showJob`:

```ts
  function showLifecycleJob(id: string) {
    stopPoll();
    const generation = pollGen;
    const phase = el('div', { class: 'pve-phase' });
    const log = el('pre', { class: 'pve-log' });
    const footer = el('div', { class: 'modal-actions' });
    setContent(el('h3', {}, ['Lifecycle job']), phase, log, footer);
    async function tick() {
      const job = await pve.lifecycleJob(id).catch(() => null);
      if (generation !== pollGen) return;
      if (!job) { pollTimer = window.setTimeout(tick, 1500); return; }
      phase.textContent = `${job.action.toUpperCase()} | ${job.status.toUpperCase()} | ${job.phase}${job.error ? ` | ${job.error}` : ''}`;
      log.textContent = job.log || '';
      if (job.status === 'running') { pollTimer = window.setTimeout(tick, 1500); return; }
      opts.onBoxLinked();
      await pve.linkedContainers().catch(() => []);
      if (generation !== pollGen) return;
      footer.replaceChildren(el('button', { type: 'button', onclick: () => selectTab('Containers') }, ['Back to Containers']));
    }
    void tick();
  }
```

- [ ] **Step 5: Add stable responsive lifecycle styles**

Append:

```css
.pve-container-toolbar { min-height: 32px; display: flex; justify-content: flex-end; align-items: center; }
.pve-container-list { display: flex; flex-direction: column; gap: 6px; }
.pve-container-row { display: grid; grid-template-columns: minmax(180px, 1fr) auto minmax(240px, auto); align-items: center; }
.pve-container-row.focused { border-color: #2f6feb; }
.pve-container-row .pve-row-actions { justify-content: flex-end; flex-wrap: wrap; }
.pve-container-row button.warn { color: #d29922; }
.pve-badge.stopped, .pve-badge.unknown { color: var(--muted); }
.pve-badge.missing { color: #f85149; }
.pve-deprovision-modal { width: 460px; }
.pve-warning { margin: 0; color: #ffb4ad; font-size: 12px; line-height: 1.45; }
@media (max-width: 720px) {
  .pve-container-row { grid-template-columns: minmax(0, 1fr) auto; }
  .pve-container-row .pve-row-actions { grid-column: 1 / -1; justify-content: flex-start; }
}
```

- [ ] **Step 6: Verify and commit Containers**

Run:

```bash
npx vitest run test/proxmoxContainers.test.js test/proxmoxWebClient.test.js --cache=false
npm run typecheck
npm run build
```

Expected: all pass/build.

Commit:

```bash
git add src/web/proxmoxContainers.ts src/web/proxmoxUi.ts src/web/style.css test/proxmoxContainers.test.js
git commit -m "feat(ui): add Proxmox container lifecycle controls"
```

---

### Task 11: Add Activity, stopped-box terminal suppression, docs, and end-to-end verification

**Files:**
- Create: `src/web/proxmoxActivity.ts`
- Create: `test/proxmoxActivity.test.js`
- Modify: `src/web/proxmoxUi.ts`
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Produces pure `mergeActivity(provisions, lifecycle): ActivityItem[]`.
- Produces `renderActivityTab(content, { showProvisionJob, showLifecycleJob })`.
- Stopped box selection opens Proxmox Containers focused on that box and never calls `openTerminal`.

- [ ] **Step 1: Write failing Activity merge tests**

Create `test/proxmoxActivity.test.js`:

```js
import { test, expect } from 'vitest';
import { mergeActivity } from '../src/web/proxmoxActivity.ts';

test('mergeActivity tags, sorts, and labels both job sources', () => {
  const result = mergeActivity(
    [{ id: 'P1', hostname: 'dev-01', presetName: 'base', vmid: 131, status: 'done', createdAt: '2026-07-11T00:00:00Z' }],
    [{ id: 'L1', action: 'reboot', boxLabel: 'db-01', vmid: 140, status: 'error', createdAt: '2026-07-11T01:00:00Z' }],
  );
  expect(result.map((item) => [item.kind, item.id, item.title])).toEqual([
    ['lifecycle', 'L1', 'Reboot | db-01'],
    ['provision', 'P1', 'Provision | dev-01'],
  ]);
});
```

- [ ] **Step 2: Run Activity test and verify RED**

Run: `npx vitest run test/proxmoxActivity.test.js --cache=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement Activity renderer**

Create `src/web/proxmoxActivity.ts`:

```ts
import { pve, type LifecycleJobSummary, type ProvisionSummary } from './proxmox';
import { el } from './dom';

export type ActivityItem = {
  kind: 'provision' | 'lifecycle'; id: string; title: string; subtitle: string;
  status: string; createdAt: string;
};

export function mergeActivity(provisions: ProvisionSummary[], lifecycle: LifecycleJobSummary[]): ActivityItem[] {
  return [
    ...provisions.map((job) => ({ kind: 'provision' as const, id: job.id, title: `Provision | ${job.hostname}`, subtitle: `${job.presetName} | VMID ${job.vmid ?? '-'}`, status: job.status, createdAt: job.createdAt })),
    ...lifecycle.map((job) => ({ kind: 'lifecycle' as const, id: job.id, title: `${job.action[0].toUpperCase()}${job.action.slice(1)} | ${job.boxLabel}`, subtitle: `${job.hostName} | ${job.node} | VMID ${job.vmid}`, status: job.status, createdAt: job.createdAt })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function renderActivityTab(content: HTMLElement, deps: {
  showProvisionJob: (id: string) => void;
  showLifecycleJob: (id: string) => void;
}) {
  const [provisions, lifecycle] = await Promise.all([
    pve.provisions().catch(() => []), pve.lifecycleJobs().catch(() => []),
  ]);
  const activity = mergeActivity(provisions, lifecycle);
  content.replaceChildren(activity.length ? el('div', { class: 'pve-list' }, activity.map((item) =>
    el('button', { type: 'button', class: 'pve-row pve-row-btn', onclick: () => item.kind === 'provision' ? deps.showProvisionJob(item.id) : deps.showLifecycleJob(item.id) }, [
      el('div', {}, [el('strong', {}, [item.title]), el('div', { class: 'pve-sub' }, [item.subtitle])]),
      el('span', { class: `pve-badge ${item.status}` }, [item.status]),
    ]))) : el('div', { class: 'pve-sub' }, ['No Proxmox activity yet.']));
}
```

In `src/web/proxmoxUi.ts`, replace History atomically with Activity and route detail clicks to the existing provision detail function plus the lifecycle detail function from Task 10:

```ts
const TABS = ['Containers', 'Presets', 'Provision', 'Activity'] as const;

const renderers: Record<Tab, () => Promise<void> | void> = {
  Containers: () => renderContainersTab(content, { focusBoxId: initial.focusBoxId, showLifecycleJob, openEditBox: opts.openEditBox }),
  Presets: () => renderPresetsTab(content, { openSettingsModal }),
  Provision: renderProvision,
  Activity: () => renderActivityTab(content, { showProvisionJob: showJob, showLifecycleJob }),
};
```

Delete the old provision-only `renderHistory` body.

- [ ] **Step 4: Prevent stopped boxes from opening terminals**

Add a helper in `src/web/main.ts`:

```ts
function highlightBox(boxId: string | null) {
  app.querySelectorAll('.box').forEach((element) => {
    const row = element as HTMLElement;
    row.classList.toggle('active', boxId !== null && row.dataset.id === boxId);
  });
  app.querySelectorAll('.box-group').forEach((element) => {
    const group = element as HTMLElement;
    group.classList.toggle('active-child', boxId !== null && !!group.querySelector(`.box[data-id="${CSS.escape(boxId)}"]`));
  });
}

function showStoppedBox(box: Box) {
  activeBoxId = box.id;
  highlightBox(box.id);
  app.querySelector('.local-shell')?.classList.remove('active');
  for (const terminal of tabs.values()) terminal.el.style.display = 'none';
  const stage = app.querySelector('#stage') as HTMLElement;
  stage.querySelector('.empty')?.remove();
  stage.querySelector('.stopped-box-state')?.remove();
  const state = latestStatus[box.id];
  const panel = document.createElement('div');
  panel.className = 'stopped-box-state';
  const title = document.createElement('strong');
  title.textContent = `${box.label} is stopped`;
  const detail = document.createElement('span');
  detail.textContent = `${state?.proxmoxNode ?? 'Proxmox'} | VMID ${state?.proxmoxVmid ?? box.proxmox?.vmid ?? '-'}`;
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'pve-btn';
  manage.textContent = 'Open Proxmox';
  manage.addEventListener('click', () => openProxmoxHub({
    openBox,
    openEditBox: (id) => { const target = allBoxes.find((item) => item.id === id); if (target) openBoxDialog(target); },
    onBoxLinked: () => { void refresh(); },
  }, { tab: 'Containers', focusBoxId: box.id }));
  panel.append(title, detail, manage);
  stage.append(panel);
}
```

Use `highlightBox` in place of `openBox`'s current duplicated row/group loop. At the top of `openBox`, before setting `activeBoxId`:

```ts
  if (latestStatus[b.id]?.proxmoxState === 'stopped') {
    closeTab(b.id);
    showStoppedBox(b);
    return;
  }
```

For a normal box or local-shell open, remove only `stage.querySelector('.stopped-box-state')`; never use `replaceChildren`, because the stage also owns hidden live terminal elements.

After `pollStatus` applies the new row states, reconcile externally stopped active terminals and a stopped panel whose container has restarted:

```ts
      const selected = activeBoxId ? allBoxes.find((box) => box.id === activeBoxId) : undefined;
      for (const [id] of tabs) {
        if (id !== '__local__' && status[id]?.proxmoxState === 'stopped') closeTab(id);
      }
      if (selected && status[selected.id]?.proxmoxState === 'stopped') {
        showStoppedBox(selected);
      } else {
        const stage = app.querySelector('#stage') as HTMLElement;
        const stoppedPanel = stage.querySelector('.stopped-box-state');
        if (stoppedPanel) {
          stoppedPanel.remove();
          activeBoxId = null;
          highlightBox(null);
          if (!stage.querySelector('.empty')) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Select a box to open a terminal.';
            stage.append(empty);
          }
        }
      }
```

Update the ordinary sidebar Proxmox button call to pass `openEditBox`. Calling `closeTab` before `showStoppedBox` ensures the helper's final active id/highlight wins.

Add stable styles:

```css
.stopped-box-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); }
.stopped-box-state strong { color: var(--text); font-size: 15px; }
```

- [ ] **Step 5: Update architecture, runtime-state, privilege, and safety docs**

Update both `AGENTS.md` and `CLAUDE.md` architecture lists with:

```markdown
- `proxmoxInventory.js` - host/node-batched linked-LXC inventory and status authority.
- `proxmoxLifecycle.js` / `proxmoxLifecycleStore.js` - persisted LXC power/deprovision jobs in `data/proxmox-lifecycle-jobs.json`.
- `boxRemoval.js` - shared session/tmux/store cleanup for ordinary removal and verified deprovision.
```

Add `proxmoxAssociation.ts`, `proxmoxContainers.ts`, and `proxmoxActivity.ts` to the web feature-module paragraph.

Update `README.md` and `docs/DEPLOY.md` to state:

- Lifecycle control applies only to verified linked LXC containers.
- Manual linking is explicit; import never restores lifecycle authority.
- Grey Stopped requires a live PVE confirmation; PVE failure does not hide SSH outages.
- Deprovision gracefully shuts down, destroys attached container volumes, keeps backup archives, then removes the local box.
- Required token privileges explicitly include `VM.Audit`/`Sys.Audit` for inventory, `VM.PowerMgmt` for Start/Shutdown/Stop/Reboot, and `VM.Allocate` for LXC deletion, alongside the existing provisioning datastore privileges. Explain that the documented `PVEVMAdmin` plus `PVEAuditor` lab role combination covers these operations, while a custom production role should grant only the needed paths and privileges.

Add `proxmox-lifecycle-jobs.json` to the documented `data/` inventory in both agent docs. Keep `AGENTS.md` and `CLAUDE.md` synchronized except for their existing document-specific wording.

- [ ] **Step 6: Run focused and full automated verification**

Run:

```bash
npx vitest run test/proxmoxActivity.test.js test/proxmoxContainers.test.js test/proxmoxAssociation.test.js test/statusDot.test.js test/healthHistory.test.js --cache=false
npm test
npm run build
```

Expected: all focused tests pass, the full Vitest suite has zero failures, TypeScript is clean, and Vite builds successfully. The existing bundle-size warning is non-blocking.

- [ ] **Step 7: Run the browser walkthrough with disposable API fixtures**

Start a local server on unused ports and use Playwright route interception so real `data/` and PVE credentials are untouched. Verify at 1280x900 and 390x844:

1. Edit an unlinked box: Host -> Node -> Container options load, already-linked targets are disabled, save links it, and Unlink warns that PVE is unchanged.
2. A linked stopped box is grey with Stopped metadata; clicking it does not create `/term` and shows Open Proxmox.
3. Containers focuses that box; stopped exposes Start/Deprovision, running exposes Shutdown/Stop/Reboot/Deprovision, unknown exposes none, missing exposes Deprovision cleanup only.
4. Stop is visually forceful. Deprovision remains disabled until the exact label is typed and its warning states attached volumes deleted, backups retained, and local box removed.
5. Lifecycle job polling reaches terminal status, refreshes Containers/dashboard, and Activity merges lifecycle/provision entries newest-first.
6. PVE failure plus SSH failure stays red; missing plus reachable SSH stays reachable with PVE-link-missing metadata.
7. No text clipping, incoherent overlap, horizontal page overflow, or modal scrollbar covering controls.

Capture screenshots under `/tmp`, inspect them with `view_image`, then remove the temporary Playwright script and stop the disposable server.

- [ ] **Step 8: Inspect final diff and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat
rg -n "tokenSecret|rootPassword" src/web
```

Expected: no whitespace errors; no secret field added to web types/responses; only planned files changed; real values absent.

Commit:

```bash
git add src/web/proxmoxActivity.ts src/web/proxmoxUi.ts src/web/main.ts src/web/style.css test/proxmoxActivity.test.js AGENTS.md CLAUDE.md README.md docs/DEPLOY.md
git commit -m "feat(ui): integrate Proxmox lifecycle activity"
```

---

## Final Acceptance Gate

Before integration or release, rerun from a clean working tree:

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected:

- Full typecheck/Vitest suite: zero failures.
- Vite build: success (existing chunk-size warning allowed).
- Browser walkthrough: all seven scenarios pass on desktop and mobile.
- `git status --short`: empty.
- No production service restart, version bump, tag, push, or GitHub release unless the owner explicitly requests deployment after reviewing the completed branch.
