# Relink-by-endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inventory sweep re-homes a box's dangling Proxmox link to a re-added host profile whose endpoint matches the one stamped on the link.

**Architecture:** One new function (`healGroup`) inside `createProxmoxInventory`, called from `fetchHost`'s missing-host branch, per the spec (`docs/superpowers/specs/2026-07-12-relink-by-endpoint-design.md`). Reuses the node auto-follow's guard + CAS discipline; healed boxes re-enter `fetchHost` so the same sweep returns live records.

**Tech Stack:** Node 20 ESM server, vitest (node env), injected fakes (no mocks).

## Global Constraints

- Public repo: placeholders only (`example.com`, RFC1918 IPs).
- Tests use real code with injected fakes; never module mocks.
- Every heal failure mode degrades to today's `error: 'host profile missing'` record; the sweep never throws.
- Commit only with owner approval (autonomous-session harness rule).

---

### Task 1: `healGroup` in the inventory sweep

**Files:**
- Modify: `src/server/proxmoxInventory.js:53` (the `if (!host)` branch) + new `healGroup` function above `fetchHost`
- Test: `test/proxmoxInventory.test.js` (append)

**Interfaces:**
- Consumes: existing `proxmoxStore.listHosts()` (redacted `{ id, name, endpoint, ... }[]`), `proxmoxStore.getHost(id, { withSecret: true })`, `boxStore.getBox` / `boxStore.setProxmoxLink`, `activeJobGuard`, `record`, `makeClient`, `log`.
- Produces: no new exports — behavior only.

- [x] **Step 1: Write the tests (one failing, six guards)**

Append to `test/proxmoxInventory.test.js`:

```js
// --- relink-by-endpoint heal: a removed-then-re-added host gets a new id; the
// sweep re-homes orphaned links whose stamped endpoint matches exactly one host.
const READDED = { id: 'H9', name: 'lab-readded', endpoint: HOST.endpoint, tokenSecret: 'sek' };
function healSetup({ hosts = [READDED], cluster = [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' }], boxStore, guard } = {}) {
  const writes = [];
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      getHost: async (id) => hosts.find((h) => h.id === id), // the old H1 profile is gone
      listHosts: async () => hosts,
    },
    makeClient: () => ({ clusterResources: async () => cluster }),
    boxStore: boxStore === null ? null : { getBox: async () => null, setProxmoxLink: async (id, link) => writes.push([id, link]), ...boxStore },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, writes, logged };
}

test('an orphaned link re-homes to the unique host with the same endpoint (netboxIpId preserved)', async () => {
  const box = linked('b1', 'pve', 131);
  box.proxmox.netboxIpId = 99;
  const { inventory, writes, logged } = healSetup({ boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([['b1', { hostId: 'H9', node: 'pve', vmid: 131, endpoint: HOST.endpoint, netboxIpId: 99 }]]);
  expect(record).toMatchObject({ state: 'running', hostId: 'H9', hostName: 'lab-readded', containerName: 'dev-01', error: null });
  expect(logged.some((line) => line.includes('re-homed'))).toBe(true);
});

test('an ambiguous endpoint (two matching hosts) never guesses', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ hosts: [READDED, { ...READDED, id: 'H8', name: 'twin' }], boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ state: 'unknown', hostId: 'H1', error: 'host profile missing' });
});

test('the heal requires the vmid to exist on the candidate cluster', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ cluster: [], boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('the heal is skipped while a lifecycle job is active on the box', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ boxStore: { getBox: async () => box }, guard: (boxId) => boxId === 'b1' });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('the heal is skipped if the user re-linked the box mid-poll (CAS re-check)', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({
    boxStore: { getBox: async () => ({ ...box, proxmox: { ...box.proxmox, hostId: 'H7' } }) },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('a link without a stamped endpoint stays orphaned', async () => {
  const box = linked('b1', 'pve', 131);
  delete box.proxmox.endpoint;
  const { inventory, writes } = healSetup({ boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('without a boxStore the orphan is only reported, never healed', async () => {
  const { inventory } = healSetup({ boxStore: null });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record).toMatchObject({ state: 'unknown', error: 'host profile missing' });
});
```

- [x] **Step 2: Run tests to verify the expected failure pattern**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: the happy-path test FAILS (record still `host profile missing`, no write). The six other new tests are guards that already pass against current behavior. All pre-existing tests pass.

- [x] **Step 3: Implement `healGroup`**

In `src/server/proxmoxInventory.js`, add above `fetchHost`:

```js
  // A removed-then-re-added host profile gets a new id, stranding links on the
  // old one. Every link stamps the host endpoint, so an orphaned group can
  // re-home to the unique current host with the same endpoint — verified
  // against that cluster (the vmid must exist) and written with the same
  // CAS + active-job guards as the node auto-follow. Ambiguity (zero or 2+
  // endpoint matches) never guesses; every failure mode degrades to the
  // plain "host profile missing" report.
  async function healGroup(hostBoxes) {
    const orphan = (box) => record(box, { error: 'host profile missing' });
    if (!boxStore) return hostBoxes.map(orphan);
    let hosts;
    try { hosts = await proxmoxStore.listHosts(); } catch { hosts = []; }
    const results = [];
    const byCandidate = new Map();
    for (const box of hostBoxes) {
      const endpoint = box.proxmox.endpoint;
      const matches = endpoint ? hosts.filter((h) => h.endpoint === endpoint) : [];
      if (matches.length !== 1 || activeJobGuard(box.id)) { results.push(orphan(box)); continue; }
      if (!byCandidate.has(matches[0].id)) byCandidate.set(matches[0].id, []);
      byCandidate.get(matches[0].id).push(box);
    }
    for (const [candidateId, candidateBoxes] of byCandidate) {
      let host = null;
      let guests = null;
      try {
        host = await proxmoxStore.getHost(candidateId, { withSecret: true });
        guests = host ? await makeClient(host).clusterResources() : null;
      } catch { guests = null; }
      if (!guests) { results.push(...candidateBoxes.map(orphan)); continue; }
      const present = new Set(guests.filter((g) => g.type === 'lxc').map((g) => Number(g.vmid)));
      const healed = [];
      for (const box of candidateBoxes) {
        if (!present.has(Number(box.proxmox.vmid))) { results.push(orphan(box)); continue; }
        try {
          const fresh = await boxStore.getBox(box.id);
          const freshLink = fresh && fresh.proxmox;
          const stillOrphaned = freshLink
            && freshLink.hostId === box.proxmox.hostId
            && Number(freshLink.vmid) === Number(box.proxmox.vmid);
          if (!stillOrphaned) { results.push(orphan(box)); continue; }
          const link = { ...freshLink, hostId: candidateId };
          await boxStore.setProxmoxLink(box.id, link);
          log(`[tmuxifier] box ${box.label}: host profile re-added as '${host.name}' — re-homed link by endpoint ${freshLink.endpoint}`);
          healed.push({ ...box, proxmox: link });
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not re-home link: ${error.message}`);
          results.push(orphan(box));
        }
      }
      if (healed.length) results.push(...await fetchHost(candidateId, healed));
    }
    return results;
  }
```

And change the missing-host branch in `fetchHost`:

```js
    if (!host) return healGroup(hostBoxes);
```

- [x] **Step 4: Run tests to verify all pass**

Run: `npx vitest run test/proxmoxInventory.test.js`
Expected: PASS (all tests, old and new).

### Task 2: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` + `AGENTS.md` (`proxmoxInventory.js` bullet), `README.md` (Proxmox section)

**Interfaces:**
- Consumes: Task 1's behavior. Produces: nothing new.

- [x] **Step 1: Update docs**

Extend the `proxmoxInventory.js` bullet in `CLAUDE.md`/`AGENTS.md` — after "auto-follows node migrations by updating the stored link's node (guarded against active lifecycle jobs)" append "; re-homes an orphaned link when a removed host profile is re-added with the same endpoint (new id, exact `host:port` match, vmid verified on that cluster)". In `README.md`'s Proxmox host-setup area, add one sentence: removing and re-adding a host profile with the same endpoint automatically re-homes linked boxes on the next status poll.

- [x] **Step 2: Run the full suite**

Run: `npm test`
Expected: typecheck clean; all vitest files pass.

- [ ] **Step 3: Commit (owner approval required — harness rule: commit only when asked)**

```bash
git add -A
git diff --cached   # PII scrub
git commit -m "feat(proxmox): re-home orphaned box links when a host profile is re-added"
```

## Self-review

- Spec coverage: heal path → Task 1 Step 3; every guard in the spec's design/error-handling sections has a test in Step 1; docs → Task 2. No gaps.
- Placeholder scan: none; full code in every step.
- Type consistency: `healGroup(hostBoxes)` returns the same record array shape `fetchHost` produces; the write payload `{ ...freshLink, hostId }` matches the store's `setProxmoxLink(id, link)` used by the auto-follow; `READDED`/`linked`/`HOST` match the existing fixtures.
