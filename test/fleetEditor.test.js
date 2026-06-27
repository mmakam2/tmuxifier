import { test, expect } from 'vitest';
import { buildCompletions, SHELL_BUILTINS } from '../src/web/fleetEditor.ts';

test('buildCompletions includes every shell builtin as a keyword completion', () => {
  const opts = buildCompletions([]);
  for (const b of SHELL_BUILTINS) {
    const hit = opts.find((o) => o.label === b);
    expect(hit, `missing builtin ${b}`).toBeTruthy();
  }
});

test('buildCompletions surfaces recent commands ahead of builtins, tagged "recent"', () => {
  const opts = buildCompletions(['docker ps -a', 'systemctl status nginx']);
  const recent = opts.filter((o) => o.detail === 'recent').map((o) => o.label);
  expect(recent).toEqual(['docker ps -a', 'systemctl status nginx']);
  // recent entries come before the builtin block so they rank first when matched
  const firstBuiltinIdx = opts.findIndex((o) => o.type === 'keyword');
  const lastRecentIdx = opts.map((o) => o.detail).lastIndexOf('recent');
  expect(lastRecentIdx).toBeLessThan(firstBuiltinIdx);
});

test('buildCompletions dedupes a recent command that is also a builtin', () => {
  const opts = buildCompletions(['echo', 'echo']);
  expect(opts.filter((o) => o.label === 'echo')).toHaveLength(1);
});

test('buildCompletions ignores blank/whitespace recent entries', () => {
  const opts = buildCompletions(['', '   ', 'true']);
  expect(opts.filter((o) => o.detail === 'recent').map((o) => o.label)).toEqual(['true']);
});
