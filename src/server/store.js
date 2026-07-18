import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeSession, assertBoxSafe } from './sshCommand.js';
import { readJson, writeJson } from './jsonFile.js';

// Bump when the on-disk export shape changes; importBoxes stays lenient about it.
const EXPORT_VERSION = 1;
const EXPORT_TYPE = 'tmuxifier-boxes';

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/\s+/g, ' ');
    if (tag) return [tag];
  }
  return [];
}

function canonicalUniqueValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function assertUniqueBox(boxes, candidate, ignoreId) {
  const host = canonicalUniqueValue(candidate.host);
  const label = canonicalUniqueValue(candidate.label);
  for (const box of boxes) {
    if (ignoreId && box.id === ignoreId) continue;
    if (host && canonicalUniqueValue(box.host) === host) throw new Error('box host already exists');
    if (label && canonicalUniqueValue(box.label) === label) throw new Error('box label already exists');
  }
}

export function createStore({ dataDir }) {
  const file = path.join(dataDir, 'boxes.json');

  async function readAll() {
    return readJson(file, { fallback: [], validate: Array.isArray });
  }
  async function writeAll(boxes) {
    await writeJson(file, boxes);
  }
  function normalize(spec, base = {}, { trustedProxmox = false } = {}) {
    if (!spec.host || typeof spec.host !== 'string') throw new Error('box requires a host');
    const link = trustedProxmox ? spec.proxmox : base.proxmox;
    return {
      id: base.id || randomUUID(),
      label: spec.label || base.label || spec.host,
      host: spec.host,
      user: spec.user ?? base.user,
      port: spec.port ?? base.port,
      proxyJump: spec.proxyJump ?? base.proxyJump,
      sessionName: sanitizeSession(spec.sessionName || base.sessionName || 'web'),
      startupCommand: spec.startupCommand ?? base.startupCommand,
      tags: normalizeTags(spec.tags),
      source: link ? 'proxmox' : 'manual',
      ...(link ? { proxmox: link } : {}),
      createdAt: base.createdAt || new Date().toISOString(),
    };
  }

  // Canonical identity of a Proxmox target (host+node+vmid) so the same
  // container can never be linked to two boxes at once.
  const linkKey = (link) => `${link.hostId}\u0000${link.node}\u0000${link.vmid}`;

  // Every mutation is a read-modify-write cycle over the whole file; without
  // serialization, two concurrent ones (a background provision addBox racing a
  // user PATCH) both read the same array and the second write silently drops
  // the first's change. Reads stay unserialized — the atomic rename underneath
  // makes a read during a write safe.
  let queue = Promise.resolve();
  function serialize(op) {
    const run = queue.then(op, op); // run regardless of the predecessor's fate
    queue = run.then(() => {}, () => {}); // the chain itself must never reject
    return run;
  }

  return {
    async listBoxes() {
      return readAll();
    },
    async getBox(id) {
      return (await readAll()).find((b) => b.id === id);
    },
    async addBox(spec, { trustedProxmox = false } = {}) {
      return serialize(async () => {
        const boxes = await readAll();
        const box = normalize(spec, {}, { trustedProxmox });
        assertBoxSafe(box);
        assertUniqueBox(boxes, box);
        boxes.push(box);
        await writeAll(boxes);
        return box;
      });
    },
    async updateBox(id, patch) {
      if ('source' in patch || 'proxmox' in patch) throw new Error('proxmox linkage must use the dedicated link route');
      return serialize(async () => {
        const boxes = await readAll();
        const index = boxes.findIndex((box) => box.id === id);
        if (index === -1) throw new Error('box not found');
        boxes[index] = normalize(
          { ...boxes[index], ...patch, host: patch.host ?? boxes[index].host },
          boxes[index],
        );
        // null means "clear this field" — ?? cannot express that, so handle explicitly
        for (const key of ['user', 'port', 'proxyJump']) {
          if (key in patch && patch[key] === null) boxes[index][key] = undefined;
        }
        // Clearing the label falls back to the host (the addBox default) — the
        // `spec.label || base.label` merge in normalize swallows ''/null.
        if ('label' in patch && (patch.label === null || patch.label === '')) boxes[index].label = boxes[index].host;
        assertBoxSafe(boxes[index]);
        assertUniqueBox(boxes, boxes[index], id);
        await writeAll(boxes);
        return boxes[index];
      });
    },
    async setProxmoxLink(id, link) {
      return serialize(async () => {
        const boxes = await readAll();
        const index = boxes.findIndex((box) => box.id === id);
        if (index === -1) throw new Error('box not found');
        const key = linkKey(link);
        if (boxes.some((box) => box.id !== id && box.proxmox && linkKey(box.proxmox) === key)) {
          throw new Error('proxmox container is already linked');
        }
        boxes[index] = normalize(
          { ...boxes[index], proxmox: link },
          boxes[index],
          { trustedProxmox: true },
        );
        assertBoxSafe(boxes[index]);
        await writeAll(boxes);
        return boxes[index];
      });
    },
    async clearProxmoxLink(id) {
      return serialize(async () => {
        const boxes = await readAll();
        const index = boxes.findIndex((box) => box.id === id);
        if (index === -1) throw new Error('box not found');
        const { proxmox: _link, ...base } = boxes[index];
        boxes[index] = { ...base, source: 'manual' };
        await writeAll(boxes);
        return boxes[index];
      });
    },
    async removeBox(id) {
      return serialize(async () => {
        const boxes = await readAll();
        await writeAll(boxes.filter((b) => b.id !== id));
      });
    },
    // Snapshot every box for download. The wrapper carries a type/version so
    // importBoxes can recognise its own files and reject unrelated JSON.
    async exportBoxes() {
      return {
        type: EXPORT_TYPE,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        boxes: await readAll(),
      };
    },
    // Restore boxes from a previously exported file. Accepts either the wrapped
    // payload or a bare array of boxes. Each box is re-added through addBox, so
    // it gets a fresh id/createdAt and is re-validated; duplicates (same
    // host/label) and unsafe/invalid entries are skipped, not fatal.
    async importBoxes(payload) {
      const incoming = Array.isArray(payload)
        ? payload
        : payload && Array.isArray(payload.boxes)
          ? payload.boxes
          : null;
      if (!incoming) throw new Error('invalid box export: expected a boxes array');
      // One read and one write for the whole batch — importing N boxes used to
      // do N full read/validate/rewrite cycles of boxes.json.
      return serialize(async () => {
        const boxes = await readAll();
        const added = [];
        let skipped = 0;
        for (const spec of incoming) {
          try {
            const { id: _id, createdAt: _createdAt, source: _source, proxmox: _proxmox, ...safeSpec } = spec || {};
            const box = normalize(safeSpec);
            assertBoxSafe(box);
            assertUniqueBox(boxes, box);
            boxes.push(box);
            added.push(box);
          } catch {
            skipped += 1; // duplicate host/label or unsafe/invalid entry
          }
        }
        if (added.length) await writeAll(boxes);
        return { added, skipped };
      });
    },
  };
}
