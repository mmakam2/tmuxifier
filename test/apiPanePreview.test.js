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

test('panePreview asks for the session and 40 lines, and never for cols or rows', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b1', 'side');
  expect(calls[0].url).toBe('/api/boxes/b1/pane?session=side&lines=40');
  expect(calls[0].url).not.toMatch(/cols|rows|client/);
});

test('panePreview encodes the box id and the session', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b/1', 'a b&c');
  expect(calls[0].url).toBe('/api/boxes/b%2F1/pane?session=a%20b%26c&lines=40');
});

test('localPanePreview targets the Host Shell route', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.localPanePreview();
  expect(calls[0].url).toBe('/api/local-shell/pane?lines=40');
});

test('both pass the abort signal through and route a 401 to the seam', async () => {
  const ac = new AbortController();
  let calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b1', 's', ac.signal);
  expect(calls[0].opts.signal).toBe(ac.signal);
  await api.localPanePreview(ac.signal);
  expect(calls[1].opts.signal).toBe(ac.signal);

  let fired = 0;
  onUnauthorized(() => { fired += 1; });
  stubFetch(unauthorized);
  await expect(api.panePreview('b1', 's')).rejects.toThrow(/unauthorized/);
  stubFetch(unauthorized);
  await expect(api.localPanePreview()).rejects.toThrow(/unauthorized/);
  expect(fired).toBe(2);
});
