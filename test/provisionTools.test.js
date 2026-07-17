import { test, expect } from 'vitest';
import { TOOL_IDS } from '../src/server/boxActions.js';
import { PROVISION_TOOLS } from '../src/web/provisionTools.ts';

test('client tool list mirrors the server catalog, in order', () => {
  expect(PROVISION_TOOLS.map((t) => t.id)).toEqual(TOOL_IDS);
});

test('every tool has a human label', () => {
  for (const t of PROVISION_TOOLS) expect(t.label.trim().length).toBeGreaterThan(0);
});
