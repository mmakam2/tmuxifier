import { api, type AddBoxSpec, type Box, type Status } from './api';
import { openTerminal } from './terminal';
import logoUrl from './assets/tmuxifier-logo.png';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal> }>();

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
    const list = app.querySelectorAll('.box');
    const DOTS = new Set(['gray', 'green', 'amber', 'red']);
    list.forEach(li => {
      const id = (li as HTMLElement).dataset.id;
      if (!id) return;
      const st = status[id];
      const dotClass = !st ? 'gray' : st.reachable ? (st.tmux === false ? 'amber' : 'green') : 'red';
      const dot = DOTS.has(dotClass) ? dotClass : 'gray';
      const dotEl = li.querySelector('.dot');
      if (dotEl) dotEl.className = `dot ${dot}`;
    });
  } catch {} finally {
    polling = false;
  }
}

async function renderDashboard() {
  if (pollInterval) clearInterval(pollInterval);
  app.innerHTML = `<div class="layout">
      <aside class="sidebar">
        <div class="brand"><span><img src="${logoUrl}" alt="" />tmuxifier</span><button id="logout" title="Log out">⎋</button></div>
        <div class="actions"><button id="import">Import ~/.ssh/config</button><button id="add">+ Add box</button></div>
        <ul id="boxes" class="boxes"></ul>
      </aside>
      <main id="stage" class="stage"><div class="empty">Select a box to open a terminal.</div></main>
    </div>`;
  app.querySelector('#logout')!.addEventListener('click', async () => { 
    if (pollInterval) clearInterval(pollInterval);
    await api.logout(); await renderLogin();
  });
  app.querySelector('#import')!.addEventListener('click', async () => { await api.importSsh(); await refresh(); });
  app.querySelector('#add')!.addEventListener('click', () => openAddDialog());
  await refresh();
  pollInterval = setInterval(pollStatus, POLL_MS);
}

async function refresh() {
  const list = app.querySelector('#boxes'); if (!list) return;
  const boxes = await api.boxes();
  let status: Record<string, Status> = {};
  api.status().then((s) => { status = s; paint(boxes, status); }).catch(() => {});
  paint(boxes, status);
}

function paint(boxes: Box[], status: Record<string, Status>) {
  const list = app.querySelector('#boxes')!;
  list.innerHTML = '';
  const DOTS = new Set(['gray', 'green', 'amber', 'red']);
  for (const b of boxes) {
    const st = status[b.id];
    const dotClass = !st ? 'gray' : st.reachable ? (st.tmux === false ? 'amber' : 'green') : 'red';
    const dot = DOTS.has(dotClass) ? dotClass : 'gray';

    const li = document.createElement('li');
    li.className = 'box';
    li.dataset.id = b.id;

    const dotEl = document.createElement('span');
    dotEl.className = `dot ${dot}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = b.label;
    nameEl.addEventListener('click', () => openBox(b));

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

    li.append(dotEl, nameEl, rm);
    list.appendChild(li);
  }
}

function openBox(b: Box) {
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
}

function openAddDialog() {
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

  const installOhMyZsh = document.createElement('label');
  installOhMyZsh.className = 'check-field';
  const installOhMyZshInput = document.createElement('input');
  installOhMyZshInput.type = 'checkbox';
  installOhMyZshInput.checked = true;
  const installOhMyZshText = document.createElement('span');
  installOhMyZshText.textContent = 'Install Oh My Zsh if missing';
  installOhMyZsh.append(installOhMyZshInput, installOhMyZshText);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal';
  const title = document.createElement('h2');
  title.textContent = 'Add box';

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Add';
  actions.append(cancel, submit);

  form.append(
    title,
    field('host', 'Host or alias', { placeholder: 'e.g. 192.168.3.245' }),
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    installOhMyTmux,
    installOhMyZsh,
    err,
    actions,
  );
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
    const host = fields.host.value.trim();
    if (!host) { err.textContent = 'Host is required'; return; }
    const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh: installOhMyZshInput.checked };
    const label = fields.label.value.trim(); if (label) spec.label = label;
    const user = fields.user.value.trim(); if (user) spec.user = user;
    const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
    const portRaw = fields.port.value.trim();
    if (portRaw) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; return; }
      spec.port = port;
    }
    submit.disabled = true;
    try {
      await api.addBox(spec);
      close();
      await refresh();
    } catch (e: any) {
      err.textContent = e?.message || 'Could not add box';
      submit.disabled = false;
    }
  });
}

start();
