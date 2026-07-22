import { test, expect } from 'vitest';
import { setupStatusText, formatStatuslineResult } from '../src/web/setupStatus.ts';

test('statusline phase renders a configuring label', () => {
  expect(setupStatusText({ status: 'running', phase: 'statusline', error: null })).toBe('Configuring statusline…');
});

test('formatStatuslineResult: applied / skipped / failed / empty', () => {
  expect(formatStatuslineResult({ target: 'statusline', ok: true })).toBe('statusline ✓');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, skipped: 'no Claude on the box' })).toBe('statusline skipped (no Claude on the box)');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, error: 'statusline push failed' })).toBe('statusline failed (statusline push failed)');
  expect(formatStatuslineResult(null)).toBe('');
  expect(formatStatuslineResult(undefined)).toBe('');
});
