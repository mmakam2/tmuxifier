import { test, expect } from 'vitest';
import { setupStatusText, setupActions, setupBadge, formatSeedResults, formatStatuslineResult, blocksTerminal } from '../src/web/setupStatus.ts';

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

test('seed results render one segment per target', () => {
  expect(formatSeedResults([
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ])).toBe('claude ✓ · codex skipped (no codex auth on the Tmuxifier host)');
});

test('seed results render failures, including the whole-step marker', () => {
  expect(formatSeedResults([{ target: 'all', ok: false, error: 'seed failed' }])).toBe('all failed (seed failed)');
  expect(formatSeedResults([{ target: 'claude', ok: false }])).toBe('claude failed (failed)');
});

test('seed results are empty for jobs that never seeded', () => {
  expect(formatSeedResults([])).toBe('');
  expect(formatSeedResults(undefined)).toBe('');
  expect(formatSeedResults(null)).toBe('');
});

test('the seeding phase has its own status text', () => {
  expect(setupStatusText({ status: 'running', phase: 'seeding' })).toMatch(/seeding/i);
});

test('the statusline phase has its own status text', () => {
  expect(setupStatusText({ status: 'running', phase: 'statusline' })).toBe('Configuring statusline…');
});

test('statusline result renders applied / skipped / failed / empty', () => {
  expect(formatStatuslineResult({ target: 'statusline', ok: true })).toBe('statusline ✓');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, skipped: 'no Claude on the box' })).toBe('statusline skipped (no Claude on the box)');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, error: 'statusline push failed' })).toBe('statusline failed (statusline push failed)');
  expect(formatStatuslineResult(null)).toBe('');
  expect(formatStatuslineResult(undefined)).toBe('');
});

test('only a running setup job blocks the terminal', () => {
  expect(blocksTerminal('running')).toBe(true);
});

test('parked and finished jobs never block the terminal', () => {
  // needs-interactive can sit parked for days, and error/interrupted boxes are
  // exactly the ones you need a shell on to diagnose. Blocking any of these
  // would make a box unreachable rather than merely not-ready.
  expect(blocksTerminal('needs-interactive')).toBe(false);
  expect(blocksTerminal('done')).toBe(false);
  expect(blocksTerminal('error')).toBe(false);
  expect(blocksTerminal('interrupted')).toBe(false);
  expect(blocksTerminal('superseded')).toBe(false);
});

test('no job at all does not block', () => {
  expect(blocksTerminal(undefined)).toBe(false);
  expect(blocksTerminal(null)).toBe(false);
});
