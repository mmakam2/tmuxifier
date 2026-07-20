import { test, expect } from 'vitest';
import { voiceStatusLine, installPollDelay, micTestMessage } from '../src/web/settingsVoice';

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

// --- microphone permission test button --------------------------------------

const ok = { supported: true, secureContext: true };

test('reports success when getUserMedia resolves', () => {
  expect(micTestMessage(null, ok)).toMatch(/granted/i);
});

test('an unsupported browser is reported before anything else', () => {
  expect(micTestMessage(null, { supported: false, secureContext: false })).toMatch(/browser/i);
});

test('an insecure context explains HTTPS rather than blaming permission', () => {
  const m = micTestMessage({ name: 'NotAllowedError' }, { supported: true, secureContext: false });
  expect(m).toMatch(/https|secure/i);
  expect(m).not.toMatch(/denied/i);
});

test('a blocked permission names both plausible causes, including the reload', () => {
  // NotAllowedError covers BOTH a user denial and a page loaded before voice
  // was enabled (Permissions-Policy). We cannot tell them apart, so say so
  // rather than guessing and sending the user down the wrong path.
  const m = micTestMessage({ name: 'NotAllowedError' }, ok);
  expect(m).toMatch(/reload/i);
  expect(m).toMatch(/denied|blocked/i);
});

test('no capture device is distinguished from a permission problem', () => {
  const m = micTestMessage({ name: 'NotFoundError' }, ok);
  expect(m).toMatch(/no microphone|not found|no capture/i);
  expect(m).not.toMatch(/reload/i);
});

test('an unknown error still yields a usable message rather than undefined', () => {
  const m = micTestMessage({ name: 'WeirdError', message: 'something odd' }, ok);
  expect(typeof m).toBe('string');
  expect(m.length).toBeGreaterThan(0);
  expect(m).toMatch(/something odd|WeirdError/);
});
