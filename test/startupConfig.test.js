import { test, expect } from 'vitest';
import { reportConfig } from '../src/server/config.js';

test('OIDC warnings print before the fatal error is returned', () => {
  const lines = [];
  const err = reportConfig({ authMode: 'oidc', oidcProviders: [], oidcConfigWarnings: ['bad thing'], cookieSecret: '' }, (l) => lines.push(l));
  expect(err).toBeTruthy();
  expect(lines[0]).toBe('OIDC config: bad thing');
  expect(lines).toHaveLength(1);
});
