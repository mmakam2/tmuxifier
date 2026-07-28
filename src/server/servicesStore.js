import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';
import { normFp } from './tlsPin.js';

// CRUD for the standby dashboard's service tiles (data/services.json), in the
// mold of store.js: normalize+validate inside, mutations serialized so two
// concurrent read-modify-write cycles can't drop each other's change.
const KINDS = ['http', 'tcp', 'none', 'pihole', 'truenas', 'unifi'];
const SECTIONS = ['services', 'infrastructure'];
// Kinds whose record can carry a sealed credential; changing to any other kind
// drops it.
const SECRET_KINDS = new Set(['pihole', 'truenas', 'unifi']);
const SAFE_TCP_HOST = /^[A-Za-z0-9_.-]+$/; // same family as sshCommand.js SAFE_HOST
// A UniFi controller's certificate is self-signed by default and the key it
// guards can write, so this kind gets the full three-way choice rather than the
// verified/insecure pair pihole and truenas share.
const UNIFI_TLS_MODES = ['verify', 'pin', 'insecure'];
// Both kinds refuse plain HTTP, for different reasons — so the reason travels
// with the call rather than being baked into the helper.
const TRUENAS_HTTPS_REASON = 'TrueNAS permanently revokes any API key sent over plain HTTP';
const UNIFI_HTTPS_REASON = 'the API key is write-capable and UniFi controllers always serve TLS';

function assertHttpUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${label} must be http(s)`);
}

// Some kinds refuse an http target outright rather than offering it as an
// opt-out. TrueNAS does so because the failure mode destroys the operator's
// credential (it permanently revokes any key sent in the clear); UniFi does so
// because the key can write to the network. The reason is a parameter so each
// kind explains its own refusal instead of inheriting another product's.
function assertHttpsUrl(value, label, reason = '') {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol === 'http:') {
    throw new Error(`${label} must be https${reason ? ` — ${reason}` : ''}`);
  }
  if (u.protocol !== 'https:') throw new Error(`${label} must be https`);
}

function normalizeCheck(raw, base) {
  const merged = { ...(base || {}), ...(raw || {}) };
  const kind = merged.kind ?? 'http';
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, pihole, truenas, unifi, or none');
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
  if (kind === 'pihole') {
    // The Pi-hole v6 API base. Empty means "use the tile's own url", which is
    // the common case: the link and the API live on the same host.
    const out = { kind };
    if (target) { assertHttpUrl(target, 'check.target'); out.target = target; }
    // Verified TLS is the default; this is the per-service opt-out, because
    // unlike the http/tcp checks this one sends a password.
    if (merged.insecure === true) out.insecure = true;
    return out;
  }
  if (kind === 'truenas') {
    const out = { kind };
    // The JSON-RPC API base. Empty means "use the tile's own url", which is the
    // common case: the link and the API live on the same host.
    if (target) { assertHttpsUrl(target, 'check.target', TRUENAS_HTTPS_REASON); out.target = target; }
    // API keys are user-linked from TrueNAS 25.04, and auth.login_ex needs the
    // account name alongside the key. Not a secret — stored in the clear.
    const username = String(merged.username ?? '').trim();
    if (!username || username.length > 64) throw new Error('truenas check requires a username (1-64 characters)');
    out.username = username;
    // Verified TLS is the default; this is the per-service opt-out for a NAS
    // with a self-signed certificate. It never downgrades the scheme.
    if (merged.insecure === true) out.insecure = true;
    return out;
  }
  if (kind === 'unifi') {
    const out = { kind };
    // The Network Integration API base. Empty means "use the tile's own url",
    // which is the common case: the link and the API live on the same controller.
    if (target) { assertHttpsUrl(target, 'check.target', UNIFI_HTTPS_REASON); out.target = target; }
    // Optional site selector, matched against the controller's own
    // internalReference/name/id. Empty means the first site it reports, which is
    // right for the single-site case that dominates.
    const site = String(merged.site ?? '').trim();
    if (site) {
      if (site.length > 64) throw new Error('unifi site must be at most 64 characters');
      out.site = site;
    }
    const tls = merged.tls ?? 'verify';
    if (!UNIFI_TLS_MODES.includes(tls)) throw new Error('unifi check tls must be verify, pin, or insecure');
    out.tls = tls;
    // The pin is meaningless outside pin mode, so leaving that mode drops it
    // rather than carrying a stale fingerprint into a later read.
    if (tls === 'pin') {
      const fp = normFp(merged.fingerprint);
      if (!fp) throw new Error('unifi check with tls "pin" requires a certificate fingerprint');
      out.fingerprint = fp;
    }
    return out;
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

export function createServicesStore({ dataDir, secretBox = null }) {
  const file = path.join(dataDir, 'services.json');
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.services);

  async function readAll() {
    return (await readJson(file, { fallback: { version: 1, services: [] }, validate: valid })).services;
  }
  async function writeAll(services) {
    // 0o600 because a pihole tile's record carries a sealed app password.
    await writeJson(file, { version: 1, services }, { mode: 0o600 });
  }

  // The app password is the only secret a service record can hold. It is sealed
  // before it touches disk (AES-256-GCM, key from cookieSecret) and redacted on
  // every read — getServiceSecret is the sole decrypting path, mirroring
  // netboxStore.getSettings({ withSecret: true }).
  function redact(svc) {
    const { secret, ...rest } = svc;
    return { ...rest, hasPassword: !!secret };
  }

  function sealPassword(spec, base) {
    // Only a pihole or truenas check has anywhere to use one; changing kind drops it.
    if (!SECRET_KINDS.has(spec.check?.kind ?? base.check?.kind)) return undefined;
    if (spec.password === undefined) return base.secret;
    if (spec.password === null || String(spec.password) === '') return undefined;
    if (!secretBox) throw new Error('cannot store a credential: no secret box configured');
    return secretBox.seal(String(spec.password));
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
    const check = normalizeCheck(spec.check, base.check);
    // A truenas or unifi check with no explicit target dials the tile's own url,
    // so that url has to clear the same https bar the target does.
    if (check.kind === 'truenas' && !check.target) assertHttpsUrl(url, 'service url', TRUENAS_HTTPS_REASON);
    if (check.kind === 'unifi' && !check.target) assertHttpsUrl(url, 'service url', UNIFI_HTTPS_REASON);
    const out = {
      id: base.id || `svc-${randomUUID()}`,
      name,
      url,
      section,
      check,
      createdAt: base.createdAt || new Date().toISOString(),
    };
    const glyph = optionalString(spec.glyph, base.glyph, { label: 'glyph', max: 4 });
    if (glyph !== undefined) out.glyph = glyph;
    const group = optionalString(spec.group, base.group, { label: 'group', max: 32 });
    if (group !== undefined) out.group = group;
    const secret = sealPassword(spec, base);
    if (secret !== undefined) out.secret = secret;
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
    async listServices() { return (await readAll()).map(redact); },
    async getService(id) {
      const svc = (await readAll()).find((s) => s.id === id);
      return svc ? redact(svc) : undefined;
    },
    async getServiceSecret(id) {
      const svc = (await readAll()).find((s) => s.id === id);
      if (!svc?.secret || !secretBox) return null;
      try { return secretBox.open(svc.secret); } catch { return null; }
    },
    async addService(spec) {
      return serialize(async () => {
        const services = await readAll();
        const svc = normalize(spec || {});
        services.push(svc);
        await writeAll(services);
        return redact(svc);
      });
    },
    async updateService(id, patch) {
      return serialize(async () => {
        const services = await readAll();
        const index = services.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('service not found');
        services[index] = normalize(patch || {}, services[index]);
        await writeAll(services);
        return redact(services[index]);
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
