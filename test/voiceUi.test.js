import { test, expect, afterEach } from 'vitest';
import { evaluateVoice, isVoiceHotkey, createVoiceHotkeyHandler, wireVoice, createVoiceController, idleTitle } from '../src/web/voiceUi';

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
// not a full jsdom, just enough surface (dataset/addEventListener/remove/
// setAttribute, the latter for the aria-label mirror) for the property
// assignments in voiceUi.ts's paint()/mount() to succeed.
function stubDocument() {
  const made = [];
  globalThis.document = {
    createElement: () => {
      const el = { dataset: {}, attrs: {}, addEventListener() {}, remove() {}, setAttribute(k, v) { this.attrs[k] = v; } };
      made.push(el);
      return el;
    },
  };
  return made;   // the elements mount() created, for tests that inspect the button
}

// One macrotask: drains every microtask the controller's promise chains queue.
const flush = () => new Promise((r) => setTimeout(r, 0));

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

test('isVoiceHotkey does not match keyup — only a keydown can toggle', () => {
  const ev = { type: 'keyup', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
               metaKey: false, altKey: false, repeat: false };
  expect(isVoiceHotkey(ev)).toBe(false);
});

test('keydown still requires the full chord together', () => {
  // Dropping any one modifier still fails it, exactly as before the toggle change.
  const down = (over) => ({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
                             metaKey: false, altKey: false, repeat: false, ...over });
  expect(isVoiceHotkey(down({}))).toBe(true);
  expect(isVoiceHotkey(down({ ctrlKey: false }))).toBe(false);
  expect(isVoiceHotkey(down({ shiftKey: false }))).toBe(false);
});

// createVoiceHotkeyHandler owns the actual toggle decision (which isVoiceHotkey
// alone can't express, since it matches every fresh chord press identically
// regardless of whether one is already in flight) plus the swallow-the-whole-
// chord state machine. `voice` here is the minimal shape terminal.ts hands it
// — no real controller/recorder needed since the handler only ever calls
// voice.recording()/begin()/finish(), never touches a mic itself.
function fakeVoiceTarget(readyValue = true) {
  let recording = false;
  const calls = [];
  return {
    ready: () => readyValue,
    recording: () => recording,
    begin: () => { calls.push('begin'); recording = true; },
    finish: () => { calls.push('finish'); recording = false; },
    calls,
  };
}

const down = (over) => ({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
                           metaKey: false, altKey: false, repeat: false, ...over });
const up = (over) => ({ type: 'keyup', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
                         metaKey: false, altKey: false, ...over });

test('a first non-repeat keydown starts a recording', () => {
  const voice = fakeVoiceTarget();
  const handle = createVoiceHotkeyHandler(voice);
  expect(handle(down({}))).toBe(true); // consumed
  expect(voice.calls).toEqual(['begin']);
  expect(voice.recording()).toBe(true);
});

test('a second press (after the chord is fully released) stops the recording', () => {
  const voice = fakeVoiceTarget();
  const handle = createVoiceHotkeyHandler(voice);
  handle(down({}));                    // starts
  expect(handle(up({}))).toBe(true);   // Space released — ends this physical press, still consumed
  expect(handle(down({}))).toBe(true); // second tap
  expect(voice.calls).toEqual(['begin', 'finish']);
  expect(voice.recording()).toBe(false);
});

test('ev.repeat keydowns while the chord is held do not toggle — they are swallowed instead', () => {
  const voice = fakeVoiceTarget();
  const handle = createVoiceHotkeyHandler(voice);
  handle(down({}));
  expect(handle(down({ repeat: true }))).toBe(true); // consumed, not a second toggle
  expect(handle(down({ repeat: true }))).toBe(true);
  expect(voice.calls).toEqual(['begin']); // only the original press acted
});

test('a keyup of Control or Shift mid-chord is swallowed too, without ending the press', () => {
  const voice = fakeVoiceTarget();
  const handle = createVoiceHotkeyHandler(voice);
  handle(down({}));
  // Releasing a modifier before Space (the common real-world release order)
  // must still be consumed, and must not itself be mistaken for the chord's
  // end — repeats of Space could still be arriving.
  expect(handle(up({ key: 'Control', code: 'ControlLeft', ctrlKey: false }))).toBe(true);
  expect(handle(down({ repeat: true }))).toBe(true); // Space is still physically held
  expect(voice.calls).toEqual(['begin']);
  expect(handle(up({}))).toBe(true); // Space finally comes up — press ends
  expect(handle(down({}))).toBe(true); // a genuinely new press toggles again
  expect(voice.calls).toEqual(['begin', 'finish']);
});

test('an unrelated key event is not part of the chord and falls through', () => {
  const voice = fakeVoiceTarget();
  const handle = createVoiceHotkeyHandler(voice);
  expect(handle(down({ key: 'v', code: 'KeyV' }))).toBe(false);
  expect(handle(up({ key: 'v', code: 'KeyV' }))).toBe(false);
  expect(voice.calls).toEqual([]);
});

test('the chord falls through untouched when voice is not ready', () => {
  const voice = fakeVoiceTarget(false);
  const handle = createVoiceHotkeyHandler(voice);
  expect(handle(down({}))).toBe(false);
  expect(voice.calls).toEqual([]);
});

// I1: a release that lands before start() resolves must not orphan a live
// mic. createVoiceController's makeRecorder param (defaulting to the real
// createVoiceRecorder) lets a fake recorder drive that race deterministically
// instead of racing real getUserMedia/permission-prompt timing. `probe` is
// injected for the same reason: a press now probes the pane before it can
// know it is a dictation, and a non-claude verdict is what hands the recorder
// to the transcription round trip.
test('a release landing before start() resolves releases the mic once start() catches up, instead of orphaning it', async () => {
  let resolveStart;
  const rec = {
    cancelled: false,
    start: () => new Promise((r) => { resolveStart = r; }),
    stop: async () => new ArrayBuffer(44), // nothing was ever captured
    cancel() { this.cancelled = true; },
    recording: () => true,
  };
  const controller = createVoiceController('box1', 120, { write() {}, copy() {}, focus() {} }, () => rec,
    { probe: async () => 'shell' });

  controller.begin();
  // The pointer comes back up while start() is still pending — the original
  // bug's trigger: a tap shorter than getUserMedia's permission-prompt/
  // device-open latency (a normal short click, or the very first use where
  // the browser's permission prompt is in the way).
  controller.release();
  await flush(); await flush();
  expect(rec.cancelled).toBe(false); // nothing was live yet, so the dictation called stop(), not cancel()

  // start() now resolves — in the real recorder this is the moment
  // getUserMedia's promise settles and the mic track goes LIVE — after the
  // dictation already ran and nulled the outer `recorder` reference. Without
  // the fix, begin() would blindly paint 'recording' here with nothing left
  // referencing `rec`, stranding the live mic until the 120s auto-stop
  // (whose own onAutoStop would find `recorder` pointing at something else,
  // or null, and be unable to stop it either).
  resolveStart();
  await flush();
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
  const controller = createVoiceController('box1', 120, { write() {}, copy() {}, focus() {} },
    () => (call++ === 0 ? stale : fresh), { probe: async () => 'shell' });

  controller.begin();          // recorder = stale, awaiting stale.start()
  controller.release();        // the verdict then supersedes stale (recorder -> null); stale.start() still pending
  await flush(); await flush();
  controller.begin();          // recorder = fresh, resolves immediately
  await flush(); await flush();
  expect(controller.recording()).toBe(true);

  resolveStaleStart(); // the stale recorder's start() finally catches up
  await flush();
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
  const controller = createVoiceController('box1', 120, { write: (t) => writes.push(t), copy() {}, focus() {} }, () => rec,
    { probe: async () => 'shell' });
  controller.begin();
  controller.release();
  await flush(); await flush();
  // Without the short-circuit this reaches api.postVoice() -> a real fetch()
  // of a relative URL in this Node test environment, which throws
  // immediately and would surface here as a "[voice failed: ...]" write.
  // Seeing no write at all is what proves the round trip never happened.
  expect(writes).toEqual([]);
});

// Readiness gating for terminal.ts's hotkey handler (finding: the hotkey must
// not be swallowed — must not `return false` — when there is nothing mounted
// to hand it to). wireVoice's ready() is the signal terminal.ts consults.
test('wireVoice().ready() is false until the /api/ui-config fetch settles, and the mic mounts even with whisper off', async () => {
  let resolveFetch;
  globalThis.fetch = () => new Promise((r) => { resolveFetch = r; });
  const made = stubDocument();
  stubSupportedSecureEnv();
  const parent = { appendChild() {} };
  const host = { write() {}, copy() {}, focus() {} };

  const voice = wireVoice(parent, 'box1', host);
  // Synchronously — before the readiness fetch has any chance to settle —
  // nothing is mounted, so the hotkey must fall through to xterm rather than
  // being swallowed with no controller to act on it.
  expect(voice.ready()).toBe(false);
  expect(() => { voice.begin(); voice.finish(); }).not.toThrow();
  expect(made).toHaveLength(0);

  resolveFetch({ ok: true, status: 200, statusText: 'OK', json: async () => fakeUiConfig({ voice: false }) });
  await flush();
  // Server-disabled voice used to mean no button at all. It is the LINK
  // button too now — a Claude pane links with no whisper on this host — so it
  // mounts, enabled (only the readiness verdict disables it), and says in its
  // idle tooltip that dictation is the half that is missing.
  expect(made).toHaveLength(1);
  expect(made[0].disabled).toBeFalsy();
  expect(made[0].title).toMatch(/not enabled/i);
  expect(voice.ready()).toBe(true);
});

test('wireVoice().ready() also stays false when the readiness fetch fails outright', async () => {
  globalThis.fetch = () => Promise.reject(new Error('network error'));
  const voice = wireVoice({ appendChild() {} }, 'box1', { write() {}, copy() {}, focus() {} });
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

  const voice = wireVoice(parent, 'box1', { write() {}, copy() {}, focus() {} });
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

  const voice = wireVoice(parent, 'box1', { write() {}, copy() {}, focus() {} });
  await new Promise((r) => setTimeout(r, 0));
  // A controller DID mount (a disabled button exists to click) — but ready()
  // must still be false so terminal.ts's hotkey handler falls through to
  // xterm rather than calling begin() on an unusable controller.
  expect(voice.ready()).toBe(false);
  expect(() => { voice.begin(); voice.finish(); }).not.toThrow();
});

// The button takes DOM focus when clicked, so without an explicit handback the
// transcript lands in the pane but Enter goes to the button rather than the
// PTY — the user has to click the pane before they can submit what they just
// dictated. mount()'s mousedown preventDefault() stops focus moving at all;
// this pins the belt-and-braces handback for the paths that cannot cover
// (focus already elsewhere, or the hotkey used while another element had it).
test('a completed dictation hands keyboard focus back to the terminal', async () => {
  const rec = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(new ArrayBuffer(44)), // header-only: short-circuits before any fetch
    cancel() {},
    recording: () => true,
  };
  let focused = 0;
  const controller = createVoiceController(
    'box1', 120, { write() {}, copy() {}, focus() { focused += 1; } }, () => rec,
    { probe: async () => 'shell' },
  );
  controller.begin();
  controller.release();
  await flush(); await flush();
  expect(focused).toBe(1);
});

test('focus is handed back even when the transcription round trip throws', async () => {
  const rec = {
    start: () => Promise.resolve(),
    stop: () => Promise.reject(new Error('recorder blew up')),
    cancel() {},
    recording: () => true,
  };
  let focused = 0;
  const writes = [];
  const controller = createVoiceController(
    'box1', 120, { write: (t) => writes.push(t), copy() {}, focus() { focused += 1; } }, () => rec,
    { probe: async () => 'shell' },
  );
  controller.begin();
  controller.release();
  await flush(); await flush();
  // The failure is reported to the pane AND focus still returns, so a failed
  // dictation cannot strand the keyboard on the button.
  expect(writes.join('')).toContain('voice failed');
  expect(focused).toBe(1);
});

test('a present sink reroutes the transcript into it with inject=off and leaves focus alone', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi there', injected: false, mode: 'off' }) };
  };
  const rec = {
    start: async () => {},
    stop: async () => new ArrayBuffer(45), // one byte past the 44-byte WAV header — reaches the server call
    cancel() {},
    recording: () => true,
  };
  const sunk = [];
  const controller = createVoiceController('box1', 120, {
    write() {},
    copy() { throw new Error('the sink path must not fall back to the clipboard'); },
    focus() { throw new Error('the sink path must leave focus on the composer field'); },
    sink: () => (t) => sunk.push(t),
  }, () => rec, { probe: async () => 'shell' });
  controller.begin();
  controller.release();
  await flush(); await flush();
  expect(urls[0]).toContain('inject=off');
  expect(sunk).toEqual(['hi there']);
});

test('without a sink, a dictation still refocuses the terminal (the pre-composer contract)', async () => {
  globalThis.fetch = async () => (
    { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi', injected: true, mode: 'claude' }) });
  const rec = { start: async () => {}, stop: async () => new ArrayBuffer(45), cancel() {}, recording: () => true };
  let focused = 0;
  const controller = createVoiceController('box1', 120,
    { write() {}, copy() {}, focus() { focused++; } }, () => rec, { probe: async () => 'shell' });
  controller.begin();
  controller.release();
  await flush(); await flush();
  expect(focused).toBe(1);
});

// --- The one 🎤 button (spec 2026-09-04) -----------------------------------
// A press probes the pane, links a Claude one, and dictates anywhere else.
// The reducer (voicePress.ts) owns the orderings; these drive the controller
// that runs its effects, with the recorder, the probe and the link all faked
// so every path is deterministic.

// A fake recorder that also supports the link's stream mode.
function streamRecorder() {
  const r = { started: 0, cancelled: 0, streamed: null, start: async () => { r.started++; }, stop: async () => new ArrayBuffer(45), cancel() { r.cancelled++; }, recording: () => true, stream(sink) { r.streamed = sink; } };
  return r;
}
function fakeLink() {
  const l = { sent: [], closed: 0, send: (f) => l.sent.push(f), close() { l.closed++; } };
  return l;
}
const noopHost = { write() {}, copy() {}, focus() {} };

test('idleTitle names the flow a press will take', () => {
  expect(idleTitle('claude', true)).toMatch(/link your mic to Claude Code/i);
  expect(idleTitle(null, true)).toMatch(/hold to dictate/i);
  expect(idleTitle(null, false)).toMatch(/not enabled/i);
  expect(idleTitle('claude', false)).toMatch(/link your mic/i);
});

test('a claude verdict links: the link opens, ready streams the recorder, the button reads live, a second press unlinks', async () => {
  stubDocument();
  const rec = streamRecorder();
  const link = fakeLink();
  let closeCb;
  const opened = [];
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'proj' }, () => rec, {
    probe: async (boxId, session) => { opened.push(['probe', boxId, session]); return 'claude'; },
    openLink: async (boxId, onClose) => { opened.push(['link', boxId]); closeCb = onClose; return link; },
    dictationEnabled: true,
  });
  let btn;
  c.mount({ appendChild: (b) => { btn = b; } }, { ok: true, reason: '', hint: '' });
  c.begin();
  await flush(); await flush();
  expect(opened).toEqual([['probe', 'box1', 'proj'], ['link', 'box1']]);
  expect(typeof rec.streamed).toBe('function');
  expect(c.recording()).toBe(true);
  // The button says so: amber 'live' state, the unlink affordance in the
  // tooltip, and the same text mirrored into the accessible name (the label
  // is a glyph, so the state change would otherwise be paint only).
  expect(btn.dataset.state).toBe('live');
  expect(btn.textContent).toBe('\u25cf live');
  expect(btn.title).toContain('Tap to unlink');
  expect(btn.attrs['aria-label']).toBe(btn.title);
  rec.streamed(new Uint8Array(640));
  expect(link.sent).toHaveLength(1);
  c.release();                       // ignored while live
  expect(c.recording()).toBe(true);
  c.begin();                         // second press = unlink
  expect(link.closed).toBe(1);
  expect(rec.cancelled).toBe(1);
  expect(c.recording()).toBe(false);
  expect(btn.dataset.state).toBe('idle');
  expect(typeof closeCb).toBe('function');
});

test('a refused link continues as dictation with the buffered audio and says why', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'kept words', injected: true, mode: 'claude' }) }; };
  const rec = streamRecorder();
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'claude',
    openLink: async () => { throw Object.assign(new Error('voice link not-set-up'), { why: 'not-set-up' }); },
    dictationEnabled: true,
  });
  c.begin();
  c.release();
  await flush(); await flush(); await flush();
  expect(writes.join('')).toMatch(/box not set up/);
  expect(writes.join('')).toMatch(/dictating instead/);
  expect(urls[0]).toContain('/api/voice?box=box1');
  expect(rec.streamed).toBeNull();
});

test('a non-claude verdict is today\'s dictation, and a release before the verdict finishes once it lands', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi', injected: true, mode: 'shell' }) }; };
  const rec = streamRecorder();
  let resolveVerdict;
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: () => new Promise((r) => { resolveVerdict = r; }),
    openLink: async () => { throw new Error('must not link'); },
    dictationEnabled: true,
  });
  c.begin();
  c.release();
  await flush();
  expect(urls).toEqual([]);
  resolveVerdict('shell');
  await flush(); await flush(); await flush();
  expect(urls).toHaveLength(1);
});

test('with whisper off a non-claude press explains itself instead of posting', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }; };
  const rec = streamRecorder();
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'shell', openLink: async () => fakeLink(), dictationEnabled: false,
  });
  c.begin(); c.release();
  await flush(); await flush(); await flush();
  expect(fetched).toBe(0);
  expect(writes.join('')).toMatch(/not enabled/);
  expect(rec.cancelled).toBe(1);
});

test('blur finishes a dictation but never unlinks a live link; dispose closes it', async () => {
  const rec = streamRecorder();
  const link = fakeLink();
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async () => link, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  expect(c.recording()).toBe(true);
  c.blur();
  expect(link.closed).toBe(0);
  expect(c.recording()).toBe(true);
  c.dispose();
  expect(link.closed).toBe(1);
});

test('the server closing a live link stops the mic and reports the reason', async () => {
  const rec = streamRecorder();
  let onClose;
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async (_b, cb) => { onClose = cb; return fakeLink(); }, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  onClose('superseded');
  expect(c.recording()).toBe(false);
  expect(rec.cancelled).toBe(1);
  expect(writes.join('')).toMatch(/another pane/);
});

test('finish() ends whatever is in flight: release for a recording, unlink for a link', async () => {
  const rec = streamRecorder();
  const link = fakeLink();
  // The composer is open, so the unlink's stopMic must leave focus on the
  // draft field — the same rule finishDictation follows on the sink path.
  const c = createVoiceController('box1', 120, {
    ...noopHost,
    session: () => 'web',
    sink: () => (t) => t,
    focus() { throw new Error('unlinking must not pull focus off the composer draft'); },
  }, () => rec, {
    probe: async () => 'claude', openLink: async () => link, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  c.finish();
  expect(link.closed).toBe(1);
  expect(c.recording()).toBe(false);
});

// A mic disabled by the readiness verdict (plain HTTP, unsupported browser)
// carries that verdict as its only explanation. refreshHint() repaints the
// idle tooltip, and main.ts calls it after EVERY status poll, so without the
// verdict surviving the repaint the button would advertise "Hold to dictate"
// within seconds of mounting and do nothing when tapped.
test('a disabled mic keeps its verdict tooltip through a hint refresh', () => {
  const made = stubDocument();
  const c = createVoiceController('box1', 120, noopHost, () => streamRecorder(), { probe: async () => 'shell' });
  c.mount({ appendChild() {} }, { ok: false, reason: 'R', hint: 'H' });
  const btn = made[0];
  expect(btn.disabled).toBe(true);
  expect(btn.title).toBe('R H');

  c.refreshHint();
  expect(btn.title).toBe('R H');
  expect(btn.attrs['aria-label']).toBe('R H');
  expect(btn.disabled).toBe(true);
});

// The other side of the getUserMedia race: the link reaches `ready` while the
// permission prompt is still up, so the reducer's 'stream' effect runs against
// a recorder with no worklet node and is a silent no-op. Without the re-arm in
// startMic the button would read 'live' with nothing ever on the wire. This
// fake mirrors the real recorder: stream() only takes effect once started.
function lateStartRecorder() {
  let resolveStart;
  const r = {
    cancelled: 0, started: false, streamed: null,
    start: () => new Promise((res) => { resolveStart = res; }),
    stop: async () => new ArrayBuffer(45),
    cancel() { r.cancelled++; },
    recording: () => true,
    stream(sink) { if (r.started) r.streamed = sink; },
    finishStart() { r.started = true; resolveStart(); },
  };
  return r;
}

test('a link that goes live while the mic is still opening streams once the mic is up', async () => {
  const rec = lateStartRecorder();
  const link = fakeLink();
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async () => link, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  // Live already — but the mic was not open when the effect ran, so nothing
  // was armed. This is the state the bug leaves permanently.
  expect(c.recording()).toBe(true);
  expect(rec.streamed).toBeNull();

  rec.finishStart();
  await flush();
  expect(typeof rec.streamed).toBe('function');
  rec.streamed(new Uint8Array(640));
  expect(link.sent).toHaveLength(1);
});

test('a probe that rejects cannot strand the press: it reads as error and dictates', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi', injected: true, mode: 'shell' }) }; };
  const rec = streamRecorder();
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: async () => { throw new Error('x'); },
    openLink: async () => { throw new Error('must not link'); },
    dictationEnabled: true,
  });
  c.begin();
  c.release();                       // the pointer is back up before the probe settles
  await flush(); await flush(); await flush();
  // An unanswered probe must never eat the audio: the reducer treats the
  // rejection exactly like the 1500ms timeout's 'error' verdict.
  expect(urls).toHaveLength(1);
  expect(c.recording()).toBe(false);
});
