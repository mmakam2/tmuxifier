import { el, input, field, err, openModal, makeRadio } from './dom';
import { registerModal } from './modalRegistry';
import {
  listAlerts, ackAlert, muteAlert, unmuteAlert,
  listChecks, createCheck, updateCheck, deleteCheck, runCheck,
  listFeed, ingestStatus,
  type CheckSummary, type CheckRunState,
} from './alerts';
import {
  laneFor, severityRank, reasonLabel, occurrenceSummary, relativeAge, sourceRows,
  type Alert, type Severity,
} from './alertFormat';
import { checkFieldsFor, checkFormPayload, checkinPath, IMPLEMENTED_TYPES } from './checkForm';

const TABS = ['Alerts', 'Checks', 'Feed', 'Sources'] as const;
type Tab = typeof TABS[number];
const LANES: Severity[] = ['critical', 'warning', 'info'];

// The feed and decision routes return raw log lines, so every field is treated
// as possibly absent or wrong-typed rather than trusted — these are NDJSON lines
// read off disk, not a validated API shape.
type FeedEvent = { ts?: number; source?: string; severity?: string; title?: string };

// Mirrors the server's clamps in checkTypes.js. The server stays the authority —
// these only spare the operator a round trip to discover the same bounds.
const DEFAULTS = { intervalSec: 60, timeoutMs: 10000, failuresBeforeNotify: 3, severity: 'warning' as Severity };

export function openAlertsHub() {
  const modal = el('div', { class: 'modal pve-hub alerts-hub' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });
  const { close } = openModal({ modal, onClose: () => unregister() });
  // Body-mounted, like the Proxmox hub: register so logout / session-expiry
  // teardown closes it rather than leaving it over the login screen.
  const unregister = registerModal(close);

  // A mute is a stored rule, but an alert only learns it is muted when the next
  // evaluation cycle stamps reason='suppressed:muted' on it — up to alertEvalMs
  // away (30s by default). Remembering what this session muted keeps the row's
  // toggle honest in that gap, instead of offering "Mute" on an alert the
  // operator just muted.
  const muted = new Set<string>();

  const renderers: Record<Tab, () => Promise<void>> = {
    Alerts: renderAlerts, Checks: renderChecks, Feed: renderFeed, Sources: renderSources,
  };
  function selectTab(t: Tab) {
    for (const b of tabStrip.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    void renderers[t]();
  }
  for (const t of TABS) tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': t, onclick: () => selectTab(t) }, [t]));

  // Above the tab strip, not inside a tab: a dead receiver invalidates what
  // every tab shows, so it cannot be something the operator has to go looking
  // for. Empty until the check answers, so a working install shows nothing.
  const banner = el('div', {});
  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Alerts']), el('button', { type: 'button', class: 'pve-close', title: 'Close', onclick: close }, ['✕'])]),
    banner, tabStrip, content,
  );
  selectTab('Alerts');
  void syncIngestBanner();

  async function syncIngestBanner() {
    let st;
    try { st = await ingestStatus(); } catch { return; } // a failed probe is not evidence of death
    // alive === null means this build has no liveness reader wired at all, which
    // is not the same claim as "the daemon is down" — say nothing rather than
    // cry wolf.
    if (st.alive !== false) { banner.replaceChildren(); return; }
    const age = st.staleFor == null ? 'never seen' : `last check-in ${relativeAge(Date.now() - st.staleFor, Date.now())}`;
    banner.replaceChildren(el('div', { class: 'alert-banner' }, [
      `Alert ingest is not running — heartbeat checks cannot detect check-ins (${age}).`,
    ]));
  }

  function setContent(...nodes: (Node | string)[]) { content.replaceChildren(...nodes); }
  function showError(e: unknown) { content.prepend(err(e instanceof Error ? e.message : String(e))); }

  // --- Alerts ---
  async function renderAlerts() {
    setContent(el('div', { class: 'pve-sub' }, ['Loading…']));
    let alerts: Alert[];
    try { alerts = await listAlerts(); } catch (e) { setContent(err(e instanceof Error ? e.message : String(e))); return; }
    for (const a of alerts) if (a.reason === 'suppressed:muted') muted.add(a.key);

    // laneFor drops resolved alerts, so a check that recovered leaves the list
    // on its own — the open list is what is wrong now, not a history.
    const open = alerts.filter((a) => laneFor(a) !== null)
      .sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || (y.lastTs ?? 0) - (x.lastTs ?? 0));
    if (!open.length) {
      setContent(el('div', { class: 'pve-sub' }, ['Nothing firing. Checks that pass never appear here.']));
      return;
    }
    const now = Date.now();
    setContent(...LANES.filter((lane) => open.some((a) => laneFor(a) === lane)).map((lane) =>
      el('div', { class: 'alert-lane' }, [
        el('div', { class: 'pve-eyebrow' }, [lane]),
        el('div', { class: 'pve-list' }, open.filter((a) => laneFor(a) === lane).map((a) => alertRow(a, now))),
      ])));
  }

  function alertRow(a: Alert, now: number) {
    const isMuted = muted.has(a.key);
    const act = async (fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { showError(e); return; }
      await renderAlerts();
    };
    // Every row states why it did or did not reach you: a quiet system and a
    // broken one are otherwise indistinguishable.
    const seen = a.lastTs == null ? 'not seen yet' : `last ${relativeAge(a.lastTs, now)}`;
    return el('div', { class: `pve-row alert-row ${a.severity}` }, [
      el('div', {}, [
        el('strong', {}, [a.title]),
        el('div', { class: 'pve-sub' }, [`${a.source} · ${occurrenceSummary(a)} · ${seen} · ${reasonLabel(a.reason)}`]),
      ]),
      el('div', { class: 'pve-row-actions' }, [
        el('button', { type: 'button', onclick: () => void act(() => ackAlert(a.key)) }, ['Ack']),
        el('button', { type: 'button', onclick: () => void act(async () => {
          if (isMuted) { await unmuteAlert(a.key); muted.delete(a.key); }
          else { await muteAlert(a.key); muted.add(a.key); }
        }) }, [isMuted ? 'Unmute' : 'Mute']),
      ]),
    ]);
  }

  // --- Checks ---
  async function renderChecks() {
    setContent(el('div', { class: 'pve-sub' }, ['Loading…']));
    let data: { checks: CheckSummary[]; state: Record<string, CheckRunState>; ingestPort: number | null };
    try { data = await listChecks(); } catch (e) { setContent(err(e instanceof Error ? e.message : String(e))); return; }
    const now = Date.now();
    setContent(
      el('div', { class: 'modal-actions' }, [
        el('button', { type: 'button', class: 'pve-primary', onclick: () => openCheckForm(null) }, ['+ New check']),
      ]),
      data.checks.length
        ? el('div', { class: 'pve-list' }, data.checks.map((c) => checkRow(c, data.state[c.id], now, data.ingestPort)))
        : el('div', { class: 'pve-sub' }, ['No checks yet. A check is a probe run on a schedule; a failing one becomes an alert.']),
    );
  }

  function checkStatusText(st: CheckRunState | undefined, now: number): string {
    if (!st || st.lastRunAt == null) return 'not run yet';
    const bits = [st.ok === null ? 'unknown' : st.ok ? 'ok' : `failing (${st.consecutiveFail}×)`, relativeAge(st.lastRunAt, now)];
    if (st.latencyMs != null) bits.push(`${st.latencyMs}ms`);
    if (st.detail) bits.push(st.detail);
    return bits.join(' · ');
  }

  function checkRow(c: CheckSummary, st: CheckRunState | undefined, now: number, ingestPort: number | null) {
    const act = async (fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { showError(e); return; }
      await renderChecks();
    };
    // A heartbeat is satisfied by something calling in, so the row carries the
    // path to call — the check is unusable without it, and nothing else in the
    // UI reveals the token.
    const lines = [
      el('strong', {}, [c.label]),
      el('div', { class: 'pve-sub' }, [`${c.type}${c.enabled ? '' : ' · disabled'} · ${checkStatusText(st, now)}`]),
    ];
    if (c.type === 'heartbeat') {
      const port = ingestPort ?? '<ingest-port>';
      lines.push(el('div', { class: 'pve-sub' }, [
        `check in with: curl -fsS http://<ingest-host>:${port}${checkinPath(c.id)}`,
      ]));
    }
    return el('div', { class: 'pve-row' }, [
      el('div', {}, lines),
      el('div', { class: 'pve-row-actions' }, [
        el('button', { type: 'button', onclick: () => void act(() => runCheck(c.id)) }, ['Run now']),
        el('button', { type: 'button', onclick: () => openCheckForm(c) }, ['Edit']),
        el('button', { type: 'button', class: 'danger', onclick: () => confirmDelete(c) }, ['Delete']),
      ]),
    ]);
  }

  // --- Feed ---
  // Every occurrence, including the ones no rule will ever notify on. This is
  // where a newly added check is confirmed working without interrupting anyone.
  async function renderFeed() {
    setContent(el('div', { class: 'pve-sub' }, ['Loading…']));
    let events: FeedEvent[];
    try { events = (await listFeed()) as FeedEvent[]; } catch (e) { setContent(err(e instanceof Error ? e.message : String(e))); return; }
    if (!events.length) {
      setContent(el('div', { class: 'pve-sub' }, ['Nothing recorded yet. Every occurrence lands here first, whether or not it notifies.']));
      return;
    }
    const newest = [...events].reverse();
    const filter = input('', { type: 'text', placeholder: 'Filter by title or source…' });
    const list = el('div', { class: 'pve-list' });
    const paint = () => {
      const term = filter.value.trim().toLowerCase();
      const shown = term
        ? newest.filter((e) => `${e.title ?? ''} ${e.source ?? ''}`.toLowerCase().includes(term))
        : newest;
      list.replaceChildren(...(shown.length
        ? shown.slice(0, 300).map(feedRow)
        : [el('div', { class: 'pve-sub' }, ['Nothing matches that filter.'])]));
    };
    filter.addEventListener('input', paint);
    setContent(el('div', { class: 'modal-actions' }, [filter]), list);
    paint();
  }

  function feedRow(e: FeedEvent) {
    const sev = String(e.severity ?? 'info');
    const ts = Number(e.ts);
    return el('div', { class: `pve-row alert-row ${sev}` }, [
      el('div', {}, [
        el('strong', {}, [String(e.title ?? '(untitled)')]),
        el('div', { class: 'pve-sub' }, [
          `${String(e.source ?? 'unknown')} · ${Number.isFinite(ts) ? relativeAge(ts, Date.now()) : 'unknown time'}`,
        ]),
      ]),
      el('span', { class: 'pve-badge' }, [sev]),
    ]);
  }

  // --- Sources ---
  async function renderSources() {
    setContent(el('div', { class: 'pve-sub' }, ['Loading…']));
    let events: FeedEvent[];
    let checks: CheckSummary[];
    try {
      const [ev, data] = await Promise.all([listFeed(), listChecks()]);
      events = ev as FeedEvent[];
      checks = data.checks;
    } catch (e) { setContent(err(e instanceof Error ? e.message : String(e))); return; }
    const rows = sourceRows(events.map((e) => ({ source: String(e.source ?? 'unknown'), ts: Number(e.ts) || 0 })));
    if (!rows.length) {
      setContent(el('div', { class: 'pve-sub' }, ['No sources have reported yet.']));
      return;
    }
    const now = Date.now();
    setContent(el('div', { class: 'pve-list' }, rows.map((row) => sourceRow(row, checks, now))));
  }

  function sourceRow(row: { source: string; count: number; lastTs: number }, checks: CheckSummary[], now: number) {
    const isMuted = muted.has(row.source);
    const actions: HTMLElement[] = [];
    // A source-level mute: decideAlert matches rules.mutes against the alert's
    // source as well as its key, so muting the source silences every alert it
    // raises rather than only the one currently firing.
    actions.push(el('button', { type: 'button', onclick: async () => {
      try {
        if (isMuted) { await unmuteAlert(row.source); muted.delete(row.source); }
        else { await muteAlert(row.source); muted.add(row.source); }
      } catch (e) { showError(e); return; }
      await renderSources();
    } }, [isMuted ? 'Unmute source' : 'Mute source']));

    // The per-source notification threshold, for the sources that are checks.
    // updateCheck re-validates the whole definition, so the full spec is resent
    // with only this field changed — including `assert`, which the server would
    // otherwise reset to {} and silently downgrade the check.
    const check = checks.find((c) => `check:${c.id}` === row.source);
    if (check) {
      const box = input(String(check.failuresBeforeNotify), { type: 'number', min: 1, max: 1000, title: 'Consecutive failures before notifying' });
      box.style.width = '64px';
      box.addEventListener('change', async () => {
        const n = Number(box.value);
        if (!Number.isFinite(n) || n < 1) { box.value = String(check.failuresBeforeNotify); return; }
        try {
          await updateCheck(check.id, {
            label: check.label, type: check.type, target: check.target, severity: check.severity,
            intervalSec: check.intervalSec, timeoutMs: check.timeoutMs, failuresBeforeNotify: n,
            enabled: check.enabled, assert: check.assert,
          });
        } catch (e) { showError(e); return; }
        await renderSources();
      });
      actions.push(box);
    }

    return el('div', { class: 'pve-row' }, [
      el('div', {}, [
        el('strong', {}, [row.source]),
        el('div', { class: 'pve-sub' }, [
          `${row.count} occurrence${row.count === 1 ? '' : 's'} · last ${relativeAge(row.lastTs, now)}`,
        ]),
      ]),
      el('div', { class: 'pve-row-actions' }, actions),
    ]);
  }

  function confirmDelete(c: CheckSummary) {
    const dialog = el('div', { class: 'modal' });
    const { close: closeConfirm } = openModal({ modal: dialog });
    const go = el('button', { type: 'button', class: 'danger', onclick: async () => {
      try { await deleteCheck(c.id); } catch (e) { dialog.append(err(e instanceof Error ? e.message : String(e))); return; }
      closeConfirm();
      await renderChecks();
    } }, ['Delete']);
    dialog.append(
      el('h2', {}, ['Delete check']),
      el('div', {}, [`${c.label} · ${c.type}`]),
      el('p', { class: 'pve-warning' }, ['Deletes the definition and its schedule. Occurrences already recorded stay in the event log.']),
      el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: closeConfirm }, ['Cancel']), go]),
    );
  }

  function openCheckForm(existing: CheckSummary | null) {
    const dialog = el('div', { class: 'modal' });
    const { close: closeForm } = openModal({ modal: dialog });

    const label = input(existing?.label ?? '', { placeholder: 'Invoice app' });
    const intervalSec = input(String(existing?.intervalSec ?? DEFAULTS.intervalSec), { type: 'number', min: 10, max: 86400 });
    const timeoutMs = input(String(existing?.timeoutMs ?? DEFAULTS.timeoutMs), { type: 'number', min: 1000, max: 120000 });
    const failures = input(String(existing?.failuresBeforeNotify ?? DEFAULTS.failuresBeforeNotify), { type: 'number', min: 1, max: 1000 });
    // A stored secret is never sent to the browser (the route redacts it to
    // hasSecret), and a blank field is omitted from the payload rather than
    // clearing it — so an edit can leave a credential untouched without ever
    // round-tripping it.
    const secret = input('', { type: 'password', placeholder: existing?.hasSecret ? 'stored — leave blank to keep' : 'optional bearer token' });
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = existing?.enabled ?? true;

    let type = existing?.type ?? IMPLEMENTED_TYPES[0];
    let severity: Severity = (existing?.severity as Severity) ?? DEFAULTS.severity;

    const targetBox = el('div', {});
    const targetInputs = new Map<string, HTMLInputElement>();
    function renderTarget() {
      targetInputs.clear();
      targetBox.replaceChildren(...checkFieldsFor(type).map((f) => {
        // Only carry an existing value across when the type still matches:
        // switching type changes what the field means.
        const value = existing && existing.type === type ? String(existing.target?.[f.name] ?? '') : '';
        const box = input(value, f.placeholder ? { placeholder: f.placeholder } : {});
        targetInputs.set(f.name, box);
        return field(f.label, box);
      }));
    }
    renderTarget();

    const typeRow = el('div', { class: 'check-row' }, IMPLEMENTED_TYPES.map((t) => {
      const r = makeRadio('check-type', t, t, t === type);
      r.input.addEventListener('change', () => { if (r.input.checked) { type = t; renderTarget(); } });
      return r.wrap;
    }));
    const sevRow = el('div', { class: 'check-row' }, LANES.map((s) => {
      const r = makeRadio('check-sev', s, s, s === severity);
      r.input.addEventListener('change', () => { if (r.input.checked) severity = s; });
      return r.wrap;
    }));

    const save = el('button', { type: 'button', class: 'pve-primary', onclick: async () => {
      dialog.querySelector('.pve-err')?.remove();
      const values: Record<string, unknown> = {
        label: label.value, type, severity,
        intervalSec: intervalSec.value, timeoutMs: timeoutMs.value,
        failuresBeforeNotify: failures.value,
        enabled: enabled.checked, secret: secret.value,
        // No field edits this, but omitting it would make the server reset the
        // stored assertion to {} — an edit of an unrelated field would quietly
        // turn a body/status/JSON assertion into a bare reachability probe.
        assert: existing?.assert,
      };
      for (const [name, box] of targetInputs) values[name] = box.value;
      try {
        const payload = checkFormPayload(values);
        if (existing) await updateCheck(existing.id, payload);
        else await createCheck(payload);
      } catch (e) { dialog.append(err(e instanceof Error ? e.message : String(e))); return; }
      closeForm();
      await renderChecks();
    } }, [existing ? 'Save' : 'Create']);

    dialog.append(
      el('h2', {}, [existing ? 'Edit check' : 'New check']),
      field('Label', label),
      el('label', { class: 'field' }, [el('span', {}, ['Type']), typeRow]),
      targetBox,
      el('label', { class: 'field' }, [el('span', {}, ['Severity']), sevRow]),
      field('Interval (seconds)', intervalSec),
      field('Timeout (ms)', timeoutMs),
      field('Consecutive failures before notifying', failures),
      field('Secret', secret),
      el('label', { class: 'check-field' }, [enabled, el('span', {}, ['Enabled'])]),
      el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: closeForm }, ['Cancel']), save]),
    );
    label.focus();
  }
}
