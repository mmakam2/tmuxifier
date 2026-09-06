import { test, expect } from 'vitest';
import { TOOL_IDS, NODE_MAJOR } from '../src/server/boxActions.js';
import { PROVISION_TOOLS } from '../src/web/provisionTools.ts';

test('client tool list mirrors the server catalog, in order', () => {
  expect(PROVISION_TOOLS.map((t) => t.id)).toEqual(TOOL_IDS);
});

test('every tool has a human label', () => {
  for (const t of PROVISION_TOOLS) expect(t.label.trim().length).toBeGreaterThan(0);
});

// The label names the major the server installs; the two are pinned together
// because the web bundle cannot import the server catalog.
test('the node label names the pinned NodeSource major', () => {
  const node = PROVISION_TOOLS.find((t) => t.id === 'node');
  expect(node.label).toContain(`Node.js ${NODE_MAJOR}`);
});
