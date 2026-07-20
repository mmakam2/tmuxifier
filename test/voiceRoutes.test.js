import { test, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let injected;

async function makeApp(over = {}) {
  const config = {
    authMode: 'password',
    // hashPassword is async (scrypt) — see test/server.test.js's makeApp for
    // the same pattern. Passing the bare Promise here (as the plan's draft
    // code did) makes config.passwordHash stringify to "[object Promise]",
    // so verifyPassword's scheme check fails and every login 401s regardless
    // of password. Confirmed empirically: with the un-awaited call every test
    // that depends on login() failed with 401 instead of its intended
    // assertion.
    passwordHash: await hashPassword('pw'),
    cookieSecret: 'c'.repeat(32),
    voiceEnabled: true,
    voiceMaxBytes: 1024,
    voiceMaxSeconds: 120,
    ...over.config,
  };
  const store = {
    listBoxes: async () => [{ id: 'b1', name: 'web', host: 'h', user: 'u', sessionName: 'web' }],
    getBox: async (id) => (id === 'b1'
      ? { id: 'b1', name: 'web', host: 'h', user: 'u', sessionName: 'web' } : null),
  };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const boxActions = {
    injectText: async (_box, _session, text) => { injected.push(text); return { injected: true, mode: 'claude' }; },
  };
  const voiceEngine = { transcribe: async () => 'hello\nworld', stop: async () => {}, state: () => 'ready' };
  return buildServer({ config, store, sessions, statusChecker, boxActions, voiceEngine, ...over.server });
}

beforeEach(async () => { injected = []; app = await makeApp(); });

async function login(a = app) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}

const wav = () => Buffer.from('RIFF0000WAVEfmt ');

async function post(a, cookie, body = wav(), url = '/api/voice?box=b1') {
  return a.inject({
    method: 'POST', url, payload: body,
    headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}) },
  });
}

test('rejects unauthenticated transcription', async () => {
  const res = await post(app, null);
  expect(res.statusCode).toBe(401);
  expect(injected).toEqual([]);
});

test('transcribes, normalizes, and injects into the box session', async () => {
  const res = await post(app, await login());
  expect(res.statusCode).toBe(200);
  // The newline from the engine is collapsed before it reaches send-keys.
  expect(res.json()).toEqual({ text: 'hello world', injected: true, mode: 'claude' });
  expect(injected).toEqual(['hello world']);
});

test('returns 503 when voice is disabled', async () => {
  const a = await makeApp({ config: { voiceEnabled: false } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});

test('returns 503 when no engine is wired', async () => {
  const a = await makeApp({ server: { voiceEngine: null } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});

test('rejects an unknown box', async () => {
  const res = await post(app, await login(), wav(), '/api/voice?box=nope');
  expect(res.statusCode).toBe(400);
});

test('rejects an empty body', async () => {
  const res = await post(app, await login(), Buffer.alloc(0));
  expect(res.statusCode).toBe(400);
});

test('enforces voiceMaxBytes with a 413', async () => {
  const res = await post(app, await login(), Buffer.alloc(4096));
  expect(res.statusCode).toBe(413);
  expect(injected).toEqual([]);
});

test('returns the transcript even when injection fails', async () => {
  const a = await makeApp({ server: {
    boxActions: { injectText: async () => ({ injected: false, mode: 'busy' }) },
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(200);
  // The text must survive a refused injection — the client puts it on the
  // clipboard so nothing spoken is ever lost.
  expect(res.json()).toEqual({ text: 'hello world', injected: false, mode: 'busy' });
});

test('maps engine overload to 429 and engine failure to 502', async () => {
  const boom = (status) => ({
    transcribe: async () => { const e = new Error('x'); e.status = status; throw e; },
    stop: async () => {}, state: () => 'stopped',
  });
  for (const [status, expected] of [[429, 429], [502, 502], [503, 503]]) {
    const a = await makeApp({ server: { voiceEngine: boom(status) } });
    const res = await post(a, await login(a));
    expect(res.statusCode).toBe(expected);
  }
});

test('an empty transcript is reported, not typed', async () => {
  const a = await makeApp({ server: {
    voiceEngine: { transcribe: async () => '[BLANK_AUDIO]', stop: async () => {}, state: () => 'ready' },
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ text: '', injected: false, mode: 'empty' });
  expect(injected).toEqual([]);
});

test('clamps a nonsense/out-of-range engine error status to 502', async () => {
  const boom = (status) => ({
    transcribe: async () => { const e = new Error('x'); e.status = status; throw e; },
    stop: async () => {}, state: () => 'stopped',
  });
  // 200 (success-range) and 999 (out of HTTP range) must never pass through
  // verbatim — only a genuine 4xx/5xx integer from the engine should.
  for (const status of [200, 999, -1, 0, 'nope', undefined, null, NaN]) {
    const a = await makeApp({ server: { voiceEngine: boom(status) } });
    const res = await post(a, await login(a));
    expect(res.statusCode).toBe(502);
  }
});

// --- box=__local__ ------------------------------------------------------

test('injects into the local session via injectLocalText (not boxActions.injectText) for box=__local__', async () => {
  const localCalls = [];
  const a = await makeApp({ server: {
    injectLocalText: async (session, text) => { localCalls.push([session, text]); return { injected: true, mode: 'shell' }; },
  } });
  const res = await post(a, await login(a), wav(), '/api/voice?box=__local__');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ text: 'hello world', injected: true, mode: 'shell' });
  expect(localCalls).toEqual([['local', 'hello world']]);
  // The box-side injector must not have been touched for a local dictation.
  expect(injected).toEqual([]);
});

test('box=__local__ dictation does not go through store.getBox', async () => {
  const getBoxCalls = [];
  const store = {
    listBoxes: async () => [],
    // '__local__' is not a real box id; if the route ever called getBox with
    // it, a real store would return null for it. Track calls directly so a
    // regression that starts calling getBox is caught regardless of what it
    // returns.
    getBox: async (id) => { getBoxCalls.push(id); return null; },
  };
  const a = await makeApp({ server: {
    store,
    injectLocalText: async () => ({ injected: true, mode: 'shell' }),
  } });
  const res = await post(a, await login(a), wav(), '/api/voice?box=__local__');
  expect(res.statusCode).toBe(200);
  expect(getBoxCalls).toEqual([]);
});

test('the transcript is still returned when __local__ injection is refused', async () => {
  const a = await makeApp({ server: {
    injectLocalText: async () => ({ injected: false, mode: 'busy' }),
  } });
  const res = await post(a, await login(a), wav(), '/api/voice?box=__local__');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ text: 'hello world', injected: false, mode: 'busy' });
});

// --- stage 2: data/voice.json governs the running server ---------------------
// resolveVoice is injected, so these prove the route consults the store's
// resolved state rather than the boot-time config.

test('/api/ui-config reports voice off when the store disables it', async () => {
  const a = await makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: false, pinned: { bin: 'vendor', model: 'store' } }),
  } });
  const cookie = await login(a);
  const res = await a.inject({ method: 'GET', url: '/api/ui-config', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.json().voice).toBe(false);
});

test('/api/ui-config reports voice on when the store enables it', async () => {
  const a = await makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: true, pinned: { bin: 'vendor', model: 'store' } }),
  } });
  const cookie = await login(a);
  const res = await a.inject({ method: 'GET', url: '/api/ui-config', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.json().voice).toBe(true);
});

test('transcription is refused when the store has voice disabled', async () => {
  const a = await makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: false, pinned: { bin: null, model: null } }),
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});

test('the permissions-policy header follows the store, not boot config', async () => {
  // The header gates getUserMedia and is set in a synchronous hook, so it
  // reads a cache refreshed by voiceState(). Enabling voice at runtime must
  // eventually flip it, or the mic stays blocked despite the UI saying on.
  const a = await makeApp({ server: {
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: true, pinned: { bin: null, model: null } }),
  } });
  const cookie = await login(a);
  const hdrs = { cookie: `${cookie.name}=${cookie.value}` };
  await a.inject({ method: 'GET', url: '/api/ui-config', headers: hdrs }); // refreshes the cache
  const res = await a.inject({ method: 'GET', url: '/api/ui-config', headers: hdrs });
  expect(res.headers['permissions-policy']).toContain('microphone=(self)');
});

test('the engine is taken from getVoiceEngine when supplied, so a model switch is picked up', async () => {
  let handed = 0;
  const a = await makeApp({ server: {
    voiceEngine: null,
    getVoiceEngine: async () => { handed += 1; return { transcribe: async () => 'from the new engine', stop: async () => {}, state: () => 'ready' }; },
    resolveVoice: async () => ({ bin: '/w', model: '/m', enabled: true, pinned: { bin: null, model: null } }),
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(200);
  expect(res.json().text).toBe('from the new engine');
  expect(handed).toBeGreaterThan(0);
});
