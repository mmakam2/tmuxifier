import { randomUUID } from 'node:crypto';
import { buildCreateParams } from './proxmoxParams.js';
import { assertProvisionInput } from './proxmoxValidate.js';

const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save, defaultPublicKey = () => null,
  now = () => new Date().toISOString(), makeId = randomUUID, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 1500, taskTimeoutMs = 600000, leaseTimeoutMs = 60000, maxJobs = 50, maxLogBytes = 65536,
  maxPollFailures = 5, // consecutive taskStatus errors tolerated before the job fails
}) {
  const jobs = new Map();
  const settles = new Map();

  // Startup reconciliation: a job still 'running' lost its poller when the process died.
  for (const j of load() || []) {
    if (!TERMINAL.has(j.status)) { j.status = 'interrupted'; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
  }
  persist();

  function ordered() { return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
  function persist() { save(ordered().slice(0, maxJobs)); }
  function summary(j) {
    return { id: j.id, presetName: j.presetName, hostname: j.hostname, vmid: j.vmid, status: j.status, phase: j.phase, createdAt: j.createdAt, finishedAt: j.finishedAt, boxId: j.boxId, needsHost: j.needsHost };
  }
  function publicJob(j) { if (!j) return j; const { _cancelled, ...rest } = j; return rest; }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }

  async function pollTask(client, node, upid, j) {
    const deadline = Date.now() + taskTimeoutMs;
    let logStart = 0;
    let statusFailures = 0;
    for (;;) {
      if (j._cancelled) throw new Error('cancelled');
      const lines = await client.taskLog(node, upid, logStart).catch(() => []);
      if (Array.isArray(lines) && lines.length) {
        logStart += lines.length;
        appendLog(j, lines.map((l) => l.t).join('\n') + '\n');
        persist();
      }
      // One transient hiccup (network blip, pveproxy restart) during a
      // minutes-long create/start poll must not fail the whole job and orphan
      // the container on PVE — only consecutive failures count as an outage.
      let st = null;
      try {
        st = await client.taskStatus(node, upid);
        statusFailures = 0;
      } catch (e) {
        statusFailures += 1;
        if (statusFailures >= maxPollFailures) throw e;
      }
      if (st && st.status === 'stopped') {
        if (st.exitstatus && st.exitstatus !== 'OK') throw new Error(`task failed: ${st.exitstatus}`);
        return;
      }
      if (Date.now() > deadline) throw new Error('task timed out');
      await sleep(pollMs);
    }
  }

  async function discoverIp(client, node, vmid, j) {
    const deadline = Date.now() + leaseTimeoutMs;
    for (;;) {
      if (j._cancelled) throw new Error('cancelled');
      const ifaces = await client.lxcInterfaces(node, vmid).catch(() => []);
      const eth = (ifaces || []).find((i) => i.name === 'eth0' && i.inet);
      if (eth) return String(eth.inet).split('/')[0];
      if (Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  }

  async function run(j, { client, preset, host, publicKeys, password }) {
    try {
      j.phase = 'allocate'; persist();
      if (!j.vmid) j.vmid = Number(await client.nextId());

      j.phase = 'create'; persist();
      const params = buildCreateParams(preset, { vmid: j.vmid, hostname: j.hostname, ip: j.ip, publicKeys, password });
      const upid = await client.createLxc(j.node, params);
      appendLog(j, `# create ${upid}\n`); persist();
      await pollTask(client, j.node, upid, j);

      if (preset.startAfterCreate) {
        j.phase = 'start'; persist();
        const sup = await client.startLxc(j.node, j.vmid);
        appendLog(j, `# start ${sup}\n`); persist();
        await pollTask(client, j.node, sup, j);
      }

      j.phase = 'discover'; persist();
      let boxHost = null;
      if (preset.net.ipMode === 'static') boxHost = String(j.ip || preset.net.cidr).split('/')[0];
      else if (preset.startAfterCreate) boxHost = await discoverIp(client, j.node, j.vmid, j);

      if (boxHost) {
        j.phase = 'link'; persist();
        const bd = preset.boxDefaults || {};
        const box = await boxStore.addBox({
          label: j.hostname, host: boxHost, user: bd.user || 'root',
          sessionName: bd.sessionName || 'web', tags: (j.tags && j.tags.length) ? j.tags : (bd.tags || []), source: 'proxmox',
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, endpoint: host.endpoint },
        });
        j.boxId = box.id;
      } else {
        j.needsHost = true;
      }
      j.phase = 'done'; j.status = 'done'; j.finishedAt = now(); persist();
    } catch (e) {
      j.status = j._cancelled ? 'cancelled' : 'error';
      j.error = e.message;
      j.finishedAt = now();
      persist();
    }
  }

  return {
    async createProvision({ presetId, hostname, vmid, ip, tags }) {
      assertProvisionInput({ hostname, vmid, ip, tags });
      const preset = await proxmoxStore.getPreset(presetId);
      if (!preset) throw new Error('preset not found');
      const host = await proxmoxStore.getHost(preset.hostId, { withSecret: true });
      if (!host) throw new Error('host not found');
      const node = preset.node || host.defaultNode;
      if (!node) throw new Error('preset has no node and host has no defaultNode');
      // Inject the host's default key plus every stored key (no longer preset-scoped).
      const additional = (await proxmoxStore.listKeys({ withSecret: true })).map((k) => k.publicKey);
      const publicKeys = [await defaultPublicKey(), ...additional].filter(Boolean);
      const password = await proxmoxStore.getRootPassword({ withSecret: true });
      const client = makeClient(host);
      const j = {
        id: makeId(), presetId, presetName: preset.name, hostId: host.id, node,
        hostname, vmid: vmid ? Number(vmid) : null,
        tags: Array.isArray(tags) ? tags : null,
        ip: ip || (preset.net.ipMode === 'static' ? preset.net.cidr : null),
        status: 'running', phase: 'allocate', log: '', boxId: null, needsHost: false, error: null,
        createdAt: now(), startedAt: now(), finishedAt: null,
      };
      jobs.set(j.id, j);
      persist();
      const p = run(j, { client, preset, host, publicKeys, password }).finally(() => {});
      settles.set(j.id, p);
      return summary(j);
    },
    getProvision(id) { return publicJob(jobs.get(id)); },
    listProvisions() { return ordered().map(summary); },
    cancelProvision(id) {
      const j = jobs.get(id);
      if (!j) return undefined;
      if (!TERMINAL.has(j.status)) j._cancelled = true;
      return summary(j);
    },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
