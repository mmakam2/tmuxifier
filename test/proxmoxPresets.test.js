import { test, expect } from 'vitest';
import { allowAutoStatic } from '../src/web/proxmoxPresets.ts';

test('auto-static is offered only when NetBox is configured or already selected', () => {
  expect(allowAutoStatic(true, 'dhcp')).toBe(true);
  expect(allowAutoStatic(true, 'auto-static')).toBe(true);
  expect(allowAutoStatic(false, 'dhcp')).toBe(false);
  expect(allowAutoStatic(false, 'static')).toBe(false);
  // Removing a selected option would silently rewrite the preset's saved mode.
  expect(allowAutoStatic(false, 'auto-static')).toBe(true);
});
