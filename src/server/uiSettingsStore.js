import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

// data/ui-settings.json — cross-device UI preferences (theme, clawd working
// animation). Single-user app: one record, no per-user keying. Read per
// request like voiceStore.js so a change applies without a restart.
//
// Catalog-agnostic on purpose: the theme/variant catalogs live in the web
// bundle, so the server validates SHAPE only (slug charset/length) and the
// client normalizes unknown ids to defaults — renaming a theme in code can
// never brick the server. `null` means "never set", which the client needs
// to tell a fresh install from an explicit choice (the clawd migration).
const KEYS = ['theme', 'clawdAnim'];
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of KEYS) out[k] = typeof o[k] === 'string' && SLUG_RE.test(o[k]) ? o[k] : null;
  return out;
}

export function createUiSettingsStore({ dataDir }) {
  const file = path.join(dataDir, 'ui-settings.json');

  async function read() {
    // Corrupt file fails open to nulls: this is cosmetic data, and jsonFile.js
    // has already quarantined the unparseable original.
    const raw = await readJson(file, { fallback: {}, validate: (v) => v && typeof v === 'object' });
    return normalize(raw);
  }

  return {
    read,
    async update(patch = {}) {
      const current = await read();
      const next = { ...current };
      for (const k of KEYS) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (v === null) { next[k] = null; continue; }
        if (typeof v !== 'string' || !SLUG_RE.test(v)) throw new Error(`invalid ${k}: ${String(v).slice(0, 40)}`);
        next[k] = v;
      }
      await writeJson(file, next);
      return next;
    },
  };
}
