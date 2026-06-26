import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeSession, assertBoxSafe } from './sshCommand.js';

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
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return [];
    }
  }
  async function writeAll(boxes) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(boxes, null, 2));
  }
  function normalize(spec, base = {}) {
    if (!spec.host || typeof spec.host !== 'string') throw new Error('box requires a host');
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
      source: spec.source || base.source || 'manual',
      proxmox: spec.proxmox ?? base.proxmox,
      createdAt: base.createdAt || new Date().toISOString(),
    };
  }

  return {
    async listBoxes() {
      return readAll();
    },
    async getBox(id) {
      return (await readAll()).find((b) => b.id === id);
    },
    async addBox(spec) {
      const boxes = await readAll();
      const box = normalize(spec);
      assertBoxSafe(box);
      assertUniqueBox(boxes, box);
      boxes.push(box);
      await writeAll(boxes);
      return box;
    },
    async updateBox(id, patch) {
      const boxes = await readAll();
      const i = boxes.findIndex((b) => b.id === id);
      if (i === -1) throw new Error('box not found');
      boxes[i] = normalize({ ...boxes[i], ...patch, host: patch.host ?? boxes[i].host }, boxes[i]);
      // null means "clear this field" — ?? cannot express that, so handle explicitly
      for (const key of ['user', 'port', 'proxyJump']) {
        if (key in patch && patch[key] === null) boxes[i][key] = undefined;
      }
      assertBoxSafe(boxes[i]);
      assertUniqueBox(boxes, boxes[i], id);
      await writeAll(boxes);
      return boxes[i];
    },
    async removeBox(id) {
      const boxes = await readAll();
      await writeAll(boxes.filter((b) => b.id !== id));
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
      const added = [];
      let skipped = 0;
      for (const spec of incoming) {
        try {
          added.push(await this.addBox(spec));
        } catch {
          skipped += 1; // duplicate host/label or unsafe/invalid entry
        }
      }
      return { added, skipped };
    },
  };
}
