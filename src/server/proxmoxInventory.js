import { mapWithConcurrency } from './concurrency.js';
import { macOfNet0, cleanGuestName, fingerprintComplete } from './proxmoxParams.js';

const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const normalizeState = (status) => status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown';
// Parity with proxmoxValidate.js's client-supplied node check (assertProxmoxLinkInput,
// proxmoxValidate.js:97) — the cluster payload is untrusted input too, so a malformed/garbage
// node from it must never reach the stored link or the display.
const SAFE_NODE = /^[A-Za-z0-9_.-]+$/;
const GUEST_TYPES = new Set(['lxc', 'qemu']);
// A link written before VM support has no kind and is a container by definition.
const linkKind = (box) => (box.proxmox && box.proxmox.kind === 'qemu' ? 'qemu' : 'lxc');
// The fingerprint backfill reads one guest config per unstamped link; bounded
// so the first poll after a deploy does not fire every link's read at once.
const STAMP_CONCURRENCY = 4;
const guestKey = (hostId, vmid) => `${hostId}\u0000${Number(vmid)}`;

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
      proxmoxKind: record.kind,
      proxmoxTemplate: record.template,
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

  // Guests whose config was read successfully but yielded no usable
  // fingerprint (no net0, unrecognisable MAC, disallowed name). Remembered for
  // the life of the process so such a guest costs one read, not one per poll.
  const unusable = new Set();

  // Box id -> signature of the last "not following" reason logged, so an
  // ambiguous missing guest is reported when its situation changes, not on
  // every poll.
  const notFollowingLogged = new Map();

  const record = (box, fields) => ({
    boxId: box.id, boxLabel: box.label, hostId: box.proxmox.hostId, hostName: null,
    node: box.proxmox.node, vmid: Number(box.proxmox.vmid), kind: linkKind(box), containerName: null,
    state: 'unknown', fetchedAt: now(), error: null, template: false, ...fields,
  });

  // A removed-then-re-added host profile gets a new id, stranding links on the
  // old one. Every link stamps the host endpoint, so an orphaned group can
  // re-home to the unique current host with the same endpoint — verified
  // against that cluster (the vmid must exist) and written with the same
  // CAS + active-job guards as the node auto-follow. Ambiguity (zero or 2+
  // endpoint matches) never guesses; every failure mode degrades to the
  // plain "host profile missing" report.
  async function healGroup(hostBoxes, ctx) {
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
      const present = new Map(guests.filter((g) => GUEST_TYPES.has(g.type)).map((g) => [Number(g.vmid), g.type]));
      const healed = [];
      for (const box of candidateBoxes) {
        // Same "never guess" rule the endpoint match already follows: a vmid
        // that came back as the other type is a different guest, not ours.
        if (present.get(Number(box.proxmox.vmid)) !== linkKind(box)) { results.push(orphan(box)); continue; }
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
      if (healed.length) results.push(...await fetchHost(candidateId, healed, ctx));
    }
    return results;
  }

  async function fetchHost(hostId, hostBoxes, ctx) {
    let host;
    try {
      host = await proxmoxStore.getHost(hostId, { withSecret: true });
    } catch (error) {
      ctx.resources.set(hostId, null);
      return hostBoxes.map((box) => record(box, { error: error.message }));
    }
    if (!host) { ctx.resources.set(hostId, null); return healGroup(hostBoxes, ctx); }
    ctx.hosts.set(hostId, host);
    let guests;
    try {
      guests = await makeClient(host).clusterResources();
    } catch (error) {
      ctx.resources.set(hostId, null);
      return hostBoxes.map((box) => record(box, { hostName: host.name, error: error.message }));
    }
    ctx.resources.set(hostId, guests || []);
    const byVmid = new Map((guests || []).filter((g) => GUEST_TYPES.has(g.type)).map((g) => [Number(g.vmid), g]));
    return Promise.all(hostBoxes.map(async (box) => {
      const item = byVmid.get(Number(box.proxmox.vmid));
      if (!item) return record(box, { hostName: host.name, state: 'missing' });
      const nodeValid = typeof item.node === 'string' && SAFE_NODE.test(item.node);
      const want = linkKind(box);
      // A vmid that changed type is a DIFFERENT guest wearing the same number —
      // unlike a migration, which is the same guest on a new node. Refuse and
      // make the operator re-link; write nothing back, not even the node, since
      // this container may belong to someone else entirely.
      if (item.type !== want) {
        return record(box, {
          hostName: host.name, kind: item.type,
          node: nodeValid ? item.node : box.proxmox.node,
          containerName: item.name || null,
          state: 'mismatch',
          template: !!item.template,
          error: `vmid ${Number(box.proxmox.vmid)} is a ${item.type} guest on this cluster, but this box is linked to a ${want} — re-link the box`,
        });
      }
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
            // From the fresh link, not the poll's snapshot: a concurrent
            // refresh may have just stamped `fp`, and the snapshot predates it.
            await boxStore.setProxmoxLink(box.id, { ...freshLink, node: item.node });
            log(`[tmuxifier] box ${box.label}: container ${box.proxmox.vmid} migrated ${box.proxmox.node} -> ${item.node}`);
          } // else: link changed underneath us — skip silently, that's a user action, not an error
        } catch (error) {
          log(`[tmuxifier] box ${box.label}: could not follow container migration to ${item.node}: ${error.message}`);
        }
      }
      return record(box, {
        hostName: host.name, node: nodeValid ? item.node : box.proxmox.node,
        kind: item.type, containerName: item.name || null, state: normalizeState(item.status),
        // Carried even for an already-linked guest: a container/VM can be
        // converted to a template after linking, and a template must never
        // stop being recognisable just because the link predates it.
        template: !!item.template,
      });
    }));
  }

  // Cross-cluster follow (spec 2026-10-05). PDM's remote migration with the
  // source deleted leaves the link reading `missing`; if exactly one guest on
  // any profile carries the link's stamped fingerprint, the link follows it —
  // the node auto-follow's rule widened across clusters, with the mismatch
  // rule's posture: anything short of one unambiguous match writes nothing.
  async function resourcesFor(summary, ctx) {
    if (ctx.resources.has(summary.id)) return ctx.resources.get(summary.id);
    let guests = null;
    try {
      const host = await proxmoxStore.getHost(summary.id, { withSecret: true });
      if (host) {
        ctx.hosts.set(host.id, host);
        guests = (await makeClient(host).clusterResources()) || [];
      }
    } catch { guests = null; }
    ctx.resources.set(summary.id, guests);
    return guests;
  }

  // Returns { found, unreachable, locked, twins }. Only `found` is a candidate
  // to follow; any of the other three makes the search inconclusive.
  async function searchFingerprint(box, ctx) {
    const fp = box.proxmox && box.proxmox.fp;
    if (!boxStore || !fingerprintComplete(fp)) return { found: [], unreachable: [], locked: [], twins: [] };
    const kind = linkKind(box);
    // The whole fleet, not the refresh's box list: a single-box refresh is
    // handed one box, and "already linked elsewhere" needs every link.
    const [summaries, fleet] = await Promise.all([proxmoxStore.listHosts(), boxStore.listBoxes()]);
    const others = (fleet || []).filter((other) => other && other.id !== box.id && other.proxmox);
    // A guest another box links is never a match — keyed by profile id AND by
    // the link's stamped endpoint, since a second profile for the same cluster
    // (an alias) names the same guest under a different id.
    const linkedElsewhere = new Set(others.map((other) => guestKey(other.proxmox.hostId, other.proxmox.vmid)));
    const linkedAtEndpoint = new Set(others
      .filter((other) => typeof other.proxmox.endpoint === 'string' && other.proxmox.endpoint)
      .map((other) => guestKey(other.proxmox.endpoint, other.proxmox.vmid)));
    // Another box carrying this very fingerprint makes the guest contested,
    // whatever it is linked to: an alias profile on a different endpoint can
    // still name the same guest, so only the fingerprint itself can tell.
    const twins = others
      .filter((other) => linkKind(other) === kind && fingerprintComplete(other.proxmox.fp) && other.proxmox.fp.mac === fp.mac)
      .map((other) => other.label || other.id);
    const seen = new Set();
    const searched = [];
    for (const summary of summaries || []) {
      if (!summary || seen.has(summary.endpoint)) continue;
      seen.add(summary.endpoint);
      searched.push(summary);
    }
    // Concurrently: an unreachable profile costs one API timeout per sweep,
    // not one per profile in turn. Results keep the summaries' order.
    const lists = await Promise.all(searched.map((summary) => resourcesFor(summary, ctx)));
    const named = [];
    const unreachable = [];
    const locked = [];
    searched.forEach((summary, index) => {
      const guests = lists[index];
      // An unreadable cluster could hold a second match: the search is incomplete.
      if (!guests) { unreachable.push(summary.name || summary.id); return; }
      for (const g of guests) {
        if (!g || g.type !== kind || g.template) continue;
        if (typeof g.node !== 'string' || !SAFE_NODE.test(g.node)) continue;
        const vmid = Number(g.vmid);
        if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) continue;
        if (cleanGuestName(g.name) !== fp.name) continue;
        if (linkedElsewhere.has(guestKey(summary.id, vmid))) continue;
        if (summary.endpoint && linkedAtEndpoint.has(guestKey(summary.endpoint, vmid))) continue;
        // A same-name guest mid-migration (or mid-backup) could be the real
        // target: never followed, but reported so the search reads inconclusive.
        if (g.lock) { locked.push({ hostId: summary.id, hostName: summary.name || null, vmid }); continue; }
        named.push({
          hostId: summary.id, hostName: summary.name || null, endpoint: summary.endpoint,
          node: g.node, vmid, kind, status: g.status, name: g.name,
        });
      }
    });
    const macs = await Promise.all(named.map(async (candidate) => {
      try {
        const config = await makeClient(ctx.hosts.get(candidate.hostId)).guestConfig(kind, candidate.node, candidate.vmid);
        return { mac: macOfNet0(kind, config && config.net0) };
      } catch { return { failed: true }; }
    }));
    const found = [];
    named.forEach((candidate, index) => {
      // A failed read might have been the match.
      if (macs[index].failed) unreachable.push(candidate.hostName || candidate.hostId);
      else if (macs[index].mac === fp.mac) found.push(candidate);
    });
    return { found, unreachable: [...new Set(unreachable)], locked, twins };
  }

  function noteNotFollowing(box, signature, message) {
    if (notFollowingLogged.get(box.id) === signature) return;
    notFollowingLogged.set(box.id, signature);
    log(`[tmuxifier] box ${box.label}: guest missing; not following — ${message}`);
  }

  async function rehome(box, target, ctx) {
    try {
      // CAS: the link must still be the one this refresh found missing.
      const fresh = await boxStore.getBox(box.id);
      const link = fresh && fresh.proxmox;
      const stillOurs = link && link.hostId === box.proxmox.hostId
        && Number(link.vmid) === Number(box.proxmox.vmid)
        && fingerprintComplete(link.fp) && link.fp.mac === box.proxmox.fp.mac;
      if (!stillOurs || activeJobGuard(box.id)) return null;
      const next = { ...link, hostId: target.hostId, node: target.node, vmid: target.vmid, endpoint: target.endpoint };
      await boxStore.setProxmoxLink(box.id, next);
      const fromName = (ctx.hosts.get(link.hostId) || {}).name || link.hostId;
      log(`[tmuxifier] box ${box.label}: guest moved ${fromName}/${link.vmid} -> ${target.hostName || target.hostId}/${target.vmid} (fingerprint ${link.fp.name} ${link.fp.mac})`);
      return record({ ...box, proxmox: next }, {
        hostName: target.hostName, node: target.node, kind: target.kind,
        containerName: target.name || null, state: normalizeState(target.status), template: false,
      });
    } catch (error) {
      log(`[tmuxifier] box ${box.label}: could not follow guest to ${target.hostName || target.hostId}/${target.vmid}: ${error.message}`);
      return null;
    }
  }

  async function followAcrossClusters(records, boxes, ctx) {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const plans = [];
    for (const item of records) {
      if (item.state !== 'missing') { notFollowingLogged.delete(item.boxId); continue; }
      const box = byId.get(item.boxId);
      if (!box || !box.proxmox || !fingerprintComplete(box.proxmox.fp) || activeJobGuard(box.id)) continue;
      let result;
      try { result = await searchFingerprint(box, ctx); } catch (error) {
        noteNotFollowing(box, `error:${error.message}`, `search failed: ${error.message}`);
        continue;
      }
      const { found, unreachable, locked, twins } = result;
      const inconclusive = unreachable.length + locked.length + twins.length;
      if (found.length === 1 && inconclusive === 0) { plans.push({ box, target: found[0] }); continue; }
      if (found.length === 0 && inconclusive === 0) { notFollowingLogged.delete(box.id); continue; }
      const signature = [
        ...found.map((c) => `${c.hostId}/${c.vmid}`), ...unreachable.map((n) => `!${n}`),
        ...locked.map((c) => `#${c.hostId}/${c.vmid}`), ...twins.map((label) => `=${label}`),
      ].join(',');
      const named = (c) => `${c.hostName || c.hostId}/${c.vmid}`;
      const reasons = [`${found.length} fingerprint match(es)${found.length ? `: ${found.map(named).join(', ')}` : ''}`];
      if (twins.length) reasons.push(`box ${twins.join(', ')} carries the same fingerprint`);
      if (unreachable.length) reasons.push(`could not read: ${unreachable.join(', ')}`);
      if (locked.length) reasons.push(`locked: ${locked.map(named).join(', ')}`);
      noteNotFollowing(box, signature, reasons.join('; '));
    }
    const claims = new Map();
    for (const { target } of plans) {
      const key = guestKey(target.hostId, target.vmid);
      claims.set(key, (claims.get(key) || 0) + 1);
    }
    const replaced = new Map();
    for (const { box, target } of plans) {
      const key = guestKey(target.hostId, target.vmid);
      if (claims.get(key) > 1) {
        noteNotFollowing(box, `shared:${key}`, `another missing box matches the same guest (${target.hostName || target.hostId}/${target.vmid})`);
        continue;
      }
      notFollowingLogged.delete(box.id);
      const moved = await rehome(box, target, ctx);
      if (moved) replaced.set(box.id, moved);
    }
    return records.map((item) => replaced.get(item.boxId) || item);
  }

  // A link is found by vmid, so a different guest of the same kind that takes
  // the vmid before Tmuxifier notices the original is gone would be adopted
  // silently — the kind-mismatch rule's gap, one level down. A guest whose
  // name no longer matches the stamped fingerprint is checked against the
  // recorded MAC: same MAC is a plain rename (the stamp step refreshes fp.name),
  // anything else is a stranger. Read-only, so it runs on every refresh —
  // follow:false and an active job included: the lifecycle pre-check must see
  // the mismatch, or a deprovision could destroy the stranger. The common
  // case (name unchanged) costs no PVE call. Fails closed to `unknown`.
  async function verifyIdentity(records, boxes, ctx) {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const work = [];
    for (const item of records) {
      if (item.state !== 'running' && item.state !== 'stopped') continue;
      const box = byId.get(item.boxId);
      if (!box || !box.proxmox || !fingerprintComplete(box.proxmox.fp)) continue;
      // Same rule as the stamp step: a record rebuilt for a different target
      // is not about the link the box object holds.
      if (item.hostId !== box.proxmox.hostId || item.vmid !== Number(box.proxmox.vmid)) continue;
      if (cleanGuestName(item.containerName) === box.proxmox.fp.name) continue;
      work.push({ item, fp: box.proxmox.fp });
    }
    if (!work.length) return records;
    const replaced = new Map();
    await mapWithConcurrency(work, STAMP_CONCURRENCY, async ({ item, fp }) => {
      let config;
      try {
        const host = ctx.hosts.get(item.hostId);
        if (!host) throw new Error('host profile not available');
        config = await makeClient(host).guestConfig(item.kind, item.node, item.vmid);
      } catch (error) {
        replaced.set(item.boxId, {
          ...item, state: 'unknown',
          error: `could not verify guest identity after a name change: ${error.message}`,
        });
        return;
      }
      if (macOfNet0(item.kind, config && config.net0) === fp.mac) return;
      replaced.set(item.boxId, {
        ...item, state: 'mismatch',
        error: `vmid ${item.vmid} on ${item.hostName || item.hostId} is now a different guest (named ${cleanGuestName(item.containerName) || 'unnamed'}) — re-link the box`,
      });
    });
    return records.map((item) => replaced.get(item.boxId) || item);
  }

  // Cross-cluster follow (spec 2026-10-05) matches on a fingerprint that can
  // only be read while the guest exists, so it is stamped here — on the first
  // poll after any link is made — and its name kept current for free from the
  // resource list. This is the only writer of `fp`.
  async function stampFingerprints(records, boxes, ctx) {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const work = [];
    for (const item of records) {
      if (item.state !== 'running' && item.state !== 'stopped') continue;
      const box = byId.get(item.boxId);
      if (!box || !box.proxmox || activeJobGuard(box.id)) continue;
      // A record this refresh rebuilt for a different target (a healed link;
      // the cross-cluster follow runs after this step) is not about the link
      // the box object holds; the next poll stamps it.
      if (item.hostId !== box.proxmox.hostId || item.vmid !== Number(box.proxmox.vmid)) continue;
      const name = cleanGuestName(item.containerName);
      const fp = box.proxmox.fp;
      if (fingerprintComplete(fp)) {
        if (name && name !== fp.name) work.push({ box, item, name, mac: fp.mac });
        continue;
      }
      if (unusable.has(guestKey(item.hostId, item.vmid))) continue;
      work.push({ box, item, name, mac: null });
    }
    await mapWithConcurrency(work, STAMP_CONCURRENCY, async ({ box, item, name, mac }) => {
      let stampMac = mac;
      if (!stampMac) {
        const host = ctx.hosts.get(item.hostId);
        if (!host) return;
        let config;
        // Best-effort and silent: a failed read is retried next poll.
        try { config = await makeClient(host).guestConfig(item.kind, item.node, item.vmid); } catch { return; }
        stampMac = macOfNet0(item.kind, config && config.net0);
        if (!name || !stampMac) { unusable.add(guestKey(item.hostId, item.vmid)); return; }
      }
      try {
        // CAS: re-read right before writing, same as the node auto-follow, so a
        // link the user changed mid-poll is never stamped with this guest.
        const fresh = await boxStore.getBox(box.id);
        const link = fresh && fresh.proxmox;
        if (!link || link.hostId !== item.hostId || Number(link.vmid) !== item.vmid || activeJobGuard(box.id)) return;
        await boxStore.setProxmoxLink(box.id, { ...link, fp: { name, mac: stampMac } });
      } catch (error) {
        log(`[tmuxifier] box ${box.label}: could not stamp guest fingerprint: ${error.message}`);
      }
    });
  }

  async function doRefresh(boxes, { follow = true } = {}) {
    // Per-refresh context: every host fetched and every profile's resource
    // list read in this refresh, so later steps never ask a cluster twice.
    const ctx = { hosts: new Map(), resources: new Map() };
    const groups = new Map();
    for (const box of boxes.filter((item) => item.proxmox)) {
      const hostId = box.proxmox.hostId;
      if (!groups.has(hostId)) groups.set(hostId, []);
      groups.get(hostId).push(box);
    }
    let records = (await Promise.all(
      [...groups.entries()].map(([hostId, hostBoxes]) => fetchHost(hostId, hostBoxes, ctx)),
    )).flat();
    // Identity check first and unconditionally (read-only — see verifyIdentity);
    // a mismatch/unknown record is then skipped by stamp and follow below.
    records = await verifyIdentity(records, boxes, ctx);
    // follow:false (a lifecycle pre-check) is read-only beyond the node
    // auto-follow fetchHost already did: no stamp, no cross-cluster re-home.
    // Stamp BEFORE follow: a box linked in this same poll must already carry
    // its fp when another box's search checks for fingerprint twins. The two
    // steps touch disjoint records (stamp: running/stopped; follow: missing),
    // and the search re-reads the fleet, so it sees the fresh stamp.
    if (follow && boxStore) {
      await stampFingerprints(records, boxes, ctx);
      records = await followAcrossClusters(records, boxes, ctx);
    }
    for (const item of records) cache.set(item.boxId, item);
    return records;
  }

  function refreshLinked(boxes) {
    if (inFlight) return inFlight;
    inFlight = doRefresh(boxes).finally(() => { inFlight = null; });
    return inFlight;
  }

  // Physical-node health for the standby dashboard's Proxmox readout: one
  // `/cluster/resources?type=node` call per distinct endpoint (two profiles
  // pointing at the same cluster answer identically — fetch once). Per-host
  // failures degrade to one error record; the healthy clusters still report.
  async function listClusterNodes() {
    let summaries;
    try { summaries = await proxmoxStore.listHosts(); } catch { return []; }
    const pct = (used, max) => (Number.isFinite(used) && Number.isFinite(max) && max > 0
      ? Math.round((used / max) * 100) : null);
    const seen = new Set();
    const out = [];
    for (const summary of summaries) {
      let host;
      try { host = await proxmoxStore.getHost(summary.id, { withSecret: true }); } catch { host = null; }
      if (!host || seen.has(host.endpoint)) continue;
      seen.add(host.endpoint);
      const base = {
        hostId: host.id, hostName: host.name || null,
        cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: null,
      };
      let entries;
      try { entries = await makeClient(host).clusterNodes(); } catch (error) {
        out.push({ ...base, node: null, status: 'error', error: error.message });
        continue;
      }
      for (const e of entries || []) {
        if (!e || e.type !== 'node' || typeof e.node !== 'string' || !SAFE_NODE.test(e.node)) continue;
        out.push({
          ...base, node: e.node,
          status: e.status === 'online' ? 'online' : e.status === 'offline' ? 'offline' : 'unknown',
          cpuPct: Number.isFinite(e.cpu) ? Math.round(e.cpu * 100) : null,
          memPct: pct(e.mem, e.maxmem), diskPct: pct(e.disk, e.maxdisk),
          uptimeSec: Number.isFinite(e.uptime) ? e.uptime : null,
        });
      }
    }
    return out;
  }

  return {
    refreshLinked,
    listClusterNodes,
    setActiveJobGuard(fn) { activeJobGuard = fn; },
    async refreshBox(box, opts = {}) { return (await doRefresh([box], opts))[0]; },
    // The deprovision guard's query (proxmoxLifecycle.js): the same search the
    // follow runs, without writing anything. Precondition: call it only for a
    // box whose own guest reads `missing` — the box's own guest is not excluded.
    async findFollowCandidates(box) {
      const { found, unreachable, locked, twins } = await searchFingerprint(box, { hosts: new Map(), resources: new Map() });
      return { found: found.map(({ hostId, hostName, vmid, node }) => ({ hostId, hostName, vmid, node })), unreachable, locked, twins };
    },
    async getLinkedGuests(boxes) { return refreshLinked(boxes); },
    async listNodeGuests(hostId, node, boxes) {
      const host = await proxmoxStore.getHost(hostId, { withSecret: true });
      if (!host) throw new Error('proxmox host not found');
      const linked = new Map(boxes.filter((box) => box.proxmox).map((box) => [targetKey(box.proxmox), box.id]));
      const client = makeClient(host);
      // Both must succeed. PVE permissions are path-based on /vms/<vmid> and do
      // not distinguish guest type, so "can list containers but not VMs" is not
      // a real token; silently omitting VMs would be worse than a visible error.
      const [lxc, qemu] = await Promise.all([client.listGuests('lxc', node), client.listGuests('qemu', node)]);
      return [
        ...(lxc || []).map((item) => ({ item, kind: 'lxc' })),
        ...(qemu || []).map((item) => ({ item, kind: 'qemu' })),
      ].map(({ item, kind }) => ({
        hostId, node, kind, vmid: Number(item.vmid), name: item.name || String(item.vmid),
        state: normalizeState(item.status),
        // PVE returns template: 1 on both qemu and lxc template rows. Carried
        // through so the picker can refuse to select one and the Guests tab
        // can refuse to offer lifecycle actions on one — a template linked
        // and then deprovisioned destroys the source every future clone
        // depends on.
        template: !!item.template,
        linkedBoxId: linked.get(targetKey({ hostId, node, vmid: item.vmid })) || null,
      })).sort((a, b) => a.vmid - b.vmid);
    },
    stateFor(box) {
      const record = box.proxmox ? cache.get(box.id) : undefined;
      return record && now() - record.fetchedAt <= freshnessMs ? record : undefined;
    },
  };
}
