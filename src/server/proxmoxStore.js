import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertHostInput, assertKeyInput, assertPresetInput, assertRootPassword, parseEndpoint } from './proxmoxValidate.js';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

function normalizePreset(spec, id, createdAt) {
  const net = spec.net || {};
  return {
    id, name: spec.name.trim(), hostId: spec.hostId, node: spec.node || null,
    template: spec.template, storage: spec.storage, diskGiB: spec.diskGiB,
    cores: spec.cores, memoryMiB: spec.memoryMiB, swapMiB: spec.swapMiB,
    unprivileged: spec.unprivileged !== false,
    features: spec.features && typeof spec.features === 'object' ? spec.features : {},
    net: { bridge: net.bridge, vlan: net.vlan ?? null, ipMode: net.ipMode, cidr: net.ipMode === 'auto-static' ? null : (net.cidr ?? null), gateway: net.ipMode === 'auto-static' ? null : (net.gateway ?? null) },
    dns: { nameserver: spec.dns?.nameserver ?? null, searchdomain: spec.dns?.searchdomain ?? null },
    onboot: !!spec.onboot, startAfterCreate: spec.startAfterCreate !== false,
    mounts: Array.isArray(spec.mounts) ? spec.mounts.map((m) => ({ id: m.id, storage: m.storage, sizeGiB: m.sizeGiB, path: m.path, backup: !!m.backup })) : [],
    boxDefaults: { user: spec.boxDefaults?.user || 'root', sessionName: spec.boxDefaults?.sessionName || 'web', tags: spec.boxDefaults?.tags || [] },
    createdAt,
  };
}

export function createProxmoxStore({ dataDir, secretBox, makeId = randomUUID, now = () => new Date().toISOString() }) {
  const file = path.join(dataDir, 'proxmox.json');

  // The shape check treats a well-formed-but-wrong file (e.g. a top-level array,
  // or hosts: null) as corrupt too, so it is quarantined instead of crashing the
  // list/find calls below.
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && ['hosts', 'keys', 'presets'].every((k) => !(k in v) || Array.isArray(v[k]));
  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape });
    return { version: VERSION, hosts: [], keys: [], presets: [], ...v };
  }
  async function writeAll(data) {
    await writeJson(file, data, { mode: 0o600 });
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
      assertPresetInput(spec, { hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, spec.name);
      const p = normalizePreset(spec, makeId(), now());
      data.presets.push(p);
      await writeAll(data);
      return p;
    },
    async updatePreset(id, spec) {
      const data = await readAll();
      const index = data.presets.findIndex((x) => x.id === id);
      if (index === -1) return undefined;
      assertPresetInput(spec, { hostIds: data.hosts.map((h) => h.id) });
      assertUniqueName(data.presets, spec.name, id);
      const current = data.presets[index];
      const preset = normalizePreset(spec, current.id, current.createdAt);
      data.presets[index] = preset;
      await writeAll(data);
      return preset;
    },
    async removePreset(id) {
      const data = await readAll();
      data.presets = data.presets.filter((x) => x.id !== id);
      await writeAll(data);
    },
  };
}
