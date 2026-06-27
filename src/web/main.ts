import { api, type AddBoxSpec, type Box, type Status } from './api';
import { openTerminal, openProvisionTerminal, setTerminalFont } from './terminal';
import { dotClassFor, dotTitleFor, metaSegmentsFor, latestActivity, hasUnseenActivity } from './statusDot';
import { toggleBox, setBoxes, groupState } from './fleetSelection';
import { addRecent, parseRecent } from './fleetHistory';
import logoUrl from './assets/tmuxifier-logo.png';
import { openProxmoxHub } from './proxmoxUi';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal> }>();
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';
const GROUP_COLLAPSED_KEY = 'tmuxifier.collapsedTagGroups';
const UNTAGGED_LABEL = 'Untagged';
const UNTAGGED_KEY = '__untagged__';
let activeBoxId: string | null = null;
let allBoxes: Box[] = [];
let latestStatus: Record<string, Status> = {};
let fleetMode = false;
let fleetSelected = new Set<string>();
let fleetScriptDraft = ''; // in-progress bash-script editor content; survives reopen, cleared on run/exit

// Per-box last-seen tmux activity, so a background session doing new work since
// you last opened the box shows an activity badge. Seeded silently on first sight
// (no badge storm on load); cleared when you open the box. Persisted so it
// survives reloads.
const LAST_SEEN_ACTIVITY_KEY = 'tmuxifier.lastSeenActivity';
function readLastSeenActivity(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LAST_SEEN_ACTIVITY_KEY) || '{}') || {}; } catch { return {}; }
}
let lastSeenActivity: Record<string, number> = readLastSeenActivity();
function persistLastSeenActivity() {
  try { localStorage.setItem(LAST_SEEN_ACTIVITY_KEY, JSON.stringify(lastSeenActivity)); } catch {}
}

// Paint a box row's status affordances (dot, health meta line, activity badge)
// from a status snapshot. Shared by initial render and the poll so they never
// drift. Also maintains the activity baseline: the box you're viewing never
// badges itself, and a box seen for the first time is seeded without a badge.
function applyRowStatus(li: HTMLElement, id: string, st: Status | undefined) {
  const dotEl = li.querySelector('.dot') as HTMLElement | null;
  if (dotEl) { dotEl.className = `dot ${dotClassFor(st)}`; dotEl.title = dotTitleFor(st); }
  const metaEl = li.querySelector('.box-meta') as HTMLElement | null;
  if (metaEl) {
    const nodes: Node[] = [];
    metaSegmentsFor(st).forEach((s, i) => {
      if (i) nodes.push(document.createTextNode(' · '));
      const span = document.createElement('span');
      if (s.level) span.className = `lvl-${s.level}`;
      if (s.title) span.title = s.title;
      span.append(s.text);
      if (s.icon) {
        span.append(' ');
        const ic = document.createElement('span');
        ic.textContent = s.icon;
        if (s.iconClass) ic.className = s.iconClass;
        span.append(ic);
      }
      nodes.push(span);
    });
    metaEl.replaceChildren(...nodes);
  }
  const badgeEl = li.querySelector('.box-activity') as HTMLElement | null;
  if (badgeEl) {
    const act = latestActivity(st);
    let show = false;
    if (id === activeBoxId) {
      if (act) lastSeenActivity[id] = act;      // viewing it: keep baseline current, never badge
    } else if (!(id in lastSeenActivity)) {
      lastSeenActivity[id] = act;               // first sighting: seed silently
    } else {
      show = hasUnseenActivity(st, lastSeenActivity[id]);
    }
    badgeEl.classList.toggle('hidden', !show);
  }
}

// Transient bottom-center notice; auto-dismisses. Used for import results/errors.
function showToast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.classList.add('show'), 10);
  window.setTimeout(() => { el.classList.remove('show'); window.setTimeout(() => el.remove(), 300); }, 3500);
}

const FLEET_RECENT_KEY = 'tmuxifier.fleetRecent';
function readFleetRecent(): string[] { return parseRecent(localStorage.getItem(FLEET_RECENT_KEY)); }
function pushFleetRecent(cmd: string) {
  localStorage.setItem(FLEET_RECENT_KEY, JSON.stringify(addRecent(readFleetRecent(), cmd)));
}

interface BoxGroup {
  key: string;
  label: string;
  boxes: Box[];
  untagged: boolean;
}

function normalizeTagInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function primaryTag(box: Box): string {
  return normalizeTagInput(box.tags?.[0]);
}

function keyForTag(tag: string): string {
  const normalized = normalizeTagInput(tag);
  return normalized ? normalized.toLowerCase() : UNTAGGED_KEY;
}

function labelForTag(tag: string): string {
  return normalizeTagInput(tag) || UNTAGGED_LABEL;
}

function boxMatchesSearch(box: Box, term: string): boolean {
  if (!term) return true;
  const tag = primaryTag(box).toLowerCase();
  return box.label.toLowerCase().includes(term)
    || box.host.toLowerCase().includes(term)
    || tag.includes(term);
}

function groupBoxes(boxes: Box[]): BoxGroup[] {
  const groups = new Map<string, BoxGroup>();
  for (const box of boxes) {
    const tag = primaryTag(box);
    const key = keyForTag(tag);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelForTag(tag), boxes: [], untagged: key === UNTAGGED_KEY };
      groups.set(key, group);
    }
    group.boxes.push(box);
  }
  for (const group of groups.values()) {
    group.boxes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.untagged && !b.untagged) return 1;
    if (!a.untagged && b.untagged) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

function existingTagMap(): Map<string, string> {
  const tags = new Map<string, string>();
  for (const box of allBoxes) {
    const tag = primaryTag(box);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }
  return tags;
}

function existingTagOptions(): string[] {
  return [...existingTagMap().values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function canonicalTagForInput(value: string): string {
  const normalized = normalizeTagInput(value);
  if (!normalized) return '';
  return existingTagMap().get(normalized.toLowerCase()) || normalized;
}

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(keys: Set<string>) {
  localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify([...keys].sort()));
}

function isGroupCollapsed(key: string): boolean {
  return readCollapsedGroups().has(key);
}

function setGroupCollapsed(key: string, collapsed: boolean) {
  const keys = readCollapsedGroups();
  if (collapsed) keys.add(key);
  else keys.delete(key);
  writeCollapsedGroups(keys);
}

function getSearchTerm(): string {
  const input = app.querySelector('#search') as HTMLInputElement;
  return input ? input.value.trim().toLowerCase() : '';
}

function filterAndPaint() {
  const term = getSearchTerm();
  const filtered = allBoxes.filter(b => boxMatchesSearch(b, term));
  paint(filtered, latestStatus, term);
}

function refitActiveTerminals() {
  for (const t of tabs.values()) t.term.refit();
}

async function start() {
  if (await api.me()) {
    // Apply the configured terminal font before any box opens. Best-effort: on
    // failure the bundled font stack stays in effect.
    try { setTerminalFont(await api.uiConfig()); } catch {}
    renderDashboard();
  } else await renderLogin();
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
      applyRowStatus(li as HTMLElement, id, status[id]);
    });
    persistLastSeenActivity();
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
            <button id="export" type="button" title="Export boxes to a file" aria-label="Export boxes to a file">⤓</button>
            <button id="import" type="button" title="Import boxes from a file" aria-label="Import boxes from a file">⤒</button>
            <button id="logout" title="Log out">⎋</button>
          </div>
          <input id="import-file" type="file" accept="application/json,.json" hidden />
        </div>
        <div class="actions"><button id="add">+ Add box</button></div>
        <div class="fleet-actions"><button id="fleet-toggle" type="button" class="fleet-toggle">Fleet Command</button><button id="fleet-jobs" type="button" class="fleet-jobs-btn" title="Fleet job history">Fleet Jobs</button><button id="proxmox" type="button" class="proxmox-btn" title="Provision Proxmox LXC containers">Proxmox</button></div>
        <div id="fleet-bar" class="fleet-bar" hidden></div>
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
    stopFleetPoll();
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
  app.querySelector('#export')!.addEventListener('click', () => {
    // Same-origin GET navigation; the session cookie rides along and the server
    // sets Content-Disposition, so the browser saves the file with its name.
    const a = document.createElement('a');
    a.href = '/api/export';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  const importFile = app.querySelector('#import-file') as HTMLInputElement;
  app.querySelector('#import')!.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = ''; // reset so re-selecting the same file fires change again
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const { added, skipped } = await api.importBoxes(payload);
      await refresh();
      const msg = `Imported ${added.length} box${added.length === 1 ? '' : 'es'}${skipped ? `, ${skipped} skipped` : ''}`;
      showToast(msg);
    } catch (e) {
      showToast(`Import failed: ${(e as Error).message}`, 'error');
    }
  });
  app.querySelector('#add')!.addEventListener('click', () => openBoxDialog());
  app.querySelector('#search')!.addEventListener('input', () => filterAndPaint());
  app.querySelector('#fleet-toggle')!.addEventListener('click', () => {
    fleetMode = !fleetMode;
    if (!fleetMode) { fleetSelected = new Set(); fleetScriptDraft = ''; }
    const layout = app.querySelector('.layout');
    if (layout) layout.classList.toggle('fleet-mode', fleetMode);
    (app.querySelector('#fleet-toggle') as HTMLElement).classList.toggle('active', fleetMode);
    const bar = app.querySelector('#fleet-bar') as HTMLElement;
    if (bar) bar.hidden = !fleetMode;
    renderFleetBar();
    filterAndPaint();
  });
  app.querySelector('#fleet-jobs')!.addEventListener('click', () => {
    const panel = document.getElementById('fleet-panel')!;
    if (panel.classList.contains('open')) closeFleetJobsPanel();
    else openFleetJobsPanel();
  });
  app.querySelector('#proxmox')!.addEventListener('click', () => openProxmoxHub({
    openBox: (b) => openBox(b),
    onBoxLinked: () => { void refresh(); },
  }));

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
  api.status().then((s) => { latestStatus = s; filterAndPaint(); persistLastSeenActivity(); }).catch(() => {});
  filterAndPaint();
}

function createBoxRow(b: Box, status: Record<string, Status>): HTMLElement {
  const st = status[b.id];

  const li = document.createElement('li');
  li.className = b.id === activeBoxId ? 'box active' : 'box';
  li.dataset.id = b.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'box-check';
  check.dataset.id = b.id;
  check.checked = fleetSelected.has(b.id);
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    fleetSelected = toggleBox(fleetSelected, b.id);
    syncFleetUI();
  });

  const dotEl = document.createElement('span');
  dotEl.className = 'dot';

  const mainEl = document.createElement('span');
  mainEl.className = 'box-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = b.label;
  const metaEl = document.createElement('span');
  metaEl.className = 'box-meta';
  mainEl.append(nameEl, metaEl);

  // Unseen-activity badge (a background session did something since you opened it).
  const activityEl = document.createElement('span');
  activityEl.className = 'box-activity hidden';
  activityEl.title = 'Background session has new activity';

  li.addEventListener('click', () => openBox(b));

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'refresh';
  refreshBtn.title = 'Reconnect';
  refreshBtn.textContent = '↻';
  refreshBtn.addEventListener('click', async (e) => {
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

  const actions = document.createElement('span');
  actions.className = 'box-actions';
  actions.append(refreshBtn, edit, rm);

  li.append(check, dotEl, mainEl, activityEl, actions);
  applyRowStatus(li, b.id, st);
  return li;
}

function paint(boxes: Box[], status: Record<string, Status>, searchTerm = getSearchTerm()) {
  const list = app.querySelector('#boxes')!;
  list.innerHTML = '';
  const searching = !!searchTerm;

  // Fleet mode: a tri-state master checkbox that selects/clears every box
  // currently shown (respects the active search filter, like the group checks).
  if (fleetMode && boxes.length) {
    const allShownIds = boxes.map((b) => b.id);
    const row = document.createElement('li');
    row.className = 'fleet-select-all';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'select-all-check';
    // Binary: only "on" when every shown box is selected (no partial/indeterminate
    // highlight — partial state is conveyed by the per-group/per-box checkboxes).
    check.checked = groupState(fleetSelected, allShownIds) === 'all';
    check.addEventListener('change', () => {
      fleetSelected = setBoxes(fleetSelected, allShownIds, check.checked);
      syncFleetUI();
    });
    const label = document.createElement('span');
    label.className = 'select-all-label';
    label.textContent = `Select all (${allShownIds.length})`;
    // Clicking anywhere on the row (not just the box) toggles the checkbox.
    row.addEventListener('click', (e) => {
      if (e.target === check) return;
      check.checked = !check.checked;
      check.dispatchEvent(new Event('change'));
    });
    row.append(check, label);
    list.appendChild(row);
  }

  for (const group of groupBoxes(boxes)) {
    const collapsed = !searching && isGroupCollapsed(group.key);
    const containsActive = !!activeBoxId && group.boxes.some(b => b.id === activeBoxId);

    const groupItem = document.createElement('li');
    groupItem.className = `box-group${collapsed ? ' collapsed' : ''}${containsActive ? ' active-child' : ''}`;
    groupItem.dataset.tagKey = group.key;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'group-header';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    header.title = searching ? 'Clear search to collapse groups' : `${collapsed ? 'Expand' : 'Collapse'} ${group.label}`;

    const chevron = document.createElement('span');
    chevron.className = 'group-chevron';
    chevron.textContent = collapsed ? '›' : '⌄';

    const groupCheck = document.createElement('input');
    groupCheck.type = 'checkbox';
    groupCheck.className = 'group-check';
    const groupIds = group.boxes.map((b) => b.id);
    const gState = groupState(fleetSelected, groupIds);
    groupCheck.checked = gState === 'all';
    groupCheck.indeterminate = gState === 'some';
    groupCheck.addEventListener('click', (e) => e.stopPropagation());
    groupCheck.addEventListener('change', () => {
      fleetSelected = setBoxes(fleetSelected, groupIds, groupCheck.checked);
      syncFleetUI();
    });

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.label;

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(group.boxes.length);

    header.append(groupCheck, chevron, name, count);
    header.addEventListener('click', () => {
      if (searching) return;
      setGroupCollapsed(group.key, !collapsed);
      filterAndPaint();
    });

    const body = document.createElement('ul');
    body.className = 'group-body';
    body.hidden = collapsed;
    for (const box of group.boxes) body.appendChild(createBoxRow(box, status));

    groupItem.append(header, body);
    list.appendChild(groupItem);
  }
  if (fleetMode) syncFleetUI();
}

function openLocalShell() {
  activeBoxId = '__local__';
  // De-highlight all box items
  app.querySelectorAll('.box').forEach(el => el.classList.remove('active'));
  app.querySelectorAll('.box-group').forEach(el => el.classList.remove('active-child'));
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
  const term = openTerminal(el, '__local__', 'local shell');
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
  // Opening a box marks its current activity as seen and clears its badge.
  const act = latestActivity(latestStatus[b.id]);
  if (act) lastSeenActivity[b.id] = act;
  persistLastSeenActivity();
  app.querySelectorAll('.box').forEach(el => {
    const boxEl = el as HTMLElement;
    boxEl.classList.toggle('active', boxEl.dataset.id === b.id);
  });
  app.querySelector(`.box[data-id="${CSS.escape(b.id)}"] .box-activity`)?.classList.add('hidden');
  app.querySelectorAll('.box-group').forEach(el => {
    const groupEl = el as HTMLElement;
    groupEl.classList.toggle('active-child', !!groupEl.querySelector(`.box[data-id="${CSS.escape(b.id)}"]`));
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
  const term = openTerminal(el, b.id, b.label);
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
  // Only close on a genuine backdrop click. A text selection that starts inside
  // an input and ends on the backdrop produces a click whose target is the
  // backdrop (the common ancestor), which would otherwise close the modal — so
  // require the press to have started on the backdrop too.
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

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
  function field(name: string, label: string, opts: { placeholder?: string; value?: string; type?: string; list?: string } = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = opts.type || 'text';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.list) input.setAttribute('list', opts.list);
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

  // tmux session: a type-or-pick field. The datalist pre-fills from the status
  // snapshot we already cache (0 new SSH); the ⟳ button does a user-triggered
  // live probe. Empty submits as 'web' (the store default).
  const sessionWrap = document.createElement('label');
  sessionWrap.className = 'field';
  const sessionSpan = document.createElement('span');
  sessionSpan.textContent = 'tmux session';
  const sessionRow = document.createElement('div');
  sessionRow.className = 'session-row';
  const sessionInput = document.createElement('input');
  sessionInput.type = 'text';
  sessionInput.placeholder = 'web';
  if (isEdit && box!.sessionName) sessionInput.value = box!.sessionName;
  const sessionRefresh = document.createElement('button');
  sessionRefresh.type = 'button';
  sessionRefresh.className = 'session-refresh';
  sessionRefresh.title = 'Fetch live tmux sessions from the host';
  sessionRefresh.textContent = '⟳';
  // Known sessions show as clickable chips that fill the field on click; the
  // field itself stays free-text so you can also type a brand-new session name.
  const sessionPicker = document.createElement('div');
  sessionPicker.className = 'session-picker';
  const sessionHint = document.createElement('span');
  sessionHint.className = 'session-hint';
  function applySessions(names: string[]) {
    const all = Array.from(new Set(['web', ...names.filter(Boolean)]));
    sessionPicker.replaceChildren(...all.map((n) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'session-chip';
      chip.textContent = n === 'web' ? 'web (default)' : n;
      if (sessionInput.value.trim() === n) chip.classList.add('selected');
      chip.addEventListener('click', () => {
        sessionInput.value = n;
        for (const c of sessionPicker.children) c.classList.toggle('selected', c === chip);
        sessionInput.focus();
      });
      return chip;
    }));
  }
  sessionRow.append(sessionInput, sessionRefresh);
  sessionWrap.append(sessionSpan, sessionRow, sessionPicker, sessionHint);
  // Pre-fill from cached status (edit mode only — an unsaved box has no snapshot).
  applySessions(isEdit ? (latestStatus[box!.id]?.sessions ?? []).map((s) => s.name) : []);

  sessionRefresh.addEventListener('click', async () => {
    const host = fields.host.value.trim();
    if (!host) { sessionHint.textContent = 'enter a host first'; sessionHint.className = 'session-hint err'; return; }
    sessionRefresh.disabled = true;
    sessionHint.className = 'session-hint';
    sessionHint.textContent = 'fetching…';
    try {
      const spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string } = { host };
      if (isEdit) spec.id = box!.id;
      const user = fields.user.value.trim(); if (user) spec.user = user;
      const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
      const portRaw = fields.port.value.trim(); if (portRaw) spec.port = Number(portRaw);
      const res = await api.probeSessions(spec);
      if (res.inUse) {
        sessionHint.textContent = 'terminal still connecting — retry shortly';
      } else if (res.needsAuth) {
        sessionHint.textContent = 'needs login — open the terminal';
        sessionHint.className = 'session-hint err';
      } else if (!res.reachable) {
        sessionHint.textContent = "couldn't reach host";
        sessionHint.className = 'session-hint err';
      } else if (res.tmux === false) {
        applySessions([]);
        sessionHint.textContent = 'tmux not running';
      } else {
        const names = (res.sessions ?? []).map((s) => s.name);
        applySessions(names);
        sessionHint.textContent = names.length ? `${names.length} session${names.length === 1 ? '' : 's'}` : 'no sessions yet';
      }
    } catch (e: any) {
      sessionHint.textContent = e?.message || 'fetch failed';
      sessionHint.className = 'session-hint err';
    } finally {
      sessionRefresh.disabled = false;
    }
  });

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
  const tagListId = 'tag-options';
  const tagDatalist = document.createElement('datalist');
  tagDatalist.id = tagListId;
  for (const tag of existingTagOptions()) {
    const option = document.createElement('option');
    option.value = tag;
    tagDatalist.appendChild(option);
  }

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
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    tagDatalist,
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    sessionWrap,
    installOhMyTmux,
    shellGroup,
    err,
    actions,
  );

  // Pre-populate fields in edit mode
  if (isEdit) {
    fields.label.value = box!.label !== box!.host ? box!.label : '';
    fields.tag.value = primaryTag(box!);
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
  // Only close on a genuine backdrop click. A text selection that starts inside
  // an input and ends on the backdrop produces a click whose target is the
  // backdrop (the common ancestor), which would otherwise close the modal — so
  // require the press to have started on the backdrop too.
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      if (isEdit) {
        const patch: any = {};
        const label = fields.label.value.trim(); if (label) patch.label = label;
        const user = fields.user.value.trim(); patch.user = user || null;
        const jump = fields.proxyJump.value.trim(); patch.proxyJump = jump || null;
        const tag = canonicalTagForInput(fields.tag.value);
        patch.tags = tag ? [tag] : [];
        patch.sessionName = sessionInput.value.trim() || 'web';
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
        const spec: AddBoxSpec = { host };
        const label = fields.label.value.trim(); if (label) spec.label = label;
        const tag = canonicalTagForInput(fields.tag.value); if (tag) spec.tags = [tag];
        spec.sessionName = sessionInput.value.trim() || 'web';
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

function selectedTargetLabels(): { id: string; label: string }[] {
  return allBoxes.filter((b) => fleetSelected.has(b.id)).map((b) => ({ id: b.id, label: b.label }));
}

function renderFleetBar() {
  const bar = app.querySelector('#fleet-bar') as HTMLElement | null;
  if (!bar) return;
  if (!fleetMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';

  const recent = readFleetRecent();
  const listId = 'fleet-recent';
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  for (const cmd of recent) {
    const opt = document.createElement('option');
    opt.value = cmd;
    datalist.appendChild(opt);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fleet-input';
  input.placeholder = 'command to run on selected boxes…';
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  // Expand the one-liner into a full bash-script editor (modal). Newlines flow
  // through to the remote shell verbatim, so a script runs just like a command.
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'fleet-expand';
  expand.title = 'Edit as a bash script';
  expand.setAttribute('aria-label', 'Edit as a bash script');
  expand.textContent = '⤢';

  const inputRow = document.createElement('div');
  inputRow.className = 'fleet-input-row';
  inputRow.append(input, expand);

  const run = document.createElement('button');
  run.type = 'button';
  run.id = 'fleet-run';
  run.className = 'fleet-run';
  run.textContent = `Run on ${fleetSelected.size}`;
  run.disabled = fleetSelected.size === 0;

  function submit() {
    const command = input.value.trim();
    if (!command || fleetSelected.size === 0) return;
    openFleetConfirm(command, selectedTargetLabels());
  }
  run.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  expand.addEventListener('click', () => openFleetScriptEditor(input.value, selectedTargetLabels()));

  bar.append(datalist, inputRow, run);
  syncFleetUI();
}

function syncFleetUI() {
  const count = fleetSelected.size;
  const run = app.querySelector('#fleet-run') as HTMLButtonElement | null;
  if (run) {
    run.textContent = `Run on ${count}`;
    run.disabled = count === 0;
  }
  // Reflect per-box + per-group checkbox state without a full repaint.
  app.querySelectorAll('input.box-check').forEach((el) => {
    const cb = el as HTMLInputElement;
    cb.checked = fleetSelected.has(cb.dataset.id || '');
  });
  app.querySelectorAll('.box-group').forEach((groupEl) => {
    const ids = Array.from(groupEl.querySelectorAll('input.box-check')).map((el) => (el as HTMLInputElement).dataset.id || '');
    const state = groupState(fleetSelected, ids);
    const gc = groupEl.querySelector('input.group-check') as HTMLInputElement | null;
    if (gc) { gc.checked = state === 'all'; gc.indeterminate = state === 'some'; }
  });
  // Master "select all" reflects every currently-shown box.
  const selectAll = app.querySelector('.fleet-select-all .select-all-check') as HTMLInputElement | null;
  if (selectAll) {
    const shownIds = Array.from(app.querySelectorAll('input.box-check')).map((el) => (el as HTMLInputElement).dataset.id || '');
    selectAll.checked = groupState(fleetSelected, shownIds) === 'all';
    selectAll.indeterminate = false;
  }
}

function openFleetConfirm(command: string, targets: { id: string; label: string }[]) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal fleet-confirm';

  const title = document.createElement('h2');
  title.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}?`;

  const cmd = document.createElement('pre');
  cmd.className = 'fleet-confirm-cmd';
  cmd.textContent = `$ ${command}`;

  const targetList = document.createElement('div');
  targetList.className = 'fleet-confirm-targets';
  targetList.textContent = targets.map((t) => t.label).join('  •  ');

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}`;
  actions.append(cancel, confirm);

  form.append(title, cmd, targetList, err, actions);
  backdrop.appendChild(form);
  app.appendChild(backdrop);

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    confirm.disabled = true;
    try {
      const job = await api.createFleetJob(targets.map((t) => t.id), command);
      pushFleetRecent(command);
      close();
      openFleetJobsPanel(job.id); // jumps straight to the live job (Task 15)
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not start fleet job';
      confirm.disabled = false;
    }
  });
}

// Full bash-script editor for a fleet run. The script text is sent verbatim and
// executed by each box's login shell, so newlines run exactly like a local
// script. Doubles as the confirm step — its Run button creates the job directly.
function openFleetScriptEditor(initial: string, targets: { id: string; label: string }[]) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal fleet-script-modal';

  const title = document.createElement('h2');
  title.textContent = 'Fleet script';

  const hint = document.createElement('p');
  hint.className = 'fleet-script-hint';
  hint.textContent = 'Runs on each selected box via its login shell. Newlines are honored — write a full bash script. ⌘/Ctrl+Enter to run.';

  const editor = document.createElement('textarea');
  editor.className = 'fleet-script';
  editor.spellcheck = false;
  editor.autocapitalize = 'off';
  editor.setAttribute('autocorrect', 'off');
  editor.placeholder = '#!/usr/bin/env bash\nset -euo pipefail\n…';
  editor.value = fleetScriptDraft || initial || '';

  const targetList = document.createElement('div');
  targetList.className = 'fleet-confirm-targets';
  targetList.textContent = targets.length
    ? targets.map((t) => t.label).join('  •  ')
    : 'No boxes selected — select boxes before running.';

  const err = document.createElement('p');
  err.className = 'err';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.className = 'fleet-script-run';
  runBtn.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}`;
  runBtn.disabled = targets.length === 0;
  actions.append(cancel, runBtn);

  form.append(title, hint, editor, targetList, err, actions);
  backdrop.appendChild(form);
  app.appendChild(backdrop);
  editor.focus();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  // Keep the in-progress script so reopening restores it; cleared only on a successful run or on leaving fleet mode.
  editor.addEventListener('input', () => { fleetScriptDraft = editor.value; });
  cancel.addEventListener('click', close);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = editor.value.trim();
    if (!command) { err.textContent = 'Script is empty'; return; }
    if (targets.length === 0) { err.textContent = 'Select at least one box'; return; }
    runBtn.disabled = true;
    try {
      const job = await api.createFleetJob(targets.map((t) => t.id), command);
      // Only single-line commands belong in the one-liner autocomplete/datalist.
      if (!command.includes('\n')) pushFleetRecent(command);
      fleetScriptDraft = '';
      close();
      openFleetJobsPanel(job.id);
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not start fleet job';
      runBtn.disabled = false;
    }
  });
}

let fleetPollTimer: any = null;
let fleetPollJobId: string | null = null;

function stopFleetPoll() { if (fleetPollTimer) { clearTimeout(fleetPollTimer); fleetPollTimer = null; } fleetPollJobId = null; }

function closeFleetJobsPanel() {
  stopFleetPoll();
  document.getElementById('fleet-panel')!.classList.remove('open');
  document.getElementById('fleet-jobs')?.classList.remove('active');
}

function openFleetJobsPanel(jobId?: string) {
  const panel = document.getElementById('fleet-panel')!;
  panel.classList.add('open');
  document.getElementById('fleet-jobs')?.classList.add('active');
  const closeBtn = panel.querySelector('.fleet-panel-close') as HTMLElement;
  closeBtn.onclick = () => closeFleetJobsPanel();
  renderFleetHistory();
  if (jobId) showFleetJob(jobId);
  else (panel.querySelector('.fleet-detail') as HTMLElement).innerHTML = '<p class="fleet-empty">Select a job to see results.</p>';
}

async function renderFleetHistory() {
  const list = document.querySelector('#fleet-panel .fleet-history') as HTMLElement | null;
  if (!list) return;
  let jobs: import('./api').FleetJobSummary[] = [];
  try { jobs = await api.listFleetJobs(); } catch {}
  list.innerHTML = '';
  for (const s of jobs) {
    const li = document.createElement('li');
    li.className = 'fleet-history-item';
    li.dataset.id = s.id;
    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'fh-cmd';
    cmdSpan.textContent = s.command;
    const metaSpan = document.createElement('span');
    metaSpan.className = 'fh-meta';
    metaSpan.textContent = `${s.okCount}/${s.targetCount} ok · ${s.status}`;
    li.appendChild(cmdSpan);
    li.appendChild(metaSpan);
    li.addEventListener('click', () => showFleetJob(s.id));
    list.appendChild(li);
  }
}

async function showFleetJob(id: string) {
  stopFleetPoll();
  const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
  if (!detail) return;
  let job: import('./api').FleetJob;
  try { job = await api.getFleetJob(id); } catch { detail.innerHTML = '<p class="err">Could not load job.</p>'; return; }
  renderFleetJob(detail, job);
  if (job.status === 'running') { fleetPollJobId = id; fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500); }
}

async function pollFleetJob(id: string) {
  const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
  if (!detail) { stopFleetPoll(); return; }
  let job: import('./api').FleetJob;
  try { job = await api.getFleetJob(id); } catch { if (fleetPollJobId === id) fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500); return; }
  if (fleetPollJobId === id) renderFleetJob(detail, job);
  if (job.status === 'running') { if (fleetPollJobId === id) fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500); }
  else { stopFleetPoll(); renderFleetHistory(); }
}

function renderFleetJob(detail: HTMLElement, job: import('./api').FleetJob) {
  detail.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'fleet-detail-head';
  const cmd = document.createElement('pre');
  cmd.className = 'fleet-confirm-cmd';
  cmd.textContent = `$ ${job.command}`;
  const status = document.createElement('span');
  status.className = `fleet-job-status ${job.status}`;
  status.textContent = job.status;
  head.append(cmd, status);
  detail.appendChild(head);

  if (job.status === 'running') {
    const cancel = document.createElement('button');
    cancel.className = 'fleet-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', async () => { cancel.disabled = true; try { await api.cancelFleetJob(job.id); } catch {} });
    detail.appendChild(cancel);
  }

  for (const t of job.targets) {
    const row = document.createElement('div');
    row.className = `fleet-result ${t.status}`;
    const top = document.createElement('div');
    top.className = 'fleet-result-top';
    const name = document.createElement('span');
    name.className = 'fr-label';
    name.textContent = t.label;
    const badge = document.createElement('span');
    badge.className = 'fr-badge';
    badge.textContent = t.status === 'ok' ? 'exit 0'
      : t.status === 'error' ? (t.code != null ? `exit ${t.code}` : (t.error || 'error'))
      : t.status; // running | pending | cancelled | interrupted
    top.append(name, badge);
    row.appendChild(top);

    const body = (t.stdout || '') + (t.stderr ? `\n${t.stderr}` : '');
    if (body.trim()) {
      const out = document.createElement('pre');
      out.className = 'fr-output';
      out.textContent = body + (t.truncated ? '\n… (truncated)' : '');
      row.appendChild(out);
    }
    detail.appendChild(row);
  }
}

start();
