const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const normalizeState = (status) => status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown';
// Parity with proxmoxValidate.js's client-supplied node check (assertProxmoxLinkInput,
// proxmoxValidate.js:97) — the cluster payload is untrusted input too, so a malformed/garbage
// node from it must never reach the stored link or the display.
const SAFE_NODE = /^[A-Za-z0-9_.-]+$/;

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

  // A removed-then-re-added host profile gets a new id, stranding links on the
  // old one. Every link stamps the host endpoint, so an orphaned group can
  // re-home to the unique current host with the same endpoint — verified
  // against that cluster (the vmid must exist) and written with the same
  // CAS + active-job guards as the node auto-follow. Ambiguity (zero or 2+
  // endpoint matches) never guesses; every failure mode degrades to the
  // plain "host profile missing" report.
  async function healGroup(hostBoxes) {
    const orphan = (box) => record(box, { error: 'host profile missing' });
    if (!boxStore) return hostBoxes.map(orphan);
    let hosts;
    try { hosts = await proxmoxStore.listHosts(); } catch { hosts = []; }
    const results = [];
    const byCandidate = new Map();
    for (const box of hostBoxes) {
      const endpoint = box.proxmox.endpoint;
      const matches = endpoint ? hosts.filter((h) => h.endpoint === endpoint) : [];
      if (matches.length !== 1 || activeJobGuard(box.id)) { results.push(orphan(box)); continue; }
      if (!byCandidate.has(matches[0].id)) byCandidate.set(matches[0].id, []);
      byCandidate.get(matches[0].id).push(box);
    }
    for (const [candidateId, candidateBoxes] of byCandidate) {
      let host = null;
      let guests = null;
      try {
        host = await proxmoxStore.getHost(candidateId, { withSecret: true });
        guests = host ? await makeClient(host).clusterResources() : null;
      } catch { guests = null; }
      if (!guests) { results.push(...candidateBoxes.map(orphan)); continue; }
      const present = new Set(guests.filter((g) => g.type === 'lxc').map((g) => Number(g.vmid)));
      const healed = [];
      for (const box of candidateBoxes) {
        if (!present.has(Number(box.proxmox.vmid))) { results.push(orphan(box)); continue; }
        try {
          const fresh = await boxStore.getBox(box.id);
          const freshLink = fresh && fresh.proxmox;
          const stillOrphaned = freshLink
            && freshLink.hostId === box.proxmox.hostId
            && Number(freshLink.vmid) === Number(box.proxmox.vmid);
          if (!stillOrphaned) { results.push(orphan(box)); continue; }
          const link = { ...freshLink, hostId: candidateId };
          await boxStore.setProxmoxLink(box.id, link);
          log(`[tmuxifier] box ${box.label}: host profile re-added as '${host.name}' — re-homed link by endpoint ${freshLink.endpoint}`);
          healed.push({ ...box, proxmox: link });
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not re-home link: ${error.message}`);
          results.push(orphan(box));
        }
      }
      if (healed.length) results.push(...await fetchHost(candidateId, healed));
    }
    return results;
  }

  async function fetchHost(hostId, hostBoxes) {
    let host;
    try {
      host = await proxmoxStore.getHost(hostId, { withSecret: true });
    } catch (error) {
      return hostBoxes.map((box) => record(box, { error: error.message }));
    }
    if (!host) return healGroup(hostBoxes);
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
      // The cluster payload is untrusted: a malformed/missing node must never be written to
      // the link nor shown in the display — fall back to the stored node for both.
      const nodeValid = typeof item.node === 'string' && SAFE_NODE.test(item.node);
      if (!nodeValid) {
        log(`[tmuxifier] box ${box.label}: ignoring malformed node from cluster resources: ${item.node}`);
      } else if (item.node !== box.proxmox.node && boxStore && !activeJobGuard(box.id)) {
        // The cluster list carries the container's CURRENT node. When it differs
        // from the stored link, follow the migration (trusted server-side write:
        // node only, for the already-linked hostId+vmid) — unless a lifecycle
        // job holds a snapshot of the old target; the next poll retries.
        try {
          // CAS-style re-check: re-read the box immediately before writing so a link the
          // user cleared/changed between this poll's snapshot and now is never resurrected.
          const fresh = await boxStore.getBox(box.id);
          const freshLink = fresh && fresh.proxmox;
          const stillLinked = freshLink
            && freshLink.hostId === box.proxmox.hostId
            && freshLink.node === box.proxmox.node
            && Number(freshLink.vmid) === Number(box.proxmox.vmid);
          if (stillLinked) {
            await boxStore.setProxmoxLink(box.id, { ...box.proxmox, node: item.node });
            log(`[tmuxifier] box ${box.label}: container ${box.proxmox.vmid} migrated ${box.proxmox.node} -> ${item.node}`);
          } // else: link changed underneath us — skip silently, that's a user action, not an error
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not follow container migration to ${item.node}: ${error.message}`);
        }
      }
      return record(box, {
        hostName: host.name, node: nodeValid ? item.node : box.proxmox.node,
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
