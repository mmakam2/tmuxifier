import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UPLOAD_DIR_NAME,
  validUploadName,
  storedUploadName,
  buildUploadRemote,
  saveLocalUpload,
} from '../src/server/uploads.js';

test('validUploadName accepts plain filenames', () => {
  expect(validUploadName('screenshot.png')).toBe(true);
  expect(validUploadName('pasted-1760000000000.png')).toBe(true);
  expect(validUploadName('My File (1).txt'.replace(/[()]/g, '_'))).toBe(true);
  expect(validUploadName('a')).toBe(true);
});

test('validUploadName rejects traversal, options, hidden files, junk', () => {
  expect(validUploadName('')).toBe(false);
  expect(validUploadName(undefined)).toBe(false);
  expect(validUploadName('../etc/passwd')).toBe(false);
  expect(validUploadName('a/b.png')).toBe(false);
  expect(validUploadName('-rf')).toBe(false);
  expect(validUploadName('.env')).toBe(false);
  expect(validUploadName('..')).toBe(false);
  expect(validUploadName('a\nb')).toBe(false);
  expect(validUploadName(`x'; rm -rf /`)).toBe(false);
  expect(validUploadName('x'.repeat(200))).toBe(false);
});

test('storedUploadName uniquifies and preserves the original name', () => {
  const s = storedUploadName('shot.png', { now: 1760000000000, rand: () => 'abcd1234' });
  expect(s).toBe('1760000000000-abcd1234-shot.png');
  expect(validUploadName(s)).toBe(true);
  expect(() => storedUploadName('../x')).toThrow(/invalid/);
});

test('storedUploadName keeps long-but-valid names inside the 128-char budget', () => {
  const name = 'a'.repeat(120) + '.png'; // 124 chars, passes NAME_RE
  const s = storedUploadName(name, { now: 1760000000000, rand: () => 'abcd1234' });
  expect(validUploadName(s)).toBe(true);
  expect(s.length).toBeLessThanOrEqual(128);
  expect(s.endsWith('.png')).toBe(true); // extension preserved
  expect(s.startsWith('1760000000000-abcd1234-')).toBe(true);
});

test('a maximum-length valid name uploads end-to-end via saveLocalUpload', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uplong-'));
  const name = 'b'.repeat(124) + '.txt'; // 128 chars, the allowlist maximum
  const p = await saveLocalUpload(storedUploadName(name), Buffer.from('x'), { home });
  expect(await fs.readFile(p, 'utf8')).toBe('x');
  await fs.rm(home, { recursive: true, force: true });
});

test('buildUploadRemote writes stdin to the upload dir, prunes old files, prints the path', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uphome-'));
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  const oldFile = path.join(dir, 'stale.txt');
  await fs.writeFile(oldFile, 'old');
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const script = buildUploadRemote('1-aa-shot.png');
  const res = await new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }));
    child.stdin.end(Buffer.from('img-bytes'));
  });

  expect(res.code).toBe(0);
  const dest = path.join(dir, '1-aa-shot.png');
  expect(res.stdout.trim()).toBe(dest);
  expect(await fs.readFile(dest, 'utf8')).toBe('img-bytes');
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.rm(home, { recursive: true, force: true });
});

test('buildUploadRemote refuses an invalid stored name', () => {
  expect(() => buildUploadRemote("x'; rm -rf /")).toThrow(/invalid/);
});

test('saveLocalUpload writes 0600, prunes old files, returns the absolute path', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uplocal-'));
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  const oldFile = path.join(dir, 'stale.txt');
  await fs.writeFile(oldFile, 'old');
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const p = await saveLocalUpload('1-aa-shot.png', Buffer.from('local-bytes'), { home });
  expect(p).toBe(path.join(dir, '1-aa-shot.png'));
  expect(await fs.readFile(p, 'utf8')).toBe('local-bytes');
  expect(((await fs.stat(p)).mode & 0o777)).toBe(0o600);
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.rm(home, { recursive: true, force: true });
});

test('saveLocalUpload refuses an invalid stored name', async () => {
  await expect(saveLocalUpload('../x', Buffer.from('x'), { home: os.tmpdir() })).rejects.toThrow(/invalid/);
});
