import { api, onUnauthorized, type AddBoxSpec, type Box, type Status, type Sample, type HealthEvent, type SetupJob, type SetupSummary } from './api';
import { openTerminal, openProvisionTerminal, setTerminalFont, setTerminalUploads } from './terminal';
import { setupStatusText, setupActions, setupBadge } from './setupStatus';
import { dotClassFor, dotTitleFor, metaSegmentsFor } from './statusDot';
import { sparkline } from './sparkline';
import { formatEvent, relTime, unseenCountFiltered } from './healthEvents';
import { loadNotifyPrefs, enabledKinds } from './notifyPrefs';
import { toggleBox, setBoxes, groupState } from './fleetSelection';
import { addRecent, parseRecent } from './fleetHistory';
import { createFleetScriptEditor } from './fleetEditor';
import { createFleetPoller } from './fleetPoll';
import { createInteractiveLauncher } from './interactiveLauncher';
import { closeAllModals } from './modalRegistry';
import { openModal, makeRadio } from './dom';
import { createSetupJobPoller } from './setupPoller';
import logoUrl from './assets/tmuxifier-logo.png';
import { openProxmoxHub } from './proxmoxUi';
import { pve } from './proxmox';
import { openSettingsModal } from './settingsUi';
import { createProxmoxAssociationEditor } from './proxmoxAssociation';
import { toolsCheckboxGroup } from './provisionTools';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal> }>();
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';
const GROUP_COLLAPSED_KEY = 'tmuxifier.collapsedTagGroups';
const UNTAGGED_LABEL = 'Untagged';
const UNTAGGED_KEY = '__untagged__';
let activeBoxId: string | null = null;
let allBoxes: Box[] = [];
let latestStatus: Record<string, Status> = {};
let latestSetups: SetupSummary[] = [];
let fleetMode = false;
let fleetSelected = new Set<string>();
let fleetScriptDraft = ''; // in-progress bash-script editor content; survives reopen, cleared on run/exit

// Box health history (rolling series + in-app events). Both ride the status
// poll tick; the caches let repaints (search, fleet mode) redraw without a fetch.
const SPARK_METRIC_KEY = 'tmuxifier.sparkMetric';
const EVENTS_SEEN_KEY = 'tmuxifier.eventsSeen';
type SparkMetric = 'cpuPct' | 'memPct' | 'diskPct';
const SPARK_METRICS: SparkMetric[] = ['cpuPct', 'memPct', 'diskPct'];
const SPARK_LABEL: Record<SparkMetric, string> = { cpuPct: 'CPU', memPct: 'memory', diskPct: 'disk' };
let latestSeries: Record<string, Sample[]> = {};
let latestEvents: HealthEvent[] = [];
let latestEventSeq = 0;
let lastNotifiedSeq = -1; // -1 until the first poll seeds it (no startup flood)

function sparkMetric(): SparkMetric {
  const v = localStorage.getItem(SPARK_METRIC_KEY) as SparkMetric | null;
  return v && SPARK_METRICS.includes(v) ? v : 'cpuPct';
}

// One shared preference: clicking any row's sparkline cycles every row through
// cpu → mem → disk, so the sidebar always compares like with like.
function cycleSparkMetric() {
  const next = SPARK_METRICS[(SPARK_METRICS.indexOf(sparkMetric()) + 1) % SPARK_METRICS.length];
  localStorage.setItem(SPARK_METRIC_KEY, next);
  syncSparkMetricClass();
  repaintSparklines();
}

// The sparkline itself is anonymous — name what it graphs by highlighting the
// matching meta-line figure. One class on the list (spark-cpu|mem|disk) lets
// CSS pair it with the tagged .metric-* segments across every row.
function syncSparkMetricClass() {
  const list = app.querySelector('#boxes');
  if (!list) return;
  list.classList.remove('spark-cpu', 'spark-mem', 'spark-disk');
  list.classList.add(`spark-${sparkMetric().replace('Pct', '')}`);
}

function repaintSparklines() {
  app.querySelectorAll('.box').forEach((li) => {
    const id = (li as HTMLElement).dataset.id;
    if (id) applySparkline(li as HTMLElement, id);
  });
}

// Paint a box row's metric sparkline from the cached series. Same in-place
// pattern as applyRowStatus so the poll never rebuilds whole rows. An empty
// path (too few points, metric absent) empties the span; CSS :empty hides it.
function applySparkline(li: HTMLElement, id: string) {
  const el = li.querySelector('.spark') as HTMLElement | null;
  if (!el) return;
  const metric = sparkMetric();
  const d = sparkline(latestSeries[id] || [], metric);
  if (!d) { el.replaceChildren(); el.removeAttribute('title'); return; }
  el.title = `${SPARK_LABEL[metric]} trend — click to switch metric`;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'spark-svg');
  svg.setAttribute('viewBox', '0 0 64 16');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  el.replaceChildren(svg);
}

function readLastSeenSeq(): number { return Number(localStorage.getItem(EVENTS_SEEN_KEY)) || 0; }
function writeLastSeenSeq(seq: number) { localStorage.setItem(EVENTS_SEEN_KEY, String(seq)); }

// The badge counts not-yet-viewed events of kinds enabled in Settings →
// Notifications (loadNotifyPrefs/enabledKinds) — the events log itself is
// never filtered. Browser notifications for those same enabled kinds fire
// separately, from an unfocused tab, in pollHealth below.
function updateEventsBadge() {
  const badge = document.getElementById('events-badge');
  if (!badge) return;
  const n = unseenCountFiltered(latestEvents, readLastSeenSeq(), enabledKinds(loadNotifyPrefs()));
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

// Paint a box row's status affordances (dot + health meta line) from a status
// snapshot. Shared by initial render and the poll so they never drift.
function applyRowStatus(li: HTMLElement, _id: string, st: Status | undefined) {
  const dotEl = li.querySelector('.dot') as HTMLElement | null;
  if (dotEl) { dotEl.className = `dot ${dotClassFor(st)}`; dotEl.title = dotTitleFor(st); }
  const forgetEl = li.querySelector('.forget-key') as HTMLElement | null;
  if (forgetEl) forgetEl.style.display = st?.hostKeyChanged ? '' : 'none';
  const metaEl = li.querySelector('.box-meta') as HTMLElement | null;
  if (metaEl) {
    const nodes: Node[] = [];
    metaSegmentsFor(st).forEach((s, i) => {
      if (i) nodes.push(document.createTextNode(' · '));
      const span = document.createElement('span');
      if (s.level) span.classList.add(`lvl-${s.level}`);
      // Tag metric segments so the active sparkline metric can highlight its
      // source figure (see syncSparkMetricClass + the .spark-* CSS pairing).
      if (s.metric) span.classList.add(`metric-${s.metric}`);
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
    try {
      const uiCfg = await api.uiConfig();
      setTerminalFont(uiCfg);
      setTerminalUploads(uiCfg);
    } catch {}
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
    try {
      const status = await api.status();
      latestStatus = status;
      const list = app.querySelectorAll('.box');
      list.forEach(li => {
        const id = (li as HTMLElement).dataset.id;
        if (!id) return;
        applyRowStatus(li as HTMLElement, id, status[id]);
      });
      // Reconcile Proxmox-stopped state with open terminals and the stopped panel:
      // a box that stopped out from under a live terminal loses that terminal, the
      // active stopped box shows its panel, and a panel whose container restarted
      // is cleared back to the empty stage.
      const selected = activeBoxId ? allBoxes.find((box) => box.id === activeBoxId) : undefined;
      for (const [id] of tabs) {
        if (id !== '__local__' && status[id]?.proxmoxState === 'stopped') closeTab(id);
      }
      if (selected && status[selected.id]?.proxmoxState === 'stopped') {
        showStoppedBox(selected);
      } else if (!selected || status[selected.id]?.proxmoxState !== 'unknown') {
        // 'unknown' means the PVE read failed or is stale — it must never be
        // read as "the container started", so keep the stopped panel up.
        const stage = app.querySelector('#stage') as HTMLElement;
        const stoppedPanel = stage.querySelector('.stopped-box-state');
        if (stoppedPanel) {
          stoppedPanel.remove();
          activeBoxId = null;
          highlightBox(null);
          if (!stage.querySelector('.empty')) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Select a box to open a terminal.';
            stage.append(empty);
          }
        }
      }
    } catch {}
    // Health extras (sparkline series + events) ride the same tick but fail
    // independently — a hiccup on either side must not stop the dots.
    await pollHealth();
  } finally {
    polling = false;
  }
}

async function pollHealth() {
  try {
    latestSeries = await api.healthSeries();
    repaintSparklines();
  } catch {}
  try {
    const { events, latestSeq } = await api.healthEvents();
    latestEvents = events;
    latestEventSeq = latestSeq;
    // Self-heal a stale high-water mark: if the server's events log was reset,
    // seq restarts below the stored cursor and the badge would never fire again.
    if (readLastSeenSeq() > latestSeq) writeLastSeenSeq(latestSeq);
    // Browser notifications for newly-arrived enabled events. Seed the cursor
    // on the first poll so a page load never replays history. Fire only when
    // permission is granted and this tab is not focused — a focused tab already
    // shows the badge, so a popup would be redundant.
    // Self-heal like the seen-cursor above: a server events-log reset restarts
    // seq below our cursor, which would otherwise mute notifications forever.
    if (lastNotifiedSeq > latestSeq) lastNotifiedSeq = latestSeq;
    if (lastNotifiedSeq < 0) {
      lastNotifiedSeq = latestSeq;
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
      const enabled = enabledKinds(loadNotifyPrefs());
      for (const e of events) {
        if (e.seq > lastNotifiedSeq && enabled.has(e.kind)) {
          const line = formatEvent(e);
          try {
            const n = new Notification(`Tmuxifier — ${e.label || e.host}`, { body: line.text, tag: `${e.kind}:${e.boxId}` });
            n.onclick = () => { window.focus(); n.close(); };
          } catch { /* notifications unavailable */ }
        }
      }
      lastNotifiedSeq = latestSeq;
    } else {
      lastNotifiedSeq = latestSeq; // keep the cursor current while unfocused-but-denied or focused
    }
    updateEventsBadge();
    // Keep an open panel live; rendering also marks the new events seen.
    if (document.getElementById('events-panel')?.classList.contains('open')) renderEventsPanel();
  } catch {}
}

// The Proxmox hub is useless until a host profile exists (setup lives in
// Settings → Proxmox), so the sidebar button only appears once one does.
// A fetch error keeps it hidden — never show a dead button.
async function syncProxmoxButton() {
  const btn = app.querySelector<HTMLButtonElement>('#proxmox');
  if (!btn) return;
  try { btn.hidden = (await pve.hosts()).length === 0; } catch { btn.hidden = true; }
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
            <button id="settings" type="button" title="Settings" aria-label="Settings">⚙</button>
            <button id="export" type="button" title="Export boxes to a file" aria-label="Export boxes to a file">⤓</button>
            <button id="import" type="button" title="Import boxes from a file" aria-label="Import boxes from a file">⤒</button>
            <button id="logout" title="Log out">⎋</button>
          </div>
          <input id="import-file" type="file" accept="application/json,.json" hidden />
        </div>
        <div class="actions"><button id="add">+ Add box</button></div>
        <div class="fleet-actions"><button id="fleet-toggle" type="button" class="fleet-toggle">Fleet Command</button><button id="fleet-jobs" type="button" class="fleet-jobs-btn" title="Fleet job history">Fleet Jobs</button><button id="proxmox" type="button" class="proxmox-btn" title="Provision Proxmox LXC containers" hidden>Proxmox</button><button id="events" type="button" class="events-btn" title="Box health events (down/up/needs login/thresholds)">Events<span id="events-badge" class="events-badge" hidden></span></button></div>
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
    // Dispose every terminal before the login screen replaces the dashboard:
    // the tabs map is module-level, so surviving entries would keep detached
    // elements (unopenable boxes after re-login) and live reconnect loops.
    for (const id of [...tabs.keys()]) closeTab(id);
    closeFleetJobsPanel();
    closeEventsPanel();
    closeProvisionPanel();
    closeAllModals(); // body-mounted modals (Proxmox hub, settings) survive the #app re-render
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
  app.querySelector('#settings')!.addEventListener('click', () => { openSettingsModal('netbox', () => { void syncProxmoxButton(); }); });
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
  app.querySelector('#events')!.addEventListener('click', () => {
    const panel = document.getElementById('events-panel')!;
    if (panel.classList.contains('open')) closeEventsPanel();
    else openEventsPanel();
  });
  app.querySelector('#proxmox')!.addEventListener('click', () => openProxmoxHub({
    openBox: (b) => openBox(b),
    openEditBox: (boxId) => { const b = allBoxes.find((x) => x.id === boxId); if (b) openBoxDialog(b); },
    onBoxLinked: () => { void refresh(); },
  }));
  void syncProxmoxButton();

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

  syncSparkMetricClass();
  await refresh();
  pollInterval = setInterval(pollStatus, POLL_MS);
  void pollHealth(); // seed sparklines + events badge without waiting a tick
}

async function refresh() {
  const list = app.querySelector('#boxes'); if (!list) return;
  allBoxes = await api.boxes();
  // Keep the previous status/setup caches until fresh responses land — wiping
  // them here flashed every dot gray and dropped setup badges on each add/
  // edit/remove/import.
  api.status().then((s) => { latestStatus = s; filterAndPaint(); }).catch(() => {});
  api.listSetups().then((s) => { latestSetups = s; filterAndPaint(); }).catch(() => {});
  filterAndPaint();
}

function createBoxRow(b: Box, status: Record<string, Status>): HTMLElement {
  const st = status[b.id];

  const li = document.createElement('li');
  li.className = b.id === activeBoxId ? 'box active' : 'box';
  li.dataset.id = b.id;
  li.dataset.boxId = b.id; // matches [data-box-id] used by tests/tooling to locate a card

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
  const badgesEl = document.createElement('span');
  badgesEl.className = 'box-badges';
  // latestSetups is newest-first (the manager's ordered()), so the first match
  // for this box is its current setup job. Rendered as part of every row build
  // (both the sync and async-status repaints in refresh()) so a badge can never
  // be wiped by a later repaint racing a post-hoc DOM patch.
  const setup = latestSetups.find((s) => s.boxId === b.id);
  const badge = setup ? setupBadge(setup.status) : null;
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = `badge ${badge.cls}`;
    badgeEl.textContent = badge.text;
    badgesEl.append(badgeEl);
  }
  const metaEl = document.createElement('span');
  metaEl.className = 'box-meta';
  const sparkEl = document.createElement('span');
  sparkEl.className = 'spark';
  sparkEl.addEventListener('click', (e) => { e.stopPropagation(); cycleSparkMetric(); });
  mainEl.append(nameEl, badgesEl, metaEl, sparkEl);

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

  const forgetKeyBtn = document.createElement('button');
  forgetKeyBtn.className = 'forget-key';
  forgetKeyBtn.title = 'Forget old host key — only if this box was legitimately rebuilt (removes its known_hosts entry, then reconnects)';
  forgetKeyBtn.textContent = '⚷';
  forgetKeyBtn.style.display = 'none';
  forgetKeyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Forget the stored host key for ${b.label}? Only do this if the box was legitimately rebuilt.`)) return;
    await api.forgetHostKey(b.id);
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
    // The ✕ sits in a tight icon cluster next to ✎ — one misclick used to
    // destroy the box config with no way back. Same confirm() pattern as every
    // remove in the Proxmox hub. (Only the Tmuxifier entry is removed; the tmux
    // session on the box keeps running.)
    if (!confirm(`Remove box ${b.label}?`)) return;
    await api.removeBox(b.id);
    closeTab(b.id);
    await refresh();
  });

  const actions = document.createElement('span');
  actions.className = 'box-actions';
  actions.append(forgetKeyBtn, refreshBtn, edit, rm);

  li.append(check, dotEl, mainEl, actions);
  applyRowStatus(li, b.id, st);
  applySparkline(li, b.id);
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
  stage.querySelector('.stopped-box-state')?.remove();
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

// Highlight one box row (and its containing tag group) as active, clearing the
// rest. `null` de-highlights everything (local shell / empty stage). Shared by
// openBox, showStoppedBox, and the poll reconcile so highlight state never drifts.
function highlightBox(boxId: string | null) {
  app.querySelectorAll('.box').forEach((element) => {
    const row = element as HTMLElement;
    row.classList.toggle('active', boxId !== null && row.dataset.id === boxId);
  });
  app.querySelectorAll('.box-group').forEach((element) => {
    const group = element as HTMLElement;
    group.classList.toggle('active-child', boxId !== null && !!group.querySelector(`.box[data-id="${CSS.escape(boxId)}"]`));
  });
}

// A Proxmox-linked box confirmed stopped has no reachable tmux, so instead of a
// dead terminal the stage shows a static panel with the container's identity and
// a shortcut into the Proxmox Containers tab (Start / Deprovision live there).
function showStoppedBox(box: Box) {
  activeBoxId = box.id;
  highlightBox(box.id);
  app.querySelector('.local-shell')?.classList.remove('active');
  for (const terminal of tabs.values()) terminal.el.style.display = 'none';
  const stage = app.querySelector('#stage') as HTMLElement;
  stage.querySelector('.empty')?.remove();
  stage.querySelector('.stopped-box-state')?.remove();
  const state = latestStatus[box.id];
  const panel = document.createElement('div');
  panel.className = 'stopped-box-state';
  const title = document.createElement('strong');
  title.textContent = `${box.label} is stopped`;
  const detail = document.createElement('span');
  detail.textContent = `${state?.proxmoxNode ?? 'Proxmox'} | VMID ${state?.proxmoxVmid ?? box.proxmox?.vmid ?? '-'}`;
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'pve-btn';
  manage.textContent = 'Open Proxmox';
  manage.addEventListener('click', () => openProxmoxHub({
    openBox,
    openEditBox: (id) => { const target = allBoxes.find((item) => item.id === id); if (target) openBoxDialog(target); },
    onBoxLinked: () => { void refresh(); },
  }, { tab: 'Containers', focusBoxId: box.id }));
  panel.append(title, detail, manage);
  stage.append(panel);
}

function openBox(b: Box) {
  if (latestStatus[b.id]?.proxmoxState === 'stopped') {
    closeTab(b.id);
    showStoppedBox(b);
    return;
  }
  activeBoxId = b.id;
  highlightBox(b.id);
  // De-highlight local shell bar when switching to a box
  const ls = app.querySelector('.local-shell');
  if (ls) ls.classList.remove('active');
  const stage = app.querySelector('#stage') as HTMLElement;
  stage.querySelector('.stopped-box-state')?.remove();
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

  const isShell = (v: string) => currentShell === v
    || (v === 'none' && !['none', 'omz', 'omb'].includes(currentShell));
  const shellNone = makeRadio('localShellFramework', 'none', 'None', isShell('none'));
  const shellZsh = makeRadio('localShellFramework', 'omz', 'Oh My Zsh', isShell('omz'));
  const shellBash = makeRadio('localShellFramework', 'omb', 'Oh My Bash', isShell('omb'));
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
  const { close } = openModal({ modal: form, mount: app });
  cancel.addEventListener('click', close);

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

// One provision run owns the shared static panel at a time. Module-level state
// so a re-open can cancel the previous run's pending poll timer / auto-close
// and dispose any live interactive terminal (whose WebSocket would otherwise
// keep streaming into a detached element), and so logout/session-expiry can
// tear the panel down too.
let activeProvisionCleanup: (() => void) | null = null;

// Bumped on every panel open and every run teardown, so a fire-and-forget
// callback (the seed-AI-auth request below) can tell whether the panel it
// was writing to still belongs to the run that started it. Without this, a
// slow seed request from a previous box's run can land after the panel was
// reopened for a different box and append onto the wrong status line.
let provisionPanelGen = 0;

function closeProvisionPanel() {
  const panel = document.getElementById('provision-panel')!;
  panel.classList.remove('open');
  const cleanup = activeProvisionCleanup;
  activeProvisionCleanup = null;
  cleanup?.();
}

// Poll-based setup viewer: POSTs a durable server-side setup job, then polls
// it (GET /api/setup/:id) instead of streaming a live WebSocket terminal —
// the job survives Tmuxifier restarts, so a reload/reconnect just resumes
// polling. `needs-interactive` (sudo password required) falls back to the
// existing WS PTY (openProvisionTerminal) so the user can type it in; the
// server marks the job's outcome from that session (markInteractiveResult),
// so polling simply keeps going until the status changes.
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools?: string[]; seedAiAuth?: boolean }) {
  const panel = document.getElementById('provision-panel')!;
  const title = panel.querySelector('.provision-title')!;
  const status = panel.querySelector('.provision-status')!;
  const container = panel.querySelector('.provision-term') as HTMLElement;
  const closeBtn = panel.querySelector('.provision-close') as HTMLElement;

  // Tear down any previous run first (pending poll timer / auto-close, live interactive WS).
  closeProvisionPanel();
  provisionPanelGen += 1;

  title.textContent = `Setup — ${box.label}`;
  status.textContent = '';
  status.className = 'provision-status';
  container.innerHTML = '';
  panel.classList.add('open');

  const opts = { ohMyTmux: options.ohMyTmux, ohMyZsh: options.ohMyZsh, ohMyBash: options.ohMyBash, tools: options.tools || [] };
  const seedAiAuth = !!options.seedAiAuth;
  const log = document.createElement('pre');
  log.className = 'provision-log';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  container.append(log, actions);

  let currentJobId: string | null = null;
  let autoCloseTimer: number | undefined;
  // Fire-once guard: onJob observes 'done' once per normal run, but the
  // needs-interactive fallback re-enters polling, so this must survive restarts.
  let seeded = false;
  // One interactive session at a time: a second "Finish interactively" click
  // must not start a concurrent setup script run on the same box.
  const interactive = createInteractiveLauncher<ReturnType<typeof openProvisionTerminal>>();
  // Shared poll loop (setupPoller.ts); the onJob policy below renders this
  // panel's chrome and decides the cadence per status.
  const poller = createSetupJobPoller<SetupJob>({
    fetchJob: () => api.getSetup(currentJobId!),
    onJob: (job) => {
      if (!job) return 1500; // transient fetch error — keep trying
      status.textContent = setupStatusText(job);
      status.className = 'provision-status' + (job.status === 'done' ? ' success' : (job.status === 'error' || job.status === 'interrupted' || job.status === 'needs-interactive') ? ' error' : '');
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      renderActions(job.status);
      if (job.status === 'running') return 1500;
      if (job.status === 'done') {
        refresh();
        if (seedAiAuth) {
          // Auto-close must wait for the seed outcome to render (below) before
          // arming, or it destroys the outcome (e.g. a skip reason) before the
          // operator can read it — see the generation guard on each branch.
          if (!seeded) {
            seeded = true;
            const myGen = provisionPanelGen;
            void api.seedAiAuth(box.id).then(({ results }) => {
              if (provisionPanelGen !== myGen) return; // panel closed/reopened while the request was in flight
              const txt = results.map((r) => `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`).join(' · ');
              status.textContent = `${status.textContent} · auth: ${txt}`;
            }).catch(() => {
              if (provisionPanelGen !== myGen) return; // panel closed/reopened while the request was in flight
              status.textContent = `${status.textContent} · auth: request failed`;
            }).finally(() => {
              if (provisionPanelGen !== myGen) return; // panel closed/reopened while the request was in flight
              autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), 5000);
            });
          }
        } else {
          autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), 2000);
        }
        return null;
      }
      if (job.status === 'needs-interactive') return 2500;
      return null; // error / interrupted: terminal for this run — Retry/Remove/Close cover it
    },
  });
  const stop = () => {
    poller.stop();
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    // Disposes a live interactive session; no-op when its own onComplete
    // already ran. Only matters if the panel is closed mid-session.
    interactive.stop();
    provisionPanelGen += 1;
  };

  function btn(label: string, onclick: () => void, cls = '') {
    const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; b.textContent = label; b.onclick = onclick; return b;
  }

  function renderActions(jobStatus: SetupJob['status']) {
    actions.replaceChildren();
    for (const a of setupActions(jobStatus)) {
      if (a === 'close') actions.append(btn('Close', () => closeProvisionPanel()));
      else if (a === 'retry') actions.append(btn('Retry', () => { void begin(); }, 'pve-primary'));
      else if (a === 'remove') actions.append(btn('Remove box', async () => {
        if (!confirm(`Remove box ${box.label}?`)) return;
        await api.removeBox(box.id);
        stop();
        closeProvisionPanel();
        refresh();
      }, 'danger'));
      else if (a === 'finish-interactive') {
        const b = btn('Finish interactively', () => { finishInteractive(); b.disabled = true; }, 'pve-primary');
        // The poll re-renders these actions while the job stays
        // needs-interactive — keep the button disabled while a session is live.
        b.disabled = interactive.active();
        actions.append(b);
      }
    }
  }

  function finishInteractive() {
    // The existing WS PTY runs the same idempotent script with the user present
    // to type the sudo password. On exit, the server marks the job; the
    // background poll (still running) picks up the new status.
    if (interactive.active()) return;
    log.style.display = 'none';
    const term = document.createElement('div'); term.style.height = '320px'; container.insertBefore(term, actions);
    interactive.launch(() => openProvisionTerminal(term, box.id, opts, () => {
      interactive.done();
      log.style.display = '';
      term.remove();
    }));
  }

  async function begin() {
    try {
      const s = await api.startSetup(box.id, opts);
      currentJobId = s.id;
      poller.start();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Failed to start setup';
      status.className = 'provision-status error';
      renderActions('error');
    }
  }

  activeProvisionCleanup = stop;
  // Always dismissible — a hung/slow setup used to leave the panel covering
  // the screen with no way out short of a reload. onclick assignment (not
  // addEventListener) so re-opens never stack stale handlers that would
  // close the panel over a newer run.
  closeBtn.style.display = '';
  (closeBtn as HTMLButtonElement).onclick = () => closeProvisionPanel();
  void begin();
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

  const shellNone = makeRadio('shellFramework', 'none', 'None', true);
  const shellZsh = makeRadio('shellFramework', 'omz', 'Install Oh My Zsh if missing', false);
  const shellBash = makeRadio('shellFramework', 'omb', 'Install Oh My Bash if missing', false);

  shellGroup.append(shellNone.wrap, shellZsh.wrap, shellBash.wrap);

  const toolsGroup = toolsCheckboxGroup();

  const seedAiAuth = document.createElement('label');
  seedAiAuth.className = 'check-field';
  seedAiAuth.title = 'Copies subscription credentials from the Tmuxifier host to this box — seed only boxes you trust with your own login';
  const seedAiAuthInput = document.createElement('input');
  seedAiAuthInput.type = 'checkbox';
  const seedAiAuthText = document.createElement('span');
  seedAiAuthText.textContent = 'Seed AI CLI auth (claude/codex) from this host';
  seedAiAuth.append(seedAiAuthInput, seedAiAuthText);

  const form = document.createElement('form');
  form.className = 'modal box-modal';
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

  const proxmoxAssociation = createProxmoxAssociationEditor(box ?? null);

  // Two-column body: compact fields pair up (Host|Label, Tag|User, Port|ProxyJump),
  // the session picker and Proxmox section span full width, and err/actions sit
  // outside the scroll region so they are always visible (pinned footer).
  const fieldGrid = document.createElement('div');
  fieldGrid.className = 'field-grid';
  fieldGrid.append(
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
  );

  const setupGrid = document.createElement('div');
  setupGrid.className = 'field-grid';
  setupGrid.append(shellGroup, installOhMyTmux, toolsGroup.element, seedAiAuth);

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';
  modalBody.append(
    fieldGrid,
    tagDatalist,
    sessionWrap,
    setupGrid,
    proxmoxAssociation.element,
  );

  form.append(title, modalBody, err, actions);

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

  const { close } = openModal({ modal: form, mount: app });
  fields.host.focus();
  cancel.addEventListener('click', close);

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
        try {
          await proxmoxAssociation.commit(box!.id);
        } catch (error) {
          await refresh();
          throw error;
        }
        close();
        await refresh();
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        const selectedTools = toolsGroup.selected();
        if (installOhMyTmuxInput.checked || installOhMyZsh || installOhMyBash || selectedTools.length || seedAiAuthInput.checked) {
          openProvisionPanel(updatedBox, {
            ohMyTmux: installOhMyTmuxInput.checked,
            ohMyZsh: installOhMyZsh,
            ohMyBash: installOhMyBash,
            tools: selectedTools,
            seedAiAuth: seedAiAuthInput.checked,
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
          ohMyTmux: installOhMyTmuxInput.checked,
          ohMyZsh: installOhMyZsh,
          ohMyBash: installOhMyBash,
          tools: toolsGroup.selected(),
          seedAiAuth: seedAiAuthInput.checked,
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
  const { close } = openModal({ modal: form, mount: app });
  cancel.addEventListener('click', close);

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
  const form = document.createElement('form');
  form.className = 'modal fleet-script-modal';

  const title = document.createElement('h2');
  title.textContent = 'Fleet script';

  const hint = document.createElement('p');
  hint.className = 'fleet-script-hint';
  hint.textContent = 'Runs on each selected box via its login shell. Newlines are honored — write a full bash script. ⌘/Ctrl+Enter to run.';

  const editorHost = document.createElement('div');
  editorHost.className = 'fleet-script';

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

  form.append(title, hint, editorHost, targetList, err, actions);
  // closeOnEscape off: while the editor has focus its own keymap owns Escape
  // (so an open completion popup's Escape doesn't also tear down the modal);
  // the fallback handler below covers Escape/Mod-Enter when focus is elsewhere.
  const { close } = openModal({
    modal: form, mount: app, closeOnEscape: false,
    onClose: () => { document.removeEventListener('keydown', onKey); cm.destroy(); },
  });

  // CodeMirror handles its own Mod-Enter (run) / Escape (close) while focused;
  // onChange persists the in-progress script so reopening restores it (cleared
  // only on a successful run or on leaving fleet mode).
  const cm = createFleetScriptEditor({
    initial: fleetScriptDraft || initial || '',
    recent: readFleetRecent(),
    placeholder: '#!/usr/bin/env bash\nset -euo pipefail\n…',
    onChange: (v) => { fleetScriptDraft = v; },
    onRun: () => form.requestSubmit(),
    onEscape: () => close(),
  });
  editorHost.appendChild(cm.dom);
  cm.focus();

  // Fallback for keys pressed while focus is on a button (the editor's own keymap
  // owns these while it is focused — defer to it so an open completion popup's
  // Escape doesn't also tear down the modal).
  function onKey(e: KeyboardEvent) {
    if (cm.dom.contains(document.activeElement)) return;
    if (e.key === 'Escape') close();
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = cm.getValue().trim();
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

// --- Events panel (in-app health timeline) ---------------------------------
// Mirrors the Fleet Jobs drawer. No polling loop of its own: pollHealth (on the
// status tick) refreshes the cache and re-renders when the panel is open.

function openEventsPanel() {
  closeFleetJobsPanel(); // the drawers share the same edge; stacking hides one
  const panel = document.getElementById('events-panel')!;
  panel.classList.add('open');
  document.getElementById('events')?.classList.add('active');
  (panel.querySelector('.fleet-panel-close') as HTMLElement).onclick = () => closeEventsPanel();
  renderEventsPanel();
  // Refresh so the list is current even mid-tick; re-render only if still open.
  api.healthEvents().then(({ events, latestSeq }) => {
    latestEvents = events;
    latestEventSeq = latestSeq;
    if (panel.classList.contains('open')) renderEventsPanel();
  }).catch(() => {});
}

function closeEventsPanel() {
  document.getElementById('events-panel')!.classList.remove('open');
  document.getElementById('events')?.classList.remove('active');
}

function renderEventsPanel() {
  const list = document.querySelector('#events-panel .events-list') as HTMLElement | null;
  if (!list) return;
  list.innerHTML = '';
  if (!latestEvents.length) {
    const li = document.createElement('li');
    li.className = 'events-empty';
    li.textContent = 'No events yet. Box transitions (down / up / needs login / metric thresholds) will appear here.';
    list.appendChild(li);
  }
  const now = Date.now();
  for (const e of latestEvents) { // already newest-first from the server
    const line = formatEvent(e);
    const li = document.createElement('li');
    li.className = `event-row ${line.level}`;
    const icon = document.createElement('span');
    icon.className = 'event-icon';
    icon.textContent = line.icon;
    const text = document.createElement('span');
    text.className = 'event-text';
    text.textContent = line.text;
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = relTime(e.t, now);
    time.title = new Date(e.t).toLocaleString();
    li.append(icon, text, time);
    list.appendChild(li);
  }
  // Viewing the panel marks everything seen — but only once real data has
  // loaded (an open before the first fetch must not regress the cursor to 0).
  // The badge stays a passive in-app indicator — no Notification API, no
  // outbound request.
  if (latestEventSeq) writeLastSeenSeq(latestEventSeq);
  updateEventsBadge();
}

// Generation-guarded job-detail poller (fleetPoll.ts): a stale response for a
// previously selected job can neither paint over nor stop the polling of the
// job the user has since switched to.
const fleetPoller = createFleetPoller<import('./api').FleetJob>({
  fetchJob: (id) => api.getFleetJob(id),
  render: (job) => {
    const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
    if (!detail) return false;
    renderFleetJob(detail, job);
    return true;
  },
  renderError: () => {
    const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
    if (detail) detail.innerHTML = '<p class="err">Could not load job.</p>';
  },
  onFinished: () => renderFleetHistory(),
});

function stopFleetPoll() { fleetPoller.stop(); }

function closeFleetJobsPanel() {
  stopFleetPoll();
  document.getElementById('fleet-panel')!.classList.remove('open');
  document.getElementById('fleet-jobs')?.classList.remove('active');
}

function openFleetJobsPanel(jobId?: string) {
  closeEventsPanel(); // the drawers share the same edge; stacking hides one
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

function showFleetJob(id: string) {
  void fleetPoller.show(id);
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
      : t.status === 'skipped' ? (t.error || 'skipped')
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

// Session expiry (or a server restart with a new cookie secret) surfaces as
// 401s on the polls and actions. Tear the dashboard down exactly like logout —
// surviving tabs would keep detached terminal elements and live reconnect
// loops — and land on the login screen with a notice. No-op when the login
// screen is already up (e.g. the 401 from a wrong password on /api/login).
onUnauthorized(() => {
  if (!app.querySelector('.layout')) return;
  if (pollInterval) clearInterval(pollInterval);
  stopFleetPoll();
  for (const id of [...tabs.keys()]) closeTab(id);
  closeFleetJobsPanel();
  closeEventsPanel();
  closeProvisionPanel();
  // Body-mounted modals (Proxmox hub, settings) are outside #app: without an
  // explicit close they would overlay the login screen with pollers running.
  closeAllModals();
  void renderLogin();
  showToast('Session expired — please log in again.', 'error');
});

start();
