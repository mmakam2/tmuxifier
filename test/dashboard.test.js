import { test, expect } from 'vitest';
import { groupServices, fmtLatency, serviceLamp, dashboardMode, pveHostRollup, nodeModules, partitionInfraGroups, sectionServices, fmtCount, fmtCompact, fmtUptime, piholeCardModel, osLabel, fmtDiskPair, boxSpecLines } from '../src/web/dashboard.ts';

const svc = (id, group, kind = 'http') => ({ id, name: id, url: 'http://x.example.com/', group, check: { kind }, createdAt: '' });

test('groupServices: ungrouped first, then groups in order of first appearance, stored order within', () => {
  const groups = groupServices([svc('a', 'Media'), svc('b', undefined), svc('c', 'Mon'), svc('d', 'Media')]);
  expect(groups.map((g) => g.name)).toEqual([null, 'Media', 'Mon']);
  expect(groups[1].services.map((s) => s.id)).toEqual(['a', 'd']);
});

test('fmtLatency: dash for missing, ms under a second, seconds above', () => {
  expect(fmtLatency(undefined)).toBe('—');
  expect(fmtLatency(12)).toBe('12ms');
  expect(fmtLatency(1234)).toBe('1.2s');
});

test('serviceLamp: none has no lamp, unknown before first sweep, else the result state', () => {
  const s = svc('a', undefined);
  expect(serviceLamp(svc('n', undefined, 'none'), null)).toBe('none');
  expect(serviceLamp(s, null)).toBe('unknown');
  expect(serviceLamp(s, { checkedAt: null, results: {} })).toBe('unknown');
  expect(serviceLamp(s, { checkedAt: 't', results: { a: { state: 'up', latencyMs: 5 } } })).toBe('up');
  expect(serviceLamp(s, { checkedAt: 't', results: { a: { state: 'down', error: 'http 503' } } })).toBe('down');
});

test('dashboardMode: standby only when there is nothing at all to show', () => {
  expect(dashboardMode(0, 0)).toBe('standby');
  expect(dashboardMode(1, 0)).toBe('dash');
  expect(dashboardMode(0, 1)).toBe('dash');
});

test('osLabel: known ids get their real casing, unknown ones are capitalized, version appended', () => {
  expect(osLabel({ osId: 'debian', osVer: '12' })).toBe('Debian 12');
  expect(osLabel({ osId: 'almalinux', osVer: '9.4' })).toBe('AlmaLinux 9.4');
  expect(osLabel({ osId: 'voidlinux' })).toBe('Voidlinux');
  expect(osLabel({ osId: 'arch' })).toBe('Arch');
});

test('osLabel: null when the probe reported no OS (non-Linux, locked-down, or unreachable)', () => {
  expect(osLabel(undefined)).toBeNull();
  expect(osLabel({})).toBeNull();
  expect(osLabel({ osVer: '12' })).toBeNull();
});

test('fmtDiskPair: a shared unit is printed once, a split unit keeps both', () => {
  expect(fmtDiskPair(31200000, 51474912)).toBe('29.8/49.1 GB');
  expect(fmtDiskPair(900000, 51474912)).toBe('879 MB / 49.1 GB');
  expect(fmtDiskPair(undefined, 51474912)).toBe('49.1 GB');
  expect(fmtDiskPair(31200000, undefined)).toBeNull();
});

test('boxSpecLines: identity line then capacity line', () => {
  expect(boxSpecLines({
    reachable: true,
    metrics: { osId: 'debian', osVer: '12', cpus: 8, memTotalKb: 16 * 1024 * 1024, diskTotalKb: 51474912, diskUsedKb: 31200000 },
  })).toEqual(['Debian 12 · 8 cores', '16 GB RAM · 29.8/49.1 GB disk']);
});

test('boxSpecLines: one core is singular', () => {
  expect(boxSpecLines({ reachable: true, metrics: { cpus: 1 } })).toEqual(['1 core']);
});

test('boxSpecLines: a line with nothing known is dropped rather than printed empty', () => {
  expect(boxSpecLines({ reachable: true, metrics: { memTotalKb: 2 * 1024 * 1024 } })).toEqual(['2 GB RAM']);
  expect(boxSpecLines({ reachable: true, metrics: {} })).toEqual([]);
  expect(boxSpecLines({ reachable: false })).toEqual([]);
  expect(boxSpecLines(undefined)).toEqual([]);
});

test('pveHostRollup groups containers per host with running/stopped counts', () => {
  const c = (hostName, state) => ({ hostName, state, boxId: 'b', boxLabel: 'b', hostId: 'h', node: 'n', vmid: 1, containerName: null, fetchedAt: 0, error: null, activeJob: null });
  expect(pveHostRollup([c('pve1', 'running'), c('pve1', 'stopped'), c('pve2', 'running'), c('pve1', 'unknown')])).toEqual([
    { hostName: 'pve1', running: 1, stopped: 1, other: 1 },
    { hostName: 'pve2', running: 1, stopped: 0, other: 0 },
  ]);
});

test('nodeModules: per-node health readout with linked-container counts merged', () => {
  const nodes = [
    { hostId: 'H1', hostName: 'lab', node: 'pve1', status: 'online', cpuPct: 12, memPct: 48, diskPct: 61, uptimeSec: 3600, error: null },
    { hostId: 'H1', hostName: 'lab', node: 'pve2', status: 'offline', cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: null },
    { hostId: 'H3', hostName: 'lab2', node: null, status: 'error', cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: 'connect ECONNREFUSED' },
  ];
  const c = (node, state) => ({ node, state, hostName: 'lab', boxId: 'b', boxLabel: 'b', hostId: 'H1', vmid: 1, containerName: null, fetchedAt: 0, error: null, activeJob: null });
  expect(nodeModules(nodes, [c('pve1', 'running'), c('pve1', 'stopped'), c('pve1', 'running')])).toEqual([
    { name: 'pve1', lamp: 'green', readout: 'cpu 12% · mem 48% · disk 61% · 2/3 ctr' },
    { name: 'pve2', lamp: 'red', readout: '—' },
    { name: 'lab2', lamp: 'red', readout: 'connect ECONNREFUSED' },
  ]);
});

test('nodeModules: unknown status gets a dark lamp; no containers, no ctr segment', () => {
  const nodes = [{ hostId: 'H1', hostName: 'lab', node: 'pve1', status: 'unknown', cpuPct: 5, memPct: null, diskPct: null, uptimeSec: null, error: null }];
  expect(nodeModules(nodes, null)).toEqual([{ name: 'pve1', lamp: '', readout: 'cpu 5%' }]);
});

test('partitionInfraGroups: proxmox/ipam categories merge into the built-ins, others become extra groups', () => {
  const s = (id, section, group) => ({ ...svc(id, group), section });
  const parts = partitionInfraGroups([
    s('a', 'infrastructure', 'Proxmox'),
    s('b', 'infrastructure', 'IPAM'),
    s('c', 'infrastructure', 'DNS Filtering'),
    s('d', 'infrastructure', undefined),
    s('e', 'services', 'Media'),      // not infrastructure — excluded
    s('f', undefined, 'Media'),       // legacy record, defaults to services — excluded
  ]);
  expect(parts.proxmox.map((x) => x.id)).toEqual(['a']);
  expect(parts.ipam.map((x) => x.id)).toEqual(['b']);
  expect(parts.extra.map((g) => [g.name, g.services.map((x) => x.id)])).toEqual([
    [null, ['d']],
    ['DNS Filtering', ['c']],
  ]);
});

test('sectionServices keeps only the services section, defaulting legacy records in', () => {
  const s = (id, section) => ({ ...svc(id, undefined), section });
  expect(sectionServices([s('a', 'services'), s('b', 'infrastructure'), s('c', undefined)]).map((x) => x.id)).toEqual(['a', 'c']);
});

const piSvc = { id: 'p', name: 'pihole', url: 'http://x.example.com/', check: { kind: 'pihole' }, createdAt: '' };
const metrics = {
  blocking: 'enabled', blockingTimer: null,
  queriesTotal: 48132, queriesBlocked: 10780, percentBlocked: 22.396,
  clientsActive: 31, clientsTotal: 54, gravityDomains: 1284933,
  versionCore: 'v6.2.1', versionWeb: 'v6.2', versionFtl: 'v6.2.3',
  updateAvailable: false, uptimeSec: 1220400,
};
const snap = (result) => ({ checkedAt: '2026-07-27T00:00:00.000Z', results: { p: result } });

test('fmtCount groups thousands and dashes a missing number', () => {
  expect(fmtCount(48132)).toBe('48,132');
  expect(fmtCount(0)).toBe('0');
  expect(fmtCount(null)).toBe('—');
});

test('fmtCompact abbreviates millions and thousands', () => {
  expect(fmtCompact(1284933)).toBe('1.28M');
  expect(fmtCompact(250000)).toBe('250.0k');
  expect(fmtCompact(9999)).toBe('9,999');
  expect(fmtCompact(null)).toBe('—');
});

test('fmtUptime reads in the largest two units', () => {
  expect(fmtUptime(1220400)).toBe('14d 3h');
  expect(fmtUptime(11520)).toBe('3h 12m');
  expect(fmtUptime(480)).toBe('8m');
  expect(fmtUptime(0)).toBe('0m');
  expect(fmtUptime(null)).toBe('—');
});

test('piholeCardModel lays out all six readings', () => {
  const card = piholeCardModel(piSvc, snap({ state: 'up', latencyMs: 40, pihole: metrics }));
  expect(card.lamp).toBe('green');
  expect(card.chip).toBe('blocking on');
  expect(card.error).toBe('');
  expect(card.rows).toEqual([
    { label: 'QUERIES', value: '48,132' },
    { label: 'BLOCKED', value: '22.4%' },
    { label: 'CLIENTS', value: '31/54' },
    { label: 'DOMAINS', value: '1.28M' },
    { label: 'VERSION', value: 'v6.2.1' },
    { label: 'UPTIME', value: '14d 3h' },
  ]);
});

test('piholeCardModel marks an available update on the version row', () => {
  const card = piholeCardModel(piSvc, snap({ state: 'up', pihole: { ...metrics, updateAvailable: true } }));
  expect(card.rows.find((r) => r.label === 'VERSION').value).toBe('v6.2.1 ↑');
});

test('piholeCardModel shows the remaining timer while blocking is disabled', () => {
  const off = piholeCardModel(piSvc, snap({ state: 'up', pihole: { ...metrics, blocking: 'disabled', blockingTimer: 1680 } }));
  expect(off.chip).toBe('blocking off · 28m left');
  const indefinite = piholeCardModel(piSvc, snap({ state: 'up', pihole: { ...metrics, blocking: 'disabled', blockingTimer: null } }));
  expect(indefinite.chip).toBe('blocking off');
});

test('piholeCardModel renders the three degraded states instead of numbers', () => {
  const auth = piholeCardModel(piSvc, snap({ state: 'auth', error: 'app password rejected' }));
  expect(auth).toMatchObject({ lamp: 'auth', rows: [], chip: '', error: 'app password rejected' });

  const down = piholeCardModel(piSvc, snap({ state: 'down', error: 'timeout' }));
  expect(down).toMatchObject({ lamp: 'red', rows: [], error: 'timeout' });

  const pending = piholeCardModel(piSvc, null);
  expect(pending).toMatchObject({ lamp: '', rows: [], error: '' });
});

test('serviceLamp surfaces the auth state', () => {
  expect(serviceLamp(piSvc, snap({ state: 'auth', error: 'x' }))).toBe('auth');
});
