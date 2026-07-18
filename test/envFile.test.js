import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile, readEnvFile, upsertEnvFile } from '../src/server/envFile.js';

function tmpFile(name = '.env') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-env-'));
  return path.join(dir, name);
}

test('parseEnvFile reads KEY=value pairs', () => {
  const out = parseEnvFile('FOO=bar\nBAZ=qux');
  expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
});

test('parseEnvFile skips comments and blank lines', () => {
  const out = parseEnvFile('# a comment\n\nFOO=bar\n  # indented comment\nBAZ=1\n');
  expect(out).toEqual({ FOO: 'bar', BAZ: '1' });
});

test('parseEnvFile strips matching single or double quotes and the export prefix', () => {
  const out = parseEnvFile(`export FOO="bar baz"\nQUX='zed'\nRAW=  spaced  `);
  expect(out).toEqual({ FOO: 'bar baz', QUX: 'zed', RAW: 'spaced' });
});

test('parseEnvFile keeps = signs that appear inside the value', () => {
  const out = parseEnvFile('SECRET=a=b=c');
  expect(out).toEqual({ SECRET: 'a=b=c' });
});

test('readEnvFile returns {} when the file is missing', () => {
  expect(readEnvFile('/no/such/file/.env')).toEqual({});
});

test('readEnvFile parses an existing file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'FOO=bar\n');
  expect(readEnvFile(file)).toEqual({ FOO: 'bar' });
});

test('upsertEnvFile creates the file when absent', () => {
  const file = tmpFile();
  upsertEnvFile(file, { FOO: 'bar' });
  expect(readEnvFile(file)).toEqual({ FOO: 'bar' });
});

test('upsertEnvFile replaces an existing key in place and preserves others and comments', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '# header\nFOO=old\nKEEP=me\n');
  upsertEnvFile(file, { FOO: 'new' });
  const text = fs.readFileSync(file, 'utf8');
  expect(text).toContain('# header');
  expect(text).toContain('KEEP=me');
  expect(readEnvFile(file)).toEqual({ FOO: 'new', KEEP: 'me' });
});

test('upsertEnvFile appends keys that do not yet exist', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'FOO=bar\n');
  upsertEnvFile(file, { NEW: 'value' });
  expect(readEnvFile(file)).toEqual({ FOO: 'bar', NEW: 'value' });
});

test('upsertEnvFile writes a new file owner-only (0600) because it holds credentials', () => {
  const file = tmpFile();
  upsertEnvFile(file, { TMUXIFIER_COOKIE_SECRET: 'secret' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('upsertEnvFile tightens permissions on an already-existing loose file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'FOO=bar\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644); // make sure it is world-readable to start
  upsertEnvFile(file, { FOO: 'baz' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('an unquoted inline # comment is stripped from the value', () => {
  const parsed = parseEnvFile('TMUXIFIER_PORT=8080 # dashboard port\nX=plain#nothash\nY="quoted # kept"');
  expect(parsed.TMUXIFIER_PORT).toBe('8080');
  expect(parsed.X).toBe('plain#nothash'); // no space before # — part of the value
  expect(parsed.Y).toBe('quoted # kept'); // quoted values keep everything
});
