# Proxmox LXC Provisioning Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tmuxifier create a "canned" LXC container on a Proxmox VE host over the PVE HTTP API and auto-add a Tmuxifier box pointed at it, so the user gets a browser terminal on a freshly provisioned container.

**Architecture:** Five new injectable-factory server modules (encryption, validation, profile/preset store, PVE API client, provision manager) plus a debounced job store, wired into the existing Fastify app under `/api/proxmox/*` and the existing `index.js`. A provision is a server-held **job** polled by the browser (the Fleet pattern). Two new web modules hold the UI so `main.ts` barely grows. The Proxmox API **token** is the first persisted credential: AES-256-GCM encrypted at rest in `data/proxmox.json`, key derived from the existing cookie secret, never sent to the browser.

**Tech Stack:** Node 20+ ESM, Fastify 4, `node:crypto` (HKDF + AES-256-GCM), `node:https` (PVE client + TLS pinning), Vitest (unit/integration, real code + dependency injection — no mocking library), TypeScript + Vite + xterm.js (web), Proxmox VE REST API (`/api2/json`).

Full design: `docs/superpowers/specs/2026-06-26-proxmox-lxc-provisioning-design.md`.

## Global Constraints

Every task's requirements implicitly include these (copied from the spec):

- **ESM everywhere** (`"type": "module"`), **Node 20+**. Server is plain `.js`; web client is `.ts`.
- **No new runtime dependencies.** Use built-in `node:crypto` and `node:https` only. (No `node-fetch`, no Proxmox SDK.)
- **Factory functions with injected dependencies** (`createX({...})`) — matches `createStore`, `createFleetManager`. Never read `process.env`/`process.cwd()` inside modules; `loadConfig` stays pure and takes `{ env, cwd }`.
- **TDD, real code + dependency injection, no mocking library.** Tests pass in-memory fakes/stubs as constructor args.
- **The token secret never reaches the browser.** REST returns redacted host views (`hasToken: true`, no `tokenSecret`); never log or export it.
- **Files holding secrets are written `0o600`** (like `.env`). `data/proxmox.json` qualifies.
- **No real PII anywhere committed** — use `example.com`, RFC1918 IPs (`192.168.1.0/24`), `you@example.com`, `user@pam!tmuxifier`. The repo is public.
- **Conventional-commit messages** (`feat(proxmox): …`, `test(proxmox): …`, `docs(proxmox): …`). Commit after every green task.
- **Encryption key source:** derive from `config.cookieSecret` via HKDF-SHA256 with info label `tmuxifier-pve-token-v1`. `requiredConfigError` already guarantees `cookieSecret` exists at boot.
- Run the full suite with `npm test` (Vitest). A single file: `npm test -- test/<file>`.

---

## File Structure

**New server modules (`src/server/`):**
- `secretBox.js` — `createSecretBox(cookieSecret)` → `{ seal, open, isSealed }` (AES-256-GCM).
- `proxmoxValidate.js` — pure validators/parsers shared by store + routes.
- `proxmoxStore.js` — `data/proxmox.json` CRUD for hosts/keys/presets; seals token, redacts on read.
- `proxmoxParams.js` — pure `buildNet0` / `buildCreateParams` (preset → PVE create params).
- `proxmoxApi.js` — `createProxmoxClient({host,request})` + `inspectEndpoint` over `node:https`.
- `provisionStore.js` — debounced persistence for `data/provision-jobs.json` (mirrors `fleetStore.js`).
- `proxmoxProvision.js` — `createProvisionManager({...})`; create→poll→start→discover→link orchestration.

**Modified server modules:**
- `config.js` — add `pve*` knobs.
- `server.js` — add `/api/proxmox/*` routes; extend `buildServer` deps.
- `index.js` — construct + wire the new modules.

**New web modules (`src/web/`):**
- `proxmox.ts` — TS types + `pve` fetch wrappers (mirrors `api.ts`).
- `proxmoxUi.ts` — the Proxmox hub modal (Hosts · Keys · Presets · Provision · History) + job panel.

**Modified web modules:**
- `main.ts` — header button + `openProxmoxHub()` call + open-box callback.

**New tests (`test/`):** `secretBox.test.js`, `proxmoxValidate.test.js`, `proxmoxStore.test.js`, `proxmoxParams.test.js`, `proxmoxApi.test.js`, `provisionStore.test.js`, `proxmoxProvision.test.js`. **Modified:** `config.test.js`, `server.test.js`.

**Docs:** `.env.example`, `README.md`, `CLAUDE.md`, `AGENTS.md`.

---

## Task 1: Config knobs

**Files:**
- Modify: `src/server/config.js` (DEFAULTS block ~5-32; envCfg block ~55-79)
- Modify: `src/server/.env.example` (append a Proxmox section)
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config.pvePollMs`, `config.pveTimeoutMs`, `config.pveProvisionTimeoutMs`, `config.pveLeaseTimeoutMs`, `config.pveMaxJobs` (all numbers).

- [ ] **Step 1: Write the failing test** — append to `test/config.test.js`:

```js
test('proxmox knobs have defaults and are overridable via env', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.pvePollMs).toBe(1500);
  expect(d.pveTimeoutMs).toBe(15000);
  expect(d.pveProvisionTimeoutMs).toBe(600000);
  expect(d.pveLeaseTimeoutMs).toBe(60000);
  expect(d.pveMaxJobs).toBe(50);
  const e = loadConfig({}, { env: {
    TMUXIFIER_PVE_POLL_MS: '500', TMUXIFIER_PVE_TIMEOUT_MS: '9000',
    TMUXIFIER_PVE_PROVISION_TIMEOUT_MS: '120000', TMUXIFIER_PVE_LEASE_TIMEOUT_MS: '30000',
    TMUXIFIER_PVE_MAX_JOBS: '10',
  }, cwd: '/app' });
  expect(e.pvePollMs).toBe(500);
  expect(e.pveTimeoutMs).toBe(9000);
  expect(e.pveProvisionTimeoutMs).toBe(120000);
  expect(e.pveLeaseTimeoutMs).toBe(30000);
  expect(e.pveMaxJobs).toBe(10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config.test.js`
Expected: FAIL — `expected undefined to be 1500`.

- [ ] **Step 3: Implement** — in `src/server/config.js`, add to the `DEFAULTS` object (after `fleetMaxOutputBytes`):

```js
  // Proxmox LXC provisioning (Phase 1). Poll cadence for PVE task progress, per-request
  // and overall-provision timeouts, DHCP-lease discovery window, and retained job history.
  pvePollMs: 1500,
  pveTimeoutMs: 15000,
  pveProvisionTimeoutMs: 600000,
  pveLeaseTimeoutMs: 60000,
  pveMaxJobs: 50,
```

Add to the `envCfg = clean({ ... })` object (after the `fleet*` lines):

```js
    pvePollMs: e.TMUXIFIER_PVE_POLL_MS ? Number(e.TMUXIFIER_PVE_POLL_MS) : undefined,
    pveTimeoutMs: e.TMUXIFIER_PVE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_TIMEOUT_MS) : undefined,
    pveProvisionTimeoutMs: e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS) : undefined,
    pveLeaseTimeoutMs: e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS) : undefined,
    pveMaxJobs: e.TMUXIFIER_PVE_MAX_JOBS ? Number(e.TMUXIFIER_PVE_MAX_JOBS) : undefined,
```

- [ ] **Step 4: Append docs to `.env.example`** (new section at the end):

```bash
# --- Proxmox LXC provisioning ------------------------------------------------
# Poll cadence (ms) for streaming a PVE create/start task's progress log.
#TMUXIFIER_PVE_POLL_MS=1500
# Per-request timeout (ms) for calls to the Proxmox API.
#TMUXIFIER_PVE_TIMEOUT_MS=15000
# Overall deadline (ms) for one provision (create + start + discover).
#TMUXIFIER_PVE_PROVISION_TIMEOUT_MS=600000
# How long (ms) to wait for a DHCP container to report a leased IP before
# finishing the job without an auto-linked box.
#TMUXIFIER_PVE_LEASE_TIMEOUT_MS=60000
# Retained provision-job history in data/provision-jobs.json (older pruned).
#TMUXIFIER_PVE_MAX_JOBS=50
# NOTE: the Proxmox API token is NOT stored here. It is encrypted at rest in
# data/proxmox.json, with the key derived from TMUXIFIER_COOKIE_SECRET.
```

- [ ] **Step 5: Run tests + commit**

Run: `npm test -- test/config.test.js`
Expected: PASS.

```bash
git add src/server/config.js src/server/.env.example test/config.test.js
git commit -m "feat(proxmox): add PVE provisioning config knobs"
```

> Note: `.env.example` lives at the repo root, not under `src/server/`. Use the actual path shown by `git status` if it differs.

---

## Task 2: Secret encryption (`secretBox.js`)

**Files:**
- Create: `src/server/secretBox.js`
- Test: `test/secretBox.test.js`

**Interfaces:**
- Produces: `createSecretBox(cookieSecret) -> { seal(plaintext:string)->string, open(sealed:string)->string, isSealed(v)->boolean }`. Sealed format: `pvebox.v1:<iv_b64>:<ct_b64>:<tag_b64>`.

- [ ] **Step 1: Write the failing test** — create `test/secretBox.test.js`:

```js
import { test, expect } from 'vitest';
import { createSecretBox } from '../src/server/secretBox.js';

test('round-trips a secret', () => {
  const box = createSecretBox('cookie-secret');
  const sealed = box.seal('PVEAPIToken=user@pam!t=uuid');
  expect(box.isSealed(sealed)).toBe(true);
  expect(sealed.startsWith('pvebox.v1:')).toBe(true);
  expect(box.open(sealed)).toBe('PVEAPIToken=user@pam!t=uuid');
});

test('produces a different ciphertext each time (random IV)', () => {
  const box = createSecretBox('cookie-secret');
  expect(box.seal('x')).not.toBe(box.seal('x'));
});

test('a tampered ciphertext fails authentication', () => {
  const box = createSecretBox('cookie-secret');
  const sealed = box.seal('secret');
  const parts = sealed.split(':');
  parts[2] = Buffer.from('different-bytes').toString('base64'); // swap ct
  expect(() => box.open(parts.join(':'))).toThrow();
});

test('a different cookie secret cannot open the sealed value', () => {
  const sealed = createSecretBox('secret-a').seal('hi');
  expect(() => createSecretBox('secret-b').open(sealed)).toThrow();
});

test('isSealed rejects plaintext and requires a cookie secret', () => {
  const box = createSecretBox('s');
  expect(box.isSealed('plain')).toBe(false);
  expect(() => createSecretBox('')).toThrow(/cookieSecret/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/secretBox.test.js`
Expected: FAIL — cannot find module `secretBox.js`.

- [ ] **Step 3: Implement** — create `src/server/secretBox.js`:

```js
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Versioned scheme tag so the store can recognise (and one day migrate) sealed values.
const SCHEME = 'pvebox.v1';
// Distinct HKDF info label keeps this key disjoint from cookie signing even though both
// derive from cookieSecret.
const INFO = 'tmuxifier-pve-token-v1';

function deriveKey(cookieSecret) {
  if (!cookieSecret) throw new Error('secretBox requires a cookieSecret');
  // HKDF-SHA256 -> 32 bytes for AES-256. hkdfSync returns an ArrayBuffer.
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(cookieSecret)), Buffer.alloc(0), Buffer.from(INFO), 32));
}

export function createSecretBox(cookieSecret) {
  const key = deriveKey(cookieSecret);
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return `${SCHEME}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
    },
    open(sealed) {
      const parts = String(sealed).split(':');
      if (parts.length !== 4 || parts[0] !== SCHEME) throw new Error('unrecognized sealed secret');
      const [, ivb, ctb, tagb] = parts;
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
      d.setAuthTag(Buffer.from(tagb, 'base64'));
      return d.update(Buffer.from(ctb, 'base64'), undefined, 'utf8') + d.final('utf8');
    },
    isSealed(v) {
      return typeof v === 'string' && v.startsWith(`${SCHEME}:`);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/secretBox.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/secretBox.js test/secretBox.test.js
git commit -m "feat(proxmox): add AES-256-GCM secretBox for token encryption at rest"
```

---

## Task 3: Validation + parsing (`proxmoxValidate.js`)

**Files:**
- Create: `src/server/proxmoxValidate.js`
- Test: `test/proxmoxValidate.test.js`

**Interfaces:**
- Produces:
  - `parseEndpoint(s) -> { host, port }` (throws on bad input; default port 8006).
  - `isCidr(s)->bool`, `isIp(s)->bool`.
  - `assertHostInput(spec, { requireSecret })` — throws `Error` on invalid.
  - `assertKeyInput(spec)` — throws on invalid.
  - `assertPresetInput(spec, { keyIds, hostIds })` — throws on invalid.
  - `assertProvisionInput(spec)` — throws on invalid.

- [ ] **Step 1: Write the failing test** — create `test/proxmoxValidate.test.js`:

```js
import { test, expect } from 'vitest';
import {
  parseEndpoint, isCidr, isIp,
  assertHostInput, assertKeyInput, assertPresetInput, assertProvisionInput,
} from '../src/server/proxmoxValidate.js';

test('parseEndpoint accepts host and host:port, strips scheme, defaults 8006', () => {
  expect(parseEndpoint('pve.example.com')).toEqual({ host: 'pve.example.com', port: 8006 });
  expect(parseEndpoint('pve.example.com:8443')).toEqual({ host: 'pve.example.com', port: 8443 });
  expect(parseEndpoint('https://192.168.1.10:8006')).toEqual({ host: '192.168.1.10', port: 8006 });
  expect(() => parseEndpoint('bad host')).toThrow();
  expect(() => parseEndpoint('pve.example.com:70000')).toThrow();
});

test('isCidr / isIp', () => {
  expect(isCidr('192.168.1.10/24')).toBe(true);
  expect(isCidr('192.168.1.10')).toBe(false);
  expect(isIp('192.168.1.1')).toBe(true);
  expect(isIp('192.168.1.1/24')).toBe(false);
});

test('assertHostInput requires name, endpoint, token id pattern, and secret when asked', () => {
  const ok = { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'x', verifyMode: 'pin', fingerprint256: 'AB:CD' };
  expect(() => assertHostInput(ok, { requireSecret: true })).not.toThrow();
  expect(() => assertHostInput({ ...ok, name: '' }, { requireSecret: true })).toThrow(/name/);
  expect(() => assertHostInput({ ...ok, tokenId: 'nope' }, { requireSecret: true })).toThrow(/token id/);
  expect(() => assertHostInput({ ...ok, tokenSecret: '' }, { requireSecret: true })).toThrow(/token secret/);
  expect(() => assertHostInput({ ...ok, tokenSecret: '' }, { requireSecret: false })).not.toThrow();
  expect(() => assertHostInput({ ...ok, verifyMode: 'pin', fingerprint256: '' }, { requireSecret: true })).toThrow(/fingerprint/);
  expect(() => assertHostInput({ ...ok, verifyMode: 'bogus' }, { requireSecret: true })).toThrow(/verifyMode/);
});

test('assertKeyInput requires a name and a single valid public-key line', () => {
  expect(() => assertKeyInput({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' })).not.toThrow();
  expect(() => assertKeyInput({ name: '', publicKey: 'ssh-ed25519 AAAA' })).toThrow(/name/);
  expect(() => assertKeyInput({ name: 'k', publicKey: 'not a key' })).toThrow(/public key/);
  expect(() => assertKeyInput({ name: 'k', publicKey: 'ssh-ed25519 AAAA\nssh-ed25519 BBBB' })).toThrow(/single/);
});

const PRESET = {
  name: 'dev', hostId: 'h1', template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: { nesting: true },
  net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
  dns: {}, keyIds: ['k1'], onboot: false, startAfterCreate: true,
};

test('assertPresetInput validates ranges, refs, and static-network completeness', () => {
  const ctx = { keyIds: ['k1'], hostIds: ['h1'] };
  expect(() => assertPresetInput(PRESET, ctx)).not.toThrow();
  expect(() => assertPresetInput({ ...PRESET, cores: 0 }, ctx)).toThrow(/cores/);
  expect(() => assertPresetInput({ ...PRESET, diskGiB: 0 }, ctx)).toThrow(/disk/);
  expect(() => assertPresetInput({ ...PRESET, keyIds: [] }, ctx)).toThrow(/at least one/);
  expect(() => assertPresetInput({ ...PRESET, keyIds: ['nope'] }, ctx)).toThrow(/key/);
  expect(() => assertPresetInput({ ...PRESET, hostId: 'nope' }, ctx)).toThrow(/host/);
  const staticNet = { ...PRESET, net: { bridge: 'vmbr0', vlan: 5, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' } };
  expect(() => assertPresetInput(staticNet, ctx)).not.toThrow();
  expect(() => assertPresetInput({ ...staticNet, net: { ...staticNet.net, cidr: 'bad' } }, ctx)).toThrow(/cidr/);
  expect(() => assertPresetInput({ ...PRESET, net: { ...PRESET.net, bridge: 'no spaces!' } }, ctx)).toThrow(/bridge/);
});

test('assertProvisionInput validates hostname, vmid, and ip', () => {
  expect(() => assertProvisionInput({ hostname: 'dev-01' })).not.toThrow();
  expect(() => assertProvisionInput({ hostname: 'Bad_Host' })).toThrow(/hostname/);
  expect(() => assertProvisionInput({ hostname: 'ok', vmid: 50 })).toThrow(/vmid/);
  expect(() => assertProvisionInput({ hostname: 'ok', vmid: 150 })).not.toThrow();
  expect(() => assertProvisionInput({ hostname: 'ok', ip: 'bad' })).toThrow(/ip/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/proxmoxValidate.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/proxmoxValidate.js`:

```js
const SAFE_HOST = /^[A-Za-z0-9_.-]+$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const TOKEN_ID = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/; // user@realm!name
const SAFE_ID = /^[A-Za-z0-9_.:/+-]+$/;                                // storage / bridge / template volid
const FINGERPRINT = /^[0-9A-Fa-f:]+$/;
const PUBKEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[A-Za-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-[A-Za-z0-9-]+)@openssh\.com)\s+[A-Za-z0-9+/=]+(\s+\S+)?$/;
const VERIFY_MODES = ['pin', 'ca', 'insecure'];

export function isIp(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}
export function isCidr(s) {
  const m = /^(.+)\/(\d{1,2})$/.exec(String(s));
  return !!m && isIp(m[1]) && Number(m[2]) >= 0 && Number(m[2]) <= 32;
}

export function parseEndpoint(value) {
  let s = String(value || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!s) throw new Error('endpoint is required');
  let host = s;
  let port = 8006;
  const idx = s.lastIndexOf(':');
  if (idx !== -1) {
    host = s.slice(0, idx);
    port = Number(s.slice(idx + 1));
  }
  if (!SAFE_HOST.test(host)) throw new Error(`invalid endpoint host: ${JSON.stringify(host)}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid endpoint port: ${JSON.stringify(port)}`);
  return { host, port };
}

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function intInRange(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

export function assertHostInput(spec, { requireSecret = true } = {}) {
  if (!nonEmpty(spec.name)) throw new Error('host name is required');
  parseEndpoint(spec.endpoint);
  if (!TOKEN_ID.test(String(spec.tokenId || ''))) throw new Error('token id must look like user@realm!name');
  if (requireSecret && !nonEmpty(spec.tokenSecret)) throw new Error('token secret is required');
  const mode = spec.verifyMode || 'pin';
  if (!VERIFY_MODES.includes(mode)) throw new Error(`invalid verifyMode: ${JSON.stringify(mode)}`);
  if (mode === 'pin' && !FINGERPRINT.test(String(spec.fingerprint256 || ''))) {
    throw new Error('pin mode requires a fingerprint256');
  }
}

export function assertKeyInput(spec) {
  if (!nonEmpty(spec.name)) throw new Error('key name is required');
  const pk = String(spec.publicKey || '').trim();
  if (/\r?\n/.test(pk)) throw new Error('paste a single public key line');
  if (!PUBKEY.test(pk)) throw new Error('not a valid public key');
}

export function assertPresetInput(spec, { keyIds = [], hostIds = [] } = {}) {
  if (!nonEmpty(spec.name)) throw new Error('preset name is required');
  if (!hostIds.includes(spec.hostId)) throw new Error('preset host is unknown');
  if (!SAFE_ID.test(String(spec.template || ''))) throw new Error('invalid template');
  if (!SAFE_ID.test(String(spec.storage || ''))) throw new Error('invalid storage');
  if (!intInRange(spec.diskGiB, 1, 8192)) throw new Error('disk must be 1..8192 GiB');
  if (!intInRange(spec.cores, 1, 512)) throw new Error('cores must be 1..512');
  if (!intInRange(spec.memoryMiB, 16, 1048576)) throw new Error('memory must be >= 16 MiB');
  if (!intInRange(spec.swapMiB, 0, 1048576)) throw new Error('swap must be >= 0 MiB');
  const net = spec.net || {};
  if (!SAFE_ID.test(String(net.bridge || ''))) throw new Error('invalid bridge');
  if (net.vlan != null && !intInRange(net.vlan, 1, 4094)) throw new Error('vlan must be 1..4094');
  if (!['dhcp', 'static'].includes(net.ipMode)) throw new Error('ipMode must be dhcp or static');
  if (net.ipMode === 'static') {
    if (!isCidr(net.cidr)) throw new Error('static network requires a cidr like 192.168.1.50/24');
    if (!isIp(net.gateway)) throw new Error('static network requires a gateway ip');
  }
  if (!Array.isArray(spec.keyIds) || spec.keyIds.length === 0) throw new Error('select at least one mgmt key');
  for (const id of spec.keyIds) if (!keyIds.includes(id)) throw new Error(`unknown mgmt key: ${id}`);
}

export function assertProvisionInput(spec) {
  if (!DNS_LABEL.test(String(spec.hostname || ''))) throw new Error('hostname must be a DNS label');
  if (spec.vmid != null && !intInRange(Number(spec.vmid), 100, 999999999)) throw new Error('vmid must be 100..999999999');
  if (spec.ip != null && spec.ip !== '' && !isCidr(spec.ip)) throw new Error('ip must be a CIDR like 192.168.1.50/24');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/proxmoxValidate.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxValidate.js test/proxmoxValidate.test.js
git commit -m "feat(proxmox): add input validators and endpoint parser"
```

---

## Task 4: Profile/key/preset store (`proxmoxStore.js`)

**Files:**
- Create: `src/server/proxmoxStore.js`
- Test: `test/proxmoxStore.test.js`

**Interfaces:**
- Consumes: `createSecretBox` (Task 2), validators (Task 3).
- Produces: `createProxmoxStore({ dataDir, secretBox, makeId?, now? }) -> { listHosts, getHost, addHost, updateHost, removeHost, listKeys, addKey, removeKey, listPresets, getPreset, addPreset, updatePreset, removePreset }`. `getHost(id, { withSecret })` returns the **decrypted** token when `withSecret:true`, else a redacted host (`hasToken:boolean`, no `tokenSecret`). All list/add/update host methods return redacted hosts.

- [ ] **Step 1: Write the failing test** — create `test/proxmoxStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProxmoxStore } from '../src/server/proxmoxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

let dir;
const secretBox = createSecretBox('test-cookie');
const make = () => createProxmoxStore({ dataDir: dir, secretBox });
const HOST = { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'super-secret', verifyMode: 'pin', fingerprint256: 'AB:CD:EF' };

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pve-')); });

test('addHost seals the token; reads are redacted; on-disk file is 0600 and ciphertext-only', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  expect(h.tokenSecret).toBeUndefined();
  expect(h.hasToken).toBe(true);
  const list = await store.listHosts();
  expect(list[0].tokenSecret).toBeUndefined();
  const raw = await fs.readFile(path.join(dir, 'proxmox.json'), 'utf8');
  expect(raw).not.toContain('super-secret');
  expect(raw).toContain('pvebox.v1:');
  const stat = await fs.stat(path.join(dir, 'proxmox.json'));
  expect(stat.mode & 0o777).toBe(0o600);
});

test('getHost withSecret returns the decrypted token; default is redacted', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  expect((await store.getHost(h.id)).hasToken).toBe(true);
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('super-secret');
});

test('updateHost without a new secret keeps the stored token', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  await store.updateHost(h.id, { defaultNode: 'pve' });
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('super-secret');
  await store.updateHost(h.id, { tokenSecret: 'rotated' });
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('rotated');
});

test('host/key/preset names are unique', async () => {
  const store = make();
  await store.addHost(HOST);
  await expect(store.addHost(HOST)).rejects.toThrow(/name/);
});

test('keys CRUD with validation', async () => {
  const store = make();
  const k = await store.addKey({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' });
  expect((await store.listKeys())[0].id).toBe(k.id);
  await expect(store.addKey({ name: 'bad', publicKey: 'nope' })).rejects.toThrow(/public key/);
  await store.removeKey(k.id);
  expect(await store.listKeys()).toHaveLength(0);
});

test('presets validate against existing hosts and keys and persist normalized', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const k = await store.addKey({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' });
  const preset = await store.addPreset({
    name: 'dev', hostId: h.id, template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
    unprivileged: true, features: { nesting: true },
    net: { bridge: 'vmbr0', ipMode: 'dhcp' }, keyIds: [k.id], startAfterCreate: true,
  });
  expect(preset.id).toBeTruthy();
  expect(preset.net.ipMode).toBe('dhcp');
  expect((await store.getPreset(preset.id)).name).toBe('dev');
  await expect(store.addPreset({ ...preset, name: 'dev2', keyIds: ['ghost'] })).rejects.toThrow(/key/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/proxmoxStore.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/proxmoxStore.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertHostInput, assertKeyInput, assertPresetInput, parseEndpoint } from './proxmoxValidate.js';

const VERSION = 1;

function normalizePreset(spec, id, createdAt) {
  const net = spec.net || {};
  return {
    id, name: spec.name.trim(), hostId: spec.hostId, node: spec.node || null,
    template: spec.template, storage: spec.storage, diskGiB: spec.diskGiB,
    cores: spec.cores, memoryMiB: spec.memoryMiB, swapMiB: spec.swapMiB,
    unprivileged: spec.unprivileged !== false,
    features: spec.features && typeof spec.features === 'object' ? spec.features : {},
    net: { bridge: net.bridge, vlan: net.vlan ?? null, ipMode: net.ipMode, cidr: net.cidr ?? null, gateway: net.gateway ?? null },
    dns: { nameserver: spec.dns?.nameserver ?? null, searchdomain: spec.dns?.searchdomain ?? null },
    keyIds: [...spec.keyIds],
    onboot: !!spec.onboot, startAfterCreate: spec.startAfterCreate !== false,
    boxDefaults: { user: spec.boxDefaults?.user || 'root', sessionName: spec.boxDefaults?.sessionName || 'web', tags: spec.boxDefaults?.tags || [] },
    createdAt,
  };
}

export function createProxmoxStore({ dataDir, secretBox, makeId = randomUUID, now = () => new Date().toISOString() }) {
  const file = path.join(dataDir, 'proxmox.json');

  async function readAll() {
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      return { version: VERSION, hosts: [], keys: [], presets: [], ...v };
    } catch {
      return { version: VERSION, hosts: [], keys: [], presets: [] };
    }
  }
  async function writeAll(data) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  function redactHost(h) {
    const { tokenSecret, ...rest } = h;
    return { ...rest, hasToken: !!tokenSecret };
  }
  function assertUniqueName(list, name, ignoreId) {
    const n = String(name || '').trim().toLowerCase();
    for (const it of list) {
      if (ignoreId && it.id === ignoreId) continue;
      if (String(it.name || '').trim().toLowerCase() === n) throw new Error('name already exists');
    }
  }

  return {
    async listHosts() { return (await readAll()).hosts.map(redactHost); },
    async getHost(id, { withSecret = false } = {}) {
      const h = (await readAll()).hosts.find((x) => x.id === id);
      if (!h) return undefined;
      return withSecret ? { ...h, tokenSecret: secretBox.open(h.tokenSecret) } : redactHost(h);
    },
    async addHost(spec) {
      assertHostInput(spec, { requireSecret: true });
      const data = await readAll();
      assertUniqueName(data.hosts, spec.name);
      const { host, port } = parseEndpoint(spec.endpoint);
      const h = {
        id: makeId(), name: spec.name.trim(), endpoint: `${host}:${port}`,
        tokenId: spec.tokenId, tokenSecret: secretBox.seal(spec.tokenSecret),
        fingerprint256: spec.fingerprint256 || null, verifyMode: spec.verifyMode || 'pin',
        defaultNode: spec.defaultNode || null, createdAt: now(),
      };
      data.hosts.push(h);
      await writeAll(data);
      return redactHost(h);
    },
    async updateHost(id, patch) {
      const data = await readAll();
      const i = data.hosts.findIndex((x) => x.id === id);
      if (i === -1) throw new Error('host not found');
      const merged = { ...data.hosts[i], ...patch };
      merged.tokenSecret = patch.tokenSecret ? secretBox.seal(patch.tokenSecret) : data.hosts[i].tokenSecret;
      if (patch.endpoint) { const { host, port } = parseEndpoint(patch.endpoint); merged.endpoint = `${host}:${port}`; }
      assertHostInput({ ...merged, tokenSecret: 'present' }, { requireSecret: false });
      assertUniqueName(data.hosts, merged.name, id);
      data.hosts[i] = merged;
      await writeAll(data);
      return redactHost(merged);
    },
    async removeHost(id) {
      const data = await readAll();
      data.hosts = data.hosts.filter((x) => x.id !== id);
      await writeAll(data);
    },
    async listKeys() { return (await readAll()).keys; },
    async addKey(spec) {
      assertKeyInput(spec);
      const data = await readAll();
      assertUniqueName(data.keys, spec.name);
      const k = { id: makeId(), name: spec.name.trim(), publicKey: spec.publicKey.trim(), createdAt: now() };
      data.keys.push(k);
      await writeAll(data);
      return k;
    },
    async removeKey(id) {
      const data = await readAll();
      data.keys = data.keys.filter((x) => x.id !== id);
      await writeAll(data);
    },
    async listPresets() { return (await readAll()).presets; },
    async getPreset(id) { return (await readAll()).presets.find((x) => x.id === id); },
    async addPreset(spec) {
      const data = await readAll();
      assertPresetInput(spec, { keyIds: data.keys.map((k) => k.id), hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, spec.name);
      const p = normalizePreset(spec, makeId(), now());
      data.presets.push(p);
      await writeAll(data);
      return p;
    },
    async updatePreset(id, patch) {
      const data = await readAll();
      const i = data.presets.findIndex((x) => x.id === id);
      if (i === -1) throw new Error('preset not found');
      const merged = { ...data.presets[i], ...patch };
      assertPresetInput(merged, { keyIds: data.keys.map((k) => k.id), hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, merged.name, id);
      data.presets[i] = normalizePreset(merged, id, data.presets[i].createdAt);
      await writeAll(data);
      return data.presets[i];
    },
    async removePreset(id) {
      const data = await readAll();
      data.presets = data.presets.filter((x) => x.id !== id);
      await writeAll(data);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/proxmoxStore.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxStore.js test/proxmoxStore.test.js
git commit -m "feat(proxmox): add encrypted host/key/preset store"
```

---

## Task 5: Create-param builder (`proxmoxParams.js`)

**Files:**
- Create: `src/server/proxmoxParams.js`
- Test: `test/proxmoxParams.test.js`

**Interfaces:**
- Produces:
  - `buildNet0(net, ipOverride?) -> string` — the PVE `net0` field.
  - `buildCreateParams(preset, { vmid, hostname, ip, publicKeys }) -> object` — the `POST /lxc` body params.

- [ ] **Step 1: Write the failing test** — create `test/proxmoxParams.test.js`:

```js
import { test, expect } from 'vitest';
import { buildNet0, buildCreateParams } from '../src/server/proxmoxParams.js';

test('buildNet0 dhcp and static (with vlan + override)', () => {
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'dhcp' })).toBe('name=eth0,bridge=vmbr0,ip=dhcp');
  expect(buildNet0({ bridge: 'vmbr0', vlan: 5, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }))
    .toBe('name=eth0,bridge=vmbr0,tag=5,ip=192.168.1.50/24,gw=192.168.1.1');
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }, '192.168.1.99/24'))
    .toContain('ip=192.168.1.99/24');
});

const PRESET = {
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst', storage: 'local-lvm',
  diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512, unprivileged: true,
  features: { nesting: true, keyctl: false }, onboot: false,
  net: { bridge: 'vmbr0', ipMode: 'dhcp' }, dns: { nameserver: '1.1.1.1' },
};

test('buildCreateParams maps a preset to PVE fields', () => {
  const p = buildCreateParams(PRESET, { vmid: 123, hostname: 'dev-01', publicKeys: ['ssh-ed25519 AAA a', 'ssh-ed25519 BBB b'] });
  expect(p).toMatchObject({
    vmid: 123, hostname: 'dev-01',
    ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    rootfs: 'local-lvm:8', cores: 2, memory: 2048, swap: 512,
    unprivileged: 1, onboot: 0, net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
    features: 'nesting=1', nameserver: '1.1.1.1',
  });
  expect(p['ssh-public-keys']).toBe('ssh-ed25519 AAA a\nssh-ed25519 BBB b\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/proxmoxParams.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/proxmoxParams.js`:

```js
// Pure preset -> Proxmox `POST /nodes/{node}/lxc` parameter mapping. No I/O.

export function buildNet0(net, ipOverride) {
  const parts = ['name=eth0', `bridge=${net.bridge}`];
  if (net.vlan) parts.push(`tag=${net.vlan}`);
  if (net.ipMode === 'static') {
    parts.push(`ip=${ipOverride || net.cidr}`);
    if (net.gateway) parts.push(`gw=${net.gateway}`);
  } else {
    parts.push('ip=dhcp');
  }
  return parts.join(',');
}

export function buildCreateParams(preset, { vmid, hostname, ip, publicKeys }) {
  const params = {
    vmid,
    hostname,
    ostemplate: preset.template,
    rootfs: `${preset.storage}:${preset.diskGiB}`,
    cores: preset.cores,
    memory: preset.memoryMiB,
    swap: preset.swapMiB,
    unprivileged: preset.unprivileged ? 1 : 0,
    onboot: preset.onboot ? 1 : 0,
    net0: buildNet0(preset.net, ip),
  };
  const feats = Object.entries(preset.features || {}).filter(([, v]) => v).map(([k]) => `${k}=1`);
  if (feats.length) params.features = feats.join(',');
  if (preset.dns?.nameserver) params.nameserver = preset.dns.nameserver;
  if (preset.dns?.searchdomain) params.searchdomain = preset.dns.searchdomain;
  if (publicKeys && publicKeys.length) params['ssh-public-keys'] = publicKeys.join('\n') + '\n';
  return params;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/proxmoxParams.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxParams.js test/proxmoxParams.test.js
git commit -m "feat(proxmox): add pure preset-to-create-params builder"
```

---

## Task 6: PVE API client (`proxmoxApi.js`)

**Files:**
- Create: `src/server/proxmoxApi.js`
- Test: `test/proxmoxApi.test.js`

**Interfaces:**
- Produces:
  - `createProxmoxClient({ host, request?, timeoutMs? }) -> { version, nodes, storages, templates, bridges, nextId, createLxc, startLxc, taskStatus, taskLog, lxcInterfaces }`. `host` is a **secret-bearing** profile (`{ endpoint, tokenId, tokenSecret, verifyMode, fingerprint256 }`).
  - `inspectEndpoint(endpoint, { request?, timeoutMs? }) -> { reachable, fingerprint256, subject, issuer, validTo, caValid, error? }`.
  - The default transport `httpsRequest(opts)` is internal; tests inject `request`.
- `request(opts)` contract — `opts = { url, method, headers, body, timeoutMs, tls }`; resolves `{ status, json, text, cert, authorized }`. `tls = { rejectUnauthorized?, checkServerIdentity? }`.

- [ ] **Step 1: Write the failing test** — create `test/proxmoxApi.test.js`:

```js
import { test, expect } from 'vitest';
import { createProxmoxClient, inspectEndpoint } from '../src/server/proxmoxApi.js';

const HOST = { endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB:CD:EF' };

function fakeRequest(script) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return script(opts, calls.length - 1); };
  fn.calls = calls;
  return fn;
}

test('GET sends the token auth header to the right URL', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: [{ node: 'pve' }] } }));
  const client = createProxmoxClient({ host: HOST, request });
  const nodes = await client.nodes();
  expect(nodes).toEqual([{ node: 'pve' }]);
  expect(request.calls[0].url).toBe('https://pve.example.com:8006/api2/json/nodes');
  expect(request.calls[0].headers.Authorization).toBe('PVEAPIToken=user@pam!tmuxifier=sek');
});

test('createLxc form-encodes params and POSTs', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:pve:001' } }));
  const client = createProxmoxClient({ host: HOST, request });
  const upid = await client.createLxc('pve', { vmid: 123, hostname: 'dev-01', cores: 2, net0: 'name=eth0,bridge=vmbr0,ip=dhcp' });
  expect(upid).toBe('UPID:pve:001');
  const call = request.calls[0];
  expect(call.method).toBe('POST');
  expect(call.url).toBe('https://pve.example.com:8006/api2/json/nodes/pve/lxc');
  expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(call.body).toContain('vmid=123');
  expect(call.body).toContain('hostname=dev-01');
  expect(call.body).toContain('net0=name%3Deth0%2Cbridge%3Dvmbr0%2Cip%3Ddhcp');
});

test('maps 401 and 403 to clear errors', async () => {
  const c401 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 401, json: null })) });
  await expect(c401.version()).rejects.toThrow(/rejected|401/);
  const c403 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 403, json: null })) });
  await expect(c403.version()).rejects.toThrow(/permission|403/);
});

test('pin mode rejects a fingerprint mismatch and accepts a match', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  const client = createProxmoxClient({ host: HOST, request });
  await client.version();
  const check = request.calls[0].tls.checkServerIdentity;
  expect(request.calls[0].tls.rejectUnauthorized).toBe(false);
  expect(check('h', { fingerprint256: 'ab:cd:ef' })).toBeUndefined();          // case-insensitive match
  expect(check('h', { fingerprint256: '00:11' })).toBeInstanceOf(Error);
});

test('ca mode verifies normally; insecure disables verification', async () => {
  const reqCa = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'ca' }, request: reqCa }).version();
  expect(reqCa.calls[0].tls.rejectUnauthorized).toBe(true);
  const reqIns = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'insecure' }, request: reqIns }).version();
  expect(reqIns.calls[0].tls.rejectUnauthorized).toBe(false);
  expect(reqIns.calls[0].tls.checkServerIdentity).toBeUndefined();
});

test('inspectEndpoint returns the cert fingerprint and caValid; unreachable on throw', async () => {
  const ok = await inspectEndpoint('pve.example.com:8006', { request: fakeRequest(() => ({
    status: 200, json: { data: {} }, authorized: false,
    cert: { fingerprint256: 'AB:CD', subject: { CN: 'pve' }, issuer: { CN: 'pve' }, valid_to: 'Jan 1 2030' },
  })) });
  expect(ok).toMatchObject({ reachable: true, fingerprint256: 'AB:CD', subject: 'pve', caValid: false });
  const bad = await inspectEndpoint('down.example.com', { request: async () => { throw new Error('ECONNREFUSED'); } });
  expect(bad.reachable).toBe(false);
  expect(bad.error).toMatch(/ECONNREFUSED/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/proxmoxApi.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/proxmoxApi.js`:

```js
import https from 'node:https';

// Default transport. Tests inject `request` instead, so this is never exercised in unit tests.
function httpsRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 15000, tls = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 8006,
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      checkServerIdentity: tls.checkServerIdentity,
      timeout: timeoutMs,
    }, (res) => {
      const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      const authorized = res.socket.authorized === true;
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, text: data, cert, authorized });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function normFp(s) { return String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }

function tlsOptionsFor(host) {
  if (host.verifyMode === 'ca') return { rejectUnauthorized: true };
  if (host.verifyMode === 'insecure') return { rejectUnauthorized: false };
  const want = normFp(host.fingerprint256);
  return {
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const got = normFp(cert && cert.fingerprint256);
      if (!got || got !== want) return new Error('TLS fingerprint mismatch — the Proxmox host cert changed');
      return undefined;
    },
  };
}

function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}

export function createProxmoxClient({ host, request = httpsRequest, timeoutMs = 15000 }) {
  const base = `https://${host.endpoint}/api2/json`;
  const tls = tlsOptionsFor(host);

  async function call(method, p, params) {
    const opts = {
      url: `${base}${p}`,
      method,
      headers: { Authorization: `PVEAPIToken=${host.tokenId}=${host.tokenSecret}` },
      timeoutMs,
      tls,
    };
    if (params) {
      opts.body = new URLSearchParams(cleanParams(params)).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await request(opts);
    if (res.status === 401) throw new Error('Proxmox token rejected (401)');
    if (res.status === 403) throw new Error('Proxmox token lacks permission (403)');
    if (res.status >= 400) throw new Error(`Proxmox API error ${res.status}`);
    return res.json ? res.json.data : null;
  }

  const enc = encodeURIComponent;
  return {
    version: () => call('GET', '/version'),
    nodes: () => call('GET', '/nodes'),
    storages: (node) => call('GET', `/nodes/${enc(node)}/storage`),
    templates: (node, storage) => call('GET', `/nodes/${enc(node)}/storage/${enc(storage)}/content?content=vztmpl`),
    bridges: (node) => call('GET', `/nodes/${enc(node)}/network?type=bridge`),
    nextId: () => call('GET', '/cluster/nextid'),
    createLxc: (node, params) => call('POST', `/nodes/${enc(node)}/lxc`, params),
    startLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/start`, {}),
    taskStatus: (node, upid) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/status`),
    taskLog: (node, upid, start = 0) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/log?start=${start}&limit=500`),
    lxcInterfaces: (node, vmid) => call('GET', `/nodes/${enc(node)}/lxc/${enc(vmid)}/interfaces`),
  };
}

export async function inspectEndpoint(endpoint, { request = httpsRequest, timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await request({ url: `https://${endpoint}/api2/json/version`, method: 'GET', timeoutMs, tls: { rejectUnauthorized: false } });
  } catch (e) {
    return { reachable: false, error: e.message };
  }
  const cert = res.cert || {};
  return {
    reachable: true,
    fingerprint256: cert.fingerprint256 || null,
    subject: cert.subject ? cert.subject.CN || '' : '',
    issuer: cert.issuer ? cert.issuer.CN || '' : '',
    validTo: cert.valid_to || null,
    caValid: res.authorized === true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/proxmoxApi.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxApi.js test/proxmoxApi.test.js
git commit -m "feat(proxmox): add PVE HTTP client with TLS pinning and endpoint inspection"
```

---

## Task 7: Provision-job persistence (`provisionStore.js`)

**Files:**
- Create: `src/server/provisionStore.js`
- Test: `test/provisionStore.test.js`

**Interfaces:**
- Produces: `createProvisionStore({ dataDir }) -> { load()->array, save(jobs)->void, whenIdle()->Promise }`. Mirrors `fleetStore.js`'s debounced async writer to `data/provision-jobs.json`.

- [ ] **Step 1: Write the failing test** — create `test/provisionStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProvisionStore } from '../src/server/provisionStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pj-')); });

test('load returns [] when the file is absent', () => {
  expect(createProvisionStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips through the file', async () => {
  const store = createProvisionStore({ dataDir: dir });
  store.save([{ id: 'j1', status: 'done' }]);
  await store.whenIdle();
  expect(createProvisionStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', status: 'done' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/provisionStore.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/provisionStore.js` (the `fleetStore.js` shape, new filename):

```js
import fs from 'node:fs';
import path from 'node:path';

export function createProvisionStore({ dataDir }) {
  const file = path.join(dataDir, 'provision-jobs.json');
  let pending = null;
  let flushing = false;
  let idleResolvers = [];
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await fs.promises.mkdir(dataDir, { recursive: true });
      while (pending !== null) {
        const data = pending; pending = null;
        await fs.promises.writeFile(file, data);
      }
    } catch {
      // best effort: persistence must never crash a provision run
    } finally {
      flushing = false;
      const resolvers = idleResolvers; idleResolvers = [];
      for (const r of resolvers) r();
    }
  }
  return {
    load() {
      try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; }
      catch { return []; }
    },
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/provisionStore.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/provisionStore.js test/provisionStore.test.js
git commit -m "feat(proxmox): add debounced provision-job persistence"
```

---

## Task 8: Provision manager (`proxmoxProvision.js`)

**Files:**
- Create: `src/server/proxmoxProvision.js`
- Test: `test/proxmoxProvision.test.js`

**Interfaces:**
- Consumes: `proxmoxStore` (Task 4: `getPreset`, `getHost({withSecret})`, `listKeys`), `boxStore` (existing `store.js`: `addBox`), `buildCreateParams` (Task 5), `assertProvisionInput` (Task 3), a `provisionStore` (Task 7: `load`/`save`), and an injected `makeClient(host) -> client` (Task 6 shape).
- Produces: `createProvisionManager({...}) -> { createProvision, getProvision, listProvisions, cancelProvision, _settled }`. `createProvision({presetId,hostname,vmid?,ip?})` returns a job summary and runs the work as a fire-and-forget promise. `_settled(id)` resolves when that promise finishes (test seam, mirrors `fleet.js`).

- [ ] **Step 1: Write the failing test** — create `test/proxmoxProvision.test.js`:

```js
import { test, expect } from 'vitest';
import { createProvisionManager } from '../src/server/proxmoxProvision.js';

const PRESET_DHCP = {
  id: 'p1', name: 'dev', hostId: 'h1', node: 'pve', template: 'local:vztmpl/x.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512, unprivileged: true,
  features: {}, net: { bridge: 'vmbr0', ipMode: 'dhcp', cidr: null, gateway: null }, dns: {},
  keyIds: ['k1'], onboot: false, startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
};
const PRESET_STATIC = { ...PRESET_DHCP, id: 'p2', net: { bridge: 'vmbr0', ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' } };
const HOST = { id: 'h1', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB' };

function makeStore(preset) {
  return {
    getPreset: async (id) => (id === preset.id ? preset : undefined),
    getHost: async () => HOST,
    listKeys: async () => [{ id: 'k1', publicKey: 'ssh-ed25519 AAA you@example.com' }],
  };
}
function fakeBoxStore() {
  const added = [];
  return { added, addBox: async (spec) => { const b = { id: `box-${added.length + 1}`, ...spec }; added.push(b); return b; } };
}
// A client whose task always succeeds immediately; interfaces configurable.
function okClient({ ifaces = [{ name: 'eth0', inet: '192.168.1.77/24' }] } = {}) {
  return {
    nextId: async () => '131',
    createLxc: async () => 'UPID:create',
    startLxc: async () => 'UPID:start',
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'creating...' }],
    lxcInterfaces: async () => ifaces,
  };
}
const base = (over = {}) => ({
  boxStore: fakeBoxStore(), load: () => [], save: () => {},
  now: () => '2026-06-26T00:00:00Z', makeId: (() => { let n = 0; return () => `job-${++n}`; })(),
  sleep: async () => {}, pollMs: 0, leaseTimeoutMs: 1000, ...over,
});

test('static preset: create -> start -> link box from the static IP', async () => {
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), boxStore, makeClient: () => okClient() }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01' });
  expect(job.status).toBe('running');
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(done.vmid).toBe(131);
  expect(boxStore.added[0]).toMatchObject({ host: '192.168.1.50', user: 'root', source: 'proxmox', label: 'dev-01' });
  expect(boxStore.added[0].proxmox).toMatchObject({ node: 'pve', vmid: 131, hostId: 'h1' });
  expect(done.boxId).toBe('box-1');
});

test('dhcp preset: discovers the leased IP then links the box', async () => {
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => okClient() }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-02' });
  await mgr._settled(job.id);
  expect(boxStore.added[0].host).toBe('192.168.1.77');
  expect(mgr.getProvision(job.id).status).toBe('done');
});

test('dhcp lease timeout: job still succeeds but defers the box', async () => {
  const boxStore = fakeBoxStore();
  const client = okClient({ ifaces: [] }); // never reports an inet
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => client, leaseTimeoutMs: 0 }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-03' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(done.needsHost).toBe(true);
  expect(done.boxId).toBeNull();
  expect(boxStore.added).toHaveLength(0);
});

test('a failed create task marks the job error', async () => {
  const client = { ...okClient(), taskStatus: async () => ({ status: 'stopped', exitstatus: 'volume create failed' }) };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-04' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/volume create failed/);
});

test('cancel before the create task finishes ends the job cancelled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = { ...okClient(), createLxc: async () => { await gate; return 'UPID:create'; } };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-05' });
  mgr.cancelProvision(job.id);
  release();
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).status).toBe('cancelled');
});

test('task log is capped at maxLogBytes', async () => {
  const client = { ...okClient(), taskLog: async () => [{ n: 1, t: 'x'.repeat(100) }] };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), makeClient: () => client, maxLogBytes: 10 }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-06' });
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).log.length).toBeLessThanOrEqual(10);
});

test('startup reconciliation flips a persisted running job to interrupted', () => {
  const saved = [];
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_DHCP),
    load: () => [{ id: 'old', status: 'running', phase: 'create', createdAt: '2026-06-25T00:00:00Z' }],
    save: (jobs) => saved.push(jobs),
  }));
  expect(mgr.getProvision('old').status).toBe('interrupted');
  expect(saved[0][0].status).toBe('interrupted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/proxmoxProvision.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement** — create `src/server/proxmoxProvision.js`:

```js
import { randomUUID } from 'node:crypto';
import { buildCreateParams } from './proxmoxParams.js';
import { assertProvisionInput } from './proxmoxValidate.js';

const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save,
  now = () => new Date().toISOString(), makeId = randomUUID, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 1500, taskTimeoutMs = 600000, leaseTimeoutMs = 60000, maxJobs = 50, maxLogBytes = 65536,
}) {
  const jobs = new Map();
  const settles = new Map();

  // Startup reconciliation: a job still 'running' lost its poller when the process died.
  for (const j of load() || []) {
    if (!TERMINAL.has(j.status)) { j.status = 'interrupted'; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
  }
  persist();

  function ordered() { return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
  function persist() { save(ordered().slice(0, maxJobs)); }
  function summary(j) {
    return { id: j.id, presetName: j.presetName, hostname: j.hostname, vmid: j.vmid, status: j.status, phase: j.phase, createdAt: j.createdAt, finishedAt: j.finishedAt, boxId: j.boxId, needsHost: j.needsHost };
  }
  function publicJob(j) { if (!j) return j; const { _cancelled, ...rest } = j; return rest; }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }

  async function pollTask(client, node, upid, j) {
    const deadline = Date.now() + taskTimeoutMs;
    let logStart = 0;
    for (;;) {
      if (j._cancelled) throw new Error('cancelled');
      const lines = await client.taskLog(node, upid, logStart).catch(() => []);
      if (Array.isArray(lines) && lines.length) {
        logStart += lines.length;
        appendLog(j, lines.map((l) => l.t).join('\n') + '\n');
        persist();
      }
      const st = await client.taskStatus(node, upid);
      if (st && st.status === 'stopped') {
        if (st.exitstatus && st.exitstatus !== 'OK') throw new Error(`task failed: ${st.exitstatus}`);
        return;
      }
      if (Date.now() > deadline) throw new Error('task timed out');
      await sleep(pollMs);
    }
  }

  async function discoverIp(client, node, vmid, j) {
    const deadline = Date.now() + leaseTimeoutMs;
    for (;;) {
      if (j._cancelled) throw new Error('cancelled');
      const ifaces = await client.lxcInterfaces(node, vmid).catch(() => []);
      const eth = (ifaces || []).find((i) => i.name === 'eth0' && i.inet);
      if (eth) return String(eth.inet).split('/')[0];
      if (Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  }

  async function run(j, { client, preset, host, publicKeys }) {
    try {
      j.phase = 'allocate'; persist();
      if (!j.vmid) j.vmid = Number(await client.nextId());

      j.phase = 'create'; persist();
      const params = buildCreateParams(preset, { vmid: j.vmid, hostname: j.hostname, ip: j.ip, publicKeys });
      const upid = await client.createLxc(j.node, params);
      appendLog(j, `# create ${upid}\n`); persist();
      await pollTask(client, j.node, upid, j);

      if (preset.startAfterCreate) {
        j.phase = 'start'; persist();
        const sup = await client.startLxc(j.node, j.vmid);
        appendLog(j, `# start ${sup}\n`); persist();
        await pollTask(client, j.node, sup, j);
      }

      j.phase = 'discover'; persist();
      let boxHost = null;
      if (preset.net.ipMode === 'static') boxHost = String(j.ip || preset.net.cidr).split('/')[0];
      else if (preset.startAfterCreate) boxHost = await discoverIp(client, j.node, j.vmid, j);

      if (boxHost) {
        j.phase = 'link'; persist();
        const bd = preset.boxDefaults || {};
        const box = await boxStore.addBox({
          label: j.hostname, host: boxHost, user: bd.user || 'root',
          sessionName: bd.sessionName || 'web', tags: bd.tags || [], source: 'proxmox',
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, endpoint: host.endpoint },
        });
        j.boxId = box.id;
      } else {
        j.needsHost = true;
      }
      j.phase = 'done'; j.status = 'done'; j.finishedAt = now(); persist();
    } catch (e) {
      j.status = j._cancelled ? 'cancelled' : 'error';
      j.error = e.message;
      j.finishedAt = now();
      persist();
    }
  }

  return {
    async createProvision({ presetId, hostname, vmid, ip }) {
      assertProvisionInput({ hostname, vmid, ip });
      const preset = await proxmoxStore.getPreset(presetId);
      if (!preset) throw new Error('preset not found');
      const host = await proxmoxStore.getHost(preset.hostId, { withSecret: true });
      if (!host) throw new Error('host not found');
      const node = preset.node || host.defaultNode;
      if (!node) throw new Error('preset has no node and host has no defaultNode');
      const keys = await proxmoxStore.listKeys();
      const publicKeys = preset.keyIds.map((id) => (keys.find((k) => k.id === id) || {}).publicKey).filter(Boolean);
      const client = makeClient(host);
      const j = {
        id: makeId(), presetId, presetName: preset.name, hostId: host.id, node,
        hostname, vmid: vmid ? Number(vmid) : null,
        ip: ip || (preset.net.ipMode === 'static' ? preset.net.cidr : null),
        status: 'running', phase: 'allocate', log: '', boxId: null, needsHost: false, error: null,
        createdAt: now(), startedAt: now(), finishedAt: null,
      };
      jobs.set(j.id, j);
      persist();
      const p = run(j, { client, preset, host, publicKeys }).finally(() => {});
      settles.set(j.id, p);
      return summary(j);
    },
    getProvision(id) { return publicJob(jobs.get(id)); },
    listProvisions() { return ordered().map(summary); },
    cancelProvision(id) {
      const j = jobs.get(id);
      if (!j) return undefined;
      if (!TERMINAL.has(j.status)) j._cancelled = true;
      return summary(j);
    },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/proxmoxProvision.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxProvision.js test/proxmoxProvision.test.js
git commit -m "feat(proxmox): add provision manager (create/start/discover/link job)"
```

---

## Task 8.5: Carry Proxmox metadata on auto-linked boxes (`store.js`)

The provision manager (Task 8) calls `boxStore.addBox({ ..., source: 'proxmox', proxmox: {...} })`. The existing `store.js` `normalize()` returns a **fixed** field set and silently drops any `proxmox` block, so the cross-link the spec records (inert in Phase 1, used by Phase 2) would be lost on the real store. Task 8's unit test misses this because it injects a fake `boxStore`. This task makes the real store carry it through.

**Files:**
- Modify: `src/server/store.js` (`normalize()` return object, ~line 50-62)
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/store.test.js`:

```js
test('addBox carries source and a proxmox metadata block through normalize', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'h', source: 'proxmox', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' } });
  expect(box.source).toBe('proxmox');
  expect(box.proxmox).toEqual({ hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' });
  // persists across a reload
  const again = createStore({ dataDir: dir });
  expect((await again.getBox(box.id)).proxmox.vmid).toBe(131);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/store.test.js`
Expected: FAIL — `box.proxmox` is `undefined`.

- [ ] **Step 3: Implement** — in `src/server/store.js`, add one line to the object returned by `normalize()` (after `source: ...,` and before `createdAt: ...`):

```js
      proxmox: spec.proxmox ?? base.proxmox,
```

(For normal boxes `spec.proxmox` is `undefined`, and `JSON.stringify` omits `undefined`, so existing box JSON is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/store.test.js`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/server/store.js test/store.test.js
git commit -m "feat(proxmox): carry source/proxmox metadata on boxes for Phase 2 cross-link"
```

---

## Task 9: REST routes (`server.js`)

**Files:**
- Modify: `src/server/server.js` (add import at top; add a `requireAuth` route block after the Fleet routes, before `app.get('/api/status'`; extend the `buildServer({...})` destructure on line ~50)
- Test: `test/server.test.js` (add a `proxmoxStubs` helper + a block of route tests)

**Interfaces:**
- Consumes (new `buildServer` deps): `proxmoxStore` (Task 4), `provisionManager` (Task 8), `makeProxmoxClient(host)->client` (Task 6 `createProxmoxClient` bound with `request`), `inspectEndpoint` (Task 6).
- Produces: the `/api/proxmox/*` REST surface from the spec. Token never appears in any response (store redacts).

- [ ] **Step 1: Write the failing tests** — add to `test/server.test.js`. First, a stub factory near the top (after `fleetStub`):

```js
function proxmoxStubs(calls = []) {
  const host = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', hasToken: true, verifyMode: 'pin', fingerprint256: 'AB' };
  const proxmoxStore = {
    listHosts: async () => [host],
    getHost: async (id, opts) => (id === 'H1' ? (opts?.withSecret ? { ...host, tokenSecret: 'sek' } : host) : undefined),
    addHost: async (spec) => { calls.push(['addHost', spec.name]); return { ...host, name: spec.name }; },
    updateHost: async (id, patch) => ({ ...host, ...patch, hasToken: true }),
    removeHost: async () => {},
    listKeys: async () => [{ id: 'K1', name: 'mgmt', publicKey: 'ssh-ed25519 AAA you@example.com' }],
    addKey: async (spec) => { if (!String(spec.publicKey).startsWith('ssh-')) throw new Error('not a valid public key'); return { id: 'K2', ...spec }; },
    removeKey: async () => {},
    listPresets: async () => [{ id: 'P1', name: 'dev' }],
    getPreset: async (id) => (id === 'P1' ? { id: 'P1', name: 'dev' } : undefined),
    addPreset: async (spec) => ({ id: 'P2', ...spec }),
    updatePreset: async (id, patch) => ({ id, ...patch }),
    removePreset: async () => {},
  };
  const provisionManager = {
    createProvision: async (body) => { calls.push(['createProvision', body.hostname]); if (!body.hostname) throw new Error('hostname required'); return { id: 'J1', status: 'running', hostname: body.hostname }; },
    listProvisions: () => [{ id: 'J1', status: 'done' }],
    getProvision: (id) => (id === 'J1' ? { id: 'J1', status: 'done', log: '' } : undefined),
    cancelProvision: (id) => (id === 'J1' ? { id: 'J1', status: 'cancelled' } : undefined),
  };
  const makeProxmoxClient = () => ({
    version: async () => ({ version: '8.2' }),
    nodes: async () => [{ node: 'pve' }],
    storages: async () => [{ storage: 'local', content: 'vztmpl,iso' }, { storage: 'local-lvm', content: 'rootdir,images' }],
    templates: async () => [{ volid: 'local:vztmpl/debian-12.tar.zst' }],
    bridges: async () => [{ iface: 'vmbr0' }],
    nextId: async () => '131',
  });
  const inspectEndpoint = async () => ({ reachable: true, fingerprint256: 'AB:CD', subject: 'pve', issuer: 'pve', validTo: 'x', caValid: false });
  return { proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint };
}
```

Then add the route tests:

```js
test('proxmox routes require auth', async () => {
  app = await makeApp(proxmoxStubs());
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts' })).statusCode).toBe(401);
});

test('hosts: list is redacted, add verifies the token, browse works, token never leaks', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const list = await app.inject({ method: 'GET', url: '/api/proxmox/hosts', headers });
  expect(list.statusCode).toBe(200);
  expect(list.payload).not.toContain('tokenSecret');
  expect(list.json()[0].hasToken).toBe(true);

  const inspect = await app.inject({ method: 'POST', url: '/api/proxmox/inspect', headers, payload: { endpoint: 'pve.example.com:8006' } });
  expect(inspect.json().fingerprint256).toBe('AB:CD');

  const add = await app.inject({ method: 'POST', url: '/api/proxmox/hosts', headers, payload: { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB' } });
  expect(add.statusCode).toBe(201);
  expect(add.payload).not.toContain('sek');

  const storage = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/storage', headers });
  expect(storage.json()).toEqual({ rootdir: [{ storage: 'local-lvm', content: 'rootdir,images' }], vztmpl: [{ storage: 'local', content: 'vztmpl,iso' }] });
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nextid', headers })).json()).toEqual({ vmid: '131' });
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/NOPE/nodes', headers })).statusCode).toBe(404);
});

test('keys reject an invalid public key (400)', async () => {
  app = await makeApp(proxmoxStubs());
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/keys', headers, payload: { name: 'k', publicKey: 'nope' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/keys', headers, payload: { name: 'k', publicKey: 'ssh-ed25519 AAA you@example.com' } })).statusCode).toBe(201);
});

test('provisions: validation, create, poll, cancel, 404', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers, payload: { presetId: 'P1' } })).statusCode).toBe(400);
  const ok = await app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers, payload: { presetId: 'P1', hostname: 'dev-01' } });
  expect(ok.statusCode).toBe(201);
  expect(ok.json().status).toBe('running');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions', headers })).json()).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions/J1', headers })).json().status).toBe('done');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions/NOPE', headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/provisions/J1/cancel', headers })).json().status).toBe('cancelled');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/server.test.js`
Expected: FAIL — 404s (routes not mounted) / 500s.

- [ ] **Step 3: Implement** — in `src/server/server.js`:

(a) Add an import near the other imports at the top:

```js
import { parseEndpoint } from './proxmoxValidate.js';
```

(b) Extend the `buildServer` destructure (line ~50) to add the four deps:

```js
export function buildServer({ config, store, sessions, statusChecker, statusPoller, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, googleAuth, localSession = 'local', killLocalSession = killTmuxSession }) {
```

(c) Insert this route block right after the Fleet `cancel` route (after the `app.post('/api/fleet/jobs/:id/cancel', …)` block, before `app.get('/api/status', …)`):

```js
  // --- Proxmox LXC provisioning ---
  async function callHost(reply, id, fn) {
    const host = await proxmoxStore.getHost(id, { withSecret: true });
    if (!host) return reply.code(404).send({ error: 'host not found' });
    try { return await fn(makeProxmoxClient(host)); }
    catch (e) { return reply.code(502).send({ error: e.message }); }
  }

  app.post('/api/proxmox/inspect', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { host, port } = parseEndpoint((req.body || {}).endpoint);
      return await inspectEndpoint(`${host}:${port}`, { timeoutMs: config.pveTimeoutMs });
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.get('/api/proxmox/hosts', { preHandler: requireAuth }, async () => proxmoxStore.listHosts());
  app.post('/api/proxmox/hosts', { preHandler: requireAuth }, async (req, reply) => {
    const spec = req.body || {};
    try {
      // Verify the token reaches Proxmox before persisting an unusable profile.
      const { host, port } = parseEndpoint(spec.endpoint);
      const transient = { endpoint: `${host}:${port}`, tokenId: spec.tokenId, tokenSecret: spec.tokenSecret, verifyMode: spec.verifyMode || 'pin', fingerprint256: spec.fingerprint256 };
      await makeProxmoxClient(transient).version();
    } catch (e) { return reply.code(400).send({ error: `could not reach Proxmox: ${e.message}` }); }
    try { return reply.code(201).send(await proxmoxStore.addHost(spec)); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.patch('/api/proxmox/hosts/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { return await proxmoxStore.updateHost(req.params.id, req.body || {}); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/hosts/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removeHost(req.params.id); return { ok: true }; });
  app.post('/api/proxmox/hosts/:id/test', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, async (c) => ({ ok: true, version: await c.version() })));
  app.get('/api/proxmox/hosts/:id/nodes', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.nodes()));
  app.get('/api/proxmox/hosts/:id/nodes/:node/storage', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, async (c) => {
      const list = await c.storages(req.params.node);
      const group = (kind) => list.filter((s) => String(s.content || '').split(',').includes(kind));
      return { rootdir: group('rootdir'), vztmpl: group('vztmpl') };
    }));
  app.get('/api/proxmox/hosts/:id/nodes/:node/templates', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.templates(req.params.node, req.query.storage)));
  app.get('/api/proxmox/hosts/:id/nodes/:node/bridges', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.bridges(req.params.node)));
  app.get('/api/proxmox/hosts/:id/nextid', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, async (c) => ({ vmid: await c.nextId() })));

  app.get('/api/proxmox/keys', { preHandler: requireAuth }, async () => proxmoxStore.listKeys());
  app.post('/api/proxmox/keys', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await proxmoxStore.addKey(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/keys/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removeKey(req.params.id); return { ok: true }; });

  app.get('/api/proxmox/presets', { preHandler: requireAuth }, async () => proxmoxStore.listPresets());
  app.post('/api/proxmox/presets', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await proxmoxStore.addPreset(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.patch('/api/proxmox/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { return await proxmoxStore.updatePreset(req.params.id, req.body || {}); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/presets/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removePreset(req.params.id); return { ok: true }; });

  app.post('/api/proxmox/provisions', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await provisionManager.createProvision(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.get('/api/proxmox/provisions', { preHandler: requireAuth }, async () => provisionManager.listProvisions());
  app.get('/api/proxmox/provisions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = provisionManager.getProvision(req.params.id);
    if (!job) return reply.code(404).send({ error: 'provision not found' });
    return job;
  });
  app.post('/api/proxmox/provisions/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const job = provisionManager.cancelProvision(req.params.id);
    if (!job) return reply.code(404).send({ error: 'provision not found' });
    return job;
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/server.test.js`
Expected: PASS (existing tests + 4 new proxmox tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(proxmox): add /api/proxmox REST routes"
```

---

## Task 10: Wiring (`index.js`)

**Files:**
- Modify: `src/server/index.js`
- Test: full suite (`npm test`) + a manual boot smoke check.

**Interfaces:**
- Consumes: every server module above. Produces nothing new — wires real implementations into `buildServer`.

- [ ] **Step 1: Add imports** — in `src/server/index.js`, with the other imports:

```js
import { createSecretBox } from './secretBox.js';
import { createProxmoxStore } from './proxmoxStore.js';
import { createProvisionStore } from './provisionStore.js';
import { createProvisionManager } from './proxmoxProvision.js';
import { createProxmoxClient, inspectEndpoint } from './proxmoxApi.js';
```

- [ ] **Step 2: Construct the modules** — after the `fleetManager` construction and before `statusPoller`:

```js
const secretBox = createSecretBox(config.cookieSecret);
const proxmoxStore = createProxmoxStore({ dataDir: config.dataDir, secretBox });
const provisionStore = createProvisionStore({ dataDir: config.dataDir });
const makeProxmoxClient = (host) => createProxmoxClient({ host, timeoutMs: config.pveTimeoutMs });
const provisionManager = createProvisionManager({
  proxmoxStore,
  boxStore: store,
  makeClient: makeProxmoxClient,
  load: () => provisionStore.load(),
  save: (jobs) => provisionStore.save(jobs),
  pollMs: config.pvePollMs,
  taskTimeoutMs: config.pveProvisionTimeoutMs,
  leaseTimeoutMs: config.pveLeaseTimeoutMs,
  maxJobs: config.pveMaxJobs,
});
```

- [ ] **Step 3: Pass them into `buildServer`** — extend the `buildServer({...})` call:

```js
const app = buildServer({ config, store, sessions, statusChecker, statusPoller, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint });
```

- [ ] **Step 4: Verify the suite still passes and the server boots**

Run: `npm test`
Expected: PASS (whole suite).

Boot smoke check (requires a configured `.env` with a cookie secret; in a scratch dir if needed):

Run: `node -e "import('./src/server/index.js')" &  sleep 1; curl -sk -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7437/api/auth/info; kill %1`
Expected: `200` (server constructed all modules and is serving). If `requiredConfigError` exits, set up `.env` first per `README.md`.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js
git commit -m "feat(proxmox): wire encryption, store, client, and provision manager"
```

---

## Task 11: Web API client + types (`proxmox.ts`)

**Files:**
- Create: `src/web/proxmox.ts`
- Test: `npm run build` (type-check + bundle).

**Interfaces:**
- Produces: TS types (`PveHost`, `PveKey`, `PvePreset`, `InspectResult`, `ProvisionJob`, `ProvisionSummary`) and a `pve` object of `fetch` wrappers mirroring `api.ts`.

- [ ] **Step 1: Implement** — create `src/web/proxmox.ts`:

```ts
export interface PveHost {
  id: string; name: string; endpoint: string; tokenId: string; hasToken: boolean;
  verifyMode: 'pin' | 'ca' | 'insecure'; fingerprint256: string | null; defaultNode: string | null; createdAt: string;
}
export interface PveKey { id: string; name: string; publicKey: string; createdAt: string; }
export interface PvePresetNet { bridge: string; vlan: number | null; ipMode: 'dhcp' | 'static'; cidr: string | null; gateway: string | null; }
export interface PvePreset {
  id: string; name: string; hostId: string; node: string | null; template: string; storage: string;
  diskGiB: number; cores: number; memoryMiB: number; swapMiB: number; unprivileged: boolean;
  features: Record<string, boolean>; net: PvePresetNet; dns: { nameserver: string | null; searchdomain: string | null };
  keyIds: string[]; onboot: boolean; startAfterCreate: boolean;
  boxDefaults: { user: string; sessionName: string; tags: string[] }; createdAt: string;
}
export interface InspectResult { reachable: boolean; fingerprint256: string | null; subject: string; issuer: string; validTo: string | null; caValid: boolean; error?: string; }
export type ProvisionStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type ProvisionPhase = 'allocate' | 'create' | 'start' | 'discover' | 'link' | 'done';
export interface ProvisionSummary { id: string; presetName: string; hostname: string; vmid: number | null; status: ProvisionStatus; phase: ProvisionPhase; createdAt: string; finishedAt: string | null; boxId: string | null; needsHost: boolean; }
export interface ProvisionJob extends ProvisionSummary { log: string; error: string | null; }
export interface StorageGroups { rootdir: { storage: string }[]; vztmpl: { storage: string }[]; }

async function jr<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const post = (v: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
const patch = (v: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

export const pve = {
  hosts() { return jr<PveHost[]>(fetch('/api/proxmox/hosts')); },
  inspect(endpoint: string) { return jr<InspectResult>(fetch('/api/proxmox/inspect', post({ endpoint }))); },
  addHost(spec: Partial<PveHost> & { tokenSecret: string }) { return jr<PveHost>(fetch('/api/proxmox/hosts', post(spec))); },
  updateHost(id: string, p: Partial<PveHost> & { tokenSecret?: string }) { return jr<PveHost>(fetch(`/api/proxmox/hosts/${id}`, patch(p))); },
  removeHost(id: string) { return jr(fetch(`/api/proxmox/hosts/${id}`, { method: 'DELETE' })); },
  testHost(id: string) { return jr<{ ok: boolean; version?: unknown }>(fetch(`/api/proxmox/hosts/${id}/test`, { method: 'POST' })); },
  nodes(id: string) { return jr<{ node: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes`)); },
  storage(id: string, node: string) { return jr<StorageGroups>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/storage`)); },
  templates(id: string, node: string, storage: string) { return jr<{ volid: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/templates?storage=${encodeURIComponent(storage)}`)); },
  bridges(id: string, node: string) { return jr<{ iface: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/bridges`)); },
  nextId(id: string) { return jr<{ vmid: string }>(fetch(`/api/proxmox/hosts/${id}/nextid`)); },
  keys() { return jr<PveKey[]>(fetch('/api/proxmox/keys')); },
  addKey(spec: { name: string; publicKey: string }) { return jr<PveKey>(fetch('/api/proxmox/keys', post(spec))); },
  removeKey(id: string) { return jr(fetch(`/api/proxmox/keys/${id}`, { method: 'DELETE' })); },
  presets() { return jr<PvePreset[]>(fetch('/api/proxmox/presets')); },
  addPreset(spec: unknown) { return jr<PvePreset>(fetch('/api/proxmox/presets', post(spec))); },
  updatePreset(id: string, spec: unknown) { return jr<PvePreset>(fetch(`/api/proxmox/presets/${id}`, patch(spec))); },
  removePreset(id: string) { return jr(fetch(`/api/proxmox/presets/${id}`, { method: 'DELETE' })); },
  createProvision(spec: { presetId: string; hostname: string; vmid?: number; ip?: string }) { return jr<ProvisionSummary>(fetch('/api/proxmox/provisions', post(spec))); },
  provisions() { return jr<ProvisionSummary[]>(fetch('/api/proxmox/provisions')); },
  provision(id: string) { return jr<ProvisionJob>(fetch(`/api/proxmox/provisions/${id}?t=${Date.now()}`)); },
  cancelProvision(id: string) { return jr<ProvisionSummary>(fetch(`/api/proxmox/provisions/${id}/cancel`, { method: 'POST' })); },
};
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: build succeeds (no TS errors).

- [ ] **Step 3: Commit**

```bash
git add src/web/proxmox.ts
git commit -m "feat(proxmox): add web API client and types"
```

---

## Task 12: Web hub UI (`proxmoxUi.ts`) + wiring + styles

**Files:**
- Create: `src/web/proxmoxUi.ts`
- Modify: `src/web/main.ts` (import; add the header button inside the `.fleet-actions` div at line ~252; add its click handler near the other `app.querySelector(...)` handlers in `renderDashboard`)
- Modify: `src/web/style.css` (append hub styles)
- Test: `npm run build` + manual verification steps below.

**Interfaces:**
- Consumes: `pve` (Task 11), `api`/`Box` from `./api`.
- Produces: `openProxmoxHub({ openBox, onBoxLinked }) -> void`. `openBox(box: Box)` opens a terminal (passed from `main.ts`); `onBoxLinked()` refreshes the sidebar after a provision links a box.

- [ ] **Step 1: Implement the hub** — create `src/web/proxmoxUi.ts`:

```ts
import { api, type Box } from './api';
import { pve, type PvePreset, type ProvisionStatus } from './proxmox';

type HubOpts = { openBox: (b: Box) => void; onBoxLinked: () => void };
type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else if (typeof v === 'boolean') { if (v) node.setAttribute(k, ''); }
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}
function input(value = '', attrs: Attrs = {}) { const i = el('input', attrs); i.value = value; return i; }
function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
function err(msg: string) { return el('div', { class: 'pve-err' }, [msg]); }

const TABS = ['Hosts', 'SSH Keys', 'Presets', 'Provision', 'History'] as const;
type Tab = typeof TABS[number];

export function openProxmoxHub(opts: HubOpts) {
  let pollTimer: number | null = null;
  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal pve-hub' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });
  const close = () => { stopPoll(); backdrop.remove(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  let active: Tab = 'Hosts';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Hosts: renderHosts, 'SSH Keys': renderKeys, Presets: renderPresets, Provision: renderProvision, History: renderHistory,
  };
  function selectTab(t: Tab) {
    active = t; stopPoll();
    for (const b of tabStrip.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    void renderers[t]();
  }
  for (const t of TABS) tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': t, onclick: () => selectTab(t) }, [t]));

  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Proxmox']), el('button', { type: 'button', class: 'pve-close', title: 'Close', onclick: close }, ['✕'])]),
    tabStrip, content,
  );
  backdrop.append(modal);
  document.body.append(backdrop);
  selectTab('Hosts');

  function setContent(...nodes: (Node | string)[]) { content.replaceChildren(...nodes); }

  // --- Hosts ---
  async function renderHosts() {
    const hosts = await pve.hosts().catch(() => []);
    const list = el('div', { class: 'pve-list' }, hosts.map((h) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [h.name]), el('span', { class: 'pve-sub' }, [` ${h.endpoint} · ${h.verifyMode}`])]),
      el('div', { class: 'pve-row-actions' }, [
        el('button', { type: 'button', onclick: async () => { try { await pve.testHost(h.id); alert('Reachable ✓'); } catch (e) { alert(`Test failed: ${(e as Error).message}`); } } }, ['Test']),
        el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove host ${h.name}?`)) { await pve.removeHost(h.id); void renderHosts(); } } }, ['Remove']),
      ]),
    ])));

    const name = input('', { placeholder: 'lab-pve' });
    const endpoint = input('', { placeholder: 'pve.example.com:8006' });
    const tokenId = input('', { placeholder: 'user@pam!tmuxifier' });
    const tokenSecret = input('', { placeholder: 'token secret (uuid)', type: 'password' });
    const defaultNode = input('', { placeholder: 'pve (optional default node)' });
    const fpLine = el('div', { class: 'pve-sub' }, ['Click Inspect to fetch and pin the TLS certificate.']);
    let verifyMode: 'pin' | 'ca' | 'insecure' = 'pin';
    let fingerprint256: string | null = null;
    const box = el('div', {});

    const inspectBtn = el('button', { type: 'button', onclick: async () => {
      try {
        const r = await pve.inspect(endpoint.value.trim());
        if (!r.reachable) { fpLine.replaceChildren(err(r.error || 'unreachable')); return; }
        fingerprint256 = r.fingerprint256;
        verifyMode = r.caValid ? 'ca' : 'pin';
        fpLine.replaceChildren(`${r.caValid ? 'CA-valid ✓ (will verify normally)' : 'self-signed → pin'} · ${r.fingerprint256 || ''}`);
      } catch (e) { fpLine.replaceChildren(err((e as Error).message)); }
    } }, ['Inspect']);

    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault();
      box.querySelector('.pve-err')?.remove();
      if (verifyMode === 'pin' && !fingerprint256) { box.append(err('Inspect the endpoint first to pin its certificate.')); return; }
      try {
        await pve.addHost({ name: name.value.trim(), endpoint: endpoint.value.trim(), tokenId: tokenId.value.trim(), tokenSecret: tokenSecret.value, verifyMode, fingerprint256, defaultNode: defaultNode.value.trim() || null });
        void renderHosts();
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add host']);

    box.append(
      el('h3', {}, ['Add a Proxmox host']),
      field('Name', name), field('Endpoint', endpoint), field('Token id', tokenId), field('Token secret', tokenSecret),
      el('div', { class: 'pve-inline' }, [inspectBtn, fpLine]),
      field('Default node', defaultNode),
      el('div', { class: 'modal-actions' }, [save]),
    );
    setContent(list, el('hr', { class: 'pve-hr' }), box);
  }

  // --- SSH Keys ---
  async function renderKeys() {
    const keys = await pve.keys().catch(() => []);
    const list = el('div', { class: 'pve-list' }, keys.map((k) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [k.name]), el('span', { class: 'pve-sub' }, [` ${k.publicKey.slice(0, 40)}…`])]),
      el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove key ${k.name}?`)) { await pve.removeKey(k.id); void renderKeys(); } } }, ['Remove']),
    ])));
    const name = input('', { placeholder: 'mgmt' });
    const pk = el('textarea', { class: 'pve-textarea', placeholder: 'ssh-ed25519 AAAA… you@example.com', rows: 3 });
    const box = el('div', {});
    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      try { await pve.addKey({ name: name.value.trim(), publicKey: (pk as HTMLTextAreaElement).value.trim() }); void renderKeys(); }
      catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add key']);
    box.append(el('h3', {}, ['Add a management public key']), field('Name', name), field('Public key', pk), el('div', { class: 'modal-actions' }, [save]));
    setContent(list, el('hr', { class: 'pve-hr' }), box);
  }

  // --- Presets ---
  async function renderPresets() {
    const [presets, hosts, keys] = await Promise.all([pve.presets().catch(() => []), pve.hosts().catch(() => []), pve.keys().catch(() => [])]);
    const list = el('div', { class: 'pve-list' }, presets.map((p) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [p.name]), el('span', { class: 'pve-sub' }, [` ${p.cores}c/${p.memoryMiB}MiB · ${p.net.ipMode}`])]),
      el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove preset ${p.name}?`)) { await pve.removePreset(p.id); void renderPresets(); } } }, ['Remove']),
    ])));

    if (!hosts.length || !keys.length) {
      setContent(list, el('hr', { class: 'pve-hr' }), el('div', { class: 'pve-sub' }, ['Add at least one host and one SSH key before creating a preset.']));
      return;
    }

    const name = input('', { placeholder: 'debian-dev' });
    const hostSel = el('select', {}, hosts.map((h) => el('option', { value: h.id }, [h.name])));
    const nodeSel = el('select', {});
    const tmplSel = el('select', {});
    const storeSel = el('select', {});
    const bridgeSel = el('select', {});
    const disk = input('8', { type: 'number', min: '1' });
    const cores = input('2', { type: 'number', min: '1' });
    const mem = input('2048', { type: 'number', min: '16' });
    const swap = input('512', { type: 'number', min: '0' });
    const unpriv = el('input', { type: 'checkbox' }); (unpriv as HTMLInputElement).checked = true;
    const nesting = el('input', { type: 'checkbox' }); (nesting as HTMLInputElement).checked = true;
    const startAfter = el('input', { type: 'checkbox' }); (startAfter as HTMLInputElement).checked = true;
    const ipMode = el('select', {}, [el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static'])]);
    const cidr = input('', { placeholder: '192.168.1.50/24' });
    const gateway = input('', { placeholder: '192.168.1.1' });
    const vlan = input('', { placeholder: 'vlan (optional)', type: 'number' });
    const keyBoxes = keys.map((k) => { const c = el('input', { type: 'checkbox', value: k.id }); return { k, c }; });
    const box = el('div', {});

    async function loadNodes() {
      nodeSel.replaceChildren(el('option', {}, ['…']));
      const nodes = await pve.nodes(hostSel.value).catch(() => []);
      nodeSel.replaceChildren(...nodes.map((n) => el('option', { value: n.node }, [n.node])));
      await loadNodeScoped();
    }
    async function loadNodeScoped() {
      const id = hostSel.value, node = nodeSel.value;
      if (!node) return;
      const [sg, br] = await Promise.all([pve.storage(id, node).catch(() => ({ rootdir: [], vztmpl: [] })), pve.bridges(id, node).catch(() => [])]);
      storeSel.replaceChildren(...sg.rootdir.map((s) => el('option', { value: s.storage }, [s.storage])));
      bridgeSel.replaceChildren(...br.map((b) => el('option', { value: b.iface }, [b.iface])));
      const tmplStorage = sg.vztmpl[0]?.storage;
      const tmpls = tmplStorage ? await pve.templates(id, node, tmplStorage).catch(() => []) : [];
      tmplSel.replaceChildren(...tmpls.map((t) => el('option', { value: t.volid }, [t.volid.split('/').pop() || t.volid])));
    }
    hostSel.addEventListener('change', () => void loadNodes());
    nodeSel.addEventListener('change', () => void loadNodeScoped());

    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      const spec = {
        name: name.value.trim(), hostId: hostSel.value, node: nodeSel.value,
        template: tmplSel.value, storage: storeSel.value, diskGiB: Number(disk.value),
        cores: Number(cores.value), memoryMiB: Number(mem.value), swapMiB: Number(swap.value),
        unprivileged: (unpriv as HTMLInputElement).checked, features: { nesting: (nesting as HTMLInputElement).checked },
        net: { bridge: bridgeSel.value, vlan: vlan.value ? Number(vlan.value) : null, ipMode: ipMode.value, cidr: cidr.value.trim() || null, gateway: gateway.value.trim() || null },
        keyIds: keyBoxes.filter((x) => (x.c as HTMLInputElement).checked).map((x) => x.k.id),
        onboot: false, startAfterCreate: (startAfter as HTMLInputElement).checked,
      };
      try { await pve.addPreset(spec); void renderPresets(); }
      catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add preset']);

    box.append(
      el('h3', {}, ['Add a container preset']),
      field('Name', name), field('Host', hostSel), field('Node', nodeSel), field('Template', tmplSel), field('Storage (rootfs)', storeSel),
      el('div', { class: 'pve-grid' }, [field('Disk GiB', disk), field('Cores', cores), field('Memory MiB', mem), field('Swap MiB', swap)]),
      el('label', { class: 'check-field' }, [unpriv, el('span', {}, ['Unprivileged'])]),
      el('label', { class: 'check-field' }, [nesting, el('span', {}, ['Nesting'])]),
      field('Bridge', bridgeSel), field('IP mode', ipMode),
      el('div', { class: 'pve-grid' }, [field('CIDR (static)', cidr), field('Gateway (static)', gateway), field('VLAN', vlan)]),
      el('div', { class: 'field' }, [el('span', {}, ['Inject keys']), ...keyBoxes.map((x) => el('label', { class: 'check-field' }, [x.c, el('span', {}, [x.k.name])]))]),
      el('label', { class: 'check-field' }, [startAfter, el('span', {}, ['Start after create'])]),
      el('div', { class: 'modal-actions' }, [save]),
    );
    setContent(list, el('hr', { class: 'pve-hr' }), box);
    await loadNodes();
  }

  // --- Provision ---
  async function renderProvision() {
    const presets = await pve.presets().catch(() => []);
    if (!presets.length) { setContent(el('div', { class: 'pve-sub' }, ['Create a preset first.'])); return; }
    const sel = el('select', {}, presets.map((p) => el('option', { value: p.id }, [p.name]))) as HTMLSelectElement;
    const hostname = input('', { placeholder: 'dev-01' });
    const vmid = input('', { placeholder: 'auto (next free)', type: 'number' });
    const ip = input('', { placeholder: 'override IP/CIDR (static only)' });
    const ipField = field('IP/CIDR', ip);
    const box = el('div', {});
    const curPreset = (): PvePreset | undefined => presets.find((p) => p.id === sel.value);
    const syncStatic = () => { ipField.style.display = curPreset()?.net.ipMode === 'static' ? '' : 'none'; };
    sel.addEventListener('change', syncStatic);

    const go = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      try {
        const job = await pve.createProvision({ presetId: sel.value, hostname: hostname.value.trim(), vmid: vmid.value ? Number(vmid.value) : undefined, ip: ip.value.trim() || undefined });
        showJob(job.id);
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Provision']);

    box.append(el('h3', {}, ['Provision a container']), field('Preset', sel), field('Hostname', hostname), field('VMID', vmid), ipField, el('div', { class: 'modal-actions' }, [go]));
    setContent(box);
    syncStatic();
  }

  // --- History ---
  async function renderHistory() {
    const jobs = await pve.provisions().catch(() => []);
    const list = el('div', { class: 'pve-list' }, jobs.map((j) => el('button', { type: 'button', class: 'pve-row pve-row-btn', onclick: () => showJob(j.id) }, [
      el('div', {}, [el('strong', {}, [j.hostname]), el('span', { class: 'pve-sub' }, [` ${j.presetName} · vmid ${j.vmid ?? '—'}`])]),
      el('span', { class: `pve-badge ${j.status}` }, [j.status]),
    ])));
    setContent(jobs.length ? list : el('div', { class: 'pve-sub' }, ['No provisions yet.']));
  }

  // --- Job panel (shared) ---
  function showJob(id: string) {
    stopPoll();
    let linked = false;
    const phase = el('div', { class: 'pve-phase' });
    const log = el('pre', { class: 'pve-log' });
    const footer = el('div', { class: 'modal-actions' });
    setContent(el('h3', {}, ['Provision job']), phase, log, footer);

    const RUNNING: ProvisionStatus[] = ['running'];
    async function tick() {
      let job;
      try { job = await pve.provision(id); } catch { pollTimer = window.setTimeout(tick, 1500); return; }
      phase.textContent = `${job.status.toUpperCase()} · ${job.phase}${job.vmid ? ` · vmid ${job.vmid}` : ''}${job.error ? ` · ${job.error}` : ''}`;
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      if (RUNNING.includes(job.status)) { pollTimer = window.setTimeout(tick, 1500); return; }
      // terminal
      footer.replaceChildren();
      if (job.boxId && !linked) { linked = true; opts.onBoxLinked(); }
      if (job.boxId) {
        footer.append(el('button', { type: 'button', class: 'pve-primary', onclick: async () => {
          const boxes = await api.boxes(); const b = boxes.find((x) => x.id === job!.boxId);
          if (b) { close(); opts.openBox(b); }
        } }, ['Open terminal']));
      } else if (job.needsHost) {
        footer.append(el('span', { class: 'pve-sub' }, [`Container ${job.vmid} is up but no IP was discovered — add a box manually.`]));
      }
    }
    void tick();
  }
}
```

- [ ] **Step 2: Wire it into `main.ts`**

(a) Add the import near the top (with the other local imports):

```ts
import { openProxmoxHub } from './proxmoxUi';
```

(b) In `renderDashboard`, replace the `.fleet-actions` line (~252) to add a Proxmox button:

```ts
        <div class="fleet-actions"><button id="fleet-toggle" type="button" class="fleet-toggle">Fleet Command</button><button id="fleet-jobs" type="button" class="fleet-jobs-btn" title="Fleet job history">Fleet Jobs</button><button id="proxmox" type="button" class="proxmox-btn" title="Provision Proxmox LXC containers">Proxmox</button></div>
```

(c) Add the click handler next to the `#fleet-jobs` handler (after line ~325):

```ts
  app.querySelector('#proxmox')!.addEventListener('click', () => openProxmoxHub({
    openBox: (b) => openBox(b),
    onBoxLinked: () => { void refresh(); },
  }));
```

- [ ] **Step 3: Append styles** — add to the end of `src/web/style.css`:

```css
/* Proxmox hub */
.modal.pve-hub { width: 560px; max-height: 86vh; }
.pve-head { display: flex; justify-content: space-between; align-items: center; }
.pve-close { background: none; border: 0; color: #8b949e; cursor: pointer; font-size: 16px; }
.pve-tabs { display: flex; gap: 4px; border-bottom: 1px solid #232a36; }
.pve-tab { padding: 7px 12px; background: none; border: 0; border-bottom: 2px solid transparent; color: #8b949e; cursor: pointer; font-size: 13px; }
.pve-tab.active { color: #c9d1d9; border-bottom-color: #1f6feb; }
.pve-content { overflow: auto; padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.pve-list { display: flex; flex-direction: column; gap: 6px; }
.pve-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #232a36; border-radius: 8px; background: #131722; }
.pve-row-btn { width: 100%; text-align: left; color: inherit; cursor: pointer; }
.pve-row-actions { display: flex; gap: 6px; }
.pve-row-actions button, .pve-row button { padding: 4px 10px; border-radius: 6px; border: 1px solid #232a36; background: #0f131c; color: #c9d1d9; cursor: pointer; font-size: 12px; }
.pve-row button.danger { color: #f85149; }
.pve-sub { color: #6e7681; font-size: 12px; }
.pve-hr { border: 0; border-top: 1px solid #232a36; width: 100%; margin: 4px 0; }
.pve-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pve-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pve-textarea { padding: 9px 10px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; font: inherit; resize: vertical; }
.pve-hub select { padding: 9px 10px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; font-size: 14px; }
.pve-err { color: #f85149; font-size: 12px; }
.pve-phase { font-size: 13px; color: #c9d1d9; }
.pve-log { max-height: 320px; overflow: auto; background: #0a0d14; border: 1px solid #232a36; border-radius: 8px; padding: 10px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; }
.pve-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #232a36; }
.pve-badge.done { color: #3fb950; } .pve-badge.error { color: #f85149; } .pve-badge.running { color: #d29922; }
.pve-primary { padding: 8px 16px; border-radius: 8px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; cursor: pointer; }
.proxmox-btn { padding: 6px 10px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; cursor: pointer; font-size: 13px; }
.proxmox-btn:hover { border-color: #2f6feb; }
```

> If the `.fleet-actions` buttons use a shared class with their own look, match it instead — the goal is for the Proxmox button to sit visually alongside "Fleet Command" / "Fleet Jobs", not to stand out.

- [ ] **Step 4: Verify it builds**

Run: `npm run build`
Expected: build succeeds (no TS errors), bundle written to `dist/`.

- [ ] **Step 5: Manual verification** (no real Proxmox needed for the UI shell)

Run: `npm start` (with a configured `.env`), open the dashboard, click **Proxmox**. Confirm: the hub opens; the five tabs switch; the Hosts "Add" form shows; Inspect on an unreachable endpoint shows a readable error. (Full provision needs a real PVE host — see the spec's E2E note.)

- [ ] **Step 6: Commit**

```bash
git add src/web/proxmoxUi.ts src/web/main.ts src/web/style.css
git commit -m "feat(proxmox): add the Proxmox hub UI (hosts, keys, presets, provision, history)"
```

---

## Task 13: Documentation

**Files:**
- Modify: `README.md` (new user-facing section)
- Modify: `CLAUDE.md` and `AGENTS.md` (kept in sync — `data/` inventory, architecture module list, security notes)
- Test: `npm test` (must stay green — docs don't affect it) + a manual read.

- [ ] **Step 1: README** — add a new section (after the existing feature/config sections; before or after the Fleet section if present):

```markdown
## Proxmox LXC provisioning

Tmuxifier can provision a "canned" LXC container on a Proxmox VE host over the PVE HTTP API and
auto-add a box pointed at it, so a freshly created container opens straight into a browser terminal.

**1. Create an API token in Proxmox.** In the PVE UI: *Datacenter → Permissions → API Tokens →
Add*. Pick a user/realm (e.g. `user@pam`), a token id (e.g. `tmuxifier`), and copy the secret
(shown once). Grant the token a role with at least container-create privileges — in a lab the
built-in `PVEVMAdmin` role on `/` plus `Datastore.AllocateSpace` + `Datastore.Audit` on the target
storage is sufficient (use a privilege-separated token, not full `Administrator`).

**2. Add the host.** Dashboard → **Proxmox → Hosts → Add**: enter the endpoint (`host:8006`), the
token id (`user@pam!tmuxifier`) and the secret. Click **Inspect** to fetch and **pin** the host's
TLS certificate (Proxmox ships a self-signed cert; pinning is trust-on-first-use, like
`ssh accept-new`). Save — Tmuxifier verifies the token before storing it.

**3. Add a management key.** **SSH Keys → Add**: paste a *public* key. It is injected into new
containers' `root` authorized_keys so Tmuxifier can SSH in. The private half stays in your own SSH
setup — Tmuxifier never stores private keys.

**4. Define a preset and provision.** **Presets → Add** a blueprint (template, CPU/mem/disk,
storage, network, keys). Then **Provision → pick a preset → enter a hostname**. Watch the live task
log; on success an **Open terminal** button drops you into the new container.

**Security.** The API token is **encrypted at rest** (AES-256-GCM; the key is derived from your
cookie secret) in the gitignored `data/proxmox.json` (`0600`), and is never sent to the browser.
TLS is pinned for self-signed certs and CA-verified when the host presents a valid certificate.
```

- [ ] **Step 2: CLAUDE.md + AGENTS.md** — make the **same** edits in both files:

(a) In the **Self-contained principle** `data/` bullet, extend it to list the new files:

```markdown
- `data/` (gitignored) — `boxes.json`, `fleet-jobs.json` (Fleet Command history), `proxmox.json`
  (Proxmox host profiles with **encrypted** API tokens, plus container presets and SSH mgmt public
  keys), `provision-jobs.json` (provision history), and SSH ControlMaster sockets under `data/cm/`.
```

(b) In **Architecture (`src/server/`)**, add these bullets after `statusPoller.js`:

```markdown
- `secretBox.js` — AES-256-GCM seal/open for secrets at rest; key derived from `cookieSecret` via
  HKDF. Used to encrypt the Proxmox API token.
- `proxmoxValidate.js` — pure validators/parsers for Proxmox host/key/preset/provision input.
- `proxmoxStore.js` — `data/proxmox.json` CRUD; seals the token on write, redacts it on read
  (`getHost(id,{withSecret})` is the only path that decrypts).
- `proxmoxApi.js` — PVE HTTP client over `node:https` with TLS fingerprint pinning, plus
  `inspectEndpoint`. The token never leaves the server.
- `proxmoxParams.js` — pure preset → `pct`/LXC create-param mapping (`net0`, `ssh-public-keys`, …).
- `provisionStore.js` / `proxmoxProvision.js` — debounced `data/provision-jobs.json` persistence and
  the create→poll→start→discover→auto-link-box job manager (the Fleet job pattern).
```

(c) In **Security notes**, add:

```markdown
- The Proxmox API token is the only persisted credential. It is AES-256-GCM encrypted at rest in
  `data/proxmox.json` (key from `cookieSecret`), written `0o600`, and never returned to the browser
  (host views are redacted to `hasToken`). PVE TLS is pinned by fingerprint for self-signed certs
  (TOFU, like `ssh accept-new`) or CA-verified; an explicit per-host `insecure` mode is off by
  default. All provision input is validated (`proxmoxValidate.js`) before reaching the API.
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test`
Expected: PASS (whole suite). Run `npm run build` once more.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs(proxmox): document Proxmox provisioning, data files, and security"
```

---

## Plan self-review (recorded)

- **Spec coverage:** host profiles → T2/T4/T9; PVE client + TLS pinning + inspect → T6; browse → T6/T9; mgmt keys → T4/T9/T12; presets → T4/T9/T12; provision (create→poll→start→discover→link) → T5/T8; live-progress job + persistence → T7/T8; auto-box + Phase-2 cross-link metadata → T8/**T8.5**; config knobs → T1; REST surface → T9; web UI → T11/T12; security (encryption/redaction/TLS/validation) → T2/T3/T4/T6/T9; docs → T13. No spec section is left without a task.
- **Placeholder scan:** no `TBD`/`TODO`/"handle errors"/"similar to" — every code/test step shows complete content. Example values are intentional placeholders (`example.com`, RFC1918, `user@pam!tmuxifier`).
- **Type/name consistency:** `createSecretBox`→`{seal,open,isSealed}`; `proxmoxStore.getHost(id,{withSecret})`, `getPreset`, `listKeys` consumed by T8/T9/T10 all exist; client methods (`nextId/createLxc/startLxc/taskStatus/taskLog/lxcInterfaces` for T8; `version/nodes/storages/templates/bridges/nextId` for T9) all defined in T6; `buildServer` new deps (`proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint`) match between T9 (destructure) and T10 (pass); web `pve.*` methods used in T12 are all defined in T11; `openProxmoxHub({openBox,onBoxLinked})` matches the T12 wiring. The found gap (real `store.js` dropping `proxmox`) is fixed by the added **Task 8.5**.

## Notes for the implementer

- **Order matters:** Tasks 1–8 are independent leaf modules; 8.5 patches the box store; 9 wires routes (needs 4+6+8); 10 wires `index.js` (needs all server modules); 11–12 are the web layer (need the routes from 9); 13 is docs. Build in number order.
- **No real Proxmox in CI.** All server tests inject fakes. End-to-end validation against a live PVE host is manual (spec's E2E note) — do it once at the end with a throwaway preset.
- **Watch the `insecure` TLS mode.** It exists but defaults off and is never auto-selected. If the user later decides to drop it, remove the `'insecure'` branch in `tlsOptionsFor` (T6) and the value from `VERIFY_MODES` (T3) — pinning already covers self-signed hosts.
