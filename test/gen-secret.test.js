import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCookieSecret } from '../scripts/gen-secret.js';
import { readEnvFile } from '../src/server/envFile.js';

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-secret-'));
  return path.join(dir, '.env');
}

test('writes a cookie secret on a fresh .env', () => {
  const file = tmpEnv();
  const r = ensureCookieSecret(file, { makeSecret: () => 'SECRET1' });
  expect(r.wrote).toBe(true);
  expect(readEnvFile(file).TMUXIFIER_COOKIE_SECRET).toBe('SECRET1');
});

test('leaves an existing cookie secret untouched and preserves other keys', () => {
  const file = tmpEnv();
  fs.writeFileSync(file, 'TMUXIFIER_COOKIE_SECRET=KEEP\nTMUXIFIER_PORT=9000\n');
  const r = ensureCookieSecret(file, { makeSecret: () => 'NOPE' });
  expect(r.wrote).toBe(false);
  const env = readEnvFile(file);
  expect(env.TMUXIFIER_COOKIE_SECRET).toBe('KEEP');
  expect(env.TMUXIFIER_PORT).toBe('9000');
});
