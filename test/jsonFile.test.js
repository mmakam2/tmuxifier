import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, readJsonSync, writeJson, writeJsonSync } from '../src/server/jsonFile.js';

let dir, file;
const silent = () => {};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-jsonfile-'));
  file = path.join(dir, 'thing.json');
});

async function names() {
  return (await fs.readdir(dir)).sort();
}

test('missing file reads as the fallback (async and sync)', async () => {
  expect(await readJson(file, { fallback: [] })).toEqual([]);
  expect(readJsonSync(file, { fallback: { a: 1 } })).toEqual({ a: 1 });
});

test('write then read round-trips, creates the parent dir, and leaves no temp file', async () => {
  const nested = path.join(dir, 'data', 'thing.json');
  await writeJson(nested, [{ id: 1 }]);
  expect(await readJson(nested, { fallback: [] })).toEqual([{ id: 1 }]);
  const inDataDir = await fs.readdir(path.dirname(nested));
  expect(inDataDir).toEqual(['thing.json']); // no .tmp leftovers
});

test('written files are owner-only (0600)', async () => {
  await writeJson(file, { secret: true });
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  writeJsonSync(path.join(dir, 'sync.json'), { secret: true });
  expect((await fs.stat(path.join(dir, 'sync.json'))).mode & 0o777).toBe(0o600);
});

test('a corrupt file is moved aside, not treated as empty — the bytes survive', async () => {
  await fs.writeFile(file, '{"boxes": [truncated');
  expect(await readJson(file, { fallback: [], onCorrupt: silent })).toEqual([]);
  const quarantined = (await names()).filter((n) => n.startsWith('thing.json.corrupt-'));
  expect(quarantined).toHaveLength(1);
  expect(await fs.readFile(path.join(dir, quarantined[0]), 'utf8')).toBe('{"boxes": [truncated');
  // The live path is now free: a subsequent write cannot destroy the original.
  await writeJson(file, ['fresh']);
  expect(await fs.readFile(path.join(dir, quarantined[0]), 'utf8')).toBe('{"boxes": [truncated');
});

test('a file that fails the shape check is quarantined like corrupt JSON', () => {
  const f = path.join(dir, 'list.json');
  writeJsonSync(f, { not: 'an array' }); // valid JSON, wrong shape for an array store
  const v = readJsonSync(f, { fallback: [], validate: Array.isArray, onCorrupt: silent });
  expect(v).toEqual([]);
});

test('sync corrupt read quarantines too', async () => {
  await fs.writeFile(file, 'not json at all');
  expect(readJsonSync(file, { fallback: [], onCorrupt: silent })).toEqual([]);
  const quarantined = (await names()).filter((n) => n.startsWith('thing.json.corrupt-'));
  expect(quarantined).toHaveLength(1);
});

test('non-ENOENT read errors are rethrown, not masked as empty', async () => {
  // A directory at the file's path is a stand-in for any unreadable-file error
  // (EISDIR/EACCES): returning the fallback would invite a destructive rewrite.
  await fs.mkdir(file);
  await expect(readJson(file, { fallback: [], onCorrupt: silent })).rejects.toThrow();
  expect(() => readJsonSync(file, { fallback: [], onCorrupt: silent })).toThrow();
});
