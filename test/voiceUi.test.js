import { test, expect, afterEach } from 'vitest';
import { evaluateVoice, isVoiceHotkey, isVoiceHotkeyRelease, wireVoice, createVoiceController } from '../src/web/voiceUi';

// wireVoice calls the global fetch (via api.uiConfig) and, once voice turns
// out to be enabled, the global document (to mount a button), navigator/window
// (to evaluate readiness), and window (to install a blur listener). Stub all
// of them and restore after each test — same pattern as
// webApi.test.js/proxmoxWebClient use for fetch; this repo's vitest
// environment is plain 'node', so none of these globals exist unless a test
// supplies them.
const realFetch = globalThis.fetch;
const realDocument = globalThis.document;
const realNavigator = globalThis.navigator;
const realWindow = globalThis.window;
const realAudioWorkletNode = globalThis.AudioWorkletNode;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.document = realDocument;
  globalThis.navigator = realNavigator;
  globalThis.window = realWindow;
  globalThis.AudioWorkletNode = realAudioWorkletNode;
});

function fakeUiConfig(overrides = {}) {
  return { termFont: null, termFontSize: 12, uploadMaxBytes: 1, voice: false, voiceMaxSeconds: 120, ...overrides };
}

// Minimal stand-in for the DOM node createVoiceController.mount() touches —
// not a full jsdom, just enough surface (dataset/addEventListener/remove) for
// the property assignments in voiceUi.ts's setState()/mount() to succeed.
function stubDocument() {
  globalThis.document = { createElement: () => ({ dataset: {}, addEventListener() {}, remove() {} }) };
}

// A browser that supports capture (mediaDevices.getUserMedia + AudioWorkletNode)
// and is a secure context — the environment evaluateVoice needs to say ok:true
// once the server also reports voice enabled. window here also needs
// add/removeEventListener since wireVoice installs a blur listener whenever
// `window` is defined (used to stop an in-flight recording on alt-tab).
function stubSupportedSecureEnv() {
  globalThis.navigator = { mediaDevices: { getUserMedia: () => Promise.resolve() } };
  globalThis.AudioWorkletNode = function AudioWorkletNode() {};
  globalThis.window = { isSecureContext: true, addEventListener() {}, removeEventListener() {} };
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

test('isVoiceHotkey no longer matches keyup — release is isVoiceHotkeyRelease\'s job', () => {
  const ev = { type: 'keyup', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
               metaKey: false, altKey: false, repeat: false };
  expect(isVoiceHotkey(ev)).toBe(false);
});

// I2: releasing Ctrl before Space is roughly a coin flip on an ordinary chord
// release, and by the time that Space keyup fires its own ctrlKey already
// reads false. Requiring all three modifiers to still be held on release (the
// original bug) made stopping unreachable on a normal release order, leaving
// the mic live until the 120s auto-stop.
const keyup = (over) => ({ type: 'keyup', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
                            metaKey: false, altKey: false, ...over });

test('releasing Space first still stops the recording — the common case', () => {
  expect(isVoiceHotkeyRelease(keyup({}))).toBe(true);
});

test('releasing Ctrl before Space still stops the recording', () => {
  // Ctrl's own keyup naturally reports ctrlKey: false — it is not held down
  // by the very key event that reports its release.
  expect(isVoiceHotkeyRelease(keyup({ key: 'Control', code: 'ControlLeft', ctrlKey: false }))).toBe(true);
});

test('releasing Shift before Space still stops the recording', () => {
  expect(isVoiceHotkeyRelease(keyup({ key: 'Shift', code: 'ShiftLeft', shiftKey: false }))).toBe(true);
});

test('keydown still requires the full chord together, unaffected by the release predicate', () => {
  // isVoiceHotkey (start) is unchanged: dropping any one modifier still fails
  // it on keydown, exactly as before this fix.
  const down = (over) => ({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
                             metaKey: false, altKey: false, repeat: false, ...over });
  expect(isVoiceHotkey(down({}))).toBe(true);
  expect(isVoiceHotkey(down({ ctrlKey: false }))).toBe(false);
  expect(isVoiceHotkey(down({ shiftKey: false }))).toBe(false);
  // And isVoiceHotkeyRelease is a keyup-only predicate — it never matches keydown.
  expect(isVoiceHotkeyRelease(down({}))).toBe(false);
});

test('an unrelated key release is not part of the chord', () => {
  expect(isVoiceHotkeyRelease(keyup({ key: 'v', code: 'KeyV' }))).toBe(false);
});

// I1: a finish() that lands before start() resolves must not orphan a live
// mic. createVoiceController's makeRecorder param (defaulting to the real
// createVoiceRecorder) lets a fake recorder drive that race deterministically
// instead of racing real getUserMedia/permission-prompt timing.
test('finish() landing before start() resolves releases the mic once start() catches up, instead of orphaning it', async () => {
  let resolveStart;
  const rec = {
    cancelled: false,
    start: () => new Promise((r) => { resolveStart = r; }),
    stop: async () => new ArrayBuffer(44), // nothing was ever captured
    cancel() { this.cancelled = true; },
    recording: () => true,
  };
  const controller = createVoiceController('box1', 120, { write() {}, copy() {} }, () => rec);

  const beginPromise = controller.begin();
  // finish() runs while start() is still pending — the original bug's
  // trigger: a tap shorter than getUserMedia's permission-prompt/device-open
  // latency (a normal short click, or the very first use where the browser's
  // permission prompt is in the way).
  await controller.finish();
  expect(rec.cancelled).toBe(false); // nothing was live yet, so finish() called stop(), not cancel()

  // start() now resolves — in the real recorder this is the moment
  // getUserMedia's promise settles and the mic track goes LIVE — after
  // finish() already ran and nulled the outer `recorder` reference. Without
  // the fix, begin() would blindly setState('recording') here with nothing
  // left referencing `rec`, stranding the live mic until the 120s auto-stop
  // (whose own onAutoStop would find `recorder` pointing at something else,
  // or null, and be unable to stop it either).
  resolveStart();
  await beginPromise;
  expect(rec.cancelled).toBe(true); // released through the still-live local reference
});

test('a superseded recorder is released without disturbing a newer, still-active recording', async () => {
  let resolveStaleStart;
  const stale = {
    cancelled: false,
    start: () => new Promise((r) => { resolveStaleStart = r; }),
    stop: async () => new ArrayBuffer(44),
    cancel() { this.cancelled = true; },
    recording: () => true,
  };
  const fresh = {
    cancelled: false,
    start: async () => {},
    stop: async () => new ArrayBuffer(44),
    cancel() { this.cancelled = true; },
    recording: () => true,
  };
  let call = 0;
  const controller = createVoiceController('box1', 120, { write() {}, copy() {} }, () => (call++ === 0 ? stale : fresh));

  const staleBegin = controller.begin(); // recorder = stale, awaiting stale.start()
  await controller.finish();             // supersedes stale (recorder -> null); stale.start() still pending
  await controller.begin();              // recorder = fresh, resolves immediately
  expect(controller.recording()).toBe(true);

  resolveStaleStart(); // the stale recorder's start() finally catches up
  await staleBegin;
  expect(stale.cancelled).toBe(true);  // the stale one was released...
  expect(fresh.cancelled).toBe(false); // ...without touching the newer, active one
  expect(controller.recording()).toBe(true);
});

// I1: also short-circuit a zero-sample clip so a stray tap never cold-spawns
// the whisper engine (up to 120s) to transcribe a 44-byte empty WAV.
test('a zero-sample clip is short-circuited client-side and never reaches the server', async () => {
  const rec = {
    start: async () => {},
    stop: async () => new ArrayBuffer(44), // header-only WAV — no PCM samples
    cancel() {},
    recording: () => true,
  };
  const writes = [];
  const controller = createVoiceController('box1', 120, { write: (t) => writes.push(t), copy() {} }, () => rec);
  await controller.begin();
  await controller.finish();
  // Without the short-circuit this reaches api.postVoice() -> a real fetch()
  // of a relative URL in this Node test environment, which throws
  // immediately and would surface here as a "[voice failed: ...]" write.
  // Seeing no write at all is what proves the round trip never happened.
  expect(writes).toEqual([]);
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
  stubDocument();
  // A fully supported, secure environment: this test is about ready()
  // tracking mount/dispose, so the readiness verdict itself must come out ok
  // — see the dedicated M15 test below for the case where it doesn't.
  stubSupportedSecureEnv();
  const parent = { appendChild() {} };

  const voice = wireVoice(parent, 'box1', { write() {}, copy() {} });
  expect(voice.ready()).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(voice.ready()).toBe(true);

  voice.dispose();
  expect(voice.ready()).toBe(false);
});

// M15: on a plain-HTTP LAN deployment (the README's own documented setup),
// cfg.voice is true so a controller mounts — but evaluateVoice's verdict is
// ok: false (no secure context), and the button correctly renders disabled
// with the reason/hint. Before this fix, ready() returned true as soon as
// ANY controller mounted regardless of the verdict, so the hotkey handler in
// terminal.ts would call begin() anyway and hit a raw TypeError from
// navigator.mediaDevices being undefined, instead of falling through to
// xterm so the user sees the same reason the disabled button shows.
test('wireVoice().ready() stays false when a controller mounts but the readiness verdict says no', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => fakeUiConfig({ voice: true }) });
  stubDocument();
  // Capture support is present, but the context is not secure (plain HTTP,
  // non-localhost) — evaluateVoice fails on the secureContext check.
  globalThis.navigator = { mediaDevices: { getUserMedia: () => Promise.resolve() } };
  globalThis.AudioWorkletNode = function AudioWorkletNode() {};
  globalThis.window = { isSecureContext: false, addEventListener() {}, removeEventListener() {} };
  const parent = { appendChild() {} };

  const voice = wireVoice(parent, 'box1', { write() {}, copy() {} });
  await new Promise((r) => setTimeout(r, 0));
  // A controller DID mount (a disabled button exists to click) — but ready()
  // must still be false so terminal.ts's hotkey handler falls through to
  // xterm rather than calling begin() on an unusable controller.
  expect(voice.ready()).toBe(false);
  expect(() => { voice.begin(); voice.finish(); }).not.toThrow();
});
