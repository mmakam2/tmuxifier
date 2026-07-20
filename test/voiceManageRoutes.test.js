import { test, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let settings;
let installedFiles;

async function makeApp(over = {}) {
  settings = { enabled: false, model: 'small.en' };
  // Which model files exist on disk, keyed by filename. The status route must
  // report each model's own installed state — not just the selected one.
  installedFiles = new Set(['ggml-small.en.bin']);

  const config = {
    authMode: 'password', passwordHash: await hashPassword('pw'),
    cookieSecret: 'c'.repeat(32), voiceMaxBytes: 1024, voiceMaxSeconds: 120,
  };
  const store = { listBoxes: async () => [], getBox: async () => null };
  const statusChecker = { checkBox: async () => ({}), listSessions: async () => ({ sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };

  const voiceStore = {
    read: async () => ({ ...settings }),
    update: async (p) => {
      if (p.model !== undefined && !['small.en', 'base.en', 'medium.en-q5_0'].includes(p.model)) {
        throw new Error('unknown model');
      }
      settings = { ...settings, ...p };
      return { ...settings };
    },
  };
  const voiceInstallManager = {
    jobs: [],
    async start(model) {
      if (this.jobs.some((j) => j.status === 'running')) throw new Error('an install is already running');
      const j = { id: 'j1', model, status: 'running', phase: 'clone', log: '', error: null, createdAt: 1 };
      this.jobs.push(j); return j;
    },
    getJob(id) { return this.jobs.find((j) => j.id === id) || null; },
    current() { return this.jobs[0] || null; },
  };

  return buildServer({
    config, store, sessions, statusChecker, voiceStore, voiceInstallManager,
    resolveVoice: async () => ({
      bin: '/w', model: '/m', enabled: settings.enabled, pinned: { bin: 'vendor', model: 'store' },
    }),
    modelInstalled: (file) => installedFiles.has(file),
    getVoiceEngine: async () => ({ transcribe: async () => 'x', stop: async () => {}, state: () => 'stopped' }),
    ...over,
  });
}

beforeEach(async () => { app = await makeApp(); });

async function login(a = app) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}
const auth = (c) => ({ cookie: `${c.name}=${c.value}` });

test('every management route requires authentication', async () => {
  for (const [method, url] of [
    ['GET', '/api/voice/status'], ['POST', '/api/voice/install'],
    ['GET', '/api/voice/install/j1'], ['PATCH', '/api/voice/settings'],
  ]) {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
  }
});

test('status reports installed state, selection, pinning and the model catalog', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/voice/status', headers: auth(await login()) });
  expect(res.statusCode).toBe(200);
  const b = res.json();
  expect(b.installed).toBe(true);
  expect(b.enabled).toBe(false);
  expect(b.model).toBe('small.en');
  expect(b.pinned).toEqual({ bin: 'vendor', model: 'store' });
  expect(Array.isArray(b.models)).toBe(true);
  expect(b.models.some((m) => m.id === 'small.en')).toBe(true);
});

test('each model reports its OWN installed state, not the selection', async () => {
  // The trap: marking only the selected model as installed would make an
  // already-downloaded model show "will download" and re-trigger an install.
  installedFiles = new Set(['ggml-small.en.bin', 'ggml-base.en.bin']);
  const res = await app.inject({ method: 'GET', url: '/api/voice/status', headers: auth(await login()) });
  const byId = Object.fromEntries(res.json().models.map((m) => [m.id, m.installed]));
  expect(byId['small.en']).toBe(true);
  expect(byId['base.en']).toBe(true);          // installed but NOT selected
  expect(byId['medium.en-q5_0']).toBe(false);  // genuinely absent
});

test('settings can enable voice and switch model', async () => {
  const c = await login();
  const res = await app.inject({
    method: 'PATCH', url: '/api/voice/settings', headers: auth(c), payload: { enabled: true, model: 'base.en' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ enabled: true, model: 'base.en' });
});

test('settings rejects a model outside the catalog', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/voice/settings', headers: auth(await login()), payload: { model: '../../etc/passwd' },
  });
  expect(res.statusCode).toBe(400);
});

test('install starts a job and refuses a second while it runs', async () => {
  const c = await login();
  const first = await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  expect(first.statusCode).toBe(200);
  expect(first.json().status).toBe('running');

  const second = await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  expect(second.statusCode).toBe(409);
});

test('install rejects a model outside the catalog', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/voice/install', headers: auth(await login()), payload: { model: 'nope' },
  });
  expect(res.statusCode).toBe(400);
});

test('a job can be polled by id, and an unknown id is 404', async () => {
  const c = await login();
  await app.inject({ method: 'POST', url: '/api/voice/install', headers: auth(c), payload: { model: 'base.en' } });
  const ok = await app.inject({ method: 'GET', url: '/api/voice/install/j1', headers: auth(c) });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().id).toBe('j1');

  const missing = await app.inject({ method: 'GET', url: '/api/voice/install/nope', headers: auth(c) });
  expect(missing.statusCode).toBe(404);
});

test('enabling voice through settings flips what /api/ui-config reports', async () => {
  // Proves the two surfaces agree: the tab turning voice on must be what the
  // terminal sees, with no restart in between.
  const c = await login();
  const before = await app.inject({ method: 'GET', url: '/api/ui-config', headers: auth(c) });
  expect(before.json().voice).toBe(false);

  await app.inject({ method: 'PATCH', url: '/api/voice/settings', headers: auth(c), payload: { enabled: true } });

  const after = await app.inject({ method: 'GET', url: '/api/ui-config', headers: auth(c) });
  expect(after.json().voice).toBe(true);
});
