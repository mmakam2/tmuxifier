// Pure formatters: wire shapes in, compact model-readable text out. Raw JSON is
// not a UI. No I/O here — every function is unit-tested in isolation.

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC2 = /\x1b[@-Z\\-_]/g;

export function stripSgr(text) {
  const lines = String(text ?? '').replace(OSC, '').replace(CSI, '').replace(ESC2, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export function agentOf(sample) { return sample?.agent ?? 'gone'; }

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
    segs.push(`tmux: ${status.sessions.map((s) => `${s.name}${s.attached ? '*' : ''}(${s.windows}w)`).join(', ')}`);
  }
  if (sample?.agent) segs.push(`agent: ${sample.agent}`);
  if (status?.metrics?.osId) segs.push(`os: ${status.metrics.osId}${status.metrics.osVer ? ` ${status.metrics.osVer}` : ''}`);
  if (status && !status.reachable && status.error) segs.push(status.error);
  return segs.join(' · ');
}

export function fleetOverview(boxes, statusMap = {}, seriesMap = {}) {
  if (!boxes.length) return 'no boxes';
  return [`${boxes.length} boxes`, ...boxes.map((b) => boxLine(b, statusMap[b.id], (seriesMap[b.id] || []).at(-1)))].join('\n');
}

export function paneText(snap, box) {
  const head = `pane ${box.label || box.host} session ${snap.sessionName} ${snap.width}x${snap.height} cursor ${snap.cursorX},${snap.cursorY} alt:${!!snap.alt} mouse:${!!snap.mouse} agent:${agentOf({ agent: snap.agent })}`;
  return `${head}\n---\n${stripSgr(snap.content)}`;
}

export function healthText(boxId, series = [], events = [], { maxEvents = 20 } = {}) {
  const last = series.at(-1);
  const latest = last
    ? ['latest: ' + upWord(undefined, last), metricsSeg(last), last.agent ? `agent: ${last.agent}` : ''].filter(Boolean).join(' · ')
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
