import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCredentials } from '../scripts/hash-password.js';
import { readEnvFile } from '../src/server/envFile.js';

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cred-'));
  return path.join(dir, '.env');
}

test('writeCredentials writes the hash and generates a cookie secret on a fresh .env', () => {
  const file = tmpEnv();
  const result = writeCredentials(file, 'HASH1', { makeSecret: () => 'SECRET1' });
  expect(result.wroteSecret).toBe(true);
  expect(readEnvFile(file)).toEqual({
    TMUXIFIER_PASSWORD_HASH: 'HASH1',
    TMUXIFIER_COOKIE_SECRET: 'SECRET1',
  });
});

test('writeCredentials updates the hash but keeps an existing cookie secret', () => {
  const file = tmpEnv();
  fs.writeFileSync(file, 'TMUXIFIER_COOKIE_SECRET=ORIGINAL\nTMUXIFIER_PASSWORD_HASH=OLD\n');
  const result = writeCredentials(file, 'NEWHASH', { makeSecret: () => 'SHOULD_NOT_BE_USED' });
  expect(result.wroteSecret).toBe(false);
  const env = readEnvFile(file);
  expect(env.TMUXIFIER_PASSWORD_HASH).toBe('NEWHASH');
  expect(env.TMUXIFIER_COOKIE_SECRET).toBe('ORIGINAL');
});

test('writeCredentials preserves unrelated keys', () => {
  const file = tmpEnv();
  fs.writeFileSync(file, 'TMUXIFIER_PORT=9000\n');
  writeCredentials(file, 'HASH', { makeSecret: () => 'S' });
  expect(readEnvFile(file).TMUXIFIER_PORT).toBe('9000');
});

test('passing the password via argv still works but warns about shell history/ps exposure', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-hp-cli-'));
  const script = path.resolve('scripts/hash-password.js');
  const r = spawnSync(process.execPath, [script, 'hunter2'], { cwd: dir, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(readEnvFile(path.join(dir, '.env')).TMUXIFIER_PASSWORD_HASH).toMatch(/^scrypt\$/);
  expect(r.stderr).toMatch(/shell history|argument/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
