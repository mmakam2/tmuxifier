import { test, expect, afterEach } from 'vitest';
import { evaluateVoice, isVoiceHotkey, wireVoice } from '../src/web/voiceUi';

// wireVoice calls the global fetch (via api.uiConfig) and, once voice turns
// out to be enabled, the global document (to mount a button). Stub both and
// restore after each test — same pattern as webApi.test.js/proxmoxWebClient
// use for fetch; this repo's vitest environment is plain 'node', so there is
// no real `document` unless a test supplies one.
const realFetch = globalThis.fetch;
const realDocument = globalThis.document;
afterEach(() => { globalThis.fetch = realFetch; globalThis.document = realDocument; });

function fakeUiConfig(overrides = {}) {
  return { termFont: null, termFontSize: 12, uploadMaxBytes: 1, voice: false, voiceMaxSeconds: 120, ...overrides };
}

const ready = { supported: true, secureContext: true, enabled: true };

test('reports ready when support, secure context, and server enablement all hold', () => {
  expect(evaluateVoice(ready)).toEqual({ ok: true, reason: '', hint: '' });
});

test('browser support is checked before anything else', () => {
  // Ordered like passkeys.ts evaluateOrigin: the most fundamental blocker wins,
  // so the user is never told to fix TLS on a browser that could not work anyway.
  const v = evaluateVoice({ supported: false, secureContext: false, enabled: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/browser/i);
});

test('an insecure context explains the HTTPS requirement', () => {
  const v = evaluateVoice({ ...ready, secureContext: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/https|secure/i);
  expect(v.hint).toMatch(/DEPLOY/);
});

test('a server with voice off says so rather than blaming the browser', () => {
  const v = evaluateVoice({ ...ready, enabled: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/not enabled|setup-voice/i);
});

test('Ctrl+Shift+Space is the hotkey and Ctrl+Shift+V is left to paste', () => {
  const ev = (over) =>
    ({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
       metaKey: false, altKey: false, repeat: false, ...over });
  expect(isVoiceHotkey(ev({}))).toBe(true);
  expect(isVoiceHotkey(ev({ key: 'v', code: 'KeyV' }))).toBe(false); // clipboard paste
  expect(isVoiceHotkey(ev({ shiftKey: false }))).toBe(false);
  expect(isVoiceHotkey(ev({ ctrlKey: false }))).toBe(false);
  expect(isVoiceHotkey(ev({ metaKey: true }))).toBe(false);
});

test('auto-repeat while the key is held is not a second press', () => {
  const ev = { type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
               metaKey: false, altKey: false, repeat: true };
  expect(isVoiceHotkey(ev)).toBe(false);
});

// Readiness gating for terminal.ts's hotkey handler (finding: the hotkey must
// not be swallowed — must not `return false` — when there is nothing mounted
// to hand it to). wireVoice's ready() is the signal terminal.ts consults.
test('wireVoice().ready() is false until the /api/ui-config fetch settles', async () => {
  let resolveFetch;
  globalThis.fetch = () => new Promise((r) => { resolveFetch = r; });
  const parent = { appendChild() {} };
  const host = { write() {}, copy() {} };

  const voice = wireVoice(parent, 'box1', host);
  // Synchronously — before the readiness fetch has any chance to settle —
  // nothing is mounted, so the hotkey must fall through to xterm rather than
  // being swallowed with no controller to act on it.
  expect(voice.ready()).toBe(false);
  expect(() => { voice.begin(); voice.finish(); }).not.toThrow();

  resolveFetch({ ok: true, status: 200, statusText: 'OK', json: async () => fakeUiConfig({ voice: false }) });
  await new Promise((r) => setTimeout(r, 0));
  // Server-disabled voice: still nothing mounted, ready() stays false forever.
  expect(voice.ready()).toBe(false);
});

test('wireVoice().ready() also stays false when the readiness fetch fails outright', async () => {
  globalThis.fetch = () => Promise.reject(new Error('network error'));
  const voice = wireVoice({ appendChild() {} }, 'box1', { write() {}, copy() {} });
  await new Promise((r) => setTimeout(r, 0));
  expect(voice.ready()).toBe(false);
});

test('wireVoice().ready() becomes true once voice is enabled and mounts, and false again after dispose', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => fakeUiConfig({ voice: true, voiceMaxSeconds: 60 }) });
  // Minimal stand-in for the DOM node createVoiceController.mount() touches —
  // not a full jsdom, just enough surface (dataset/addEventListener) for the
  // property assignments in voiceUi.ts's setState()/mount() to succeed. This
  // repo runs vitest with environment 'node', so there is no real `document`.
  globalThis.document = { createElement: () => ({ dataset: {}, addEventListener() {}, remove() {} }) };
  const parent = { appendChild() {} };

  const voice = wireVoice(parent, 'box1', { write() {}, copy() {} });
  expect(voice.ready()).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(voice.ready()).toBe(true);

  voice.dispose();
  expect(voice.ready()).toBe(false);
});
