# Proxmox VM (qemu) Lifecycle Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Tmuxifier box link to a Proxmox VM (qemu guest) and run the five existing lifecycle actions — start, shutdown, stop, reboot, deprovision — against it, exactly as it already can for an LXC container.

**Architecture:** The guest kind (`'lxc' | 'qemu'`) is stored on the box's Proxmox link and threaded through the API client as a validated path segment. The inventory stops discarding qemu guests from the cluster payload it already receives, and reports a new `'mismatch'` state when a vmid's observed type disagrees with the stored link — a condition that refuses every action rather than auto-following. Deprovision escalates to a hard stop using PVE's own `forceStop`/`timeout` parameters. Throughout the subsystem, "container" is renamed to PVE's umbrella term, "guest".

**Tech Stack:** Node 20+ ESM (server, plain `.js`), TypeScript + Vite (web client), Vitest (unit + integration), Playwright (e2e), Fastify.

**Spec:** `docs/superpowers/specs/2026-08-01-proxmox-vm-lifecycle-design.md`

## Global Constraints

- **ESM everywhere** (`"type": "module"`), Node 20+. Server is plain `.js`; web client is `.ts`.
- **TDD, real code, no mocks.** Every module here is a factory with injected dependencies (`createProxmoxInventory`, `createProxmoxLifecycleManager`, `createProxmoxClient`). Fake *dependencies*, never mock the unit under test.
- **Vitest runs `environment: 'node'` with no jsdom.** There is no DOM in unit tests. Never plan a test that renders or queries DOM — only pure helpers are testable. DOM layers are verified in a real browser.
- **`test/e2e`'s fixture has no Proxmox host profile**, so no Playwright spec exercises this subsystem. Do not add e2e specs for it; they would need a live cluster.
- **Guest kinds are exactly `'lxc'` and `'qemu'`.** Both halves of any path segment derived from user input must be closed allowlists.
- **Conventional-commit messages** (`feat(pve): …`, `refactor(pve): …`, `test(pve): …`).
- **The repo is public — never commit real PII.** Tests and docs use `example.com`, RFC1918 addresses like `192.168.1.10`, and placeholder node names like `pve` / `pve2`.
- **Run `npm test`** (typecheck + vitest) before every commit. Individual files: `npx vitest run test/<file>`.
- **Work happens on branch `feat/proxmox-vm-lifecycle`**, already created, with the design doc committed.

---

## File Structure

**Server — modified**

| File | Responsibility after this change |
|---|---|
| `src/server/proxmoxValidate.js` | Exports `GUEST_KINDS`; `assertProxmoxLinkInput` validates an optional `kind` |
| `src/server/store.js` | `normalize` fills an absent link `kind` with `'lxc'` |
| `src/server/proxmoxApi.js` | Six kind-parameterized guest methods replacing the `*Lxc` six; `createLxc`/`lxcInterfaces` unchanged |
| `src/server/proxmoxInventory.js` | Discovers qemu guests; reports `'mismatch'`; `listNodeGuests` merges both kinds |
| `src/server/proxmoxLifecycle.js` | Dispatches on `job.kind`; deprovision force-stops after a grace |
| `src/server/proxmoxProvision.js` | Calls `startGuest('lxc', …)`; stamps `kind: 'lxc'` on the link it creates |
| `src/server/server.js` | Routes renamed to `/guests` |

**Web — modified, one renamed**

| File | Responsibility after this change |
|---|---|
| `src/web/proxmox.ts` | Guest-named types carrying `kind`; `linkedGuests()` / `nodeGuests()` fetchers |
| `src/web/proxmoxContainers.ts` → `src/web/proxmoxGuests.ts` | The Guests tab; `'mismatch'` yields no actions |
| `src/web/proxmoxAssociation.ts` | Picker offers both kinds; a kind change is a real mutation |
| `src/web/proxmoxUi.ts` | Tab labelled "Guests" |
| `src/web/dashboard.ts`, `src/web/main.ts`, `src/web/paneLifecycle.ts` | CT/VM badge from `proxmoxKind` |
| `src/web/style.css` | `.pve-container-*` → `.pve-guest-*` |

**Tests — modified, one renamed**

`test/proxmoxValidate.test.js`, `test/store.test.js`, `test/proxmoxApi.test.js`, `test/proxmoxApi.integration.test.js`, `test/proxmoxInventory.test.js`, `test/proxmoxLifecycle.test.js`, `test/proxmoxProvision.test.js`, `test/server.test.js`, `test/proxmoxRoutes.test.js`, `test/proxmoxWebClient.test.js`, `test/proxmoxAssociation.test.js`, and `test/proxmoxContainers.test.js` → `test/proxmoxGuests.test.js`.

---

### Task 1: Guest kind on the link

**Files:**
- Modify: `src/server/proxmoxValidate.js:155-161`
- Modify: `src/server/store.js:43-60`
- Test: `test/proxmoxValidate.test.js`, `test/store.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `GUEST_KINDS` (a frozen `['lxc','qemu']` array) exported from `proxmoxValidate.js`. Every stored link is guaranteed to carry `kind: 'lxc' | 'qemu'` after passing through `store.js`'s `normalize`.

- [ ] **Step 1: Write the failing validator tests**

Append to `test/proxmoxValidate.test.js`:

```js
test('link kind is optional but must be a known guest kind when present', () => {
  const opts = { hostIds: ['H1'] };
  const base = { hostId: 'H1', node: 'pve', vmid: 131 };
  // Absent kind is accepted — every link written before VM support omits it.
  expect(() => assertProxmoxLinkInput(base, opts)).not.toThrow();
  expect(() => assertProxmoxLinkInput({ ...base, kind: 'lxc' }, opts)).not.toThrow();
  expect(() => assertProxmoxLinkInput({ ...base, kind: 'qemu' }, opts)).not.toThrow();
  expect(() => assertProxmoxLinkInput({ ...base, kind: 'vm' }, opts)).toThrow(/guest kind/);
  expect(() => assertProxmoxLinkInput({ ...base, kind: '../qemu' }, opts)).toThrow(/guest kind/);
});
```

Confirm `assertProxmoxLinkInput` is already imported at the top of that file; add it to the import if not.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/proxmoxValidate.test.js -t 'guest kind'`
Expected: FAIL — `'vm'` and `'../qemu'` are accepted, so the two `toThrow` assertions fail.

- [ ] **Step 3: Add the allowlist to the validator**

In `src/server/proxmoxValidate.js`, add the export near the other module-level constants:

```js
// The only two guest types PVE has. Closed allowlist: this value becomes a URL
// path segment in proxmoxApi.js, so nothing outside this list may ever reach it.
export const GUEST_KINDS = Object.freeze(['lxc', 'qemu']);
```

Then extend `assertProxmoxLinkInput` (currently ending at the vmid check):

```js
export function assertProxmoxLinkInput(spec, { hostIds = [] } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('proxmox link is required');
  if (!nonEmpty(spec.hostId)) throw new Error('proxmox host is required');
  if (!hostIds.includes(spec.hostId)) throw new Error('proxmox host is unknown');
  if (!/^[A-Za-z0-9_.-]+$/.test(String(spec.node || ''))) throw new Error('invalid proxmox node');
  if (!intInRange(spec.vmid, 100, 999999999)) throw new Error('vmid must be 100..999999999');
  // Absent is accepted and defaults to 'lxc' in store.js — every link written
  // before VM support omits it, and every one of those is a container.
  if (spec.kind != null && !GUEST_KINDS.includes(spec.kind)) {
    throw new Error(`invalid proxmox guest kind: ${JSON.stringify(spec.kind)}`);
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/proxmoxValidate.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Write the failing store test**

Append to `test/store.test.js`:

```js
test('a link without a kind normalizes to lxc, and an explicit kind is preserved', async () => {
  const store = await freshStore();
  const legacy = await store.addBox(
    { host: '192.168.1.41', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' } },
    { trustedProxmox: true },
  );
  expect(legacy.proxmox.kind).toBe('lxc');

  const vm = await store.addBox(
    { host: '192.168.1.42', proxmox: { hostId: 'H1', node: 'pve', vmid: 132, endpoint: 'pve.example.com:8006', kind: 'qemu' } },
    { trustedProxmox: true },
  );
  expect(vm.proxmox.kind).toBe('qemu');
});

test('linkKey ignores kind, so one vmid cannot be linked twice under different kinds', async () => {
  const store = await freshStore();
  const first = await store.addBox({ host: '192.168.1.43' });
  const second = await store.addBox({ host: '192.168.1.44' });
  const link = { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' };
  await store.setProxmoxLink(first.id, { ...link, kind: 'lxc' });
  await expect(store.setProxmoxLink(second.id, { ...link, kind: 'qemu' })).rejects.toThrow(/already linked/);
});
```

Use whatever this file's existing store-construction helper is named — read the top of `test/store.test.js` and match it rather than introducing `freshStore()` if a differently-named helper already exists.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run test/store.test.js -t 'kind'`
Expected: FAIL — `legacy.proxmox.kind` is `undefined`.

- [ ] **Step 7: Normalize the kind in the store**

In `src/server/store.js`, change `normalize` (lines 43-60):

```js
  function normalize(spec, base = {}, { trustedProxmox = false } = {}) {
    if (!spec.host || typeof spec.host !== 'string') throw new Error('box requires a host');
    const raw = trustedProxmox ? spec.proxmox : base.proxmox;
    // A link written before VM support has no kind, and every one of those is a
    // container — so defaulting to 'lxc' migrates the whole file by asserting
    // what is already true. Nothing rewrites boxes.json; the default applies on
    // read, and an older build simply ignores the extra field.
    const link = raw ? { ...raw, kind: raw.kind === 'qemu' ? 'qemu' : 'lxc' } : raw;
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

Leave `linkKey` (line 64) alone — vmid is cluster-unique, so two links differing only in kind point at the same guest and one is wrong; keying on kind would let both exist.

- [ ] **Step 8: Fix the existing strict-equality assertion**

`test/store.test.js:255` asserts the whole link with `toEqual`, which now fails on the added key. Update the expectation:

```js
  expect(reloaded.proxmox).toEqual({ hostId: 'H1', node: 'pve2', vmid: 131, endpoint: 'pve.example.com:8006', kind: 'lxc' });
```

Run `npx vitest run test/store.test.js` and fix any other assertion that compares a link with strict `toEqual`. `toMatchObject` assertions need no change — they tolerate the extra key.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. If `test/proxmoxProvision.test.js` or `test/server.test.js` fail on a link comparison, add `kind: 'lxc'` to those expectations — the default is correct there, since provisioning creates containers.

- [ ] **Step 10: Commit**

```bash
git add src/server/proxmoxValidate.js src/server/store.js test/proxmoxValidate.test.js test/store.test.js
git commit -m "feat(pve): store a guest kind on the Proxmox box link

An absent kind normalizes to 'lxc', so every link already in boxes.json
migrates by asserting what is already true — nothing rewrites the file.
linkKey deliberately ignores kind: vmid is cluster-unique, so two links
differing only in kind point at the same guest and one of them is wrong."
```

---

### Task 2: Kind-parameterized API client

**Files:**
- Modify: `src/server/proxmoxApi.js:76-98`
- Modify: `src/server/proxmoxProvision.js:142`
- Test: `test/proxmoxApi.test.js`

**Interfaces:**
- Consumes: `GUEST_KINDS` from Task 1 (conceptually; the client keeps its own `Set` so it is self-contained and cannot be bypassed by a caller importing neither).
- Produces, on the object returned by `createProxmoxClient`:
  - `startGuest(kind, node, vmid) → Promise<string>` (UPID)
  - `shutdownGuest(kind, node, vmid, { forceStop = false, timeout = null } = {}) → Promise<string>`
  - `stopGuest(kind, node, vmid) → Promise<string>`
  - `rebootGuest(kind, node, vmid) → Promise<string>`
  - `destroyGuest(kind, node, vmid) → Promise<string>`
  - `listGuests(kind, node) → Promise<Array<{ vmid, name, status }>>`
  - Removed: `startLxc`, `shutdownLxc`, `stopLxc`, `rebootLxc`, `destroyLxc`, `listLxc`.
  - Unchanged: `createLxc`, `lxcInterfaces`, `clusterResources`, `clusterNodes`, `taskStatus`, `taskLog`, `nodes`, `storages`, `templates`, `bridges`, `nextId`, `version`.

- [ ] **Step 1: Write the failing client tests**

Append to `test/proxmoxApi.test.js`:

```js
test.each(['lxc', 'qemu'])('%s guest actions hit the kind-specific status paths', async (kind) => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:x' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  const base = `https://pve.example.com:8006/api2/json/nodes/pve/${kind}/131`;

  await client.startGuest(kind, 'pve', 131);
  expect(request.calls[0]).toMatchObject({ method: 'POST', url: `${base}/status/start` });

  await client.stopGuest(kind, 'pve', 131);
  expect(request.calls[1]).toMatchObject({ method: 'POST', url: `${base}/status/stop` });

  await client.rebootGuest(kind, 'pve', 131);
  expect(request.calls[2]).toMatchObject({ method: 'POST', url: `${base}/status/reboot` });

  await client.listGuests(kind, 'pve');
  expect(request.calls[3]).toMatchObject({ method: 'GET', url: `https://pve.example.com:8006/api2/json/nodes/pve/${kind}` });
});

test('graceful shutdown sends forceStop=0 and no timeout; deprovision escalates via PVE', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:x' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });

  await client.shutdownGuest('qemu', 'pve', 131);
  expect(request.calls[0].body).toBe('forceStop=0');

  await client.shutdownGuest('qemu', 'pve', 131, { forceStop: true, timeout: 120 });
  expect(request.calls[1].body).toContain('forceStop=1');
  expect(request.calls[1].body).toContain('timeout=120');
});

test('destroyGuest purges disks over DELETE with query params, for both kinds', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:x' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  await client.destroyGuest('qemu', 'pve', 131);
  const call = request.calls[0];
  expect(call.method).toBe('DELETE');
  // pveproxy rejects a DELETE carrying a body, so these ride the query string.
  expect(call.body).toBeUndefined();
  expect(call.url).toContain('/nodes/pve/qemu/131?');
  expect(call.url).toContain('purge=1');
  expect(call.url).toContain('destroy-unreferenced-disks=1');
});

test('an unknown guest kind is refused before it can become a path segment', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:x' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  await expect(client.startGuest('../nodes', 'pve', 131)).rejects.toThrow(/guest kind/);
  await expect(client.destroyGuest(undefined, 'pve', 131)).rejects.toThrow(/guest kind/);
  expect(request.calls).toHaveLength(0); // nothing reached the wire
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/proxmoxApi.test.js -t 'guest'`
Expected: FAIL — `client.startGuest is not a function`.

- [ ] **Step 3: Replace the six Lxc methods**

In `src/server/proxmoxApi.js`, add above `createProxmoxClient`:

```js
// PVE has exactly two guest types. This value becomes a URL path segment, so it
// is re-checked here rather than trusting that every caller validated it — the
// same chokepoint discipline voiceCatalog.js and iconCatalog.js apply.
const GUEST_KINDS = new Set(['lxc', 'qemu']);
const guestKind = (kind) => {
  if (!GUEST_KINDS.has(kind)) throw new Error(`invalid proxmox guest kind: ${JSON.stringify(kind)}`);
  return kind;
};
```

Then in the returned object, replace lines 86-94 (`startLxc`, `listLxc`, `shutdownLxc`, `stopLxc`, `rebootLxc`, `destroyLxc`) with:

```js
    startGuest: (kind, node, vmid) => call('POST', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}/status/start`, {}),
    listGuests: (kind, node) => call('GET', `/nodes/${enc(node)}/${guestKind(kind)}`),
    // forceStop + timeout let PVE do the escalation server-side: one task, no
    // window where we and PVE disagree about what is running, and the escalation
    // lands in the task log the operator already reads. Graceful shutdown passes
    // neither, so a graceful shutdown that fails, fails.
    shutdownGuest: (kind, node, vmid, { forceStop = false, timeout = null } = {}) => call(
      'POST', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}/status/shutdown`,
      { forceStop, ...(timeout == null ? {} : { timeout }) },
    ),
    stopGuest: (kind, node, vmid) => call('POST', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}/status/stop`, {}),
    rebootGuest: (kind, node, vmid) => call('POST', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}/status/reboot`, {}),
    destroyGuest: (kind, node, vmid) => call('DELETE', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}`, {
      purge: true,
      'destroy-unreferenced-disks': true,
    }),
```

`createLxc` and `lxcInterfaces` stay exactly as they are — provisioning is LXC-only and those names are honest.

- [ ] **Step 4: Update the one provisioning caller**

`src/server/proxmoxProvision.js:142` currently reads `const sup = await client.startLxc(j.node, j.vmid);`. Change to:

```js
        const sup = await client.startGuest('lxc', j.node, j.vmid);
```

Also make the link this module stamps explicit about its kind — line 174:

```js
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, kind: 'lxc', endpoint: host.endpoint, ...(j.netboxIpId ? { netboxIpId: j.netboxIpId } : {}) },
```

Task 1's normalize would default this to `'lxc'` anyway, but stating it where we *know* the answer beats relying on a default.

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run test/proxmoxApi.test.js test/proxmoxProvision.test.js`
Expected: PASS. Provision tests whose fake client defines `startLxc` must be updated to define `startGuest` — search the file for `startLxc` and rename, adding the leading `kind` argument to any assertion on its call arguments.

- [ ] **Step 6: Check the integration suite**

Run: `npx vitest run test/proxmoxApi.integration.test.js`
If it exercises any renamed method against its fake HTTPS server, update the call sites. If it only covers `createLxc`, TLS, and error mapping, it needs no change.

- [ ] **Step 7: Commit**

```bash
git add src/server/proxmoxApi.js src/server/proxmoxProvision.js test/proxmoxApi.test.js test/proxmoxApi.integration.test.js test/proxmoxProvision.test.js
git commit -m "feat(pve): parameterize the guest API methods by kind

Replaces the six hardcoded /lxc/ guest methods with startGuest/shutdownGuest/
stopGuest/rebootGuest/destroyGuest/listGuests, each taking the kind as a first
argument re-validated inside the client immediately before it becomes a path
segment. shutdownGuest gains forceStop/timeout so deprovision can let PVE run
the escalation server-side. createLxc and lxcInterfaces stay LXC-only."
```

---

### Task 3: Inventory discovers VMs and detects kind mismatch

**Files:**
- Modify: `src/server/proxmoxInventory.js` (`record` 40-44, `healGroup` 75-78, `fetchHost` 114-149, `listNodeContainers` 217-226, `mergeProxmoxStatus` 8-23)
- Test: `test/proxmoxInventory.test.js`

**Interfaces:**
- Consumes: `client.listGuests(kind, node)` from Task 2; links guaranteed to carry `kind` from Task 1.
- Produces:
  - Inventory records gain `kind: 'lxc' | 'qemu'` and `state` gains the value `'mismatch'`. Full record shape: `{ boxId, boxLabel, hostId, hostName, node, vmid, kind, containerName, state, fetchedAt, error }` where `state ∈ 'running' | 'stopped' | 'missing' | 'unknown' | 'mismatch'`.
  - `listNodeContainers` → **`listNodeGuests(hostId, node, boxes)`**, returning `Array<{ hostId, node, kind, vmid, name, state, linkedBoxId }>` sorted ascending by vmid.
  - `getLinkedContainers` → **`getLinkedGuests(boxes)`**, same return as before plus the new fields.
  - `mergeProxmoxStatus` adds `proxmoxKind` to each merged entry.

- [ ] **Step 1: Extend the test fixture to carry kinds**

In `test/proxmoxInventory.test.js`, replace the `linked` helper (lines 5-8) and `setup` client (lines 14-17):

```js
const linked = (id, node, vmid, kind = 'lxc') => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, kind, endpoint: HOST.endpoint },
});

function setup({ cluster = [], listByNode = {}, boxStore = null, guard } = {}) {
  const calls = { cluster: 0, nodes: [] };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({
      clusterResources: async () => { calls.cluster += 1; return cluster; },
      listGuests: async (kind, node) => { calls.nodes.push(`${kind}:${node}`); return (listByNode[node] || []).filter((g) => (g.type || 'lxc') === kind); },
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

Then fix the existing drift-follow assertion at line 55, which compares the written link with strict `toEqual` and now must include the kind:

```js
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'pve-n03', vmid: 165, kind: 'lxc', endpoint: HOST.endpoint }]]);
```

Run `npx vitest run test/proxmoxInventory.test.js` and fix any other assertion broken purely by the added field or the `listLxc` → `listGuests` rename. This step is preparation — the suite should be green again before you add new behavior.

- [ ] **Step 2: Write the failing behavior tests**

Append to `test/proxmoxInventory.test.js`:

```js
test('a linked VM is discovered from the same cluster payload containers come from', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'ct-01' },
    { vmid: 200, node: 'pve', type: 'qemu', status: 'running', name: 'vm-01' },
  ] });
  const records = await inventory.refreshLinked([linked('b1', 'pve', 131), linked('b2', 'pve', 200, 'qemu')]);
  expect(records.map((r) => [r.boxId, r.kind, r.state])).toEqual([
    ['b1', 'lxc', 'running'], ['b2', 'qemu', 'running'],
  ]);
});

test('a vmid whose type disagrees with the link reports mismatch and never writes the link', async () => {
  const writes = [];
  const { inventory } = setup({
    // vmid 165 was destroyed as a container and recreated as a VM on another node.
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'qemu', status: 'running', name: 'someone-elses-vm' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => linked('b1', 'pve-n02', 165),
    },
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve-n02', 165, 'lxc')]);
  expect(record.state).toBe('mismatch');
  expect(record.kind).toBe('qemu');           // report what is actually there
  expect(record.error).toMatch(/165/);
  expect(record.error).toMatch(/re-link/);
  // Load-bearing: a mismatched vmid may not be our guest at all, so the node
  // drift-follow must not write anything back for it.
  expect(writes).toEqual([]);
});

test('re-homing an orphaned link requires the vmid to still be the same kind', async () => {
  const writes = [];
  const hosts = [{ id: 'H2', name: 'lab-readded', endpoint: HOST.endpoint }];
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      listHosts: async () => hosts,
      getHost: async (id) => id === 'H2' ? { ...hosts[0], tokenSecret: 'sek' } : undefined,
    },
    makeClient: () => ({
      clusterResources: async () => [{ vmid: 165, node: 'pve', type: 'qemu', status: 'running', name: 'vm' }],
    }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async (id) => box },
    now: () => 1000, log: () => {},
  });
  // The link points at the old host id H1 and says lxc; the re-added profile H2
  // has the right endpoint, but vmid 165 is now a VM.
  const box = { id: 'b1', label: 'b1', host: '192.168.1.65', proxmox: { hostId: 'H1', node: 'pve', vmid: 165, kind: 'lxc', endpoint: HOST.endpoint } };
  const [record] = await inventory.refreshLinked([box]);
  expect(record.error).toBe('host profile missing');
  expect(writes).toEqual([]);
});

test('listNodeGuests merges both kinds, tags each, and sorts by vmid', async () => {
  const { inventory, calls } = setup({ listByNode: { pve: [
    { vmid: 300, type: 'qemu', status: 'running', name: 'vm-hi' },
    { vmid: 131, type: 'lxc', status: 'stopped', name: 'ct-lo' },
    { vmid: 200, type: 'qemu', status: 'stopped', name: 'vm-mid' },
  ] } });
  const rows = await inventory.listNodeGuests('H1', 'pve', [linked('b1', 'pve', 131)]);
  expect(rows.map((r) => [r.vmid, r.kind])).toEqual([[131, 'lxc'], [200, 'qemu'], [300, 'qemu']]);
  expect(rows[0].linkedBoxId).toBe('b1');
  expect(rows[1].linkedBoxId).toBeNull();
  expect(calls.nodes.sort()).toEqual(['lxc:pve', 'qemu:pve']);
});

test('mergeProxmoxStatus carries the guest kind into the status snapshot', () => {
  const boxes = [linked('b1', 'pve', 200, 'qemu')];
  const records = [{ boxId: 'b1', state: 'running', node: 'pve', vmid: 200, kind: 'qemu' }];
  const merged = mergeProxmoxStatus({ b1: { reachable: true } }, boxes, records);
  expect(merged.b1).toMatchObject({ reachable: true, proxmoxState: 'running', proxmoxKind: 'qemu', proxmoxVmid: 200 });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: FAIL — VMs are filtered out (so the VM box reads `missing`), `listNodeGuests` is not a function, and `proxmoxKind` is absent.

- [ ] **Step 4: Implement the inventory changes**

In `src/server/proxmoxInventory.js`:

Add near `SAFE_NODE` at the top:

```js
const GUEST_TYPES = new Set(['lxc', 'qemu']);
// A link written before VM support has no kind and is a container by definition.
const linkKind = (box) => (box.proxmox && box.proxmox.kind === 'qemu' ? 'qemu' : 'lxc');
```

Add `proxmoxKind` in `mergeProxmoxStatus`:

```js
    next[box.id] = {
      ...(next[box.id] || { reachable: false }),
      proxmoxState: record.state,
      proxmoxNode: record.node,
      proxmoxVmid: record.vmid,
      proxmoxKind: record.kind,
    };
```

Give `record()` a kind default:

```js
  const record = (box, fields) => ({
    boxId: box.id, boxLabel: box.label, hostId: box.proxmox.hostId, hostName: null,
    node: box.proxmox.node, vmid: Number(box.proxmox.vmid), kind: linkKind(box), containerName: null,
    state: 'unknown', fetchedAt: now(), error: null, ...fields,
  });
```

In `healGroup`, replace the presence set with a kind-aware map:

```js
      const present = new Map(guests.filter((g) => GUEST_TYPES.has(g.type)).map((g) => [Number(g.vmid), g.type]));
      const healed = [];
      for (const box of candidateBoxes) {
        // Same "never guess" rule the endpoint match already follows: a vmid
        // that came back as the other type is a different guest, not ours.
        if (present.get(Number(box.proxmox.vmid)) !== linkKind(box)) { results.push(orphan(box)); continue; }
```

In `fetchHost`, widen the map and add the mismatch branch:

```js
    const byVmid = new Map((guests || []).filter((g) => GUEST_TYPES.has(g.type)).map((g) => [Number(g.vmid), g]));
    return Promise.all(hostBoxes.map(async (box) => {
      const item = byVmid.get(Number(box.proxmox.vmid));
      if (!item) return record(box, { hostName: host.name, state: 'missing' });
      const nodeValid = typeof item.node === 'string' && SAFE_NODE.test(item.node);
      const want = linkKind(box);
      // A vmid that changed type is a DIFFERENT guest wearing the same number —
      // unlike a migration, which is the same guest on a new node. Refuse and
      // make the operator re-link; write nothing back, not even the node, since
      // this container may belong to someone else entirely.
      if (item.type !== want) {
        return record(box, {
          hostName: host.name, kind: item.type,
          node: nodeValid ? item.node : box.proxmox.node,
          containerName: item.name || null,
          state: 'mismatch',
          error: `vmid ${Number(box.proxmox.vmid)} is a ${item.type} guest on this cluster, but this box is linked to a ${want} — re-link the box`,
        });
      }
      if (!nodeValid) {
        log(`[tmuxifier] box ${box.label}: ignoring malformed node from cluster resources: ${item.node}`);
      } else if (item.node !== box.proxmox.node && boxStore && !activeJobGuard(box.id)) {
```

…leaving the rest of the drift-follow block unchanged, and the final `record(box, {...})` gaining `kind: item.type`:

```js
      return record(box, {
        hostName: host.name, node: nodeValid ? item.node : box.proxmox.node,
        kind: item.type, containerName: item.name || null, state: normalizeState(item.status),
      });
```

Finally rename the two exported readers:

```js
    async getLinkedGuests(boxes) { return refreshLinked(boxes); },
    async listNodeGuests(hostId, node, boxes) {
      const host = await proxmoxStore.getHost(hostId, { withSecret: true });
      if (!host) throw new Error('proxmox host not found');
      const linked = new Map(boxes.filter((box) => box.proxmox).map((box) => [targetKey(box.proxmox), box.id]));
      const client = makeClient(host);
      // Both must succeed. PVE permissions are path-based on /vms/<vmid> and do
      // not distinguish guest type, so "can list containers but not VMs" is not
      // a real token; silently omitting VMs would be worse than a visible error.
      const [lxc, qemu] = await Promise.all([client.listGuests('lxc', node), client.listGuests('qemu', node)]);
      return [
        ...(lxc || []).map((item) => ({ item, kind: 'lxc' })),
        ...(qemu || []).map((item) => ({ item, kind: 'qemu' })),
      ].map(({ item, kind }) => ({
        hostId, node, kind, vmid: Number(item.vmid), name: item.name || String(item.vmid),
        state: normalizeState(item.status),
        linkedBoxId: linked.get(targetKey({ hostId, node, vmid: item.vmid })) || null,
      })).sort((a, b) => a.vmid - b.vmid);
    },
```

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: PASS.

- [ ] **Step 6: Fix the two server call sites so the suite builds**

`src/server/server.js:1171` calls `getLinkedContainers`; `:1195` calls `listNodeContainers`. Rename both call sites now (the *route paths* move in Task 5):

```js
      const records = await proxmoxInventory.getLinkedGuests(await store.listBoxes());
```
```js
    try { return await proxmoxInventory.listNodeGuests(req.params.id, req.params.node, await store.listBoxes()); }
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/server/proxmoxInventory.js src/server/server.js test/proxmoxInventory.test.js
git commit -m "feat(pve): discover VMs in the inventory and detect kind mismatch

/cluster/resources?type=vm already returned both guest types; the filter that
dropped qemu is gone. A vmid whose observed type disagrees with the stored link
reports state 'mismatch' and writes nothing back — deliberately unlike the node
drift-follow, because a migrated guest is the same guest while a retyped vmid is
a different guest wearing the same number.

Renames getLinkedContainers/listNodeContainers to the guest spelling."
```

---

### Task 4: Lifecycle manager dispatches on kind

**Files:**
- Modify: `src/server/proxmoxLifecycle.js` (load loop 27-37, `summary` 47, `resolveTarget` 58-66, `runRoutine` 80-102, `runDeprovision` 154-187, `createJob` 199-240)
- Test: `test/proxmoxLifecycle.test.js`

**Interfaces:**
- Consumes: `startGuest`/`shutdownGuest`/`stopGuest`/`rebootGuest`/`destroyGuest` (Task 2); inventory records carrying `kind` and the `'mismatch'` state (Task 3).
- Produces: job records and `summary()` output gain `kind: 'lxc' | 'qemu'`. New constructor option `deprovisionGraceSec` (default `120`).

- [ ] **Step 1: Update the fixture to the guest API**

In `test/proxmoxLifecycle.test.js`, change `BOX` (line 5) and the `fixture` client (lines 10-17):

```js
const BOX = { id: 'B1', label: 'dev-01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc', endpoint: HOST.endpoint } };

function fixture(initialState = 'stopped', overrides = {}) {
  let state = initialState;
  const calls = [];
  const client = {
    startGuest: async (kind) => { calls.push(`start:${kind}`); state = 'running'; return 'UPID:start'; },
    shutdownGuest: async (kind, node, vmid, opts) => { calls.push(`shutdown:${kind}`, opts); state = 'stopped'; return 'UPID:shutdown'; },
    stopGuest: async (kind) => { calls.push(`stop:${kind}`); state = 'stopped'; return 'UPID:stop'; },
    rebootGuest: async (kind) => { calls.push(`reboot:${kind}`); state = 'running'; return 'UPID:reboot'; },
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'task output' }],
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: { getBox: async (id) => id === 'B1' ? BOX : undefined },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
    makeClient: () => client,
    load: () => [], save: () => {}, sleep: async () => {}, pollMs: 0,
    now: () => '2026-07-11T00:00:00.000Z', makeId: () => 'J1',
    removeLinkedBox: async () => {}, shutdownTimeoutMs: 600_000,
    ...overrides,
  });
  return { manager, calls, getState: () => state };
}
```

The first `test.each` block asserts `expect(calls).toContain(action)`; change it to `expect(calls).toContain(`${action}:lxc`)`. Then sweep the whole file for `startLxc` / `shutdownLxc` / `stopLxc` / `rebootLxc` / `destroyLxc` in per-test `makeClient` overrides and rename each to its `*Guest` spelling, adding the leading `kind` parameter.

Note `test/proxmoxLifecycle.test.js:209` ("deprovision shutdown failure never escalates to stop") asserts we never call the stop method ourselves. That assertion stays true and must be **kept**: our escalation is PVE-side via `forceStop`, not a second client call.

- [ ] **Step 2: Run and watch the fixture rename fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: FAIL — the manager still calls `startLxc`, which the fixture no longer defines.

- [ ] **Step 3: Write the new failing behavior tests**

Append to `test/proxmoxLifecycle.test.js`:

```js
const VM_BOX = { id: 'B1', label: 'vm-01', host: '192.168.1.20', proxmox: { hostId: 'H1', node: 'pve', vmid: 200, kind: 'qemu', endpoint: HOST.endpoint } };

test.each([
  ['start', 'stopped', 'running'],
  ['shutdown', 'running', 'stopped'],
  ['stop', 'running', 'stopped'],
  ['reboot', 'running', 'running'],
])('%s runs against a qemu guest and records the kind on the job', async (action, initial, final) => {
  let state = initial;
  const { manager, calls } = fixture(initial, {
    boxStore: { getBox: async (id) => id === 'B1' ? VM_BOX : undefined },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 200, kind: 'qemu' }) },
    makeClient: () => ({
      startGuest: async (kind) => { calls.push(`start:${kind}`); state = 'running'; return 'UPID:start'; },
      shutdownGuest: async (kind) => { calls.push(`shutdown:${kind}`); state = 'stopped'; return 'UPID:shutdown'; },
      stopGuest: async (kind) => { calls.push(`stop:${kind}`); state = 'stopped'; return 'UPID:stop'; },
      rebootGuest: async (kind) => { calls.push(`reboot:${kind}`); state = 'running'; return 'UPID:reboot'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const summary = await manager.createJob({ boxId: 'B1', action });
  expect(summary).toMatchObject({ action, kind: 'qemu', vmid: 200 });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done', error: null });
  expect(calls).toContain(`${action}:qemu`);
  expect(state).toBe(final);
});

test('a kind mismatch refuses every action with a message naming the problem', async () => {
  const { manager } = fixture('running', {
    inventory: { refreshBox: async () => ({
      boxId: 'B1', state: 'mismatch', node: 'pve', vmid: 131, kind: 'qemu',
      error: 'vmid 131 is a qemu guest on this cluster, but this box is linked to a lxc — re-link the box',
    }) },
  });
  await expect(manager.createJob({ boxId: 'B1', action: 'shutdown' }))
    .rejects.toMatchObject({ statusCode: 409, message: /re-link the box/ });
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: /re-link the box/ });
  expect(manager.listJobs()).toEqual([]);
});

test('deprovision hands PVE the grace period and the force-stop flag', async () => {
  let state = 'running';
  const shutdowns = [];
  const calls = [];
  const { manager } = fixture('running', {
    deprovisionGraceSec: 90,
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
    makeClient: () => ({
      shutdownGuest: async (kind, node, vmid, opts) => { shutdowns.push([kind, opts]); state = 'stopped'; return 'UPID:shutdown'; },
      stopGuest: async () => { calls.push('stop'); return 'UPID:stop'; },
      destroyGuest: async (kind) => { calls.push(`destroy:${kind}`); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done' });
  expect(shutdowns).toEqual([['lxc', { forceStop: true, timeout: 90 }]]);
  // The escalation is PVE's, not ours: we never issue a separate stop.
  expect(calls).toEqual(['destroy:lxc']);
});

test('a job loaded from history without a kind reads as lxc', async () => {
  const { manager } = fixture('stopped', {
    load: () => [{ id: 'OLD', action: 'start', boxId: 'B1', status: 'done', phase: 'done', createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', log: '', error: null }],
  });
  expect(manager.listJobs()[0]).toMatchObject({ id: 'OLD', kind: 'lxc' });
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js -t 'qemu'`
Expected: FAIL — `summary` has no `kind`, and the manager calls `client.startLxc`.

- [ ] **Step 5: Implement the lifecycle changes**

In `src/server/proxmoxLifecycle.js`:

Add the constructor option beside the other timeouts (line 18 area):

```js
  taskTimeoutMs = 600_000, shutdownTimeoutMs = taskTimeoutMs, maxPollFailures = 5,
  deprovisionGraceSec = 120,
```

Add a helper beside `targetKey` (line 10):

```js
const jobKind = (link) => (link && link.kind === 'qemu' ? 'qemu' : 'lxc');
```

In the load loop (after line 31's shape guard), default the kind:

```js
    if (!job || typeof job !== 'object' || typeof job.id !== 'string') continue;
    // Every job in an existing history file acted on a container, so this states
    // a fact rather than guessing. Loaded jobs are forced terminal, so it is
    // only ever read for display.
    job.kind = jobKind(job);
```

Add `kind` to `summary` (line 47), right after `vmid`:

```js
  const summary = (job) => ({ id: job.id, action: job.action, boxId: job.boxId, boxLabel: job.boxLabel, hostId: job.hostId, hostName: job.hostName, node: job.node, vmid: job.vmid, kind: job.kind, status: job.status, phase: job.phase, error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt });
```

Extend `resolveTarget` to compare the kind — `targetKey` deliberately does not, since it is about job-collision identity:

```js
  async function resolveTarget(job) {
    const box = await boxStore.getBox(job.boxId);
    if (!box || !box.proxmox || targetKey(box.proxmox) !== targetKey(job) || jobKind(box.proxmox) !== job.kind) {
      throw new Error('box Proxmox link changed before lifecycle action');
    }
    const host = await proxmoxStore.getHost(job.hostId, { withSecret: true });
    if (!host) throw new Error('Proxmox host profile is unavailable');
    return { box, client: makeClient(host) };
  }
```

In `runRoutine`, add the mismatch guard and dispatch on kind:

```js
  async function runRoutine(job) {
    const { box, client } = await resolveTarget(job);
    const current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
    if (current.state !== REQUIRED[job.action]) throw new Error(`${job.action} requires ${REQUIRED[job.action]}`);
    job.phase = 'request'; persist();
    const method = `${job.action}Guest`;
    const upid = await client[method](job.kind, job.node, job.vmid);
```

…the rest of `runRoutine` unchanged.

In `runDeprovision`, add the same guard and switch both calls:

```js
    let current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
```

```js
    if (current.state === 'running') {
      job.phase = 'shutdown'; persist();
      // forceStop + timeout make PVE escalate server-side once the grace expires:
      // one task rather than a poll loop plus a second request, and no window in
      // which we and PVE disagree about what is running. The guest's disk is
      // about to be purged, so a clean unmount is moot.
      const shutdown = await client.shutdownGuest(job.kind, job.node, job.vmid, { forceStop: true, timeout: deprovisionGraceSec });
      appendLog(job, `# shutdown ${shutdown}\n`); persist();
      await pollTask(client, job, shutdown);
      current = await waitForState(job, 'stopped', shutdownTimeoutMs);
    }
```

```js
    const destroy = await client.destroyGuest(job.kind, job.node, job.vmid);
```

In `createJob`, add the mismatch refusal and record the kind:

```js
    const current = await inventory.refreshBox(box).catch((error) => { throw serviceError(502, error.message); });
    if (current.state === 'unknown') throw serviceError(502, current.error || 'Proxmox state unavailable');
    // Checked explicitly rather than left to fall through to the REQUIRED test:
    // "start requires stopped" would send the operator debugging the wrong thing
    // when the real problem is that this vmid is not the guest they linked.
    if (current.state === 'mismatch') throw serviceError(409, current.error || 'proxmox guest kind mismatch');
    if (action === 'deprovision') {
```

…and in the job literal, after `vmid`:

```js
      hostId: host.id, hostName: host.name, node: current.node, vmid: Number(box.proxmox.vmid),
      kind: jobKind(box.proxmox),
```

Note the asymmetry, and keep it: `node` comes from `current` because it drift-follows, while `kind` comes from the **link**, which is its authority. The refresh's role was only to prove the two agree.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: PASS, all tests in the file including the pre-existing ones.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/server/proxmoxLifecycle.js test/proxmoxLifecycle.test.js
git commit -m "feat(pve): run lifecycle actions against VMs as well as containers

Dispatch is now client[\`\${action}Guest\`](job.kind, …), with the kind taken from
the link rather than the refreshed record — deliberately unlike node, which is
snapshotted from the record precisely because it drift-follows.

A 'mismatch' state refuses in createJob, runRoutine and runDeprovision with an
explicit message. Deprovision passes forceStop + deprovisionGraceSec (default
120s) so PVE escalates server-side; we still never issue a stop ourselves, so
the existing 'shutdown failure never escalates' invariant is untouched."
```

---

### Task 5: Rename the routes to /guests

**Files:**
- Modify: `src/server/server.js:1164`, `:1169`, `:1186`, `:1202`
- Test: `test/server.test.js`, `test/proxmoxRoutes.test.js`

**Interfaces:**
- Consumes: `getLinkedGuests` / `listNodeGuests` (Task 3), already wired in Task 3 Step 6.
- Produces: `GET /api/proxmox/guests` and `GET /api/proxmox/hosts/:id/nodes/:node/guests`. `POST /api/proxmox/lifecycle-jobs` is unchanged — it was already kind-neutral.

- [ ] **Step 1: Point the existing route tests at the new paths**

In `test/server.test.js` and `test/proxmoxRoutes.test.js`, replace every occurrence of `/api/proxmox/containers` with `/api/proxmox/guests`, and every `/nodes/<node>/containers` with `/nodes/<node>/guests`. Find them with:

```bash
grep -rn "proxmox/containers\|/containers'" test/
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/server.test.js test/proxmoxRoutes.test.js`
Expected: FAIL with 404 — the routes still answer on the old paths.

- [ ] **Step 3: Rename the routes**

In `src/server/server.js`:

```js
  // --- Proxmox linked-guest inventory and lifecycle jobs ---
```
```js
  app.get('/api/proxmox/guests', { preHandler: requireAuth }, async (_req, reply) => {
```
```js
  app.get('/api/proxmox/hosts/:id/nodes/:node/guests', { preHandler: requireAuth }, async (req, reply) => {
```

And line 1202's message, which says "container" about something that may now be a VM:

```js
    if (box.proxmox && lifecycleManager.hasActiveTarget(box.proxmox)) return reply.code(409).send({ error: 'guest has an active lifecycle job' });
```

If any test asserts that exact 409 string, update it to match.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/server.test.js test/proxmoxRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js test/proxmoxRoutes.test.js
git commit -m "refactor(pve): rename the container routes to /guests

/api/proxmox/containers -> /api/proxmox/guests, and the per-node listing
likewise. /api/proxmox/lifecycle-jobs was already kind-neutral and does not
move. The web client follows in the next commit."
```

---

### Task 6: Web client — types, Guests tab, picker, and badges

Renaming the web types breaks every consumer at once, so this task carries all
four parts and lands as **one commit**. Splitting it would put three
non-typechecking commits in history, contradicting the Global Constraint that
`npm test` passes before every commit. Work Parts A→D in order; commit once at
the end, after Part D's verification gates.

**Files:**
- Modify: `src/web/proxmox.ts:24-28`, `:35`, `:66-69`; `src/web/api.ts`
- Rename: `src/web/proxmoxContainers.ts` → `src/web/proxmoxGuests.ts`
- Rename: `test/proxmoxContainers.test.js` → `test/proxmoxGuests.test.js`
- Modify: `src/web/proxmoxUi.ts:10`, `src/web/proxmoxAssociation.ts`, `src/web/dashboard.ts`, `src/web/main.ts`, `src/web/paneLifecycle.ts`, `src/web/style.css`
- Test: `test/proxmoxWebClient.test.js`, `test/proxmoxAssociation.test.js`

**Interfaces:**
- Consumes: the routes from Task 5 and the record shapes from Tasks 3-4.
- Produces:
  - `export type PveGuestKind = 'lxc' | 'qemu'`
  - `export type PveGuestState = 'running' | 'stopped' | 'missing' | 'unknown' | 'mismatch'`
  - `PveLinkedGuest` = the old `PveLinkedContainer` + `kind: PveGuestKind`, with `state: PveGuestState`
  - `PveNodeGuest` = the old `PveNodeContainer` + `kind: PveGuestKind`
  - `LifecycleJobSummary` + `kind: PveGuestKind`
  - `pve.linkedGuests()`, `pve.nodeGuests(hostId, node)`
  - `PveBoxLink` (in `api.ts`) + `kind: PveGuestKind`
  - `renderGuestsTab(content, deps)`, `actionsForState(state: PveGuestState): LifecycleAction[]`, `guestMatches(guest: PveLinkedGuest, term: string): boolean`, `kindLabel(kind: PveGuestKind): 'CT' | 'VM'` — all from `src/web/proxmoxGuests.ts`
  - `associationMutation(current, draft)` where `Draft` is `{ mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number; kind: PveGuestKind }`

#### Part A — types and fetch layer

- [ ] **Step 1: Rewrite the type block**

In `src/web/proxmox.ts`, replace lines 24-28:

```ts
export type PveGuestKind = 'lxc' | 'qemu';
// 'mismatch': the vmid's observed type disagrees with the stored link — a
// different guest wearing the same number. No lifecycle action is offered.
export type PveGuestState = 'running' | 'stopped' | 'missing' | 'unknown' | 'mismatch';
export type LifecycleAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'deprovision';
export type LifecycleStatus = 'running' | 'done' | 'error' | 'interrupted';
export interface PveLinkedGuest { boxId: string; boxLabel: string; hostId: string; hostName: string | null; node: string; vmid: number; kind: PveGuestKind; containerName: string | null; state: PveGuestState; fetchedAt: number; error: string | null; activeJob: LifecycleJobSummary | null; }
export interface PveNodeGuest { hostId: string; node: string; kind: PveGuestKind; vmid: number; name: string; state: PveGuestState; linkedBoxId: string | null; }
```

Add `kind: PveGuestKind;` to `LifecycleJobSummary` (line 35), after `vmid: number;`.

Replace the two fetchers (lines 66, 68):

```ts
  linkedGuests() { return jr<PveLinkedGuest[]>('/api/proxmox/guests'); },
  nodeGuests(hostId: string, node: string) { return jr<PveNodeGuest[]>(`/api/proxmox/hosts/${hostId}/nodes/${encodeURIComponent(node)}/guests`); },
```

- [ ] **Step 2: Add kind to the link type**

In `src/web/api.ts`, find `PveBoxLink` and add `kind: PveGuestKind;`, importing the type from `./proxmox` (or declaring it locally if `api.ts` must not import from `proxmox.ts` — check the existing import direction first and follow it).

- [ ] **Step 3: Run the typechecker and save the breakage list**

Run: `npm run typecheck`
Expected: FAIL, with errors in `proxmoxContainers.ts`, `proxmoxAssociation.ts`, `proxmoxUi.ts`, `dashboard.ts`, `main.ts`, `paneLifecycle.ts`. This failure is expected and temporary — Parts B-D close it before the single commit at the end. Save the error list; it is Part D's worklist.

- [ ] **Step 4: Update the web-client fetch test**

In `test/proxmoxWebClient.test.js`, rename any `linkedContainers` / `nodeContainers` call and update asserted URLs to `/api/proxmox/guests` and `…/guests`.

**Do not commit yet** — the tree does not typecheck until Part D. Continue to Part B.

#### Part B — the Guests tab

- [ ] **Step 5: Move the files**

```bash
git mv src/web/proxmoxContainers.ts src/web/proxmoxGuests.ts
git mv test/proxmoxContainers.test.js test/proxmoxGuests.test.js
```

- [ ] **Step 6: Write the failing pure-helper tests**

Replace the body of `test/proxmoxGuests.test.js` imports and append:

```js
import { actionsForState, guestMatches, kindLabel } from '../src/web/proxmoxGuests.ts';

const guest = (over = {}) => ({
  boxId: 'b1', boxLabel: 'vm-01', hostId: 'H1', hostName: 'lab', node: 'pve',
  vmid: 200, kind: 'qemu', containerName: 'vm-01', state: 'running',
  fetchedAt: 0, error: null, activeJob: null, ...over,
});

test('a kind mismatch offers no lifecycle action at all', () => {
  expect(actionsForState('mismatch')).toEqual([]);
});

test('kindLabel uses PVE shorthand', () => {
  expect(kindLabel('lxc')).toBe('CT');
  expect(kindLabel('qemu')).toBe('VM');
});

test('the filter matches the kind label the row displays', () => {
  expect(guestMatches(guest(), 'vm')).toBe(true);
  expect(guestMatches(guest({ kind: 'lxc', boxLabel: 'ct-01' }), 'ct')).toBe(true);
  expect(guestMatches(guest({ kind: 'lxc', boxLabel: 'ct-01' }), 'vm')).toBe(false);
  expect(guestMatches(guest(), '')).toBe(true);
});
```

Keep every pre-existing test in the file, renaming `containerMatches` to `guestMatches` in each.

- [ ] **Step 7: Run and watch it fail**

Run: `npx vitest run test/proxmoxGuests.test.js`
Expected: FAIL — `kindLabel` is not exported and `guestMatches` does not exist.

- [ ] **Step 8: Update the module**

In `src/web/proxmoxGuests.ts`:

```ts
import { pve, type LifecycleAction, type PveGuestKind, type PveGuestState, type PveLinkedGuest } from './proxmox';

export const kindLabel = (kind: PveGuestKind): 'CT' | 'VM' => (kind === 'qemu' ? 'VM' : 'CT');

export function actionsForState(state: PveGuestState): LifecycleAction[] {
  if (state === 'running') return ['shutdown', 'stop', 'reboot', 'deprovision'];
  if (state === 'stopped') return ['start', 'deprovision'];
  if (state === 'missing') return ['deprovision'];
  // 'unknown' and 'mismatch' both offer nothing: one because we cannot see the
  // guest, the other because the guest we can see may not be ours.
  return [];
}

export function guestMatches(guest: PveLinkedGuest, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [guest.boxLabel, guest.hostName ?? guest.hostId, guest.node, String(guest.vmid), kindLabel(guest.kind), guest.state]
    .some((field) => field.toLowerCase().includes(t));
}
```

Rename `renderContainersTab` → `renderGuestsTab`, `PveLinkedContainer` → `PveLinkedGuest`, `pve.linkedContainers()` → `pve.linkedGuests()`, the local `containers` variable to `guests`, and `container` to `guest` throughout. Update the CSS class strings: `pve-container-search` → `pve-guest-search`, `pve-container-toolbar` → `pve-guest-toolbar`, `pve-container-list` → `pve-guest-list`, `pve-container-row` → `pve-guest-row`.

Add the kind badge to the row, beside the state badge:

```ts
      el('span', { class: `pve-badge kind ${guest.kind}` }, [kindLabel(guest.kind)]),
      el('span', { class: `pve-badge ${guest.state}` }, [guest.state]),
```

Show the mismatch explanation, since `actionsForState` returns nothing and the row would otherwise be a dead end. Immediately after the row is constructed:

```ts
    if (guest.state === 'mismatch' && guest.error) row.append(err(guest.error));
```

Extend the "Edit link" affordance to cover it — change the existing condition:

```ts
    if (guest.state === 'unknown' || guest.state === 'missing' || guest.state === 'mismatch') {
      actions.append(el('button', { type: 'button', onclick: () => deps.openEditBox(guest.boxId) }, ['Edit link']));
    }
```

Update the deprovision dialog copy:

```ts
    el('h2', {}, ['Deprovision guest']),
    el('div', {}, [`${guest.boxLabel} | ${kindLabel(guest.kind)} | ${guest.hostName ?? guest.hostId} | ${guest.node} | VMID ${guest.vmid}`]),
    el('p', { class: 'pve-warning' }, [guest.state === 'missing'
      ? 'Proxmox already reports this guest missing. Tmuxifier will remove only the stale linked box.'
      : `Tmuxifier will ask Proxmox to shut the guest down gracefully, force it off if it has not stopped within the grace period, then destroy it and its ${guest.kind === 'qemu' ? 'disks' : 'volumes'}, keep independent backups, and remove the linked box.`]),
```

- [ ] **Step 9: Update the hub**

In `src/web/proxmoxUi.ts`, change the import to `import { renderGuestsTab } from './proxmoxGuests';`, the call site, and the tab label from `Containers` to `Guests`.

- [ ] **Step 10: Rename the CSS**

In `src/web/style.css`, rename `.pve-container-row` → `.pve-guest-row`, `.pve-container-toolbar` → `.pve-guest-toolbar`, `.pve-container-search` → `.pve-guest-search`, `.pve-container-list` → `.pve-guest-list`. Add a rule for the kind badge next to the existing `.pve-badge` rules, following whatever DESIGN.md specifies for secondary badges — read `DESIGN.md` before choosing colors rather than inventing them.

- [ ] **Step 11: Verify no orphaned class hooks remain**

```bash
grep -rn "pve-container" src/ test/
```
Expected: **zero hits.** A class hook no stylesheet matches fails silently rather than at the typechecker — this grep is the only thing that catches it.

- [ ] **Step 12: Check the tab's own tests**

Run: `npx vitest run test/proxmoxGuests.test.js`
Expected: PASS. Typecheck still fails in `proxmoxAssociation.ts`, `dashboard.ts`, `main.ts`, `paneLifecycle.ts` — Parts C and D close those. **Do not commit yet.**

#### Part C — association picker offers both kinds

- [ ] **Step 13: Write the failing test**

Append to `test/proxmoxAssociation.test.js`:

```js
test('changing only the kind is a real mutation, not a no-op', () => {
  const current = { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' };
  // Same coordinates, different type: vmid 131 was recreated as a VM, and the
  // operator is re-linking to clear the mismatch. Comparing only hostId/node/
  // vmid would report "nothing changed" and silently skip the write.
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131, kind: 'qemu' }))
    .toEqual({ kind: 'link', link: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'qemu' } });
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' }))
    .toBeNull();
});
```

Note the outer `kind: 'link'` (the mutation discriminator) and the inner `link.kind` (the guest kind) are different fields that happen to share a name. Do not conflate them.

- [ ] **Step 14: Run and watch it fail**

Run: `npx vitest run test/proxmoxAssociation.test.js -t 'kind'`
Expected: FAIL — returns `null` for the qemu case.

- [ ] **Step 15: Update the module**

In `src/web/proxmoxAssociation.ts`:

```ts
import { pve, type PveGuestKind, type PveNodeGuest } from './proxmox';
import { kindLabel } from './proxmoxGuests';

type Draft = { mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number; kind: PveGuestKind };

export function associationMutation(current: PveBoxLink | undefined, draft: Draft) {
  if (draft.mode === 'unlinked') return current ? { kind: 'unlink' as const } : null;
  if (!draft.hostId || !draft.node || !Number.isInteger(draft.vmid) || draft.vmid < 100) throw new Error('select a Proxmox guest');
  if (current && current.hostId === draft.hostId && current.node === draft.node && current.vmid === draft.vmid && current.kind === draft.kind) return null;
  return { kind: 'link' as const, link: { hostId: draft.hostId, node: draft.node, vmid: draft.vmid, kind: draft.kind } };
}
```

The `<select>` element must now carry the kind per option, since vmid alone no longer identifies the draft. Encode it in the option value and parse it back:

```ts
  async function loadGuests(selected = 0) {
    const rows = await pve.nodeGuests(host.value, node.value);
    guest.replaceChildren(...rows.map((item: PveNodeGuest) => el('option', {
      value: `${item.kind}:${item.vmid}`,
      disabled: !!item.linkedBoxId && item.linkedBoxId !== box?.id,
    }, [`${item.vmid} | ${kindLabel(item.kind)} | ${item.name} | ${item.state}${item.linkedBoxId && item.linkedBoxId !== box?.id ? ' | linked' : ''}`])));
    if (selected) {
      const match = rows.find((item) => item.vmid === selected);
      if (match) guest.value = `${match.kind}:${match.vmid}`;
    }
    syncDraft();
  }
  const syncDraft = () => {
    const [kind, vmid] = guest.value.split(':');
    draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: Number(vmid), kind: kind === 'qemu' ? 'qemu' : 'lxc' };
  };
```

Rename the `container` select variable to `guest`, `loadContainers` to `loadGuests`, the field label from `'Container'` to `'Guest'`, and the button text from `'Link container'` to `'Link guest'`. In `renderSummary`, include the kind in the details line, and in `hydrateSummary` use `pve.nodeGuests`. Update the unlink confirm text from "The Proxmox container will not be stopped or destroyed" to "guest".

In the two places that rebuild the draft on `host`/`node` change (lines 61, 66), the draft literal needs a kind — use `'lxc'` as the placeholder, since `vmid: 0` already marks the draft incomplete and `syncDraft` overwrites both as soon as options load.

- [ ] **Step 16: Check the picker's own tests**

Run: `npx vitest run test/proxmoxAssociation.test.js`
Expected: PASS. Typecheck still fails in `dashboard.ts` / `main.ts` / `paneLifecycle.ts` — Part D closes them. **Do not commit yet.**

#### Part D — dashboard, sidebar and pane badges

Touches `src/web/dashboard.ts`, `src/web/main.ts`, `src/web/paneLifecycle.ts`. Check
whether either of `test/dashboard.test.js` / `test/paneLifecycle.test.js` exists with
`ls test/ | grep -i "dashboard\|paneLifecycle"`; extend whichever does. This part closes
the remaining typecheck errors and produces no new exports.

- [ ] **Step 17: Get the exact worklist**

Run: `npm run typecheck`
Every remaining error is a site where a renamed type or the new `'mismatch'` state is unhandled. Work the list top to bottom.

- [ ] **Step 18: Handle the new state wherever states are mapped**

Any `switch`/lookup over a guest state — in `dashboard.ts`'s lamp/mode helpers and `paneLifecycle.ts`'s `lifecycleKeysFor` — needs a `'mismatch'` arm. Treat it exactly as `'unknown'`: no lifecycle keys, and a neutral (not green) lamp. `paneLifecycle.ts`'s `lifecycleKeysFor` must return `[]`, matching Task 7's `actionsForState`.

- [ ] **Step 19: Render the CT/VM badge**

Wherever a box's Proxmox state is already shown from the status snapshot, add the kind label from `proxmoxKind`, guarding for absence (a box with no Proxmox link has none):

```ts
const kind = status?.proxmoxKind;
// ... render kindLabel(kind) only when kind is present
```

Read `DESIGN.md` before styling it — that document outranks ad-hoc styling decisions.

- [ ] **Step 20: Verify clean**

Run: `npm test`
Expected: PASS, including `npm run typecheck` which `npm test` runs first.

- [ ] **Step 21: Verify the rename left nothing behind**

```bash
grep -rn "linkedContainers\|nodeContainers\|listNodeContainers\|getLinkedContainers\|PveContainerState\|PveLinkedContainer\|PveNodeContainer\|renderContainersTab\|containerMatches\|pve-container\|proxmox/containers" src/ test/
```
Expected: **zero hits.**

- [ ] **Step 22: Commit — one commit for the whole web client**

Only now, with `npm test` green, does anything get committed. This is deliberately a
single commit: the type rename breaks every consumer at once, so any split would put
non-typechecking commits in history.

```bash
git add -A src/web test/proxmoxGuests.test.js test/proxmoxWebClient.test.js test/proxmoxAssociation.test.js
git status --short   # confirm the rename registered as R, not D+A
git commit -m "feat(ui): the Containers tab becomes the Guests tab

Web types take the guest spelling and carry the kind: PveContainerState ->
PveGuestState (gaining 'mismatch'), PveLinkedContainer -> PveLinkedGuest,
PveNodeContainer -> PveNodeGuest.

Rows carry a CT/VM badge, the filter matches it, and a 'mismatch' row explains
itself and offers Edit link instead of a dead end. Deprovision copy names the
grace period and says disks for a VM, volumes for a container.

The picker's options are keyed kind:vmid, because vmid alone no longer
identifies a draft, and a kind-only change now counts as a mutation — without
that, re-linking a box to a vmid that changed type would compare equal and
silently do nothing, leaving the operator stuck in the mismatch state with a
Save button that appears to work.

One commit rather than four: renaming the types breaks every consumer at once,
so a split would put three non-typechecking commits in history."
```

---

### Task 7: Documentation and live validation

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`
- Modify: `docs/superpowers/plans/2026-08-01-proxmox-vm-lifecycle.md` (check off completed steps)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update the architecture docs**

`CLAUDE.md` and `AGENTS.md` are kept in sync and both describe this subsystem. Update these entries:

- `proxmoxInventory.js` — say it covers both guest kinds, and state the mismatch rule and why it refuses rather than auto-follows.
- `proxmoxLifecycle.js` — mention `deprovisionGraceSec` and the PVE-side force-stop escalation, noting it applies to containers too.
- `proxmoxApi.js` — the kind-parameterized guest methods and the allowlist chokepoint.
- `proxmoxValidate.js` / `store.js` — the link's `kind` field and the read-time `'lxc'` default.
- The web-client paragraph — `proxmoxContainers.ts` → `proxmoxGuests.ts` and the Guests tab.

Keep the existing prose style: these files explain *why*, not just *what*.

- [ ] **Step 2: Update the user-facing README**

Add VM support to whatever section describes Proxmox lifecycle actions. State plainly that provisioning remains LXC-only, and that a VM needs ACPI support or the QEMU guest agent for graceful shutdown to work — otherwise `shutdown` fails on timeout and only `stop` or deprovision will stop it. Use placeholder hostnames only.

- [ ] **Step 3: Commit the docs**

```bash
git add CLAUDE.md AGENTS.md README.md docs/superpowers/plans/2026-08-01-proxmox-vm-lifecycle.md
git commit -m "docs: describe Proxmox VM lifecycle support"
```

- [ ] **Step 4: Build and deploy a candidate to the live app**

Per `CLAUDE.md`, features are validated on the live app **before** they merge. From this branch:

```bash
npm run build
rsync -a --delete dist/ /root/tmuxifier/dist/
```

Before restarting, confirm no job is in flight — a restart interrupts running setup, provision, lifecycle, fleet, and voice-install jobs:

```bash
curl -sk "$BASE/api/proxmox/lifecycle-jobs" | grep -c '"status":"running"'   # expect 0
```

Then `sudo systemctl restart tmuxifier` and verify a hashed asset end-to-end, not just `GET /` — asset routes are registered per file at boot, so a freshly swapped bundle otherwise falls through to the SPA fallback and the app renders blank:

```bash
curl -sk -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/assets/<hashed-file>.js"   # expect 200 text/javascript
```

- [ ] **Step 5: Verify in a real browser**

None of the following has automated coverage — Vitest has no DOM and the e2e fixture has no Proxmox host. Confirm each by eye:

The operator has provisioned two throwaway VMs for this: one **with** the QEMU guest agent
and one **without**. Use both — they exercise different shutdown paths.

1. The hub tab reads **Guests**, and linked containers still appear with a **CT** badge.
2. Both VMs appear with a **VM** badge and their correct state.
3. Typing `vm` in the filter narrows to VMs; `ct` narrows to containers.
4. The association picker lists both kinds, sorted by vmid, each labelled.
5. Start / Shutdown / Reboot on the **agent-equipped** VM each drive a job to `done`.
6. Start / Shutdown / Reboot on the **agentless** VM likewise. Note that a missing guest
   agent does *not* by itself mean a VM ignores shutdown: PVE sends an ACPI power-button
   event, and any OS running `acpid`/systemd handles it without an agent. Expect this VM
   to shut down normally, and treat that as the "no agent, plain ACPI" case rather than as
   the hang case.
7. The sidebar and standby dashboard show the CT/VM badge.
8. If you can produce one, a mismatched link shows the explanation and offers only **Edit link**.

- [ ] **Step 6: Verify the force-stop escalation actually fires**

The escalation only triggers on a guest that cannot respond to ACPI at all — not merely one
without the guest agent. To exercise it deliberately, catch a VM at its boot menu or BIOS
prompt (before any OS loads) and run deprovision against it there. Confirm in the job log
that PVE's shutdown task reports a forced stop after roughly `deprovisionGraceSec`, and that
the job proceeds to `destroy` rather than failing.

If that setup is impractical, record the escalation as covered by unit test only
(Task 4's `deprovision hands PVE the grace period and the force-stop flag`) and say so —
do not claim it was verified live.

- [ ] **Step 7: Validate deprovision on the throwaway VMs only**

**Deprovision is irreversible — it purges disks.** Run it only against the two VMs created
for this purpose, and confirm the target with the operator immediately before each run.
Never point this step at any other VM. Verify the job reaches `done`, the box is removed,
and — if the VM was on an `auto-static` preset — its NetBox address is released.

- [ ] **Step 8: Merge and ship**

Only after validation passes, follow the release checklist in `CLAUDE.md`: `npm version patch --no-git-tag-version`, `npm run build`, restart, health check, verify the lockfile versions match, review the staged diff for PII, commit, tag, push, and create the GitHub release.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: data model → Task 1; API client → Task 2; inventory (all six changes) → Task 3; lifecycle manager → Task 4; routes → Task 5; web types, guests tab, association picker, badges and mismatch handling, plus the CSS zero-hits grep → Task 6 (Parts A-D); docs, browser verification, and the deprovision safety rule → Task 7.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Three steps deliberately defer to inspection rather than prescribing content — Task 1 Step 5 (match the file's existing store helper name), Task 6 Step 17 (work the typecheck error list), and Task 6 Steps 10 and 19 (read `DESIGN.md` before choosing badge styling). Each names exactly what to inspect and what rule governs the choice; inventing colors here would contradict `DESIGN.md`'s authority.

**Type consistency.** `kindLabel` is defined in Task 6 Part B and consumed in Parts C-D under that name. `linkKind` (inventory, Task 3) and `jobKind` (lifecycle, Task 4) are separate module-local helpers with the same logic — deliberately not shared, since neither module imports the other today and a shared import would be the only coupling between them. `PveGuestKind` / `PveGuestState` / `PveLinkedGuest` / `PveNodeGuest` are defined in Task 6 and used consistently after. The mutation discriminator `{ kind: 'link' }` and the guest kind `link.kind` in Task 8 are flagged inline as distinct fields.

**One risk the plan does not eliminate.** Task 6 is large — four parts and one commit — because renaming the web types breaks every consumer simultaneously. The operator chose this over three non-typechecking commits. Its four parts each end in a green test gate, so a failure localizes even though the commit does not.
