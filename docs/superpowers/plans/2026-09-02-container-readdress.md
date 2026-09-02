# Container Re-address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked LXC container can be moved to a new NetBox-managed VLAN/IP from the Proxmox hub: the next free address is allocated from the chosen VLAN's NetBox prefix, written to the container's `net0` (live when running), the box re-pointed, and the old NetBox record released.

**Architecture:** A new `readdress` action inside the existing lifecycle job manager (`src/server/proxmoxLifecycle.js`), fed by four small additions in the modules that already own each concern: pure `net0` parse/rebuild in `proxmoxParams.js`, two PVE client methods in `proxmoxApi.js`, `listVlanPrefixes()` in `netboxApi.js`, and a single-write `readdressBox` in `store.js`. Two read-only routes feed a new dialog (`src/web/proxmoxReaddress.ts`) opened from the Guests tab's row actions.

**Tech Stack:** Node 20+ ESM server (Fastify), TypeScript web client bundled by Vite, vitest (`environment: 'node'`, no DOM), no mocks — dependency-injected fakes only.

**Spec:** `docs/superpowers/specs/2026-09-02-container-readdress-design.md`

## Global Constraints

- ESM everywhere; server is plain `.js`, web client is `.ts`. Node 20+.
- TDD: write the failing test first, run it red, implement, run it green, commit. Tests use real code and injected fakes, never mocking libraries.
- vitest runs with `environment: 'node'`: no DOM in unit tests. DOM code is exercised on the live app only.
- Conventional-commit messages (`feat(pve): …`, `test(pve): …`, `docs(pve): …`). Every commit ends with the session trailer lines in this repo's convention (see the system reminder at execution time).
- The public repo must never receive real PII: docs, tests and examples use `example.com`, RFC1918 addresses like `192.168.30.7`, `you@example.com`.
- **Never run `npm run build` in `/root/tmuxifier` (the main checkout) while the service is running** — the service serves that `dist/` with boot-registered asset routes and goes blank until restart. Do all work in a git worktree (superpowers:using-git-worktrees); `npm run typecheck` and `npm test` are safe anywhere.
- Test commands: `npx vitest run test/<file>.test.js` for one file, `npm run typecheck` for the TS client, `npm test` for everything (typecheck + unit + integration).
- Out of scope, do not build: VMs, changing the bridge, IPv6 rewriting, moving to `static`/`dhcp` mode, renaming.

---

## File map

| File | Responsibility in this feature |
|---|---|
| `src/server/proxmoxParams.js` | Pure `parseNet0` / `net0Field` / `describeNet0` / `buildNet0Readdress` |
| `src/server/proxmoxApi.js` | `guestConfig(kind, node, vmid)`, `setLxcConfig(node, vmid, params)` |
| `src/server/netboxApi.js` | `listVlanPrefixes()` |
| `src/server/proxmoxValidate.js` | `isDnsLabel(s)` export |
| `src/server/store.js` | `readdressBox(id, { host, netboxIpId })`, `uniquenessConflict(candidate, ignoreId)` |
| `src/server/proxmoxLifecycle.js` | The `readdress` action: guards, phases, release rules, boot reconcile, hooks |
| `src/server/server.js` | `GET /api/boxes/:id/proxmox/net`, `GET /api/netbox/vlans` |
| `src/server/index.js` | Wires `setupRunning` and `onReaddress` into the lifecycle manager |
| `src/web/proxmox.ts` | `'readdress'` action, `PveGuestNet`, `pve.guestNet`, `vlan` on `createLifecycleJob` |
| `src/web/netbox.ts` | `NetboxVlan`, `NetboxVlans`, `nbx.vlans()` |
| `src/web/proxmoxGuests.ts` | Eligibility (`actionsForGuest` gains `readdress` for LXC), the Re-address button |
| `src/web/proxmoxReaddress.ts` | The dialog: pure `vlanOptionLabel` / `currentNetLine` + DOM half |
| `src/web/style.css` | `.pve-readdress-modal` width |
| `docs/proxmox.md`, `README.md`, `CLAUDE.md`, `AGENTS.md` | Docs |

---

### Task 1: Pure `net0` parsing and rebuilding

**Files:**
- Modify: `src/server/proxmoxParams.js`
- Test: `test/proxmoxParams.test.js`

**Interfaces:**
- Consumes: `isCidr`, `isIp` from `src/server/proxmoxValidate.js` (existing exports).
- Produces:
  - `parseNet0(str: string): [string, string][]` — ordered key/value pairs; throws on empty or a token without `=`.
  - `net0Field(pairs, key): string | null`.
  - `describeNet0(pairs): { bridge: string|null, vlan: number|null, ip: string|null, gateway: string|null }` — `ip` is null unless a valid IPv4 CIDR (so `dhcp`/`manual` read as null); `gateway` null unless a valid IPv4.
  - `buildNet0Readdress(pairs, { vlan: number, ip: string, gateway: string }): string` — rewrites only `tag`/`ip`/`gw` in place, appends any that were absent.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxParams.test.js`:

```js
import { parseNet0, net0Field, describeNet0, buildNet0Readdress } from '../src/server/proxmoxParams.js';

const LINE = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.20.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.20.5/24,ip6=fd00::5/64,gw6=fd00::1,tag=20,type=veth';

test('parseNet0 keeps every pair in order and rejects what PVE never writes', () => {
  expect(parseNet0(LINE).map(([k]) => k)).toEqual(['name', 'bridge', 'firewall', 'gw', 'hwaddr', 'ip', 'ip6', 'gw6', 'tag', 'type']);
  expect(net0Field(parseNet0(LINE), 'hwaddr')).toBe('BC:24:11:AA:BB:CC');
  expect(net0Field(parseNet0(LINE), 'rate')).toBeNull();
  expect(() => parseNet0('')).toThrow(/empty/);
  expect(() => parseNet0('name=eth0,garbage')).toThrow(/unparseable/);
});

test('buildNet0Readdress rewrites only tag/ip/gw, in place, keeping hwaddr and IPv6 verbatim', () => {
  expect(buildNet0Readdress(parseNet0(LINE), { vlan: 30, ip: '192.168.30.7/24', gateway: '192.168.30.1' }))
    .toBe('name=eth0,bridge=vmbr0,firewall=1,gw=192.168.30.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.30.7/24,ip6=fd00::5/64,gw6=fd00::1,tag=30,type=veth');
});

test('buildNet0Readdress appends the managed keys an untagged dhcp interface lacks', () => {
  const pairs = parseNet0('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth');
  expect(buildNet0Readdress(pairs, { vlan: 30, ip: '192.168.30.7/24', gateway: '192.168.30.1' }))
    .toBe('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.30.7/24,type=veth,tag=30,gw=192.168.30.1');
});

test('describeNet0 reads the IPv4 view and nulls dhcp/absent fields', () => {
  expect(describeNet0(parseNet0(LINE))).toEqual({ bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' });
  expect(describeNet0(parseNet0('name=eth0,bridge=vmbr0,ip=dhcp'))).toEqual({ bridge: 'vmbr0', vlan: null, ip: null, gateway: null });
  expect(describeNet0(parseNet0('name=eth0,bridge=vmbr1,ip=manual,tag=abc,gw=nope'))).toEqual({ bridge: 'vmbr1', vlan: null, ip: null, gateway: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/proxmoxParams.test.js`
Expected: FAIL — `parseNet0` is not exported.

- [ ] **Step 3: Implement**

Add at the top of `src/server/proxmoxParams.js`:

```js
import { isCidr, isIp } from './proxmoxValidate.js';
```

Append to the file:

```js
// --- net0 as PVE reports it (the re-address job's input) ---
// PVE emits `key=value` tokens joined by commas and never quotes a value, so a
// plain split is exact. A token without `=` is not something PVE writes and is
// rejected rather than guessed at. Order is preserved so the rebuilt string
// differs from the original only where this feature means it to.
export function parseNet0(str) {
  const s = String(str || '').trim();
  if (!s) throw new Error('net0 is empty');
  return s.split(',').map((token) => {
    const i = token.indexOf('=');
    if (i <= 0) throw new Error(`unparseable net0 token: ${JSON.stringify(token)}`);
    return [token.slice(0, i), token.slice(i + 1)];
  });
}

export function net0Field(pairs, key) {
  const hit = pairs.find(([k]) => k === key);
  return hit ? hit[1] : null;
}

// The IPv4 view the dialog shows and the job records. `ip=dhcp`/`ip=manual`
// read as null: the interface has no static address for the job to "move".
export function describeNet0(pairs) {
  const ip = net0Field(pairs, 'ip');
  const gw = net0Field(pairs, 'gw');
  const tag = net0Field(pairs, 'tag');
  return {
    bridge: net0Field(pairs, 'bridge'),
    vlan: tag != null && /^\d{1,4}$/.test(tag) ? Number(tag) : null,
    ip: ip && isCidr(ip) ? ip : null,
    gateway: gw && isIp(gw) ? gw : null,
  };
}

// Rewrite only tag/ip/gw; every other pair keeps its position and value
// (hwaddr, bridge, firewall, mtu, rate, ip6, gw6, …), so the MAC and bridge
// never change and IPv6 is untouched. A managed key that is absent is
// appended, so a previously untagged interface gains its tag.
export function buildNet0Readdress(pairs, { vlan, ip, gateway }) {
  const managed = new Map([['tag', String(vlan)], ['ip', ip], ['gw', gateway]]);
  const out = [];
  for (const [k, v] of pairs) {
    if (managed.has(k)) { out.push(`${k}=${managed.get(k)}`); managed.delete(k); }
    else out.push(`${k}=${v}`);
  }
  for (const [k, v] of managed) out.push(`${k}=${v}`);
  return out.join(',');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxParams.test.js`
Expected: PASS (all, including the pre-existing `buildNet0`/`buildCreateParams` tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxParams.js test/proxmoxParams.test.js
git commit -m "feat(pve): parse and rebuild net0 for re-addressing (tag/ip/gw only)"
```

---

### Task 2: PVE client — read a guest config, write an LXC config

**Files:**
- Modify: `src/server/proxmoxApi.js` (the returned object, after `lxcInterfaces`)
- Test: `test/proxmoxApi.test.js`

**Interfaces:**
- Produces:
  - `client.guestConfig(kind, node, vmid): Promise<object>` — the PVE config object (`{ hostname, net0, … }`); rejects on an invalid kind.
  - `client.setLxcConfig(node, vmid, params): Promise<null>` — `PUT /nodes/{node}/lxc/{vmid}/config`, form-encoded body, resolves when PVE has applied it (synchronous for containers; hot-applies to a running guest).

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxApi.test.js`:

```js
test('guestConfig GETs the kind-qualified config path and re-validates the kind before any request', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: { hostname: 'dev-01', net0: 'name=eth0,bridge=vmbr0,ip=dhcp' } } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  await expect(client.guestConfig('lxc', 'pve', 131)).resolves.toMatchObject({ hostname: 'dev-01' });
  expect(request.calls[0].method).toBe('GET');
  expect(request.calls[0].url).toBe('https://pve.example.com:8006/api2/json/nodes/pve/lxc/131/config');
  await expect(client.guestConfig('disk', 'pve', 131)).rejects.toThrow(/invalid proxmox guest kind/);
  expect(request.calls).toHaveLength(1);
});

test('setLxcConfig PUTs a form-encoded body to the lxc config path', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: null } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  await expect(client.setLxcConfig('pve', 131, { net0: 'name=eth0,bridge=vmbr0,ip=192.168.30.7/24,gw=192.168.30.1,tag=30' })).resolves.toBeNull();
  const call = request.calls[0];
  expect(call.method).toBe('PUT');
  expect(call.url).toBe('https://pve.example.com:8006/api2/json/nodes/pve/lxc/131/config');
  expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(call.body).toBe('net0=name%3Deth0%2Cbridge%3Dvmbr0%2Cip%3D192.168.30.7%2F24%2Cgw%3D192.168.30.1%2Ctag%3D30');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/proxmoxApi.test.js`
Expected: FAIL — `client.guestConfig is not a function`.

- [ ] **Step 3: Implement**

In `src/server/proxmoxApi.js`, inside the returned object, after the `lxcInterfaces` line add:

```js
    // The guest's config as PVE holds it — for a container, the `net0` line is
    // the only record of which VLAN/address it is on (boxes.json stores
    // neither). Kind is a URL segment, so it is re-validated here like every
    // other kind-parameterized method; async for the same reason they are.
    guestConfig: async (kind, node, vmid) => call('GET', `/nodes/${enc(node)}/${guestKind(kind)}/${enc(vmid)}/config`),
    // PUT config is synchronous for containers (no UPID comes back) and PVE
    // hot-applies a net change to a running guest. LXC-only like createLxc:
    // re-addressing a VM would need cloud-init, which is out of scope.
    setLxcConfig: (node, vmid, params) => call('PUT', `/nodes/${enc(node)}/lxc/${enc(vmid)}/config`, params),
```

`call()` already form-encodes the body for any method other than GET/DELETE, so PUT needs nothing else.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxApi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxApi.js test/proxmoxApi.test.js
git commit -m "feat(pve): guestConfig and setLxcConfig client methods"
```

---

### Task 3: NetBox client — `listVlanPrefixes()`

**Files:**
- Modify: `src/server/netboxApi.js` (inside the object `createNetboxClient` returns, after `listPrefixes`)
- Test: `test/netboxApi.test.js`

**Interfaces:**
- Produces: `client.listVlanPrefixes(): Promise<Array<{ vid: number, name: string, prefix: string, allocatable: boolean, reason?: string }>>`, sorted by `vid`. Only IPv4 prefixes that carry a VLAN. A VLAN with more than one prefix is `allocatable: false` with `reason: 'VLAN <vid> maps to <n> NetBox prefixes'`.

- [ ] **Step 1: Write the failing test**

Append to `test/netboxApi.test.js`:

```js
test('listVlanPrefixes lists v4 prefixes by VLAN, marks a two-prefix VLAN non-allocatable, skips v6 and VLAN-less', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => {
    calls.push(o);
    return { status: 200, json: { results: [
      { id: 2, prefix: '192.168.40.0/24', vlan: { id: 6, vid: 40, name: 'lab' } },
      { id: 1, prefix: '192.168.30.0/24', vlan: { id: 5, vid: 30, name: 'servers' } },
      { id: 3, prefix: '192.168.41.0/24', vlan: { id: 6, vid: 40, name: 'lab' } },
      { id: 4, prefix: 'fd00:30::/64', vlan: { id: 5, vid: 30, name: 'servers' } },
      { id: 5, prefix: '10.0.0.0/8', vlan: null },
      { id: 6, prefix: '192.168.50.0/24', vlan: { id: 7, vid: 50, name: null } },
    ] }, text: '' };
  } });
  await expect(client.listVlanPrefixes()).resolves.toEqual([
    { vid: 30, name: 'servers', prefix: '192.168.30.0/24', allocatable: true },
    { vid: 40, name: 'lab', prefix: '192.168.40.0/24', allocatable: false, reason: 'VLAN 40 maps to 2 NetBox prefixes' },
    { vid: 50, name: '', prefix: '192.168.50.0/24', allocatable: true },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/?limit=100');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/netboxApi.test.js`
Expected: FAIL — `client.listVlanPrefixes is not a function`.

- [ ] **Step 3: Implement**

In `src/server/netboxApi.js`, inside the returned object after `listPrefixes`, add:

```js
    // The re-address picker's source: every IPv4 prefix NetBox knows that
    // carries a VLAN, from the same bounded page listPrefixes reads. A VLAN
    // with more than one prefix is listed but not allocatable — the rule
    // findPrefixByVlan enforces at allocation time, surfaced up front so the
    // picker can say why rather than failing a job later. The name is
    // NetBox-side content that reaches the UI; it is trimmed and capped.
    async listVlanPrefixes() {
      const data = await call('GET', '/ipam/prefixes/?limit=100');
      const byVid = new Map();
      for (const rec of (data && data.results) || []) {
        const vid = rec && rec.vlan ? Number(rec.vlan.vid) : NaN;
        if (!Number.isInteger(vid) || vid < 1 || vid > 4094) continue;
        if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(String(rec.prefix))) continue; // v4 only
        const name = typeof rec.vlan.name === 'string' ? rec.vlan.name.trim().slice(0, 64) : '';
        const entry = byVid.get(vid) || { vid, name, prefix: String(rec.prefix), count: 0 };
        entry.count += 1;
        byVid.set(vid, entry);
      }
      return [...byVid.values()].sort((a, b) => a.vid - b.vid).map(({ count, ...entry }) => (
        count === 1 ? { ...entry, allocatable: true } : { ...entry, allocatable: false, reason: `VLAN ${entry.vid} maps to ${count} NetBox prefixes` }
      ));
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/netboxApi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "feat(netbox): listVlanPrefixes for the re-address picker"
```

---

### Task 4: Store — `readdressBox` and `uniquenessConflict(candidate, ignoreId)`

**Files:**
- Modify: `src/server/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces:
  - `store.readdressBox(id, { host: string, netboxIpId: number }): Promise<Box>` — one serialized write setting `host` and `proxmox.netboxIpId`; throws `box requires a host`, `netboxIpId must be a positive integer`, `box not found`, `box is not linked to Proxmox`, or the `assertUniqueBox`/`assertBoxSafe` messages.
  - `store.uniquenessConflict(candidate, ignoreId?)` — existing method, gains the optional `ignoreId` `assertUniqueBox` already supports.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.js`:

```js
const LINK = { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc', endpoint: 'pve.example.com:8006', netboxIpId: 99 };

test('readdressBox writes host and the link allocation id together, keeping the rest of the box and link', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.20.5', label: 'dev-01', user: 'root', proxmox: LINK }, { trustedProxmox: true });
  const updated = await store.readdressBox(box.id, { host: '192.168.30.7', netboxIpId: 120 });
  expect(updated.host).toBe('192.168.30.7');
  expect(updated.proxmox).toEqual({ ...LINK, netboxIpId: 120 });
  expect(updated).toMatchObject({ id: box.id, label: 'dev-01', user: 'root', source: 'proxmox' });
  expect((await store.getBox(box.id)).host).toBe('192.168.30.7');
});

test('readdressBox refuses a taken host, an unlinked box, an unknown id, and a bad allocation id — and changes nothing', async () => {
  const store = createStore({ dataDir: dir });
  await store.addBox({ host: '192.168.30.7', label: 'other' });
  const linked = await store.addBox({ host: '192.168.20.5', label: 'dev-01', proxmox: LINK }, { trustedProxmox: true });
  const plain = await store.addBox({ host: '192.168.20.6', label: 'plain' });
  await expect(store.readdressBox(linked.id, { host: '192.168.30.7', netboxIpId: 120 })).rejects.toThrow(/host already exists/);
  await expect(store.readdressBox(plain.id, { host: '192.168.30.8', netboxIpId: 120 })).rejects.toThrow(/not linked/);
  await expect(store.readdressBox('nope', { host: '192.168.30.8', netboxIpId: 120 })).rejects.toThrow(/not found/);
  await expect(store.readdressBox(linked.id, { host: '192.168.30.8', netboxIpId: null })).rejects.toThrow(/netboxIpId/);
  await expect(store.readdressBox(linked.id, { host: '', netboxIpId: 120 })).rejects.toThrow(/host/);
  expect((await store.getBox(linked.id))).toMatchObject({ host: '192.168.20.5', proxmox: LINK });
});

test('uniquenessConflict can ignore the box being re-addressed', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.30.7', label: 'dev-01' });
  expect(await store.uniquenessConflict({ host: '192.168.30.7' })).toMatch(/host already exists/);
  expect(await store.uniquenessConflict({ host: '192.168.30.7' }, box.id)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/store.test.js`
Expected: FAIL — `store.readdressBox is not a function`, and the ignore test fails because the second call still reports a conflict.

- [ ] **Step 3: Implement**

In `src/server/store.js`, change `uniquenessConflict`:

```js
    async uniquenessConflict(candidate, ignoreId) {
      try { assertUniqueBox(await readAll(), candidate, ignoreId); } catch (e) { return e.message; }
      return null;
    },
```

Add after `clearProxmoxLink`:

```js
    // The re-address job's one write: the new host and the new NetBox
    // allocation land together, or not at all. Two writes (updateBox for the
    // host, then setProxmoxLink for the id) would leave a window in which the
    // box points at the new address while its link still claims the old
    // allocation — exactly the state the lifecycle manager's boot reconcile
    // cannot tell from a leaked id. Every other field and link key is kept as
    // it was; the same assertBoxSafe/assertUniqueBox checks as every other
    // mutation apply. A null id is refused: this feature always allocates.
    async readdressBox(id, { host, netboxIpId } = {}) {
      if (typeof host !== 'string' || !host) throw new Error('box requires a host');
      if (!Number.isInteger(netboxIpId) || netboxIpId <= 0) throw new Error('netboxIpId must be a positive integer');
      return serialize(async () => {
        const boxes = await readAll();
        const index = boxes.findIndex((box) => box.id === id);
        if (index === -1) throw new Error('box not found');
        if (!boxes[index].proxmox) throw new Error('box is not linked to Proxmox');
        boxes[index] = { ...boxes[index], host, proxmox: { ...boxes[index].proxmox, netboxIpId } };
        assertBoxSafe(boxes[index]);
        assertUniqueBox(boxes, boxes[index], id);
        await writeAll(boxes);
        return boxes[index];
      });
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/store.js test/store.test.js
git commit -m "feat(store): readdressBox single write; uniquenessConflict ignoreId"
```

---

### Task 5: The `readdress` lifecycle action

**Files:**
- Modify: `src/server/proxmoxValidate.js` (one export)
- Modify: `src/server/proxmoxLifecycle.js`
- Test: `test/proxmoxValidate.test.js`, `test/proxmoxLifecycle.test.js`

**Interfaces:**
- Consumes: Task 1 (`parseNet0`, `describeNet0`, `buildNet0Readdress`), Task 2 (`client.guestConfig`, `client.setLxcConfig`), Task 4 (`boxStore.readdressBox`, `boxStore.uniquenessConflict(candidate, ignoreId)`), existing `netbox.findPrefixByVlan/allocateIp/releaseIp/findIpsByAddress`.
- Produces:
  - `createProxmoxLifecycleManager` gains two options: `setupRunning: (boxId) => boolean` (default `() => false`) and `onReaddress: ({ before, after }) => void|Promise` (default `null`).
  - `createJob({ boxId, action: 'readdress', vlan })` — `vlan` integer 1..4094 (400 otherwise; 400 when present on any other action); 409 for a `qemu` link, template, mismatch, state not running/stopped, active job, or `setupRunning(boxId)`; 400 when NetBox is not configured.
  - Job record fields for this action: `vlan, oldIp, oldVlan, oldNetboxIpId, hostname, ip, gateway, netboxIpId`. Phases: `resolve → inspect → allocate-ip → apply → relink → release → verify → done`.
  - `manager._reconciled(): Promise` for tests (the boot orphan release).
  - `isDnsLabel(s): boolean` exported from `proxmoxValidate.js`.

- [ ] **Step 1: Write the failing validator test**

Append to `test/proxmoxValidate.test.js`:

```js
import { isDnsLabel } from '../src/server/proxmoxValidate.js';

test('isDnsLabel accepts a hostname label and rejects underscores, dots, and blanks', () => {
  expect(isDnsLabel('dev-01')).toBe(true);
  expect(isDnsLabel('DEV01')).toBe(true);
  expect(isDnsLabel('dev_01')).toBe(false);
  expect(isDnsLabel('dev.example')).toBe(false);
  expect(isDnsLabel('')).toBe(false);
  expect(isDnsLabel(null)).toBe(false);
});
```

Add to `src/server/proxmoxValidate.js`, right after the `isCidr` function:

```js
// One DNS label (a hostname, no dots) — what provisioning demands of a typed
// hostname and what the re-address job demands of a PVE-reported one before
// it becomes a NetBox dns_name.
export function isDnsLabel(s) { return DNS_LABEL.test(String(s || '')); }
```

Run: `npx vitest run test/proxmoxValidate.test.js` — expected PASS.

- [ ] **Step 2: Write the failing lifecycle tests**

Append to the END of `test/proxmoxLifecycle.test.js` (after the last existing test — the `nbSettings` constant it uses is defined mid-file):

```js
// ---------------------------------------------------------------------------
// readdress: move a linked container to a new NetBox-managed VLAN/IP
// ---------------------------------------------------------------------------
const NET0 = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.1.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/24,tag=10,type=veth';
const NET0_AFTER = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.30.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.30.7/24,tag=30,type=veth';

function readdressFixture(state = 'running', overrides = {}, { net0 = NET0, hostname = 'dev-01', netboxIpId = 99 } = {}) {
  const calls = [];
  const forgets = [];
  let stored = { ...BOX, proxmox: { ...BOX.proxmox, ...(netboxIpId == null ? {} : { netboxIpId }) } };
  const client = {
    guestConfig: async (kind, node, vmid) => { calls.push(`config:${kind}:${node}:${vmid}`); return { hostname, ...(net0 == null ? {} : { net0 }) }; },
    setLxcConfig: async (node, vmid, params) => { calls.push(`set:${node}:${vmid}:${params.net0}`); return null; },
  };
  const netbox = {
    findPrefixByVlan: async (vid) => { calls.push(`prefix:${vid}`); return { id: 7, prefix: '192.168.30.0/24' }; },
    allocateIp: async (prefix, fields) => { calls.push(['allocate', prefix.prefix, fields]); return { id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }; },
    findIpsByAddress: async (ip) => { calls.push(`lookup:${ip}`); return []; },
    releaseIp: async (id) => { calls.push(`release:${id}`); },
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: {
      getBox: async (id) => id === 'B1' ? stored : undefined,
      uniquenessConflict: async ({ host }, ignoreId) => { calls.push(`unique:${host}:${ignoreId}`); return null; },
      readdressBox: async (id, { host, netboxIpId: nid }) => { calls.push(`relink:${host}:${nid}`); stored = { ...stored, host, proxmox: { ...stored.proxmox, netboxIpId: nid } }; return stored; },
    },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
    makeClient: () => client,
    netboxStore: { getSettings: async () => ({ ...nbSettings, dnsSuffix: 'lan.example.com' }) },
    makeNetboxClient: () => netbox,
    knownHosts: { forget: async (host, port) => { forgets.push([host, port]); return []; } },
    onReaddress: async ({ before, after }) => { calls.push(`hook:${before.host}->${after.host}`); },
    onContainerUp: (boxId) => { calls.push(`up:${boxId}`); },
    load: () => [], save: () => {}, sleep: async () => {}, pollMs: 0,
    now: () => '2026-09-02T00:00:00.000Z', makeId: () => 'J1',
    removeLinkedBox: async () => {},
    ...overrides,
  });
  return { manager, calls, forgets, getStored: () => stored, client, netbox };
}

test('readdress on a running container: inspect, allocate, apply, relink, release old, forget both keys, fire hooks — in that order', async () => {
  const { manager, calls, forgets, getStored } = readdressFixture('running');
  const summary = await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  expect(summary).toMatchObject({ id: 'J1', action: 'readdress', status: 'running', boxId: 'B1', kind: 'lxc' });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({
    status: 'done', phase: 'done', error: null, vlan: 30,
    oldIp: '192.168.1.10/24', oldVlan: 10, oldNetboxIpId: 99, hostname: 'dev-01',
    ip: '192.168.30.7/24', gateway: '192.168.30.1', netboxIpId: 120,
  });
  expect(calls).toEqual([
    'config:lxc:pve:131',
    'prefix:30',
    ['allocate', '192.168.30.0/24', { status: 'active', description: 'tmuxifier: dev-01', dns_name: 'dev-01.lan.example.com' }],
    'unique:192.168.30.7:B1',
    `set:pve:131:${NET0_AFTER}`,
    'relink:192.168.30.7:120',
    'release:99',
    'lookup:192.168.1.10',
    'hook:192.168.1.10->192.168.30.7',
    'up:B1',
  ]);
  expect(forgets).toEqual([['192.168.30.7', undefined], ['192.168.1.10', undefined]]);
  expect(getStored().host).toBe('192.168.30.7');
  expect(job.log).toContain(`# before: ${NET0}`);
  expect(job.log).toContain('allocated 192.168.30.7/24 from 192.168.30.0/24 (gw 192.168.30.1, NetBox ip 120)');
  expect(job.log).toContain('released NetBox ip 99');
});

test('readdress on a stopped container does the same work but never signals container-up', async () => {
  const { manager, calls } = readdressFixture('stopped');
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(manager.getJob('J1').status).toBe('done');
  expect(calls).not.toContain('up:B1');
  expect(calls).toContain('hook:192.168.1.10->192.168.30.7');
});

test('readdress of a dhcp, hand-linked container: no old id, old address swept from the box host', async () => {
  const { manager, calls } = readdressFixture('running', {
    makeNetboxClient: () => ({
      findPrefixByVlan: async () => ({ id: 7, prefix: '192.168.30.0/24' }),
      allocateIp: async () => ({ id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }),
      findIpsByAddress: async (ip) => { calls.push(`lookup:${ip}`); return [{ id: 42, address: '192.168.1.10/32' }]; },
      releaseIp: async (id) => { calls.push(`release:${id}`); },
    }),
  }, { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth', netboxIpId: null });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'done', oldIp: null, oldVlan: null, oldNetboxIpId: null, netboxIpId: 120 });
  expect(calls).toContain('set:pve:131:name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.30.7/24,type=veth,tag=30,gw=192.168.30.1');
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:42']);
  expect(calls).toContain('lookup:192.168.1.10');
});

test('readdress uses the box label and no dns_name when the PVE hostname is not a DNS label', async () => {
  const { manager, calls } = readdressFixture('running', {}, { hostname: 'bad_host' });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(calls).toContainEqual(['allocate', '192.168.30.0/24', { status: 'active', description: 'tmuxifier: dev-01' }]);
});

test('readdress refusals create no job: VM link, template, missing state, setup running, bad vlan, vlan on a power action, NetBox unconfigured', async () => {
  const qemu = readdressFixture('running', {
    boxStore: { getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, kind: 'qemu' } }) },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state: 'running', node: 'pve', vmid: 131, kind: 'qemu' }) },
  });
  await expect(qemu.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /containers only/ });
  const template = readdressFixture('stopped', { inventory: { refreshBox: async () => ({ boxId: 'B1', state: 'stopped', node: 'pve', vmid: 131, kind: 'lxc', template: true }) } });
  await expect(template.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409 });
  const missing = readdressFixture('missing');
  await expect(missing.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /cannot run from missing/ });
  const setup = readdressFixture('running', { setupRunning: () => true });
  await expect(setup.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /setup/ });
  const ok = readdressFixture('running');
  for (const vlan of [undefined, 0, 4095, '30', 30.5]) {
    await expect(ok.manager.createJob({ boxId: 'B1', action: 'readdress', vlan })).rejects.toMatchObject({ statusCode: 400, message: /vlan/ });
  }
  await expect(ok.manager.createJob({ boxId: 'B1', action: 'shutdown', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /vlan/ });
  const noNetbox = readdressFixture('running', { netboxStore: null });
  await expect(noNetbox.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /NetBox/ });
  const unconfigured = readdressFixture('running', { netboxStore: { getSettings: async () => null } });
  await expect(unconfigured.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /NetBox/ });
  for (const f of [qemu, template, missing, setup, ok, noNetbox, unconfigured]) expect(f.manager.listJobs()).toEqual([]);
});

test('readdress fails before any NetBox call when the container has no net0', async () => {
  const { manager, calls } = readdressFixture('running', {}, { net0: null });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(manager.getJob('J1')).toMatchObject({ status: 'error', phase: 'inspect', error: /net0/ });
  expect(calls).toEqual(['config:lxc:pve:131']);
});

test('a uniqueness conflict on the new address fails the job and releases the fresh allocation, touching neither PVE nor the old record', async () => {
  const { manager, calls, getStored } = readdressFixture('running', {
    boxStore: {
      getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, netboxIpId: 99 } }),
      uniquenessConflict: async () => 'box host already exists',
      readdressBox: async () => { throw new Error('must not be called'); },
    },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'error', phase: 'allocate-ip', error: /host already exists/, netboxIpId: null });
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('set:'))).toEqual([]);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:120']);
  expect(job.log).toContain('released NetBox ip 120 (unused allocation)');
  expect(getStored().host).toBe('192.168.1.10');
});

test('an apply failure releases the fresh allocation and leaves the old record and the box untouched', async () => {
  const { manager, calls, getStored } = readdressFixture('running', {
    makeClient: () => ({
      guestConfig: async () => ({ hostname: 'dev-01', net0: NET0 }),
      setLxcConfig: async () => { throw new Error('hotplug failed'); },
    }),
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'error', phase: 'apply', error: 'hotplug failed', netboxIpId: null });
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:120']);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('relink:'))).toEqual([]);
  expect(getStored().host).toBe('192.168.1.10');
});

test('a relink failure after the container moved names both addresses and releases nothing', async () => {
  const { manager, calls } = readdressFixture('running', {
    boxStore: {
      getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, netboxIpId: 99 } }),
      uniquenessConflict: async () => null,
      readdressBox: async () => { throw new Error('disk write failed'); },
    },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job.status).toBe('error');
  expect(job.phase).toBe('relink');
  expect(job.error).toContain('192.168.30.7');
  expect(job.error).toContain('192.168.1.10');
  expect(job.error).toContain('disk write failed');
  expect(job.netboxIpId).toBe(120);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual([]);
});

test('a failing old-record release or a throwing hook never fails a readdress job', async () => {
  const { manager } = readdressFixture('running', {
    makeNetboxClient: () => ({
      findPrefixByVlan: async () => ({ id: 7, prefix: '192.168.30.0/24' }),
      allocateIp: async () => ({ id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }),
      findIpsByAddress: async () => { throw new Error('netbox down'); },
      releaseIp: async () => { throw new Error('netbox down'); },
    }),
    onReaddress: async () => { throw new Error('exitMaster exploded'); },
    knownHosts: { forget: async () => { throw new Error('ssh-keygen missing'); } },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'done', phase: 'done', netboxIpId: 120 });
  expect(job.log).toContain('could not release NetBox ip 99: netbox down');
});

test('boot reconcile releases an allocation interrupted at allocate-ip and only logs one interrupted at apply or later', async () => {
  const released = [];
  const { manager } = readdressFixture('running', {
    load: () => [
      { id: 'A', action: 'readdress', boxId: 'B1', status: 'running', phase: 'allocate-ip', netboxIpId: 120, log: '', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'B', action: 'readdress', boxId: 'B1', status: 'running', phase: 'apply', netboxIpId: 121, log: '', createdAt: '2026-09-01T00:00:01Z' },
      { id: 'C', action: 'readdress', boxId: 'B1', status: 'running', phase: 'inspect', netboxIpId: null, log: '', createdAt: '2026-09-01T00:00:02Z' },
    ],
    makeNetboxClient: () => ({ releaseIp: async (id) => { released.push(id); } }),
  });
  await manager._reconciled();
  expect(released).toEqual([120]);
  expect(manager.getJob('A')).toMatchObject({ status: 'interrupted', netboxIpId: null });
  expect(manager.getJob('A').log).toContain('released NetBox ip 120');
  expect(manager.getJob('B')).toMatchObject({ status: 'interrupted', netboxIpId: 121 });
  expect(manager.getJob('B').log).toContain('NetBox ip 121 may be in use');
  expect(manager.getJob('C')).toMatchObject({ status: 'interrupted', netboxIpId: null });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: the new tests FAIL (`invalid lifecycle action` 400s, missing `_reconciled`); every pre-existing test still PASSES.

- [ ] **Step 4: Implement**

Edit `src/server/proxmoxLifecycle.js`. Imports and constants at the top become:

```js
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createNetboxClient } from './netboxApi.js';
import { newestFirst } from './jobOrder.js';
import { pollPveTask } from './pveTask.js';
import { parseNet0, describeNet0, buildNet0Readdress } from './proxmoxParams.js';
import { isCidr, isIp, isDnsLabel } from './proxmoxValidate.js';

const ACTIONS = new Set(['start', 'shutdown', 'stop', 'reboot', 'deprovision', 'readdress']);
const TERMINAL = new Set(['done', 'error', 'interrupted']);
const REQUIRED = { start: 'stopped', shutdown: 'running', stop: 'running', reboot: 'running' };
const jobKind = (link) => (link && link.kind === 'qemu' ? 'qemu' : 'lxc');
const targetKey = (link) => `${link.hostId} ${link.node} ${Number(link.vmid)}`;
const serviceError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
// The only client-supplied value this action sends anywhere: a NetBox filter
// and, via buildNet0Readdress, a PVE `tag=`. Integers only — a numeric string
// from a hand-built request is refused rather than coerced.
const parseVlan = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 4094) throw serviceError(400, 'vlan must be an integer 1..4094');
  return value;
};
const NETBOX_REQUIRED = 'readdress requires the NetBox integration — configure it in Settings (⚙)';
```

Add the two new options to the factory signature (after `netboxStore = null, makeNetboxClient = createNetboxClient,`):

```js
  // Refuses a readdress while a setup job streams over the SSH master the job
  // is about to sever. Wired in index.js to setupManager.currentForBox.
  setupRunning = () => false,
  // Fired once the box points at its new address: index.js exits the old
  // ControlMaster, closes the box's terminal group so viewers reconnect at the
  // new host, and resets the status backoff. Best-effort, never awaited into
  // the job's success (see runReaddress).
  onReaddress = null,
```

Replace the load loop so it collects orphaned and chaseable readdress jobs (keep the existing comments):

```js
  const jobs = new Map();
  const settles = new Map();
  const orphaned = []; // readdress jobs interrupted at allocate-ip: a reservation nothing else can reclaim
  const chaseable = []; // readdress jobs interrupted at apply or later: PVE may or may not have written the config
  for (const job of load() || []) {
    if (!job || typeof job !== 'object' || typeof job.id !== 'string') continue;
    job.kind = jobKind(job);
    if (!TERMINAL.has(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || now();
      if (job.action === 'readdress' && job.netboxIpId) (job.phase === 'allocate-ip' ? orphaned : chaseable).push(job);
    }
    jobs.set(job.id, job);
  }
```

(The existing comments above those lines — the `[null]` file note and the "states a fact" note on `job.kind` — stay where they are.)

Add a `requireNetboxSettings` helper and generalize the release routine. Replace the whole `releaseNetboxIp(job, box)` function with:

```js
  // The re-address preflight and its allocation both need decrypted settings
  // and both must fail as a 400 the route can render, not a bare throw.
  async function requireNetboxSettings() {
    if (!netboxStore) throw serviceError(400, NETBOX_REQUIRED);
    let settings;
    try { settings = await netboxStore.getSettings({ withSecret: true }); }
    catch (e) { throw serviceError(400, `NetBox settings could not be read: ${e?.message || e}`); }
    if (!settings) throw serviceError(400, NETBOX_REQUIRED);
    return settings;
  }

  // Best-effort IPAM cleanup shared by deprovision and readdress: release an
  // allocation by its stamped id, then delete every record matching an
  // address so a manually created NetBox record doesn't outlive what used it.
  // A NetBox failure must never fail a job whose container is already gone or
  // already moved — log it and let the rest finish.
  async function releaseNetboxRecords(job, { ipId, hostIp }) {
    if ((!ipId && !hostIp) || !netboxStore) return;
    let settings = null;
    let readError = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch (e) { readError = e?.message || String(e); }
    if (!settings) {
      // Distinguish "never configured" from a real read/decrypt failure — the
      // latter means an allocated IP was NOT released for a fixable reason.
      const why = readError ? `settings could not be read: ${readError}` : 'NetBox integration not configured';
      if (ipId) { appendLog(job, `# could not release NetBox ip ${ipId}: ${why}\n`); persist(); }
      return;
    }
    const client = makeNetboxClient(settings);
    if (ipId) {
      try {
        await client.releaseIp(ipId);
        appendLog(job, `# released NetBox ip ${ipId}\n`); persist();
      } catch (error) {
        appendLog(job, `# could not release NetBox ip ${ipId}: ${error.message}\n`); persist();
      }
    }
    if (!hostIp) return;
    let matches;
    try {
      matches = await client.findIpsByAddress(hostIp);
    } catch (error) {
      appendLog(job, `# could not look up NetBox ip records for ${hostIp}: ${error.message}\n`); persist();
      return;
    }
    if (!matches.length) {
      if (!ipId) { appendLog(job, `# no NetBox ip record matches ${hostIp}\n`); persist(); }
      return;
    }
    for (const rec of matches) {
      try {
        await client.releaseIp(rec.id);
        appendLog(job, `# released NetBox ip ${rec.id} (${rec.address})\n`); persist();
      } catch (error) {
        appendLog(job, `# could not release NetBox ip ${rec.id} (${rec.address}): ${error.message}\n`); persist();
      }
    }
  }
  // Deprovision's view of the same routine: the box's stamped id and its host.
  const releaseNetboxIp = (job, box) => releaseNetboxRecords(job, {
    ipId: box?.proxmox?.netboxIpId,
    hostIp: isIP(String(box?.host || '')) ? box.host : null,
  });

  // A readdress reservation the container never moved onto — a failed run, or
  // a job interrupted at allocate-ip. Best-effort and logged; the id is
  // cleared only on a confirmed release, so a failure leaves it recorded and
  // chaseable rather than silently forgotten.
  async function releaseFreshAllocation(job) {
    if (!job.netboxIpId) return;
    try {
      const netbox = makeNetboxClient(await requireNetboxSettings());
      await netbox.releaseIp(job.netboxIpId);
      appendLog(job, `# released NetBox ip ${job.netboxIpId} (unused allocation)\n`);
      job.netboxIpId = null;
    } catch (error) {
      appendLog(job, `# could not release NetBox ip ${job.netboxIpId}: ${error.message}\n`);
    }
  }
```

`runDeprovision` keeps calling `releaseNetboxIp(job, box)` unchanged. Add the new routine after `runDeprovision`:

```js
  // Move the container to a new NetBox-managed VLAN/IP. Phase order is the
  // safety argument: the new address is allocated BEFORE the old is touched,
  // PVE is written BEFORE the box is re-pointed, and the old record is released
  // only AFTER the box owns the new one — so a failure at any phase leaves
  // exactly one address registered to the container, never zero.
  async function runReaddress(job) {
    const { box, client } = await resolveTarget(job);
    const current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
    if (current.state !== 'running' && current.state !== 'stopped') throw new Error(`readdress cannot run from ${current.state}`);

    job.phase = 'inspect'; persist();
    const config = await client.guestConfig('lxc', job.node, job.vmid);
    if (!config || typeof config.net0 !== 'string') throw new Error('container has no net0 interface');
    const pairs = parseNet0(config.net0);
    const before = describeNet0(pairs);
    // The address the old record is swept by and whose known_hosts entry goes:
    // the box's host, when it is an IP literal — also what deprovision uses.
    // net0's own ip= is null for a dhcp interface, which is fine.
    const oldHost = isIP(String(box.host || '')) ? box.host : null;
    job.oldIp = before.ip;
    job.oldVlan = before.vlan;
    job.oldNetboxIpId = box.proxmox.netboxIpId || null;
    job.hostname = typeof config.hostname === 'string' ? config.hostname : null;
    appendLog(job, `# before: ${config.net0}\n`); persist();

    job.phase = 'allocate-ip'; persist();
    const settings = await requireNetboxSettings();
    const netbox = makeNetboxClient(settings);
    const prefix = await netbox.findPrefixByVlan(job.vlan);
    // The provisioning rule for the record's description and dns_name; the
    // PVE hostname is box-side content and becomes a dns_name only when it is
    // a DNS label (the same check provisioning applies to a typed hostname).
    const name = isDnsLabel(job.hostname) ? job.hostname : null;
    const fields = { status: 'active', description: `tmuxifier: ${name || box.label}` };
    if (name) fields.dns_name = settings.dnsSuffix ? `${name}.${settings.dnsSuffix}` : name;
    const res = await netbox.allocateIp(prefix, fields);
    job.netboxIpId = res.id;
    if (!isCidr(res.address) || !isIp(res.gateway)) throw new Error(`NetBox returned an unusable address: ${res.address} (gw ${res.gateway})`);
    job.ip = res.address;
    job.gateway = res.gateway;
    appendLog(job, `# allocated ${res.address} from ${prefix.prefix} (gw ${res.gateway}, NetBox ip ${res.id})\n`); persist();
    const newHost = res.address.split('/')[0];
    // Another box already at the new address is a NetBox/boxes.json
    // disagreement — refuse before PVE is touched. The box itself is ignored:
    // an unregistered dhcp box may well be handed its own current address.
    const conflict = await boxStore.uniquenessConflict({ host: newHost }, box.id);
    if (conflict) throw new Error(`${conflict} (${newHost}) — nothing was changed`);
    // NetBox just handed the address out as free: any known_hosts entry for it
    // belongs to whatever used it before (the provisioning rule). Best-effort.
    if (knownHosts) { try { await knownHosts.forget(newHost, box.port); } catch { /* best-effort */ } }

    job.phase = 'apply'; persist();
    const net0 = buildNet0Readdress(pairs, { vlan: job.vlan, ip: res.address, gateway: res.gateway });
    await client.setLxcConfig(job.node, job.vmid, { net0 });
    appendLog(job, `# applied: ${net0}\n`); persist();

    job.phase = 'relink'; persist();
    let after;
    try {
      after = await boxStore.readdressBox(job.boxId, { host: newHost, netboxIpId: res.id });
    } catch (error) {
      // The only failure after the container has moved. Both addresses are now
      // genuinely in use somewhere, so run() releases nothing at this phase.
      throw new Error(`container is now at ${newHost} but the box still points at ${box.host} — edit the box host by hand (${error.message})`);
    }
    appendLog(job, `# box ${box.label} now ${newHost}\n`); persist();

    job.phase = 'release'; persist();
    await releaseNetboxRecords(job, { ipId: job.oldNetboxIpId, hostIp: oldHost });

    job.phase = 'verify'; persist();
    // The old address is free in NetBox now: the container's identity has
    // verifiably left it. Best-effort.
    if (knownHosts && oldHost) { try { await knownHosts.forget(oldHost, box.port); } catch { /* best-effort */ } }
    if (onReaddress) { try { await Promise.resolve(onReaddress({ before: box, after })).catch(() => {}); } catch { /* best-effort */ } }
    if (current.state === 'running' && onContainerUp) {
      try { Promise.resolve(onContainerUp(job.boxId)).catch(() => {}); } catch { /* best-effort */ }
    }
  }
```

Replace `run`:

```js
  async function run(job) {
    try {
      if (job.action === 'deprovision') await runDeprovision(job);
      else if (job.action === 'readdress') await runReaddress(job);
      else await runRoutine(job);
      job.phase = 'done'; job.status = 'done'; job.finishedAt = now(); persist();
    } catch (error) {
      // A readdress that failed while the container was still at its old
      // address (allocate-ip: conflict/unusable; apply: PVE refused) must not
      // leak the reservation. A relink failure keeps it — the container is
      // using it — and the boot reconcile applies the same phase rule.
      if (job.action === 'readdress' && (job.phase === 'allocate-ip' || job.phase === 'apply')) await releaseFreshAllocation(job);
      job.status = 'error'; job.error = error instanceof Error ? error.message : 'lifecycle action failed'; job.finishedAt = now(); persist();
    }
  }
```

In `createJob`, replace the input parsing and the action-specific checks. The top of the function becomes:

```js
  async function createJob(input = {}) {
    if (['hostId', 'node', 'vmid'].some((key) => key in input)) {
      throw serviceError(400, 'lifecycle targets are resolved from the box link');
    }
    const { boxId, action } = input;
    if (typeof boxId !== 'string' || !boxId) throw serviceError(400, 'boxId is required');
    if (!ACTIONS.has(action)) throw serviceError(400, 'invalid lifecycle action');
    // Shape before I/O: a bad vlan is refused without a box read.
    const vlan = action === 'readdress' ? parseVlan(input.vlan) : null;
    if (action !== 'readdress' && 'vlan' in input) throw serviceError(400, 'vlan applies only to readdress');
```

and the action-specific block (after the `template` check) becomes:

```js
    if (action === 'deprovision') {
      if (input.confirmName !== box.label) throw serviceError(409, 'confirmation name does not match');
      if (!['running', 'stopped', 'missing'].includes(current.state)) throw serviceError(409, `deprovision cannot run from ${current.state}`);
    } else if (action === 'readdress') {
      if (jobKind(box.proxmox) !== 'lxc') throw serviceError(409, 'readdress is available for containers only');
      if (!['running', 'stopped'].includes(current.state)) throw serviceError(409, `readdress cannot run from ${current.state}`);
      if (setupRunning(box.id)) throw serviceError(409, 'box has a running setup job — wait for it to finish');
      await requireNetboxSettings(); // 400 with no job record, as provisioning does
    } else if (current.state !== REQUIRED[action]) {
      throw serviceError(409, `${action} requires ${REQUIRED[action]}`);
    }
```

and the job record gains the readdress fields:

```js
    const job = {
      id: makeId(), action, boxId: box.id, boxLabel: box.label,
      hostId: host.id, hostName: host.name, node: current.node, vmid: Number(box.proxmox.vmid),
      kind: jobKind(box.proxmox),
      status: 'running', phase: 'resolve', log: '', error: null,
      createdAt: now(), finishedAt: null,
      ...(action === 'readdress' ? { vlan, oldIp: null, oldVlan: null, oldNetboxIpId: null, hostname: null, ip: null, gateway: null, netboxIpId: null } : {}),
    };
```

Finally, just before the `return { createJob, … }` at the bottom, kick off the boot reconcile (it must sit after every helper it uses is defined):

```js
  // Boot reconcile for readdress reservations. Fire-and-forget so a slow or
  // unreachable NetBox cannot delay boot; awaited by _reconciled() in tests.
  for (const job of chaseable) appendLog(job, `# interrupted at ${job.phase}: NetBox ip ${job.netboxIpId} may be in use by the container — check it by hand\n`);
  if (chaseable.length) persist();
  const reconciled = orphaned.length
    ? (async () => { for (const job of orphaned) await releaseFreshAllocation(job); persist(); })()
    : Promise.resolve();
```

and add `_reconciled: () => reconciled,` to the returned object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/proxmoxLifecycle.test.js test/proxmoxValidate.test.js`
Expected: PASS — all new tests and every pre-existing deprovision/power test.

- [ ] **Step 6: Commit**

```bash
git add src/server/proxmoxLifecycle.js src/server/proxmoxValidate.js test/proxmoxLifecycle.test.js test/proxmoxValidate.test.js
git commit -m "feat(pve): readdress lifecycle action — allocate, apply net0, relink, release"
```

---

### Task 6: Routes and wiring

**Files:**
- Modify: `src/server/server.js` (imports; a route after `DELETE /api/boxes/:id/proxmox`; a route after `GET /api/netbox/next-ip`)
- Modify: `src/server/index.js` (the `createProxmoxLifecycleManager({...})` call)
- Test: `test/server.test.js`, `test/netboxRoutes.test.js`

**Interfaces:**
- Consumes: Task 1 (`parseNet0`, `describeNet0`), Task 2 (`client.guestConfig`), Task 3 (`client.listVlanPrefixes`), Task 5 (`setupRunning`, `onReaddress` options).
- Produces:
  - `GET /api/boxes/:id/proxmox/net` → `200 { hostname, bridge, vlan, ip, gateway }`; `404` unknown box or host profile; `409` unlinked, VM, or no `net0`; `502` PVE unreachable.
  - `GET /api/netbox/vlans` → `200 { ok: true, vlans: NetboxVlan[] } | { ok: false, error }`.
  - `POST /api/proxmox/lifecycle-jobs` passes `vlan` through to `createJob` unchanged (no route edit needed; pinned by a test).

- [ ] **Step 1: Write the failing route tests**

Append to `test/server.test.js`:

```js
test('GET /api/boxes/:id/proxmox/net reads the container net0 through PVE and gates VMs and unlinked boxes', async () => {
  const stubs = proxmoxStubs();
  const configCalls = [];
  stubs.makeProxmoxClient = () => ({
    guestConfig: async (kind, node, vmid) => { configCalls.push([kind, node, vmid]); return { hostname: 'dev-01', net0: 'name=eth0,bridge=vmbr0,gw=192.168.20.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.20.5/24,tag=20,type=veth' }; },
  });
  const store = createStore({ dataDir: dir });
  const ct = await store.addBox({ host: '192.168.20.5', label: 'ct', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' } }, { trustedProxmox: true });
  const vm = await store.addBox({ host: '192.168.20.6', label: 'vm', proxmox: { hostId: 'H1', node: 'pve', vmid: 200, kind: 'qemu' } }, { trustedProxmox: true });
  const plain = await store.addBox({ host: '192.168.20.7', label: 'plain' });
  app = await makeApp({ ...stubs, store });
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${ct.id}/proxmox/net` })).statusCode).toBe(401);
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${ct.id}/proxmox/net`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ hostname: 'dev-01', bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' });
  expect(configCalls).toEqual([['lxc', 'pve', 131]]);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${vm.id}/proxmox/net`, headers })).statusCode).toBe(409);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${plain.id}/proxmox/net`, headers })).statusCode).toBe(409);
  expect((await app.inject({ method: 'GET', url: '/api/boxes/nope/proxmox/net', headers })).statusCode).toBe(404);
  expect(configCalls).toHaveLength(1); // the refusals never reached PVE
});

test('GET /api/boxes/:id/proxmox/net maps a PVE failure to 502 and a config without net0 to 409', async () => {
  const stubs = proxmoxStubs();
  let mode = 'throw';
  stubs.makeProxmoxClient = () => ({ guestConfig: async () => { if (mode === 'throw') throw new Error('pveproxy down'); return { hostname: 'dev-01' }; } });
  const store = createStore({ dataDir: dir });
  const ct = await store.addBox({ host: '192.168.20.5', label: 'ct', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' } }, { trustedProxmox: true });
  app = await makeApp({ ...stubs, store });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const down = await app.inject({ method: 'GET', url: `/api/boxes/${ct.id}/proxmox/net`, headers });
  expect(down.statusCode).toBe(502);
  expect(down.json().error).toContain('pveproxy down');
  mode = 'nonet';
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${ct.id}/proxmox/net`, headers })).statusCode).toBe(409);
});

test('POST /api/proxmox/lifecycle-jobs passes a readdress vlan through to the manager untouched', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: 'B1', action: 'readdress', vlan: 30 } });
  expect(created.statusCode).toBe(201);
  expect(calls).toContainEqual(['createLifecycleJob', { boxId: 'B1', action: 'readdress', vlan: 30 }]);
});
```

Append to `test/netboxRoutes.test.js`:

```js
test('vlans: requires auth, reports ok:false when unconfigured without touching the client', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/netbox/vlans' })).statusCode).toBe(401);
  let made = 0;
  const a = buildServer({ ...baseDeps, makeNetboxClient: () => { made += 1; return {}; } });
  const h = await headers(a);
  const res = await a.inject({ method: 'GET', url: '/api/netbox/vlans', headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/i) });
  expect(made).toBe(0);
});

test('vlans: lists via the client, never leaks the token, and renders a client failure inline', async () => {
  let fail = false;
  const a = buildServer({ ...baseDeps, makeNetboxClient: () => ({
    listVlanPrefixes: async () => { if (fail) throw new Error('netbox down'); return [{ vid: 30, name: 'servers', prefix: '192.168.30.0/24', allocatable: true }]; },
  }) });
  const h = await headers(a);
  await a.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'nb-secret-token' } });
  const res = await a.inject({ method: 'GET', url: '/api/netbox/vlans', headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, vlans: [{ vid: 30, name: 'servers', prefix: '192.168.30.0/24', allocatable: true }] });
  expect(res.body).not.toContain('nb-secret-token');
  fail = true;
  const down = await a.inject({ method: 'GET', url: '/api/netbox/vlans', headers: h });
  expect(down.statusCode).toBe(200);
  expect(down.json()).toEqual({ ok: false, error: 'netbox down' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server.test.js test/netboxRoutes.test.js`
Expected: the new tests FAIL with 404s (routes absent); everything else PASSES.

- [ ] **Step 3: Implement the routes**

In `src/server/server.js`, add to the imports at the top of the file:

```js
import { parseNet0, describeNet0 } from './proxmoxParams.js';
```

After the `app.delete('/api/boxes/:id/proxmox', …)` route handler, add:

```js
  // Read-only view of a linked container's live interface for the re-address
  // dialog. The parsed net0 is the only truth about which VLAN/address the
  // container is on — boxes.json stores neither. Containers only: the
  // lifecycle action behind it is LXC-only, so a VM gets the same 409 here
  // rather than a dialog that ends in one.
  app.get('/api/boxes/:id/proxmox/net', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (!box.proxmox) return reply.code(409).send({ error: 'box is not linked to Proxmox' });
    if (box.proxmox.kind === 'qemu') return reply.code(409).send({ error: 'only containers can be re-addressed' });
    const host = await proxmoxStore.getHost(box.proxmox.hostId, { withSecret: true });
    if (!host) return reply.code(404).send({ error: 'proxmox host not found' });
    let config;
    try { config = await makeProxmoxClient(host).guestConfig('lxc', box.proxmox.node, box.proxmox.vmid); }
    catch (error) { return serviceFailure(reply, error, 502); }
    if (!config || typeof config.net0 !== 'string') return reply.code(409).send({ error: 'container has no net0 interface' });
    try {
      return { hostname: typeof config.hostname === 'string' ? config.hostname : null, ...describeNet0(parseNet0(config.net0)) };
    } catch (error) { return serviceFailure(reply, error, 502); }
  });
```

`serviceFailure` is defined just above the `GET /api/proxmox/guests` route; the new route must be placed AFTER that definition (it sits with the other `/api/boxes/:id/proxmox` routes, which are already below it — verify with `grep -n "const serviceFailure\|api/boxes/:id/proxmox" src/server/server.js`).

After the `GET /api/netbox/next-ip` route, add:

```js
  // The re-address dialog's VLAN picker. Result-shaped like next-ip: an
  // unconfigured, undecryptable or unreachable NetBox renders inline in the
  // dialog, never as a 500.
  app.get('/api/netbox/vlans', { preHandler: requireAuth }, async () => {
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); }
    catch { return { ok: false, error: 'could not decrypt the stored NetBox token — re-enter it (was TMUXIFIER_COOKIE_SECRET rotated?)' }; }
    if (!settings) return { ok: false, error: 'NetBox is not configured — set it up in Settings (⚙)' };
    try { return { ok: true, vlans: await makeNetboxClient(settings).listVlanPrefixes() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
```

- [ ] **Step 4: Wire the manager in `index.js`**

In `src/server/index.js`, inside the `createProxmoxLifecycleManager({ … })` call, after the `onContainerUp` line add:

```js
  // readdress: refuse while a setup job streams over the SSH master the job
  // is about to sever — the same test the /term gate applies.
  setupRunning: (boxId) => setupManager.currentForBox(boxId)?.status === 'running',
  // readdress: once the box points at its new address, exit the old
  // ControlMaster (built from the OLD record — its socket is keyed by host),
  // drop every viewer's terminal so it reconnects at the new host (terminals
  // only, as PATCH /api/boxes does), and reset the status backoff. Each step
  // best-effort; the job has already succeeded.
  onReaddress: async ({ before }) => {
    try { await boxActions.exitMaster(before); } catch { /* best-effort */ }
    try { sessions.closeGroup(before.id, 'terminal'); } catch { /* best-effort */ }
    try { statusChecker.resetBackoff?.(before.id); } catch { /* best-effort */ }
  },
```

(`sessions`, `boxActions`, `statusChecker` and `setupManager` are all constructed earlier in `index.js` than the lifecycle manager — confirm with `grep -n "^const sessions\|^const boxActions\|^const statusChecker\|^const setupManager\|^const lifecycleManager" src/server/index.js`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/server.test.js test/netboxRoutes.test.js && node --check src/server/index.js`
Expected: PASS; the syntax check prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/server/index.js test/server.test.js test/netboxRoutes.test.js
git commit -m "feat(api): container net read, NetBox vlan list, readdress wiring"
```

---

### Task 7: Web types, fetch layers, and eligibility

**Files:**
- Modify: `src/web/proxmox.ts`, `src/web/netbox.ts`, `src/web/proxmoxGuests.ts` (`actionsForGuest` only)
- Test: `test/proxmoxGuests.test.js`, `test/proxmoxWebClient.test.js`

**Interfaces:**
- Produces:
  - `proxmox.ts`: `LifecycleAction` includes `'readdress'`; `interface PveGuestNet { hostname: string | null; bridge: string | null; vlan: number | null; ip: string | null; gateway: string | null }`; `pve.guestNet(boxId): Promise<PveGuestNet>`; `pve.createLifecycleJob` spec gains `vlan?: number`.
  - `netbox.ts`: `interface NetboxVlan { vid: number; name: string; prefix: string; allocatable: boolean; reason?: string }`; `type NetboxVlans = { ok: true; vlans: NetboxVlan[] } | { ok: false; error: string }`; `nbx.vlans(): Promise<NetboxVlans>`.
  - `proxmoxGuests.ts`: `actionsForGuest({ state, template, kind })` inserts `'readdress'` before `'deprovision'` for an LXC guest in `running`/`stopped`.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxGuests.test.js`:

```js
test('readdress is offered to a running or stopped container, before deprovision, and never to a VM, template, missing or unknown guest', () => {
  expect(actionsForGuest({ state: 'running', template: false, kind: 'lxc' })).toEqual(['shutdown', 'stop', 'reboot', 'readdress', 'deprovision']);
  expect(actionsForGuest({ state: 'stopped', template: false, kind: 'lxc' })).toEqual(['start', 'readdress', 'deprovision']);
  expect(actionsForGuest({ state: 'missing', template: false, kind: 'lxc' })).toEqual(['deprovision']);
  expect(actionsForGuest({ state: 'unknown', template: false, kind: 'lxc' })).toEqual([]);
  expect(actionsForGuest({ state: 'running', template: false, kind: 'qemu' })).toEqual(['shutdown', 'stop', 'reboot', 'deprovision']);
  expect(actionsForGuest({ state: 'stopped', template: true, kind: 'lxc' })).toEqual([]);
});
```

Append to `test/proxmoxWebClient.test.js`:

```js
test('pve.guestNet GETs the box net route and createLifecycleJob carries vlan', async () => {
  const net = { hostname: 'dev-01', bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' };
  const calls = stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => net });
  expect(await pve.guestNet('B1')).toEqual(net);
  expect(calls[0].url).toBe('/api/boxes/B1/proxmox/net');
  const calls2 = stubFetch({ ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'L1' }) });
  await pve.createLifecycleJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  expect(calls2[0].url).toBe('/api/proxmox/lifecycle-jobs');
  expect(JSON.parse(calls2[0].opts.body)).toEqual({ boxId: 'B1', action: 'readdress', vlan: 30 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/proxmoxGuests.test.js test/proxmoxWebClient.test.js`
Expected: FAIL — `readdress` absent from the arrays; `pve.guestNet is not a function`.

- [ ] **Step 3: Implement**

`src/web/proxmox.ts`:

```ts
export type LifecycleAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'deprovision' | 'readdress';
```

after `PveNodeGuest` add:

```ts
// A linked container's live net0 as GET /api/boxes/:id/proxmox/net reports
// it — the truth about which VLAN/address it is on. `ip` is null for dhcp.
export interface PveGuestNet { hostname: string | null; bridge: string | null; vlan: number | null; ip: string | null; gateway: string | null; }
```

in the `pve` object:

```ts
  guestNet(boxId: string) { return jr<PveGuestNet>(`/api/boxes/${boxId}/proxmox/net`); },
  createLifecycleJob(spec: { boxId: string; action: LifecycleAction; confirmName?: string; vlan?: number }) { return jr<LifecycleJobSummary>('/api/proxmox/lifecycle-jobs', post(spec)); },
```

`src/web/netbox.ts`, after `NetboxNextIp`:

```ts
export interface NetboxVlan { vid: number; name: string; prefix: string; allocatable: boolean; reason?: string }
export type NetboxVlans = { ok: true; vlans: NetboxVlan[] } | { ok: false; error: string };
```

in the `nbx` object:

```ts
  vlans() { return jsonFetch<NetboxVlans>('/api/netbox/vlans'); },
```

`src/web/proxmoxGuests.ts`, replace `actionsForGuest`:

```ts
// A template gets the same no-actions treatment as 'mismatch', regardless of
// its reported state — Deprovisioning a template destroys the source every
// future clone depends on, and Start is meaningless for one. Checked ahead of
// actionsForState so a template can never fall through to a real action.
// Re-address is container-only (a VM would need cloud-init) and needs a guest
// PVE can actually see — running or stopped, never missing or unknown — and
// sits before Deprovision so the destructive key stays last.
export function actionsForGuest(guest: { state: PveGuestState; template: boolean; kind: PveGuestKind }): LifecycleAction[] {
  if (guest.template) return [];
  const actions = actionsForState(guest.state);
  if (guest.kind === 'lxc' && (guest.state === 'running' || guest.state === 'stopped')) {
    const i = actions.indexOf('deprovision');
    actions.splice(i === -1 ? actions.length : i, 0, 'readdress');
  }
  return actions;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/proxmoxGuests.test.js test/proxmoxWebClient.test.js && npm run typecheck`
Expected: PASS; typecheck clean. (`renderGuestsTab` passes the whole `guest` object, which already carries `kind`, so the wider parameter type compiles.)

- [ ] **Step 5: Commit**

```bash
git add src/web/proxmox.ts src/web/netbox.ts src/web/proxmoxGuests.ts test/proxmoxGuests.test.js test/proxmoxWebClient.test.js
git commit -m "feat(web): readdress action type, guestNet/vlans fetch layers, LXC eligibility"
```

---

### Task 8: The Re-address dialog

**Files:**
- Create: `src/web/proxmoxReaddress.ts`
- Modify: `src/web/proxmoxGuests.ts` (import; the button label/class; the click dispatch)
- Modify: `src/web/style.css` (one rule next to `.pve-deprovision-modal`)
- Test: `test/proxmoxReaddress.test.js` (pure helpers only — vitest has no DOM)

**Interfaces:**
- Consumes: Task 7 (`pve.guestNet`, `pve.createLifecycleJob({ …, vlan })`, `nbx.vlans()`, `nbx.nextIp()`, `PveGuestNet`, `NetboxVlan`), `el`/`err`/`field`/`openModal` from `dom.ts`, `registerModal` from `modalRegistry.ts`.
- Produces:
  - `vlanOptionLabel(v: NetboxVlan): string` — `"30 · servers · 192.168.30.0/24"`, with ` — <reason>` appended when not allocatable, `unnamed` for a blank name.
  - `currentNetLine(net: PveGuestNet): string` — `"vmbr0 · VLAN 20 · 192.168.20.5/24 · gw 192.168.20.1"`; `untagged`/`dhcp` stand in for null vlan/ip; a null gateway is omitted; a null bridge reads `?`.
  - `openReaddressDialog(guest: PveLinkedGuest, deps: { showLifecycleJob: (id: string) => void }): void`.

- [ ] **Step 1: Write the failing tests**

Create `test/proxmoxReaddress.test.js`:

```js
import { test, expect } from 'vitest';
import { vlanOptionLabel, currentNetLine } from '../src/web/proxmoxReaddress.ts';

test('vlanOptionLabel: vid · name · prefix, with the reason when not allocatable and "unnamed" for a blank name', () => {
  expect(vlanOptionLabel({ vid: 30, name: 'servers', prefix: '192.168.30.0/24', allocatable: true })).toBe('30 · servers · 192.168.30.0/24');
  expect(vlanOptionLabel({ vid: 40, name: 'lab', prefix: '192.168.40.0/24', allocatable: false, reason: 'VLAN 40 maps to 2 NetBox prefixes' }))
    .toBe('40 · lab · 192.168.40.0/24 — VLAN 40 maps to 2 NetBox prefixes');
  expect(vlanOptionLabel({ vid: 50, name: '', prefix: '192.168.50.0/24', allocatable: true })).toBe('50 · unnamed · 192.168.50.0/24');
});

test('currentNetLine: bridge · VLAN · ip · gw, with untagged/dhcp stand-ins and no gw segment when absent', () => {
  expect(currentNetLine({ hostname: 'dev-01', bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' }))
    .toBe('vmbr0 · VLAN 20 · 192.168.20.5/24 · gw 192.168.20.1');
  expect(currentNetLine({ hostname: null, bridge: 'vmbr0', vlan: null, ip: null, gateway: null })).toBe('vmbr0 · untagged · dhcp');
  expect(currentNetLine({ hostname: null, bridge: null, vlan: 5, ip: null, gateway: null })).toBe('? · VLAN 5 · dhcp');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/proxmoxReaddress.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the dialog module**

Create `src/web/proxmoxReaddress.ts`:

```ts
// The Re-address dialog: move a linked LXC container to another
// NetBox-managed VLAN/IP. Split like proxmoxGuests.ts — the pure label
// builders are unit-tested, the DOM half is validated on the live app (vitest
// has no DOM). The dialog only chooses a VLAN and starts the lifecycle job;
// every rule about what happens next lives server-side in proxmoxLifecycle.js.
import { pve, type PveGuestNet, type PveLinkedGuest } from './proxmox';
import { nbx, type NetboxVlan } from './netbox';
import { el, err, field, openModal } from './dom';
import { registerModal } from './modalRegistry';

export function vlanOptionLabel(v: NetboxVlan): string {
  const base = `${v.vid} · ${v.name || 'unnamed'} · ${v.prefix}`;
  return v.allocatable ? base : `${base} — ${v.reason ?? 'not allocatable'}`;
}

export function currentNetLine(net: PveGuestNet): string {
  const parts = [net.bridge ?? '?', net.vlan == null ? 'untagged' : `VLAN ${net.vlan}`, net.ip ?? 'dhcp'];
  if (net.gateway) parts.push(`gw ${net.gateway}`);
  return parts.join(' · ');
}

export function openReaddressDialog(guest: PveLinkedGuest, deps: { showLifecycleJob: (id: string) => void }) {
  const modal = el('form', { class: 'modal pve-readdress-modal' });
  const now = el('div', { class: 'pve-sub' }, ['Reading the container interface…']);
  const select = el('select', { class: 'pve-vlan-select', disabled: true }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, ['Loading NetBox VLANs…']));
  const preview = el('div', { class: 'pve-sub' });
  const submit = el('button', { type: 'submit', class: 'pve-primary', disabled: true }, ['Re-address']);
  const errorLine = el('div', { class: 'pve-err' });
  // Body-mounted, so teardown must be able to reach it: an expiring session
  // otherwise leaves a live Re-address button over the login screen.
  const { close } = openModal({ modal, onClose: () => unregister() });
  const unregister = registerModal(close);

  // Non-binding next-free preview from the existing next-ip route; a stale
  // response for a VLAN the user has already moved off is dropped.
  let previewGen = 0;
  const refreshPreview = async () => {
    const gen = ++previewGen;
    const vid = Number(select.value);
    if (!vid) { preview.textContent = ''; return; }
    preview.textContent = 'Looking up the next free address…';
    const res = await nbx.nextIp(vid).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'lookup failed' }));
    if (gen !== previewGen) return;
    preview.textContent = res.ok ? `Next free: ${res.address} in ${res.prefix} (non-binding — allocated when the job runs)` : `Preview unavailable: ${res.error}`;
  };
  select.addEventListener('change', () => { submit.disabled = !select.value; void refreshPreview(); });

  modal.addEventListener('submit', async (event) => {
    event.preventDefault();
    const vlan = Number(select.value);
    if (!vlan) return;
    submit.disabled = true; errorLine.textContent = '';
    try {
      const job = await pve.createLifecycleJob({ boxId: guest.boxId, action: 'readdress', vlan });
      close();
      deps.showLifecycleJob(job.id);
    } catch (error) {
      errorLine.textContent = error instanceof Error ? error.message : 'Re-address failed';
      submit.disabled = !select.value;
    }
  });

  modal.append(
    el('h2', {}, ['Re-address container']),
    // Inlined rather than importing kindLabel from proxmoxGuests.ts, which
    // imports this module — no cycle. Only ever opened for a container anyway.
    el('div', {}, [`${guest.boxLabel} | ${guest.kind === 'qemu' ? 'VM' : 'CT'} | ${guest.hostName ?? guest.hostId} | ${guest.node} | VMID ${guest.vmid}`]),
    now,
    field('Move to VLAN', select),
    preview,
    el('p', { class: 'pve-warning' }, [
      guest.state === 'running'
        ? 'Proxmox re-plugs eth0 live with the new VLAN tag and address. Open terminals on this box drop and reconnect at the new address once SSH answers there. The old address is released to NetBox.'
        : 'The new VLAN tag and address are written to the container config and take effect at its next start. The old address is released to NetBox.',
    ]),
    errorLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), submit]),
  );

  void (async () => {
    const [net, vlans] = await Promise.allSettled([pve.guestNet(guest.boxId), nbx.vlans()]);
    if (net.status === 'fulfilled') now.textContent = `Now: ${currentNetLine(net.value)}`;
    else { now.replaceWith(err(net.reason instanceof Error ? net.reason.message : 'Could not read the container interface')); return; }
    if (vlans.status === 'rejected') { select.replaceChildren(el('option', { value: '' }, ['NetBox unavailable'])); errorLine.textContent = vlans.reason instanceof Error ? vlans.reason.message : 'Could not load VLANs'; return; }
    if (!vlans.value.ok) { select.replaceChildren(el('option', { value: '' }, ['NetBox unavailable'])); errorLine.textContent = vlans.value.error; return; }
    select.replaceChildren(el('option', { value: '' }, ['Choose a VLAN…']));
    for (const v of vlans.value.vlans) {
      const opt = el('option', { value: String(v.vid) }, [vlanOptionLabel(v)]) as HTMLOptionElement;
      if (!v.allocatable) opt.disabled = true;
      select.append(opt);
    }
    if (vlans.value.vlans.length === 0) { errorLine.textContent = 'NetBox has no IPv4 prefix with a VLAN to allocate from.'; return; }
    select.disabled = false;
    select.focus();
  })();
}
```

- [ ] **Step 4: Wire the button in `proxmoxGuests.ts`**

Add the import:

```ts
import { openReaddressDialog } from './proxmoxReaddress';
```

In `renderGuestsTab`'s action loop, replace the `label` and `button` construction and the click dispatch with:

```ts
        const label = action === 'deprovision' ? 'Deprovision'
          : action === 'stop' ? 'Stop now'
          : action === 'readdress' ? 'Re-address'
          : action[0].toUpperCase() + action.slice(1);
        const button = el('button', {
          type: 'button',
          class: action === 'deprovision' ? 'danger' : action === 'stop' || action === 'readdress' ? 'warn' : '',
          ...(action === 'stop' ? { title: 'Force an immediate stop' } : {}),
          ...(action === 'readdress' ? { title: 'Move to another NetBox-managed VLAN/IP' } : {}),
        }, [label]);
        button.addEventListener('click', () => {
          const run = async (confirmName?: string) => {
            button.disabled = true;
            row.querySelector('.pve-err')?.remove();
            try {
              const job = await pve.createLifecycleJob({ boxId: guest.boxId, action, ...(confirmName ? { confirmName } : {}) });
              deps.showLifecycleJob(job.id);
            } finally { button.disabled = false; }
          };
          if (action === 'deprovision') openDeprovisionDialog(guest, run);
          else if (action === 'readdress') openReaddressDialog(guest, { showLifecycleJob: deps.showLifecycleJob });
          else void run().catch((error) => { row.append(err(error instanceof Error ? error.message : 'Lifecycle action failed')); });
        });
```

- [ ] **Step 5: Style**

In `src/web/style.css`, directly after the `.pve-deprovision-modal { width: 460px; }` rule add:

```css
.pve-readdress-modal { width: 460px; }
.pve-readdress-modal .pve-vlan-select { width: 100%; }
```

- [ ] **Step 6: Run the tests, typecheck, and build**

Run: `npx vitest run test/proxmoxReaddress.test.js test/proxmoxGuests.test.js && npm run typecheck && npm run build`
Expected: PASS, typecheck clean, `vite build` succeeds (in the worktree — never in the main checkout while the service runs).

- [ ] **Step 7: Commit**

```bash
git add src/web/proxmoxReaddress.ts src/web/proxmoxGuests.ts src/web/style.css test/proxmoxReaddress.test.js
git commit -m "feat(web): Re-address dialog on the Guests tab"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/proxmox.md` (new subsection after the `**Deprovision**` paragraph at the end of "Proxmox guest lifecycle")
- Modify: `README.md` (the `## Proxmox` paragraph)
- Modify: `CLAUDE.md` and `AGENTS.md` (identical edits; the two files differ only in their heading and two intro sentences — apply the same text to both)

- [ ] **Step 1: `docs/proxmox.md`**

Append after the Deprovision paragraph (end of file):

```markdown
**Re-address** moves a linked **container** to another NetBox-managed VLAN/IP without rebuilding
it. On a running or stopped container the Guests tab offers **Re-address**, which reads the
container's live `net0` from Proxmox (bridge, VLAN tag, address, gateway — Tmuxifier stores none
of these), lists the IPv4 prefixes NetBox knows by VLAN (a VLAN with more than one prefix is shown
but not selectable, the same rule provisioning applies), and previews the next free address
(non-binding). Apply runs a lifecycle job that, in this order: allocates the next free address
from the chosen VLAN's prefix (skipping the gateway, stamping `description`/`dns_name` the way
provisioning does, from the container's hostname); refuses if another box already sits at that
address; writes the new `tag`, `ip` and `gw` to `net0` — every other key, including `hwaddr`,
the bridge and any IPv6 settings, is left exactly as it was; re-points the box at the new address;
then releases the old NetBox record (by its stamped id when the container was provisioned
`auto-static`, and by address otherwise — so a hand-registered record goes too). A running
container is re-plugged live by Proxmox; open terminals drop and reconnect once SSH answers at
the new address. A stopped one takes the change at its next start. The `known_hosts` entries for
both addresses are removed — the new one was just handed out by NetBox as free, and the old one
has just been released. The bridge never changes, VMs are not eligible (they would need
cloud-init), and a container on `dhcp` can be moved onto a managed VLAN but not back. The
token needs `VM.Config.Network` for the config write — already included in `PVEVMAdmin`.

If the job fails before Proxmox is written, the fresh allocation is released and nothing has
changed. If Proxmox accepted the change but the box record could not be updated, the job names
both addresses in its error and releases nothing — fix the box host by hand in Edit box. A job
interrupted by a restart between allocation and the Proxmox write releases its allocation on the
next boot; one interrupted later leaves it and says so in its log, since the server cannot know
whether Proxmox wrote the config.
```

- [ ] **Step 2: `README.md`**

In the `## Proxmox` paragraph, change

```
control: Start / Shutdown / Stop / Reboot and a confirm-gated **Deprovision** that destroys the
guest and releases its NetBox IP. Token permissions, presets, the shell-framework update
```

to

```
control: Start / Shutdown / Stop / Reboot, a **Re-address** that moves a container to another
NetBox-managed VLAN/IP (next free address allocated, old record released, live re-plug on a
running container), and a confirm-gated **Deprovision** that destroys the guest and releases its
NetBox IP. Token permissions, presets, the shell-framework update
```

- [ ] **Step 3: `CLAUDE.md` and `AGENTS.md`**

Apply each of these to BOTH files.

(a) In the `proxmoxLifecycle.js` / `proxmoxLifecycleStore.js` entry, append after the sentence ending "…so manually created records don't go stale (best-effort).":

```
  A third action, `readdress`, moves a linked LXC container to a new NetBox-managed VLAN/IP
  (spec: `docs/superpowers/specs/2026-09-02-container-readdress-design.md`). Phase order is the
  safety argument: `inspect` (read the live `net0` — `boxes.json` stores neither VLAN nor
  gateway) → `allocate-ip` (next free from the VLAN's prefix; then `uniquenessConflict` on the
  new address, ignoring the box itself) → `apply` (`setLxcConfig` with `buildNet0Readdress`,
  which rewrites only `tag`/`ip`/`gw`) → `relink` (`store.readdressBox`, one write) → `release`
  (the old record by stamped id and by address, the deprovision routine generalized into
  `releaseNetboxRecords`) → `verify` (forget both `known_hosts` entries; `onReaddress` hook;
  `onContainerUp` when it was running). A failure at `allocate-ip` or `apply` releases the fresh
  allocation (the container never moved); a failure at `relink` releases nothing (both
  addresses are in use somewhere) and names both in its error. The boot reconcile applies the
  same rule: interrupted at `allocate-ip` → released, later → logged as chaseable. `vlan` is the
  only client-supplied value that reaches PVE or NetBox and is integer-checked (no coercion)
  before any I/O; `setupRunning` (wired to `setupManager.currentForBox`) refuses a job that
  would sever a setup's SSH master. LXC-only, like provisioning.
```

(b) In the `proxmoxApi.js` entry, after "`createLxc` and `lxcInterfaces` stay LXC-only; VM provisioning is out of scope.", append:

```
  `guestConfig` (kind-parameterized, re-validated like the six above) reads a guest's config;
  `setLxcConfig` PUTs one and is LXC-only for the same reason `createLxc` is — a VM's address
  lives in cloud-init.
```

(c) In the `proxmoxParams.js` entry, replace the one-liner with:

```
- `proxmoxParams.js` — pure preset → `pct`/LXC create-param mapping (`net0`, `ssh-public-keys`, …),
  plus the re-address side: `parseNet0` (ordered pairs, rejects what PVE never writes),
  `describeNet0` (the IPv4 view; `dhcp`/`manual` read as null), and `buildNet0Readdress`, which
  rewrites only `tag`/`ip`/`gw` in place and appends any that were absent, so `hwaddr`, the
  bridge and IPv6 keys survive verbatim.
```

(d) In the `store.js` entry, append:

```
  `readdressBox(id, { host, netboxIpId })` is the re-address job's one write — host and link
  allocation id land together or not at all, since two writes would leave a window the boot
  reconcile cannot tell from a leaked id; `uniquenessConflict` takes an optional `ignoreId` so
  that job can be handed the box's own current address.
```

(e) In the `netboxValidate.js` / `netboxStore.js` / `netboxApi.js` entry, append:

```
  `listVlanPrefixes` (served by `GET /api/netbox/vlans`, result-shaped like `next-ip`) feeds the
  re-address picker: IPv4 prefixes by VLAN, a multi-prefix VLAN listed as non-allocatable up
  front rather than failing the job later.
```

(f) In the `server.js` entry, after the `POST /api/boxes/:id/kill` paragraph, append:

```
  `GET /api/boxes/:id/proxmox/net` is the re-address dialog's read of a linked container's live
  `net0` (409 for a VM or an unlinked box, 502 when PVE cannot be read); `POST
  /api/proxmox/lifecycle-jobs` carries the new `readdress` action's `vlan` unchanged to
  `createJob`, which validates it.
```

(g) In the web-client paragraph, the `proxmoxGuests.ts` description ends with the text
`does not otherwise distinguish a template from an ordinary stopped guest), \`proxmoxActivity.ts\``.
Replace `ordinary stopped guest),` there with:

```
  ordinary stopped guest; `actionsForGuest` also inserts `readdress` before `deprovision` for an
  LXC guest in `running`/`stopped` — never a VM, template, missing or unknown one — and the
  button opens `proxmoxReaddress.ts`: the dialog, pure `vlanOptionLabel`/`currentNetLine`
  unit-tested and the DOM half live-validated, which reads `GET /api/boxes/:id/proxmox/net` and
  `GET /api/netbox/vlans`, previews via the existing `next-ip`, and hands the created job to
  `showLifecycleJob`, whose existing settle path already refetches the box list through
  `onBoxLinked`),
```

so that `, \`proxmoxActivity.ts\`` still follows.

(h) In "Security notes", after the bullet beginning "A changed SSH host key is treated as a possible MITM…", add:

```
- A container re-address removes two `known_hosts` entries, both under the existing rule: the
  new address was just handed out by NetBox as free (any entry for it is a recycled-IP leftover,
  the same argument provisioning makes), and the old address has just been released to NetBox
  (the container's identity has verifiably left it). `vlan` is the only new client-supplied
  value that reaches an external system; the address and gateway written to PVE come from
  NetBox and are re-validated with `isCidr`/`isIp`, and the PVE-reported hostname becomes a
  NetBox `dns_name` only when it passes the same `DNS_LABEL` check a typed hostname does.
```

- [ ] **Step 4: Check the two files still differ only where they did before**

Run: `diff CLAUDE.md AGENTS.md | grep '^[<>]' | grep -v 'CLAUDE.md\|AGENTS.md\|coding agents\|runs from the repo\|meant to run' | wc -l`
Expected: the same count as on `main` before this task (run the same command on `main` to compare; the pre-existing drift is a handful of lines in the healthHistory entry).

- [ ] **Step 5: Commit**

```bash
git add docs/proxmox.md README.md CLAUDE.md AGENTS.md
git commit -m "docs(pve): container re-address — guide, README, module map, security note"
```

---

### Task 10: Whole-suite verification and live validation

**Files:** none new.

- [ ] **Step 1: Full suite in the worktree**

Run: `npm test`
Expected: typecheck clean, every vitest file green (unit + integration; the sshd-backed integration tests spin up their own isolated box).

- [ ] **Step 2: Whole-branch review**

Run `git diff main...HEAD` and read it end to end against the spec (superpowers:requesting-code-review). Specifically re-check, because past features shipped with each of these: (1) every new fetch layer routes through `http.ts` (`test/webHttp.test.js` enforces it); (2) `readdressBox` is only ever called after `setLxcConfig` succeeded; (3) no test proves nothing — each failure-path test asserts the *absence* of the calls that must not happen.

- [ ] **Step 3: Candidate deploy to the live app (server-touching feature)**

Per the `validate-on-live-before-ship` memory: this feature touches `src/server`, so a dist swap is not enough. Gate on no running jobs first:

```bash
cd /root/tmuxifier
for f in setup-jobs provision-jobs proxmox-lifecycle-jobs fleet-jobs voice-jobs apk-build-jobs; do node -e "const j=require('./data/$f.json');const r=(Array.isArray(j)?j:j.jobs||[]).filter(x=>x.status==='running');if(r.length){console.log('$f running:',r.length);process.exit(1)}" 2>/dev/null || true; done
```

Then check out the branch head as a candidate branch in the main checkout (a different branch name than the worktree's), rsync the worktree's `dist/`, restart, and verify one hashed asset end-to-end:

```bash
WT=<absolute path of the worktree>
git -C /root/tmuxifier checkout -b candidate-readdress "$(git -C "$WT" rev-parse HEAD)"
rsync -a --delete "$WT/dist/" /root/tmuxifier/dist/
sudo systemctl restart tmuxifier && systemctl status tmuxifier --no-pager | head -5
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
ASSET="$(ls dist/assets/*.js | head -1 | xargs basename)"
curl -sk -o /dev/null -w '%{content_type}\n' "$BASE/assets/$ASSET"   # expect application/javascript
```

- [ ] **Step 4: Validate on a disposable container**

Ask the user which container to use, or provision a throwaway one from an `auto-static` preset. Then, in the live app: Proxmox hub → Guests → **Re-address** on it → confirm the "Now:" line matches `pct config <vmid>` on the node → pick a VLAN → confirm the next-free preview → Apply → watch the job reach `done`. Verify on the node with `pct config <vmid> | grep net0`, in NetBox that the old record is gone and the new one is `active` with the expected `dns_name`, that the box's sidebar row shows the new host and goes green, and that an open terminal reconnected. Then re-address it back to the original VLAN to prove the round trip, and finally deprovision the throwaway container if one was created.

- [ ] **Step 5: Merge and ship**

Only after the user validates: `git -C /root/tmuxifier checkout main`, merge the branch (superpowers:finishing-a-development-branch), delete `candidate-readdress`, and run the CLAUDE.md shipping checklist (version bump → build → gated restart → health check → PII-scrubbed commit → tag → push → GitHub release).
