import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

// CRUD for Fleet Command's saved scripts (data/fleet-scripts.json), in the mold
// of servicesStore.js: normalize+validate inside the store, mutations serialized
// so two concurrent read-modify-write cycles can't drop each other's change.

// The body cap is deliberately the same limit POST /api/fleet/jobs enforces on
// `command`: a script that can be saved must always be runnable.
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 200;
export const MAX_SCRIPT = 65536;
export const MAX_SCRIPTS = 200;

export function createFleetScriptsStore({ dataDir }) {
  const file = path.join(dataDir, 'fleet-scripts.json');
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.scripts);

  async function readAll() {
    return (await readJson(file, { fallback: { version: 1, scripts: [] }, validate: valid })).scripts;
  }
  async function writeAll(scripts) {
    // 0o600 like every other data/ file. Nothing here is sealed — a script body
    // holds no credential class Tmuxifier manages — but the operator may well
    // have pasted one in, so the file stays owner-only.
    await writeJson(file, { version: 1, scripts }, { mode: 0o600 });
  }

  function normalize(spec, base = {}) {
    const name = String(spec.name ?? base.name ?? '').trim();
    if (!name) throw new Error('script name is required');
    if (name.length > MAX_NAME) throw new Error(`script name must be at most ${MAX_NAME} characters`);
    const script = String(spec.script ?? base.script ?? '');
    if (!script.trim()) throw new Error('script body is required');
    if (script.length > MAX_SCRIPT) throw new Error(`script body must be at most ${MAX_SCRIPT} characters`);
    // An omitted key keeps the stored value; an explicit '' clears it. Stating
    // both readings here is the point — a spread-merge that treats absent and
    // empty alike can never turn a field off.
    const description = String(spec.description ?? base.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) throw new Error(`description must be at most ${MAX_DESCRIPTION} characters`);
    const now = new Date().toISOString();
    const out = {
      id: base.id || `fs-${randomUUID()}`,
      name,
      script,
      createdAt: base.createdAt || now,
      updatedAt: now,
    };
    if (description) out.description = description;
    return out;
  }

  // Case-insensitive: two names differing only in case are the same script to
  // the operator reading the rail, and the rail is the only place they appear.
  function assertNameFree(scripts, name, exceptId) {
    const key = name.toLowerCase();
    if (scripts.some((s) => s.id !== exceptId && String(s.name).toLowerCase() === key)) {
      throw new Error(`a script named ${JSON.stringify(name)} already exists`);
    }
  }

  // Same serialization seam as store.js/servicesStore.js: mutations queue, reads
  // stay free.
  let queue = Promise.resolve();
  function serialize(op) {
    const run = queue.then(op, op);
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Newest-updated first, id as tie-break so two records written in the same
  // millisecond still have a total order (jobOrder.js's rule).
  const newestFirst = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.id).localeCompare(String(b.id));

  return {
    async listScripts() {
      return [...(await readAll())].sort(newestFirst);
    },
    // Single-record read for the setup manager's post-setup script phase, which
    // resolves by id at run time rather than snapshotting the body. Not
    // serialized: reads stay free here, the same rule listScripts follows. A
    // missing or malformed id is `null`, never a throw — the caller turns that
    // into a recorded skip, not a failure.
    async getScript(id) {
      if (typeof id !== 'string' || !id) return null;
      return (await readAll()).find((s) => s.id === id) || null;
    },
    async addScript(spec) {
      return serialize(async () => {
        const scripts = await readAll();
        if (scripts.length >= MAX_SCRIPTS) throw new Error(`at most ${MAX_SCRIPTS} saved scripts`);
        const rec = normalize(spec || {});
        assertNameFree(scripts, rec.name, rec.id);
        scripts.push(rec);
        await writeAll(scripts);
        return rec;
      });
    },
    async updateScript(id, patch) {
      return serialize(async () => {
        const scripts = await readAll();
        const index = scripts.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('script not found');
        const rec = normalize(patch || {}, scripts[index]);
        assertNameFree(scripts, rec.name, id);
        scripts[index] = rec;
        await writeAll(scripts);
        return rec;
      });
    },
    async removeScript(id) {
      return serialize(async () => {
        const scripts = await readAll();
        await writeAll(scripts.filter((s) => s.id !== id));
      });
    },
  };
}
