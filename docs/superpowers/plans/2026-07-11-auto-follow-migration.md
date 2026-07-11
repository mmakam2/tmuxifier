# Auto-Follow Container Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The linked-container inventory becomes cluster-aware via PVE `GET /cluster/resources?type=vm` — one call per host, container state survives node migrations, `missing` means cluster-wide-absent, and the stored `box.proxmox.node` auto-updates (guarded against active lifecycle jobs).

**Architecture:** `proxmoxApi` gains `clusterResources()`; `proxmoxInventory` regroups by host, matches vmids against the cluster list, and performs a guarded best-effort drift write through the store's existing trusted `setProxmoxLink`; `index.js` injects `boxStore` and late-binds the `hasActiveJob` guard after the lifecycle manager exists. Server-only; zero UI changes.

**Tech Stack:** Node 20+ ESM, vitest (real code + injected fakes), existing PVE client/`tlsPin` transport.

**Spec:** `docs/superpowers/specs/2026-07-11-auto-follow-migration-design.md`

## Global Constraints

- Server-side only; no UI changes (`src/web/` untouched except nothing — verify the diff).
- Trust boundary: only `node` may auto-change, only to a value PVE reported for the already-linked hostId+vmid; `hostId`/`vmid`/`endpoint` never auto-change; no client-facing route relaxes validation.
- Drift write is skipped while `hasActiveJob(boxId)` is true, and is best-effort (a store failure logs and leaves the old node; records carry the reported node regardless).
- Per-host failure isolation preserved: one host's `clusterResources` failure → its boxes `unknown` with the error, other hosts unaffected.
- Audit log line per follow, exact format: `[tmuxifier] box <label>: container <vmid> migrated <oldNode> -> <newNode>` (injectable `log` for test silence).
- The association picker (`listNodeContainers`) and its per-node `listLxc` call are UNCHANGED.
- **NUL-byte protocol (ledger-mandated):** `src/server/proxmoxInventory.js:1` contains the JS escape sequence backslash-u-0-0-0-0 inside `targetKey`. A backslash-u-0000 escape typed in tool-call JSON decodes to a raw NUL byte and has corrupted this exact file before. After ANY write to this file run: `node -e "const b=require('fs').readFileSync('src/server/proxmoxInventory.js');process.exit(b.includes(0)?1:0)" && echo no-NUL-bytes` — must print `no-NUL-bytes` — and `git diff --stat` must show a text diff, not `Bin`.
- Gate per task: named vitest files green; Task 3 runs `npm test` (full suite; baseline 626, count must not decrease).

---

### Task 1: `clusterResources()` on the PVE client

**Files:**
- Modify: `src/server/proxmoxApi.js` (the method map in `createProxmoxClient`, next to `nextId`/`listLxc`)
- Test: `test/proxmoxApi.test.js` (append one test)

**Interfaces:**
- Produces: `client.clusterResources(): Promise<Array<{ vmid, node, type, status, name, … }>>` — issues `GET /cluster/resources?type=vm` through the existing `call()` (auth header, TLS mode, error mapping all inherited).

- [ ] **Step 1: Write the failing test**

Append to `test/proxmoxApi.test.js` (match the file's existing fake-`request` pattern — it builds a client with an injected `request` recording `{ url, method }` and returning `{ status: 200, json: { data: … } }`):

```js
test('clusterResources lists cluster-wide guests with their current node', async () => {
  const calls = [];
  const client = createProxmoxClient({
    host: { endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'insecure' },
    request: async (opts) => { calls.push(opts); return { status: 200, json: { data: [
      { vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'mcmcreativedev01' },
      { vmid: 200, node: 'proxmox02', type: 'qemu', status: 'running', name: 'a-vm' },
    ] } }; },
  });
  const list = await client.clusterResources();
  expect(calls[0].url).toBe('https://pve.example.com:8006/api2/json/cluster/resources?type=vm');
  expect(calls[0].method).toBe('GET');
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ vmid: 165, node: 'proxmox03', type: 'lxc' });
});
```

(Adapt the client-construction call to exactly match how the neighbouring tests in that file build a client with an injected `request` — reuse their helper if one exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxmoxApi.test.js`
Expected: FAIL — `client.clusterResources is not a function`.

- [ ] **Step 3: Implement**

In `src/server/proxmoxApi.js`, in the returned method map (after the `nextId` line):

```js
    clusterResources: () => call('GET', '/cluster/resources?type=vm'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/proxmoxApi.test.js`
Expected: PASS (previous count + 1).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxApi.js test/proxmoxApi.test.js
git commit -m "feat(proxmox): cluster-wide guest listing via /cluster/resources"
```

---

### Task 2: Cluster-aware inventory with guarded drift write

**Files:**
- Modify: `src/server/proxmoxInventory.js` (replace `fetchGroup`/`doRefresh` internals; `createProxmoxInventory` signature grows)
- Modify: `src/server/index.js` (inventory construction ~line 115; one line after the lifecycle manager ~line 128)
- Test: `test/proxmoxInventory.test.js` (rework the fakes; existing tests updated; new drift tests)
- Test: `test/store.test.js` (one appended relink test)

**Interfaces:**
- Consumes: `client.clusterResources()` (Task 1); `boxStore.setProxmoxLink(id, link)` (existing trusted mutation — validates, dedupes by linkKey excluding own id, normalizes with `trustedProxmox: true`).
- Produces: `createProxmoxInventory({ proxmoxStore, makeClient, boxStore = null, now, freshnessMs, log = (...a) => console.log(...a) })` — same returned methods plus `setActiveJobGuard(fn: (boxId: string) => boolean): void`. Records unchanged in shape; `node` now carries the container's CURRENT node when found (stored node when missing/unknown).

- [ ] **Step 1: Rework the inventory tests (failing first)**

Rewrite `test/proxmoxInventory.test.js`'s `setup` so the fake client serves BOTH APIs (`clusterResources` for the poll, `listLxc` for the untouched picker tests), then update/extend the tests. The fake and the new/changed tests:

```js
function setup({ cluster = [], listByNode = {}, boxStore = null, guard } = {}) {
  const calls = { cluster: 0, nodes: [] };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({
      clusterResources: async () => { calls.cluster += 1; return cluster; },
      listLxc: async (node) => { calls.nodes.push(node); return listByNode[node] || []; },
    }),
    boxStore,
    now: () => 1000,
    freshnessMs: 60_000,
    log: () => {},
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, calls };
}
```

Changed/new tests (keep the untouched picker/coalescing/`stateFor` tests as they are, adapting only their fakes):

```js
test('refreshLinked makes one cluster call per host and maps vmids across nodes', async () => {
  const { inventory, calls } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' },
    { vmid: 132, node: 'pve', type: 'lxc', status: 'stopped', name: 'dev-02' },
    { vmid: 140, node: 'pve2', type: 'lxc', status: 'running', name: 'db-01' },
  ] });
  const records = await inventory.refreshLinked([
    linked('b1', 'pve', 131), linked('b2', 'pve', 132), linked('b3', 'pve2', 140),
  ]);
  expect(calls.cluster).toBe(1); // one call for the whole host, regardless of node spread
  expect(records.map((r) => [r.boxId, r.state, r.node])).toEqual([
    ['b1', 'running', 'pve'], ['b2', 'stopped', 'pve'], ['b3', 'running', 'pve2'],
  ]);
});

test('a migrated container stays healthy, reports its new node, and the link auto-follows', async () => {
  const writes = [];
  const boxStore = { setProxmoxLink: async (id, link) => writes.push([id, link]) };
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore,
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('proxmox03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'proxmox03', vmid: 165, endpoint: HOST.endpoint }]]);
});

test('the drift write is skipped while a lifecycle job is active on the box', async () => {
  const writes = [];
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]) },
    guard: (boxId) => boxId === 'b1',
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.node).toBe('proxmox03'); // display still follows
  expect(writes).toEqual([]);            // store write deferred to a later poll
});

test('a failing drift write is best-effort: logged, record still healthy', async () => {
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async () => { throw new Error('disk full'); } },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(logged.some((line) => line.includes('disk full'))).toBe(true);
});

test('missing means absent from the whole cluster; qemu entries never match', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve2', type: 'qemu', status: 'running', name: 'a-vm' }, // same vmid, wrong type
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.state).toBe('missing');
  expect(record.node).toBe('pve'); // stored node kept for display when missing
});

test('one host failing leaves another host healthy (per-host isolation)', async () => {
  const HOSTS = { H1: HOST, H2: { ...HOST, id: 'H2', name: 'lab2' } };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => HOSTS[id] },
    makeClient: (host) => ({ clusterResources: async () => {
      if (host.id === 'H2') throw new Error('PVE down');
      return [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev' }];
    } }),
    now: () => 1000, log: () => {},
  });
  const b2 = { ...linked('b2', 'pve', 140), proxmox: { hostId: 'H2', node: 'pve', vmid: 140, endpoint: 'x:8006' } };
  const records = await inventory.refreshLinked([linked('b1', 'pve', 131), b2]);
  const byId = Object.fromEntries(records.map((r) => [r.boxId, r]));
  expect(byId.b1.state).toBe('running');
  expect(byId.b2.state).toBe('unknown');
  expect(byId.b2.error).toBe('PVE down');
});
```

Note: `makeClient(host)` in the isolation test relies on the real inventory passing the host object through — it already does (`makeClient(host)`).

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: new tests FAIL (`clusterResources` never called / `setProxmoxLink` never called); untouched picker tests still pass.

- [ ] **Step 3: Implement the inventory changes**

In `src/server/proxmoxInventory.js` — use targeted Edits (do NOT rewrite line 1; `groupKey` on line 2 is deleted). Replace `fetchGroup` and `doRefresh`, extend the factory signature, and add the guard setter. The changed regions in full:

```js
export function createProxmoxInventory({
  proxmoxStore,
  makeClient,
  boxStore = null,
  now = () => Date.now(),
  freshnessMs = 60_000,
  log = (...args) => console.log(...args),
}) {
  const cache = new Map();
  let inFlight = null;
  // Late-bound by index.js once the lifecycle manager exists: a drift write
  // must not rewrite a link that a running job snapshotted (resolveTarget
  // would abort the job). Defaults open so tests without jobs need no wiring.
  let activeJobGuard = () => false;

  const record = (box, fields) => ({
    boxId: box.id, boxLabel: box.label, hostId: box.proxmox.hostId, hostName: null,
    node: box.proxmox.node, vmid: Number(box.proxmox.vmid), containerName: null,
    state: 'unknown', fetchedAt: now(), error: null, ...fields,
  });

  async function fetchHost(hostId, hostBoxes) {
    let host;
    try {
      host = await proxmoxStore.getHost(hostId, { withSecret: true });
    } catch (error) {
      return hostBoxes.map((box) => record(box, { error: error.message }));
    }
    if (!host) return hostBoxes.map((box) => record(box, { error: 'host profile missing' }));
    let guests;
    try {
      guests = await makeClient(host).clusterResources();
    } catch (error) {
      return hostBoxes.map((box) => record(box, { hostName: host.name, error: error.message }));
    }
    const byVmid = new Map((guests || []).filter((g) => g.type === 'lxc').map((g) => [Number(g.vmid), g]));
    return Promise.all(hostBoxes.map(async (box) => {
      const item = byVmid.get(Number(box.proxmox.vmid));
      if (!item) return record(box, { hostName: host.name, state: 'missing' });
      // The cluster list carries the container's CURRENT node. When it differs
      // from the stored link, follow the migration (trusted server-side write:
      // node only, for the already-linked hostId+vmid) — unless a lifecycle
      // job holds a snapshot of the old target; the next poll retries.
      if (item.node !== box.proxmox.node && boxStore && !activeJobGuard(box.id)) {
        try {
          await boxStore.setProxmoxLink(box.id, { ...box.proxmox, node: item.node });
          log(`[tmuxifier] box ${box.label}: container ${box.proxmox.vmid} migrated ${box.proxmox.node} -> ${item.node}`);
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not follow container migration to ${item.node}: ${error.message}`);
        }
      }
      return record(box, {
        hostName: host.name, node: item.node,
        containerName: item.name || null, state: normalizeState(item.status),
      });
    }));
  }

  async function doRefresh(boxes) {
    const groups = new Map();
    for (const box of boxes.filter((item) => item.proxmox)) {
      const hostId = box.proxmox.hostId;
      if (!groups.has(hostId)) groups.set(hostId, []);
      groups.get(hostId).push(box);
    }
    const records = (await Promise.all(
      [...groups.entries()].map(([hostId, hostBoxes]) => fetchHost(hostId, hostBoxes)),
    )).flat();
    for (const item of records) cache.set(item.boxId, item);
    return records;
  }
```

And in the returned object, add:

```js
    setActiveJobGuard(fn) { activeJobGuard = fn; },
```

Delete the now-unused `groupKey` helper on line 2 (`targetKey` on line 1 stays — still used by `listNodeContainers`). `refreshLinked`, `refreshBox`, `getLinkedContainers`, `listNodeContainers`, and `stateFor` are unchanged.

- [ ] **Step 4: NUL-byte check + RED→GREEN**

Run: `node -e "const b=require('fs').readFileSync('src/server/proxmoxInventory.js');process.exit(b.includes(0)?1:0)" && echo no-NUL-bytes && git diff --stat -- src/server/proxmoxInventory.js`
Expected: `no-NUL-bytes` and a text (not `Bin`) diff.

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: PASS (all, including the reworked originals).

- [ ] **Step 5: Store relink regression test**

Append to `test/store.test.js` (match its existing store-construction helper):

```js
test('setProxmoxLink can move an existing link to a new node, preserving vmid/host/endpoint', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.40', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' } }, { trustedProxmox: true });
  await store.setProxmoxLink(box.id, { hostId: 'H1', node: 'pve2', vmid: 131, endpoint: 'pve.example.com:8006' });
  const reloaded = (await createStore({ dataDir: dir }).getBox(box.id));
  expect(reloaded.proxmox).toEqual({ hostId: 'H1', node: 'pve2', vmid: 131, endpoint: 'pve.example.com:8006' });
});
```

Run: `npx vitest run test/store.test.js`
Expected: PASS (this pins existing behavior — the own-id exemption in the duplicate-link check).

- [ ] **Step 6: Wire `index.js`**

In the `createProxmoxInventory({...})` call, add `boxStore: store,` after `makeClient`. After the `lifecycleManager` construction block, add:

```js
proxmoxInventory.setActiveJobGuard((boxId) => lifecycleManager.hasActiveJob(boxId));
```

- [ ] **Step 7: Verify boot + covering tests**

Run: `npx vitest run test/proxmoxInventory.test.js test/store.test.js test/statusPoller.test.js test/proxmoxLifecycle.test.js && node -e "import('./src/server/server.js').then(()=>console.log('imports ok'))"`
Expected: all green; `imports ok`.

- [ ] **Step 8: Commit**

```bash
git add src/server/proxmoxInventory.js src/server/index.js test/proxmoxInventory.test.js test/store.test.js
git commit -m "feat(proxmox): cluster-aware inventory auto-follows container migrations"
```

---

### Task 3: Docs + full suite

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (identical edits), `README.md`

- [ ] **Step 1: CLAUDE.md + AGENTS.md**

Update the `proxmoxInventory.js` architecture bullet in both files (byte-identical) from "host/node-batched linked-LXC inventory and status authority" to:

```markdown
- `proxmoxInventory.js` — cluster-wide linked-LXC inventory and status authority (one
  `/cluster/resources` call per host); auto-follows node migrations by updating the stored
  link's node (guarded against active lifecycle jobs).
```

- [ ] **Step 2: README**

In the Proxmox LXC provisioning section (near the lifecycle/Containers description), add one sentence: containers migrated between nodes are followed automatically — Tmuxifier updates the stored node on its next status poll — and note the PVEAuditor grant also powers this cluster-wide inventory. Placeholders only.

- [ ] **Step 3: Full suite + PII scan**

Run: `npm test`
Expected: typecheck clean; ≥ 626 + new tests, all green.
Run: `git diff main --stat` — confirm no `src/web/` file changed.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: cluster-aware inventory and migration auto-follow"
```
