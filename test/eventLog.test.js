import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'evlog-'));

test('append writes one NDJSON line per event into a day-partitioned file', async () => {
  const dir = await tmpDir();
  // 1784976000123 === 2026-07-25T10:40:00.123Z (Date.parse('2026-07-25T10:40:00.123Z')).
  // The brief's literal (1753440000123) is actually 2025-07-25, a mismatch with the
  // 2026 filename assertion below — corrected here rather than reproduced verbatim.
  const log = createEventLog({ dir, prefix: 'checks', now: () => 1784976000123 });
  const stored = await log.append({ key: 'check:a', severity: 'critical', title: 'down' });
  expect(stored.id).toBe('1784976000123-0');
  expect(stored.ts).toBe(1784976000123);
  const raw = await fs.readFile(path.join(dir, 'checks-2026-07-25.ndjson'), 'utf8');
  expect(raw.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(raw)).toMatchObject({ key: 'check:a', title: 'down' });
});

test('ids stay unique within a millisecond', async () => {
  const dir = await tmpDir();
  const log = createEventLog({ dir, prefix: 'checks', now: () => 5 });
  const a = await log.append({ key: 'k' });
  const b = await log.append({ key: 'k' });
  expect(a.id).not.toBe(b.id);
});

test('readSince returns events across day boundaries in time order', async () => {
  const dir = await tmpDir();
  let t = Date.parse('2026-07-24T23:59:00Z');
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  await log.append({ key: 'a' });
  t = Date.parse('2026-07-25T00:01:00Z');
  await log.append({ key: 'b' });
  const got = await log.readSince(Date.parse('2026-07-24T00:00:00Z'), Date.parse('2026-07-25T12:00:00Z'));
  expect(got.map((e) => e.key)).toEqual(['a', 'b']);
});

test('a corrupt line is skipped, not fatal — one bad line never costs a day of history', async () => {
  const dir = await tmpDir();
  const log = createEventLog({ dir, prefix: 'checks', now: () => Date.parse('2026-07-25T10:00:00Z') });
  await log.append({ key: 'good1' });
  await fs.appendFile(path.join(dir, 'checks-2026-07-25.ndjson'), '{not json\n');
  await log.append({ key: 'good2' });
  const got = await log.readDay('2026-07-25');
  expect(got.map((e) => e.key)).toEqual(['good1', 'good2']);
});

test('prune deletes day files older than the retention window and reports them', async () => {
  const dir = await tmpDir();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  await log.append({ key: 'old' });
  t = Date.parse('2026-07-25T00:00:00Z');
  await log.append({ key: 'new' });
  const removed = await log.prune(90);
  expect(removed).toEqual(['checks-2026-01-01.ndjson']);
  expect(await log.readDay('2026-01-01')).toEqual([]);
  expect(await log.readDay('2026-07-25')).toHaveLength(1);
});
