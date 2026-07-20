import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createGoogleAuth, base64url } from '../src/server/googleAuth.js';

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

async function makeApp({ email = 'alice@example.com', emailVerified = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-goog-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    authMode: 'google', cookieSecret: 'test-secret', secureCookie: false,
    publicUrl: 'https://tmux.example.com',
    googleClientId: 'cid', googleClientSecret: 'csecret', allowedEmails: ['alice@example.com'],
    dataDir: dir, sshConfigPath: path.join(dir, 'nope'),
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ id_token: makeIdToken({ email, email_verified: emailVerified }) }),
  });
  const googleAuth = createGoogleAuth({
    clientId: config.googleClientId, clientSecret: config.googleClientSecret,
    redirectUri: 'https://tmux.example.com/api/auth/google/callback',
    allowedEmails: config.allowedEmails, fetchImpl,
  });
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, googleAuth });
}

async function flow(app, { tamperState = false } = {}) {
  const login = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  const oauth = login.cookies.find((c) => c.name === 'tmuxifier_oauth');
  const sentState = new URL(login.headers.location).searchParams.get('state');
  const useState = tamperState ? 'WRONG' : sentState;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(useState)}`,
    headers: { cookie: `tmuxifier_oauth=${oauth.value}` },
  });
  return { login, oauth, cb };
}

let app;
beforeEach(async () => { app = await makeApp(); });

test('/api/auth/info reports google mode and /api/login is gone', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json()).toMatchObject({ mode: 'google' });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'x' } });
  expect(login.statusCode).toBe(404);
});

test('login redirects to Google and sets the signed oauth cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
  expect(res.cookies.find((c) => c.name === 'tmuxifier_oauth')).toBeTruthy();
});

test('callback with valid state + allowed email sets the session cookie', async () => {
  const { cb } = await flow(app);
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe('/');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeTruthy();
});

test('callback with a mismatched state is rejected', async () => {
  const { cb } = await flow(app, { tamperState: true });
  expect(cb.headers.location).toBe('/?error=state');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with a disallowed email is forbidden', async () => {
  app = await makeApp({ email: 'mallory@evil.com' });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with an unverified email is forbidden', async () => {
  app = await makeApp({ emailVerified: false });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
});

test('callback with no oauth cookie is rejected as state error', async () => {
  const cb = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=ST' });
  expect(cb.headers.location).toBe('/?error=state');
});
