import { test, expect } from 'vitest';
import { voiceStatusLine, installPollDelay } from '../src/web/settingsVoice';

test('describes an uninstalled server', () => {
  const s = voiceStatusLine({ installed: false, enabled: false, model: 'small.en', pinned: { bin: null, model: null } });
  expect(s).toMatch(/not installed/i);
});

test('describes an installed but disabled server', () => {
  const s = voiceStatusLine({ installed: true, enabled: false, model: 'small.en', pinned: { bin: 'vendor', model: 'store' } });
  expect(s).toMatch(/installed/i);
  expect(s).toMatch(/disabled|off/i);
});

test('describes a working server with its model', () => {
  const s = voiceStatusLine({ installed: true, enabled: true, model: 'small.en', pinned: { bin: 'vendor', model: 'store' } });
  expect(s).toMatch(/small\.en/);
});

test('says when the model is pinned by .env so the picker is explained, not silently inert', () => {
  const s = voiceStatusLine({ installed: true, enabled: true, model: 'small.en', pinned: { bin: 'vendor', model: 'env' } });
  expect(s).toMatch(/\.env/);
  expect(s).toMatch(/TMUXIFIER_WHISPER_MODEL/);
});

test('does not mention .env when nothing is pinned', () => {
  const s = voiceStatusLine({ installed: true, enabled: true, model: 'small.en', pinned: { bin: 'vendor', model: 'store' } });
  expect(s).not.toMatch(/\.env/);
});

test('polls fast while running and stops once settled', () => {
  expect(installPollDelay({ status: 'running' })).toBeGreaterThan(0);
  expect(installPollDelay({ status: 'running' })).toBeLessThanOrEqual(2000);
  expect(installPollDelay({ status: 'done' })).toBe(null);
  expect(installPollDelay({ status: 'error' })).toBe(null);
  expect(installPollDelay({ status: 'interrupted' })).toBe(null);
  // A dropped poll must keep trying rather than silently abandoning a live build.
  expect(installPollDelay(null)).toBeGreaterThan(0);
});
