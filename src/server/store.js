import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSshConfig } from './sshConfig.js';
import { sanitizeSession, assertBoxSafe } from './sshCommand.js';

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/\s+/g, ' ');
    if (tag) return [tag];
  }
  return [];
}

export function createStore({ dataDir, sshConfigPath }) {
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
      await writeAll(boxes);
      return boxes[i];
    },
    async removeBox(id) {
      const boxes = await readAll();
      await writeAll(boxes.filter((b) => b.id !== id));
    },
    async importFromSshConfig() {
      let text = '';
      try {
        text = await fs.readFile(sshConfigPath, 'utf8');
      } catch {
        return [];
      }
      const existing = new Set((await readAll()).map((b) => b.host));
      const added = [];
      for (const cand of parseSshConfig(text)) {
        if (existing.has(cand.host)) continue;
        try {
          added.push(await this.addBox(cand));
          existing.add(cand.host);
        } catch {
          // skip unsafe/invalid ssh-config entries
        }
      }
      return added;
    },
  };
}
