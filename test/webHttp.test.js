import { test, expect, afterEach } from 'vitest';
import { jsonFetch, onUnauthorized } from '../src/web/http.ts';
import { api } from '../src/web/api.ts';
import { pve } from '../src/web/proxmox.ts';
import { nbx } from '../src/web/netbox.ts';
import { pk } from '../src/web/passkeys.ts';
import { voiceApi } from '../src/web/voice.ts';

// C2 (2026-07-29 review). api.ts owned the central 401 seam, but proxmox.ts,
// netbox.ts, passkeys.ts and voice.ts each hand-rolled their own jr()/j() pair
// and never called it. An expired session reaching any of them threw a generic
// error while the app went on believing it was signed in — the root cause behind
// B6 (the voice install poller 401ing every 2s forever after logout) and B28.
//
// The seam now lives in http.ts and every layer routes through it, so the next
// fetch layer inherits the behaviour instead of having to remember it.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; onUnauthorized(null); });

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return response; };
  return calls;
}

const unauthorized = { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'unauthorized' }) };

// One call per layer, chosen to be a plain read so the assertion is about the
// seam and not about the request shape (which each layer's own tests cover).
const LAYERS = [
  ['api', () => api.boxes()],
  ['pve', () => pve.hosts()],
  ['nbx', () => nbx.get()],
  ['pk', () => pk.state()],
  ['voiceApi', () => voiceApi.status()],
];

for (const [name, call] of LAYERS) {
  test(`${name}: a 401 fires the shared unauthorized handler and still rejects`, async () => {
    let fired = 0;
    onUnauthorized(() => { fired += 1; });
    stubFetch(unauthorized);
    await expect(call()).rejects.toThrow(/unauthorized/);
    expect(fired, 'the handler registered on http.ts must be the one every layer reaches').toBe(1);
  });

  test(`${name}: a non-401 error does not fire the handler`, async () => {
    let fired = 0;
    onUnauthorized(() => { fired += 1; });
    stubFetch({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'nope' }) });
    await expect(call()).rejects.toThrow(/nope/);
    expect(fired).toBe(0);
  });
}

// api.ts re-exports the seam so main.ts's single registration keeps working and
// no caller has to know the helper moved. If these ever became two slots, a
// registration through one would silently leave the other layers unhooked —
// exactly the bug this row fixes.
test('api.ts re-exports the same handler slot as http.ts', async () => {
  const mod = await import('../src/web/api.ts');
  expect(mod.onUnauthorized).toBe(onUnauthorized);
});

// B28. getBoxSetup hand-rolled its own response check inside api.ts, so the
// provision panel's 1.5s poll churned 401s past the seam that sits directly
// above it. 204 (no setup job for this box) must stay a null, not an error.
test('getBoxSetup routes 401 through the seam but keeps 204 meaning "no job"', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });

  stubFetch({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'unauthorized' }) });
  await expect(api.getBoxSetup('B1')).rejects.toThrow();
  expect(fired).toBe(1);

  stubFetch({ ok: true, status: 204, statusText: 'No Content', json: async () => { throw new Error('204 has no body'); } });
  await expect(api.getBoxSetup('B1')).resolves.toBe(null);
  expect(fired).toBe(1);
});

test('jsonFetch prefers the server error, then statusText, then the bare status', async () => {
  stubFetch({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'invalid endpoint' }) });
  await expect(jsonFetch('/x')).rejects.toThrow('invalid endpoint');

  stubFetch({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) });
  await expect(jsonFetch('/x')).rejects.toThrow('Bad Request');

  // HTTP/2 carries no reason phrase, so fetch reports statusText as ''. The old
  // hand-rolled copies in netbox/proxmox/passkeys threw an empty message there;
  // voice.ts's `HTTP <status>` fallback was the one right answer and is kept.
  stubFetch({ ok: false, status: 503, statusText: '', json: async () => ({}) });
  await expect(jsonFetch('/x')).rejects.toThrow('HTTP 503');
});

test('jsonFetch survives a non-JSON error body', async () => {
  stubFetch({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await expect(jsonFetch('/x')).rejects.toThrow('Bad Gateway');
});

test('jsonFetch passes init through untouched', async () => {
  const calls = stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) });
  await jsonFetch('/api/thing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  expect(calls[0].url).toBe('/api/thing');
  expect(calls[0].opts).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
});

// The point of the row: one implementation, not five. A new copy of the
// hand-rolled pair is how the seam got bypassed four times over.
test('no fetch layer hand-rolls its own response check', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const webDir = fileURLToPath(new URL('../src/web/', import.meta.url));

  const offenders = [];
  for (const file of readdirSync(webDir).filter((f) => f.endsWith('.ts')).sort()) {
    if (file === 'http.ts') continue; // the one place allowed to define it
    const src = readFileSync(path.join(webDir, file), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (/if\s*\(!res\.ok\)/.test(code)) offenders.push(file);
  }
  expect(offenders, 'these bypass http.ts and so bypass the 401 seam').toEqual([]);
});

// E4 needs to tell a 404 from a transient failure, and the thrown Error carried
// only a message. The status rides on the error now — one place, so every layer
// gets it rather than the caller re-fetching to find out what happened.
test('a thrown http error carries its status code', async () => {
  stubFetch({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'gone' }) });
  const err = await jsonFetch('/x').catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.status).toBe(404);
  expect(err.message).toBe('gone');
});

test('the status rides along on a 401 too, without disturbing the seam', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch(unauthorized);
  const err = await jsonFetch('/x').catch((e) => e);
  expect(err.status).toBe(401);
  expect(fired).toBe(1);
});
