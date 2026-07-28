import { test, expect } from 'vitest';
import { unifiCardModel, unifiLamp, fmtBitrate, CPU_WARN_PCT } from '../src/web/unifiCard.ts';

const METRICS = {
  clientsTotal: 96, clientsWired: 61, clientsWireless: 35, networks: 16,
  wanState: 'up', wanTxBps: 940000000, wanRxBps: 45000000,
  gateway: { name: 'Border Gateway', cpuPct: 12, memPct: 48, uptimeSec: 353702 },
  switches: { online: 3, total: 3, cpuPct: 4 },
  aps: { online: 3, total: 3, cpuPct: 9, clients: 35 },
  offline: [],
};
const svc = { id: 'svc-1', name: 'UniFi', url: 'https://unifi.example.com', check: { kind: 'unifi' }, createdAt: '' };
const snapOf = (result) => ({ checkedAt: 'now', results: { 'svc-1': result } });
const model = (result) => unifiCardModel(svc, snapOf(result));

test('fmtBitrate reads bit rates in decimal units, not fmtBytes binary ones', () => {
  expect(fmtBitrate(null)).toBe('—');
  expect(fmtBitrate(940000000)).toBe('940 Mbps');
  expect(fmtBitrate(45000000)).toBe('45 Mbps');
  expect(fmtBitrate(2400000000)).toBe('2.4 Gbps');
  expect(fmtBitrate(512000)).toBe('512 Kbps');
  expect(fmtBitrate(0)).toBe('0 bps');
});

test('unifiLamp is blank before the first sweep', () => {
  expect(unifiLamp(undefined)).toBe('');
});

test('unifiLamp is green when everything is online', () => {
  expect(unifiLamp({ state: 'up', unifi: METRICS })).toBe('green');
});

test('unifiLamp is auth when the key was rejected, outranking the metrics', () => {
  expect(unifiLamp({ state: 'auth', unifi: METRICS })).toBe('auth');
});

test('unifiLamp is red when the controller is unreachable', () => {
  expect(unifiLamp({ state: 'down' })).toBe('red');
});

test('unifiLamp is red when the WAN is down', () => {
  expect(unifiLamp({ state: 'up', unifi: { ...METRICS, wanState: 'down' } })).toBe('red');
});

test('unifiLamp is amber when a device is offline', () => {
  expect(unifiLamp({ state: 'up', unifi: { ...METRICS, offline: [{ name: 'Barn AP', model: 'U7 Pro Outdoor' }] } })).toBe('amber');
});

test('unifiLamp is amber when the gateway cpu is pegged', () => {
  expect(unifiLamp({ state: 'up', unifi: { ...METRICS, gateway: { ...METRICS.gateway, cpuPct: CPU_WARN_PCT } } })).toBe('amber');
});

test('unifiCardModel summarizes wan state and the adopted-device count in the chip', () => {
  expect(model({ state: 'up', unifi: METRICS }).chip).toBe('wan up · 7/7 online');
});

test('unifiCardModel renders the six census cells', () => {
  const cells = model({ state: 'up', unifi: METRICS }).cells;
  expect(cells.map((c) => c.label)).toEqual(['CLIENTS', 'WIRED', 'WIRELESS', 'NETWORKS', 'WAN', 'UPTIME']);
  expect(cells[0].value).toBe('96');
  expect(cells[3].value).toBe('16');
});

test('unifiCardModel reads the WAN in bits per second, sharing one unit label', () => {
  expect(model({ state: 'up', unifi: METRICS }).cells[4].value).toBe('940/45 Mbps');
});

test('unifiCardModel dashes an unavailable cell without disturbing the others', () => {
  const cells = model({ state: 'up', unifi: { ...METRICS, networks: null, wanTxBps: null, wanRxBps: null } }).cells;
  expect(cells[3].value).toBe('—');
  expect(cells[4].value).toBe('—');
  expect(cells[0].value).toBe('96');
});

test('unifiCardModel names the gateway and tallies the other classes', () => {
  expect(model({ state: 'up', unifi: METRICS }).rows).toEqual([
    { label: 'GATEWAY', value: 'Border Gateway · cpu 12% · mem 48%' },
    { label: 'SWITCHES', value: '3/3 online · cpu 4%' },
    { label: 'APS', value: '3/3 online · 35 clients' },
  ]);
});

test('unifiCardModel omits a device class the site does not have', () => {
  const rows = model({ state: 'up', unifi: { ...METRICS, switches: { online: 0, total: 0, cpuPct: null } } }).rows;
  expect(rows.map((r) => r.label)).toEqual(['GATEWAY', 'APS']);
});

test('unifiCardModel names offline devices rather than counting them', () => {
  const m = model({ state: 'up', unifi: { ...METRICS, offline: [{ name: 'Barn AP', model: 'U7 Pro Outdoor' }] } });
  expect(m.exception).toBe('Barn AP offline');
});

test('unifiCardModel summarizes when more devices are offline than it can name', () => {
  const offline = ['A', 'B', 'C', 'D'].map((name) => ({ name, model: '' }));
  expect(model({ state: 'up', unifi: { ...METRICS, offline } }).exception).toBe('A, B, C +1 more offline');
});

test('unifiCardModel shows one error line instead of a grid of dashes when unreachable', () => {
  const m = model({ state: 'down', error: 'connect ECONNREFUSED' });
  expect(m.cells).toEqual([]);
  expect(m.rows).toEqual([]);
  expect(m.error).toBe('connect ECONNREFUSED');
});

test('unifiCardModel reports an auth failure as its own message', () => {
  const m = model({ state: 'auth', error: 'the controller rejected the API key (HTTP 401)' });
  expect(m.lamp).toBe('auth');
  expect(m.error).toMatch(/rejected the API key/);
});

test('unifiCardModel is blank before the first sweep', () => {
  expect(unifiCardModel(svc, null)).toEqual({ lamp: '', chip: '', exception: '', cells: [], rows: [], error: '' });
});
