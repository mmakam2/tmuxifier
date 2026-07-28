// Synthetic UniFi Network Integration API v1 payloads. Shapes mirror a live
// controller (see the Probe Findings in
// docs/superpowers/plans/2026-07-28-unifi-service-tile.md); every value is
// invented, because this repo is public. Device *models* are public product
// names and are kept real — device names, addresses, and MACs are not.
export const SITES = {
  offset: 0, limit: 25, count: 1, totalCount: 1,
  data: [{ id: 'site-0001', internalReference: 'default', name: 'Default' }],
};

// Note the gateway's features list: a UCG Max reports only "switching", never
// "gateway". Classification has to lead with the model prefix, and this fixture
// is what keeps that regression caught.
export const DEVICES = {
  offset: 0, limit: 200, count: 4, totalCount: 4,
  data: [
    {
      id: 'dev-gw', macAddress: '00:00:5e:00:53:01', ipAddress: '192.168.1.1',
      name: 'Border Gateway', model: 'UCG Max', state: 'ONLINE',
      supported: true, firmwareVersion: '5.1.19', firmwareUpdatable: false,
      features: ['switching'], interfaces: ['ports'],
    },
    {
      id: 'dev-sw1', macAddress: '00:00:5e:00:53:02', ipAddress: '192.168.1.2',
      name: 'Rack Switch', model: 'USW Flex 2.5G 8 PoE', state: 'ONLINE',
      supported: true, firmwareVersion: '2.1.8', firmwareUpdatable: false,
      features: ['switching'], interfaces: ['ports'],
    },
    {
      id: 'dev-ap1', macAddress: '00:00:5e:00:53:03', ipAddress: '192.168.1.3',
      name: 'Office AP', model: 'U7 Pro Max', state: 'ONLINE',
      supported: true, firmwareVersion: '8.6.11', firmwareUpdatable: false,
      features: ['accessPoint'], interfaces: ['radios'],
    },
    {
      id: 'dev-ap2', macAddress: '00:00:5e:00:53:04', ipAddress: '192.168.1.4',
      name: 'Barn AP', model: 'U7 Pro Outdoor', state: 'OFFLINE',
      supported: true, firmwareVersion: '8.6.11', firmwareUpdatable: false,
      features: ['accessPoint'], interfaces: ['radios'],
    },
  ],
};

// Keyed by device id; the fake server serves these from
// /devices/{id}/statistics/latest. Utilization percentages arrive as floats on
// a real controller, so they are floats here.
export const DEVICE_STATS = {
  'dev-gw': {
    uptimeSec: 353702, lastHeartbeatAt: '2026-07-28T16:29:06Z', nextHeartbeatAt: '2026-07-28T16:29:26Z',
    loadAverage1Min: 3.78, loadAverage5Min: 3.77, loadAverage15Min: 3.67,
    cpuUtilizationPct: 12.4, memoryUtilizationPct: 48.2,
    uplink: { txRateBps: 940000000, rxRateBps: 45000000 }, interfaces: {},
  },
  'dev-sw1': {
    uptimeSec: 7609228, cpuUtilizationPct: 4.1, memoryUtilizationPct: 31.5, interfaces: {},
  },
  'dev-ap1': {
    uptimeSec: 5040105, cpuUtilizationPct: 9.3, memoryUtilizationPct: 40.8, interfaces: {},
  },
  'dev-ap2': {
    uptimeSec: 0, cpuUtilizationPct: null, memoryUtilizationPct: null, interfaces: {},
  },
};

export const CLIENTS_PAGE1 = {
  offset: 0, limit: 200, count: 5, totalCount: 5,
  data: [
    { type: 'WIRED', id: 'cli-1', name: 'storage node', connectedAt: '2026-05-01T14:23:37Z', ipAddress: '192.168.1.20', macAddress: '00:00:5e:00:53:10', uplinkDeviceId: 'dev-sw1', access: { type: 'DEFAULT' } },
    { type: 'WIRED', id: 'cli-2', name: 'workstation', connectedAt: '2026-05-02T09:00:00Z', ipAddress: '192.168.1.21', macAddress: '00:00:5e:00:53:11', uplinkDeviceId: 'dev-sw1', access: { type: 'DEFAULT' } },
    { type: 'WIRELESS', id: 'cli-3', name: 'laptop', connectedAt: '2026-06-11T18:42:10Z', ipAddress: '192.168.1.22', macAddress: '00:00:5e:00:53:12', uplinkDeviceId: 'dev-ap1', access: { type: 'DEFAULT' } },
    { type: 'WIRELESS', id: 'cli-4', name: 'handset', connectedAt: '2026-06-12T07:15:00Z', ipAddress: '192.168.1.23', macAddress: '00:00:5e:00:53:13', uplinkDeviceId: 'dev-ap1', access: { type: 'DEFAULT' } },
    { type: 'WIRELESS', id: 'cli-5', name: 'sensor', connectedAt: '2026-06-13T11:05:00Z', ipAddress: '192.168.1.24', macAddress: '00:00:5e:00:53:14', uplinkDeviceId: 'dev-ap2', access: { type: 'DEFAULT' } },
  ],
};

export const NETWORKS = {
  offset: 0, limit: 200, count: 3, totalCount: 3,
  data: [
    { management: 'GATEWAY', id: 'net-1', name: 'Default', enabled: true, vlanId: 1, metadata: { origin: 'SYSTEM_DEFINED', configurable: true }, default: true },
    { management: 'GATEWAY', id: 'net-2', name: 'Servers', enabled: true, vlanId: 20, metadata: { origin: 'USER_DEFINED', configurable: true }, default: false },
    { management: 'GATEWAY', id: 'net-3', name: 'Guest', enabled: true, vlanId: 30, metadata: { origin: 'USER_DEFINED', configurable: true }, default: false },
  ],
};
