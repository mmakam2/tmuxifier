import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createNetboxClient } from './netboxApi.js';

const ACTIONS = new Set(['start', 'shutdown', 'stop', 'reboot', 'deprovision']);
const TERMINAL = new Set(['done', 'error', 'interrupted']);
const REQUIRED = { start: 'stopped', shutdown: 'running', stop: 'running', reboot: 'running' };
const targetKey = (link) => `${link.hostId}\u0000${link.node}\u0000${Number(link.vmid)}`;
const serviceError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function createProxmoxLifecycleManager({
  boxStore, proxmoxStore, inventory, makeClient, removeLinkedBox,
  netboxStore = null, makeNetboxClient = createNetboxClient,
  load = () => [], save = () => {}, now = () => new Date().toISOString(), makeId = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1500,
  taskTimeoutMs = 600_000, shutdownTimeoutMs = taskTimeoutMs, maxPollFailures = 5,
  maxJobs = 50, maxLogBytes = 65_536,
}) {
  const jobs = new Map();
  const settles = new Map();
  for (const job of load() || []) {
    if (!TERMINAL.has(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || now();
    }
    jobs.set(job.id, job);
  }
  const ordered = () => [...jobs.values()].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  const prune = () => {
    const terminal = ordered().filter((job) => TERMINAL.has(job.status));
    for (const job of terminal.slice(maxJobs)) jobs.delete(job.id);
  };
  const persist = () => { prune(); save(ordered()); };
  const appendLog = (job, text) => { if (text) job.log = `${job.log}${text}`.slice(-maxLogBytes); };
  const summary = (job) => ({ id: job.id, action: job.action, boxId: job.boxId, boxLabel: job.boxLabel, hostId: job.hostId, hostName: job.hostName, node: job.node, vmid: job.vmid, status: job.status, phase: job.phase, error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt });
  const assertTargetIdle = (key) => { if ([...jobs.values()].some((job) => job.status === 'running' && targetKey(job) === key)) throw serviceError(409, 'container already has an active lifecycle job'); };
  persist();

  async function pollTask(client, job, upid) {
    const deadline = Date.now() + taskTimeoutMs;
    let logStart = 0;
    let failures = 0;
    for (;;) {
      const lines = await client.taskLog(job.node, upid, logStart).catch(() => []);
      if (Array.isArray(lines) && lines.length) {
        logStart += lines.length;
        appendLog(job, `${lines.map((line) => line.t).join('\n')}\n`);
        persist();
      }
      let status = null;
      try {
        status = await client.taskStatus(job.node, upid);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= maxPollFailures) throw error;
      }
      if (status?.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') throw new Error(`task failed: ${status.exitstatus}`);
        return;
      }
      if (Date.now() > deadline) throw new Error('task timed out');
      await sleep(pollMs);
    }
  }

  async function resolveTarget(job) {
    const box = await boxStore.getBox(job.boxId);
    if (!box || !box.proxmox || targetKey(box.proxmox) !== targetKey(job)) {
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
    if (current.state !== REQUIRED[job.action]) throw new Error(`${job.action} requires ${REQUIRED[job.action]}`);
    job.phase = 'request'; persist();
    const method = `${job.action}Lxc`;
    const upid = await client[method](job.node, job.vmid);
    appendLog(job, `# ${job.action} ${upid}\n`); persist();
    await pollTask(client, job, upid);
    job.phase = 'verify'; persist();
    const expected = job.action === 'start' || job.action === 'reboot' ? 'running' : 'stopped';
    await waitForState(job, expected);
  }

  // Best-effort IPAM cleanup: release the auto-static allocation by its
  // stamped id, then delete every record matching the box's current IP so a
  // manually created NetBox record doesn't outlive the container. A NetBox
  // failure must never fail a deprovision whose container is already
  // destroyed — log it and let local cleanup finish.
  async function releaseNetboxIp(job, box) {
    const ipId = box?.proxmox?.netboxIpId;
    const hostIp = isIP(String(box?.host || '')) ? box.host : null;
    if ((!ipId && !hostIp) || !netboxStore) return;
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch { settings = null; }
    if (!settings) {
      if (ipId) { appendLog(job, `# could not release NetBox ip ${ipId}: NetBox integration not configured\n`); persist(); }
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

  async function runDeprovision(job) {
    const { box, client } = await resolveTarget(job);
    let current = await inventory.refreshBox(box);
    if (current.state === 'unknown') throw new Error(current.error || 'Proxmox state unavailable');
    if (current.state === 'missing') {
      job.phase = 'unlink'; persist();
      await releaseNetboxIp(job, box);
      await removeLinkedBox(job.boxId);
      return;
    }
    if (current.state === 'running') {
      job.phase = 'shutdown'; persist();
      const shutdown = await client.shutdownLxc(job.node, job.vmid);
      appendLog(job, `# shutdown ${shutdown}\n`); persist();
      await pollTask(client, job, shutdown);
      current = await waitForState(job, 'stopped', shutdownTimeoutMs);
    }
    if (current.state !== 'stopped') throw new Error(`deprovision requires stopped, got ${current.state}`);
    job.phase = 'destroy'; persist();
    const destroy = await client.destroyLxc(job.node, job.vmid);
    appendLog(job, `# destroy ${destroy}\n`); persist();
    await pollTask(client, job, destroy);
    job.phase = 'verify'; persist();
    await waitForState(job, 'missing', taskTimeoutMs);
    job.phase = 'unlink'; persist();
    await releaseNetboxIp(job, box);
    await removeLinkedBox(job.boxId);
  }

  async function run(job) {
    try {
      if (job.action === 'deprovision') await runDeprovision(job);
      else await runRoutine(job);
      job.phase = 'done'; job.status = 'done'; job.finishedAt = now(); persist();
    } catch (error) {
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
    const box = await boxStore.getBox(boxId);
    if (!box) throw serviceError(404, 'box not found');
    if (!box.proxmox) throw serviceError(409, 'box is not linked to Proxmox');
    const key = targetKey(box.proxmox);
    assertTargetIdle(key);
    const host = await proxmoxStore.getHost(box.proxmox.hostId, { withSecret: true });
    if (!host) throw serviceError(404, 'proxmox host not found');
    const current = await inventory.refreshBox(box).catch((error) => { throw serviceError(502, error.message); });
    if (current.state === 'unknown') throw serviceError(502, current.error || 'Proxmox state unavailable');
    if (action === 'deprovision') {
      if (input.confirmName !== box.label) throw serviceError(409, 'confirmation name does not match');
      if (!['running', 'stopped', 'missing'].includes(current.state)) throw serviceError(409, `deprovision cannot run from ${current.state}`);
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
      status: 'running', phase: 'resolve', log: '', error: null,
      createdAt: now(), finishedAt: null,
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

  return {
    createJob,
    getJob: (id) => jobs.get(id),
    listJobs: () => ordered().map(summary),
    hasActiveJob: (boxId) => [...jobs.values()].some((job) => job.boxId === boxId && job.status === 'running'),
    hasActiveTarget: (link) => [...jobs.values()].some((job) => targetKey(job) === targetKey(link) && job.status === 'running'),
    _settled: (id) => settles.get(id) || Promise.resolve(),
  };
}
