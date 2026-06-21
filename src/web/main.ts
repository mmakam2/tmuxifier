import { api, type AddBoxSpec, type Box, type Status } from './api';
import { openTerminal, openProvisionTerminal } from './terminal';
import { dotClassFor, dotTitleFor } from './statusDot';
import logoUrl from './assets/tmuxifier-logo.png';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal> }>();
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';
let activeBoxId: string | null = null;
let allBoxes: Box[] = [];
let latestStatus: Record<string, Status> = {};

function getSearchTerm(): string {
  const input = app.querySelector('#search') as HTMLInputElement;
  return input ? input.value.trim().toLowerCase() : '';
}

function filterAndPaint() {
  const term = getSearchTerm();
  const filtered = term
    ? allBoxes.filter(b => b.label.toLowerCase().includes(term) || b.host.toLowerCase().includes(term))
    : allBoxes;
  paint(filtered, latestStatus);
}

function refitActiveTerminals() {
  for (const t of tabs.values()) t.term.refit();
}

async function start() {
  if (await api.me()) renderDashboard();
  else await renderLogin();
}

function readLoginError(): string {
  const code = new URLSearchParams(location.search).get('error');
  if (!code) return '';
  history.replaceState(null, '', location.pathname);
  return code === 'forbidden' ? 'This Google account is not allowed.'
    : code === 'google' ? 'Google sign-in failed. Please try again.'
    : code === 'state' ? 'Login session expired. Please try again.'
    : 'Sign-in failed. Please try again.';
}

async function renderLogin() {
  let mode: 'password' | 'google' = 'password';
  try { mode = (await api.authInfo()).mode; } catch {}
  const err = readLoginError();
  if (mode === 'google') {
    app.innerHTML = `<div class="login">
        <div class="login-brand">
          <img class="login-logo" src="${logoUrl}" alt="" />
          <h1>tmuxifier</h1>
          <p>persistent remote terminals for your boxes</p>
        </div>
        <a id="gsignin" class="gbtn" href="/api/auth/google/login">
          <svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
            <path fill="#34a853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.8.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#fbbc05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"/>
            <path fill="#ea4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          <span>Sign in with Google</span>
        </a>
        <p id="err" class="err">${err}</p>
        <footer class="login-footer">Babendums Engineering &amp; Fabrication, Llc.</footer>
      </div>`;
    return;
  }
  app.innerHTML = `<form id="login" class="login">
      <div class="login-brand">
        <img class="login-logo" src="${logoUrl}" alt="" />
        <h1>tmuxifier</h1>
        <p>persistent remote terminals for your boxes</p>
      </div>
      <input id="pw" type="password" placeholder="Password" autofocus />
      <button>Unlock</button>
      <p id="err" class="err">${err}</p>
      <footer class="login-footer">Babendums Engineering &amp; Fabrication, Llc.</footer>
    </form>`;
  app.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.login((app.querySelector('#pw') as HTMLInputElement).value); renderDashboard(); }
    catch { (app.querySelector('#err') as HTMLElement).textContent = 'Invalid password'; }
  });
}

// Probes are multiplexed over each box's persistent SSH master, so polling is
// cheap — but there's no need to hammer. A relaxed interval keeps the dots
// fresh without churning connections.
const POLL_MS = 30000;
let pollInterval: any;
let polling = false;

async function pollStatus() {
  if (polling) return;
  polling = true;
  try {
    const status = await api.status();
    latestStatus = status;
    const list = app.querySelectorAll('.box');
    list.forEach(li => {
      const id = (li as HTMLElement).dataset.id;
      if (!id) return;
      const st = status[id];
      const dotEl = li.querySelector('.dot') as HTMLElement | null;
      if (dotEl) { dotEl.className = `dot ${dotClassFor(st)}`; dotEl.title = dotTitleFor(st); }
    });
  } catch {} finally {
    polling = false;
  }
}

async function renderDashboard() {
  if (pollInterval) clearInterval(pollInterval);
  const sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  app.innerHTML = `<div class="layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}">
      <aside class="sidebar">
        <div class="brand">
          <span><img src="${logoUrl}" alt="" /><span class="brand-name">tmuxifier</span></span>
          <div class="brand-actions">
            <button id="sidebar-toggle" class="sidebar-toggle" type="button" title="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-expanded="${sidebarCollapsed ? 'false' : 'true'}">${sidebarCollapsed ? '›' : '‹'}</button>
            <button id="logout" title="Log out">⎋</button>
          </div>
        </div>
        <div class="actions"><button id="import">Import ~/.ssh/config</button><button id="add">+ Add box</button></div>
        <input id="search" class="search" type="text" placeholder="Search…" autocomplete="off" />
        <ul id="boxes" class="boxes"></ul>
        <div class="local-shell">
          <span class="local-dot"></span>
          <span class="local-name">Host Shell</span>
          <button class="local-refresh" title="Reconnect">↻</button>
          <button class="local-edit" title="Configure shell">✎</button>
        </div>
      </aside>
      <main id="stage" class="stage"><div class="empty">Select a box to open a terminal.</div></main>
    </div>`;
  app.querySelector('#logout')!.addEventListener('click', async () => { 
    if (pollInterval) clearInterval(pollInterval);
    await api.logout(); await renderLogin();
  });
  app.querySelector('#sidebar-toggle')!.addEventListener('click', () => {
    const layout = app.querySelector('.layout') as HTMLElement;
    const button = app.querySelector('#sidebar-toggle') as HTMLButtonElement;
    const collapsed = !layout.classList.contains('sidebar-collapsed');
    layout.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    button.textContent = collapsed ? '›' : '‹';
    button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    window.setTimeout(refitActiveTerminals, 260);
  });
  app.querySelector('#import')!.addEventListener('click', async () => { await api.importSsh(); await refresh(); });
  app.querySelector('#add')!.addEventListener('click', () => openBoxDialog());
  app.querySelector('#search')!.addEventListener('input', () => filterAndPaint());

  // Local shell — name click opens terminal
  app.querySelector('.local-name')!.addEventListener('click', () => openLocalShell());

  // Local shell — refresh
  app.querySelector('.local-refresh')!.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.reconnectLocalShell();
    const wasActive = activeBoxId === '__local__';
    closeTab('__local__');
    if (wasActive) openLocalShell();
  });

  // Local shell — edit
  app.querySelector('.local-edit')!.addEventListener('click', (e) => {
    e.stopPropagation();
    openLocalShellEditModal();
  });

  await refresh();
  pollInterval = setInterval(pollStatus, POLL_MS);
}

async function refresh() {
  const list = app.querySelector('#boxes'); if (!list) return;
  allBoxes = await api.boxes();
  latestStatus = {};
  api.status().then((s) => { latestStatus = s; filterAndPaint(); }).catch(() => {});
  filterAndPaint();
}

function paint(boxes: Box[], status: Record<string, Status>) {
  const list = app.querySelector('#boxes')!;
  list.innerHTML = '';
  for (const b of boxes) {
    const st = status[b.id];

    const li = document.createElement('li');
    li.className = b.id === activeBoxId ? 'box active' : 'box';
    li.dataset.id = b.id;

    const dotEl = document.createElement('span');
    dotEl.className = `dot ${dotClassFor(st)}`;
    dotEl.title = dotTitleFor(st);

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = b.label;
    nameEl.addEventListener('click', () => openBox(b));

    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'refresh';
    reconnectBtn.title = 'Reconnect';
    reconnectBtn.textContent = '↻';
    reconnectBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.reconnectBox(b.id);
      const wasActive = activeBoxId === b.id;
      closeTab(b.id);
      if (wasActive) openBox(b);
    });

    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openBoxDialog(b);
    });

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.removeBox(b.id);
      closeTab(b.id);
      await refresh();
    });

    li.append(dotEl, nameEl, reconnectBtn, edit, rm);
    list.appendChild(li);
  }
}

function openLocalShell() {
  activeBoxId = '__local__';
  // De-highlight all box items
  app.querySelectorAll('.box').forEach(el => el.classList.remove('active'));
  // Highlight local shell bar
  const ls = app.querySelector('.local-shell');
  if (ls) ls.classList.add('active');
  const stage = app.querySelector('#stage') as HTMLElement;
  for (const t of tabs.values()) t.el.style.display = 'none';
  const existing = tabs.get('__local__');
  if (existing) { existing.el.style.display = 'block'; existing.term.refit(); existing.term.focus(); updateLocalDot(); return; }
  stage.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'term';
  stage.appendChild(el);
  const term = openTerminal(el, '__local__');
  tabs.set('__local__', { el, term });
  term.focus();
  // Update dot after tab creation so it turns green on first open
  updateLocalDot();
}

function updateLocalDot() {
  const dot = app.querySelector('.local-dot');
  if (dot) dot.classList.toggle('green', tabs.has('__local__'));
}

function openBox(b: Box) {
  activeBoxId = b.id;
  app.querySelectorAll('.box').forEach(el => {
    const boxEl = el as HTMLElement;
    boxEl.classList.toggle('active', boxEl.dataset.id === b.id);
  });
  // De-highlight local shell bar when switching to a box
  const ls = app.querySelector('.local-shell');
  if (ls) ls.classList.remove('active');
  const stage = app.querySelector('#stage') as HTMLElement;
  for (const t of tabs.values()) t.el.style.display = 'none';
  const existing = tabs.get(b.id);
  if (existing) { existing.el.style.display = 'block'; existing.term.refit(); existing.term.focus(); return; }
  stage.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'term';
  stage.appendChild(el);
  const term = openTerminal(el, b.id);
  tabs.set(b.id, { el, term });
  term.focus();
}

function closeTab(id: string) {
  const t = tabs.get(id);
  if (t) { t.term.dispose(); t.el.remove(); tabs.delete(id); }
  if (activeBoxId === id) {
    activeBoxId = null;
    const activeEl = app.querySelector('.box.active');
    if (activeEl) activeEl.classList.remove('active');
    const ls = app.querySelector('.local-shell');
    if (ls) ls.classList.remove('active');
  }
  if (id === '__local__') updateLocalDot();
}

async function openLocalShellEditModal() {
  let currentShell = 'none';
  try { currentShell = (await api.getLocalShell()).shell; } catch {}

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'Local shell';

  // Radio group for shell framework
  const shellGroup = document.createElement('fieldset');
  shellGroup.className = 'radio-group';
  const shellLegend = document.createElement('legend');
  shellLegend.textContent = 'Shell framework';
  shellGroup.append(shellLegend);

  function makeRadio(value: string, label: string) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'localShellFramework';
    input.value = value;
    input.checked = currentShell === value
      || (value === 'none' && !['none', 'omz', 'omb'].includes(currentShell));
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return { wrap, input };
  }

  const shellNone = makeRadio('none', 'None');
  const shellZsh = makeRadio('omz', 'Oh My Zsh');
  const shellBash = makeRadio('omb', 'Oh My Bash');
  shellGroup.append(shellNone.wrap, shellZsh.wrap, shellBash.wrap);

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  actions.append(cancel, submit);

  form.append(title, shellGroup, err, actions);
  backdrop.appendChild(form);
  app.appendChild(backdrop);

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const selected = (form.querySelector('input[name="localShellFramework"]:checked') as HTMLInputElement)?.value;
    if (!selected) { submit.disabled = false; return; }
    try {
      await api.updateLocalShell(selected);
      close();
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not save shell setting';
      submit.disabled = false;
    }
  });
}

function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean }) {
  const panel = document.getElementById('provision-panel')!;
  const title = panel.querySelector('.provision-title')!;
  const status = panel.querySelector('.provision-status')!;
  const container = panel.querySelector('.provision-term') as HTMLElement;
  const closeBtn = panel.querySelector('.provision-close') as HTMLElement;

  // Reset state
  title.textContent = `Provisioning ${box.label}`;
  status.textContent = '';
  status.className = 'provision-status';
  closeBtn.style.display = 'none';
  container.innerHTML = '';

  panel.classList.add('open');

  const term = openProvisionTerminal(container, box.id, options, (code) => {
    if (code === 0) {
      status.textContent = '✓ Complete';
      status.className = 'provision-status success';
      refresh();
      setTimeout(() => {
        panel.classList.remove('open');
        term.dispose();
      }, 2000);
    } else {
      status.textContent = `✗ Failed (exit ${code})`;
      status.className = 'provision-status error';
      closeBtn.style.display = '';
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    term.dispose();
  }, { once: true });
}

function openBoxDialog(box?: Box) {
  const isEdit = !!box;
  const fields: Record<string, HTMLInputElement> = {};
  function field(name: string, label: string, opts: { placeholder?: string; value?: string; type?: string } = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = opts.type || 'text';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    wrap.append(span, input);
    fields[name] = input;
    return wrap;
  }

  const installOhMyTmux = document.createElement('label');
  installOhMyTmux.className = 'check-field';
  const installOhMyTmuxInput = document.createElement('input');
  installOhMyTmuxInput.type = 'checkbox';
  installOhMyTmuxInput.checked = true;
  const installOhMyTmuxText = document.createElement('span');
  installOhMyTmuxText.textContent = 'Install Oh My Tmux if missing';
  installOhMyTmux.append(installOhMyTmuxInput, installOhMyTmuxText);

  // Shell framework radio group
  const shellGroup = document.createElement('fieldset');
  shellGroup.className = 'radio-group';
  const shellLegend = document.createElement('legend');
  shellLegend.textContent = 'Shell framework';
  shellGroup.append(shellLegend);

  function makeRadio(name: string, value: string, label: string, defaultChecked: boolean) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = defaultChecked;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return { wrap, input };
  }

  const shellNone = makeRadio('shellFramework', 'none', 'None', true);
  const shellZsh = makeRadio('shellFramework', 'omz', 'Install Oh My Zsh if missing', false);
  const shellBash = makeRadio('shellFramework', 'omb', 'Install Oh My Bash if missing', false);

  shellGroup.append(shellNone.wrap, shellZsh.wrap, shellBash.wrap);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal';
  const title = document.createElement('h2');
  title.textContent = isEdit ? 'Edit box' : 'Add box';

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = isEdit ? 'Save' : 'Add';
  actions.append(cancel, submit);

  const hostWrap = field('host', 'Host or alias', { placeholder: 'e.g. 192.168.3.245' });
  if (isEdit) {
    const hInput = hostWrap.querySelector('input')!;
    hInput.value = box!.host;
    hInput.disabled = true;
    hInput.style.opacity = '0.6';
  }

  form.append(
    title,
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    installOhMyTmux,
    shellGroup,
    err,
    actions,
  );

  // Pre-populate fields in edit mode
  if (isEdit) {
    fields.label.value = box!.label !== box!.host ? box!.label : '';
    if (box!.user) fields.user.value = box!.user;
    if (box!.port) fields.port.value = String(box!.port);
    if (box!.proxyJump) fields.proxyJump.value = box!.proxyJump;
  }

  // Default checkboxes/radios to unchecked/None in edit mode
  if (isEdit) {
    installOhMyTmuxInput.checked = false;
    shellNone.input.checked = true;
  }

  backdrop.appendChild(form);
  app.appendChild(backdrop);
  fields.host.focus();

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      if (isEdit) {
        const patch: any = {};
        const label = fields.label.value.trim(); if (label) patch.label = label;
        const user = fields.user.value.trim(); patch.user = user || null;
        const jump = fields.proxyJump.value.trim(); patch.proxyJump = jump || null;
        const portRaw = fields.port.value.trim();
        if (portRaw) {
          const port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
          patch.port = port;
        } else {
          patch.port = null;
        }
        const updatedBox = await api.updateBox(box!.id, patch);
        close();
        await refresh();
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        if (installOhMyTmuxInput.checked || installOhMyZsh || installOhMyBash) {
          openProvisionPanel(updatedBox, {
            ohMyTmux: installOhMyTmuxInput.checked,
            ohMyZsh: installOhMyZsh,
            ohMyBash: installOhMyBash,
          });
        }
      } else {
        const host = fields.host.value.trim();
        if (!host) { err.textContent = 'Host is required'; submit.disabled = false; return; }
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh, installOhMyBash };
        const label = fields.label.value.trim(); if (label) spec.label = label;
        const user = fields.user.value.trim(); if (user) spec.user = user;
        const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
        const portRaw = fields.port.value.trim();
        if (portRaw) {
          const port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
          spec.port = port;
        }
        const newBox = await api.addBox(spec);
        close();
        openProvisionPanel(newBox, {
          ohMyTmux: installOhMyTmuxInput.checked,
          ohMyZsh: installOhMyZsh,
          ohMyBash: installOhMyBash,
        });
      }
    } catch (e: any) {
      err.textContent = e?.message || `Could not ${isEdit ? 'save' : 'add'} box`;
      submit.disabled = false;
    }
  });
}

start();
