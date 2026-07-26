import { test, expect } from 'vitest';
import { groupServices, fmtLatency, serviceLamp, dashboardMode, pveHostRollup, nodeModules } from '../src/web/dashboard.ts';

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
