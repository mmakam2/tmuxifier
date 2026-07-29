import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerified } from '../src/server/voiceDownload.js';

// B9 + S4 (2026-07-29 review). B9: nothing in the install pipeline carried a
// deadline, so a TCP stall mid-download hung the single-flight job as `running`
// forever — no cancel route exists, and the ship checklist gates restarts on
// exactly that state, so the stuck job argued against the only action that
// cleared it. S4: this module is the stream-hash-verify-rename chokepoint and
// had no direct test at all, so "digest verified before rename" was enforced
// only by unexecuted code.

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-dl-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const digestOf = (s) => createHash('sha256').update(s).digest('hex');

// A minimal fetch stand-in whose body is an async generator, matching what the
// production code iterates.
function fakeFetch(chunks, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    body: (async function* () { for (const c of chunks) yield Buffer.from(c); })(),
  });
}

test('a matching digest renames the verified file into place', async () => {
  const dest = path.join(dir, 'model.bin');
  const res = await downloadVerified({
    url: 'https://example.com/model.bin', dest, sha256: digestOf('hello world'),
    fetchImpl: fakeFetch(['hello ', 'world']),
  });
  expect(res).toEqual({ ok: true });
  expect(await fs.readFile(dest, 'utf8')).toBe('hello world');
  expect(fsSync.existsSync(`${dest}.part`)).toBe(false);
  expect(fsSync.statSync(dest).mode & 0o777).toBe(0o600);
});

test('a mismatched digest throws and leaves nothing at the real path', async () => {
  const dest = path.join(dir, 'model.bin');
  await expect(downloadVerified({
    url: 'https://example.com/model.bin', dest, sha256: digestOf('what was pinned'),
    fetchImpl: fakeFetch(['something else entirely']),
  })).rejects.toThrow(/integrity check failed/);

  // The load-bearing property: an unverified blob never occupies the real path,
  // and the temp file is cleaned up rather than left to be resumed.
  expect(fsSync.existsSync(dest)).toBe(false);
  expect(fsSync.existsSync(`${dest}.part`)).toBe(false);
});

test('a non-ok response never writes anything', async () => {
  const dest = path.join(dir, 'model.bin');
  await expect(downloadVerified({
    url: 'https://example.com/model.bin', dest, sha256: digestOf('x'),
    fetchImpl: fakeFetch([], { ok: false, status: 404 }),
  })).rejects.toThrow(/HTTP 404/);
  expect(fsSync.existsSync(dest)).toBe(false);
  expect(fsSync.existsSync(`${dest}.part`)).toBe(false);
});

test('a mid-stream error cleans up the temp file', async () => {
  const dest = path.join(dir, 'model.bin');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: (async function* () { yield Buffer.from('partial'); throw new Error('connection reset'); })(),
  });
  await expect(downloadVerified({ url: 'https://example.com/m', dest, sha256: digestOf('partial'), fetchImpl }))
    .rejects.toThrow(/connection reset/);
  expect(fsSync.existsSync(dest)).toBe(false);
  expect(fsSync.existsSync(`${dest}.part`)).toBe(false);
});

test('a stalled body aborts instead of hanging forever', async () => {
  const dest = path.join(dir, 'model.bin');
  let aborted = false;
  const fetchImpl = async (_url, { signal } = {}) => {
    signal?.addEventListener('abort', () => { aborted = true; });
    return {
      ok: true,
      status: 200,
      // One chunk, then never resolves — a TCP stall, not a closed connection.
      body: (async function* () { yield Buffer.from('start'); await new Promise(() => {}); })(),
    };
  };
  await expect(downloadVerified({
    url: 'https://example.com/m', dest, sha256: digestOf('start'), fetchImpl, stallMs: 30,
  })).rejects.toThrow(/stalled/);

  expect(aborted).toBe(true); // the connection is torn down, not left dangling
  expect(fsSync.existsSync(dest)).toBe(false);
  expect(fsSync.existsSync(`${dest}.part`)).toBe(false);
});

test('a slow but progressing download is not killed by the stall timeout', async () => {
  const dest = path.join(dir, 'model.bin');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // Each chunk arrives well within the stall window; the total exceeds it.
    body: (async function* () {
      for (const c of ['a', 'b', 'c', 'd', 'e', 'f']) {
        await new Promise((r) => setTimeout(r, 15));
        yield Buffer.from(c);
      }
    })(),
  });
  const res = await downloadVerified({
    url: 'https://example.com/m', dest, sha256: digestOf('abcdef'), fetchImpl, stallMs: 60,
  });
  expect(res).toEqual({ ok: true });
  expect(await fs.readFile(dest, 'utf8')).toBe('abcdef');
});

test('a hung connect phase aborts too', async () => {
  const dest = path.join(dir, 'model.bin');
  const fetchImpl = async () => new Promise(() => {}); // never resolves
  await expect(downloadVerified({
    url: 'https://example.com/m', dest, sha256: digestOf('x'), fetchImpl, stallMs: 30,
  })).rejects.toThrow(/stalled/);
});
