// The Proxmox tab of the settings modal, in two sections: the host profiles
// Tmuxifier talks to, and what every provisioned container is given (a default
// SSH key, extra keys, an optional root password). Immediate-CRUD semantics, moved
// from the Proxmox hub.
//
// This is the DOM half. Everything the operator reads, and every decision a form
// makes before it calls the server, lives in settingsProxmoxView.ts (unit-tested);
// network-sourced text (PVE errors, versions, public keys) only ever lands via
// textContent.
//
// Three rules shape the layout, all learned from the first version of this tab:
//  - A form is a real <form>, so Enter submits, and it stays closed behind a key
//    until asked for. At most one is open at a time (EditorSlot), which is also what
//    keeps the panel to one commit key.
//  - Inspect sits beside the endpoint because it depends on nothing else, and an edit
//    to the endpoint drops the inspection: a fingerprint belongs to one address.
//  - A host row says what state it is in. Every host is tested when the tab opens, and
//    a failure is written out in the row, not tucked into a tooltip.
import { pve, type PveHost, type PveKey } from './proxmox';
import { el } from './dom';
import { armReduce, ARM_MS, IDLE, type ArmState } from './arming';
import { writeClipboard } from './clipboard';
import {
  verifyFace, hostStateOf, splitPublicKey, certFace, validateAddHost, validateAddKey, validatePassword,
  ROOT_PASSWORD_MIN, type CertFace,
} from './settingsProxmoxView';

type Rerender = (notice?: string) => void;

// A render is async and `content` is shared with every other tab, so a render that
// finishes after the operator moved on (a newer render, or another tab) must not
// paint over whatever is there now. One settings modal exists at a time, so one counter.
let generation = 0;

// Called by the tab shell when the tab is left.
export function disposeProxmoxSection(): void { generation += 1; }

export async function renderProxmoxSection(content: HTMLElement, notice?: string): Promise<void> {
  const gen = ++generation;
  const rerender: Rerender = (n) => { void renderProxmoxSection(content, n); };
  const [hosts, keys, defaultKey, rootPassword] = await Promise.all([
    load(pve.hosts()), load(pve.keys()), load(pve.defaultKey()), load(pve.rootPasswordStatus()),
  ]);
  if (generation !== gen) return;

  const slot = createEditorSlot();
  const checks: (() => Promise<void>)[] = [];
  const noticeEl = notice ? el('p', { class: 'settings-hint ok pvs-notice', role: 'status', tabindex: -1 }, [notice]) : null;
  content.replaceChildren(
    ...(noticeEl ? [noticeEl] : []),
    hostsSection(hosts, slot, rerender, checks),
    accessSection({ keys, defaultKey, rootPassword }, slot, rerender),
  );
  noticeEl?.focus({ preventScroll: true });
  // Every host is tested once its row is in the page, so a result always has a row to land in.
  for (const run of checks) void run();
}

// A failed read is its own state. Folding it into "empty" would show a fresh-install
// form to an operator whose hosts simply did not load.
type Loaded<T> = { value: T; error: null } | { value: null; error: string };
async function load<T>(p: Promise<T>): Promise<Loaded<T>> {
  try { return { value: await p, error: null }; }
  catch (e) { return { value: null, error: (e as Error).message || 'request failed' }; }
}

let uid = 0;
const nid = (prefix: string) => `pvs-${prefix}-${++uid}`;

// --- Shared bits ------------------------------------------------------------

// A label tied to its control by id. The control may be a row that also holds a key
// (the endpoint's Inspect), which a wrapping <label> would fold into the field's name.
function labelled(text: string, control: HTMLElement, forId: string, extra: (Node | string)[] = []): HTMLElement {
  return el('div', { class: 'field' }, [el('label', { for: forId }, [text]), control, ...extra]);
}

function textInput(attrs: Record<string, string | boolean | number> = {}): HTMLInputElement {
  const i = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', ...attrs });
  if (!i.id) i.id = nid('in');
  return i;
}

// Error line of a form: one persistent alert region whose text changes, which
// announces reliably where inserting a fresh role="alert" node often does not.
function errorSlot(): { node: HTMLElement; set: (message: string | null) => void } {
  const node = el('div', { class: 'pvs-form-err', role: 'alert' });
  return { node, set: (m) => { node.textContent = m ?? ''; } };
}

// At most one form open per tab. Opening one closes the others: one task at a time,
// and one commit key in view.
interface EditorSlot { take(close: () => void): void; release(close: () => void): void }
function createEditorSlot(): EditorSlot {
  let current: (() => void) | null = null;
  return {
    take(close) { if (current && current !== close) current(); current = close; },
    release(close) { if (current === close) current = null; },
  };
}

interface Editor { toggle: HTMLButtonElement; panel: HTMLElement }
// A form behind a key. It is rebuilt on every open, so a cancelled draft never
// reappears. `startOpen` is the empty-tab case: nothing to go back to, so no Cancel.
function makeEditor(slot: EditorSlot, label: string, startOpen: boolean, build: (c: { close: () => void; dismissible: boolean }) => HTMLFormElement): Editor {
  const panel = el('div', { class: 'pvs-editor', id: nid('editor') });
  const toggle = el('button', { type: 'button', class: 'pvs-add', 'aria-expanded': 'false', 'aria-controls': panel.id }, [label]);
  // `close` is also what the slot calls when another form opens, so it must not move focus;
  // the form's own Cancel goes through `cancel`, which hands focus back to the key.
  const close = () => {
    panel.replaceChildren();
    panel.hidden = true;
    toggle.hidden = false;
    toggle.setAttribute('aria-expanded', 'false');
    slot.release(close);
  };
  const cancel = () => { close(); toggle.focus(); };
  const show = (focus: boolean) => {
    slot.take(close);
    panel.replaceChildren(build({ close: cancel, dismissible: !startOpen }));
    panel.hidden = false;
    toggle.hidden = true;
    toggle.setAttribute('aria-expanded', 'true');
    if (focus) panel.querySelector<HTMLElement>('input, textarea')?.focus();
  };
  toggle.addEventListener('click', () => show(true));
  panel.hidden = true;
  if (startOpen) show(false);
  return { toggle, panel };
}

// Arm-then-fire for an action with no undo (the house pattern, arming.ts): the first
// click states the consequence, the second commits; time, or focus leaving, disarms.
function armable(btn: HTMLButtonElement, armedText: string, fire: () => void | Promise<void>): void {
  const idleText = btn.textContent ?? '';
  let state: ArmState = IDLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => {
    const on = state.armed !== null;
    btn.classList.toggle('armed', on);
    btn.textContent = on ? armedText : idleText;
  };
  const disarm = () => { clearTimeout(timer); state = armReduce(state, { type: 'dismiss' }).state; paint(); };
  btn.addEventListener('click', () => {
    const out = armReduce(state, { type: 'click', id: 'self', armable: true });
    state = out.state;
    clearTimeout(timer);
    paint();
    if (state.armed) timer = setTimeout(() => { state = armReduce(state, { type: 'timeout' }).state; paint(); }, ARM_MS);
    if (out.fire) void fire();
  });
  btn.addEventListener('blur', disarm);
}

function sectionHead(title: string, id: string, ...tail: (Node | null)[]): HTMLElement {
  return el('div', { class: 'pvs-head' }, [el('h3', { id }, [title]), ...tail.filter((n): n is Node => n !== null)]);
}

function loadFailure(what: string, message: string, rerender: Rerender): HTMLElement {
  return el('div', { class: 'pvs-fail' }, [
    el('span', {}, [`Couldn’t load ${what}: ${message}`]),
    el('button', { type: 'button', class: 'pve-btn', onclick: () => rerender() }, ['Retry']),
  ]);
}

// --- Hosts ------------------------------------------------------------------

function hostsSection(hosts: Loaded<PveHost[]>, slot: EditorSlot, rerender: Rerender, checks: (() => Promise<void>)[]): HTMLElement {
  const titleId = nid('title');
  const section = el('section', { class: 'pvs-section', 'aria-labelledby': titleId });
  if (hosts.value === null) {
    section.append(sectionHead('Proxmox hosts', titleId), loadFailure('hosts', hosts.error, rerender));
    return section;
  }
  const list = hosts.value;
  const editor = makeEditor(slot, '+ Add host', list.length === 0, (c) => addHostForm(c, rerender));
  section.append(sectionHead('Proxmox hosts', titleId, list.length ? el('span', { class: 'pvs-count' }, [String(list.length)]) : null, editor.toggle));
  if (list.length === 0) {
    section.append(el('p', { class: 'pvs-lead' }, [
      'Tmuxifier provisions and manages containers through the Proxmox API. Create an API token first (Datacenter → Permissions → API Tokens), then add the host here. The token is stored encrypted and is never shown again.',
    ]));
  } else {
    section.append(el('ul', { class: 'pvs-list' }, list.map((h) => hostRow(h, rerender, checks))));
  }
  section.append(editor.panel);
  return section;
}

function hostRow(h: PveHost, rerender: Rerender, checks: (() => Promise<void>)[]): HTMLElement {
  const lamp = el('span', { class: 'dot', 'aria-hidden': 'true' });
  const stateLine = el('div', { class: 'pvs-row-state' });
  const paint = (check: Parameters<typeof hostStateOf>[0]) => {
    const s = hostStateOf(check);
    lamp.className = s.lamp === 'off' ? 'dot' : `dot ${s.lamp}`;
    stateLine.className = s.tone === 'err' ? 'pvs-row-state bad' : 'pvs-row-state';
    stateLine.textContent = s.text;
  };

  const testBtn = el('button', { type: 'button', 'aria-label': `Test ${h.name}` }, ['Test']);
  const run = async () => {
    paint({ phase: 'checking' });
    testBtn.disabled = true;
    try { const r = await pve.testHost(h.id); paint({ phase: 'ok', version: r.version }); }
    catch (e) { paint({ phase: 'error', message: (e as Error).message }); }
    finally { testBtn.disabled = false; }
  };
  // A press is announced; the passive check on open is not (three rows settling at once would be noise).
  testBtn.addEventListener('click', () => { stateLine.setAttribute('aria-live', 'polite'); void run(); });
  paint({ phase: 'checking' });
  checks.push(run);

  const removeBtn = el('button', { type: 'button', class: 'danger', 'aria-label': `Remove ${h.name}` }, ['Remove']);
  armable(removeBtn, 'Really remove?', async () => {
    try { await pve.removeHost(h.id); rerender(`Removed ${h.name}.`); }
    catch (e) { stateLine.setAttribute('aria-live', 'polite'); paint({ phase: 'error', message: `Could not remove: ${(e as Error).message}` }); }
  });

  const face = verifyFace(h.verifyMode);
  const sub = [h.endpoint, h.tokenId, h.defaultNode ? `node ${h.defaultNode}` : ''].filter(Boolean).join(' · ');
  return el('li', { class: 'pvs-row' }, [
    lamp,
    el('div', { class: 'pvs-row-main' }, [
      el('div', { class: 'pvs-row-title' }, [
        el('strong', {}, [h.name]),
        el('span', { class: face.tone === 'warn' ? 'pve-badge warn' : 'pve-badge', title: face.title }, [face.label]),
      ]),
      el('div', { class: 'pvs-row-sub' }, [sub]),
      stateLine,
    ]),
    el('div', { class: 'pvs-row-actions' }, [testBtn, removeBtn]),
  ]);
}

function addHostForm(c: { close: () => void; dismissible: boolean }, rerender: Rerender): HTMLFormElement {
  const certId = nid('cert');
  const endpoint = textInput({ placeholder: 'e.g. pve.example.com:8006', inputmode: 'url', 'aria-describedby': certId });
  const inspectBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Inspect']);
  const cert = el('div', { class: 'pvs-cert', id: certId, 'aria-live': 'polite' });
  const name = textInput({ placeholder: 'e.g. lab-pve' });
  const tokenId = textInput({ placeholder: 'e.g. root@pam!tmuxifier' });
  const tokenSecret = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'token secret (UUID)', id: nid('in') });
  const defaultNode = textInput({ placeholder: 'e.g. pve1' });
  const error = errorSlot();

  let inspected: CertFace | null = null;
  const paintCert = (face: CertFace | null, busy = false) => {
    // `bad`, not `err`: a bare .err is the login line's centred rule.
    cert.className = busy || !face ? 'pvs-cert' : `pvs-cert ${face.tone === 'err' ? 'bad' : face.tone}`;
    if (busy) { cert.textContent = 'Inspecting…'; return; }
    if (!face) { cert.textContent = 'Inspect reads the certificate and decides how this host is verified.'; return; }
    const kids: (Node | string)[] = [];
    if (face.mode) kids.push(el('span', { class: 'pve-badge' }, [verifyFace(face.mode).label]), ' ');
    kids.push(face.text);
    if (face.mode === 'pin' && face.fingerprint) kids.push(el('code', { class: 'pvs-fp' }, [face.fingerprint]));
    cert.replaceChildren(...kids);
  };
  paintCert(null);

  // A fingerprint belongs to one address: editing the endpoint drops the inspection.
  endpoint.addEventListener('input', () => { if (inspected) { inspected = null; paintCert(null); } });
  // Enter here means "check this endpoint", not "submit a form that is not ready".
  endpoint.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inspectBtn.click(); } });

  inspectBtn.addEventListener('click', async () => {
    error.set(null);
    const ep = endpoint.value.trim();
    if (!ep) { error.set('Enter the endpoint, like pve.example.com:8006.'); endpoint.focus(); return; }
    inspectBtn.disabled = true;
    inspected = null;
    paintCert(null, true);
    try {
      const face = certFace(await pve.inspect(ep));
      if (endpoint.value.trim() !== ep) return;   // edited while the request was out
      inspected = face.mode ? face : null;
      paintCert(face);
    } catch (e) {
      if (endpoint.value.trim() !== ep) return;
      paintCert({ tone: 'err', mode: null, fingerprint: null, text: (e as Error).message || 'Inspect failed.' });
    } finally { inspectBtn.disabled = false; }
  });

  const submit = el('button', { type: 'submit' }, ['Add host']);
  const cancel = el('button', { type: 'button', onclick: c.close }, ['Cancel']);
  const form = el('form', { class: 'pvs-form', novalidate: true, 'aria-label': 'Add a Proxmox host' }, [
    ...(c.dismissible ? [el('h4', { class: 'pvs-form-title' }, ['Add a Proxmox host'])] : []),   // on an empty tab the section legend and lead already say so
    labelled('Endpoint', el('div', { class: 'pvs-input-row' }, [endpoint, inspectBtn]), endpoint.id, [cert]),
    labelled('Name', name, name.id),
    el('div', { class: 'field-grid' }, [labelled('Token id', tokenId, tokenId.id), labelled('Token secret', tokenSecret, tokenSecret.id)]),
    labelled('Default node (optional)', defaultNode, defaultNode.id),
    error.node,
    el('div', { class: 'modal-actions' }, c.dismissible ? [cancel, submit] : [submit]),
  ]);

  const focusOf = { endpoint, name, tokenId, tokenSecret, inspect: inspectBtn } as const;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.set(null);
    const bad = validateAddHost({
      name: name.value, endpoint: endpoint.value, tokenId: tokenId.value, tokenSecret: tokenSecret.value,
      mode: inspected?.mode ?? null, fingerprint256: inspected?.fingerprint ?? null,
    });
    if (bad) { error.set(bad.message); focusOf[bad.field].focus(); return; }
    const label = name.value.trim();
    submit.disabled = true; submit.textContent = 'Adding…';
    try {
      await pve.addHost({
        name: label, endpoint: endpoint.value.trim(), tokenId: tokenId.value.trim(), tokenSecret: tokenSecret.value,
        verifyMode: inspected!.mode!, fingerprint256: inspected!.fingerprint, defaultNode: defaultNode.value.trim() || null,
      });
      rerender(`Added ${label}.`);
    } catch (er) {
      error.set((er as Error).message);
      submit.disabled = false; submit.textContent = 'Add host';
    }
  });
  return form;
}

// --- Access for new containers ----------------------------------------------

function accessSection(
  data: { keys: Loaded<PveKey[]>; defaultKey: Loaded<{ publicKey: string | null }>; rootPassword: Loaded<{ set: boolean }> },
  slot: EditorSlot, rerender: Rerender,
): HTMLElement {
  const titleId = nid('title');
  return el('section', { class: 'pvs-section', 'aria-labelledby': titleId }, [
    sectionHead('Access for new containers', titleId),
    el('p', { class: 'pvs-lead' }, ['Applied to every container Tmuxifier provisions, so it can connect once the container is up.']),
    defaultKeyBlock(data.defaultKey, rerender),
    extraKeysBlock(data.keys, slot, rerender),
    rootPasswordBlock(data.rootPassword, slot, rerender),
  ]);
}

function blockHead(title: string, ...tail: (Node | null)[]): HTMLElement {
  return el('div', { class: 'pvs-block-head' }, [el('h4', { class: 'pvs-block-title' }, [title]), ...tail.filter((n): n is Node => n !== null)]);
}

function defaultKeyBlock(dk: Loaded<{ publicKey: string | null }>, rerender: Rerender): HTMLElement {
  const block = el('div', { class: 'pvs-block' }, [blockHead('Default key')]);
  if (dk.value === null) { block.append(loadFailure('the default key', dk.error, rerender)); return block; }
  const pub = dk.value.publicKey;
  if (!pub) {
    block.append(el('div', { class: 'pvs-row' }, [
      el('span', { class: 'dot red', 'aria-hidden': 'true' }),
      el('div', { class: 'pvs-row-main' }, [
        el('div', { class: 'pvs-row-title' }, [el('strong', {}, ['No key found'])]),
        el('div', { class: 'pvs-row-state bad' }, [
          'There is no public key in the Tmuxifier host’s ~/.ssh. Create one with ssh-keygen, or set TMUXIFIER_PVE_DEFAULT_PUBKEY. Without it Tmuxifier can’t connect to the containers it provisions.',
        ]),
      ]),
    ]));
    return block;
  }
  const parts = splitPublicKey(pub);
  const copy = el('button', { type: 'button', 'aria-label': 'Copy the default public key' }, ['Copy']);
  copy.addEventListener('click', async () => {
    const ok = await writeClipboard(pub, { clipboard: navigator.clipboard, fallbackCopy: legacyCopy });
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
  });
  block.append(
    el('p', { class: 'pvs-block-note' }, ['The Tmuxifier host’s own key, added automatically.']),
    el('div', { class: 'pvs-row' }, [
      el('span', { class: 'dot green', 'aria-hidden': 'true' }),
      el('div', { class: 'pvs-row-main' }, parts
        ? [
          el('div', { class: 'pvs-row-title' }, [el('span', { class: 'pve-badge' }, [parts.type]), el('code', { class: 'pvs-key' }, [parts.body])]),
          ...(parts.comment ? [el('div', { class: 'pvs-row-sub' }, [parts.comment])] : []),
        ]
        : [el('code', { class: 'pvs-key' }, [`${pub.slice(0, 54)}…`])]),
      el('div', { class: 'pvs-row-actions' }, [copy]),
    ]),
  );
  return block;
}

// execCommand fallback for a page served over plain http, where navigator.clipboard is absent.
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  const keep = document.activeElement as HTMLElement | null;
  (keep?.closest('.modal') ?? document.body).append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  keep?.focus();
  return ok;
}

function extraKeysBlock(keys: Loaded<PveKey[]>, slot: EditorSlot, rerender: Rerender): HTMLElement {
  if (keys.value === null) return el('div', { class: 'pvs-block' }, [blockHead('Additional keys'), loadFailure('the key list', keys.error, rerender)]);
  const editor = makeEditor(slot, '+ Add key', false, (c) => addKeyForm(c, rerender));
  const block = el('div', { class: 'pvs-block' }, [blockHead('Additional keys', editor.toggle)]);
  if (keys.value.length === 0) {
    block.append(el('p', { class: 'pvs-empty' }, ['None added. Extra keys are added to every container alongside the default key.']));
  } else {
    block.append(el('p', { class: 'pvs-block-note' }, ['Added to every container alongside the default key.']));
    block.append(el('ul', { class: 'pvs-list' }, keys.value.map((k) => {
      const remove = el('button', { type: 'button', class: 'danger', 'aria-label': `Remove key ${k.name}` }, ['Remove']);
      const line = el('div', { class: 'pvs-row-state bad' });
      armable(remove, 'Really remove?', async () => {
        try { await pve.removeKey(k.id); rerender(`Removed key ${k.name}.`); }
        catch (e) { line.textContent = `Could not remove: ${(e as Error).message}`; }
      });
      return el('li', { class: 'pvs-row nolamp' }, [
        el('div', { class: 'pvs-row-main' }, [
          el('div', { class: 'pvs-row-title' }, [
            el('strong', {}, [k.name]),
            el('span', { class: 'pve-badge', title: 'Encrypted at rest and never shown again.' }, ['sealed']),
          ]),
          line,
        ]),
        el('div', { class: 'pvs-row-actions' }, [remove]),
      ]);
    })));
  }
  block.append(editor.panel);
  return block;
}

function addKeyForm(c: { close: () => void; dismissible: boolean }, rerender: Rerender): HTMLFormElement {
  const name = textInput({ placeholder: 'e.g. laptop' });
  const publicKey = el('textarea', { class: 'pve-textarea', rows: 3, spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… you@example.com', id: nid('in') });
  const error = errorSlot();
  const submit = el('button', { type: 'submit' }, ['Add key']);
  const form = el('form', { class: 'pvs-form', novalidate: true, 'aria-label': 'Add an SSH key' }, [
    labelled('Name', name, name.id),
    labelled('Public key', publicKey, publicKey.id),
    error.node,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: c.close }, ['Cancel']), submit]),
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.set(null);
    const bad = validateAddKey({ name: name.value, publicKey: publicKey.value });
    if (bad) { error.set(bad.message); (bad.field === 'name' ? name : publicKey).focus(); return; }
    const label = name.value.trim();
    submit.disabled = true; submit.textContent = 'Adding…';
    try { await pve.addKey({ name: label, publicKey: publicKey.value.trim() }); rerender(`Added key ${label}.`); }
    catch (er) { error.set((er as Error).message); submit.disabled = false; submit.textContent = 'Add key'; }
  });
  return form;
}

function rootPasswordBlock(pw: Loaded<{ set: boolean }>, slot: EditorSlot, rerender: Rerender): HTMLElement {
  if (pw.value === null) return el('div', { class: 'pvs-block' }, [blockHead('Root password'), loadFailure('the root password status', pw.error, rerender)]);
  const isSet = pw.value.set;
  const editor = makeEditor(slot, isSet ? 'Change' : 'Set password', false, (c) => passwordForm(c, rerender));
  const row = el('div', { class: 'pvs-row' }, [
    el('span', { class: isSet ? 'dot green' : 'dot', 'aria-hidden': 'true' }),
    el('div', { class: 'pvs-row-main' }, [
      el('div', { class: 'pvs-row-title' }, [el('strong', {}, [isSet ? 'Set' : 'Not set'])]),
      el('div', { class: 'pvs-row-sub' }, [isSet ? 'Write-only. It is never shown again.' : 'Containers are reachable by key only.']),
    ]),
  ]);
  if (isSet) {
    const clear = el('button', { type: 'button', class: 'danger' }, ['Clear']);
    armable(clear, 'Really clear?', async () => {
      try { await pve.clearRootPassword(); rerender('Root password cleared.'); }
      catch (e) { row.querySelector('.pvs-row-sub')!.textContent = `Could not clear: ${(e as Error).message}`; }
    });
    row.append(el('div', { class: 'pvs-row-actions' }, [clear]));
  }
  return el('div', { class: 'pvs-block' }, [
    blockHead('Root password (optional)', editor.toggle),
    el('p', { class: 'pvs-block-note' }, [`Set as the root password of every container Tmuxifier provisions. At least ${ROOT_PASSWORD_MIN} characters.`]),
    row,
    editor.panel,
  ]);
}

function passwordForm(c: { close: () => void; dismissible: boolean }, rerender: Rerender): HTMLFormElement {
  const p1 = el('input', { type: 'password', autocomplete: 'new-password', id: nid('in') });
  const p2 = el('input', { type: 'password', autocomplete: 'new-password', id: nid('in') });
  const error = errorSlot();
  const submit = el('button', { type: 'submit' }, ['Save password']);
  const form = el('form', { class: 'pvs-form', novalidate: true, 'aria-label': 'Set the root password' }, [
    el('div', { class: 'field-grid' }, [labelled('Password', p1, p1.id), labelled('Confirm', p2, p2.id)]),
    error.node,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: c.close }, ['Cancel']), submit]),
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.set(null);
    const bad = validatePassword(p1.value, p2.value);
    if (bad) { error.set(bad.message); (bad.field === 'password' ? p1 : p2).focus(); return; }
    submit.disabled = true; submit.textContent = 'Saving…';
    try { await pve.setRootPassword(p1.value); rerender('Root password saved.'); }
    catch (er) { error.set((er as Error).message); submit.disabled = false; submit.textContent = 'Save password'; }
  });
  return form;
}
