import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createNetboxClient } from './netboxApi.js';
import { newestFirst } from './jobOrder.js';
import { pollPveTask } from './pveTask.js';
import { parseNet0, describeNet0, buildNet0Readdress } from './proxmoxParams.js';
import { isCidr, isIp, isDnsLabel } from './proxmoxValidate.js';

const ACTIONS = new Set(['start', 'shutdown', 'stop', 'reboot', 'deprovision', 'readdress']);
const TERMINAL = new Set(['done', 'error', 'interrupted']);
const REQUIRED = { start: 'stopped', shutdown: 'running', stop: 'running', reboot: 'running' };
const jobKind = (link) => (link && link.kind === 'qemu' ? 'qemu' : 'lxc');
const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const serviceError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
// The only client-supplied value this action sends anywhere: a NetBox filter
// and, via buildNet0Readdress, a PVE `tag=`. Integers only — a numeric string
// from a hand-built request is refused rather than coerced.
const parseVlan = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 4094) throw serviceError(400, 'vlan must be an integer 1..4094');
  return value;
};
const NETBOX_REQUIRED = 'readdress requires the NetBox integration — configure it in Settings (⚙)';

export function createProxmoxLifecycleManager({
  boxStore, proxmoxStore, inventory, makeClient, removeLinkedBox, knownHosts = null,
  netboxStore = null, makeNetboxClient = createNetboxClient,
  // Refuses a readdress while a setup job streams over the SSH master the job
  // is about to sever. Wired in index.js to setupManager.currentForBox.
  setupRunning = () => false,
  // Fired once the box points at its new address: index.js exits the old
  // ControlMaster, closes the box's terminal group so viewers reconnect at the
  // new host, and resets the status backoff. Best-effort, never awaited into
  // the job's success (see runReaddress).
  onReaddress = null,
  load = () => [], save = () => {}, now = () => new Date().toISOString(), makeId = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1500,
  taskTimeoutMs = 600_000, shutdownTimeoutMs = taskTimeoutMs, maxPollFailures = 5,
  deprovisionGraceSec = 120,
  maxJobs = 50, maxLogBytes = 65_536,
  // Fired once PVE confirms a container is running again, so the status layer
  // can start looking for it instead of waiting out its own poll interval.
  // Best-effort and fire-and-forget: see runRoutine.
  onContainerUp = null,
}) {
  const jobs = new Map();
  const settles = new Map();
  const orphaned = []; // readdress jobs interrupted at allocate-ip: a reservation nothing else can reclaim
  const chaseable = []; // readdress jobs interrupted at apply or later: PVE may or may not have written the config
  for (const job of load() || []) {
    // One bad history row must never keep the server from booting: the store
    // validates only Array.isArray, so a `[null]` file parses, is never
    // quarantined, and would throw a TypeError right here — at module top level.
    if (!job || typeof job !== 'object' || typeof job.id !== 'string') continue;
    // Every job in an existing history file acted on a container, so this states
    // a fact rather than guessing. Loaded jobs are forced terminal, so it is
    // only ever read for display.
    job.kind = jobKind(job);
    if (!TERMINAL.has(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || now();
      if (job.action === 'readdress' && job.netboxIpId) (job.phase === 'allocate-ip' ? orphaned : chaseable).push(job);
    }
    jobs.set(job.id, job);
  }
  const ordered = () => [...jobs.values()].sort(newestFirst);
  const prune = () => {
    const terminal = ordered().filter((job) => TERMINAL.has(job.status));
    // Drop the settles entry with the job, or the promise map grows for the
    // life of the process (one entry per job ever created).
    for (const job of terminal.slice(maxJobs)) { jobs.delete(job.id); settles.delete(job.id); }
  };
  const persist = () => { prune(); save(ordered()); };
  const appendLog = (job, text) => { if (text) job.log = `${job.log}${text}`.slice(-maxLogBytes); };
  const summary = (job) => ({ id: job.id, action: job.action, boxId: job.boxId, boxLabel: job.boxLabel, hostId: job.hostId, hostName: job.hostName, node: job.node, vmid: job.vmid, kind: job.kind, status: job.status, phase: job.phase, error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt });
  const assertTargetIdle = (key) => { if ([...jobs.values()].some((job) => job.status === 'running' && targetKey(job) === key)) throw serviceError(409, 'guest already has an active lifecycle job'); };
  persist();

  function pollTask(client, job, upid) {
    return pollPveTask(client, job.node, upid, {
      onLog: (text) => { appendLog(job, text); persist(); },
      timeoutMs: taskTimeoutMs, pollMs, sleep, maxPollFailures,
    });
  }

  async function resolveTarget(job) {
    const box = await boxStore.getBox(job.boxId);
    if (!box || !box.proxmox || targetKey(box.proxmox) !== targetKey(job) || jobKind(box.proxmox) !== job.kind) {
      throw new Error('box Proxmox link changed before lifecycle action');
    }
    const host = await proxmoxStore.getHost(job.hostId, { withSecret: true });
    if (!host) throw new Error('Proxmox host profile is unavailable');
    return { box, client: makeClient(host) };
  }

  async function waitForState(job, expected, timeoutMs = taskTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { box } = await resolveTarget(job);
      const record = await inventory.refreshBox(box);
      if (record.state === expected) return record;
      if (record.state === 'unknown') throw new Error(record.error || 'Proxmox state unavailable');
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expected}`);
      await sleep(pollMs);
    }
  }

  async function runRoutine(job) {
    const { box, client } = await resolveTarget(job);
    const current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
    if (current.state !== REQUIRED[job.action]) throw new Error(`${job.action} requires ${REQUIRED[job.action]}`);
    job.phase = 'request'; persist();
    const method = `${job.action}Guest`;
    const upid = await client[method](job.kind, job.node, job.vmid);
    appendLog(job, `# ${job.action} ${upid}\n`); persist();
    await pollTask(client, job, upid);
    job.phase = 'verify'; persist();
    const backUp = job.action === 'start' || job.action === 'reboot';
    const expected = backUp ? 'running' : 'stopped';
    await waitForState(job, expected);
    // PVE says running, but sshd is still coming up — the box will not answer a
    // probe for tens of seconds yet. Hand the box off to the status layer so it
    // can watch for the box itself rather than leaving the UI to discover it on
    // the next scheduled sweep. Never awaited and never allowed to throw: this
    // is a freshness optimisation, and the lifecycle action already succeeded.
    if (backUp && onContainerUp) {
      try { Promise.resolve(onContainerUp(job.boxId)).catch(() => {}); } catch { /* best-effort */ }
    }
  }

  // The re-address preflight and its allocation both need decrypted settings
  // and both must fail as a 400 the route can render, not a bare throw.
  async function requireNetboxSettings() {
    if (!netboxStore) throw serviceError(400, NETBOX_REQUIRED);
    let settings;
    try { settings = await netboxStore.getSettings({ withSecret: true }); }
    catch (e) { throw serviceError(400, `NetBox settings could not be read: ${e?.message || e}`); }
    if (!settings) throw serviceError(400, NETBOX_REQUIRED);
    return settings;
  }

  // Best-effort IPAM cleanup shared by deprovision and readdress: release an
  // allocation by its stamped id, then delete every record matching an
  // address so a manually created NetBox record doesn't outlive what used it.
  // A NetBox failure must never fail a job whose container is already gone or
  // already moved — log it and let the rest finish.
  async function releaseNetboxRecords(job, { ipId, hostIp }) {
    if ((!ipId && !hostIp) || !netboxStore) return;
    let settings = null;
    let readError = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch (e) { readError = e?.message || String(e); }
    if (!settings) {
      // Distinguish "never configured" from a real read/decrypt failure — the
      // latter means an allocated IP was NOT released for a fixable reason.
      const why = readError ? `settings could not be read: ${readError}` : 'NetBox integration not configured';
      if (ipId) { appendLog(job, `# could not release NetBox ip ${ipId}: ${why}\n`); persist(); }
      return;
    }
    const client = makeNetboxClient(settings);
    if (ipId) {
      try {
        await client.releaseIp(ipId);
        appendLog(job, `# released NetBox ip ${ipId}\n`); persist();
      } catch (error) {
        appendLog(job, `# could not release NetBox ip ${ipId}: ${error.message}\n`); persist();
      }
    }
    if (!hostIp) return;
    let matches;
    try {
      matches = await client.findIpsByAddress(hostIp);
    } catch (error) {
      appendLog(job, `# could not look up NetBox ip records for ${hostIp}: ${error.message}\n`); persist();
      return;
    }
    if (!matches.length) {
      if (!ipId) { appendLog(job, `# no NetBox ip record matches ${hostIp}\n`); persist(); }
      return;
    }
    for (const rec of matches) {
      try {
        await client.releaseIp(rec.id);
        appendLog(job, `# released NetBox ip ${rec.id} (${rec.address})\n`); persist();
      } catch (error) {
        appendLog(job, `# could not release NetBox ip ${rec.id} (${rec.address}): ${error.message}\n`); persist();
      }
    }
  }
  // Deprovision's view of the same routine: the box's stamped id and its host.
  const releaseNetboxIp = (job, box) => releaseNetboxRecords(job, {
    ipId: box?.proxmox?.netboxIpId,
    hostIp: isIP(String(box?.host || '')) ? box.host : null,
  });

  // A readdress reservation the container never moved onto — a failed run, or
  // a job interrupted at allocate-ip. Best-effort and logged; the id is
  // cleared only on a confirmed release, so a failure leaves it recorded and
  // chaseable rather than silently forgotten.
  async function releaseFreshAllocation(job) {
    if (!job.netboxIpId) return;
    try {
      const netbox = makeNetboxClient(await requireNetboxSettings());
      await netbox.releaseIp(job.netboxIpId);
      appendLog(job, `# released NetBox ip ${job.netboxIpId} (unused allocation)\n`);
      job.netboxIpId = null;
    } catch (error) {
      appendLog(job, `# could not release NetBox ip ${job.netboxIpId}: ${error.message}\n`);
    }
  }

  async function runDeprovision(job) {
    const { box, client } = await resolveTarget(job);
    let current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
    if (current.state === 'missing') {
      job.phase = 'unlink'; persist();
      // The container is verifiably gone — its host key is dead by definition.
      // Best-effort: a failure here must never fail the deprovision.
      if (knownHosts) { try { await knownHosts.forget(box.host, box.port); } catch { /* best-effort */ } }
      await releaseNetboxIp(job, box);
      await removeLinkedBox(job.boxId);
      return;
    }
    if (current.state === 'running') {
      job.phase = 'shutdown'; persist();
      // forceStop + timeout make PVE escalate server-side once the grace expires:
      // one task rather than a poll loop plus a second request, and no window in
      // which we and PVE disagree about what is running. The guest's disk is
      // about to be purged, so a clean unmount is moot.
      const shutdown = await client.shutdownGuest(job.kind, job.node, job.vmid, { forceStop: true, timeout: deprovisionGraceSec });
      appendLog(job, `# shutdown ${shutdown}\n`); persist();
      await pollTask(client, job, shutdown);
      current = await waitForState(job, 'stopped', shutdownTimeoutMs);
    }
    if (current.state !== 'stopped') throw new Error(`deprovision requires stopped, got ${current.state}`);
    job.phase = 'destroy'; persist();
    const destroy = await client.destroyGuest(job.kind, job.node, job.vmid);
    appendLog(job, `# destroy ${destroy}\n`); persist();
    await pollTask(client, job, destroy);
    job.phase = 'verify'; persist();
    await waitForState(job, 'missing', taskTimeoutMs);
    job.phase = 'unlink'; persist();
    // The container is verifiably gone — its host key is dead by definition.
    // Best-effort: a failure here must never fail the deprovision.
    if (knownHosts) { try { await knownHosts.forget(box.host, box.port); } catch { /* best-effort */ } }
    await releaseNetboxIp(job, box);
    await removeLinkedBox(job.boxId);
  }

  // Move the container to a new NetBox-managed VLAN/IP. Phase order is the
  // safety argument: the new address is allocated BEFORE the old is touched,
  // PVE is written BEFORE the box is re-pointed, and the old record is released
  // only AFTER the box owns the new one — so a failure at any phase leaves
  // exactly one address registered to the container, never zero.
  async function runReaddress(job) {
    const { box, client } = await resolveTarget(job);
    const current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'mismatch') throw new Error(current.error || 'proxmox guest kind mismatch');
    if (current.state !== 'running' && current.state !== 'stopped') throw new Error(`readdress cannot run from ${current.state}`);

    job.phase = 'inspect'; persist();
    const config = await client.guestConfig('lxc', job.node, job.vmid);
    if (!config || typeof config.net0 !== 'string') throw new Error('container has no net0 interface');
    const pairs = parseNet0(config.net0);
    const before = describeNet0(pairs);
    // The address the old record is swept by and whose known_hosts entry goes:
    // the box's host, when it is an IP literal — also what deprovision uses.
    // net0's own ip= is null for a dhcp interface, which is fine.
    const oldHost = isIP(String(box.host || '')) ? box.host : null;
    job.oldIp = before.ip;
    job.oldVlan = before.vlan;
    job.oldNetboxIpId = box.proxmox.netboxIpId || null;
    job.hostname = typeof config.hostname === 'string' ? config.hostname : null;
    appendLog(job, `# before: ${config.net0}\n`); persist();

    job.phase = 'allocate-ip'; persist();
    const settings = await requireNetboxSettings();
    const netbox = makeNetboxClient(settings);
    const prefix = await netbox.findPrefixByVlan(job.vlan);
    // The provisioning rule for the record's description and dns_name; the
    // PVE hostname is box-side content and becomes a dns_name only when it is
    // a DNS label (the same check provisioning applies to a typed hostname).
    const name = isDnsLabel(job.hostname) ? job.hostname : null;
    const fields = { status: 'active', description: `tmuxifier: ${name || box.label}` };
    if (name) fields.dns_name = settings.dnsSuffix ? `${name}.${settings.dnsSuffix}` : name;
    const res = await netbox.allocateIp(prefix, fields);
    job.netboxIpId = res.id;
    if (!isCidr(res.address) || !isIp(res.gateway)) throw new Error(`NetBox returned an unusable address: ${res.address} (gw ${res.gateway})`);
    job.ip = res.address;
    job.gateway = res.gateway;
    appendLog(job, `# allocated ${res.address} from ${prefix.prefix} (gw ${res.gateway}, NetBox ip ${res.id})\n`); persist();
    const newHost = res.address.split('/')[0];
    // Another box already at the new address is a NetBox/boxes.json
    // disagreement — refuse before PVE is touched. The box itself is ignored:
    // an unregistered dhcp box may well be handed its own current address.
    const conflict = await boxStore.uniquenessConflict({ host: newHost }, box.id);
    if (conflict) throw new Error(`${conflict} (${newHost}) — nothing was changed`);
    // NetBox just handed the address out as free: any known_hosts entry for it
    // belongs to whatever used it before (the provisioning rule). Best-effort.
    if (knownHosts) { try { await knownHosts.forget(newHost, box.port); } catch { /* best-effort */ } }

    job.phase = 'apply'; persist();
    const net0 = buildNet0Readdress(pairs, { vlan: job.vlan, ip: res.address, gateway: res.gateway });
    await client.setLxcConfig(job.node, job.vmid, { net0 });
    appendLog(job, `# applied: ${net0}\n`); persist();

    job.phase = 'relink'; persist();
    let after;
    try {
      after = await boxStore.readdressBox(job.boxId, { host: newHost, netboxIpId: res.id });
    } catch (error) {
      // The only failure after the container has moved. Both addresses are now
      // genuinely in use somewhere, so run() releases nothing at this phase.
      throw new Error(`container is now at ${newHost} but the box still points at ${box.host} — edit the box host by hand (${error.message})`);
    }
    appendLog(job, `# box ${box.label} now ${newHost}\n`); persist();

    job.phase = 'release'; persist();
    await releaseNetboxRecords(job, { ipId: job.oldNetboxIpId, hostIp: oldHost });

    job.phase = 'verify'; persist();
    // The old address is free in NetBox now: the container's identity has
    // verifiably left it. Best-effort.
    if (knownHosts && oldHost) { try { await knownHosts.forget(oldHost, box.port); } catch { /* best-effort */ } }
    if (onReaddress) { try { await Promise.resolve(onReaddress({ before: box, after })).catch(() => {}); } catch { /* best-effort */ } }
    if (current.state === 'running' && onContainerUp) {
      try { Promise.resolve(onContainerUp(job.boxId)).catch(() => {}); } catch { /* best-effort */ }
    }
  }

  async function run(job) {
    try {
      if (job.action === 'deprovision') await runDeprovision(job);
      else if (job.action === 'readdress') await runReaddress(job);
      else await runRoutine(job);
      job.phase = 'done'; job.status = 'done'; job.finishedAt = now(); persist();
    } catch (error) {
      // A readdress that failed while the container was still at its old
      // address (allocate-ip: conflict/unusable; apply: PVE refused) must not
      // leak the reservation. A relink failure keeps it — the container is
      // using it — and the boot reconcile applies the same phase rule.
      if (job.action === 'readdress' && (job.phase === 'allocate-ip' || job.phase === 'apply')) await releaseFreshAllocation(job);
      job.status = 'error'; job.error = error instanceof Error ? error.message : 'lifecycle action failed'; job.finishedAt = now(); persist();
    }
  }

  async function createJob(input = {}) {
    if (['hostId', 'node', 'vmid'].some((key) => key in input)) {
      throw serviceError(400, 'lifecycle targets are resolved from the box link');
    }
    const { boxId, action } = input;
    if (typeof boxId !== 'string' || !boxId) throw serviceError(400, 'boxId is required');
    if (!ACTIONS.has(action)) throw serviceError(400, 'invalid lifecycle action');
    // Shape before I/O: a bad vlan is refused without a box read.
    const vlan = action === 'readdress' ? parseVlan(input.vlan) : null;
    if (action !== 'readdress' && 'vlan' in input) throw serviceError(400, 'vlan applies only to readdress');
    const box = await boxStore.getBox(boxId);
    if (!box) throw serviceError(404, 'box not found');
    if (!box.proxmox) throw serviceError(409, 'box is not linked to Proxmox');
    const key = targetKey(box.proxmox);
    assertTargetIdle(key);
    const host = await proxmoxStore.getHost(box.proxmox.hostId, { withSecret: true });
    if (!host) throw serviceError(404, 'proxmox host not found');
    const current = await inventory.refreshBox(box).catch((error) => { throw serviceError(502, error.message); });
    if (current.state === 'unknown') throw serviceError(502, current.error || 'Proxmox state unavailable');
    // Checked explicitly rather than left to fall through to the REQUIRED test:
    // "start requires stopped" would send the operator debugging the wrong thing
    // when the real problem is that this vmid is not the guest they linked.
    if (current.state === 'mismatch') throw serviceError(409, current.error || 'proxmox guest kind mismatch');
    // Checked before the deprovision/REQUIRED branches, same spot as the
    // mismatch refusal above, so it covers deprovision too — destroying a
    // template destroys every future clone's source.
    if (current.template) throw serviceError(409, 'proxmox guest is a template');
    if (action === 'deprovision') {
      if (input.confirmName !== box.label) throw serviceError(409, 'confirmation name does not match');
      if (!['running', 'stopped', 'missing'].includes(current.state)) throw serviceError(409, `deprovision cannot run from ${current.state}`);
    } else if (action === 'readdress') {
      if (jobKind(box.proxmox) !== 'lxc') throw serviceError(409, 'readdress is available for containers only');
      if (!['running', 'stopped'].includes(current.state)) throw serviceError(409, `readdress cannot run from ${current.state}`);
      if (setupRunning(box.id)) throw serviceError(409, 'box has a running setup job — wait for it to finish');
      await requireNetboxSettings(); // 400 with no job record, as provisioning does
    } else if (current.state !== REQUIRED[action]) {
      throw serviceError(409, `${action} requires ${REQUIRED[action]}`);
    }
    // The refreshBox pre-check above may have just drift-followed a node
    // migration in the store (this job doesn't exist yet, so nothing guards
    // that write) — snapshot the node from the refreshed record or resolveTarget
    // would abort the first action after a migration. Only the node may follow;
    // hostId/vmid stay pinned to the link every check above validated.
    const job = {
      id: makeId(), action, boxId: box.id, boxLabel: box.label,
      hostId: host.id, hostName: host.name, node: current.node, vmid: Number(box.proxmox.vmid),
      kind: jobKind(box.proxmox),
      status: 'running', phase: 'resolve', log: '', error: null,
      createdAt: now(), finishedAt: null,
      ...(action === 'readdress' ? { vlan, oldIp: null, oldVlan: null, oldNetboxIpId: null, hostname: null, ip: null, gateway: null, netboxIpId: null } : {}),
    };
    // Re-check on the key the job actually occupies — after a drift-follow it
    // differs from `key`, and overlapping createJob calls would otherwise both
    // land on the new target.
    assertTargetIdle(targetKey(job));
    jobs.set(job.id, job); persist();
    const settled = run(job);
    settles.set(job.id, settled);
    return summary(job);
  }

  // Boot reconcile for readdress reservations. Fire-and-forget so a slow or
  // unreachable NetBox cannot delay boot; awaited by _reconciled() in tests.
  for (const job of chaseable) appendLog(job, `# interrupted at ${job.phase}: NetBox ip ${job.netboxIpId} may be in use by the container — check it by hand\n`);
  if (chaseable.length) persist();
  const reconciled = orphaned.length
    ? (async () => { for (const job of orphaned) await releaseFreshAllocation(job); persist(); })()
    : Promise.resolve();

  return {
    createJob,
    getJob: (id) => jobs.get(id),
    listJobs: () => ordered().map(summary),
    hasActiveJob: (boxId) => [...jobs.values()].some((job) => job.boxId === boxId && job.status === 'running'),
    hasActiveTarget: (link) => [...jobs.values()].some((job) => targetKey(job) === targetKey(link) && job.status === 'running'),
    _settled: (id) => settles.get(id) || Promise.resolve(),
    _reconciled: () => reconciled,
  };
}
