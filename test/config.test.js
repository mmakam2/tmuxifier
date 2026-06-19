import { test, expect } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';

test('applies defaults', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.bindAddress).toBe('127.0.0.1');
  expect(c.port).toBe(7437);
  expect(c.graceSeconds).toBe(45);
  expect(c.hostKeyPolicy).toBe('accept-new');
  expect(c.dataDir).toBe(path.join('/app', 'data'));
});

test('env overrides defaults; overrides arg wins over env', () => {
  const env = { HELM_PORT: '9000', HELM_HOSTKEY_POLICY: 'yes' };
  const c = loadConfig({ port: 1234 }, { env, cwd: '/app' });
  expect(c.port).toBe(1234);          // explicit override wins
  expect(c.hostKeyPolicy).toBe('yes'); // from env
});
