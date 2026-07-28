// The Immich card: a service tile that reports the photo library instead of a
// status line. Pure view-model first, DOM second — same split as unifiCard.ts,
// and the reason this lives in its own file rather than growing dashboard.ts.
import type { ImmichJobs, ImmichMetrics, Service, ServiceResult, ServiceStatusSnapshot } from './api';
import { fmtBytes, fmtCompact, fmtCount } from './fmt';
import { buildServiceIcon } from './serviceIcon';

// A volume this full is what a storage reading exists to surface, so capacity
// drives the lamp rather than waiting for the operator to notice. Same
// thresholds as the TrueNAS pool rows, deliberately.
export const DISK_WARN_PCT = 80;
export const DISK_CRIT_PCT = 90;
// Beyond this the exception line would wrap the card; the rest is counted.
export const MAX_NAMED_PAUSED = 3;

// What each permission actually buys, so a refusal names the missing reading
// rather than only the scope string.
const READING_FOR: Record<string, string> = {
  'server.about': 'the version',
  'server.storage': 'disk usage',
  'server.statistics': 'library counts',
  'job.read': 'jobs',
  'server.versionCheck': 'update checks',
  'systemConfig.read': 'maintenance mode',
};

export type ImmichLamp = 'green' | 'amber' | 'red' | 'auth' | '';

export interface ImmichCell { label: string; value: string }
export interface ImmichRow { label: string; value: string }
export interface ImmichCard {
  lamp: ImmichLamp;
  chip: string;
  exception: string;
  note: string;
  cells: ImmichCell[];
  rows: ImmichRow[];
  error: string;
}

export function immichLamp(r: ServiceResult | undefined): ImmichLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.immich;
  if (r.state === 'down' || !m) return 'red';
  if (m.diskUsedPct != null && m.diskUsedPct >= DISK_CRIT_PCT) return 'red';
  if (m.diskUsedPct != null && m.diskUsedPct >= DISK_WARN_PCT) return 'amber';
  // Deliberately amber rather than red: the server is not serving, but it is
  // deliberately not serving — the same distinction that separates TrueNAS's
  // DEGRADED from FAULTED.
  if (m.maintenanceMode) return 'amber';
  if (m.jobs && (m.jobs.failed > 0 || m.jobs.paused.length > 0)) return 'amber';
  // An available update and a denied permission are both deliberately absent
  // here: neither is a fault, and colouring them would train the operator to
  // ignore the lamp.
  return 'green';
}

const joinList = (parts: string[]): string =>
  (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

export function deniedNote(denied: string[]): string {
  if (!denied.length) return '';
  const readings = denied.map((p) => READING_FOR[p] ?? p);
  return `needs ${joinList(denied)} for ${joinList(readings)}`;
}

export function immichException(m: ImmichMetrics): string {
  if (m.maintenanceMode) return 'maintenance mode — the server is not serving users';
  if (m.jobs?.failed) return `${fmtCount(m.jobs.failed)} failed job${m.jobs.failed === 1 ? '' : 's'}`;
  if (m.jobs?.paused.length) {
    // Named, not counted: a tally cannot tell you which queue to go restart.
    const named = m.jobs.paused.slice(0, MAX_NAMED_PAUSED).join(', ');
    const hidden = m.jobs.paused.length - MAX_NAMED_PAUSED;
    return hidden > 0 ? `${named} +${hidden} more paused` : `${named} paused`;
  }
  return '';
}

function jobsValue(j: ImmichJobs): string {
  const parts: string[] = [];
  if (j.active) parts.push(`${fmtCount(j.active)} active`);
  if (j.waiting) parts.push(`${fmtCount(j.waiting)} waiting`);
  if (j.failed) parts.push(`${fmtCount(j.failed)} failed`);
  return parts.length ? parts.join(' · ') : 'idle';
}

// The chip has room for one clause about the queues, so it leads with the worst
// thing true of them rather than repeating the whole rollup.
function chipJobs(j: ImmichJobs): string {
  if (j.failed) return `${fmtCount(j.failed)} failed`;
  if (j.active) return `${fmtCount(j.active)} active`;
  if (j.waiting) return `${fmtCount(j.waiting)} waiting`;
  return 'jobs idle';
}

// LIBRARY is statistics.usage and DISK is the whole volume: different numbers
// with different meanings, and collapsing them would be a defect.
function cellsFor(m: ImmichMetrics): ImmichCell[] {
  return [
    { label: 'PHOTOS', value: fmtCompact(m.photos) },
    { label: 'VIDEOS', value: fmtCompact(m.videos) },
    { label: 'LIBRARY', value: fmtBytes(m.libraryBytes) },
    { label: 'DISK', value: m.diskUsedPct == null ? '—' : `${m.diskUsedPct}%` },
    { label: 'FREE', value: fmtBytes(m.diskFreeBytes) },
    { label: 'VERSION', value: m.version ?? '—' },
  ];
}

// A reading the key cannot fetch earns no row — an empty row says less than its
// absence does, and the note already explains why it is missing.
function rowsFor(m: ImmichMetrics): ImmichRow[] {
  const rows: ImmichRow[] = [];
  if (m.jobs) rows.push({ label: 'JOBS', value: jobsValue(m.jobs) });
  if (m.users != null) {
    const parts = [fmtCount(m.users)];
    if (m.topUser?.bytes != null) parts.push(`${fmtBytes(m.topUser.bytes)} largest (${m.topUser.name})`);
    rows.push({ label: 'USERS', value: parts.join(' · ') });
  }
  if (m.updateAvailable && m.releaseVersion) {
    rows.push({ label: 'UPDATE', value: `${m.releaseVersion} available` });
  }
  return rows;
}

function chipFor(m: ImmichMetrics): string {
  const size = m.libraryBytes != null ? fmtBytes(m.libraryBytes) : (m.version ?? '');
  const jobs = m.jobs ? chipJobs(m.jobs) : '';
  return [size, jobs].filter(Boolean).join(' · ');
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded server shows one error line rather than a grid
// of dashes — blank readings say less than one sentence does.
export function immichCardModel(svc: Service, snap: ServiceStatusSnapshot | null): ImmichCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', exception: '', note: '', cells: [] as ImmichCell[], rows: [] as ImmichRow[] };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = immichLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.immich) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.immich;
  return {
    lamp,
    chip: chipFor(m),
    exception: immichException(m),
    note: deniedNote(m.denied),
    cells: cellsFor(m),
    rows: rowsFor(m),
    error: '',
  };
}

// --- DOM layer -------------------------------------------------------------

export interface ImmichCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the cell or row count changes; otherwise written in place,
// so a poll never disturbs hover or text selection (the tile contract).
export function buildImmichCard(): ImmichCardEls {
  const div = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  };
  const root = document.createElement('a');
  root.className = 'dash-tile dash-tile-wide';
  root.target = '_blank';
  root.rel = 'noopener';
  const icon = buildServiceIcon();
  const lamp = document.createElement('span');
  lamp.className = 'dot';
  const name = div('dash-tile-name');
  const chip = document.createElement('span');
  chip.className = 'dash-card-chip';
  const top = div('dash-tile-top');
  top.append(icon.root, lamp, name, chip);
  const exception = div('dash-card-warn');
  // A permission gap and an operational warning are different classes of
  // statement, so they get their own slots rather than competing for one.
  const note = div('dash-card-note');
  const grid = div('dash-card-grid');
  const rows = div('dash-card-rows');
  const error = div('dash-card-error');
  root.append(top, exception, note, grid, rows, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = immichCardModel(svc, snap);
    root.href = svc.url;
    icon.update(svc);
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    exception.textContent = model.exception;
    exception.hidden = !model.exception;
    note.textContent = model.note;
    note.hidden = !model.note;
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
        const row = div('dash-card-row');
        row.append(div('dash-card-rowlabel'), div('dash-card-rowvalue'));
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
