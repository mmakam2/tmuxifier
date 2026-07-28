// The UniFi card: a service tile that reports the network instead of a status
// line. Pure view-model first, DOM second — same split as truenasCard.ts, and
// the reason this lives in its own file rather than growing dashboard.ts.
import type { Service, ServiceResult, ServiceStatusSnapshot, UnifiMetrics } from './api';
import { fmtCount, fmtUptime } from './fmt';

// A controller pegged this hard is worth amber before anything has actually
// failed — the same surface-it-early posture the pool thresholds take.
export const CPU_WARN_PCT = 90;
export const MEM_WARN_PCT = 90;
// Beyond this the exception line would wrap the card; the rest is counted.
export const MAX_NAMED_OFFLINE = 3;

export type UnifiLamp = 'green' | 'amber' | 'red' | 'auth' | '';

export interface UnifiCell { label: string; value: string }
export interface UnifiRow { label: string; value: string }
export interface UnifiCard {
  lamp: UnifiLamp;
  chip: string;
  exception: string;
  cells: UnifiCell[];
  rows: UnifiRow[];
  error: string;
}

const pegged = (v: number | null, limit: number) => v != null && v >= limit;

export function unifiLamp(r: ServiceResult | undefined): UnifiLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.unifi;
  if (r.state === 'down' || !m) return 'red';
  // The WAN being down is the one metric-derived condition worth red: every
  // device can be online and the site still have no internet.
  if (m.wanState === 'down') return 'red';
  if (m.offline.length > 0) return 'amber';
  if (pegged(m.gateway?.cpuPct ?? null, CPU_WARN_PCT) || pegged(m.gateway?.memPct ?? null, MEM_WARN_PCT)) return 'amber';
  return 'green';
}

// UniFi reports uplink throughput in bits per second, and a network readout is
// read in Mbps by convention. fmtBytes is the wrong tool twice over: it would
// render 940000000 as "896 MiB" — wrong unit and wrong base — so this lives
// here rather than in fmt.ts, where nothing else wants bit rates.
export function fmtBitrate(bps: number | null): string {
  if (bps == null) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} Kbps`;
  return `${Math.round(bps)} bps`;
}

function deviceTotals(m: UnifiMetrics): { online: number; total: number } {
  const gw = m.gateway ? 1 : 0;
  const gwOnline = m.gateway && m.wanState !== 'down' ? 1 : 0;
  return {
    online: gwOnline + m.switches.online + m.aps.online,
    total: gw + m.switches.total + m.aps.total,
  };
}

function wanValue(m: UnifiMetrics): string {
  if (m.wanTxBps == null && m.wanRxBps == null) return '—';
  const tx = fmtBitrate(m.wanTxBps);
  const rx = fmtBitrate(m.wanRxBps);
  // Share one unit label when both sides agree: "940/45 Mbps" beats repeating it.
  const [txN, txU] = tx.split(' ');
  const [rxN, rxU] = rx.split(' ');
  return txU && txU === rxU ? `${txN}/${rxN} ${txU}` : `${tx} / ${rx}`;
}

function cellsFor(m: UnifiMetrics): UnifiCell[] {
  return [
    { label: 'CLIENTS', value: fmtCount(m.clientsTotal) },
    { label: 'WIRED', value: fmtCount(m.clientsWired) },
    { label: 'WIRELESS', value: fmtCount(m.clientsWireless) },
    { label: 'NETWORKS', value: m.networks == null ? '—' : fmtCount(m.networks) },
    { label: 'WAN', value: wanValue(m) },
    { label: 'UPTIME', value: m.gateway?.uptimeSec == null ? '—' : fmtUptime(m.gateway.uptimeSec) },
  ];
}

// A class the site does not have earns no row: "0/0 online" is noise, not news.
function rowsFor(m: UnifiMetrics): UnifiRow[] {
  const rows: UnifiRow[] = [];
  if (m.gateway) {
    const parts = [m.gateway.name];
    if (m.gateway.cpuPct != null) parts.push(`cpu ${m.gateway.cpuPct}%`);
    if (m.gateway.memPct != null) parts.push(`mem ${m.gateway.memPct}%`);
    rows.push({ label: 'GATEWAY', value: parts.join(' · ') });
  }
  if (m.switches.total > 0) {
    const parts = [`${m.switches.online}/${m.switches.total} online`];
    if (m.switches.cpuPct != null) parts.push(`cpu ${m.switches.cpuPct}%`);
    rows.push({ label: 'SWITCHES', value: parts.join(' · ') });
  }
  if (m.aps.total > 0) {
    rows.push({ label: 'APS', value: `${m.aps.online}/${m.aps.total} online · ${fmtCount(m.aps.clients)} clients` });
  }
  return rows;
}

function exceptionFor(m: UnifiMetrics): string {
  if (m.offline.length === 0) return '';
  const named = m.offline.slice(0, MAX_NAMED_OFFLINE).map((d) => d.name).join(', ');
  const hidden = m.offline.length - MAX_NAMED_OFFLINE;
  return hidden > 0 ? `${named} +${hidden} more offline` : `${named} offline`;
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded controller shows one error line rather than a
// grid of dashes — blank readings say less than one sentence does.
export function unifiCardModel(svc: Service, snap: ServiceStatusSnapshot | null): UnifiCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', exception: '', cells: [] as UnifiCell[], rows: [] as UnifiRow[] };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = unifiLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.unifi) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.unifi;
  const { online, total } = deviceTotals(m);
  return {
    lamp,
    chip: `wan ${m.wanState} · ${online}/${total} online`,
    exception: exceptionFor(m),
    cells: cellsFor(m),
    rows: rowsFor(m),
    error: '',
  };
}

// --- DOM layer -------------------------------------------------------------

export interface UnifiCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the cell or row count changes; otherwise written in place,
// so a poll never disturbs hover or text selection (the tile contract).
export function buildUnifiCard(): UnifiCardEls {
  const div = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  };
  const root = document.createElement('a');
  root.className = 'dash-tile dash-tile-wide';
  root.target = '_blank';
  root.rel = 'noopener';
  const lamp = document.createElement('span');
  lamp.className = 'dot';
  const name = div('dash-tile-name');
  const chip = document.createElement('span');
  chip.className = 'dash-card-chip';
  const top = div('dash-tile-top');
  top.append(lamp, name, chip);
  const exception = div('dash-card-warn');
  const grid = div('dash-card-grid');
  const rows = div('dash-unifi-rows');
  const error = div('dash-card-error');
  root.append(top, exception, grid, rows, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = unifiCardModel(svc, snap);
    root.href = svc.url;
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    exception.textContent = model.exception;
    exception.hidden = !model.exception;
    error.textContent = model.error;
    error.hidden = !model.error;
    root.title = model.error;

    if (grid.children.length !== model.cells.length) {
      grid.replaceChildren(...model.cells.map(() => {
        const cell = div('dash-card-cell');
        cell.append(div('dash-card-label'), div('dash-card-value'));
        return cell;
      }));
    }
    model.cells.forEach((cell, i) => {
      const el = grid.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = cell.label;
      (el.lastChild as HTMLElement).textContent = cell.value;
    });
    grid.hidden = model.cells.length === 0;

    if (rows.children.length !== model.rows.length) {
      rows.replaceChildren(...model.rows.map(() => {
        const row = div('dash-unifi-row');
        row.append(div('dash-unifi-label'), div('dash-unifi-value'));
        return row;
      }));
    }
    model.rows.forEach((row, i) => {
      const el = rows.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = row.label;
      (el.lastChild as HTMLElement).textContent = row.value;
    });
    rows.hidden = model.rows.length === 0;
  }

  return { root, update };
}
