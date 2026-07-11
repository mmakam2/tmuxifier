import { test, expect } from 'vitest';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const linked = (id, node, vmid) => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, endpoint: HOST.endpoint },
});

function setup({ cluster = [], listByNode = {}, boxStore = null, guard } = {}) {
  const calls = { cluster: 0, nodes: [] };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({
      clusterResources: async () => { calls.cluster += 1; return cluster; },
      listLxc: async (node) => { calls.nodes.push(node); return listByNode[node] || []; },
    }),
    boxStore,
    now: () => 1000,
    freshnessMs: 60_000,
    log: () => {},
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, calls };
}

test('refreshLinked makes one cluster call per host and maps vmids across nodes', async () => {
  const { inventory, calls } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' },
    { vmid: 132, node: 'pve', type: 'lxc', status: 'stopped', name: 'dev-02' },
    { vmid: 140, node: 'pve2', type: 'lxc', status: 'running', name: 'db-01' },
  ] });
  const records = await inventory.refreshLinked([
    linked('b1', 'pve', 131), linked('b2', 'pve', 132), linked('b3', 'pve2', 140),
  ]);
  expect(calls.cluster).toBe(1); // one call for the whole host, regardless of node spread
  expect(records.map((r) => [r.boxId, r.state, r.node])).toEqual([
    ['b1', 'running', 'pve'], ['b2', 'stopped', 'pve'], ['b3', 'running', 'pve2'],
  ]);
});

test('a migrated container stays healthy, reports its new node, and the link auto-follows', async () => {
  const writes = [];
  const boxStore = { setProxmoxLink: async (id, link) => writes.push([id, link]) };
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore,
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('proxmox03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'proxmox03', vmid: 165, endpoint: HOST.endpoint }]]);
});

test('the drift write is skipped while a lifecycle job is active on the box', async () => {
  const writes = [];
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]) },
    guard: (boxId) => boxId === 'b1',
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.node).toBe('proxmox03'); // display still follows
  expect(writes).toEqual([]);            // store write deferred to a later poll
});

test('a failing drift write is best-effort: logged, record still healthy', async () => {
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async () => { throw new Error('disk full'); } },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(logged.some((line) => line.includes('disk full'))).toBe(true);
});

test('missing means absent from the whole cluster; qemu entries never match', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve2', type: 'qemu', status: 'running', name: 'a-vm' }, // same vmid, wrong type
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.state).toBe('missing');
  expect(record.node).toBe('pve'); // stored node kept for display when missing
});

test('one host failing leaves another host healthy (per-host isolation)', async () => {
  const HOSTS = { H1: HOST, H2: { ...HOST, id: 'H2', name: 'lab2' } };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => HOSTS[id] },
    makeClient: (host) => ({ clusterResources: async () => {
      if (host.id === 'H2') throw new Error('PVE down');
      return [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev' }];
    } }),
    now: () => 1000, log: () => {},
  });
  const b2 = { ...linked('b2', 'pve', 140), proxmox: { hostId: 'H2', node: 'pve', vmid: 140, endpoint: 'x:8006' } };
  const records = await inventory.refreshLinked([linked('b1', 'pve', 131), b2]);
  const byId = Object.fromEntries(records.map((r) => [r.boxId, r]));
  expect(byId.b1.state).toBe('running');
  expect(byId.b2.state).toBe('unknown');
  expect(byId.b2.error).toBe('PVE down');
});

test('overlapping refreshes coalesce', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => { calls += 1; await gate; return [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running' }]; } }),
  });
  const first = inventory.refreshLinked([box]);
  const second = inventory.refreshLinked([box]);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test('legacy duplicate links retain box-specific records while sharing one host request', async () => {
  const { inventory, calls } = setup({ cluster: [{ vmid: 131, node: 'pve', type: 'lxc', name: 'dev-01', status: 'running' }] });
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 131)];
  const records = await inventory.refreshLinked(boxes);
  expect(records.map((record) => record.boxId)).toEqual(['b1', 'b2']);
  expect(inventory.stateFor(boxes[0]).boxId).toBe('b1');
  expect(inventory.stateFor(boxes[1]).boxId).toBe('b2');
  expect(calls.cluster).toBe(1);
});

test('stateFor expires cached display authority', async () => {
  let at = 1000;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 131, node: 'pve', type: 'lxc', status: 'stopped' }] }),
    now: () => at,
    freshnessMs: 100,
  });
  await inventory.refreshBox(box);
  expect(inventory.stateFor(box).state).toBe('stopped');
  at = 1101;
  expect(inventory.stateFor(box)).toBeUndefined();
});

test('listNodeContainers annotates existing links', async () => {
  const { inventory } = setup({ listByNode: { pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'free', status: 'stopped' }] } });
  expect(await inventory.listNodeContainers('H1', 'pve', [linked('b1', 'pve', 131)])).toEqual([
    { hostId: 'H1', node: 'pve', vmid: 131, name: 'dev-01', state: 'running', linkedBoxId: 'b1' },
    { hostId: 'H1', node: 'pve', vmid: 132, name: 'free', state: 'stopped', linkedBoxId: null },
  ]);
});

test('a throwing getHost yields unknown for that host only', async () => {
  const b1 = linked('b1', 'pve', 131);
  const b2 = { id: 'b2', label: 'b2', host: '192.168.1.40', proxmox: { hostId: 'H2', node: 'pve', vmid: 140 } };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => { if (id === 'H2') throw new Error('seal open failed'); return HOST; } },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 131, node: 'pve', type: 'lxc', name: 'dev-01', status: 'running' }] }),
    now: () => 1000,
  });
  const records = await inventory.refreshLinked([b1, b2]);
  const byId = new Map(records.map((record) => [record.boxId, record]));
  expect(records).toHaveLength(2);
  expect(byId.get('b1')).toMatchObject({ state: 'running', containerName: 'dev-01', error: null });
  expect(byId.get('b2')).toMatchObject({
    state: 'unknown', hostId: 'H2', node: 'pve', vmid: 140,
    containerName: null, hostName: null, error: 'seal open failed',
  });
});

test('mergeProxmoxStatus adds state without hiding reachable missing links', () => {
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 132)];
  const merged = mergeProxmoxStatus(
    { b1: { reachable: false, error: 'timeout' }, b2: { reachable: true, tmux: true } },
    boxes,
    [
      { boxId: 'b1', state: 'stopped', node: 'pve', vmid: 131 },
      { boxId: 'b2', state: 'missing', node: 'pve', vmid: 132 },
    ],
  );
  expect(merged.b1).toMatchObject({ reachable: false, proxmoxState: 'stopped', proxmoxVmid: 131 });
  expect(merged.b2).toMatchObject({ reachable: true, proxmoxState: 'missing' });
});
