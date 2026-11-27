// Pure formatters: wire shapes in, compact model-readable text out. Raw JSON is
// not a UI. No I/O here — every function is unit-tested in isolation.

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC2 = /\x1b[@-Z\\-_]/g;

export function stripSgr(text) {
  const lines = String(text ?? '').replace(OSC, '').replace(CSI, '').replace(ESC2, '').split('\n').map((l) => l.trimEnd()); // not /\s+$/: it backtracks O(n^2) on a long blank run ending in a non-space
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// Box-controlled free text. A failed probe's ssh stderr (status.error: sshd
// banners, the box's login-shell output) and any stray probe stdout line
// (which status.js parses as a session name) are written by the box, so a
// compromised box can aim them at the model reading list_boxes. Before such
// text joins a line: drop escape sequences, C0/C1 controls, every Unicode
// format character (bidi overrides/isolates, zero-width, BOM, soft hyphen),
// lone surrogates and the tag block U+E0000-E007F (invisible "ASCII
// smuggling"); fold each whitespace run, newlines included, to one space so
// the text cannot fake extra output lines; then cap it with a visible marker.
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\p{Cf}\p{Cs}\u{E0000}-\u{E007F}]/gu;
const SPACE_RUN = /[\s\u0085]+/gu;
export const ERROR_MAX = 200;
export const SESSION_NAME_MAX = 64;
export const SESSIONS_MAX = 32;

export function untrustedText(text, max, { keep = 'head' } = {}) {
  const s = String(text ?? '').replace(OSC, '').replace(CSI, '').replace(ESC2, '').replace(INVISIBLE, '').replace(SPACE_RUN, ' ').trim();
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return keep === 'tail' ? `\u2026${cps.slice(-max).join('')}` : `${cps.slice(0, max).join('')}\u2026`;
}

// The agent entry a caller means in a health sample's `agents` map (keyed by pane
// id, one entry per pane running an agent). With `pane`: that pane's entry, read
// as an own key, when it belongs to `session` (a pane of another session is not
// the one asked for). Without: the entry of `session`'s focused pane, which is
// the pane read_pane shows and send_text types into. null when there is none.
export function agentEntryOf(sample, { session, pane } = {}) {
  const agents = sample?.agents;
  if (!agents || typeof agents !== 'object') return null;
  const mine = (e) => (e && typeof e === 'object' && e.session === session ? e : null);
  if (pane != null) return Object.hasOwn(agents, pane) ? mine(agents[pane]) : null;
  return Object.values(agents).find((e) => mine(e) && e.focused === true) ?? null;
}

// The state of that entry; 'gone' when there is no such entry or it has no marker.
export function agentOf(sample, where) {
  return agentEntryOf(sample, where)?.state ?? 'gone';
}

// The naming rule of the browser's `agentRows` (src/web/agentState.ts, header
// comment), written again here because src/mcp must not import src/web, and
// pinned equal to it by test/agentNaming.test.js. A name is the window,
// `<windowIndex>:<windowName>` (`window` when it is empty); `.<paneIndex>` is
// added only when the box has more than one agent ENTRY, stateless ones counted,
// in that session and window; `<session> › ` is prefixed only when the entries
// span more than one session. Ordered by session (plain string compare, not a
// locale one), window index, pane index.
//
// Every entry is listed, with or without a state; callers filter. Session and
// window names are written by the box, so they are cleaned (`untrustedText`) as
// they join a name; the ordering and the counting use the raw values.
const WINDOW_NAME_MAX = 64;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function agentNames(agents) {
  const entries = [];
  const perWindow = new Map(); // session -> windowId -> entries in that window
  for (const [pane, e] of Object.entries(agents ?? {})) {
    if (!e || typeof e !== 'object') continue;
    entries.push([pane, e]);
    const windows = perWindow.get(e.session) ?? new Map();
    windows.set(e.windowId, (windows.get(e.windowId) ?? 0) + 1);
    perWindow.set(e.session, windows);
  }
  const acrossSessions = perWindow.size > 1;
  entries.sort(([, a], [, b]) => cmp(a.session, b.session) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
  return entries.map(([pane, e]) => {
    let name = `${e.windowIndex}:${untrustedText(e.windowName, WINDOW_NAME_MAX) || 'window'}`;
    if ((perWindow.get(e.session)?.get(e.windowId) ?? 0) > 1) name += `.${e.paneIndex}`;
    if (acrossSessions) name = `${untrustedText(e.session, SESSION_NAME_MAX)} \u203a ${name}`;
    const item = { pane, name };
    if (e.state) item.state = e.state;
    if (e.cause) item.cause = e.cause;
    return item;
  });
}

// A tmux pane id, as the server validates one (`PANE_ID_RE`, src/server/sshCommand.js;
// the server is not importable here). Pinned equal by test/mcpTools.test.js.
const PANE_ID = /^%\d{1,9}$/;

// `agents: 2:frontend.1[%12]=blocked(permission) 2:frontend.2[%13]=working`: one
// item per agent pane that has a state, named by `agentNames`, the pane id in
// brackets so a caller can hand it to wait_for_agent, the cause only for a
// blocked pane. Empty when no pane has a state (or the server sent no `agents`).
export function agentsSeg(sample) {
  const items = agentNames(sample?.agents)
    .filter((a) => a.state)
    .map((a) => `${a.name}${PANE_ID.test(a.pane) ? `[${a.pane}]` : ''}=${a.state}${a.state === 'blocked' && a.cause ? `(${a.cause})` : ''}`);
  return items.length ? `agents: ${items.join(' ')}` : '';
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `…${s.slice(-max)}` : s;
}

function upWord(status, sample) {
  if (!status && !sample) return 'unknown';
  if (sample?.stopped || status?.proxmoxState === 'stopped') return 'stopped';
  if (status?.hostKeyChanged || sample?.keyChanged) return 'key-changed';
  if (status?.needsAuth || sample?.needsAuth) return 'needs-auth';
  if (status ? status.reachable : sample?.up) return 'up';
  return 'down';
}

function metricsSeg(sample) {
  const parts = [];
  if (sample?.cpuPct != null) parts.push(`cpu ${sample.cpuPct}%`);
  if (sample?.memPct != null) parts.push(`mem ${sample.memPct}%`);
  if (sample?.diskPct != null) parts.push(`disk ${sample.diskPct}%`);
  return parts.join(' ');
}

export function boxLine(box, status, sample) {
  const segs = [`${box.label || box.host} [${box.id}] ${box.host} — ${upWord(status, sample)}`];
  const m = metricsSeg(sample);
  if (m) segs.push(m);
  if (Array.isArray(status?.sessions) && status.sessions.length) {
    const shown = status.sessions.slice(0, SESSIONS_MAX).map((s) => `${untrustedText(s.name, SESSION_NAME_MAX)}${s.attached ? '*' : ''}(${s.windows}w)`);
    const more = status.sessions.length - shown.length;
    segs.push(`tmux: ${shown.join(', ')}${more > 0 ? `, \u2026 +${more} more` : ''}`);
  }
  const ag = agentsSeg(sample);
  if (ag) segs.push(ag);
  if (status?.metrics?.osId) segs.push(`os: ${status.metrics.osId}${status.metrics.osVer ? ` ${status.metrics.osVer}` : ''}`);
  // The tail: ssh prints any banner first and its own verdict last.
  const err = status && !status.reachable && status.error ? untrustedText(status.error, ERROR_MAX, { keep: 'tail' }) : '';
  if (err) segs.push(err);
  return segs.join(' · ');
}

export function fleetOverview(boxes, statusMap = {}, seriesMap = {}) {
  if (!boxes.length) return 'no boxes';
  return [`${boxes.length} boxes`, ...boxes.map((b) => boxLine(b, statusMap[b.id], (seriesMap[b.id] || []).at(-1)))].join('\n');
}

// The head names the pane the capture came from (`pane:%N`, when the server says
// which) and that pane's agent state: the route reads both from the same entry.
export function paneText(snap, box) {
  const state = snap.agent ?? 'gone';
  const pane = PANE_ID.test(snap.pane) ? ` pane:${snap.pane}` : '';
  const cause = state === 'blocked' && snap.agentCause ? `(${snap.agentCause})` : '';
  const head = `pane ${box.label || box.host} session ${snap.sessionName} ${snap.width}x${snap.height} cursor ${snap.cursorX},${snap.cursorY} alt:${!!snap.alt} mouse:${!!snap.mouse}${pane} agent:${state}${cause}`;
  return `${head}\n---\n${stripSgr(snap.content)}`;
}

export function healthText(boxId, series = [], events = [], { maxEvents = 20 } = {}) {
  const last = series.at(-1);
  const latest = last
    ? ['latest: ' + upWord(undefined, last), metricsSeg(last), agentsSeg(last)].filter(Boolean).join(' · ')
    : 'latest: no samples';
  const mine = (events || []).filter((e) => e.boxId === boxId).slice(0, maxEvents);
  const lines = [latest, `events (${mine.length}):`];
  for (const e of mine) lines.push(`${new Date(e.t).toISOString()} ${e.kind}${e.metric ? ` ${e.metric}=${e.value}` : ''}`);
  return lines.join('\n');
}

// POST /api/fleet/jobs, GET /api/fleet/jobs/:id and the cancel route return the
// RAW job (targets, no counts); only the list route returns summarize()'s
// okCount/targetCount/errorCount. Derive them here so both shapes render alike.
export function fleetCounts(job) {
  if (job.okCount != null) return { ok: job.okCount, total: job.targetCount, failed: job.errorCount };
  const t = job.targets || [];
  return {
    ok: t.filter((x) => x.status === 'ok').length,
    total: t.length,
    failed: t.filter((x) => x.status === 'error' || x.status === 'interrupted').length,
  };
}

export function jobLine(kind, job) {
  let ctx;
  if (kind === 'fleet') {
    const c = fleetCounts(job);
    ctx = `${c.ok}/${c.total} ok, ${c.failed} failed — ${String(job.scriptName || job.command || '').slice(0, 60)}`;
  }
  else if (kind === 'setup') ctx = `${job.boxLabel} phase ${job.phase}`;
  else if (kind === 'provision') ctx = `${job.hostname} phase ${job.phase}`;
  else ctx = `${job.action} ${job.boxLabel} phase ${job.phase}`;
  return `${kind} ${job.id} ${job.status} ${ctx} · ${job.createdAt}`;
}

export function jobDetail(kind, job, { tail = 4000 } = {}) {
  const lines = [jobLine(kind, job)];
  if (kind === 'fleet') {
    for (const t of job.targets || []) {
      lines.push(`--- ${t.label} (${t.status}, exit ${t.code})${t.error ? ` ${t.error}` : ''}`);
      if (t.stdout) lines.push(clip(t.stdout, tail));
      if (t.stderr) lines.push('stderr:', clip(t.stderr, tail));
    }
    return lines.join('\n');
  }
  if (kind === 'setup' && job.needs) lines.push(`needs: ${job.needs}`);
  if (job.error) lines.push(`error: ${job.error}`);
  if (job.log) lines.push(`log (last ${tail} chars):`, clip(job.log, tail));
  return lines.join('\n');
}

export function scriptsText(scripts) {
  if (!scripts.length) return 'no saved scripts';
  const lines = [`${scripts.length} saved scripts`];
  for (const s of scripts) {
    // Mirrors fleetScriptsStore.js's own record shape (`script`/`description`),
    // not the `body`/`note` names this used to assume — those were never the
    // wire shape GET /api/fleet/scripts actually returns.
    lines.push(`${s.id} ${s.name}${s.description ? ` — ${s.description}` : ''}`);
    for (const l of String(s.script || '').split('\n')) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

export function presetsText(presets, hosts) {
  if (!presets.length) return 'no presets';
  const byId = new Map((hosts || []).map((h) => [h.id, h]));
  return presets.map((p) => {
    const host = byId.get(p.hostId);
    const net = p.net || {};
    const netSeg = `net ${net.bridge}${net.vlan != null ? ` vlan ${net.vlan}` : ''} ${net.ipMode}${net.cidr ? ` ${net.cidr}` : ''}`;
    return `${p.id} ${p.name} host=${host?.name || p.hostId} node=${p.node || host?.defaultNode || 'host default'} template=${p.template} ${p.cores}c ${p.memoryMiB}MiB disk ${p.diskGiB}GiB ${netSeg}`;
  }).join('\n');
}

export function guestsText(guests) {
  if (!guests.length) return 'no linked guests';
  return guests.map((g) => {
    let line = `${g.boxLabel} [${g.boxId}] ${g.kind === 'qemu' ? 'VM' : 'CT'} vmid ${g.vmid} node ${g.node} state ${g.state}`;
    if (g.template) line += ' TEMPLATE';
    if (g.activeJob) line += ` · active job ${g.activeJob.action}`;
    if (g.error) line += ` · ${g.error}`;
    return line;
  }).join('\n');
}

export function errorText(err) {
  if (err?.kind === 'unauthorized') return 'token invalid or revoked — re-run `npm run mcp-enroll`';
  if (err?.kind === 'unreachable') return `cannot reach Tmuxifier at ${err.baseUrl}: ${err.message}`;
  if (err?.kind === 'http') return `${err.status} ${err.path}: ${err.message}`;
  return String(err?.message || err);
}
