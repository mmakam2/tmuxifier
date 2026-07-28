import { test, expect } from 'vitest';
import { classifyDevice, buildMetrics } from '../src/server/unifiMetrics.js';
import { DEVICES, DEVICE_STATS, CLIENTS_PAGE1, NETWORKS } from './helpers/unifiSamples.js';

const statsById = new Map(Object.entries(DEVICE_STATS));
const build = (over = {}) => buildMetrics({
  devices: DEVICES.data,
  statsById,
  clients: CLIENTS_PAGE1.data,
  clientsTotal: CLIENTS_PAGE1.totalCount,
  networks: NETWORKS.data,
  ...over,
});

// The regression this exists to catch: a real UCG Max advertises exactly the
// same feature list as a switch, so features alone cannot identify a gateway.
test('classifyDevice identifies a gateway whose only feature is switching, by model', () => {
  expect(classifyDevice({ features: ['switching'], model: 'UCG Max' })).toBe('gateway');
});

test('classifyDevice reads switches and access points from their features', () => {
  expect(classifyDevice({ features: ['switching'], model: 'USW Flex 2.5G 8 PoE' })).toBe('switch');
  expect(classifyDevice({ features: ['accessPoint'], model: 'U7 Pro Max' })).toBe('ap');
});

test('classifyDevice falls back to the model prefix when features are absent', () => {
  expect(classifyDevice({ model: 'UDM Pro' })).toBe('gateway');
  expect(classifyDevice({ model: 'USW-24' })).toBe('switch');
  expect(classifyDevice({ model: 'UAP AC Pro' })).toBe('ap');
  expect(classifyDevice({ model: 'WHAT' })).toBe('other');
  expect(classifyDevice(null)).toBe('other');
});

test('classifyDevice still honours an explicit gateway feature if firmware grows one', () => {
  expect(classifyDevice({ features: ['gateway'], model: 'MYSTERY' })).toBe('gateway');
});

test('buildMetrics counts clients by type and attributes wireless ones to their AP', () => {
  const m = build();
  expect(m.clientsTotal).toBe(5);
  expect(m.clientsWired).toBe(2);
  expect(m.clientsWireless).toBe(3);
  expect(m.aps.clients).toBe(3);
});

test('buildMetrics reports the gateway by name with its load rounded', () => {
  expect(build().gateway).toEqual({ name: 'Border Gateway', cpuPct: 12, memPct: 48, uptimeSec: 353702 });
});

test('buildMetrics tallies each device class and takes the worst cpu across it', () => {
  const m = build();
  expect(m.switches).toEqual({ online: 1, total: 1, cpuPct: 4 });
  expect(m.aps.online).toBe(1);
  expect(m.aps.total).toBe(2);
});

test('buildMetrics names every offline device rather than only counting them', () => {
  expect(build().offline).toEqual([{ name: 'Barn AP', model: 'U7 Pro Outdoor' }]);
});

test('buildMetrics reads the WAN from the gateway uplink', () => {
  const m = build();
  expect(m.wanState).toBe('up');
  expect(m.wanTxBps).toBe(940000000);
  expect(m.wanRxBps).toBe(45000000);
});

test('buildMetrics marks the WAN down when the gateway is offline', () => {
  const devices = DEVICES.data.map((d) => (d.id === 'dev-gw' ? { ...d, state: 'OFFLINE' } : d));
  expect(build({ devices }).wanState).toBe('down');
});

test('buildMetrics reports an unknown WAN when no gateway is adopted', () => {
  const devices = DEVICES.data.filter((d) => d.id !== 'dev-gw');
  const m = build({ devices });
  expect(m.wanState).toBe('unknown');
  expect(m.gateway).toBeNull();
  expect(m.wanTxBps).toBeNull();
});

test('buildMetrics degrades one field at a time when statistics are unavailable', () => {
  const m = build({ statsById: new Map() });
  expect(m.gateway).toEqual({ name: 'Border Gateway', cpuPct: null, memPct: null, uptimeSec: null });
  expect(m.switches.cpuPct).toBeNull();
  expect(m.wanTxBps).toBeNull();
  expect(m.clientsTotal).toBe(5); // unrelated readings survive
});

test('buildMetrics reports a null network count when the endpoint is unavailable', () => {
  expect(build({ networks: null }).networks).toBeNull();
  expect(build().networks).toBe(3);
});

test('buildMetrics prefers the reported total over the fetched page length', () => {
  expect(build({ clientsTotal: 900 }).clientsTotal).toBe(900);
});

test('buildMetrics survives an empty controller without throwing', () => {
  const m = buildMetrics();
  expect(m.gateway).toBeNull();
  expect(m.clientsTotal).toBe(0);
  expect(m.offline).toEqual([]);
  expect(m.switches).toEqual({ online: 0, total: 0, cpuPct: null });
});
