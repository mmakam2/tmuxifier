# Association Picker Row + Add-Mode Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Proxmox association picker's three selects render in one 3-wide row (no more scroll when linking), and the Add Box modal gains the same link-container section, committing against the freshly created box id.

**Architecture:** `createProxmoxAssociationEditor` widens to `Box | null` with a `commit(boxId)` signature; `openBoxDialog` constructs it in both modes and, in add mode, commits after `api.addBox` with a duplicate-add-proof partial-failure path. The picker's `field()` wrappers move into a `pve-picker-grid` CSS grid. Web-client only.

**Tech Stack:** TypeScript web client (`src/web/`), Vite, vitest (pure helpers only — no DOM tests), plain CSS, throwaway Playwright script for the visual gate.

**Spec:** `docs/superpowers/specs/2026-07-11-association-picker-add-mode-design.md`

## Global Constraints

- Web-client only — nothing under `src/server/` (the `PUT/DELETE /api/boxes/:id/proxmox` routes already serve both flows).
- Add-mode partial failure (box created, link failed): modal stays open with `Box added, but linking failed: <message> — retry from Edit box`, the box list refreshes, and the submit button stays **disabled** (a second click must not re-add). No provision panel on this path. The failure must NOT fall through to the generic outer catch (which re-enables submit).
- Edit-mode commit keeps today's position and refresh-and-rethrow failure handling; only the signature changes (`commit(box!.id)`).
- For a null box, every already-linked container option is disabled (`!!item.linkedBoxId && item.linkedBoxId !== box?.id`).
- No `innerHTML`; all strings via textContent/`el()` children.
- CSS verbatim from the spec: picker grid `1fr 1fr 1.6fr`, gap 8px; selects `width: 100%; min-width: 0`; collapse at `max-width: 620px`.
- Gate: `npm run typecheck && npm run build` clean + `npx vitest run test/proxmoxAssociation.test.js test/webIndex.test.js test/proxmoxWebClient.test.js` green + the Playwright screenshot pass in Step 6.

---

### Task 1: Picker row + add-mode linking

**Files:**
- Modify: `src/web/proxmoxAssociation.ts` (full-file replacement below)
- Modify: `src/web/main.ts:1148` (construction), `:1175` (assembly spread), `:1233` (edit commit), add-path block (~`:1266`)
- Modify: `src/web/style.css` (extend the `.box-pve-association` rules, ~line 597)
- Test: `test/proxmoxAssociation.test.js` (one added case)

**Interfaces:**
- Consumes: `api.addBox`, `api.setProxmoxLink(boxId, link)`, `api.clearProxmoxLink(boxId)`, `pve.hosts/nodes/nodeContainers`, `el`/`field` from `./dom` — all existing.
- Produces: `createProxmoxAssociationEditor(box: Box | null): { element: HTMLElement; commit(boxId: string): Promise<void> }` and unchanged `associationMutation`.

- [ ] **Step 1: Add the failing pure test**

Append to `test/proxmoxAssociation.test.js`:

```js
test('add mode with an untouched picker produces no mutation', () => {
  // current === undefined models add mode (no box yet); an unlinked draft must be a no-op.
  expect(associationMutation(undefined, { mode: 'unlinked' })).toBeNull();
});
```

Run: `npx vitest run test/proxmoxAssociation.test.js`
Expected: PASS already (the logic exists) — this pins the add-mode no-op contract before the refactor; it must still pass after Step 2.

- [ ] **Step 2: Replace `src/web/proxmoxAssociation.ts`**

Full new content (changes: `Box | null` param with a `current` capture, null-safe disable check, `commit(boxId)`, picker grid wrapper, dropped unused `err` import — a recorded ledger cleanup):

```ts
import { api, type Box, type PveBoxLink } from './api';
import { pve, type PveNodeContainer } from './proxmox';
import { el, field } from './dom';

type Draft = { mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number };

export function associationMutation(current: PveBoxLink | undefined, draft: Draft) {
  if (draft.mode === 'unlinked') return current ? { kind: 'unlink' as const } : null;
  if (!draft.hostId || !draft.node || !Number.isInteger(draft.vmid) || draft.vmid < 100) throw new Error('select a Proxmox container');
  if (current && current.hostId === draft.hostId && current.node === draft.node && current.vmid === draft.vmid) return null;
  return { kind: 'link' as const, link: { hostId: draft.hostId, node: draft.node, vmid: draft.vmid } };
}

// box is null in add mode: the box doesn't exist yet, so the caller passes the
// freshly created id to commit() after api.addBox resolves. The link/unlink
// calls themselves are unchanged — the server validates the target either way.
export function createProxmoxAssociationEditor(box: Box | null) {
  const current = box?.proxmox;
  let draft: Draft = current
    ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid }
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
      disabled: !!item.linkedBoxId && item.linkedBoxId !== box?.id,
    }, [`${item.vmid} | ${item.name} | ${item.state}${item.linkedBoxId && item.linkedBoxId !== box?.id ? ' | linked' : ''}`])));
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
    if (!current) return;
    const hosts = await pve.hosts();
    const hostName = hosts.find((item) => item.id === current.hostId)?.name ?? current.hostId;
    const containers = await pve.nodeContainers(current.hostId, current.node);
    const target = containers.find((item) => item.vmid === current.vmid);
    details.textContent = `${hostName} | ${current.node} | VMID ${current.vmid} | ${target?.name ?? 'missing'} | ${target?.state ?? 'missing'}`;
  }

  function renderSummary() {
    if (!current) {
      section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Not linked']), el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Link container']), message);
      return;
    }
    const details = el('div', {}, [`${current.hostId} | ${current.node} | VMID ${current.vmid}`]);
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
    draft = current
      ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid }
      : { mode: 'linked', hostId: '', node: '', vmid: 0 };
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      el('div', { class: 'pve-picker-grid' }, [field('Host', host), field('Node', node), field('Container', container)]),
      message,
    );
    await loadHosts(current?.hostId).catch(showError);
  }
  renderSummary();
  return {
    element: section,
    async commit(boxId: string) {
      const mutation = associationMutation(current, draft);
      if (mutation?.kind === 'link') await api.setProxmoxLink(boxId, mutation.link);
      if (mutation?.kind === 'unlink') await api.clearProxmoxLink(boxId);
    },
  };
}
```

- [ ] **Step 3: Wire both modes in `src/web/main.ts`**

Change the construction line (currently `const proxmoxAssociation = isEdit ? createProxmoxAssociationEditor(box!) : null;`):

```ts
  const proxmoxAssociation = createProxmoxAssociationEditor(box ?? null);
```

In the `modalBody.append(...)` call, replace the conditional spread `...(proxmoxAssociation ? [proxmoxAssociation.element] : []),` with:

```ts
    proxmoxAssociation.element,
```

In the edit branch of the submit handler, change `await proxmoxAssociation?.commit();` to:

```ts
          await proxmoxAssociation.commit(box!.id);
```

In the add branch, replace:

```ts
        const newBox = await api.addBox(spec);
        close();
        openProvisionPanel(newBox, {
```

with:

```ts
        const newBox = await api.addBox(spec);
        // The box now exists. A link failure must not fall through to the outer
        // catch (which re-enables submit — a second click would re-add a
        // duplicate host). Surface it here and leave submit disabled.
        try {
          await proxmoxAssociation.commit(newBox.id);
        } catch (error: any) {
          await refresh();
          err.textContent = `Box added, but linking failed: ${error?.message || error} — retry from Edit box`;
          return;
        }
        close();
        openProvisionPanel(newBox, {
```

- [ ] **Step 4: Extend the CSS in `src/web/style.css`**

Replace the existing rule `.box-pve-association select { padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: #131722; color: var(--text); }` with:

```css
.box-pve-association select { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: #131722; color: var(--text); }
.box-pve-association .pve-picker-grid { display: grid; grid-template-columns: 1fr 1fr 1.6fr; gap: 8px; align-items: start; }
@media (max-width: 620px) { .box-pve-association .pve-picker-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Gate**

Run: `npm run typecheck && npm run build && npx vitest run test/proxmoxAssociation.test.js test/webIndex.test.js test/proxmoxWebClient.test.js`
Expected: all clean/green (association tests: 4).

- [ ] **Step 6: Playwright visual + flow pass (throwaway script, mocked APIs — pattern from the box-modal change)**

Script requirements (place under the repo so node_modules resolves, e.g. `.superpowers/assoc-check.mjs`; delete after):
1. Serve `dist/`, intercept `**/api/**` with mocks: one existing box WITH a link (edit mode), `POST /api/boxes` returning `{ id: 'NEW1', … }`, `PUT /api/boxes/NEW1/proxmox` returning `{}` and recording the call, hosts/nodes/containers endpoints returning one host/node and containers `[{ vmid: 131, name: 'dev-01', state: 'running' }, { vmid: 140, name: 'db-01', state: 'stopped', linkedBoxId: 'B1' }]`.
2. Edit mode at 1280×900: click Edit → "Change association" → assert the three selects are side-by-side (equal `getBoundingClientRect().top` for the three `.pve-picker-grid select`s), the modal body does NOT scroll (`scrollHeight <= clientHeight` on `.modal-body`), and the actions row is inside the viewport.
3. Add mode at 1280×900: click + Add box → the association section shows "Not linked" + "Link container"; click it, select the container, fill Host with `192.168.1.99`, submit → assert the intercepted request order is `POST /api/boxes` then `PUT /api/boxes/NEW1/proxmox`, and the linked-elsewhere option (vmid 140) is disabled.
4. 500px-wide viewport: picker selects stack (different `top`s).

Run it, read the screenshots, report the assertion lines. Expected: all true.

- [ ] **Step 7: Commit**

```bash
git add src/web/proxmoxAssociation.ts src/web/main.ts src/web/style.css test/proxmoxAssociation.test.js
git commit -m "feat(ui): 3-wide association picker; link containers from Add Box"
```
