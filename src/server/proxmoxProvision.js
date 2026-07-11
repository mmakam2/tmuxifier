import { randomUUID } from 'node:crypto';
import { buildCreateParams } from './proxmoxParams.js';
import { assertProvisionInput } from './proxmoxValidate.js';
import { createNetboxClient } from './netboxApi.js';

// 'cancelled' has no producer anymore (the never-wired cancel API was removed)
// but stays terminal so legacy persisted jobs reconcile correctly on load.
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save, defaultPublicKey = () => null,
  netboxStore = null, makeNetboxClient = createNetboxClient,
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
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }

  async function requireNetboxSettings() {
    let settings = null;
    try { settings = netboxStore ? await netboxStore.getSettings({ withSecret: true }) : null; } catch { settings = null; }
    if (!settings) throw new Error('auto-static requires the NetBox integration — configure it in Settings (⚙)');
    return settings;
  }

  async function pollTask(client, node, upid, j) {
    const deadline = Date.now() + taskTimeoutMs;
    let logStart = 0;
    let statusFailures = 0;
    for (;;) {
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

  async function discoverIp(client, node, vmid) {
    const deadline = Date.now() + leaseTimeoutMs;
    for (;;) {
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

      if (preset.net.ipMode === 'auto-static') {
        j.phase = 'allocate-ip'; persist();
        const netbox = makeNetboxClient(await requireNetboxSettings());
        const prefix = await netbox.findPrefixByVlan(preset.net.vlan);
        const res = await netbox.allocateIp(prefix, { status: 'active', description: `tmuxifier: ${j.hostname}` });
        j.ip = res.address; j.netboxIpId = res.id;
        appendLog(j, `# allocated ${res.address} from ${prefix.prefix} (NetBox ip ${res.id})\n`);
        persist();
      }

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
      // Any explicitly-known address (allocated, overridden, or preset-static)
      // wins; only pure DHCP falls back to lease discovery.
      if (j.ip) boxHost = String(j.ip).split('/')[0];
      else if (preset.net.ipMode === 'static') boxHost = String(preset.net.cidr).split('/')[0];
      else if (preset.startAfterCreate) boxHost = await discoverIp(client, j.node, j.vmid);

      if (boxHost) {
        j.phase = 'link'; persist();
        const bd = preset.boxDefaults || {};
        const box = await boxStore.addBox({
          label: j.hostname, host: boxHost, user: bd.user || 'root',
          sessionName: bd.sessionName || 'web', tags: (j.tags && j.tags.length) ? j.tags : (bd.tags || []),
          source: 'proxmox',
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, endpoint: host.endpoint, ...(j.netboxIpId ? { netboxIpId: j.netboxIpId } : {}) },
        }, { trustedProxmox: true });
        j.boxId = box.id;
      } else {
        j.needsHost = true;
      }
      j.phase = 'done'; j.status = 'done'; j.finishedAt = now(); persist();
    } catch (e) {
      if (j.netboxIpId) {
        // Best-effort: the reservation must not leak when the container never
        // materialized. (Documented trade-off: a create-then-start failure
        // releases the address even though a half-built container may exist.)
        try {
          const netbox = makeNetboxClient(await requireNetboxSettings());
          await netbox.releaseIp(j.netboxIpId);
          appendLog(j, `# released NetBox ip ${j.netboxIpId}\n`);
          j.netboxIpId = null;
        } catch (releaseError) {
          appendLog(j, `# could not release NetBox ip ${j.netboxIpId}: ${releaseError.message}\n`);
        }
      }
      j.status = 'error';
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
        ip: preset.net.ipMode === 'auto-static' ? null : (ip || (preset.net.ipMode === 'static' ? preset.net.cidr : null)),
        netboxIpId: null,
        status: 'running', phase: 'allocate', log: '', boxId: null, needsHost: false, error: null,
        createdAt: now(), finishedAt: null,
      };
      jobs.set(j.id, j);
      persist();
      const p = run(j, { client, preset, host, publicKeys, password }).finally(() => {});
      settles.set(j.id, p);
      return summary(j);
    },
    getProvision(id) { return jobs.get(id); },
    listProvisions() { return ordered().map(summary); },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
