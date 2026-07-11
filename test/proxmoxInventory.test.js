import { test, expect } from 'vitest';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const linked = (id, node, vmid) => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, endpoint: HOST.endpoint },
});

function setup(listByNode = {}) {
  const calls = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({ listLxc: async (node) => { calls.push(node); return listByNode[node] || []; } }),
    now: () => 1000,
    freshnessMs: 60_000,
  });
  return { inventory, calls };
}

test('refreshLinked batches exactly once per host/node and maps VMIDs', async () => {
  const { inventory, calls } = setup({
    pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'dev-02', status: 'stopped' }],
    pve2: [{ vmid: 140, name: 'db-01', status: 'running' }],
  });
  const records = await inventory.refreshLinked([
    linked('b1', 'pve', 131), linked('b2', 'pve', 132), linked('b3', 'pve2', 140),
  ]);
  expect(calls.sort()).toEqual(['pve', 'pve2']);
  expect(records.map((record) => [record.boxId, record.state])).toEqual([
    ['b1', 'running'], ['b2', 'stopped'], ['b3', 'running'],
  ]);
});

test('missing target is explicit and failed host/node becomes unknown', async () => {
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({ listLxc: async (node) => { if (node === 'bad') throw new Error('PVE down'); return []; } }),
    now: () => 1000,
  });
  expect((await inventory.refreshBox(linked('missing', 'pve', 131))).state).toBe('missing');
  expect((await inventory.refreshBox(linked('bad', 'bad', 132))).state).toBe('unknown');
});

test('overlapping refreshes coalesce', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ listLxc: async () => { calls += 1; await gate; return [{ vmid: 131, status: 'running' }]; } }),
  });
  const first = inventory.refreshLinked([box]);
  const second = inventory.refreshLinked([box]);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test('legacy duplicate links retain box-specific records while sharing one node request', async () => {
  const { inventory, calls } = setup({ pve: [{ vmid: 131, name: 'dev-01', status: 'running' }] });
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 131)];
  const records = await inventory.refreshLinked(boxes);
  expect(records.map((record) => record.boxId)).toEqual(['b1', 'b2']);
  expect(inventory.stateFor(boxes[0]).boxId).toBe('b1');
  expect(inventory.stateFor(boxes[1]).boxId).toBe('b2');
  expect(calls).toEqual(['pve']);
});

test('stateFor expires cached display authority', async () => {
  let at = 1000;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ listLxc: async () => [{ vmid: 131, status: 'stopped' }] }),
    now: () => at,
    freshnessMs: 100,
  });
  await inventory.refreshBox(box);
  expect(inventory.stateFor(box).state).toBe('stopped');
  at = 1101;
  expect(inventory.stateFor(box)).toBeUndefined();
});

test('listNodeContainers annotates existing links', async () => {
  const { inventory } = setup({ pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'free', status: 'stopped' }] });
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
    makeClient: () => ({ listLxc: async () => [{ vmid: 131, name: 'dev-01', status: 'running' }] }),
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
