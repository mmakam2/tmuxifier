import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { buildCreateParams } from './proxmoxParams.js';
import { assertProvisionInput, isCidr } from './proxmoxValidate.js';
import { createNetboxClient } from './netboxApi.js';
import { newestFirst } from './jobOrder.js';
import { pollPveTask } from './pveTask.js';

// 'cancelled' has no producer anymore (the never-wired cancel API was removed)
// but stays terminal so legacy persisted jobs reconcile correctly on load.
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save, defaultPublicKey = () => null,
  knownHosts = null,
  netboxStore = null, makeNetboxClient = createNetboxClient,
  startSetup = null,
  now = () => new Date().toISOString(), makeId = randomUUID, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 1500, taskTimeoutMs = 600000, leaseTimeoutMs = 60000, maxJobs = 50, maxLogBytes = 65536,
  maxPollFailures = 5, // consecutive taskStatus errors tolerated before the job fails
}) {
  const jobs = new Map();
  const settles = new Map();

  const orphaned = []; // interrupted jobs holding a NetBox reservation nothing else can reclaim
  // Startup reconciliation: a job still 'running' lost its poller when the process died.
  for (const j of load() || []) {
    // One bad history row must never keep the server from booting: the store
    // validates only Array.isArray, so a `[null]` file parses, is never
    // quarantined, and would throw a TypeError right here — at module top level.
    if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
    const wasActive = !TERMINAL.has(j.status);
    if (wasActive) { j.status = 'interrupted'; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
    // An auto-static job interrupted mid-flight holds a NetBox reservation that
    // nothing else can reclaim: no box was linked, so deprovision will never see
    // it, and no route or view exposes a leaked netboxIpId. A job that DID link a
    // box is left alone — the address belongs to that box now, and its
    // deprovision releases it.
    if (wasActive && j.netboxIpId && !j.boxId) orphaned.push(j);
  }
  persist();
  // Fire-and-forget so a slow or unreachable NetBox cannot delay boot; awaited by
  // _reconciled() in tests.
  const reconciled = orphaned.length
    ? (async () => { for (const j of orphaned) await releaseNetboxIp(j); persist(); })()
    : Promise.resolve();

  function ordered() { return [...jobs.values()].sort(newestFirst); }
  // Terminal-only pruning (the lifecycle manager's rule): active jobs are
  // never dropped — the old blind slice-to-maxJobs on disk could evict a
  // still-running job's record — and the in-memory map no longer grows
  // unboundedly (it used to retain every job ever run, log and all).
  function prune() {
    const terminal = ordered().filter((j) => TERMINAL.has(j.status));
    for (const j of terminal.slice(maxJobs)) { jobs.delete(j.id); settles.delete(j.id); }
  }
  function persist() { prune(); save(ordered()); }
  function summary(j) {
    return { id: j.id, presetName: j.presetName, hostname: j.hostname, vmid: j.vmid, status: j.status, phase: j.phase, createdAt: j.createdAt, finishedAt: j.finishedAt, boxId: j.boxId, needsHost: j.needsHost };
  }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }

  // Releasing a reservation is best-effort in both callers (a failed run and a
  // job interrupted by a restart), and never allowed to throw: NetBox being
  // unreachable must not fail a job any further, nor keep the server from
  // booting. The id is cleared only on a confirmed release, so a failure leaves
  // it recorded and chaseable rather than silently forgotten.
  async function releaseNetboxIp(j) {
    if (!j.netboxIpId) return;
    try {
      const netbox = makeNetboxClient(await requireNetboxSettings());
      await netbox.releaseIp(j.netboxIpId);
      appendLog(j, `# released NetBox ip ${j.netboxIpId}\n`);
      j.netboxIpId = null;
    } catch (releaseError) {
      appendLog(j, `# could not release NetBox ip ${j.netboxIpId}: ${releaseError.message}\n`);
    }
  }

  async function requireNetboxSettings() {
    if (!netboxStore) throw new Error('auto-static requires the NetBox integration — configure it in Settings (⚙)');
    let settings;
    // A read/decrypt failure (rotated cookieSecret, unreadable file) is a real
    // error — reporting it as "not configured" sends the user to re-configure
    // an integration that is already configured.
    try { settings = await netboxStore.getSettings({ withSecret: true }); }
    catch (e) { throw new Error(`NetBox settings could not be read: ${e?.message || e}`); }
    if (!settings) throw new Error('auto-static requires the NetBox integration — configure it in Settings (⚙)');
    return settings;
  }

  function pollTask(client, node, upid, j) {
    return pollPveTask(client, node, upid, {
      onLog: (text) => { appendLog(j, text); persist(); },
      timeoutMs: taskTimeoutMs, pollMs, sleep, maxPollFailures,
    });
  }

  // The address the linked box WILL carry, when it is knowable before the
  // container exists — static presets only. dhcp discovers a lease (and
  // buildNet0 ignores an ip override there, so the override could never be
  // this container's address) and auto-static allocates from NetBox at run
  // time, so neither can be checked up front. Mirrors run()'s own boxHost
  // choice for the static case.
  function plannedHost(preset, ip) {
    if (preset.net.ipMode !== 'static') return null;
    return String(ip || preset.net.cidr || '').split('/')[0] || null;
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
        const settings = await requireNetboxSettings();
        const netbox = makeNetboxClient(settings);
        const prefix = await netbox.findPrefixByVlan(preset.net.vlan);
        // dns_name: suffix validated at settings save, hostname at request
        // time — the composed value needs no re-validation. Write-once: a
        // later box rename never updates the NetBox record (by design).
        const dnsName = settings.dnsSuffix ? `${j.hostname}.${settings.dnsSuffix}` : j.hostname;
        const res = await netbox.allocateIp(prefix, { status: 'active', description: `tmuxifier: ${j.hostname}`, dns_name: dnsName });
        j.netboxIpId = res.id;
        if (!isCidr(res.address)) throw new Error('NetBox returned an unusable address: ' + res.address);
        j.ip = res.address;
        j.gateway = res.gateway;
        appendLog(j, `# allocated ${res.address} from ${prefix.prefix} (gw ${res.gateway}, NetBox ip ${res.id})\n`);
        persist();
      }

      j.phase = 'create'; persist();
      const params = buildCreateParams(preset, { vmid: j.vmid, hostname: j.hostname, ip: j.ip, gateway: j.gateway, publicKeys, password });
      const upid = await client.createLxc(j.node, params);
      appendLog(j, `# create ${upid}\n`); persist();
      await pollTask(client, j.node, upid, j);

      if (preset.startAfterCreate) {
        j.phase = 'start'; persist();
        const sup = await client.startGuest('lxc', j.node, j.vmid);
        appendLog(j, `# start ${sup}\n`); persist();
        await pollTask(client, j.node, sup, j);
      }

      j.phase = 'discover'; persist();
      let boxHost = null;
      // An explicitly-known address (allocated or preset-static) wins. dhcp
      // always lease-discovers: an ip override is never applied to net0 for
      // dhcp presets (buildNet0 ignores it there), so the override could
      // never actually be this container's address.
      if (j.ip && preset.net.ipMode !== 'dhcp') boxHost = String(j.ip).split('/')[0];
      else if (preset.net.ipMode === 'static') boxHost = String(preset.net.cidr).split('/')[0];
      else if (preset.startAfterCreate) boxHost = await discoverIp(client, j.node, j.vmid);

      if (boxHost) {
        j.phase = 'link'; persist();
        // Tmuxifier just created this guest at boxHost — any known_hosts entry
        // for that address is by definition stale (NetBox-recycled IP).
        // Best-effort; provisioned boxes use the default port 22. Only forget
        // when boxHost is a real IP: the allocated/static sources are already
        // validated (isCidr), but a dhcp-discovered address comes straight
        // from the PVE lxcInterfaces API and isn't otherwise validated until
        // addBox's assertBoxSafe runs below — a compromised/misbehaving PVE
        // endpoint must not be able to pick an arbitrary known_hosts entry
        // to remove.
        if (knownHosts && isIP(boxHost)) { try { await knownHosts.forget(boxHost, 22); } catch {} }
        const bd = preset.boxDefaults || {};
        const box = await boxStore.addBox({
          label: j.hostname, host: boxHost, user: bd.user || 'root',
          sessionName: bd.sessionName || 'web', tags: (j.tags && j.tags.length) ? j.tags : (bd.tags || []),
          source: 'proxmox',
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, kind: 'lxc', endpoint: host.endpoint, ...(j.netboxIpId ? { netboxIpId: j.netboxIpId } : {}) },
        }, { trustedProxmox: true });
        j.boxId = box.id;
        if (startSetup && j.setupOptions) {
          // Server-side, durable setup: survives the browser closing during
          // either phase. waitForSsh: the container was just started, so sshd
          // may not accept the injected key yet.
          try { startSetup(box, j.setupOptions, { waitForSsh: true }); } catch {}
        }
      } else {
        j.needsHost = true;
      }
      j.phase = 'done'; j.status = 'done'; j.finishedAt = now(); persist();
    } catch (e) {
      // The reservation must not leak when the container never materialized.
      // (Documented trade-off: a create-then-start failure releases the address
      // even though a half-built container may exist.)
      await releaseNetboxIp(j);
      j.status = 'error';
      j.error = e.message;
      j.finishedAt = now();
      persist();
    }
  }

  return {
    async createProvision({ presetId, hostname, vmid, ip, tags, setupOptions = null }) {
      assertProvisionInput({ hostname, vmid, ip, tags });
      const preset = await proxmoxStore.getPreset(presetId);
      if (!preset) throw new Error('preset not found');
      // Fail fast, and here it is load-bearing rather than merely tidy: the
      // hostname becomes the box's label and only addBox — in the link phase,
      // long after Proxmox has built the container — enforces uniqueness, so a
      // duplicate used to be discovered by a failed job standing next to an
      // orphaned guest the user then had to clean up by hand.
      const conflict = await boxStore.uniquenessConflict({ label: hostname, host: plannedHost(preset, ip) });
      if (conflict) throw new Error(`${conflict} — nothing was provisioned`);
      // Fail fast: reject at request time (HTTP 400, no job record) instead of
      // erroring later in the allocate-ip phase of a job that already exists.
      if (preset.net.ipMode === 'auto-static') await requireNetboxSettings();
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
        gateway: null,
        status: 'running', phase: 'allocate', log: '', boxId: null, needsHost: false, error: null,
        setupOptions: setupOptions || null,
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
    _reconciled() { return reconciled; },
  };
}
