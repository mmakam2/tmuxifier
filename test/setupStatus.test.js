import { test, expect } from 'vitest';
import { setupStatusText, setupActions, setupBadge } from '../src/web/setupStatus.ts';

test('status text covers each state', () => {
  expect(setupStatusText({ status: 'running', phase: 'waiting-ssh' })).toMatch(/waiting/i);
  expect(setupStatusText({ status: 'running', phase: 'running' })).toMatch(/running/i);
  expect(setupStatusText({ status: 'done' })).toMatch(/complete|✓/i);
  expect(setupStatusText({ status: 'error', error: 'apt failed' })).toMatch(/apt failed/);
  expect(setupStatusText({ status: 'needs-interactive' })).toMatch(/sudo/i);
  expect(setupStatusText({ status: 'interrupted' })).toMatch(/interrupted/i);
});

test('actions per state', () => {
  expect(setupActions('running')).toEqual(['close']);
  expect(setupActions('done')).toEqual(['close']);
  expect(setupActions('error')).toEqual(['retry', 'remove', 'close']);
  expect(setupActions('needs-interactive')).toEqual(['finish-interactive', 'remove', 'close']);
  expect(setupActions('interrupted')).toEqual(['retry', 'remove', 'close']);
});

test('badge is null for terminal-done and present otherwise', () => {
  expect(setupBadge('done')).toBeNull();
  expect(setupBadge('running')).not.toBeNull();
  expect(setupBadge('needs-interactive')?.cls).toContain('warn');
});
