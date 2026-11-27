import { test, expect, afterEach } from 'vitest';
import { onUnauthorized } from '../src/web/http.ts';
import { api } from '../src/web/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; onUnauthorized(null); });

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return response; };
  return calls;
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const unauthorized = { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'unauthorized' }) };

test('panePreview asks for the pane and 40 lines, and never for cols or rows', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b1', '%12');
  expect(calls[0].url).toBe('/api/boxes/b1/pane?pane=%2512&lines=40');
  expect(calls[0].url).not.toMatch(/cols|rows|client|session/);
});

test('panePreview encodes the box id and the pane id', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b/1', '%1 &x');
  expect(calls[0].url).toBe('/api/boxes/b%2F1/pane?pane=%251%20%26x&lines=40');
});

test('localPanePreview targets the Host Shell route with the pane', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.localPanePreview('%3');
  expect(calls[0].url).toBe('/api/local-shell/pane?pane=%253&lines=40');
  expect(calls[0].url).not.toMatch(/cols|rows|client|session/);
});

test('both pass the abort signal through and route a 401 to the seam', async () => {
  const ac = new AbortController();
  let calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b1', '%1', ac.signal);
  expect(calls[0].opts.signal).toBe(ac.signal);
  await api.localPanePreview('%1', ac.signal);
  expect(calls[1].opts.signal).toBe(ac.signal);

  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch(unauthorized);
  await expect(api.panePreview('b1', '%1')).rejects.toThrow(/unauthorized/);
  stubFetch(unauthorized);
  await expect(api.localPanePreview('%1')).rejects.toThrow(/unauthorized/);
  expect(fired).toBe(2);
});

// The calls that act on one pane rather than on a session.
test('agentSeen posts the pane and the marker timestamp', async () => {
  const calls = stubFetch(okJson({ ok: true }));
  await api.agentSeen('b1', '%12', 1700000000);
  expect(calls[0].url).toBe('/api/boxes/b1/agent-seen');
  expect(calls[0].opts.method).toBe('POST');
  expect(JSON.parse(calls[0].opts.body)).toEqual({ pane: '%12', ts: 1700000000 });
});

test('selectWindow sends the pane only when one is given', async () => {
  const calls = stubFetch(okJson({ ok: true, windowId: '@3' }));
  await api.selectWindow('b1', 'main', '@3');
  expect(calls[0].url).toBe('/api/boxes/b1/window');
  expect(calls[0].opts.method).toBe('POST');
  expect(JSON.parse(calls[0].opts.body)).toEqual({ session: 'main', windowId: '@3' });
  expect(Object.hasOwn(JSON.parse(calls[0].opts.body), 'paneId')).toBe(false);
  await api.selectWindow('b1', 'main', '@3', '%9');
  expect(JSON.parse(calls[1].opts.body)).toEqual({ session: 'main', windowId: '@3', paneId: '%9' });
});

test('localSelectWindow posts to the Host Shell route, with the pane only when given', async () => {
  const calls = stubFetch(okJson({ ok: true }));
  await api.localSelectWindow('@0');
  expect(calls[0].url).toBe('/api/local-shell/window');
  expect(calls[0].opts.method).toBe('POST');
  expect(JSON.parse(calls[0].opts.body)).toEqual({ windowId: '@0' });
  await api.localSelectWindow('@0', '%4');
  expect(JSON.parse(calls[1].opts.body)).toEqual({ windowId: '@0', paneId: '%4' });
});

test('the pane-level calls route a 401 to the seam', async () => {
  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  for (const call of [() => api.agentSeen('b1', '%1', 1), () => api.selectWindow('b1', 's', '@1', '%1'), () => api.localSelectWindow('@1', '%1')]) {
    stubFetch(unauthorized);
    await expect(call()).rejects.toThrow(/unauthorized/);
  }
  expect(fired).toBe(3);
});
