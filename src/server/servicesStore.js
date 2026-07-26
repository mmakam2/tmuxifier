import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

// CRUD for the standby dashboard's service tiles (data/services.json), in the
// mold of store.js: normalize+validate inside, mutations serialized so two
// concurrent read-modify-write cycles can't drop each other's change.
const KINDS = ['http', 'tcp', 'none'];
const SECTIONS = ['services', 'infrastructure'];
const SAFE_TCP_HOST = /^[A-Za-z0-9_.-]+$/; // same family as sshCommand.js SAFE_HOST

function assertHttpUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${label} must be http(s)`);
}

function normalizeCheck(raw, base) {
  const merged = { ...(base || {}), ...(raw || {}) };
  const kind = merged.kind ?? 'http';
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, or none');
  const target = typeof merged.target === 'string' ? merged.target.trim() : '';
  if (kind === 'http') {
    if (!target) return { kind };
    assertHttpUrl(target, 'check.target');
    return { kind, target };
  }
  if (kind === 'tcp') {
    const m = /^(.+):(\d+)$/.exec(target);
    if (!m) throw new Error('tcp check requires a target of the form host:port');
    const host = m[1];
    const port = Number(m[2]);
    if (!SAFE_TCP_HOST.test(host) || host.startsWith('-')) throw new Error(`unsafe tcp host: ${JSON.stringify(host)}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid tcp port: ${m[2]}`);
    return { kind, target };
  }
  if (target) throw new Error("check.target must be absent for kind 'none'");
  return { kind };
}

function optionalString(value, base, { label, max }) {
  if (value === null) return undefined; // explicit clear
  const raw = value ?? base;
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (s.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return s;
}

export function createServicesStore({ dataDir }) {
  const file = path.join(dataDir, 'services.json');
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.services);

  async function readAll() {
    return (await readJson(file, { fallback: { version: 1, services: [] }, validate: valid })).services;
  }
  async function writeAll(services) {
    await writeJson(file, { version: 1, services });
  }

  function normalize(spec, base = {}) {
    const name = String(spec.name ?? base.name ?? '').trim();
    if (!name || name.length > 64) throw new Error('service name is required (1-64 characters)');
    const url = String(spec.url ?? base.url ?? '').trim();
    assertHttpUrl(url, 'service url');
    // The dashboard section the tile renders under; the free-text `group` is
    // the category within it (e.g. infrastructure -> "DNS Filtering").
    const section = spec.section ?? base.section ?? 'services';
    if (!SECTIONS.includes(section)) throw new Error('section must be services or infrastructure');
    const out = {
      id: base.id || `svc-${randomUUID()}`,
      name,
      url,
      section,
      check: normalizeCheck(spec.check, base.check),
      createdAt: base.createdAt || new Date().toISOString(),
    };
    const glyph = optionalString(spec.glyph, base.glyph, { label: 'glyph', max: 4 });
    if (glyph !== undefined) out.glyph = glyph;
    const group = optionalString(spec.group, base.group, { label: 'group', max: 32 });
    if (group !== undefined) out.group = group;
    return out;
  }

  // Same serialization seam as store.js: mutations queue, reads stay free.
  let queue = Promise.resolve();
  function serialize(op) {
    const run = queue.then(op, op);
    queue = run.then(() => {}, () => {});
    return run;
  }

  return {
    async listServices() { return readAll(); },
    async getService(id) { return (await readAll()).find((s) => s.id === id); },
    async addService(spec) {
      return serialize(async () => {
        const services = await readAll();
        const svc = normalize(spec || {});
        services.push(svc);
        await writeAll(services);
        return svc;
      });
    },
    async updateService(id, patch) {
      return serialize(async () => {
        const services = await readAll();
        const index = services.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('service not found');
        services[index] = normalize(patch || {}, services[index]);
        await writeAll(services);
        return services[index];
      });
    },
    async removeService(id) {
      return serialize(async () => {
        const services = await readAll();
        await writeAll(services.filter((s) => s.id !== id));
      });
    },
  };
}
