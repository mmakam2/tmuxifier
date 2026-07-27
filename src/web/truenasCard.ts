// The TrueNAS card: a service tile that reports storage instead of a status
// line. Pure view-model first, DOM second — same split as dashboard.ts, and the
// reason this lives in its own file rather than growing dashboard.ts further.
import type { Service, ServiceResult, ServiceStatusSnapshot, TruenasMetrics, TruenasPool } from './api';
import { fmtBytes, fmtUptime } from './fmt';

// A pool this full is the thing a storage tile exists to surface, so capacity
// drives the lamp rather than waiting for TrueNAS to raise its own alert.
export const POOL_WARN_PCT = 80;
export const POOL_CRIT_PCT = 90;
// Beyond this the card would push the rest of the dashboard off screen; the
// remainder is counted on a "+N more pools" line, never silently dropped.
export const MAX_POOL_ROWS = 6;

// A pool in one of these states is not serving data. DEGRADED is deliberately
// not here: it is still serving, and collapsing the two into one colour would
// lose the only distinction the lamp exists to make.
const FAULTED = new Set(['FAULTED', 'UNAVAIL', 'REMOVED']);

export type TruenasLamp = 'green' | 'amber' | 'red' | 'auth' | '';

const degraded = (p: TruenasPool) => !p.healthy || p.status.toUpperCase() !== 'ONLINE';
const faulted = (p: TruenasPool) => FAULTED.has(p.status.toUpperCase());
const atLeast = (p: TruenasPool, pct: number) => p.usedPct != null && p.usedPct >= pct;

export function truenasLamp(r: ServiceResult | undefined): TruenasLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.truenas;
  if (r.state === 'down' || !m) return 'red';
  if (m.pools.some(faulted) || m.pools.some((p) => atLeast(p, POOL_CRIT_PCT)) || m.alerts.critical > 0) return 'red';
  if (m.pools.some(degraded) || m.pools.some((p) => atLeast(p, POOL_WARN_PCT)) || m.alerts.warning > 0) return 'amber';
  return 'green';
}

export interface TruenasRow {
  name: string;
  used: string;
  free: string;
  scanning: boolean;
  level: '' | 'warn' | 'crit';
}
export interface TruenasCard {
  lamp: TruenasLamp;
  chip: string;
  rows: TruenasRow[];
  more: string;
  footer: string;
  error: string;
}

// The lamp already encodes alert severity, so the chip names it too: a red lamp
// beside a bare "1 alert" leaves the reader guessing whether the colour came
// from the alert or from a pool. Critical leads, because it is the one driving
// the colour.
function alertPhrase({ critical, warning }: TruenasMetrics['alerts']): string {
  const parts: string[] = [];
  if (critical) parts.push(`${critical} critical`);
  if (warning) parts.push(`${warning} warning${warning === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function chipFor(m: TruenasMetrics): string {
  const worst = m.pools.find(faulted) ?? m.pools.find(degraded);
  const health = worst ? worst.status.toLowerCase() : 'healthy';
  const alerts = alertPhrase(m.alerts);
  return alerts ? `${health} · ${alerts}` : health;
}

function rowFor(p: TruenasPool): TruenasRow {
  return {
    name: p.name,
    used: p.usedPct == null ? '—' : `${Math.round(p.usedPct)}%`,
    free: `${fmtBytes(p.free)} free`,
    scanning: p.scanning,
    level: atLeast(p, POOL_CRIT_PCT) ? 'crit' : atLeast(p, POOL_WARN_PCT) ? 'warn' : '',
  };
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded NAS shows one error line rather than a grid of
// dashes — blank readings say less than one sentence does.
export function truenasCardModel(svc: Service, snap: ServiceStatusSnapshot | null): TruenasCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', rows: [] as TruenasRow[], more: '', footer: '' };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = truenasLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.truenas) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.truenas;
  const hidden = Math.max(0, m.pools.length - MAX_POOL_ROWS);
  return {
    lamp,
    chip: chipFor(m),
    rows: m.pools.slice(0, MAX_POOL_ROWS).map(rowFor),
    more: hidden ? `+${hidden} more pool${hidden === 1 ? '' : 's'}` : '',
    footer: `${m.version ?? '—'} · up ${fmtUptime(m.uptimeSec)}`,
    error: '',
  };
}

// --- DOM layer -------------------------------------------------------------

export interface TruenasCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the row count changes; otherwise written in place, so a poll
// never disturbs hover or text selection (the tile contract).
export function buildTruenasCard(): TruenasCardEls {
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
  const pools = div('dash-pool-rows');
  const more = div('dash-pool-more');
  const footer = div('dash-card-footer');
  const error = div('dash-card-error');
  root.append(top, pools, more, footer, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = truenasCardModel(svc, snap);
    root.href = svc.url;
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    footer.textContent = model.footer;
    footer.hidden = !model.footer;
    more.textContent = model.more;
    more.hidden = !model.more;
    error.textContent = model.error;
    error.hidden = !model.error;
    root.title = model.error;

    if (pools.children.length !== model.rows.length) {
      pools.replaceChildren(...model.rows.map(() => {
        const row = div('dash-pool-row');
        row.append(div('dash-pool-name'), div('dash-pool-used'), div('dash-pool-free'));
        return row;
      }));
    }
    model.rows.forEach((row, i) => {
      const el = pools.children[i] as HTMLElement;
      el.className = `dash-pool-row${row.level ? ` ${row.level}` : ''}`;
      const nameEl = el.children[0] as HTMLElement;
      nameEl.textContent = row.scanning ? `${row.name} ⟳` : row.name;
      nameEl.title = row.scanning ? 'scrub or resilver in progress' : '';
      (el.children[1] as HTMLElement).textContent = row.used;
      (el.children[2] as HTMLElement).textContent = row.free;
    });
    pools.hidden = model.rows.length === 0;
  }

  return { root, update };
}
