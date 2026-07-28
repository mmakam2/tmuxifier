import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createIconStore } from '../src/server/iconStore.js';

let catalogDir, cacheDir, store;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-icon-'));
  catalogDir = path.join(dir, 'catalog');
  cacheDir = path.join(dir, 'cache');
  await fs.mkdir(catalogDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  store = createIconStore({ catalogDir, cacheDir });
});

const svc = (over = {}) => ({ id: 'svc-1', name: 'Controller', url: 'https://unifi.example.com/', check: { kind: 'unifi' }, ...over });
const putCatalog = (slug, body = '<svg/>', ext = 'svg') => fs.writeFile(path.join(catalogDir, `${slug}.${ext}`), body);
const putCache = (id, ext, body = 'PNGDATA') => fs.writeFile(path.join(cacheDir, `${id}.${ext}`), body);

test('resolve finds a catalog icon by the check kind and reports its type', async () => {
  await putCatalog('unifi');
  const hit = await store.resolve(svc());
  expect(hit.contentType).toBe('image/svg+xml');
  expect(hit.bytes.toString()).toBe('<svg/>');
  expect(hit.etag).toMatch(/^"[a-f0-9]{32}"$/);
});

test('resolve returns null when nothing matches', async () => {
  expect(await store.resolve(svc())).toBe(null);
});

test('a PNG-only catalog entry resolves, since a fifth of upstream has no vector', async () => {
  const hit = await store.resolve(svc({ name: 'Homepage', check: { kind: 'none' } }));
  expect(hit).toBe(null);
  await putCatalog('homepage', 'PNGBYTES', 'png');
  const found = await store.resolve(svc({ name: 'Homepage', check: { kind: 'none' } }));
  expect(found.contentType).toBe('image/png');
  expect(found.bytes.toString()).toBe('PNGBYTES');
});

test('SVG wins over PNG when the catalog carries both for one slug', async () => {
  await putCatalog('unifi', 'PNGBYTES', 'png');
  await putCatalog('unifi', '<svg id="vector"/>', 'svg');
  expect((await store.resolve(svc())).contentType).toBe('image/svg+xml');
});

test('an explicit icon outranks the guess, and the guess outranks the cache', async () => {
  await putCatalog('unifi', '<svg id="guess"/>');
  await putCatalog('grafana', '<svg id="explicit"/>');
  await putCache('svc-1', 'png');
  expect((await store.resolve(svc({ icon: 'grafana' }))).bytes.toString()).toBe('<svg id="explicit"/>');
  expect((await store.resolve(svc())).bytes.toString()).toBe('<svg id="guess"/>');
});

test('the cache is used only once the catalog misses, and carries its own type', async () => {
  await putCache('svc-1', 'png');
  const hit = await store.resolve(svc());
  expect(hit.contentType).toBe('image/png');
  expect(hit.bytes.toString()).toBe('PNGDATA');
});

test('icon "none" suppresses even when a catalog file exists', async () => {
  await putCatalog('unifi');
  expect(await store.resolve(svc({ icon: 'none' }))).toBe(null);
});

test('an explicit icon missing from the catalog falls through rather than suppressing', async () => {
  await putCache('svc-1', 'png');
  const hit = await store.resolve(svc({ icon: 'grafana' }));
  expect(hit.bytes.toString()).toBe('PNGDATA');
});

test('a slug that escapes the catalog directory is refused even when the regex is bypassed', async () => {
  const outside = path.join(catalogDir, '..', 'outside.svg');
  await fs.writeFile(outside, '<svg id="secret"/>');
  expect(await store.resolve(svc({ icon: '../outside' }))).toBe(null);
  expect(await store.readCatalogIcon('../outside')).toBe(null);
  expect(await store.readCatalogIcon('/etc/passwd')).toBe(null);
});

test('listCatalog reports the slugs on disk, sorted, deduped across extensions', async () => {
  await putCatalog('unifi');
  await putCatalog('grafana');
  await putCatalog('homepage', 'PNGBYTES', 'png');
  await putCatalog('unifi', 'PNGBYTES', 'png');
  await fs.writeFile(path.join(catalogDir, 'notes.txt'), 'ignored');
  expect(await store.listCatalog()).toEqual(['grafana', 'homepage', 'unifi']);
});

test('listCatalog is empty rather than throwing when the catalog was never fetched', async () => {
  const bare = createIconStore({ catalogDir: path.join(catalogDir, 'nope'), cacheDir });
  expect(await bare.listCatalog()).toEqual([]);
});

test('forget removes a cached favicon and tolerates one that is not there', async () => {
  await putCache('svc-1', 'png');
  await store.forget('svc-1');
  expect(await store.resolve(svc())).toBe(null);
  await expect(store.forget('svc-1')).resolves.toBeUndefined();
  await expect(store.forget('../escape')).resolves.toBeUndefined();
});

// A real loopback server rather than a mocked fetch: the repo's convention is
// real code, and the size cap and redirect limit are only meaningful against
// an actual response stream.
function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('refreshFavicon follows a declared <link rel=icon> and caches the bytes', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><link rel="icon" type="image/svg+xml" href="/logo.svg"></head></html>');
    } else if (req.url === '/logo.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end('<svg id="scraped"/>');
    } else { res.statusCode = 404; res.end(); }
  });
  try {
    expect(await store.refreshFavicon(svc({ url: `${site.url}/` }))).toEqual({ ok: true });
    const hit = await store.resolve(svc({ url: `${site.url}/` }));
    expect(hit.contentType).toBe('image/svg+xml');
    expect(hit.bytes.toString()).toBe('<svg id="scraped"/>');
  } finally { await site.close(); }
});

test('refreshFavicon falls back to /favicon.ico when the page declares nothing', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/favicon.ico') {
      res.setHeader('content-type', 'image/x-icon');
      res.end('ICODATA');
    } else { res.setHeader('content-type', 'text/html'); res.end('<html><head></head></html>'); }
  });
  try {
    expect(await store.refreshFavicon(svc({ url: `${site.url}/` }))).toEqual({ ok: true });
    expect((await store.resolve(svc({ url: `${site.url}/` }))).contentType).toBe('image/x-icon');
  } finally { await site.close(); }
});

test('refreshFavicon refuses a non-image content type and leaves no partial file', async () => {
  const site = await serve((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><head></head></html>');
  });
  try {
    const r = await store.refreshFavicon(svc({ url: `${site.url}/` }));
    expect(r.ok).toBe(false);
    expect(await store.readCached('svc-1')).toBe(null);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  } finally { await site.close(); }
});

test('refreshFavicon aborts an oversized body and leaves no partial file', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/favicon.ico') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.alloc(300 * 1024, 0x41));
    } else { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); }
  });
  try {
    const r = await store.refreshFavicon(svc({ url: `${site.url}/` }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too large/i);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  } finally { await site.close(); }
});

test('refreshFavicon gives up rather than following a redirect loop', async () => {
  const site = await serve((req, res) => { res.statusCode = 302; res.setHeader('location', '/again'); res.end(); });
  try {
    const r = await store.refreshFavicon(svc({ url: `${site.url}/` }));
    expect(r.ok).toBe(false);
  } finally { await site.close(); }
});

test('refreshFavicon replaces a cached icon of a different extension rather than stacking', async () => {
  await putCache('svc-1', 'png', 'STALE');
  const site = await serve((req, res) => {
    if (req.url === '/favicon.ico') { res.setHeader('content-type', 'image/x-icon'); res.end('FRESH'); }
    else { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); }
  });
  try {
    expect(await store.refreshFavicon(svc({ url: `${site.url}/` }))).toEqual({ ok: true });
    expect(await fs.readdir(cacheDir)).toEqual(['svc-1.ico']);
    expect((await store.readCached('svc-1')).bytes.toString()).toBe('FRESH');
  } finally { await site.close(); }
});

test('refreshFavicon reports a failure rather than throwing when the host is unreachable', async () => {
  const r = await store.refreshFavicon(svc({ url: 'http://127.0.0.1:1/' }));
  expect(r.ok).toBe(false);
  expect(typeof r.reason).toBe('string');
});
