import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCheckInput } from './checkTypes.js';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// data/checks.json. Mirrors netboxStore.js: per-check secrets are sealed before
// they touch disk and redacted to hasSecret on every read; getCheck(id,
// { withSecret: true }) is the only decrypting path and is server-internal.
export function createCheckStore({ dataDir, secretBox, now = () => new Date().toISOString(), genId = randomUUID }) {
  const file = path.join(dataDir, 'checks.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('checks' in v) || Array.isArray(v.checks));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape });
    return { version: VERSION, checks: [], ...v };
  }
  const redact = ({ secret, ...rest }) => ({ ...rest, hasSecret: !!secret });

  return {
    async listChecks() {
      return (await readAll()).checks.map(redact);
    },
    async getCheck(id, { withSecret = false } = {}) {
      const found = (await readAll()).checks.find((c) => c.id === id);
      if (!found) return null;
      if (!withSecret) return redact(found);
      return { ...found, secret: found.secret ? secretBox.open(found.secret) : null };
    },
    async addCheck(spec) {
      const norm = assertCheckInput(spec);
      const data = await readAll();
      const secret = typeof spec.secret === 'string' && spec.secret.trim()
        ? secretBox.seal(spec.secret.trim()) : null;
      const check = { id: genId(), ...norm, secret, createdAt: now(), updatedAt: now() };
      data.checks.push(check);
      await writeJson(file, data, { mode: 0o600 });
      return redact(check);
    },
    async updateCheck(id, spec) {
      const norm = assertCheckInput(spec);
      const data = await readAll();
      const i = data.checks.findIndex((c) => c.id === id);
      if (i === -1) return null;
      const existing = data.checks[i];
      // A blank secret means "leave it alone", so an edit form never has to
      // round-trip a credential through the browser to avoid clearing it.
      const secret = typeof spec.secret === 'string' && spec.secret.trim()
        ? secretBox.seal(spec.secret.trim()) : existing.secret;
      data.checks[i] = { ...existing, ...norm, secret, updatedAt: now() };
      await writeJson(file, data, { mode: 0o600 });
      return redact(data.checks[i]);
    },
    async removeCheck(id) {
      const data = await readAll();
      const before = data.checks.length;
      data.checks = data.checks.filter((c) => c.id !== id);
      if (data.checks.length === before) return false;
      await writeJson(file, data, { mode: 0o600 });
      return true;
    },
  };
}
