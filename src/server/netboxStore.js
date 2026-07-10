import path from 'node:path';
import { assertSettingsInput } from './netboxValidate.js';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// Persisted NetBox integration settings (data/netbox.json). Single-settings-object
// store, not a list: Tmuxifier talks to one NetBox. The API token is sealed by
// secretBox before it touches disk and redacted to hasToken on every read;
// getSettings({ withSecret: true }) is the only decrypting path (server-internal).
export function createNetboxStore({ dataDir, secretBox, now = () => new Date().toISOString() }) {
  const file = path.join(dataDir, 'netbox.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('settings' in v) || v.settings === null || (typeof v.settings === 'object' && !Array.isArray(v.settings)));
  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape });
    return { version: VERSION, settings: null, ...v };
  }
  function redact(s) {
    const { token, ...rest } = s;
    return { ...rest, hasToken: !!token };
  }
  return {
    async getSettings({ withSecret = false } = {}) {
      const s = (await readAll()).settings;
      if (!s) return null;
      return withSecret ? { ...s, token: secretBox.open(s.token) } : redact(s);
    },
    async setSettings(spec) {
      const data = await readAll();
      const existing = data.settings;
      const blankToken = !(typeof spec.token === 'string' && spec.token.trim());
      const keepToken = blankToken && !!(existing && existing.token);
      const norm = assertSettingsInput(spec, { requireToken: !keepToken });
      const token = keepToken ? existing.token : secretBox.seal(spec.token.trim());
      data.settings = { ...norm, token, updatedAt: now() };
      await writeJson(file, data, { mode: 0o600 });
      return redact(data.settings);
    },
    async clearSettings() {
      const data = await readAll();
      data.settings = null;
      await writeJson(file, data, { mode: 0o600 });
    },
  };
}
