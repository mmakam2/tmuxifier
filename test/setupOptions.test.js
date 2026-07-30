import { test, expect } from 'vitest';
import { seedStatusParts } from '../src/web/setupOptions.ts';

// These used to call a `seedStatusLine` export that production never used —
// it existed only so this file could assert on a whole string (D3 in the
// 2026-07-29 review). Composing the parts here instead keeps every wording
// assertion and drops the production export, so `seedStatusParts` is the one
// source of truth for this row rather than one of two.
//
// It also retires an assertion that could not fail: the old suite checked that
// `before + dot + after === seedStatusLine(...)`, which was that function's
// definition. Nothing is lost by removing a tautology.
const line = (cli, s) => {
  const { before, dot, after } = seedStatusParts(cli, s);
  return before + dot + after;
};

test('ready CLI renders a ready row', () => {
  expect(line('claude', { ready: true })).toBe('claude: ● ready');
  expect(line('codex', { ready: true })).toBe('codex: ● ready');
});

test('unready claude names the exact host commands and env var', () => {
  const l = line('claude', { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' });
  expect(l).toContain('claude: ○ not set up');
  expect(l).toContain('claude setup-token');
  expect(l).toContain('TMUXIFIER_CLAUDE_OAUTH_TOKEN');
  expect(l).toContain('restart');
});

test('unready codex says to run codex login on the host', () => {
  const l = line('codex', { ready: false, reason: 'no codex auth on the Tmuxifier host' });
  expect(l).toContain('codex: ○ not set up');
  expect(l).toContain('codex login');
});

test('null status renders status unknown', () => {
  expect(line('claude', null)).toBe('claude: status unknown');
  expect(line('codex', null)).toBe('codex: status unknown');
});

// The dot is split out of the text precisely so it alone can be coloured while
// the row stays muted, which is why the tone travels with it.
test('parts tag the dot with a tone so it can be coloured', () => {
  const ready = seedStatusParts('claude', { ready: true });
  expect(ready.tone).toBe('ok');
  expect(ready.dot).toBe('●');

  const unready = seedStatusParts('codex', { ready: false, reason: 'no codex auth on the Tmuxifier host' });
  expect(unready.tone).toBe('bad');
  expect(unready.dot).toBe('○');

  const unknown = seedStatusParts('claude', null);
  expect(unknown.tone).toBe('unknown');
  expect(unknown.dot).toBe('');
});
