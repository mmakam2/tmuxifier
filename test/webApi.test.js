import { test, expect, afterEach } from 'vitest';
import { api, onUnauthorized } from '../src/web/api.ts';

// api.ts calls the global fetch; stub it and restore after each test (same
// pattern as proxmoxWebClient.test.js).
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; onUnauthorized(null); });

function stubFetch(response) {
  globalThis.fetch = async () => response;
}

// When the session cookie expires (or the server restarts with a new secret),
// every poller and action starts failing with 401s. Without a central seam the
// dashboard silently froze — dots and sparklines stuck at their last values
// forever. The registered handler routes back to the login screen.
test('a 401 response fires the registered unauthorized handler and still rejects', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'unauthorized' }) });
  await expect(api.boxes()).rejects.toThrow(/unauthorized/);
  expect(fired).toBe(1);
});

test('non-401 errors do not fire the unauthorized handler', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'nope' }) });
  await expect(api.addBox({ host: 'h' })).rejects.toThrow(/nope/);
  expect(fired).toBe(0);
});

test('successful responses do not fire the unauthorized handler', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => [] });
  await expect(api.boxes()).resolves.toEqual([]);
  expect(fired).toBe(0);
});

test('a 401 with no registered handler still rejects cleanly', async () => {
  stubFetch({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'unauthorized' }) });
  await expect(api.boxes()).rejects.toThrow(/unauthorized/);
});
