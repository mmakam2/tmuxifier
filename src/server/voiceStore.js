import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import { MODEL_IDS, DEFAULT_MODEL_ID } from './voiceCatalog.js';

// data/voice.json — the authoritative record of whether voice is on and which
// model is selected. Read per request, so a Settings change applies without a
// restart (unlike .env, which is parsed once at boot).
//
// Nothing here is a secret, so unlike proxmox.json/netbox.json nothing is
// sealed — but the file is still written 0o600 via jsonFile.js, matching
// passkeys.json.
const DEFAULTS = { enabled: false, model: DEFAULT_MODEL_ID };

function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: o.enabled === true,
    // A model that has fallen out of the catalog (downgrade, edited file)
    // reads back as the default rather than propagating an unresolvable id.
    model: MODEL_IDS.includes(o.model) ? o.model : DEFAULT_MODEL_ID,
  };
}

export function createVoiceStore({ dataDir }) {
  const file = path.join(dataDir, 'voice.json');

  async function read() {
    // A corrupt file must fail open to the defaults: failing closed here would
    // only mean voice is off, but throwing would break /api/voice/status and
    // with it the UI that lets the operator fix anything.
    const raw = await readJson(file, { fallback: DEFAULTS, validate: (v) => v && typeof v === 'object' });
    return normalize(raw);
  }

  return {
    read,
    async update(patch = {}) {
      const current = await read();
      const next = { ...current };
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
      if (patch.model !== undefined) {
        // Validated against the catalog allowlist, never written through.
        if (!MODEL_IDS.includes(patch.model)) throw new Error(`unknown model: ${String(patch.model)}`);
        next.model = patch.model;
      }
      await writeJson(file, next);
      return next;
    },
  };
}
