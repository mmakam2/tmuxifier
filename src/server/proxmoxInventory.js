const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const normalizeState = (status) => status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown';

export function mergeProxmoxStatus(snapshot, boxes, records) {
  const next = { ...snapshot };
  const byBox = new Map((records || []).map((record) => [record.boxId, record]));
  for (const box of boxes) {
    if (!box.proxmox) continue;
    const record = byBox.get(box.id);
    if (!record) continue;
    next[box.id] = {
      ...(next[box.id] || { reachable: false }),
      proxmoxState: record.state,
      proxmoxNode: record.node,
      proxmoxVmid: record.vmid,
    };
  }
  return next;
}

export function createProxmoxInventory({
  proxmoxStore,
  makeClient,
  boxStore = null,
  now = () => Date.now(),
  freshnessMs = 60_000,
  log = (...args) => console.log(...args),
}) {
  const cache = new Map();
  let inFlight = null;
  // Late-bound by index.js once the lifecycle manager exists: a drift write
  // must not rewrite a link that a running job snapshotted (resolveTarget
  // would abort the job). Defaults open so tests without jobs need no wiring.
  let activeJobGuard = () => false;

  const record = (box, fields) => ({
    boxId: box.id, boxLabel: box.label, hostId: box.proxmox.hostId, hostName: null,
    node: box.proxmox.node, vmid: Number(box.proxmox.vmid), containerName: null,
    state: 'unknown', fetchedAt: now(), error: null, ...fields,
  });

  async function fetchHost(hostId, hostBoxes) {
    let host;
    try {
      host = await proxmoxStore.getHost(hostId, { withSecret: true });
    } catch (error) {
      return hostBoxes.map((box) => record(box, { error: error.message }));
    }
    if (!host) return hostBoxes.map((box) => record(box, { error: 'host profile missing' }));
    let guests;
    try {
      guests = await makeClient(host).clusterResources();
    } catch (error) {
      return hostBoxes.map((box) => record(box, { hostName: host.name, error: error.message }));
    }
    const byVmid = new Map((guests || []).filter((g) => g.type === 'lxc').map((g) => [Number(g.vmid), g]));
    return Promise.all(hostBoxes.map(async (box) => {
      const item = byVmid.get(Number(box.proxmox.vmid));
      if (!item) return record(box, { hostName: host.name, state: 'missing' });
      // The cluster list carries the container's CURRENT node. When it differs
      // from the stored link, follow the migration (trusted server-side write:
      // node only, for the already-linked hostId+vmid) — unless a lifecycle
      // job holds a snapshot of the old target; the next poll retries.
      if (item.node !== box.proxmox.node && boxStore && !activeJobGuard(box.id)) {
        try {
          await boxStore.setProxmoxLink(box.id, { ...box.proxmox, node: item.node });
          log(`[tmuxifier] box ${box.label}: container ${box.proxmox.vmid} migrated ${box.proxmox.node} -> ${item.node}`);
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not follow container migration to ${item.node}: ${error.message}`);
        }
      }
      return record(box, {
        hostName: host.name, node: item.node,
        containerName: item.name || null, state: normalizeState(item.status),
      });
    }));
  }

  async function doRefresh(boxes) {
    const groups = new Map();
    for (const box of boxes.filter((item) => item.proxmox)) {
      const hostId = box.proxmox.hostId;
      if (!groups.has(hostId)) groups.set(hostId, []);
      groups.get(hostId).push(box);
    }
    const records = (await Promise.all(
      [...groups.entries()].map(([hostId, hostBoxes]) => fetchHost(hostId, hostBoxes)),
    )).flat();
    for (const item of records) cache.set(item.boxId, item);
    return records;
  }

  function refreshLinked(boxes) {
    if (inFlight) return inFlight;
    inFlight = doRefresh(boxes).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    refreshLinked,
    setActiveJobGuard(fn) { activeJobGuard = fn; },
    async refreshBox(box) { return (await doRefresh([box]))[0]; },
    async getLinkedContainers(boxes) { return refreshLinked(boxes); },
    async listNodeContainers(hostId, node, boxes) {
      const host = await proxmoxStore.getHost(hostId, { withSecret: true });
      if (!host) throw new Error('proxmox host not found');
      const linked = new Map(boxes.filter((box) => box.proxmox).map((box) => [targetKey(box.proxmox), box.id]));
      return (await makeClient(host).listLxc(node)).map((item) => ({
        hostId, node, vmid: Number(item.vmid), name: item.name || String(item.vmid),
        state: normalizeState(item.status),
        linkedBoxId: linked.get(targetKey({ hostId, node, vmid: item.vmid })) || null,
      }));
    },
    stateFor(box) {
      const record = box.proxmox ? cache.get(box.id) : undefined;
      return record && now() - record.fetchedAt <= freshnessMs ? record : undefined;
    },
  };
}
