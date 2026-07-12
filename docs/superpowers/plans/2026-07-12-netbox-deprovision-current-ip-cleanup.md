# Deprovision NetBox cleanup by current IP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deprovision deletes every NetBox ip-address record matching the box's current IP — including manually created records — not just the id stamped by auto-static provisioning.

**Architecture:** One new method on the existing `createNetboxClient` (`findIpsByAddress`), and an extended `releaseNetboxIp` in `proxmoxLifecycle.js` that releases the stamped id first, then sweeps all records matching `box.host` when it is an IP literal. Everything stays best-effort and job-logged; no route or UI changes.

**Tech Stack:** Node 20 ESM, vitest, dependency-injected factories (real code, no mocks).

**Spec:** `docs/superpowers/specs/2026-07-12-netbox-deprovision-current-ip-cleanup-design.md`

## Global Constraints

- Tests use real factories with injected fakes (`request`, `makeNetboxClient`), never module mocks.
- NetBox failures must never fail a deprovision job (container is already destroyed).
- Boxes with no NetBox involvement must not gain job-log noise; unconfigured NetBox stays silent unless a stamped id is being dropped.
- Public repo: placeholder IPs/domains only (`192.168.x.x`, `netbox.example.com`).

---

### Task 1: `findIpsByAddress` on the NetBox client

**Files:**
- Modify: `src/server/netboxApi.js` (inside the object returned by `createNetboxClient`, after `allocateIp`)
- Test: `test/netboxApi.test.js`

**Interfaces:**
- Consumes: the client's private `call(method, path)` helper.
- Produces: `findIpsByAddress(address: string) → Promise<Array<{id, address}>>` — GET `/api/ipam/ip-addresses/?address=<enc>`; `[]` when no match; throws `NetBox API error <status>` on non-2xx (Task 2 relies on the name, the array shape, and the throw).

- [x] **Step 1: Write the failing tests** (append to `test/netboxApi.test.js`, reusing its `NB` settings const)

```js
test('findIpsByAddress GETs the host-address filter and maps results', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => {
    calls.push(o);
    return { status: 200, json: { count: 2, results: [
      { id: 42, address: '192.168.3.7/24', status: { value: 'active' } },
      { id: 43, address: '192.168.3.7/32' },
    ] }, text: '' };
  } });
  await expect(client.findIpsByAddress('192.168.3.7')).resolves.toEqual([
    { id: 42, address: '192.168.3.7/24' },
    { id: 43, address: '192.168.3.7/32' },
  ]);
  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toContain('/api/ipam/ip-addresses/?address=192.168.3.7');
});

test('findIpsByAddress returns [] on no match and throws on API errors', async () => {
  const empty = createNetboxClient(NB, { request: async () => ({ status: 200, json: { count: 0, results: [] }, text: '' }) });
  await expect(empty.findIpsByAddress('192.168.3.9')).resolves.toEqual([]);
  const down = createNetboxClient(NB, { request: async () => ({ status: 500, json: null, text: '' }) });
  await expect(down.findIpsByAddress('192.168.3.9')).rejects.toThrow('NetBox API error 500');
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run test/netboxApi.test.js`
Expected: 2 new tests FAIL with `client.findIpsByAddress is not a function`.

- [x] **Step 3: Implement** (in `src/server/netboxApi.js`, after `allocateIp` in the returned object)

```js
    // A mask-less ?address= filter matches on host address regardless of the
    // record's prefix length, so one query catches /24 and /32 twins.
    async findIpsByAddress(address) {
      const data = await call('GET', `/ipam/ip-addresses/?address=${encodeURIComponent(address)}`);
      return ((data && data.results) || []).map((rec) => ({ id: rec.id, address: rec.address }));
    },
```

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run test/netboxApi.test.js`
Expected: all PASS.

---

### Task 2: current-IP sweep in `releaseNetboxIp`

**Files:**
- Modify: `src/server/proxmoxLifecycle.js:1` (import), `src/server/proxmoxLifecycle.js:103-121` (`releaseNetboxIp`)
- Test: `test/proxmoxLifecycle.test.js` (new tests after line 443; add `findIpsByAddress: async () => []` stubs to the four existing netbox-client fakes at lines 370, 405, 420 so their job logs stay clean)

**Interfaces:**
- Consumes: `findIpsByAddress` / `releaseIp` from Task 1; `box.host` (validated by `SAFE_HOST`, so hostname or IPv4 literal); `box.proxmox.netboxIpId`.
- Produces: unchanged signature `releaseNetboxIp(job, box)`; new job-log lines `# released NetBox ip <id> (<address>)`, `# no NetBox ip record matches <ip>`, `# could not look up NetBox ip records for <ip>: <err>`.

- [x] **Step 1: Write the failing tests** (append to `test/proxmoxLifecycle.test.js`; `nbSettings`, `BOX`, `BOX_WITH_IP` already exist)

```js
test('deprovision of a manually linked box deletes the NetBox record matching its current IP', async () => {
  const lookups = [];
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async (ip) => { lookups.push(ip); return [{ id: 42, address: '192.168.1.10/24' }]; },
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(lookups).toEqual(['192.168.1.10']);
  expect(released).toEqual([42]);
  expect(done.log).toContain('released NetBox ip 42 (192.168.1.10/24)');
});

test('every record matching the current IP is deleted; one failure does not stop the rest', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [
        { id: 42, address: '192.168.1.10/24' },
        { id: 43, address: '192.168.1.10/32' },
        { id: 44, address: '192.168.1.10/25' },
      ],
      releaseIp: async (id) => { if (id === 43) throw new Error('locked'); released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(released).toEqual([42, 44]);
  expect(done.log).toContain('could not release NetBox ip 43 (192.168.1.10/32): locked');
  expect(done.log).toContain('released NetBox ip 44 (192.168.1.10/25)');
});

test('a stamped allocation and a same-IP manual record are both released', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [{ id: 42, address: '192.168.1.10/32' }],
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(released).toEqual([99, 42]);
  const log = manager.getJob(job.id).log;
  expect(log).toContain('released NetBox ip 99');
  expect(log).toContain('released NetBox ip 42 (192.168.1.10/32)');
});

test('no matching record on an unstamped box logs the miss', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [],
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(released).toEqual([]);
  expect(manager.getJob(job.id).log).toContain('no NetBox ip record matches 192.168.1.10');
});

test('a stamped release followed by an empty sweep does not log a no-match line', async () => {
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ findIpsByAddress: async () => [], releaseIp: async () => {} }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const log = manager.getJob(job.id).log;
  expect(log).toContain('released NetBox ip 99');
  expect(log).not.toContain('no NetBox ip record matches');
});

test('a failing IP lookup never fails the deprovision job', async () => {
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => { throw new Error('netbox down'); },
      releaseIp: async () => { throw new Error('releaseIp must not run'); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(manager.getJob(job.id).log).toContain('could not look up NetBox ip records for 192.168.1.10: netbox down');
});

test('a hostname-hosted box without a stamp never touches NetBox', async () => {
  let touched = 0;
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? { ...BOX, host: 'dev-01.lan' } : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => { touched += 1; return {}; },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(touched).toBe(0);
  expect(manager.getJob(job.id).log).not.toContain('NetBox');
});
```

- [x] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: 5 of the 7 new tests FAIL (no sweep yet: nothing released for unstamped boxes, no new log lines). Two are guard tests that already pass — the stamped-release/no-noise test and the hostname-skip test — they pin the conditionals against a naive sweep (unconditional no-match logging, client creation for hostname boxes). All pre-existing tests still PASS.

- [x] **Step 3: Implement** — in `src/server/proxmoxLifecycle.js`, add the import and replace `releaseNetboxIp`:

```js
import { isIP } from 'node:net';
```

```js
  // Best-effort IPAM cleanup: release the auto-static allocation by its
  // stamped id, then delete every record matching the box's current IP so a
  // manually created NetBox record doesn't outlive the container. A NetBox
  // failure must never fail a deprovision whose container is already
  // destroyed — log it and let local cleanup finish.
  async function releaseNetboxIp(job, box) {
    const ipId = box?.proxmox?.netboxIpId;
    const hostIp = isIP(String(box?.host || '')) ? box.host : null;
    if ((!ipId && !hostIp) || !netboxStore) return;
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch { settings = null; }
    if (!settings) {
      if (ipId) { appendLog(job, `# could not release NetBox ip ${ipId}: NetBox integration not configured\n`); persist(); }
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
```

Also add `findIpsByAddress: async () => []` to the existing single-purpose netbox-client fakes in `test/proxmoxLifecycle.test.js` (the `releaseIp`-only objects at the tests on lines 357, 393, 413) so those jobs' logs don't gain a `could not look up` line from a missing method.

- [x] **Step 4: Run to verify everything passes**

Run: `npx vitest run test/proxmoxLifecycle.test.js`
Expected: all PASS (pre-existing + 7 new).

---

### Task 3: docs + full suite

**Files:**
- Modify: `CLAUDE.md:141`, `AGENTS.md:141` (lifecycle bullet), `README.md:293` (provisioning paragraph)

- [x] **Step 1: Update the three docs**

CLAUDE.md/AGENTS.md lifecycle bullet — replace:
`deprovision releases the box's NetBox-allocated IP (best-effort).`
with:
`deprovision releases the box's NetBox-allocated IP and deletes any remaining NetBox records matching the box's current IP, so manually created records don't go stale (best-effort).`

README.md — replace `and releases it if provisioning fails or when the container is deprovisioned`
with `and releases it if provisioning fails or when the container is deprovisioned — deprovision also deletes any manually created NetBox record matching the box's current IP`.

- [x] **Step 2: Full verification**

Run: `npm test`
Expected: typecheck + all vitest suites PASS.

- [x] **Step 3: Live read-only check of the filter assumption**

Query the real NetBox (`GET /api/ipam/ip-addresses/?address=<known ip>` without mask, via the repo client or MCP) and confirm the record with a mask (e.g. `/24`) is returned.

- [ ] **Step 4: Commit (owner approval required — harness rule: commit only when asked)**

```bash
git add -A && git diff --cached   # PII scrub per CLAUDE.md
git commit -m "feat(netbox): deprovision deletes NetBox records matching the box's current IP"
```
