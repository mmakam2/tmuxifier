import { api, type Box, type Status } from './api';
import { openTerminal } from './terminal';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal> }>();

async function start() {
  if (await api.me()) renderDashboard();
  else renderLogin();
}

function renderLogin() {
  app.innerHTML = `<form id="login" class="login">
      <h1>Helm</h1>
      <input id="pw" type="password" placeholder="Password" autofocus />
      <button>Unlock</button>
      <p id="err" class="err"></p>
    </form>`;
  app.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.login((app.querySelector('#pw') as HTMLInputElement).value); renderDashboard(); }
    catch { (app.querySelector('#err') as HTMLElement).textContent = 'Invalid password'; }
  });
}

async function renderDashboard() {
  app.innerHTML = `<div class="layout">
      <aside class="sidebar">
        <div class="brand">Helm <button id="logout" title="Log out">⎋</button></div>
        <div class="actions"><button id="import">Import ~/.ssh/config</button><button id="add">+ Add box</button></div>
        <ul id="boxes" class="boxes"></ul>
      </aside>
      <main id="stage" class="stage"><div class="empty">Select a box to open a terminal.</div></main>
    </div>`;
  app.querySelector('#logout')!.addEventListener('click', async () => { await api.logout(); renderLogin(); });
  app.querySelector('#import')!.addEventListener('click', async () => { await api.importSsh(); await refresh(); });
  app.querySelector('#add')!.addEventListener('click', async () => {
    const host = prompt('SSH host or alias:'); if (!host) return;
    await api.addBox({ host }); await refresh();
  });
  await refresh();
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
  for (const b of boxes) {
    const st = status[b.id];
    const dot = !st ? 'gray' : st.reachable ? (st.tmux === false ? 'amber' : 'green') : 'red';
    const li = document.createElement('li');
    li.className = 'box';
    li.innerHTML = `<span class="dot ${dot}"></span><span class="name">${b.label}</span>
      <button class="rm" title="Remove">✕</button>`;
    li.querySelector('.name')!.addEventListener('click', () => openBox(b));
    li.querySelector('.rm')!.addEventListener('click', async (e) => { e.stopPropagation(); await api.removeBox(b.id); closeTab(b.id); await refresh(); });
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

start();
