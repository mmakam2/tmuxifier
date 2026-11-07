import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentSeenStore } from '../src/server/agentSeenStore.js';

test('agent-seen store round-trips an object map, starts empty, and is written 0o600', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  const s = createAgentSeenStore({ dataDir });
  expect(s.load()).toEqual({});
  s.save({ b1: { web: 1718000000 } });
  await s.whenIdle();
  expect(createAgentSeenStore({ dataDir }).load()).toEqual({ b1: { web: 1718000000 } });
  expect((await fs.stat(path.join(dataDir, 'agent-seen.json'))).mode & 0o777).toBe(0o600);
});

test('a non-object file is quarantined and reads as empty', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  await fs.writeFile(path.join(dataDir, 'agent-seen.json'), '[1,2]');
  expect(createAgentSeenStore({ dataDir }).load()).toEqual({});
  const names = await fs.readdir(dataDir);
  expect(names.some((n) => n.startsWith('agent-seen.json.corrupt-'))).toBe(true);
});
