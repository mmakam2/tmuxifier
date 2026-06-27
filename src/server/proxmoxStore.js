import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertHostInput, assertKeyInput, assertPresetInput, assertRootPassword, parseEndpoint } from './proxmoxValidate.js';

const VERSION = 1;

function normalizePreset(spec, id, createdAt) {
  const net = spec.net || {};
  return {
    id, name: spec.name.trim(), hostId: spec.hostId, node: spec.node || null,
    template: spec.template, storage: spec.storage, diskGiB: spec.diskGiB,
    cores: spec.cores, memoryMiB: spec.memoryMiB, swapMiB: spec.swapMiB,
    unprivileged: spec.unprivileged !== false,
    features: spec.features && typeof spec.features === 'object' ? spec.features : {},
    net: { bridge: net.bridge, vlan: net.vlan ?? null, ipMode: net.ipMode, cidr: net.cidr ?? null, gateway: net.gateway ?? null },
    dns: { nameserver: spec.dns?.nameserver ?? null, searchdomain: spec.dns?.searchdomain ?? null },
    onboot: !!spec.onboot, startAfterCreate: spec.startAfterCreate !== false,
    mounts: Array.isArray(spec.mounts) ? spec.mounts.map((m) => ({ id: m.id, storage: m.storage, sizeGiB: m.sizeGiB, path: m.path, backup: !!m.backup })) : [],
    boxDefaults: { user: spec.boxDefaults?.user || 'root', sessionName: spec.boxDefaults?.sessionName || 'web', tags: spec.boxDefaults?.tags || [] },
    createdAt,
  };
}

export function createProxmoxStore({ dataDir, secretBox, makeId = randomUUID, now = () => new Date().toISOString() }) {
  const file = path.join(dataDir, 'proxmox.json');

  async function readAll() {
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      return { version: VERSION, hosts: [], keys: [], presets: [], ...v };
    } catch {
      return { version: VERSION, hosts: [], keys: [], presets: [] };
    }
  }
  async function writeAll(data) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  function redactHost(h) {
    const { tokenSecret, ...rest } = h;
    return { ...rest, hasToken: !!tokenSecret };
  }
  function redactKey(k) {
    const { publicKey, ...rest } = k;
    return { ...rest, hasKey: !!publicKey };
  }
  // Legacy keys were stored as cleartext; new ones are sealed. Accept both on read.
  function openKey(v) { return secretBox.isSealed(v) ? secretBox.open(v) : v; }
  function assertUniqueName(list, name, ignoreId) {
    const n = String(name || '').trim().toLowerCase();
    for (const it of list) {
      if (ignoreId && it.id === ignoreId) continue;
      if (String(it.name || '').trim().toLowerCase() === n) throw new Error('name already exists');
    }
  }

  return {
    async listHosts() { return (await readAll()).hosts.map(redactHost); },
    async getHost(id, { withSecret = false } = {}) {
      const h = (await readAll()).hosts.find((x) => x.id === id);
      if (!h) return undefined;
      return withSecret ? { ...h, tokenSecret: secretBox.open(h.tokenSecret) } : redactHost(h);
    },
    async addHost(spec) {
      assertHostInput(spec, { requireSecret: true });
      const data = await readAll();
      assertUniqueName(data.hosts, spec.name);
      const { host, port } = parseEndpoint(spec.endpoint);
      const h = {
        id: makeId(), name: spec.name.trim(), endpoint: `${host}:${port}`,
        tokenId: spec.tokenId, tokenSecret: secretBox.seal(spec.tokenSecret),
        fingerprint256: spec.fingerprint256 || null, verifyMode: spec.verifyMode || 'pin',
        defaultNode: spec.defaultNode || null, createdAt: now(),
      };
      data.hosts.push(h);
      await writeAll(data);
      return redactHost(h);
    },
    async updateHost(id, patch) {
      const data = await readAll();
      const i = data.hosts.findIndex((x) => x.id === id);
      if (i === -1) throw new Error('host not found');
      const merged = { ...data.hosts[i], ...patch };
      merged.tokenSecret = patch.tokenSecret ? secretBox.seal(patch.tokenSecret) : data.hosts[i].tokenSecret;
      if (patch.endpoint) { const { host, port } = parseEndpoint(patch.endpoint); merged.endpoint = `${host}:${port}`; }
      assertHostInput({ ...merged, tokenSecret: 'present' }, { requireSecret: false });
      assertUniqueName(data.hosts, merged.name, id);
      data.hosts[i] = merged;
      await writeAll(data);
      return redactHost(merged);
    },
    async removeHost(id) {
      const data = await readAll();
      data.hosts = data.hosts.filter((x) => x.id !== id);
      await writeAll(data);
    },
    async listKeys({ withSecret = false } = {}) {
      const keys = (await readAll()).keys;
      return withSecret ? keys.map((k) => ({ ...k, publicKey: openKey(k.publicKey) })) : keys.map(redactKey);
    },
    async addKey(spec) {
      assertKeyInput(spec);
      const data = await readAll();
      assertUniqueName(data.keys, spec.name);
      const k = { id: makeId(), name: spec.name.trim(), publicKey: secretBox.seal(spec.publicKey.trim()), createdAt: now() };
      data.keys.push(k);
      await writeAll(data);
      return redactKey(k);
    },
    async removeKey(id) {
      const data = await readAll();
      data.keys = data.keys.filter((x) => x.id !== id);
      await writeAll(data);
    },
    async hasRootPassword() { return !!(await readAll()).rootPassword; },
    async getRootPassword({ withSecret = false } = {}) {
      const sealed = (await readAll()).rootPassword;
      if (!withSecret || !sealed) return null;
      return secretBox.isSealed(sealed) ? secretBox.open(sealed) : sealed;
    },
    async setRootPassword(pw) { assertRootPassword(pw); const data = await readAll(); data.rootPassword = secretBox.seal(pw); await writeAll(data); },
    async clearRootPassword() { const data = await readAll(); delete data.rootPassword; await writeAll(data); },
    async listPresets() { return (await readAll()).presets; },
    async getPreset(id) { return (await readAll()).presets.find((x) => x.id === id); },
    async addPreset(spec) {
      const data = await readAll();
      assertPresetInput(spec, { keyIds: data.keys.map((k) => k.id), hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, spec.name);
      const p = normalizePreset(spec, makeId(), now());
      data.presets.push(p);
      await writeAll(data);
      return p;
    },
    async updatePreset(id, patch) {
      const data = await readAll();
      const i = data.presets.findIndex((x) => x.id === id);
      if (i === -1) throw new Error('preset not found');
      const merged = { ...data.presets[i], ...patch };
      assertPresetInput(merged, { keyIds: data.keys.map((k) => k.id), hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, merged.name, id);
      data.presets[i] = normalizePreset(merged, id, data.presets[i].createdAt);
      await writeAll(data);
      return data.presets[i];
    },
    async removePreset(id) {
      const data = await readAll();
      data.presets = data.presets.filter((x) => x.id !== id);
      await writeAll(data);
    },
  };
}
