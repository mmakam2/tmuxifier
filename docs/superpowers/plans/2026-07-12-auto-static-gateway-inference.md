# Auto-Static Gateway Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-static provisioning infers the gateway as the NetBox prefix's first usable IP and never allocates that address (fixes the live bug where an unregistered gateway was handed out as the container IP); the preset keeps only the VLAN.

**Architecture:** `netboxApi.js` gains a pure `firstUsableIp` helper and a gateway-aware `allocateIp` (GET the available list → skip the gateway → POST the specific address); `proxmoxParams` gains a gateway override; provisioning threads `res.gateway` into net0 and the job; validation/normalize drop the preset gateway for auto-static; the preset form hides both CIDR and Gateway for auto-static.

**Tech Stack:** Node 20+ ESM, vitest (fakes injected), TypeScript web client.

**Spec:** `docs/superpowers/specs/2026-07-12-auto-static-gateway-inference-design.md`

## Global Constraints

- Gateway inference rule: first usable IPv4 host of the prefix (network + 1). `/31` and `/32` throw `prefix <cidr> is too small for auto-static` — before any reservation.
- Exhaustion and gateway-only-left produce the SAME message: `prefix <prefix> has no available IPs`.
- Atomicity trade-off documented in code: GET-then-POST; a concurrent duplicate makes NetBox reject the POST → job errors cleanly, retry succeeds.
- Backward compatibility: existing auto-static presets with a stored gateway keep working — validation no longer requires it, provisioning ignores it (inferred value always wins for auto-static), normalize nulls it on next save. `static` presets are byte-identical in behavior (no override passed → `net.gateway` used).
- Token containment unchanged: no new log/error may embed the token (new strings carry addresses/prefixes/ids only).
- No NUL-escape files are touched by this plan (verify: the diff must not include `proxmoxLifecycle.js`/`proxmoxInventory.js`/`store.js`).
- Gate per task: named vitest files green; Task 3 runs `npm test` (baseline 664; growth only) + build + browser check.

---

### Task 1: `firstUsableIp` + gateway-aware `allocateIp`

**Files:**
- Modify: `src/server/netboxApi.js` (new exported helper; `allocateIp` body replaced)
- Test: `test/netboxApi.test.js` (the two existing `allocateIp` tests are REWRITTEN to the new contract; everything else untouched)

**Interfaces:**
- Produces: `export function firstUsableIp(prefixCidr: string): string` (throws on unparseable or `/31`+`/32`); `allocateIp(prefix, fields)` now resolves `{ id, address, gateway }` — `gateway` is the bare IP string. `findPrefixByVlan`/`releaseIp`/`testNetbox` unchanged.

- [ ] **Step 1: Rewrite/append the failing tests**

In `test/netboxApi.test.js`: REPLACE the two existing allocateIp tests (`'allocateIp POSTs a JSON body and returns id+address; empty result means prefix full'` and the real-server POST test's allocate usage — read them first; the real-server test now exercises the new two-call flow) and APPEND the helper matrix. New/updated tests:

```js
test('firstUsableIp: network + 1, and tiny prefixes are rejected', async () => {
  expect(firstUsableIp('192.168.3.0/24')).toBe('192.168.3.1');
  expect(firstUsableIp('10.20.0.0/16')).toBe('10.20.0.1');
  expect(firstUsableIp('192.168.3.128/30')).toBe('192.168.3.129');
  expect(firstUsableIp('192.168.3.77/24')).toBe('192.168.3.1'); // non-canonical base normalizes
  expect(() => firstUsableIp('192.168.3.0/31')).toThrow(/too small/);
  expect(() => firstUsableIp('192.168.3.4/32')).toThrow(/too small/);
  expect(() => firstUsableIp('not-a-prefix')).toThrow(/unparseable/);
});

test('allocateIp skips the gateway and reserves the first other available address', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => {
    calls.push(o);
    if (o.method === 'GET') return { status: 200, json: [{ address: '192.168.3.1/24' }, { address: '192.168.3.5/24' }], text: '' };
    return { status: 201, json: { id: 99, address: '192.168.3.5/24' }, text: '' };
  } });
  const res = await client.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, { status: 'active', description: 'tmuxifier: dev-01' });
  expect(res).toEqual({ id: 99, address: '192.168.3.5/24', gateway: '192.168.3.1' });
  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/7/available-ips/');
  expect(calls[1].method).toBe('POST');
  expect(calls[1].url).toBe('https://netbox.example.com/api/ipam/ip-addresses/');
  expect(calls[1].body).toEqual({ address: '192.168.3.5/24', status: 'active', description: 'tmuxifier: dev-01' });
});

test('allocateIp: only the gateway left (or nothing) means prefix full', async () => {
  const gwOnly = createNetboxClient(NB, { request: async () => ({ status: 200, json: [{ address: '192.168.3.1/24' }], text: '' }) });
  await expect(gwOnly.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, {})).rejects.toThrow('prefix 192.168.3.0/24 has no available IPs');
  const empty = createNetboxClient(NB, { request: async () => ({ status: 200, json: [], text: '' }) });
  await expect(empty.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, {})).rejects.toThrow('has no available IPs');
});
```

Update the real-local-server test (the one asserting fixed Content-Length): its handler now serves the GET (list with a non-gateway address) and the POST (echo id+address); the Content-Length assertions move to the POST request it records. Update the file's import line to include `firstUsableIp`.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/netboxApi.test.js`
Expected: new/rewritten tests FAIL (`firstUsableIp` not exported; old single-POST allocate behavior); all non-allocate tests still pass.

- [ ] **Step 3: Implement**

In `src/server/netboxApi.js`, add above `createNetboxClient`:

```js
// First usable IPv4 host of a prefix (network address + 1): the conventional
// gateway. auto-static infers its gateway from this and never allocates it.
// Networks with a different gateway convention use the `static` preset mode.
export function firstUsableIp(prefixCidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(prefixCidr));
  if (!m) throw new Error(`unparseable prefix: ${prefixCidr}`);
  const len = Number(m[5]);
  if (len > 30) throw new Error(`prefix ${prefixCidr} is too small for auto-static`);
  const value = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  const first = ((value & mask) >>> 0) + 1;
  return [(first >>> 24) & 255, (first >>> 16) & 255, (first >>> 8) & 255, first & 255].join('.');
}
```

Replace `allocateIp` in the returned client object:

```js
    async allocateIp(prefix, fields) {
      const gateway = firstUsableIp(prefix.prefix);
      // GET-then-POST instead of NetBox's atomic next-free POST: the atomic
      // endpoint happily hands out an unregistered gateway address (bit us in
      // production). A concurrent duplicate reservation makes NetBox reject
      // the POST -> the job errors cleanly and a retry succeeds; acceptable
      // for a single-user tool.
      const avail = await call('GET', `/ipam/prefixes/${encodeURIComponent(prefix.id)}/available-ips/`);
      const list = Array.isArray(avail) ? avail : [];
      const pick = list.find((item) => item && item.address && String(item.address).split('/')[0] !== gateway);
      if (!pick) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      const created = await call('POST', '/ipam/ip-addresses/', { address: pick.address, ...fields });
      if (!created || !created.address) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: created.id, address: created.address, gateway };
    },
```

- [ ] **Step 4: GREEN**

Run: `npx vitest run test/netboxApi.test.js`
Expected: PASS (all, including the untouched testNetbox/pin/token tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "fix(netbox): infer the prefix gateway and never allocate it"
```

---

### Task 2: Server plumbing — gateway override through params, provision, validation

**Files:**
- Modify: `src/server/proxmoxParams.js` (`buildNet0` + `buildCreateParams` signatures)
- Modify: `src/server/proxmoxProvision.js:89-101` (allocate block + create call + job shape)
- Modify: `src/server/proxmoxValidate.js:74-77` (drop the auto-static gateway requirement)
- Modify: `src/server/proxmoxStore.js:16` (normalize gateway null for auto-static)
- Test: `test/proxmoxParams.test.js`, `test/proxmoxProvision.test.js`, `test/proxmoxValidate.test.js`, `test/proxmoxStore.test.js`

**Interfaces:**
- Consumes: `allocateIp → { id, address, gateway }` (Task 1).
- Produces: `buildNet0(net, ipOverride, gwOverride)`; `buildCreateParams(preset, { vmid, hostname, ip, gateway, publicKeys, password })`; job shape gains `gateway: null`; allocate log line becomes `# allocated <address> from <prefix> (gw <gateway>, NetBox ip <id>)`.

- [ ] **Step 1: Write/update the failing tests**

`test/proxmoxParams.test.js` — append:

```js
test('auto-static net0 takes both overrides; static keeps its stored gateway', () => {
  const autoNet = { bridge: 'vmbr0', vlan: 3, ipMode: 'auto-static', cidr: null, gateway: null };
  expect(buildNet0(autoNet, '192.168.3.5/24', '192.168.3.1'))
    .toBe('name=eth0,bridge=vmbr0,tag=3,ip=192.168.3.5/24,gw=192.168.3.1');
  const staticNet = { bridge: 'vmbr0', vlan: null, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' };
  expect(buildNet0(staticNet, undefined, undefined))
    .toBe('name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1');
});
```

`test/proxmoxValidate.test.js` — update the auto-static test: `{ vlan: 30 }` alone (no gateway) must now PASS; the without-gateway rejection assertion is removed; without-vlan still rejects.

`test/proxmoxStore.test.js` — extend the auto-static persistence test: a supplied `gateway: '192.168.30.1'` comes back `null` (alongside the existing cidr-null assertion).

`test/proxmoxProvision.test.js` — update `fakeNetbox` so `allocateIp` resolves `{ id: 99, address: '192.168.30.50/24', gateway: '192.168.30.1' }`, and in the happy-path auto-static test assert:

```js
  expect(createCalls[0].net0).toContain('ip=192.168.30.50/24');
  expect(createCalls[0].net0).toContain('gw=192.168.30.1');
  expect(done.gateway).toBe('192.168.30.1');
  expect(done.log).toContain('gw 192.168.30.1');
```

(Also set `PRESET_AUTO`'s `net.gateway` to `null` — the preset no longer stores one — and keep one variant asserting a legacy preset WITH a stored gateway still provisions using the INFERRED value from the fake, i.e. net0 `gw=192.168.30.1` even when the preset says something else, e.g. `gateway: '192.168.30.254'`.)

- [ ] **Step 2: RED**

Run: `npx vitest run test/proxmoxParams.test.js test/proxmoxValidate.test.js test/proxmoxStore.test.js test/proxmoxProvision.test.js`
Expected: the updated tests FAIL against current code.

- [ ] **Step 3: Implement**

`src/server/proxmoxParams.js`:

```js
export function buildNet0(net, ipOverride, gwOverride) {
  const parts = ['name=eth0', `bridge=${net.bridge}`];
  if (net.vlan) parts.push(`tag=${net.vlan}`);
  // auto-static stores neither cidr nor gateway — the provision flow allocates
  // an address from NetBox and infers the gateway (prefix's first usable IP),
  // passing both as overrides so this takes the same ip/gw branch as static.
  if (net.ipMode === 'static' || net.ipMode === 'auto-static') {
    parts.push(`ip=${ipOverride || net.cidr}`);
    const gw = gwOverride || net.gateway;
    if (gw) parts.push(`gw=${gw}`);
  } else {
    parts.push('ip=dhcp');
  }
  return parts.join(',');
}
```

and thread it through `buildCreateParams`:

```js
export function buildCreateParams(preset, { vmid, hostname, ip, gateway, publicKeys, password }) {
  …
    net0: buildNet0(preset.net, ip, gateway),
  …
```

`src/server/proxmoxValidate.js` — the auto-static branch loses its gateway line:

```js
  if (net.ipMode === 'auto-static') {
    if (!intInRange(net.vlan, 1, 4094)) throw new Error('auto-static requires a vlan (1..4094) to find the NetBox prefix');
  }
```

`src/server/proxmoxStore.js:16` — the `net:` line's gateway expression:

```js
    net: { bridge: net.bridge, vlan: net.vlan ?? null, ipMode: net.ipMode, cidr: net.ipMode === 'auto-static' ? null : (net.cidr ?? null), gateway: net.ipMode === 'auto-static' ? null : (net.gateway ?? null) },
```

`src/server/proxmoxProvision.js` — the allocate block gains the gateway (after the `isCidr` guard/`j.ip` assignment):

```js
        j.ip = res.address;
        j.gateway = res.gateway;
        appendLog(j, `# allocated ${res.address} from ${prefix.prefix} (gw ${res.gateway}, NetBox ip ${res.id})\n`);
```

the create call threads it:

```js
      const params = buildCreateParams(preset, { vmid: j.vmid, hostname: j.hostname, ip: j.ip, gateway: j.gateway, publicKeys, password });
```

and the job initializer in `createProvision` gains `gateway: null,` next to `netboxIpId: null,`.

- [ ] **Step 4: GREEN + boot check**

Run: `npx vitest run test/proxmoxParams.test.js test/proxmoxValidate.test.js test/proxmoxStore.test.js test/proxmoxProvision.test.js && node -e "import('./src/server/server.js').then(()=>console.log('imports ok'))"`
Expected: PASS; `imports ok`.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxParams.js src/server/proxmoxProvision.js src/server/proxmoxValidate.js src/server/proxmoxStore.js test/proxmoxParams.test.js test/proxmoxProvision.test.js test/proxmoxValidate.test.js test/proxmoxStore.test.js
git commit -m "feat(proxmox): thread the inferred gateway through auto-static provisioning"
```

---

### Task 3: UI, docs, full suite

**Files:**
- Modify: `src/web/proxmoxPresets.ts` (the `syncNetwork` block)
- Modify: `README.md:290` (and any other gateway-for-auto-static claims); `CLAUDE.md`/`AGENTS.md` only if their auto-static wording mentions the preset gateway (grep first; keep mirrors byte-identical)

**Interfaces:** none new — UI/docs only.

- [ ] **Step 1: Preset form**

In `src/web/proxmoxPresets.ts`, the `syncNetwork` block: auto-static now hides the whole cidr/gateway grid (delete the `cidrField.style.display` inner toggle — static shows both fields, dhcp and auto-static show neither) and the hint text changes:

```ts
    const syncNetwork = () => {
      const mode = ipMode.value;
      cidrGateway.style.display = mode === 'static' ? '' : 'none';
      vlan.placeholder = mode === 'auto-static' ? 'vlan (required)' : 'vlan (optional)';
      autoHint.textContent = mode === 'auto-static'
        ? `IP + gateway auto-derived from the NetBox prefix for VLAN ${vlan.value || 'N'}.${netboxConfigured ? '' : ' — configure NetBox in Settings first'}`
        : '';
    };
```

(`cidrField`/`gatewayField` consts stay — they still structure the grid.)

- [ ] **Step 2: Docs**

- `README.md:290`: "`auto-static` — pick a VLAN + gateway on the preset and Tmuxifier …" → rewrite the clause: pick a VLAN on the preset; Tmuxifier reserves the next free address from the VLAN's NetBox prefix and infers the gateway as the prefix's first usable IP (never allocating it). Keep the release-on-failure/deprovision wording intact. Grep the rest of README's auto-static text for stale gateway mentions.
- `grep -n "gateway" CLAUDE.md AGENTS.md` — the current architecture bullets don't mention the preset gateway; only edit if a claim is now false, and mirror byte-identically if so.

- [ ] **Step 3: Gate + browser check**

Run: `npm run typecheck && npm run build && npm test` — expect ≥ 664 + growth, typecheck clean.

Scripted Playwright check (throwaway under `.superpowers/`, mocked `**/api/**`, fresh port ≥7459, established pattern; delete after): preset editor → select `auto-static (NetBox)` → CIDR **and** Gateway both hidden, vlan placeholder `vlan (required)`, hint reads `IP + gateway auto-derived…`; select `static` → both fields visible again. Print assertions; screenshot; READ the screenshot; delete artifacts.

- [ ] **Step 4: PII scan**

Run: `git diff main | grep -E '^\+' | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | sort -u` — RFC1918/placeholders only.

- [ ] **Step 5: Commit**

```bash
git add src/web/proxmoxPresets.ts README.md CLAUDE.md AGENTS.md
git commit -m "feat(ui): auto-static presets need only a VLAN — gateway is inferred"
```

(Drop CLAUDE.md/AGENTS.md from the `git add` if Step 2 left them untouched.)
