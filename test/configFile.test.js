import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, upsertConfigFile } from '../src/server/configFile.js';

test('readConfigFile returns {} when file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');
  expect(readConfigFile(file)).toEqual({});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfigFile parses existing JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 5555, localShell: 'omz' }));
  expect(readConfigFile(file)).toEqual({ port: 5555, localShell: 'omz' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertConfigFile creates file and merges keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');

  // Create
  upsertConfigFile(file, { localShell: 'omz' });
  expect(readConfigFile(file)).toEqual({ localShell: 'omz' });

  // Merge — preserves existing keys
  upsertConfigFile(file, { port: 5555 });
  expect(readConfigFile(file)).toEqual({ localShell: 'omz', port: 5555 });

  // Overwrite
  upsertConfigFile(file, { localShell: 'omb' });
  expect(readConfigFile(file)).toEqual({ localShell: 'omb', port: 5555 });

  fs.rmSync(dir, { recursive: true, force: true });
});
