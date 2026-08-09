import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;
export const NOTIFY_KINDS = ['agent-input', 'agent-done'];

// Enrolled Android devices (data/devices.json). The token itself is never
// stored — only its SHA-256 digest. A device token is 32 random bytes
// (256-bit entropy), so a fast digest is the right primitive: scrypt's cost
// defends low-entropy passwords, and here it would only tax the app's ~1s
// pane polling. Nothing in the file is secret enough to seal (digests and FCM
// registration tokens), but it is still written 0o600 via jsonFile.js and a
// corrupt file fails open to empty — same posture as passkeyStore.js, and the
// same reasoning: whoever can corrupt this file can already read .env.
const digest = (token) => createHash('sha256').update(String(token)).digest();

const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

export function createDeviceStore({ dataDir, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  const file = path.join(dataDir, 'devices.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('devices' in v) || Array.isArray(v.devices));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape, onCorrupt: log });
    return { version: VERSION, devices: Array.isArray(v.devices) ? v.devices : [] };
  }
  async function save(data) { await writeJson(file, data, { mode: 0o600 }); return data; }

  const notifyView = (d) => {
    const out = {};
    for (const k of NOTIFY_KINDS) out[k] = d.notify?.[k] !== false;
    return out;
  };
  const publicView = (d) => ({
    id: d.id, name: d.name, created: d.created ?? null, lastSeen: d.lastSeen ?? null,
    hasFcmToken: !!d.fcmToken, notify: notifyView(d),
  });

  // Same in-process read-modify-write mutex as passkeyStore.js: mutators
  // serialize onto one promise chain so a concurrent enroll and revoke cannot
  // clobber each other's write. In-process only — Tmuxifier is one process.
  let queue = Promise.resolve();
  function withLock(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    enroll({ name, fcmToken } = {}) {
      return withLock(async () => {
        const trimmed = String(name ?? '').trim();
        if (!NAME_RE.test(trimmed)) throw new Error('device name must be 1-64 printable characters');
        const token = randomBytes(32).toString('base64url');
        const entry = {
          id: randomBytes(8).toString('hex'),
          name: trimmed,
          tokenHash: digest(token).toString('hex'),
          created: now(),
          lastSeen: null,
          fcmToken: typeof fcmToken === 'string' && fcmToken ? fcmToken.slice(0, 4096) : null,
          notify: {},
        };
        const data = await readAll();
        data.devices = [...data.devices, entry];
        await save(data);
        return { device: publicView(entry), token };
      });
    },

    async verify(token) {
      if (typeof token !== 'string' || !token) return null;
      const d = digest(token);
      const { devices } = await readAll();
      for (const dev of devices) {
        const stored = Buffer.from(String(dev.tokenHash ?? ''), 'hex');
        if (stored.length === d.length && timingSafeEqual(stored, d)) return publicView(dev);
      }
      return null;
    },

    // lastSeen is display metadata, so it persists at most once a minute —
    // the app polls the pane every second and each touch is a full-file write.
    touch(id) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev) return;
        const t = now();
        if (dev.lastSeen != null && t - dev.lastSeen < 60_000) return;
        dev.lastSeen = t;
        await save(data);
      });
    },

    async list() { return (await readAll()).devices.map(publicView); },

    remove(id) {
      return withLock(async () => {
        const data = await readAll();
        const before = data.devices.length;
        data.devices = data.devices.filter((x) => x.id !== id);
        if (data.devices.length === before) return { removed: false };
        await save(data);
        return { removed: true };
      });
    },

    updateSelf(id, { fcmToken, notify } = {}) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev) return null;
        // PATCH merge: an omitted field keeps its stored value; explicit null
        // clears fcmToken. Booleans only for notify, unknown kinds ignored.
        if (fcmToken === null) dev.fcmToken = null;
        else if (typeof fcmToken === 'string' && fcmToken) dev.fcmToken = fcmToken.slice(0, 4096);
        if (notify && typeof notify === 'object') {
          dev.notify = dev.notify && typeof dev.notify === 'object' ? dev.notify : {};
          for (const k of NOTIFY_KINDS) {
            if (typeof notify[k] === 'boolean') dev.notify[k] = notify[k];
          }
        }
        await save(data);
        return publicView(dev);
      });
    },

    async listNotifiable(kind) {
      const { devices } = await readAll();
      return devices
        .filter((d) => d.fcmToken && d.notify?.[kind] !== false)
        .map((d) => ({ id: d.id, fcmToken: d.fcmToken }));
    },

    clearFcmToken(id) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev || dev.fcmToken == null) return;
        dev.fcmToken = null;
        await save(data);
      });
    },
  };
}
