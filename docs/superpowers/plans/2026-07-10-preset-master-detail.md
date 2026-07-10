# Proxmox Preset Master-Detail Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Proxmox Presets tab's tile list and always-visible create form with a master-detail editor that creates, selects, updates, and deletes presets.

**Architecture:** Add a full-replacement `updatePreset(id, spec)` operation to the existing injected store and expose it through an authenticated `PUT` route plus the typed web fetch layer. Extract all Presets-tab ownership (state, form, dependent Proxmox loaders, additional-disk modal, and CRUD actions) from `proxmoxUi.ts` into `proxmoxPresets.ts`; the hub retains only its modal/tab shell and the Provision/History renderers.

**Tech Stack:** Node.js 20+ ESM server, Fastify 5, TypeScript DOM client, Vite, Vitest, CSS.

**Spec:** `docs/superpowers/specs/2026-07-10-preset-master-detail-design.md`

## Global Constraints

- Preset updates are complete replacement via `PUT /api/proxmox/presets/:id`; do not add PATCH or deep-merge semantics.
- `updatePreset(id, spec)` validates through the existing `assertPresetInput(spec, { hostIds })`, ignores its own id during name-uniqueness checks, and preserves the original `id` and `createdAt`.
- Unknown preset id returns `undefined` in the store and HTTP 404 from the route; invalid input returns HTTP 400 with `{ error }`; every preset route remains auth-gated.
- The initial Presets selection is **New preset** (`selected === null`); switching preset or hub tab silently discards unsaved edits.
- After create, select the returned preset; after save, keep the updated preset selected; after delete, select **New preset**.
- Saved node, root storage, template storage/template, and bridge values must remain selected if a Proxmox loader omits them or fails.
- A full-replacement edit must preserve saved fields not exposed by the form (`unprivileged`, `features`, `dns`, `onboot`, `startAfterCreate`, and `boxDefaults`); new presets retain the current defaults.
- The no-hosts pointer text and `openSettingsModal('proxmox')` action remain available.
- Provision and History behavior must not change; Provision continues to fetch presets each time its tab renders.
- No `innerHTML`; render server-derived values through `textContent`, DOM properties, or `el()` children.
- No new dependency and no DOM-test framework. Server and fetch-layer changes are TDD; UI acceptance uses typecheck/build plus the manual walkthrough in Task 4.
- ESM throughout; server files are `.js`, web files are `.ts`; use conventional commits and public-safe placeholders only.

---

### Task 1: Add full-replacement preset updates to the Proxmox store

**Files:**
- Modify: `test/proxmoxStore.test.js:10-116`
- Modify: `src/server/proxmoxStore.js:111-128`

**Interfaces:**
- Consumes: existing `assertPresetInput(spec, { hostIds })`, `assertUniqueName(list, name, ignoreId)`, `normalizePreset(spec, id, createdAt)`, `readAll()`, and `writeAll(data)`.
- Produces: `proxmoxStore.updatePreset(id: string, spec: object): Promise<object | undefined>`; successful calls return the normalized replacement, unknown ids return `undefined`, and validation failures reject without writing.

- [ ] **Step 1: Add deterministic preset fixtures to the store test**

Immediately after `HOST` in `test/proxmoxStore.test.js`, add a helper that always supplies a complete valid spec:

```js
const presetSpec = (hostId, overrides = {}) => ({
  name: 'dev', hostId, node: 'pve',
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: { nesting: true },
  net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
  dns: { nameserver: null, searchdomain: null },
  onboot: false, startAfterCreate: true,
  mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }],
  boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  ...overrides,
});
```

Replace the existing preset test with the same assertions backed by the shared fixture:

```js
test('presets validate against the existing host and persist normalized (keys are not preset-scoped)', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const preset = await store.addPreset(presetSpec(h.id));
  expect(preset.id).toBeTruthy();
  expect(preset.net.ipMode).toBe('dhcp');
  expect(preset.keyIds).toBeUndefined();
  expect(preset.mounts).toEqual([
    { id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true },
  ]);
  expect((await store.getPreset(preset.id)).name).toBe('dev');
  await expect(store.addPreset(presetSpec('ghost', { name: 'dev2' }))).rejects.toThrow(/host/);
});
```

- [ ] **Step 2: Write failing tests for replacement and identity preservation**

Add below the existing preset test:

```js
test('updatePreset replaces fields while preserving id and createdAt', async () => {
  const store = createProxmoxStore({
    dataDir: dir, secretBox, makeId: () => 'preset-1', now: () => '2026-07-10T12:00:00.000Z',
  });
  const host = await store.addHost(HOST);
  const original = await store.addPreset(presetSpec(host.id));

  const updated = await store.updatePreset(original.id, presetSpec(host.id, {
    name: 'production', cores: 6, memoryMiB: 8192,
    mounts: [{ id: 'mp0', storage: 'fast-lvm', sizeGiB: 32, path: '/srv', backup: false }],
  }));

  expect(updated).toMatchObject({
    id: 'preset-1', createdAt: '2026-07-10T12:00:00.000Z',
    name: 'production', cores: 6, memoryMiB: 8192,
  });
  expect(updated.mounts).toEqual([
    { id: 'mp0', storage: 'fast-lvm', sizeGiB: 32, path: '/srv', backup: false },
  ]);
  expect(await store.getPreset(original.id)).toEqual(updated);
});

test('updatePreset rejects invalid input without changing the stored preset', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  const original = await store.addPreset(presetSpec(host.id));

  await expect(store.updatePreset(original.id, presetSpec(host.id, { diskGiB: 0 })))
    .rejects.toThrow(/disk/);
  expect(await store.getPreset(original.id)).toEqual(original);
});

test('updatePreset ignores its own name but rejects another preset name', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  const dev = await store.addPreset(presetSpec(host.id));
  await store.addPreset(presetSpec(host.id, { name: 'production' }));

  await expect(store.updatePreset(dev.id, presetSpec(host.id, { name: 'dev', cores: 4 })))
    .resolves.toMatchObject({ id: dev.id, name: 'dev', cores: 4 });
  await expect(store.updatePreset(dev.id, presetSpec(host.id, { name: 'production' })))
    .rejects.toThrow(/name already exists/);
  expect((await store.getPreset(dev.id)).name).toBe('dev');
});

test('updatePreset returns undefined for an unknown id', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  expect(await store.updatePreset('missing', presetSpec(host.id))).toBeUndefined();
  expect(await store.listPresets()).toEqual([]);
});
```

- [ ] **Step 3: Run the store tests and confirm the new contract is missing**

Run:

```bash
npx vitest run test/proxmoxStore.test.js
```

Expected: the four new tests fail with `TypeError: store.updatePreset is not a function`; existing tests remain green.

- [ ] **Step 4: Implement `updatePreset` in `src/server/proxmoxStore.js`**

Insert it between `addPreset` and `removePreset`:

```js
    async updatePreset(id, spec) {
      const data = await readAll();
      const index = data.presets.findIndex((x) => x.id === id);
      if (index === -1) return undefined;
      assertPresetInput(spec, { hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, spec.name, id);
      const current = data.presets[index];
      const preset = normalizePreset(spec, current.id, current.createdAt);
      data.presets[index] = preset;
      await writeAll(data);
      return preset;
    },
```

Delete the obsolete final comment in `test/proxmoxStore.test.js` which says `updatePreset` was removed and preset changes are remove/re-add.

- [ ] **Step 5: Run the focused store tests**

Run:

```bash
npx vitest run test/proxmoxStore.test.js
```

Expected: all tests in `test/proxmoxStore.test.js` pass, including the four new `updatePreset` cases.

- [ ] **Step 6: Commit the store contract**

```bash
git add src/server/proxmoxStore.js test/proxmoxStore.test.js
git commit -m "feat(proxmox): add preset update persistence"
```

---

### Task 2: Expose preset updates through Fastify and the web fetch layer

**Files:**
- Modify: `test/server.test.js:30-60,790-850`
- Modify: `src/server/server.js:388-394`
- Modify: `test/proxmoxWebClient.test.js:1-38`
- Modify: `src/web/proxmox.ts:34-49`

**Interfaces:**
- Consumes: `proxmoxStore.updatePreset(id, spec)` from Task 1 and the existing generic `jr<T>()` response parser.
- Produces: authenticated `PUT /api/proxmox/presets/:id`; `pve.updatePreset(id: string, spec: unknown): Promise<PvePreset>`.

- [ ] **Step 1: Extend the server stub and write failing route tests**

In `proxmoxStubs(calls)`, add this method after `addPreset`:

```js
    updatePreset: async (id, spec) => {
      calls.push(['updatePreset', id, spec.name]);
      if (id === 'NOPE') return undefined;
      if (!spec.name) throw new Error('preset name is required');
      return { id, ...spec, createdAt: 't' };
    },
```

Add this test after the root-password route test and before the provision route test:

```js
test('PUT /api/proxmox/presets/:id requires auth, updates, validates, and 404s', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const payload = {
    name: 'production', hostId: 'H1', node: 'pve', template: 'local:vztmpl/debian-12.tar.zst',
    storage: 'local-lvm', diskGiB: 16, cores: 4, memoryMiB: 4096, swapMiB: 512,
    unprivileged: true, features: { nesting: true },
    net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
    dns: { nameserver: null, searchdomain: null }, mounts: [], onboot: false,
    startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  };

  expect((await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', payload,
  })).statusCode).toBe(401);

  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', headers, payload,
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ id: 'P1', name: 'production', cores: 4, createdAt: 't' });
  expect(calls).toContainEqual(['updatePreset', 'P1', 'production']);

  const invalid = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', headers, payload: { ...payload, name: '' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: 'preset name is required' });

  const missing = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/NOPE', headers, payload,
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'preset not found' });
});
```

- [ ] **Step 2: Run the server route test and verify it fails**

Run:

```bash
npx vitest run test/server.test.js -t "PUT /api/proxmox/presets"
```

Expected: FAIL because Fastify returns 404 for the unregistered PUT route.

- [ ] **Step 3: Register the authenticated PUT route**

In `src/server/server.js`, place this between POST and DELETE for presets:

```js
  app.put('/api/proxmox/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const preset = await proxmoxStore.updatePreset(req.params.id, req.body || {});
      if (!preset) return reply.code(404).send({ error: 'preset not found' });
      return preset;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
```

- [ ] **Step 4: Run the focused server route test**

Run:

```bash
npx vitest run test/server.test.js -t "PUT /api/proxmox/presets"
```

Expected: the new test passes with the 401, 200, 400, and 404 assertions green.

- [ ] **Step 5: Write a failing fetch-layer test for the PUT request**

Append to `test/proxmoxWebClient.test.js`:

```js
test('pve.updatePreset sends the full spec as JSON with PUT', async () => {
  const updated = { id: 'P1', name: 'production', cores: 4 };
  const calls = stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => updated });
  const spec = { name: 'production', cores: 4 };

  expect(await pve.updatePreset('P1', spec)).toEqual(updated);
  expect(calls[0].url).toBe('/api/proxmox/presets/P1');
  expect(calls[0].opts).toMatchObject({
    method: 'PUT', headers: { 'content-type': 'application/json' },
  });
  expect(JSON.parse(calls[0].opts.body)).toEqual(spec);
});
```

- [ ] **Step 6: Run the fetch-layer test and verify it fails**

Run:

```bash
npx vitest run test/proxmoxWebClient.test.js -t "updatePreset"
```

Expected: FAIL with `TypeError: pve.updatePreset is not a function`.

- [ ] **Step 7: Add a JSON request helper and `pve.updatePreset`**

In `src/web/proxmox.ts`, retain `post` and add a method-aware helper immediately after it:

```ts
const json = (method: 'POST' | 'PUT', value: unknown) => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
```

Change `post` to delegate without changing any caller behavior:

```ts
const post = (value: unknown) => json('POST', value);
```

Then add the new method between `addPreset` and `removePreset`:

```ts
  updatePreset(id: string, spec: unknown) {
    return jr<PvePreset>(fetch(`/api/proxmox/presets/${id}`, json('PUT', spec)));
  },
```

- [ ] **Step 8: Verify the route and fetch contract together**

Run:

```bash
npx vitest run test/server.test.js test/proxmoxWebClient.test.js
npm run typecheck
```

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 9: Commit the HTTP/client contract**

```bash
git add src/server/server.js src/web/proxmox.ts test/server.test.js test/proxmoxWebClient.test.js
git commit -m "feat(proxmox): expose preset update API"
```

---

### Task 3: Extract and replace the Presets tab with a master-detail editor

**Files:**
- Create: `src/web/proxmoxPresets.ts`
- Modify: `src/web/proxmoxUi.ts:1-195`
- Modify: `src/web/style.css:535-575`

**Interfaces:**
- Consumes: `pve.presets`, `pve.hosts`, host-dependent loaders, `pve.addPreset`, `pve.updatePreset`, `pve.removePreset`, `PvePreset`, `PveMount`, and shared `el`/`input`/`field`/`err`/`group` builders.
- Produces:
  - `export type PresetsDeps = { openSettingsModal: (tab: 'proxmox') => void }`
  - `renderPresetsTab(content: HTMLElement, deps: PresetsDeps): Promise<void>`
  - A private `replaceSelectOptions()` helper that inserts a selected `"(saved)"` fallback when lookup results omit a persisted value.
- The hub calls `renderPresetsTab(content, { openSettingsModal })`; no Presets code imports the hub.

- [ ] **Step 1: Create `src/web/proxmoxPresets.ts` and move preset ownership into it**

Create the file with this complete implementation:

```ts
import { pve, type PveHost, type PveMount, type PvePreset } from './proxmox';
import { el, err, field, group, input } from './dom';

export type PresetsDeps = { openSettingsModal: (tab: 'proxmox') => void };

type Option = { value: string; label?: string };

function replaceSelectOptions(
  select: HTMLSelectElement,
  options: Option[],
  savedValue: string | null = null,
) {
  const rows = [...options];
  if (savedValue && !rows.some((option) => option.value === savedValue)) {
    rows.unshift({ value: savedValue, label: `${savedValue} (saved)` });
  }
  select.replaceChildren(...rows.map((option) =>
    el('option', { value: option.value }, [option.label ?? option.value])));
  if (savedValue) select.value = savedValue;
}

function templateStorage(template: string) {
  const separator = template.indexOf(':');
  return separator > 0 ? template.slice(0, separator) : '';
}

function openAddDiskModal(opts: { id: string; storages: string[]; onAdd: (mount: PveMount) => void }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal pve-disk-modal' });
  const close = () => backdrop.remove();
  let pressed = false;
  backdrop.addEventListener('mousedown', (event) => { pressed = event.target === backdrop; });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop && pressed) close();
  });

  const storage = el('select', {}, opts.storages.map((name) =>
    el('option', { value: name }, [name]))) as HTMLSelectElement;
  const size = input('8', { type: 'number', min: '1' });
  const path = input('', { placeholder: '/data' });
  const backup = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const box = el('div', {});
  const add = el('button', {
    type: 'submit', class: 'pve-primary', onclick: (event: Event) => {
      event.preventDefault();
      box.querySelector('.pve-err')?.remove();
      const mountPath = path.value.trim();
      if (!storage.value) { box.append(err('Pick a storage for the disk.')); return; }
      if (!mountPath.startsWith('/')) { box.append(err('Path must be absolute, e.g. /data.')); return; }
      opts.onAdd({
        id: opts.id, storage: storage.value, sizeGiB: Number(size.value) || 1,
        path: mountPath, backup: backup.checked,
      });
      close();
    },
  }, ['Add disk']);
  const cancel = el('button', { type: 'button', class: 'pve-btn', onclick: close }, ['Cancel']);

  box.append(
    el('h3', {}, ['Add disk']),
    field('Storage', storage), field('Disk size (GiB)', size), field('Path', path),
    el('label', { class: 'check-field' }, [backup, el('span', {}, ['Include in backups'])]),
    el('div', { class: 'modal-actions' }, [cancel, add]),
  );
  modal.append(box);
  backdrop.append(modal);
  document.body.append(backdrop);
}

export async function renderPresetsTab(content: HTMLElement, deps: PresetsDeps): Promise<void> {
  const [initialPresets, hosts] = await Promise.all([
    pve.presets().catch(() => [] as PvePreset[]),
    pve.hosts().catch(() => [] as PveHost[]),
  ]);
  let presets = initialPresets;
  let selected: PvePreset | null = null;

  const master = el('div', { class: 'pve-preset-master' });
  const detail = el('div', { class: 'pve-preset-detail' });
  const layout = el('div', { class: 'pve-presets-layout' }, [master, detail]);
  content.replaceChildren(layout);

  function selectPreset(preset: PvePreset | null) {
    selected = preset;
    renderMaster();
    void renderDetail();
  }

  function renderMaster() {
    const list = el('div', { class: 'pve-preset-master-list' }, presets.map((preset) =>
      el('button', {
        type: 'button',
        class: `pve-preset-master-row${selected?.id === preset.id ? ' active' : ''}`,
        onclick: () => selectPreset(preset),
      }, [preset.name])));
    const create = el('button', {
      type: 'button',
      class: `pve-btn pve-preset-new${selected === null ? ' active' : ''}`,
      onclick: () => selectPreset(null),
    }, ['+ New preset']);
    master.replaceChildren(create, list);
  }

  async function renderDetail() {
    if (!hosts.length) {
      detail.replaceChildren(
        el('div', { class: 'pve-sub' }, [
          'Add a Proxmox host in Settings → Proxmox before creating a preset.',
        ]),
        el('div', {}, [el('button', {
          type: 'button', class: 'pve-btn',
          onclick: () => deps.openSettingsModal('proxmox'),
        }, ['Open Settings'])]),
      );
      return;
    }

    const editing = selected;
    const name = input(editing?.name ?? '', { placeholder: 'debian-dev' });
    const host = el('select', {}) as HTMLSelectElement;
    replaceSelectOptions(host, hosts.map((item) => ({ value: item.id, label: item.name })), editing?.hostId ?? null);
    const node = el('select', {}) as HTMLSelectElement;
    const template = el('select', {}) as HTMLSelectElement;
    const templateStore = el('select', {}) as HTMLSelectElement;
    const storage = el('select', {}) as HTMLSelectElement;
    const bridge = el('select', {}) as HTMLSelectElement;
    const disk = input(String(editing?.diskGiB ?? 8), { type: 'number', min: '1' });
    const cores = input(String(editing?.cores ?? 2), { type: 'number', min: '1' });
    const memory = input(String(editing?.memoryMiB ?? 2048), { type: 'number', min: '16' });
    const swap = input(String(editing?.swapMiB ?? 512), { type: 'number', min: '0' });
    const ipMode = el('select', {}, [
      el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static']),
    ]) as HTMLSelectElement;
    ipMode.value = editing?.net.ipMode ?? 'dhcp';
    const cidr = input(editing?.net.cidr ?? '', { placeholder: '192.168.1.50/24' });
    const gateway = input(editing?.net.gateway ?? '', { placeholder: '192.168.1.1' });
    const vlan = input(editing?.net.vlan == null ? '' : String(editing.net.vlan), {
      placeholder: 'vlan (optional)', type: 'number',
    });
    const cidrGateway = el('div', { class: 'pve-grid' }, [
      field('CIDR', cidr), field('Gateway', gateway),
    ]);
    const syncNetwork = () => {
      cidrGateway.style.display = ipMode.value === 'static' ? '' : 'none';
    };
    ipMode.addEventListener('change', syncNetwork);

    const box = el('div', { class: 'pve-preset-form' });
    const mounts = (editing?.mounts ?? []).map((mount) => ({ ...mount }));
    const mountsList = el('div', { class: 'pve-list' });
    let rootdirStorages: string[] = [];

    function renderMounts() {
      mountsList.replaceChildren(...mounts.map((mount, index) =>
        el('div', { class: 'pve-row' }, [
          el('div', {}, [
            el('strong', {}, [mount.id]),
            el('span', { class: 'pve-sub' }, [
              ` ${mount.storage}:${mount.sizeGiB} → ${mount.path}${mount.backup ? ' · backup' : ''}`,
            ]),
          ]),
          el('button', {
            type: 'button', class: 'danger', onclick: () => {
              mounts.splice(index, 1);
              renderMounts();
            },
          }, ['Remove']),
        ])));
    }

    const addDisk = el('button', {
      type: 'button', class: 'pve-btn', onclick: () => {
        const used = new Set(mounts.map((mount) => mount.id));
        let number = 0;
        while (used.has(`mp${number}`)) number += 1;
        openAddDiskModal({
          id: `mp${number}`, storages: rootdirStorages,
          onAdd: (mount) => { mounts.push(mount); renderMounts(); },
        });
      },
    }, ['+ Add disk']);

    async function loadTemplates(saved: PvePreset | null) {
      const storageName = templateStore.value;
      if (!node.value || !storageName) {
        replaceSelectOptions(template, [], saved?.template ?? null);
        return;
      }
      const templates = await pve.templates(host.value, node.value, storageName).catch(() => []);
      replaceSelectOptions(
        template,
        templates.map((item) => ({
          value: item.volid, label: item.volid.split('/').pop() || item.volid,
        })),
        saved?.template ?? null,
      );
    }

    async function loadNodeScoped(saved: PvePreset | null) {
      if (!node.value) {
        rootdirStorages = [];
        replaceSelectOptions(storage, [], saved?.storage ?? null);
        replaceSelectOptions(bridge, [], saved?.net.bridge ?? null);
        replaceSelectOptions(templateStore, [], saved ? templateStorage(saved.template) : null);
        await loadTemplates(saved);
        return;
      }
      const [groups, bridges] = await Promise.all([
        pve.storage(host.value, node.value).catch(() => ({ rootdir: [], vztmpl: [] })),
        pve.bridges(host.value, node.value).catch(() => []),
      ]);
      rootdirStorages = groups.rootdir.map((item) => item.storage);
      replaceSelectOptions(
        storage, groups.rootdir.map((item) => ({ value: item.storage })), saved?.storage ?? null,
      );
      replaceSelectOptions(
        bridge, bridges.map((item) => ({ value: item.iface })), saved?.net.bridge ?? null,
      );
      replaceSelectOptions(
        templateStore,
        groups.vztmpl.map((item) => ({ value: item.storage })),
        saved ? templateStorage(saved.template) : null,
      );
      await loadTemplates(saved);
    }

    async function loadNodes(saved: PvePreset | null) {
      node.replaceChildren(el('option', {}, ['Loading...']));
      const nodes = await pve.nodes(host.value).catch(() => []);
      replaceSelectOptions(
        node, nodes.map((item) => ({ value: item.node })), saved?.node ?? null,
      );
      await loadNodeScoped(saved);
    }

    host.addEventListener('change', () => void loadNodes(null));
    node.addEventListener('change', () => void loadNodeScoped(null));
    templateStore.addEventListener('change', () => void loadTemplates(null));

    function buildSpec() {
      return {
        name: name.value.trim(), hostId: host.value, node: node.value || null,
        template: template.value, storage: storage.value, diskGiB: Number(disk.value),
        cores: Number(cores.value), memoryMiB: Number(memory.value), swapMiB: Number(swap.value),
        unprivileged: editing?.unprivileged ?? true,
        features: editing?.features ?? { nesting: true },
        net: {
          bridge: bridge.value, vlan: vlan.value ? Number(vlan.value) : null,
          ipMode: ipMode.value, cidr: cidr.value.trim() || null,
          gateway: gateway.value.trim() || null,
        },
        dns: editing?.dns ?? { nameserver: null, searchdomain: null },
        onboot: editing?.onboot ?? false,
        startAfterCreate: editing?.startAfterCreate ?? true,
        mounts,
        boxDefaults: editing?.boxDefaults ?? { user: 'root', sessionName: 'web', tags: [] },
      };
    }

    const submit = el('button', { type: 'submit', class: 'pve-primary' }, [editing ? 'Save' : 'Create']);
    submit.addEventListener('click', async (event) => {
      event.preventDefault();
      box.querySelector('.pve-err')?.remove();
      submit.disabled = true;
      try {
        const preset = editing
          ? await pve.updatePreset(editing.id, buildSpec())
          : await pve.addPreset(buildSpec());
        presets = editing
          ? presets.map((item) => item.id === preset.id ? preset : item)
          : [...presets, preset];
        selected = preset;
        renderMaster();
        await renderDetail();
      } catch (error) {
        box.append(err((error as Error).message));
        submit.disabled = false;
      }
    });

    const actions: HTMLElement[] = [];
    if (editing) {
      const remove = el('button', { type: 'button', class: 'pve-btn danger' }, ['Delete']);
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove preset ${editing.name}?`)) return;
        box.querySelector('.pve-err')?.remove();
        remove.disabled = true;
        try {
          await pve.removePreset(editing.id);
          presets = presets.filter((preset) => preset.id !== editing.id);
          selected = null;
          renderMaster();
          await renderDetail();
        } catch (error) {
          box.append(err((error as Error).message));
          remove.disabled = false;
        }
      });
      actions.push(remove);
    }
    actions.push(submit);

    box.append(
      el('h3', {}, [editing ? 'Edit container preset' : 'Create a container preset']),
      group('Identity', field('Preset Name', name), field('Host', host), field('Node', node)),
      group('Template', field('Template storage', templateStore), field('Template', template)),
      group('Disk', el('div', { class: 'pve-grid' }, [
        field('Storage (rootfs)', storage), field('Disk GiB', disk),
      ])),
      group('Additional disks', mountsList, addDisk),
      group('Resources', el('div', { class: 'pve-grid-3' }, [
        field('Cores', cores), field('Memory MiB', memory), field('Swap MiB', swap),
      ])),
      group('Network', field('Bridge', bridge), field('IP mode', ipMode),
        cidrGateway, field('VLAN', vlan)),
      el('div', { class: 'modal-actions pve-preset-actions' }, actions),
    );
    detail.replaceChildren(box);
    renderMounts();
    syncNetwork();
    await loadNodes(editing);
  }

  renderMaster();
  await renderDetail();
}
```

- [ ] **Step 2: Reduce `proxmoxUi.ts` to the tab shell plus Provision/History**

Change the imports at the top to remove `PveMount`, `input` is still used by Provision, and add the new renderer:

```ts
import { api, type Box } from './api';
import { pve, type PvePreset, type ProvisionStatus } from './proxmox';
import { openProvisionTerminal } from './terminal';
import { el, input, field, err } from './dom';
import { openSettingsModal } from './settingsUi';
import { renderPresetsTab } from './proxmoxPresets';
```

Delete the entire private `openAddDiskModal` function and the entire nested `renderPresets` function. Remove `group` from the `dom` import because Provision/History do not use it.

Change the renderer table entry from:

```ts
    Presets: renderPresets, Provision: renderProvision, History: renderHistory,
```

to:

```ts
    Presets: () => renderPresetsTab(content, { openSettingsModal }),
    Provision: renderProvision,
    History: renderHistory,
```

Keep `setContent` directly before `renderProvision`; Provision and History continue to use it without any other changes.

- [ ] **Step 3: Add master-detail layout styles and responsive constraints**

Change the hub width and add the new rules in the Proxmox hub section of `src/web/style.css`:

```css
.modal.pve-hub { width: 760px; max-height: 86vh; }
.modal.pve-disk-modal { width: 380px; }
.pve-presets-layout { display: grid; grid-template-columns: minmax(150px, 190px) minmax(0, 1fr); gap: 16px; align-items: start; }
.pve-preset-master { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 16px; border-right: 1px solid var(--border); }
.pve-preset-master-list { display: flex; flex-direction: column; gap: 4px; }
.pve-preset-master-row { width: 100%; min-width: 0; padding: 8px 10px; overflow: hidden; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-size: 13px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.pve-preset-master-row:hover { background: var(--panel-2); }
.pve-preset-master-row.active { border-color: #2f6feb; background: var(--panel-2); }
.pve-preset-new { width: 100%; text-align: left; }
.pve-preset-new.active { border-color: #2f6feb; }
.pve-preset-detail { min-width: 0; }
.pve-preset-detail > .pve-sub + div { margin-top: 10px; }
.pve-preset-form { min-width: 0; }
.pve-preset-form h3 { margin: 0 0 12px; font-size: 14px; }
.pve-preset-actions .danger { margin-right: auto; color: #f85149; }

@media (max-width: 720px) {
  .modal.pve-hub { width: 92vw; }
  .pve-presets-layout { grid-template-columns: minmax(0, 1fr); }
  .pve-preset-master { padding: 0 0 12px; border-right: 0; border-bottom: 1px solid var(--border); }
  .pve-preset-master-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .pve-grid, .pve-grid-3 { grid-template-columns: minmax(0, 1fr); }
}
```

Do not change the existing generic `.pve-list`, `.pve-row`, `.pve-group`, select, or button rules; the detail form and disk list still depend on them.

- [ ] **Step 4: Run static client verification**

Run:

```bash
npm run typecheck
npm run build
npx vitest run test/proxmoxWebClient.test.js test/settingsForm.test.js test/webIndex.test.js
```

Expected: TypeScript and Vite succeed; all selected client tests pass. Fix any unused imports left by the extraction rather than weakening compiler settings.

- [ ] **Step 5: Review the extraction diff for ownership and unintended behavior changes**

Run:

```bash
git diff -- src/web/proxmoxUi.ts src/web/proxmoxPresets.ts src/web/style.css
rg -n "renderPresets|openAddDiskModal|PveMount|group" src/web/proxmoxUi.ts
```

Expected: the diff removes only Presets-tab/add-disk-modal code from `proxmoxUi.ts`; the `rg` command prints no matches; Provision and History bodies are byte-for-byte unchanged.

- [ ] **Step 6: Commit the master-detail UI**

```bash
git add src/web/proxmoxPresets.ts src/web/proxmoxUi.ts src/web/style.css
git commit -m "feat(ui): add preset master-detail editor"
```

---

### Task 4: Document the module boundary and verify the complete workflow

**Files:**
- Modify: `AGENTS.md` (web-client architecture paragraph)
- Modify: `CLAUDE.md` (matching web-client architecture paragraph)

**Interfaces:**
- Consumes: all contracts from Tasks 1-3.
- Produces: repository guidance that identifies `proxmoxPresets.ts` as the owner of Presets-tab master-detail CRUD and loader fallback behavior.

- [ ] **Step 1: Update both architecture documents**

In the Web client architecture paragraph in both `AGENTS.md` and `CLAUDE.md`, replace:

```markdown
`proxmox.ts`/`proxmoxUi.ts` (the Proxmox hub, now operations-only: Presets, Provision, and
History tabs — host/secret setup lives in the settings modal),
```

with:

```markdown
`proxmox.ts`/`proxmoxUi.ts` (the Proxmox fetch layer and operations-only hub shell: Presets,
Provision, and History tabs — host/secret setup lives in the settings modal),
`proxmoxPresets.ts` (the Presets tab's master-detail create/edit/delete form, dependent Proxmox
loaders, stale saved-option fallbacks, and additional-disk modal),
```

- [ ] **Step 2: Run the full automated verification gate**

Run:

```bash
npm test
npm run build
```

Expected: `npm test` completes with typecheck plus the full Vitest suite green; Vite produces `dist/` successfully.

- [ ] **Step 3: Start the development server for the manual walkthrough**

Run:

```bash
npm run dev
```

Expected: Vite prints a local web URL and the backend starts without configuration errors. Keep this session running while completing Steps 4-6. If the configured backend cannot start because the local `.env` lacks required credentials, run the already-configured production service instead and record that limitation in the final handoff; do not add test secrets to committed files.

- [ ] **Step 4: Walk through create, selection, save, and delete**

In the browser:

1. Open **Proxmox → Presets** and confirm **New preset** is active initially with a blank form and **Create** action.
2. Create a preset with host, node, template storage, template, root storage, resource, static-network, VLAN, and additional-disk values; confirm the created preset becomes the active master row.
3. Select **New preset**, then reselect the created preset; confirm every exposed field and mount is prefilled.
4. Change the name, host-dependent selections, resource values, IP mode/static fields, VLAN, and mounts; click **Save**.
5. Switch away and reselect it; confirm the saved values persisted and the Provision tab lists the renamed preset without any Provision behavior change.
6. Click **Delete**, cancel once to prove the confirm guard, then delete; confirm selection falls back to **New preset** and the row disappears.

Expected: Create/Save/Delete failures, if induced, render as `.pve-err` inside the detail pane and do not reset the active selection.

- [ ] **Step 5: Walk through stale loader values and no-hosts behavior**

Using a disposable preset/host configuration:

1. Open a saved preset after making its node, root storage, template storage/template, or bridge unavailable (or while its host endpoint is unreachable).
2. Confirm each unavailable persisted value appears as a selected `"(saved)"` option and Save can submit it unchanged when it remains validator-safe.
3. With no Proxmox hosts configured, open Presets and confirm the Settings → Proxmox pointer plus **Open Settings** button render; click it and confirm the Proxmox settings tab opens above the hub.
4. Switch from a modified-but-unsaved preset to another preset and from Presets to Provision; confirm no dirty-state dialog appears and edits are discarded.

- [ ] **Step 6: Stop the development server and inspect the final diff**

Stop the dev command with `Ctrl-C`, then run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: no dev process remains; `git diff --check` prints nothing; only the planned source, tests, CSS, and architecture docs are changed (plus pre-existing user changes, if any).

- [ ] **Step 7: Commit documentation**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: document preset editor module"
```

Do not commit `dist/` unless it is already intentionally tracked by the repository and changed by the normal release workflow.
