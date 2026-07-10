# Tabbed Settings Modal (NetBox | Proxmox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ⚙ settings modal into a tabbed shell (NetBox | Proxmox) and move Proxmox host + secret setup there from the Proxmox hub, which slims to Presets / Provision / History.

**Architecture:** Web-client reorganization only — zero server/route/store changes. Shared DOM helpers extracted from `proxmoxUi.ts` into `dom.ts`; `settingsUi.ts` becomes a tab shell; the NetBox form moves to `settingsNetbox.ts`; the hub's `renderHosts`/`renderSecrets` move to `settingsProxmox.ts`; the hub gains an "Open Settings" pointer in its no-hosts empty state.

**Tech Stack:** TypeScript web client (`src/web/`), Vite build, vitest (node — no DOM tests), existing `pve`/`nbx` fetch layers.

**Spec:** `docs/superpowers/specs/2026-07-10-settings-tabs-proxmox-design.md`

## Global Constraints

- **No changes under `src/server/`** — routes, stores, validators are already shared and stay untouched.
- Behavior-preserving moves: the NetBox form and the hosts/secrets renderers keep their exact `nbx.*`/`pve.*` calls, field behaviors, and error rendering; only their home module and mount point change.
- No `innerHTML` in any new/changed code — all dynamic strings via `textContent`/values/`el()` children (XSS discipline; these views render server-derived strings).
- Settings modal: **560px** wide, `max-height: 86vh`, appended to **`document.body`** (stacks above the hub), Escape + ✕ + genuine-backdrop-click close with the keydown listener removed on every close path.
- Per-tab semantics stay different by design: NetBox = form with explicit Save; Proxmox = immediate CRUD.
- Import direction: `proxmoxUi.ts` → `settingsUi.ts` only; `settingsUi`/`settingsNetbox`/`settingsProxmox` never import the hub.
- Verification gate per task: `npm run typecheck && npm run build` clean + client tests green (`npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js`). No DOM tests exist in this repo.
- ESM, client is `.ts`; conventional-commit messages; public repo — placeholders only (`example.com`, RFC1918 IPs).

---

### Task 1: Extract shared DOM helpers into `dom.ts`

**Files:**
- Create: `src/web/dom.ts`
- Modify: `src/web/proxmoxUi.ts:8-24` (delete the local helper definitions, import them instead)

**Interfaces:**
- Consumes: nothing.
- Produces (moved verbatim from `proxmoxUi.ts` where they are currently private):
  - `export type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>`
  - `el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: (Node | string)[]): HTMLElementTagNameMap[K]`
  - `input(value?: string, attrs?: Attrs): HTMLInputElement`
  - `field(label: string, control: HTMLElement): HTMLLabelElement` — `<label class="field"><span>…</span>{control}</label>`
  - `err(msg: string): HTMLDivElement` — `<div class="pve-err">`
  - `group(label: string, ...children: (Node | string)[]): HTMLDivElement`

- [ ] **Step 1: Create `src/web/dom.ts`**

Move the five helpers + `Attrs` type verbatim from `proxmoxUi.ts` (they start right after the `HubOpts` type), adding `export`:

```ts
// src/web/dom.ts
// Shared DOM builders for the imperative views (Proxmox hub, settings modal).
// All text lands as text nodes / attributes — never innerHTML.
export type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
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
export function input(value = '', attrs: Attrs = {}) { const i = el('input', attrs); i.value = value; return i; }
export function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
export function err(msg: string) { return el('div', { class: 'pve-err' }, [msg]); }
export function group(label: string, ...children: (Node | string)[]) { return el('div', { class: 'pve-group' }, [el('div', { class: 'pve-eyebrow' }, [label]), ...children]); }
```

- [ ] **Step 2: Update `src/web/proxmoxUi.ts`**

Delete the local `type Attrs` and the five function definitions (`el`, `input`, `field`, `err`, `group`) and add to the imports at the top:

```ts
import { el, input, field, err, group, type Attrs } from './dom';
```

If `tsc` then reports `Attrs` unused in `proxmoxUi.ts`, drop `type Attrs` from the import — nothing else in the file references it directly.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build && npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js`
Expected: all clean/green (7 tests across the three files).

- [ ] **Step 4: Commit**

```bash
git add src/web/dom.ts src/web/proxmoxUi.ts
git commit -m "refactor(ui): extract shared DOM builders into dom.ts"
```

---

### Task 2: Settings shell + `settingsNetbox.ts`

`settingsUi.ts` becomes a tabbed shell (hub-style chrome); the NetBox form moves to `settingsNetbox.ts` with identical behavior. After this task the modal has a single NetBox tab; Task 3 adds Proxmox.

**Files:**
- Create: `src/web/settingsNetbox.ts`
- Modify: `src/web/settingsUi.ts` (full rewrite to the shell below)
- Modify: `src/web/style.css:266` (widen the modal; add section/spacing rules)

**Interfaces:**
- Consumes: `el` from `./dom` (Task 1); `field` from `./dom`; existing `nbx`/`settingsForm` exports.
- Produces:
  - `settingsNetbox.ts`: `renderNetboxSection(content: HTMLElement, close: () => void): Promise<void>` — renders the form into `content`; `close` is the shell's close (Cancel / successful Save / successful Clear call it).
  - `settingsUi.ts`: `openSettingsModal(tab?: SettingsTab): void` with `export type SettingsTab = 'netbox'` (Task 3 widens the union to `'netbox' | 'proxmox'`). `main.ts`'s existing `void openSettingsModal()` call needs no change.

- [ ] **Step 1: Create `src/web/settingsNetbox.ts`**

This is the body of the current `openSettingsModal` with four changes: no backdrop/modal/title (the shell owns chrome and close paths), the local `field` helper replaced by the `dom.ts` import, the form gets class `settings-section` instead of `modal settings-modal`, and it mounts via `content.replaceChildren(form)`.

```ts
// src/web/settingsNetbox.ts
// The NetBox tab of the settings modal: URL + write-only token + TLS mode +
// Test Connection (with the TOFU pin offer) + Clear. Form semantics: explicit Save.
import { nbx, type NetboxSettings } from './netbox';
import { buildSavePayload, describeTestResult, isHttps, type NetboxFormState } from './settingsForm';
import { field } from './dom';

export async function renderNetboxSection(content: HTMLElement, close: () => void): Promise<void> {
  let current: NetboxSettings | null = null;
  try { current = (await nbx.get()).settings; } catch { /* render empty form */ }

  const form = document.createElement('form');
  form.className = 'settings-section';

  const section = document.createElement('h3');
  section.textContent = 'NetBox API integration';

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'https://netbox.example.com';
  url.value = current?.url ?? '';
  url.autocomplete = 'off';

  const token = document.createElement('input');
  token.type = 'password';
  token.placeholder = current?.hasToken ? 'token saved — leave blank to keep' : 'NetBox API token';
  token.autocomplete = 'new-password';

  const httpNote = document.createElement('p');
  httpNote.className = 'settings-hint';
  httpNote.textContent = 'http:// — the token travels in cleartext; LAN use only.';

  // TLS mode (https only)
  const tlsGroup = document.createElement('fieldset');
  tlsGroup.className = 'radio-group';
  const tlsLegend = document.createElement('legend');
  tlsLegend.textContent = 'TLS verification';
  tlsGroup.append(tlsLegend);
  let tlsMode: 'ca' | 'pin' | 'insecure' = current?.tlsMode ?? 'ca';
  let fingerprint256: string | null = current?.fingerprint256 ?? null;
  const fpHint = document.createElement('p');
  fpHint.className = 'settings-hint settings-fp';
  function renderFp() {
    fpHint.textContent = tlsMode === 'pin'
      ? (fingerprint256 ? `pinned: ${fingerprint256}` : 'no fingerprint pinned yet — run Test Connection to fetch it')
      : '';
  }
  function makeTls(value: 'ca' | 'pin' | 'insecure', label: string) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'netboxTlsMode';
    input.value = value;
    input.checked = tlsMode === value;
    input.addEventListener('change', () => { if (input.checked) { tlsMode = value; renderFp(); } });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return wrap;
  }
  tlsGroup.append(
    makeTls('ca', 'CA-verified (default)'),
    makeTls('pin', 'Pinned fingerprint (self-signed)'),
    makeTls('insecure', 'No verification (not recommended)'),
    fpHint,
  );
  renderFp();

  function syncSchemeUi() {
    const https = isHttps(url.value);
    tlsGroup.hidden = !https;
    httpNote.hidden = https || !/^http:\/\//i.test(url.value.trim());
  }
  url.addEventListener('input', syncSchemeUi);

  // Test Connection
  const testRow = document.createElement('div');
  testRow.className = 'settings-test';
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.textContent = 'Test Connection';
  const testOut = document.createElement('span');
  testOut.className = 'settings-hint';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.textContent = 'Pin this certificate';
  pinBtn.hidden = true;
  testRow.append(testBtn, pinBtn);

  function formState(): NetboxFormState {
    return { url: url.value, token: token.value, tlsMode, fingerprint256, hasToken: !!current?.hasToken };
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    pinBtn.hidden = true;
    testOut.className = 'settings-hint';
    testOut.textContent = 'Testing…';
    try {
      const body: Record<string, unknown> = { url: url.value.trim() };
      if (token.value.trim()) body.token = token.value.trim();
      if (isHttps(url.value)) { body.tlsMode = tlsMode; if (fingerprint256) body.fingerprint256 = fingerprint256; }
      const result = describeTestResult(await nbx.test(body));
      testOut.textContent = result.text;
      testOut.className = `settings-hint ${result.ok ? 'ok' : 'err'}`;
      if (result.offerPin) {
        pinBtn.hidden = false;
        pinBtn.onclick = () => {
          fingerprint256 = result.offerPin;
          tlsMode = 'pin';
          (tlsGroup.querySelector('input[value="pin"]') as HTMLInputElement).checked = true;
          renderFp();
          pinBtn.hidden = true;
          testOut.textContent = 'fingerprint pinned — run Test Connection again';
          testOut.className = 'settings-hint';
        };
      }
    } catch (ex) {
      testOut.textContent = ex instanceof Error ? ex.message : 'test failed';
      testOut.className = 'settings-hint err';
    } finally { testBtn.disabled = false; }
  });

  const errLine = document.createElement('p');
  errLine.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'settings-clear';
  clearBtn.hidden = !current;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  actions.append(clearBtn, cancel, submit);

  form.append(section, field('NetBox URL', url), httpNote, field('API token', token), tlsGroup, testRow, testOut, errLine, actions);
  content.replaceChildren(form);
  syncSchemeUi();

  cancel.addEventListener('click', close);

  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Remove the NetBox integration settings (including the stored token)?')) return;
    try { await nbx.clear(); close(); }
    catch (ex) { errLine.textContent = ex instanceof Error ? ex.message : 'could not clear settings'; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    const { payload, error } = buildSavePayload(formState());
    if (!payload) { errLine.textContent = error ?? 'invalid settings'; return; }
    submit.disabled = true;
    try { await nbx.save(payload); close(); }
    catch (ex) {
      errLine.textContent = ex instanceof Error ? ex.message : 'could not save settings';
      submit.disabled = false;
    }
  });
}
```

(The variable `err` from the old file is renamed `errLine` here to avoid shadowing `dom.ts`'s `err` helper if it is ever imported later; behavior identical.)

- [ ] **Step 2: Rewrite `src/web/settingsUi.ts` as the shell**

```ts
// src/web/settingsUi.ts
// The app-wide settings modal: a tabbed shell (hub-style chrome); each tab is
// a self-contained section module rendering into the content area.
import { el } from './dom';
import { renderNetboxSection } from './settingsNetbox';

export type SettingsTab = 'netbox';

type Section = { label: string; render: (content: HTMLElement, close: () => void) => void | Promise<void> };

const SECTIONS: Record<SettingsTab, Section> = {
  netbox: { label: 'NetBox', render: renderNetboxSection },
};

export function openSettingsModal(tab: SettingsTab = 'netbox'): void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal settings-modal' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  // Only close on a genuine backdrop click (see the box modal for why mousedown
  // must also have started on the backdrop).
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  function selectTab(t: SettingsTab) {
    for (const b of tabStrip.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    void SECTIONS[t].render(content, close);
  }
  for (const [key, s] of Object.entries(SECTIONS) as [SettingsTab, Section][]) {
    tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': key, onclick: () => selectTab(key) }, [s.label]));
  }

  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Settings']), el('button', { type: 'button', class: 'pve-close', title: 'Close', onclick: close }, ['✕'])]),
    tabStrip, content,
  );
  backdrop.append(modal);
  document.body.append(backdrop);
  selectTab(tab);
}
```

Note the mount point moves from `#app` to `document.body` (spec: the modal must stack above the Proxmox hub, which also mounts on `document.body`). `main.ts` needs no change — its handler already reads `void openSettingsModal()` and the return-type change (`Promise<void>` → `void`) is compatible.

- [ ] **Step 3: Update `src/web/style.css`**

Replace the line `.modal.settings-modal { width: 430px; }` with:

```css
.modal.settings-modal { width: 560px; max-height: 86vh; }
.settings-modal .settings-section { display: flex; flex-direction: column; gap: 10px; }
```

(The tab chrome reuses the existing top-level `.pve-head`/`.pve-close`/`.pve-tabs`/`.pve-tab`/`.pve-content` rules — verified unscoped. The existing `.modal.settings-modal h3` and `settings-hint`/`settings-test`/`settings-fp`/`settings-clear` rules stay as-is.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build && npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js`
Expected: all clean/green.

Static self-check: grep `src/web/settingsUi.ts src/web/settingsNetbox.ts` for `innerHTML` — zero matches; confirm every close path (✕, Escape, backdrop, Cancel, Save-success, Clear-success) funnels through the shell's `close()` which removes the keydown listener.

- [ ] **Step 5: Commit**

```bash
git add src/web/settingsUi.ts src/web/settingsNetbox.ts src/web/style.css
git commit -m "feat(ui): tabbed settings shell; NetBox form becomes its first section"
```

---

### Task 3: `settingsProxmox.ts` + hub slimming

The atomic move: Settings gains the Proxmox tab in the same commit the hub loses Hosts + LXC Secrets.

**Files:**
- Create: `src/web/settingsProxmox.ts`
- Modify: `src/web/settingsUi.ts` (widen `SettingsTab`, add the section entry)
- Modify: `src/web/proxmoxUi.ts` (delete `renderHosts`/`renderSecrets`, trim `TABS`, default tab, empty-state pointer, import `openSettingsModal`)

**Interfaces:**
- Consumes: `el/input/field/err` from `./dom` (Task 1); `pve` from `./proxmox`; the `Section` shape from Task 2 (`render(content, close)` — this section ignores `close`; CRUD is immediate).
- Produces: `renderProxmoxSection(content: HTMLElement): Promise<void>`; `SettingsTab` widens to `'netbox' | 'proxmox'`; the hub calls `openSettingsModal('proxmox')` from its no-hosts empty state.

- [ ] **Step 1: Create `src/web/settingsProxmox.ts`**

The two renderers move from `proxmoxUi.ts` with three mechanical changes: they build and return elements instead of calling the hub's `setContent`, every self-refresh (`void renderHosts()` / `void renderSecrets()`) becomes `rerender()` (re-renders the whole tab), and helpers come from `dom.ts`. All `pve.*` calls, strings, and behaviors are verbatim.

```ts
// src/web/settingsProxmox.ts
// The Proxmox tab of the settings modal: host profiles (endpoint/token/TLS)
// and LXC secrets (default key, additional SSH keys, root password).
// Immediate-CRUD semantics, moved from the Proxmox hub.
import { pve } from './proxmox';
import { el, input, field, err } from './dom';

export async function renderProxmoxSection(content: HTMLElement): Promise<void> {
  const rerender = () => { void renderProxmoxSection(content); };
  const [hostsPart, secretsPart] = await Promise.all([hostsSection(rerender), secretsSection(rerender)]);
  content.replaceChildren(hostsPart, el('hr', { class: 'pve-hr' }), secretsPart);
}

// --- Hosts (moved from proxmoxUi.ts renderHosts) ---
async function hostsSection(rerender: () => void): Promise<HTMLElement> {
  const hosts = await pve.hosts().catch(() => []);
  const list = el('div', { class: 'pve-list' }, hosts.map((h) => {
    const status = el('span', { class: 'pve-test-status', 'aria-live': 'polite' });
    const testBtn = el('button', { type: 'button', onclick: async () => {
      status.className = 'pve-test-status pending'; status.textContent = '…'; status.title = 'Testing…';
      try {
        await pve.testHost(h.id);
        status.className = 'pve-test-status ok'; status.textContent = '✓'; status.title = 'Reachable';
      } catch (e) {
        status.className = 'pve-test-status err'; status.textContent = '✗'; status.title = `Test failed: ${(e as Error).message}`;
      }
    } }, ['Test']);
    return el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [h.name]), el('span', { class: 'pve-sub' }, [` ${h.endpoint} · ${h.verifyMode}`])]),
      el('div', { class: 'pve-row-actions' }, [
        status,
        testBtn,
        el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove host ${h.name}?`)) { await pve.removeHost(h.id); rerender(); } } }, ['Remove']),
      ]),
    ]);
  }));

  const name = input('', { placeholder: 'lab-pve' });
  const endpoint = input('', { placeholder: 'pve.example.com:8006' });
  const tokenId = input('', { placeholder: 'user@pam!tmuxifier' });
  const tokenSecret = input('', { placeholder: 'token secret (uuid)', type: 'password' });
  const defaultNode = input('', { placeholder: 'pve (optional default node)' });
  const fpLine = el('div', { class: 'pve-sub' }, ['Click Inspect to fetch and pin the TLS certificate.']);
  let verifyMode: 'pin' | 'ca' | 'insecure' = 'pin';
  let fingerprint256: string | null = null;
  const box = el('div', {});

  const inspectBtn = el('button', { type: 'button', class: 'pve-btn', onclick: async () => {
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
      rerender();
    } catch (er) { box.append(err((er as Error).message)); }
  } }, ['Add host']);

  box.append(
    el('h3', {}, ['Add a Proxmox host']),
    field('Name', name), field('Endpoint', endpoint), field('Token id', tokenId), field('Token secret', tokenSecret),
    el('div', { class: 'pve-inline' }, [inspectBtn, fpLine]),
    field('Default node', defaultNode),
    el('div', { class: 'modal-actions' }, [save]),
  );
  return el('div', {}, [list, el('hr', { class: 'pve-hr' }), box]);
}

// --- LXC Secrets (moved from proxmoxUi.ts renderSecrets) ---
async function secretsSection(rerender: () => void): Promise<HTMLElement> {
  const [keys, dk, pw] = await Promise.all([
    pve.keys().catch(() => []),
    pve.defaultKey().catch(() => ({ publicKey: null })),
    pve.rootPasswordStatus().catch(() => ({ set: false })),
  ]);

  // Default management key (read-only) — the Tmuxifier host's own key, always injected.
  const defaultSection = el('div', {}, [
    el('h3', {}, ['Default management key']),
    dk.publicKey
      ? el('div', { class: 'pve-row' }, [el('span', { class: 'pve-sub' }, [`Tmuxifier host key (auto-injected): ${dk.publicKey.slice(0, 54)}…`])])
      : el('div', { class: 'pve-err' }, ['No key found in the Tmuxifier host’s ~/.ssh. Create one or set TMUXIFIER_PVE_DEFAULT_PUBKEY, or Tmuxifier won’t be able to connect to provisioned containers.']),
  ]);

  // Additional keys — sealed at rest, shown masked.
  const list = el('div', { class: 'pve-list' }, keys.map((k) => el('div', { class: 'pve-row' }, [
    el('div', {}, [el('strong', {}, [k.name]), el('span', { class: 'pve-sub' }, [' · ••• set'])]),
    el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove key ${k.name}?`)) { await pve.removeKey(k.id); rerender(); } } }, ['Remove']),
  ])));
  const name = input('', { placeholder: 'laptop' });
  const pk = el('textarea', { class: 'pve-textarea', placeholder: 'ssh-ed25519 AAAA… you@example.com', rows: 3 });
  const keyBox = el('div', {});
  const addKey = el('button', { type: 'submit', onclick: async (e) => {
    e.preventDefault(); keyBox.querySelector('.pve-err')?.remove();
    try { await pve.addKey({ name: name.value.trim(), publicKey: (pk as HTMLTextAreaElement).value.trim() }); rerender(); }
    catch (er) { keyBox.append(err((er as Error).message)); }
  } }, ['Add key']);
  keyBox.append(el('h3', {}, ['Additional keys']), el('div', { class: 'pve-sub' }, ['Injected into every provisioned container, alongside the default key.']), list, field('Name', name), field('Public key', pk), el('div', { class: 'modal-actions' }, [addKey]));

  // Root password — optional, write-only.
  const pwBox = el('div', {});
  const p1 = input('', { type: 'password', placeholder: pw.set ? 'enter a new password to replace' : 'root password (optional)' });
  const p2 = input('', { type: 'password', placeholder: 'confirm' });
  const pwActions = el('div', { class: 'modal-actions' }, [
    el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); pwBox.querySelector('.pve-err')?.remove();
      if (p1.value !== p2.value) { pwBox.append(err('Passwords do not match.')); return; }
      try { await pve.setRootPassword(p1.value); rerender(); }
      catch (er) { pwBox.append(err((er as Error).message)); }
    } }, ['Save password']),
  ]);
  if (pw.set) pwActions.append(el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm('Clear the root password?')) { await pve.clearRootPassword(); rerender(); } } }, ['Clear']));
  pwBox.append(
    el('h3', {}, [pw.set ? 'Root password (••• set)' : 'Root password (optional)']),
    el('div', { class: 'pve-sub' }, ['Set as the container root password on every provision. At least 5 characters. Leave blank for key-only access.']),
    field('Password', p1), field('Confirm', p2), pwActions,
  );

  return el('div', {}, [defaultSection, el('hr', { class: 'pve-hr' }), keyBox, el('hr', { class: 'pve-hr' }), pwBox]);
}
```

- [ ] **Step 2: Register the tab in `src/web/settingsUi.ts`**

```ts
import { renderProxmoxSection } from './settingsProxmox';

export type SettingsTab = 'netbox' | 'proxmox';

const SECTIONS: Record<SettingsTab, Section> = {
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
};
```

- [ ] **Step 3: Slim `src/web/proxmoxUi.ts`**

1. Delete the entire `renderHosts` and `renderSecrets` functions (including their `// --- Hosts ---` / `// --- LXC Secrets … ---` comment headers).
2. Update the tab wiring:

```ts
const TABS = ['Presets', 'Provision', 'History'] as const;
```

```ts
  let active: Tab = 'Presets';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Presets: renderPresets, Provision: renderProvision, History: renderHistory,
  };
```

and the initial `selectTab('Hosts')` becomes `selectTab('Presets')`.

3. Add the import (hub → settings direction only):

```ts
import { openSettingsModal } from './settingsUi';
```

4. Replace the Presets tab's no-hosts empty state:

```ts
    if (!hosts.length) {
      setContent(list, el('hr', { class: 'pve-hr' }),
        el('div', { class: 'pve-sub' }, ['Add a Proxmox host in Settings → Proxmox before creating a preset.']),
        el('div', {}, [el('button', { type: 'button', class: 'pve-btn', onclick: () => openSettingsModal('proxmox') }, ['Open Settings'])]),
      );
      return;
    }
```

(The Provision tab's "Create a preset first." message stays — it points at a hub tab, not at Settings. The Settings modal opens above the still-open hub; per spec v1 does not auto-refresh the hub when Settings closes — re-selecting the Presets tab refreshes it.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build && npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js`
Expected: all clean/green.

Static self-checks:
- `grep -n "renderHosts\|renderSecrets\|addHost\|removeHost\|testHost\|addKey\|removeKey\|rootPassword\|defaultKey" src/web/proxmoxUi.ts` → zero matches (all host/secret UI gone from the hub).
- `grep -n "innerHTML" src/web/settingsProxmox.ts` → zero matches.
- `grep -n "from './proxmoxUi'" src/web/settingsUi.ts src/web/settingsNetbox.ts src/web/settingsProxmox.ts` → zero matches (no reverse import).

- [ ] **Step 5: Commit**

```bash
git add src/web/settingsProxmox.ts src/web/settingsUi.ts src/web/proxmoxUi.ts
git commit -m "feat(ui): move Proxmox host & secret setup into Settings; slim the hub to operations"
```

---

### Task 4: Docs + full suite + manual walkthrough

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (web-client module paragraph — apply identical edits to both)
- Modify: `README.md` (any text describing where Proxmox hosts/secrets are configured)

- [ ] **Step 1: Update the web-client paragraph in `CLAUDE.md` and `AGENTS.md`**

In the "Web client is `src/web/` …" paragraph, update the two entries (matching each file's surrounding phrasing):
- `proxmox.ts`/`proxmoxUi.ts` → note the hub is now operations-only: presets, provisioning, and history (host/secret setup lives in the settings modal).
- `settingsUi.ts` → describe the tabbed shell: the ⚙ settings modal with NetBox (`settingsNetbox.ts`) and Proxmox host/secret (`settingsProxmox.ts`) tabs, `settingsForm.ts` (pure payload/result helpers), `netbox.ts` (fetch layer), and `dom.ts` (shared DOM builders used by the settings modal and the hub).

- [ ] **Step 2: Update `README.md`**

`grep -n -i "hosts\|settings" README.md`, then update any sentence that says Proxmox hosts / SSH keys / root password are managed in the Proxmox hub (or its Hosts / LXC Secrets tabs) to say they are configured in **Settings (⚙) → Proxmox**, and the existing settings-modal sentence to mention both tabs. Placeholders only; no real hostnames/IPs/emails.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: typecheck clean + all vitest files green (548 tests as of the branch base; count must not decrease).

- [ ] **Step 4: Manual walkthrough (from the spec — perform in the running app and report results)**

1. Gear → modal opens with NetBox | Proxmox tabs, NetBox active; the form works as before (save/test/pin/clear).
2. Proxmox tab: hosts list renders; Inspect → pin → Add host works; Test/Remove work; add/remove SSH key works; root password set/clear works.
3. Proxmox hub: only Presets / Provision / History tabs, defaults to Presets.
4. With zero hosts: Presets tab shows the pointer; "Open Settings" opens the modal on the Proxmox tab **above** the hub.
5. A Settings-created host appears in the preset editor's Host dropdown.
6. Escape / ✕ / backdrop click close the settings modal from either tab.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: settings modal tabs; Proxmox host/secret setup moved to Settings"
```
