import { api, onUnauthorized, type AddBoxSpec, type Box, type Status, type Sample, type HealthEvent, type SetupJob, type SetupSummary } from './api';
import { openTerminal, openProvisionTerminal, setTerminalFont, setTerminalUploads } from './terminal';
import { setupStatusText, setupActions, setupBadge, formatSeedResults, formatStatuslineResult, blocksTerminal } from './setupStatus';
import { dotClassFor, dotTitleFor, metaSegmentsFor } from './statusDot';
import { sparkline } from './sparkline';
import { formatEvent, relTime, unseenCountFiltered, notificationsToFire } from './healthEvents';
import { loadNotifyPrefs, enabledKinds } from './notifyPrefs';
import { toggleBox, setBoxes, groupState } from './fleetSelection';
import { addRecent, parseRecent } from './fleetHistory';
import { createFleetScriptEditor } from './fleetEditor';
import { fleetScripts, isDirty, sortScripts, validateName, type FleetScript } from './fleetScripts';
import { buildFleetScriptRail } from './fleetScriptRail';
import { statusOf } from './http';
import { createFleetPoller } from './fleetPoll';
import { createInteractiveLauncher } from './interactiveLauncher';
import { closeAllModals } from './modalRegistry';
import { openModal, makeRadio } from './dom';
import { armReduce, ARM_MS, IDLE as ARM_IDLE, type ArmState } from './arming';
import { createSetupJobPoller } from './setupPoller';
import logoUrl from './assets/tmuxifier-logo.png';
import { openProxmoxHub } from './proxmoxUi';
import { pve } from './proxmox';
import { nbx } from './netbox';
import { createDashboard } from './dashboard';
import { openSettingsModal } from './settingsUi';
import { createProxmoxAssociationEditor } from './proxmoxAssociation';
import { createSetupOptionsForm, setupStartPayload, type SetupOptionsValues } from './setupOptions';
import { pk, getPasskey, serializeAssertion, hasWebAuthn, evaluateOrigin } from './passkeys';
import { type PaneNode, type Edge, type DropSpec, panesOf, movePane, undockPane, replacePane, setRatio, toggleOrientation, serialize, restore } from './stageLayout';
import { renderStagePanes, applyRatios, focusMove, dropTargets, type PaneHooks, type PaneRect } from './stagePanes';
import { paneHeaderModel, buildPaneHeader, type PaneConn, type PaneHeaderModel } from './paneHeader';
import { buildPaneLifecycle } from './paneLifecycle';

const app = document.getElementById('app')!;
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal>; voiceMount: HTMLElement }>();
const connStates = new Map<string, PaneConn>();
const paneHeaders = new Map<string, (m: PaneHeaderModel) => void>();
// Lifecycle controls live alongside the header updaters and share their
// lifetime: each owns a poll loop and an arm timer, so an orphan would keep
// running after its pane's DOM died. Destroyed in repaintStage and on logout.
const paneLifecycles = new Map<string, ReturnType<typeof buildPaneLifecycle>>();
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';
const GROUP_COLLAPSED_KEY = 'tmuxifier.collapsedTagGroups';
const UNTAGGED_LABEL = 'Untagged';
const UNTAGGED_KEY = '__untagged__';
const STAGE_LAYOUT_KEY = 'tmuxifier.stageLayout';
const MAX_PANES = 4; // gesture-layer cap; the model itself is N-capable
let chordWired = false; // renderDashboard re-runs on re-login; wire document once
// The DnD spec hides the payload until drop, but the drop-zone overlay needs
// the dragged id at dragenter time to gate edge zones by the pane cap.
let dragSourceId: string | null = null;
let stageRoot: PaneNode | null = null;
let focusedBoxId: string | null = null; // the pane typing targets and plain clicks replace
let lastPaneStates = ''; // pollStatus repaints only when a docked box's derived state flips
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
  if (!d) { el.replaceChildren(); el.removeAttribute('title'); el.removeAttribute('aria-label'); return; }
  el.title = `${SPARK_LABEL[metric]} trend — click to switch metric`;
  el.setAttribute('aria-label', `${SPARK_LABEL[metric]} trend — switch metric`);
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
  // role=status implies a polite live region, so insertion announces the toast.
  el.setAttribute('role', 'status');
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
  // Every box-list change flows through here (boot refresh, add/edit/remove/
  // import), so a mounted dashboard tracks it immediately — without this the
  // first paint after login sat on the fresh-install hero until the next
  // 30s status tick delivered the loaded box list.
  if (dashTimer) dash?.update({ boxes: allBoxes, status: latestStatus, series: latestSeries });
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
    : code === 'passkey-only' ? 'This Tmuxifier requires a passkey. Password and Google sign-in are disabled.'
    : 'Sign-in failed. Please try again.';
}

async function renderLogin() {
  let mode: 'password' | 'google' = 'password';
  let passkey = { enrolled: 0, rpId: null as string | null, only: false };
  try {
    const info = await api.authInfo();
    mode = info.mode;
    if (info.passkey) passkey = info.passkey;
  } catch {}
  const err = readLoginError();
  // "No usable passkey" has two triggers, not one: no WebAuthn support, and a
  // mismatched origin (this hostname/protocol doesn't match the configured
  // rpId). evaluateOrigin (passkeys.ts) is the single source of truth for
  // both — the same helper settingsPasskeys.ts uses for the authenticated
  // Settings tab. This screen is unauthenticated, so there is no stored rpId
  // to compare against (that only comes from the authenticated
  // GET /api/passkeys) — pass null, same as "nothing enrolled in this browser".
  const verdict = evaluateOrigin({
    rpId: passkey.rpId, storedRpId: null,
    hostname: location.hostname, protocol: location.protocol, hasWebAuthn: hasWebAuthn(),
  });
  const canPasskey = passkey.enrolled > 0 && verdict.ok;
  const brand = `<div class="login-brand">
        <img class="login-logo" src="${logoUrl}" alt="" />
        <h1>tmuxifier</h1>
        <p>persistent remote terminals for your boxes</p>
      </div>`;
  const passkeyBtn = canPasskey
    ? '<button id="pkbtn" type="button" class="pkbtn">Sign in with a passkey</button>'
    : '';
  // The TMUXIFIER_PASSKEY_ONLY=off break-glass is deliberately NOT documented
  // on this screen: it is pre-authentication and reachable by anyone who can
  // see the login page, and naming the escape hatch there tells a stranger
  // exactly which knob disables the passkey requirement. The operator finds it
  // in Settings -> Passkeys (settingsPasskeys.ts), in README.md, and in
  // docs/DEPLOY.md instead.

  // passkey-only with no usable passkey here would otherwise be a dead end.
  if (passkey.only && !canPasskey) {
    app.innerHTML = `<div class="login">${brand}
        <p id="err" class="err" role="alert">${err || 'This Tmuxifier requires a passkey, and this browser cannot use one.'}</p>
        <p id="pk-reason" class="login-note"></p>
        <p class="login-note">Open Tmuxifier on the device holding your passkey.</p>
      </div>`;
    // verdict.reason/hint carry the server-supplied rpId, so they can never be
    // interpolated into the innerHTML template above (a crafted rpId must not
    // be able to inject markup). Query the empty placeholder and set
    // textContent instead — the same pattern wirePasskeyButton below uses for
    // the error text.
    const reasonEl = app.querySelector('#pk-reason') as HTMLElement | null;
    if (reasonEl) reasonEl.textContent = [verdict.reason, verdict.hint].filter(Boolean).join(' ');
    return;
  }

  if (passkey.only || mode === 'google') {
    const google = passkey.only ? '' : `<a id="gsignin" class="gbtn" href="/api/auth/google/login">
          <svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
            <path fill="#34a853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.8.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#fbbc05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"/>
            <path fill="#ea4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          <span>Sign in with Google</span>
        </a>`;
    app.innerHTML = `<div class="login">${brand}${google}${passkeyBtn}<p id="err" class="err" role="alert">${err}</p></div>`;
    wirePasskeyButton();
    return;
  }

  app.innerHTML = `<form id="login" class="login">${brand}
      <input id="pw" type="password" placeholder="Password" aria-label="Password" autofocus />
      <button>Unlock</button>
      ${passkeyBtn}
      <p id="err" class="err" role="alert">${err}</p>
    </form>`;
  app.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.login((app.querySelector('#pw') as HTMLInputElement).value); renderDashboard(); }
    catch (ex) {
      // The server's error is always a fixed string on this route (e.g.
      // "invalid", "too many attempts", or "passkey required" against a
      // freshly-armed instance whose stale page still shows this form) —
      // never attacker-supplied text — so surfacing it is safe and far more
      // actionable than a blanket "Invalid password". Empty/non-Error
      // rejections still fall back to the old generic message.
      (app.querySelector('#err') as HTMLElement).textContent = (ex as Error)?.message || 'Invalid password';
    }
  });
  wirePasskeyButton();
}

function wirePasskeyButton() {
  const btn = app.querySelector('#pkbtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const errEl = app.querySelector('#err') as HTMLElement;
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const options = await pk.loginBegin();
      const credential = await getPasskey(options);
      await pk.loginFinish(serializeAssertion(credential));
      renderDashboard();
    } catch (e) {
      btn.disabled = false;
      // Every message the two unauthenticated passkey routes
      // (loginBegin/loginFinish) can send back is a fixed server-side string
      // — "too many attempts", "challenge expired — start again", the
      // generic 409 for an rpId mismatch, the domain-name 503 — never
      // attacker-supplied text, so surfacing it via textContent here is
      // safe. NotAllowedError is the browser's own "the user cancelled the
      // prompt" signal and keeps its friendlier text; anything else falls
      // back to the old generic message only when e.message is empty.
      const err = e as Error;
      errEl.textContent = err?.name === 'NotAllowedError' ? 'Passkey sign-in cancelled.' : (err?.message || 'Passkey sign-in failed.');
    }
  });
}

// Probes are multiplexed over each box's persistent SSH master, so polling is
// cheap — but there's no need to hammer. A relaxed interval keeps the dots
// fresh without churning connections.
const POLL_MS = 30000;
let pollInterval: any;
let polling = false;

// After a lifecycle action the server fast-tracks its own probing of that box
// (statusPoller.refreshUntil), but this tab still reads the snapshot on the
// relaxed interval above — so it would sit on a stale answer long after the
// server knew better. Poll faster until this box's pane state actually moves,
// then stop. Bounded: a box that never comes back must not leave a loop running.
let fastStatusTimer: number | null = null;
function stopFastStatusPoll() {
  if (fastStatusTimer != null) { window.clearTimeout(fastStatusTimer); fastStatusTimer = null; }
}
function fastStatusPoll(id: string, everyMs = 3000, timeoutMs = 180000) {
  stopFastStatusPoll();
  const deadline = Date.now() + timeoutMs;
  const before = paneState(id);
  const tick = async () => {
    await pollStatus();
    if (paneState(id) !== before || Date.now() >= deadline) { fastStatusTimer = null; return; }
    fastStatusTimer = window.setTimeout(() => { void tick(); }, everyMs);
  };
  void tick();
}

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
      updatePaneHeaders();
      if (dashTimer) dash?.update({ boxes: allBoxes, status, series: latestSeries });
      // Reconcile pane content with Proxmox/setup state: a box that stopped
      // out from under a live terminal loses it (its pane flips to the stopped
      // panel), a restarted one flips back to a terminal. paneState treats an
      // 'unknown' PVE read as sticky for a stopped pane, so a failed read is
      // never mistaken for a start. One repaint only when a derived state
      // flips, so steady state costs nothing.
      for (const [id] of tabs) {
        if (id !== '__local__' && status[id]?.proxmoxState === 'stopped') {
          closeTab(id, { keepPane: panesOf(stageRoot).includes(id) });
        }
      }
      const paneStates = panesOf(stageRoot).map((id) => `${id}:${paneState(id)}`).join('|');
      if (paneStates !== lastPaneStates) repaintStage();
    } catch {}
    // latestSetups is otherwise refreshed only by refresh() (boot, add/edit/
    // remove/import), so a job finishing while the dashboard sits idle leaves a
    // stale "setting up" pill until the page is reloaded. Re-fetch only while
    // something is actually in flight, so steady state costs no extra request.
    if (latestSetups.some((s) => s.status === 'running')) {
      try {
        latestSetups = await api.listSetups();
        filterAndPaint();
      } catch {}
    }
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
    updatePaneHeaders(); // the agent chip's read arrives with the series
    if (dashTimer) dash?.update({ series: latestSeries });
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
      lastNotifiedSeq = latestSeq; // seed on first poll — a page load never replays history
    } else {
      // notificationsToFire (healthEvents.ts) owns the semantics: fire only from
      // an unfocused, permission-granted tab, and never consume an event the
      // user hasn't seen while focused (so a transition that happened just
      // before you tabbed away still notifies you).
      const { fire, nextCursor } = notificationsToFire({
        events, latestSeq, lastNotifiedSeq, lastSeenSeq: readLastSeenSeq(),
        focused: typeof document !== 'undefined' && document.hasFocus(),
        permissionGranted: typeof Notification !== 'undefined' && Notification.permission === 'granted',
        enabled: enabledKinds(loadNotifyPrefs()),
      });
      // fire is newest-first; walk oldest-first so a shared tag (`kind:boxId`)
      // ends on the newest event, which wins the replacement.
      for (const e of [...fire].reverse()) {
        const line = formatEvent(e);
        try {
          const n = new Notification(`Tmuxifier — ${e.label || e.host}`, { body: line.text, tag: `${e.kind}:${e.boxId}` });
          n.onclick = () => { window.focus(); n.close(); };
        } catch { /* notifications unavailable */ }
      }
      lastNotifiedSeq = nextCursor;
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

// The stage's resting state: the standby dashboard (dashboard.ts) — service
// tiles, fleet overview, and infra readouts on the screen-well glass, painted
// by repaintStage whenever no pane is docked. One instance survives across
// mounts so poll ticks update it in place; its services/infra polls run only
// while it is actually mounted (dashTimer is the mounted signal).
let dash: ReturnType<typeof createDashboard> | null = null;
let dashTimer: ReturnType<typeof setInterval> | null = null;
let dashTick = 0;

function ensureDash() {
  if (!dash) {
    dash = createDashboard({
      onOpenBox: (id) => openPane(id),
      onAddBox: () => openBoxDialog(),
      onAddService: () => openSettingsModal('services'),
    });
  }
  return dash;
}

function startDashPolling() {
  if (dashTimer) return;
  dashTick = 0;
  const tick = async () => {
    try {
      const [services, snap] = await Promise.all([api.services(), api.servicesStatus()]);
      dash?.update({ services, serviceStatus: snap });
    } catch { dash?.update({ serviceStatus: null }); } // stale marker; last tiles stay painted
    if (dashTick % 6 === 0) { // infra readout every 60s
      try { dash?.update({ netbox: await nbx.summary() }); } catch {}
      try {
        const hosts = await pve.hosts();
        if (!hosts.length) {
          dash?.update({ containers: null, nodes: null });
        } else {
          // Independent fetches: node health still paints when the container
          // rollup fails, and vice versa (the paint falls back per side).
          const [ctr, nds] = await Promise.allSettled([pve.linkedContainers(), pve.clusterNodes()]);
          dash?.update({
            containers: ctr.status === 'fulfilled' ? ctr.value : null,
            nodes: nds.status === 'fulfilled' ? nds.value : null,
          });
        }
      } catch {}
    }
    dashTick++;
  };
  void tick();
  dashTimer = setInterval(tick, 10000);
}

function stopDashPolling() {
  if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
}

function teardownDash() {
  stopDashPolling();
  dash?.destroy();
  dash = null;
}

// --- Stage panes: the layout model drives what the stage shows -------------
// Terminals are created into the hidden parking div and MOVED into panes by
// the renderer; undocked tabs return to parking. Parking is display:none —
// the same keep-alive contract as the old display:none tab toggling.

function persistStage() {
  localStorage.setItem(STAGE_LAYOUT_KEY, serialize(stageRoot, focusedBoxId));
}

function stageGrid(): HTMLElement { return app.querySelector('.stage-grid') as HTMLElement; }
function stageParking(): HTMLElement { return app.querySelector('.stage-parking') as HTMLElement; }

function ensureTab(id: string) {
  if (tabs.has(id)) return;
  const el = document.createElement('div');
  el.className = 'term';
  stageParking().appendChild(el);
  const box = allBoxes.find((b) => b.id === id);
  // The voice button mounts into this slot, which the pane header adopts on
  // every repaint — the button (and an in-flight recording) survives header
  // rebuilds because the slot element persists with the tab, not the header.
  const voiceMount = document.createElement('span');
  voiceMount.className = 'pane-voice-slot';
  const term = openTerminal(el, id, id === '__local__' ? 'local shell' : box?.label, {
    voiceMount,
    onConnState: (s) => { connStates.set(id, s); updatePaneHeaders(); },
  });
  tabs.set(id, { el, term, voiceMount });
  if (id === '__local__') updateLocalDot();
}

// Content states a pane can show instead of a terminal. 'unknown' PVE state is
// sticky for a pane already showing its stopped panel — a failed/stale PVE read
// must never be read as "the container started" (see pollStatus).
const stoppedShown = new Set<string>();

function paneState(id: string): 'terminal' | 'stopped' | 'setup' {
  if (id === '__local__') return 'terminal';
  const pveState = latestStatus[id]?.proxmoxState;
  if (pveState === 'stopped') return 'stopped';
  if (pveState === 'unknown' && stoppedShown.has(id)) return 'stopped';
  if (blocksTerminal(latestSetups.find((s) => s.boxId === id)?.status)) return 'setup';
  return 'terminal';
}

const settingUpPollers = new Map<string, { start: () => void; stop: () => void }>();

function clearSettingUpPanel(id: string) {
  settingUpPollers.get(id)?.stop();
  settingUpPollers.delete(id);
}

function paneContentFor(id: string): HTMLElement {
  const state = paneState(id);
  const box = allBoxes.find((b) => b.id === id);
  stoppedShown.delete(id);
  if (state === 'stopped' && box) {
    closeTab(id, { keepPane: true });
    stoppedShown.add(id);
    return buildStoppedPanel(box);
  }
  if (state === 'setup' && box) {
    closeTab(id, { keepPane: true });
    return buildSettingUpPanel(box);
  }
  ensureTab(id);
  return tabs.get(id)!.el;
}

function paneHeaderModelFor(id: string): PaneHeaderModel {
  const box = allBoxes.find((b) => b.id === id);
  // Latest health sample carries the agent read (see the spec: the series
  // already ships it; the bar is its first client consumer).
  const series = latestSeries[id];
  return paneHeaderModel({
    local: id === '__local__',
    label: id === '__local__' ? 'Host Shell' : box?.label ?? id,
    user: box?.user,
    host: box?.host,
    status: latestStatus[id],
    agent: series?.[series.length - 1]?.agent,
    conn: connStates.get(id),
    state: paneState(id),
  });
}

function updatePaneHeaders() {
  for (const [id, update] of paneHeaders) update(paneHeaderModelFor(id));
  for (const [id, ctl] of paneLifecycles) ctl.update({ paneState: paneState(id), pveState: latestStatus[id]?.proxmoxState });
}

function paneHooks(): PaneHooks {
  return {
    contentFor: (id) => paneContentFor(id),
    headerFor: (id, split) => {
      const model = paneHeaderModelFor(id);
      const terminalPane = paneState(id) === 'terminal';
      const built = buildPaneHeader(model, {
        // Stopped/setting-up panes keep the identity half only — their panels
        // own the actions (spec). Undock stays: a non-terminal pane must
        // remain removable from a split. The refresh aria-label deliberately
        // differs from the sidebar row's `Reconnect ${label}` — an identical
        // accessible name would trip Playwright strict mode.
        ...(terminalPane ? { wantRefresh: true } : {}),
        ...(split ? { onUndock: () => undockBox(id), undockLabel: `Undock ${model.title}` } : {}),
      });
      // The header's Reconnect cap gets the same two-click guard as the sidebar
      // rows. Keyed per pane, so arming one pane's cap does not arm another's.
      if (built.refreshBtn) {
        wireReconnectButton(built.refreshBtn, `pane:${id}`, `${model.title} terminal`, async () => {
          if (id === '__local__') await api.reconnectLocalShell();
          else await api.reconnectBox(id);
          closeTab(id, { keepPane: true });
          repaintStage();
        });
      }
      if (terminalPane) {
        ensureTab(id);
        built.voiceSlot.append(tabs.get(id)!.voiceMount);
      }
      paneHeaders.set(id, built.update);
      // Proxmox-linked boxes only: the local shell has no container, and an
      // unlinked box has nothing for these keys to act on.
      const linked = allBoxes.find((b) => b.id === id)?.proxmox;
      if (id !== '__local__' && linked) {
        const ctl = buildPaneLifecycle({
          boxId: id,
          onOpenJobLog: (jobId) => openProxmoxHub({
            openBox,
            openEditBox: (boxId) => { const target = allBoxes.find((item) => item.id === boxId); if (target) openBoxDialog(target); },
            onBoxLinked: () => { void refresh(); },
          }, jobId ? { lifecycleJobId: jobId } : { tab: 'Containers', focusBoxId: id }),
          onSettled: () => { fastStatusPoll(id); },
        });
        ctl.update({ paneState: paneState(id), pveState: latestStatus[id]?.proxmoxState });
        built.lifecycleSlot.append(ctl.el);
        paneLifecycles.set(id, ctl);
      }
      return built.el;
    },
    onFocus: (id) => { if (focusedBoxId !== id) { focusedBoxId = id; syncPaneFocus(); persistStage(); } },
    onRatio: (path, divider, firstShare, phase) => {
      stageRoot = setRatio(stageRoot, path, divider, firstShare);
      if (stageRoot != null) applyRatios(stageGrid(), stageRoot);
      if (phase === 'commit') { refitActiveTerminals(); persistStage(); }
      else requestAnimationFrame(refitActiveTerminals);
    },
    onToggleOrientation: (path) => { stageRoot = toggleOrientation(stageRoot, path); repaintStage(); },
  };
}

// Focus paint without a full re-render (a re-render moves terminal DOM).
function syncPaneFocus() {
  const split = panesOf(stageRoot).length > 1;
  stageGrid().querySelectorAll<HTMLElement>('.stage-pane').forEach((p) => {
    p.classList.toggle('focused', split && p.dataset.paneId === focusedBoxId);
  });
  highlightStage();
}

function destroyPaneLifecycles() {
  for (const [, ctl] of paneLifecycles) ctl.destroy();
  paneLifecycles.clear();
}

function repaintStage() {
  paneHeaders.clear(); // stale update closures die with their DOM; headerFor re-registers survivors
  destroyPaneLifecycles(); // their pollers and arm timers would outlive the DOM otherwise
  const grid = stageGrid();
  // Panels that lost their pane (or whose box left setup) must stop polling.
  for (const [id] of settingUpPollers) {
    if (!panesOf(stageRoot).includes(id) || paneState(id) !== 'setup') clearSettingUpPanel(id);
  }
  for (const id of [...stoppedShown]) {
    if (!panesOf(stageRoot).includes(id)) stoppedShown.delete(id);
  }
  // Park every tab first so replaceChildren() can't orphan a live terminal.
  for (const t of tabs.values()) stageParking().appendChild(t.el);
  if (stageRoot == null) {
    grid.replaceChildren();
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    const d = ensureDash();
    grid.append(d.el);
    d.update({ boxes: allBoxes, status: latestStatus, series: latestSeries });
    startDashPolling();
  } else {
    stopDashPolling();
    renderStagePanes(grid, stageRoot, focusedBoxId, paneHooks());
  }
  lastPaneStates = panesOf(stageRoot).map((id) => `${id}:${paneState(id)}`).join('|');
  refitActiveTerminals();
  highlightStage();
  persistStage();
  if (focusedBoxId) tabs.get(focusedBoxId)?.term.focus();
  filterAndPaint(); // dock-button visibility and row highlights track the layout
}

function dockBox(id: string, drop: DropSpec) {
  stageRoot = movePane(stageRoot, id, drop);
  focusedBoxId = id;
  repaintStage();
}

function undockBox(id: string) {
  stageRoot = undockPane(stageRoot, id);
  if (focusedBoxId === id) focusedBoxId = panesOf(stageRoot)[0] ?? null;
  repaintStage();
}

async function renderDashboard() {
  if (pollInterval) clearInterval(pollInterval);
  const sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  app.innerHTML = `<div class="layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}">
      <aside class="sidebar">
        <h1 class="sr-only">tmuxifier</h1>
        <div class="brand">
          <button id="home" class="brand-home" type="button" title="Standby dashboard" aria-label="Standby dashboard"><img src="${logoUrl}" alt="" /><span class="brand-name">tmuxifier</span></button>
          <div class="brand-actions">
            <button id="sidebar-toggle" class="sidebar-toggle" type="button" title="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-expanded="${sidebarCollapsed ? 'false' : 'true'}">${sidebarCollapsed ? '›' : '‹'}</button>
            <button id="settings" type="button" title="Settings" aria-label="Settings">⚙</button>
            <button id="logout" title="Log out" aria-label="Log out">⎋</button>
          </div>
        </div>
        <div class="actions"><button id="add">+ Add box</button></div>
        <div class="fleet-actions"><button id="fleet-toggle" type="button" class="fleet-toggle">Fleet Command</button><button id="fleet-jobs" type="button" class="fleet-jobs-btn" title="Fleet job history">Fleet Jobs</button><button id="proxmox" type="button" class="proxmox-btn" title="Provision Proxmox LXC containers" hidden>Proxmox</button><button id="events" type="button" class="events-btn" title="Box health events (down/up/needs login/thresholds)">Events<span id="events-badge" class="events-badge" hidden></span></button></div>
        <div id="fleet-bar" class="fleet-bar" hidden></div>
        <input id="search" class="search" type="text" placeholder="Search…" aria-label="Search boxes" autocomplete="off" />
        <ul id="boxes" class="boxes"></ul>
        <div class="local-shell">
          <span class="local-dot"></span>
          <button class="local-name" type="button">Host Shell</button>
          <button class="local-refresh" title="Reconnect" aria-label="Reconnect host shell">↻</button>
          <button class="local-edit" title="Configure shell" aria-label="Configure host shell">✎</button>
        </div>
      </aside>
      <main id="stage" class="stage"><div class="stage-grid"></div><div class="stage-parking"></div></main>
    </div>`;
  // Capture the persisted layout BEFORE the first repaint: repaintStage
  // persists on every call, so painting the initial empty stage would
  // otherwise clobber the saved split before restore ever reads it.
  const savedStage = localStorage.getItem(STAGE_LAYOUT_KEY);
  repaintStage();
  app.querySelector('#logout')!.addEventListener('click', async () => {
    teardownWorkspace();
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
  app.querySelector('#add')!.addEventListener('click', () => openBoxDialog());
  // The nameplate is the home key: back to the standby dashboard. Docked
  // terminals undock into parking — still connected, one click re-docks —
  // via the same repaint path as undocking each pane by hand.
  app.querySelector('#home')!.addEventListener('click', () => {
    if (stageRoot == null) return; // already home
    stageRoot = null;
    focusedBoxId = null;
    repaintStage();
  });
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

  // Local shell — name click opens terminal; the row also drags like a box row
  app.querySelector('.local-name')!.addEventListener('click', () => openLocalShell());
  const localRow = app.querySelector('.local-shell') as HTMLElement;
  localRow.draggable = true;
  localRow.addEventListener('dragstart', (e) => {
    dragSourceId = '__local__';
    e.dataTransfer?.setData('text/x-tmuxifier-box', '__local__');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  localRow.addEventListener('dragend', () => {
    dragSourceId = null;
    app.querySelector('#stage')?.classList.remove('dragging');
  });

  // Drag-to-dock: drop zones over the stage while a box row is in flight.
  {
    const stage = app.querySelector('#stage') as HTMLElement;
    const zones = document.createElement('div');
    zones.className = 'drop-zones';
    stage.append(zones);
    // The one visible drag indicator: previews the hovered zone's landing
    // area (half the stage / half the pane / the whole pane). The zones
    // themselves are invisible hit targets — painting them all at once made
    // a 3-pane stage unreadable.
    const preview = document.createElement('div');
    preview.className = 'drop-preview';
    stage.append(preview);

    type Band = { left: number; top: number; width: number; height: number };
    const bandOf = (r: Band, edge: string): Band =>
      edge === 'left' ? { ...r, width: r.width / 2 }
      : edge === 'right' ? { ...r, left: r.left + r.width / 2, width: r.width / 2 }
      : edge === 'top' ? { ...r, height: r.height / 2 }
      : { ...r, top: r.top + r.height / 2, height: r.height / 2 };

    const showPreview = (zone: HTMLElement | null) => {
      if (!zone) { preview.style.display = 'none'; return; }
      const host = stage.getBoundingClientRect();
      let rect: Band | null = null;
      if (zone.dataset.kind === 'stage-edge') {
        rect = bandOf({ left: 0, top: 0, width: host.width, height: host.height }, zone.dataset.edge!);
      } else {
        const paneEl = stageGrid().querySelector(`.stage-pane[data-pane-id='${zone.dataset.paneId}']`);
        if (!paneEl) { preview.style.display = 'none'; return; }
        const r = paneEl.getBoundingClientRect();
        const rel: Band = { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
        rect = zone.dataset.kind === 'pane-edge' ? bandOf(rel, zone.dataset.edge!) : rel;
      }
      preview.style.left = `${rect.left}px`;
      preview.style.top = `${rect.top}px`;
      preview.style.width = `${rect.width}px`;
      preview.style.height = `${rect.height}px`;
      preview.style.display = 'block';
    };

    const buildZones = (draggedId: string) => {
      zones.replaceChildren();
      const host = stage.getBoundingClientRect();
      const paneRect = (paneId: string) =>
        stageGrid().querySelector<HTMLElement>(`.stage-pane[data-pane-id='${paneId}']`)?.getBoundingClientRect();
      for (const t of dropTargets(stageRoot, draggedId, MAX_PANES)) {
        const z = document.createElement('div');
        if (t.kind === 'stage-edge') {
          z.className = `drop-zone drop-zone-${t.edge}`;
          z.dataset.kind = 'stage-edge';
          z.dataset.edge = t.edge;
        } else {
          const rect = paneRect(t.paneId);
          if (!rect) continue;
          const rel = { left: rect.left - host.left, top: rect.top - host.top };
          if (t.kind === 'pane-edge') {
            z.className = 'drop-zone drop-zone-pane-edge';
            z.dataset.kind = 'pane-edge';
            z.dataset.edge = t.edge;
            z.dataset.paneId = t.paneId;
            // Edge strips: outer 26% of the pane on that side, inset 8px from
            // the stage rim so stage-edge zones keep a clean claim on the rim.
            const d = 0.26;
            if (t.edge === 'left' || t.edge === 'right') {
              z.style.top = `${rel.top + 8}px`; z.style.height = `${rect.height - 16}px`;
              z.style.width = `${rect.width * d}px`;
              z.style.left = t.edge === 'left' ? `${rel.left + 8}px` : `${rel.left + rect.width * (1 - d) - 8}px`;
            } else {
              z.style.left = `${rel.left + 8}px`; z.style.width = `${rect.width - 16}px`;
              z.style.height = `${rect.height * d}px`;
              z.style.top = t.edge === 'top' ? `${rel.top + 8}px` : `${rel.top + rect.height * (1 - d) - 8}px`;
            }
          } else {
            z.className = 'drop-zone drop-zone-replace';
            z.dataset.kind = 'replace';
            z.dataset.paneId = t.paneId;
            z.style.left = `${rel.left + rect.width * 0.34}px`;
            z.style.width = `${rect.width * 0.32}px`;
            z.style.top = `${rel.top + rect.height * 0.34}px`;
            z.style.height = `${rect.height * 0.32}px`;
          }
        }
        zones.append(z);
      }
    };

    stage.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-tmuxifier-box')) return;
      // Cancelling dragenter is what makes the hovered element the drop
      // target; without it dragover/drop fire elsewhere and never reach us.
      e.preventDefault();
      stage.classList.add('dragging');
      // Build once per drag: dragenter bubbles here from every zone, and
      // rebuilding would replace the element the browser just accepted as
      // the drop target — a removed node can never receive the drop.
      if (!zones.childElementCount) buildZones(dragSourceId ?? '');
    });
    document.addEventListener('dragend', () => {
      stage.classList.remove('dragging');
      zones.replaceChildren(); // next drag rebuilds against the then-current layout
      preview.style.display = 'none';
    });
    stage.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-tmuxifier-box')) return;
      e.preventDefault(); // required, or the browser refuses the drop
      showPreview(document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-zone') as HTMLElement | null);
    });
    stage.addEventListener('dragleave', (e) => {
      if (e.target === stage) { stage.classList.remove('dragging'); preview.style.display = 'none'; }
    });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      // Resolve the zone before clearing .dragging — removing the class hides
      // the overlay (display: none), after which elementFromPoint can't see it.
      const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-zone') as HTMLElement | null;
      stage.classList.remove('dragging');
      const id = e.dataTransfer?.getData('text/x-tmuxifier-box');
      if (!id) return;
      if (!zone) return;
      // Clear drag state HERE: a successful dock repaints the sidebar,
      // destroying the drag's source row, so its dragend never fires —
      // trusting dragend is exactly the stale-zone cap-bypass bug (v1.16.0).
      zones.replaceChildren();
      dragSourceId = null;
      preview.style.display = 'none';
      const kind = zone?.dataset.kind;
      if (kind === 'stage-edge') {
        dockBox(id, { kind: 'stage-edge', edge: zone!.dataset.edge as Edge });
      } else if (kind === 'pane-edge') {
        dockBox(id, { kind: 'pane-edge', paneId: zone!.dataset.paneId!, edge: zone!.dataset.edge as Edge });
      } else if (kind === 'replace') {
        const target = zone!.dataset.paneId!;
        if (target !== id) {
          stageRoot = replacePane(stageRoot, target, id);
          focusedBoxId = id;
          repaintStage();
        }
      }
    });
  }

  // Local shell — refresh (keeps the pane; repaint rebuilds the terminal in
  // place). Armed like the box rows: this one kills the tmux session on the
  // Tmuxifier host itself.
  wireReconnectButton(
    app.querySelector('.local-refresh') as HTMLButtonElement,
    'local', 'host shell',
    async () => {
      await api.reconnectLocalShell();
      const wasDocked = panesOf(stageRoot).includes('__local__');
      closeTab('__local__', { keepPane: wasDocked });
      if (wasDocked) repaintStage();
    },
  );

  // Local shell — edit
  app.querySelector('.local-edit')!.addEventListener('click', (e) => {
    e.stopPropagation();
    openLocalShellEditModal();
  });

  // Pane-focus chord. Captured at the document level and swallowed whole —
  // the same pattern as the voice hotkey — because plain Ctrl+Arrow belongs
  // to the shell (word-jump) and must keep reaching the pane.
  if (!chordWired) {
    chordWired = true;
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey) || panesOf(stageRoot).length < 2) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const rects: PaneRect[] = [...stageGrid().querySelectorAll<HTMLElement>('.stage-pane')].map((p) => {
        const r = p.getBoundingClientRect();
        return { id: p.dataset.paneId!, x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const target = focusMove(rects, focusedBoxId, e.key);
      if (target) {
        focusedBoxId = target;
        syncPaneFocus();
        persistStage();
        tabs.get(target)?.term.focus();
      }
    }, true);
  }

  syncSparkMetricClass();
  await refresh();
  // Restore the persisted stage layout now that the box list exists for
  // pruning (a vanished box drops out; 0 panes left = the empty stage).
  const restored = restore(savedStage, [...allBoxes.map((b) => b.id), '__local__']);
  if (restored.root != null) {
    stageRoot = restored.root;
    focusedBoxId = restored.focusedId;
    repaintStage();
  }
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

// --- Reconnect arming ------------------------------------------------------
// Reconnect kills the box's tmux session and rebuilds the connection. That is
// deliberate — it is how you get a fresh session when a shell or config is
// wedged — but it also destroys whatever was running in the old one, so it asks
// twice. Same policy as the pane-header lifecycle keys (arming.ts).
//
// The armed id lives HERE, at module scope, rather than in each button's
// closure: a sidebar row is rebuilt on search input, on add/edit/remove/import,
// on dock/undock, and every 30s while a setup job is running, so a closure-held
// flag would silently disarm mid-interaction. (Routine status polls update rows
// in place and are safe; the rebuild paths are not.)
let armedReconnect: string | null = null;
let armedReconnectTimer: number | null = null;
type ReconnectBtn = { btn: HTMLButtonElement; id: string; label: string };
const reconnectBtns = new Set<ReconnectBtn>();

function paintReconnectBtn(entry: ReconnectBtn): void {
  const armed = armedReconnect === entry.id;
  entry.btn.textContent = armed ? '⚠' : '↻';
  entry.btn.classList.toggle('armed', armed);
  entry.btn.title = armed
    ? 'Click again to kill the tmux session and reconnect'
    : 'Reconnect — kills the tmux session and starts a fresh one';
  entry.btn.setAttribute('aria-label', armed
    ? `Confirm reconnect ${entry.label} — this kills the tmux session`
    : `Reconnect ${entry.label}`);
}

function paintAllReconnectBtns(): void {
  for (const entry of [...reconnectBtns]) {
    // Drop buttons whose row or header has since been rebuilt, so the set does
    // not grow for the life of the page.
    if (!entry.btn.isConnected) { reconnectBtns.delete(entry); continue; }
    paintReconnectBtn(entry);
  }
}

function disarmReconnect(): void {
  if (armedReconnectTimer != null) { window.clearTimeout(armedReconnectTimer); armedReconnectTimer = null; }
  if (armedReconnect == null) return;
  armedReconnect = null;
  paintAllReconnectBtns();
}

// A click anywhere else disarms — the "anything else" half of arm-then-fire.
// Capture phase, so it lands before the row's own click handlers. A mousedown on
// any registered Reconnect button is NOT "anywhere else": it either confirms
// that button or moves the arm to it, both handled by the click below.
document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  for (const entry of reconnectBtns) if (entry.btn.contains(target)) return;
  disarmReconnect();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarmReconnect(); }, true);

// `fire` runs only on the confirming click.
function wireReconnectButton(btn: HTMLButtonElement, id: string, label: string, fire: () => void | Promise<void>): void {
  const entry: ReconnectBtn = { btn, id, label };
  reconnectBtns.add(entry);
  paintReconnectBtn(entry);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const state: ArmState = { armed: armedReconnect };
    const outcome = armReduce(state, { type: 'click', id, armable: true });
    if (armedReconnectTimer != null) { window.clearTimeout(armedReconnectTimer); armedReconnectTimer = null; }
    armedReconnect = outcome.state.armed;
    paintAllReconnectBtns();
    if (outcome.fire) { void fire(); return; }
    armedReconnectTimer = window.setTimeout(() => {
      armedReconnectTimer = null;
      armedReconnect = armReduce({ armed: armedReconnect }, { type: 'timeout' }).state.armed;
      paintAllReconnectBtns();
    }, ARM_MS);
    // The armed button is the one that was just clicked, so it still holds
    // focus — a keyboard user confirms with a second Enter without moving.
    btn.focus();
  });
}

function createBoxRow(b: Box, status: Record<string, Status>): HTMLElement {
  const st = status[b.id];

  const li = document.createElement('li');
  li.className = 'box';
  if (b.id === focusedBoxId) li.classList.add('active');
  else if (panesOf(stageRoot).includes(b.id)) li.classList.add('docked');
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
  // A real button so the row is keyboard-operable: its native activation click
  // bubbles to the li's click handler below — one handler, no double-fire.
  const nameEl = document.createElement('button');
  nameEl.type = 'button';
  nameEl.className = 'name';
  nameEl.setAttribute('aria-label', `Open terminal — ${b.label}`);
  nameEl.textContent = b.label;
  const badgesEl = document.createElement('span');
  badgesEl.className = 'box-badges';
  // latestSetups is newest-first (the manager's ordered()), so the first match
  // for this box is its current setup job. Rendered as part of every row build
  // (both the sync and async-status repaints in refresh()) so a badge can never
  // be wiped by a later repaint racing a post-hoc DOM patch.
  const setup = latestSetups.find((s) => s.boxId === b.id);
  const badge = setup ? setupBadge(setup.status, setup.needs) : null;
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = `badge ${badge.cls}`;
    badgeEl.textContent = badge.text;
    badgesEl.append(badgeEl);
  }
  const metaEl = document.createElement('span');
  metaEl.className = 'box-meta';
  // A real button (sibling of the name button, so valid HTML): native keyboard
  // activation fires the same click handler; stopPropagation keeps the row's
  // open-terminal handler out of it, exactly as for mouse clicks.
  const sparkEl = document.createElement('button');
  sparkEl.type = 'button';
  sparkEl.className = 'spark';
  sparkEl.addEventListener('click', (e) => { e.stopPropagation(); cycleSparkMetric(); });
  mainEl.append(nameEl, badgesEl, metaEl, sparkEl);

  li.addEventListener('click', () => openBox(b));

  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    dragSourceId = b.id;
    e.dataTransfer?.setData('text/x-tmuxifier-box', b.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    dragSourceId = null;
    app.querySelector('#stage')?.classList.remove('dragging');
  });

  // Keyboard-path equivalent of dragging onto the trailing edge: visible only
  // when exactly one *other* pane is on stage and the cap allows a second.
  const dock = document.createElement('button');
  dock.className = 'dock';
  dock.title = 'Dock beside current terminal';
  dock.setAttribute('aria-label', `Dock ${b.label} beside current terminal`);
  dock.textContent = '◫';
  dock.hidden = !(panesOf(stageRoot).length >= 1 && panesOf(stageRoot).length < MAX_PANES && !panesOf(stageRoot).includes(b.id));
  dock.addEventListener('click', (e) => {
    e.stopPropagation();
    dockBox(b.id, { kind: 'stage-edge', edge: 'right' });
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'refresh';
  // Title/label/glyph and the two-click guard are owned by wireReconnectButton.
  wireReconnectButton(refreshBtn, `box:${b.id}`, b.label, async () => {
    await api.reconnectBox(b.id);
    const wasDocked = panesOf(stageRoot).includes(b.id);
    closeTab(b.id, { keepPane: wasDocked });
    if (wasDocked) repaintStage(); // rebuilds the terminal in its pane
  });

  const forgetKeyBtn = document.createElement('button');
  forgetKeyBtn.className = 'forget-key';
  forgetKeyBtn.title = 'Forget old host key — only if this box was legitimately rebuilt (removes its known_hosts entry, then reconnects)';
  forgetKeyBtn.setAttribute('aria-label', `Forget old host key for ${b.label}`);
  forgetKeyBtn.textContent = '⚷';
  forgetKeyBtn.style.display = 'none';
  forgetKeyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Forget the stored host key for ${b.label}? Only do this if the box was legitimately rebuilt.`)) return;
    await api.forgetHostKey(b.id);
    const wasDocked = panesOf(stageRoot).includes(b.id);
    closeTab(b.id, { keepPane: wasDocked });
    if (wasDocked) repaintStage();
  });

  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.title = 'Edit';
  edit.setAttribute('aria-label', `Edit ${b.label}`);
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openBoxDialog(b);
  });

  const rm = document.createElement('button');
  rm.className = 'rm';
  rm.title = 'Remove';
  rm.setAttribute('aria-label', `Remove ${b.label}`);
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
  actions.append(dock, forgetKeyBtn, refreshBtn, edit, rm);

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
    const containsActive = !!focusedBoxId && group.boxes.some(b => b.id === focusedBoxId);

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
  // Empty states: a fresh install (no boxes at all) points at + Add box; a
  // search that filtered everything out says so instead of a silent void.
  if (!boxes.length) {
    const li = document.createElement('li');
    li.className = 'boxes-empty';
    if (searching) {
      li.textContent = `No boxes match “${searchTerm}”.`;
    } else {
      const kbd = document.createElement('span');
      kbd.className = 'empty-kbd';
      kbd.textContent = '+ Add box';
      li.append('No boxes yet — ', kbd, ' connects your first.');
    }
    list.appendChild(li);
  }
  if (fleetMode) syncFleetUI();
}

function openLocalShell() { openPane('__local__'); }

function updateLocalDot() {
  const dot = app.querySelector('.local-dot');
  if (dot) dot.classList.toggle('green', tabs.has('__local__'));
}

// Sidebar highlight derived from the layout: docked = on stage (dimmed
// beacon); active = the focused pane (full beacon). One derivation shared by
// every repaint so highlight state never drifts.
function highlightStage() {
  app.querySelectorAll('.box').forEach((element) => {
    const row = element as HTMLElement;
    const id = row.dataset.id ?? '';
    row.classList.toggle('docked', panesOf(stageRoot).includes(id) && id !== focusedBoxId);
    row.classList.toggle('active', id === focusedBoxId);
  });
  app.querySelectorAll('.box-group').forEach((element) => {
    const group = element as HTMLElement;
    group.classList.toggle('active-child', !!focusedBoxId && !!group.querySelector(`.box[data-id="${CSS.escape(focusedBoxId)}"]`));
  });
  const ls = app.querySelector('.local-shell');
  if (ls) {
    ls.classList.toggle('docked', panesOf(stageRoot).includes('__local__') && focusedBoxId !== '__local__');
    ls.classList.toggle('active', focusedBoxId === '__local__');
  }
}

// Pane panel shown instead of a terminal while a box's setup job is running.
// Live: it polls the job, renders its status and log, and hands the pane back
// to a terminal (via repaintStage's state re-resolution) once the job settles.
function buildSettingUpPanel(box: Box): HTMLElement {
  clearSettingUpPanel(box.id);
  const panel = document.createElement('div');
  panel.className = 'setting-up-state';
  const title = document.createElement('strong');
  title.textContent = `${box.label} is being set up`;
  const detail = document.createElement('span');
  detail.setAttribute('aria-live', 'polite');
  detail.textContent = 'Checking…';
  const log = document.createElement('pre');
  log.className = 'provision-log';
  panel.append(title, detail, log);

  const poller = createSetupJobPoller<SetupJob>({
    fetchJob: () => api.getBoxSetup(box.id),
    onJob: (job) => {
      if (!job) return 1500; // not discovered yet / transient fetch error
      detail.textContent = setupStatusText(job);
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      if (blocksTerminal(job.status)) return 1000;
      // Job settled: refresh the sidebar's pill, then let the pane re-resolve
      // to a terminal. The fresh job state beats the cached latestSetups list,
      // so clear the poller first or the repaint would rebuild this panel.
      clearSettingUpPanel(box.id);
      void refresh();
      repaintStage();
      return null;
    },
  });
  settingUpPollers.set(box.id, poller);
  poller.start();
  return panel;
}

// A Proxmox-linked box confirmed stopped has no reachable tmux, so instead of
// a dead terminal its pane shows a static panel with the container's identity
// and a shortcut into the Proxmox Containers tab (Start / Deprovision live there).
function buildStoppedPanel(box: Box): HTMLElement {
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
  return panel;
}

function openBox(b: Box) { openPane(b.id); }

// Plain activation (sidebar click): focus the pane if already docked, replace
// the focused pane in a split, or become the single pane otherwise — the
// confirmed "C replaces the focused pane" semantics.
function openPane(id: string) {
  if (panesOf(stageRoot).includes(id)) {
    focusedBoxId = id;
    syncPaneFocus();
    persistStage();
    tabs.get(id)?.term.focus();
    return;
  }
  const panes = panesOf(stageRoot);
  stageRoot = panes.length === 0
    ? id
    : replacePane(stageRoot, panes.length <= 1 || !focusedBoxId ? panes[0] : focusedBoxId, id);
  focusedBoxId = id;
  repaintStage();
}

// keepPane tears down the terminal but leaves the pane in the layout — used
// when the pane is about to show a stopped/setting-up panel, or when a
// reconnect will immediately rebuild the terminal in place.
function closeTab(id: string, opts?: { keepPane?: boolean }) {
  const t = tabs.get(id);
  if (t) { t.term.dispose(); t.el.remove(); tabs.delete(id); connStates.delete(id); }
  if (id === '__local__') updateLocalDot();
  if (!opts?.keepPane && panesOf(stageRoot).includes(id)) undockBox(id);
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
  err.setAttribute('role', 'alert');
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
function openProvisionPanel(box: Box, options: SetupOptionsValues) {
  const panel = document.getElementById('provision-panel')!;
  const title = panel.querySelector('.provision-title')!;
  const status = panel.querySelector('.provision-status')!;
  const container = panel.querySelector('.provision-term') as HTMLElement;
  const closeBtn = panel.querySelector('.provision-close') as HTMLElement;

  // Tear down any previous run first (pending poll timer / auto-close, live interactive WS).
  closeProvisionPanel();

  title.textContent = `Setup — ${box.label}`;
  status.textContent = '';
  status.className = 'provision-status';
  container.innerHTML = '';
  panel.classList.add('open');

  // Every option the form collected rides along to the server: seedAiAuth is
  // what makes the setup job seed itself on completion, claudeStatusline what
  // makes it push the statusline, so a field named here but not forwarded
  // silently disables that feature. Hence the shared spread rather than a
  // hand-written list — the list predated the statusline checkbox and was
  // never extended, so that option never once reached the server from here.
  const opts = setupStartPayload(options);
  const log = document.createElement('pre');
  log.className = 'provision-log';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  container.append(log, actions);

  let currentJobId: string | null = null;
  let autoCloseTimer: number | undefined;
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
        // The seed already ran server-side, before this status flip — so the
        // outcome is here on the first (and only) 'done' this poller sees.
        // Nothing to request, nothing to race, nothing to guard.
        const seedTxt = formatSeedResults(job.seed);
        if (seedTxt) status.textContent = `${status.textContent} · auth: ${seedTxt}`;
        const slTxt = formatStatuslineResult(job.statusline);
        if (slTxt) status.textContent = `${status.textContent} · ${slTxt}`;
        // An outcome deserves longer on screen than a bare success.
        autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), (seedTxt || slTxt) ? 5000 : 2000);
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
  sessionRefresh.setAttribute('aria-label', 'Fetch live tmux sessions from the host');
  sessionRefresh.textContent = '⟳';
  // Known sessions show as clickable chips that fill the field on click; the
  // field itself stays free-text so you can also type a brand-new session name.
  const sessionPicker = document.createElement('div');
  sessionPicker.className = 'session-picker';
  const sessionHint = document.createElement('span');
  sessionHint.className = 'session-hint';
  sessionHint.setAttribute('aria-live', 'polite');
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

  // Shared setup-options component (Terminal / Tools / AI auth seeding).
  // Edit mode defaults Oh My Tmux off — the box already went through setup.
  const setupForm = createSetupOptionsForm({ ohMyTmux: !isEdit });

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
  err.setAttribute('role', 'alert');
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

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';
  modalBody.append(
    fieldGrid,
    tagDatalist,
    sessionWrap,
    setupForm.element,
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
        const so = setupForm.values();
        if (so.ohMyTmux || so.ohMyZsh || so.ohMyBash || so.tools.length || so.seedAiAuth || so.claudeStatusline) {
          openProvisionPanel(updatedBox, so);
        }
      } else {
        const host = fields.host.value.trim();
        if (!host) { err.textContent = 'Host is required'; submit.disabled = false; return; }
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
        openProvisionPanel(newBox, setupForm.values());
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
  input.setAttribute('aria-label', 'Command to run on selected boxes');
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
  err.setAttribute('role', 'alert');
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
  hint.textContent = 'Runs on each selected box via its login shell. Newlines are honored — write a full bash script. ⌘/Ctrl+Enter to run, ⌘/Ctrl+S to save.';

  const nameInput = document.createElement('input');
  nameInput.className = 'fs-name';
  nameInput.type = 'text';
  nameInput.maxLength = 80;
  nameInput.placeholder = 'name (save to keep this script)';
  nameInput.setAttribute('aria-label', 'Script name');
  nameInput.autocomplete = 'off';

  const noteInput = document.createElement('input');
  noteInput.className = 'fs-note';
  noteInput.type = 'text';
  noteInput.maxLength = 200;
  noteInput.placeholder = 'note (optional)';
  noteInput.setAttribute('aria-label', 'Script note');
  noteInput.autocomplete = 'off';

  const metaRow = document.createElement('div');
  metaRow.className = 'fs-meta-row';
  metaRow.append(nameInput, noteInput);

  const editorHost = document.createElement('div');
  editorHost.className = 'fleet-script';

  const main = document.createElement('div');
  main.className = 'fleet-script-main';
  main.append(metaRow, editorHost);

  const body = document.createElement('div');
  body.className = 'fleet-script-body';

  const targetList = document.createElement('div');
  targetList.className = 'fleet-confirm-targets';
  targetList.textContent = targets.length
    ? targets.map((t) => t.label).join('  •  ')
    : 'No boxes selected — select boxes before running.';

  const err = document.createElement('p');
  err.className = 'err';
  err.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'fs-save';
  saveBtn.textContent = 'Save';
  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.className = 'fleet-script-run';
  runBtn.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}`;
  runBtn.disabled = targets.length === 0;
  actions.append(cancel, saveBtn, runBtn);

  // --- saved-script state ---------------------------------------------------
  let scripts: FleetScript[] = [];
  let selected: FleetScript | null = null;

  const dirty = () => isDirty(selected, cm.getValue(), nameInput.value, noteInput.value);

  function refreshRail() {
    rail.update({ scripts, selectedId: selected?.id ?? null, dirty: dirty() });
  }

  // Load into the editor. Called only once the dirty gate below has cleared.
  function load(script: FleetScript | null) {
    selected = script;
    nameInput.value = script?.name || '';
    noteInput.value = script?.description || '';
    cm.setValue(script ? script.script : fleetScriptDraft);
    err.textContent = '';
    refreshRail();
    cm.focus();
  }

  const rail = buildFleetScriptRail({
    onSelect: (script) => {
      if ((script?.id ?? null) === (selected?.id ?? null)) return;
      if (!dirty()) { load(script); return; }
      confirmDiscard(() => load(script));
    },
    onDelete: async (script) => {
      try {
        await fleetScripts.remove(script.id);
        scripts = scripts.filter((s) => s.id !== script.id);
        if (selected?.id === script.id) selected = null;
        refreshRail();
      } catch (ex: any) {
        err.textContent = ex?.message || 'Could not delete the script';
      }
    },
  });

  body.append(rail.dom, main);
  form.append(title, hint, body, targetList, err, actions);
  // closeOnEscape off: while the editor has focus its own keymap owns Escape
  // (so an open completion popup's Escape doesn't also tear down the modal);
  // the fallback handler below covers Escape/Mod-Enter when focus is elsewhere.
  const { close } = openModal({
    modal: form, mount: app, closeOnEscape: false,
    onClose: () => { document.removeEventListener('keydown', onKey); rail.destroy(); cm.destroy(); },
  });

  // CodeMirror handles its own Mod-Enter (run) / Mod-S (save) / Escape (close)
  // while focused; onChange persists the in-progress script so reopening
  // restores it — but only while the unnamed draft is the buffer, since a
  // selected script's edits belong to that script, not to the draft.
  const cm = createFleetScriptEditor({
    initial: fleetScriptDraft || initial || '',
    recent: readFleetRecent(),
    placeholder: '#!/usr/bin/env bash\nset -euo pipefail\n…',
    onChange: (v) => { if (!selected) fleetScriptDraft = v; refreshRail(); },
    onRun: () => form.requestSubmit(),
    onSave: () => void save(),
    onEscape: () => close(),
  });
  editorHost.appendChild(cm.dom);
  cm.focus();
  nameInput.addEventListener('input', refreshRail);
  noteInput.addEventListener('input', refreshRail);
  refreshRail();

  // Load the saved list; a failure leaves the editor fully usable.
  fleetScripts.list()
    .then((list) => { scripts = sortScripts(list); refreshRail(); })
    .catch(() => { err.textContent = 'Could not load saved scripts'; });

  // A second, nested modal: the only gate in this flow, and only on a real
  // conflict (switching away from unsaved work).
  function confirmDiscard(proceed: () => void) {
    const dlg = document.createElement('div');
    dlg.className = 'modal fs-discard';
    const h = document.createElement('h2');
    h.textContent = 'Discard unsaved changes?';
    const p = document.createElement('p');
    p.textContent = 'The edits in the editor have not been saved to a script.';
    const row = document.createElement('div');
    row.className = 'modal-actions';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Cancel';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'danger';
    discard.textContent = 'Discard';
    row.append(keep, discard);
    dlg.append(h, p, row);
    const { close: closeDlg } = openModal({ modal: dlg, mount: app });
    keep.addEventListener('click', closeDlg);
    discard.addEventListener('click', () => { closeDlg(); proceed(); });
  }

  async function save() {
    const script = cm.getValue();
    if (!script.trim()) { err.textContent = 'Script is empty'; return; }
    const nameError = validateName(nameInput.value, scripts, selected?.id ?? null);
    if (nameError) { err.textContent = nameError; nameInput.focus(); return; }
    saveBtn.disabled = true;
    try {
      const spec = { name: nameInput.value.trim(), description: noteInput.value.trim(), script };
      const saved = selected
        ? await fleetScripts.update(selected.id, spec)
        : await fleetScripts.create(spec);
      scripts = sortScripts([...scripts.filter((s) => s.id !== saved.id), saved]);
      selected = saved;
      // The buffer now belongs to a saved script, so the unnamed draft is spent.
      fleetScriptDraft = '';
      err.textContent = '';
      refreshRail();
    } catch (ex: any) {
      // Someone else deleted it: demote to the unnamed draft rather than
      // discarding the operator's text.
      if (statusOf(ex) === 404) {
        selected = null;
        err.textContent = 'That script no longer exists — saving will create a new one.';
        refreshRail();
      } else {
        err.textContent = ex?.message || 'Could not save the script';
      }
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', () => void save());

  // Fallback for keys pressed while focus is on a button or the name fields
  // (the editor's own keymap owns these while it is focused — defer to it so an
  // open completion popup's Escape doesn't also tear down the modal).
  function onKey(e: KeyboardEvent) {
    if (cm.dom.contains(document.activeElement)) return;
    if (e.key === 'Escape') close();
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save(); }
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
      // Name the run only when the buffer IS the saved script. A dirty buffer
      // runs nameless rather than claiming to be a script it no longer is.
      const scriptName = selected && !dirty() ? selected.name : undefined;
      const job = await api.createFleetJob(targets.map((t) => t.id), command, scriptName);
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
    li.textContent = 'No events yet. Box transitions (down / up / needs login / metric thresholds / claude waiting for input / claude finished) will appear here.';
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
  // updateEventsBadge() itself is a local recount from the already-fetched
  // cache — no Notification API call, no outbound request (browser
  // notifications fire separately from pollHealth, above).
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
    // Keyboard-operable row: no nested controls here, so role=button on the li
    // itself is safe (unlike the box rows, which hold their own buttons).
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      showFleetJob(s.id);
    });
    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'fh-cmd';
    // A named script reads better than its first line; the raw command stays
    // available on hover.
    cmdSpan.textContent = s.scriptName || s.command;
    if (s.scriptName) cmdSpan.title = s.command;
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
// A Settings → Notifications toggle recounts the badge right away rather than
// waiting for the next health poll (see settingsNotifications.ts).
window.addEventListener('tmuxifier:notify-prefs-changed', () => updateEventsBadge());
// An import from Settings → Boxes mutates the box list while the modal is still
// open (see settingsBoxes.ts). Module scope, not renderDashboard(), which
// re-runs on every re-login and would stack duplicate listeners. Safe on the
// login screen too: refresh() returns early when #boxes is absent.
window.addEventListener('tmuxifier:boxes-changed', () => { void refresh(); });
// A service saved in Settings repaints a mounted dashboard immediately: restart
// the poll loop, whose first tick fetches the list and snapshot right away.
window.addEventListener('tmuxifier:services-changed', () => {
  if (dashTimer) { stopDashPolling(); startDashPolling(); }
});

// Leaving the workspace — by logout or by an expired session. Every timer,
// terminal and panel #app owns is torn down here, in one place: the two callers
// having hand-rolled their own versions is how they drifted apart.
//
// Terminals are disposed DIRECTLY rather than through closeTab/undockBox, because
// those repaint and persist the stage: the persisted layout must survive leaving
// and be restored on the way back in.
function teardownWorkspace(): void {
  if (pollInterval) clearInterval(pollInterval);
  stopFleetPoll();
  teardownDash();
  // The tabs map is module-level, so surviving entries would keep detached
  // elements (unopenable boxes after re-login) and live reconnect loops.
  for (const [, t] of tabs) { t.term.dispose(); t.el.remove(); }
  tabs.clear();
  destroyPaneLifecycles(); // #app is about to be replaced; nothing repaints the stage on this path
  stopFastStatusPoll();
  updateLocalDot();
  for (const id of [...settingUpPollers.keys()]) clearSettingUpPanel(id);
  stageRoot = null;
  focusedBoxId = null;
  closeFleetJobsPanel();
  closeEventsPanel();
  closeProvisionPanel();
  closeAllModals(); // body-mounted modals (Proxmox hub, settings) survive the #app re-render
}

onUnauthorized(() => {
  if (!app.querySelector('.layout')) return;
  // The same teardown logout performs. This used to close each tab via
  // closeTab(), which reaches undockBox -> repaintStage -> persistStage() and so
  // overwrote the saved split that logout deliberately preserves; removing the
  // last tab also re-entered repaintStage's empty-stage branch, remounting the
  // dashboard and restarting its 10s poll AFTER teardownDash() — 401s firing on
  // the login screen until re-login.
  teardownWorkspace();
  void renderLogin();
  showToast('Session expired — please log in again.', 'error');
});

start();
