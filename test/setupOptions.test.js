import { test, expect } from 'vitest';
import { seedStatusLine, seedStatusParts } from '../src/web/setupOptions.ts';

test('ready CLI renders a ready row', () => {
  expect(seedStatusLine('claude', { ready: true })).toBe('claude: ● ready');
  expect(seedStatusLine('codex', { ready: true })).toBe('codex: ● ready');
});

test('unready claude names the exact host commands and env var', () => {
  const line = seedStatusLine('claude', { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' });
  expect(line).toContain('claude: ○ not set up');
  expect(line).toContain('claude setup-token');
  expect(line).toContain('TMUXIFIER_CLAUDE_OAUTH_TOKEN');
  expect(line).toContain('restart');
});

test('unready codex says to run codex login on the host', () => {
  const line = seedStatusLine('codex', { ready: false, reason: 'no codex auth on the Tmuxifier host' });
  expect(line).toContain('codex: ○ not set up');
  expect(line).toContain('codex login');
});

test('null status renders status unknown', () => {
  expect(seedStatusLine('claude', null)).toBe('claude: status unknown');
  expect(seedStatusLine('codex', null)).toBe('codex: status unknown');
});

test('parts tag the dot with a tone so it can be coloured, and still join to the line', () => {
  const ready = seedStatusParts('claude', { ready: true });
  expect(ready.tone).toBe('ok');
  expect(ready.dot).toBe('●');

  const unready = seedStatusParts('codex', { ready: false, reason: 'no codex auth on the Tmuxifier host' });
  expect(unready.tone).toBe('bad');
  expect(unready.dot).toBe('○');

  const unknown = seedStatusParts('claude', null);
  expect(unknown.tone).toBe('unknown');
  expect(unknown.dot).toBe('');

  // The parts are the line — no second source of truth for the wording.
  for (const [cli, s] of [['claude', { ready: true }], ['codex', { ready: false }], ['claude', null]]) {
    const p = seedStatusParts(cli, s);
    expect(p.before + p.dot + p.after).toBe(seedStatusLine(cli, s));
  }
});
