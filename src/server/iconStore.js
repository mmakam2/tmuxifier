import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSafeSlug, slugCandidates, parseIconLinks } from './iconResolve.js';
import { CATALOG_EXTS } from './iconCatalog.js';

// Resolution and caching for service icons. The pure half lives in
// iconResolve.js; this is the only module that touches disk or the network.
//
// Two directories, deliberately separate: vendor/icons/ is the curated catalog
// that `npm run fetch-icons` writes, and data/icons/ is the per-service
// favicon cache. Keeping them apart means a re-fetch of the catalog can never
// disturb a scraped favicon, and clearing scraped junk can never delete the
// catalog.

const TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
// A scraped favicon can be any of these; the catalog is narrower (CATALOG_EXTS).
export const CACHE_EXTS = ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp'];

const MAX_BYTES = 256 * 1024;
const HTML_PREFIX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const EXT_FOR_TYPE = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

// The regex should already make traversal impossible. This is the check that
// stays correct if the regex is ever relaxed, so it guards every read rather
// than trusting the caller.
function safeJoin(dir, name) {
  const full = path.resolve(dir, name);
  const base = path.resolve(dir) + path.sep;
  return full.startsWith(base) ? full : null;
}

async function readIcon(file) {
  if (!file) return null;
  const contentType = TYPES[path.extname(file).toLowerCase()];
  if (!contentType) return null;
  let bytes;
  try { bytes = await fs.readFile(file); } catch { return null; }
  const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
  return { bytes, contentType, etag };
}

// node:http(s) rather than fetch, for the same reason serviceCheck.js uses it:
// these are LAN hosts with self-signed certificates and this request carries no
// credential — no API key, no password, no session — so it takes the
// uncredentialed-probe posture rather than the credentialed clients' verified
// one. It is also the only way to abort an oversized body mid-stream instead of
// buffering it and rejecting afterwards.
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('invalid url')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('unsupported scheme')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, timeout: TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (depth >= MAX_REDIRECTS) { reject(new Error('too many redirects')); return; }
        let next;
        try { next = new URL(location, u).href; } catch { reject(new Error('bad redirect')); return; }
        resolve(get(next, depth + 1));
        return;
      }
      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks), url: u.href }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export function createIconStore({ catalogDir, cacheDir }) {
  // CATALOG_EXTS is ordered SVG-first, so a slug carrying both resolves to the
  // vector.
  async function readCatalogIcon(slug) {
    if (!isSafeSlug(slug)) return null;
    for (const ext of CATALOG_EXTS) {
      const hit = await readIcon(safeJoin(catalogDir, `${slug}.${ext}`));
      if (hit) return hit;
    }
    return null;
  }

  async function readCached(serviceId) {
    if (typeof serviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(serviceId)) return null;
    for (const ext of CACHE_EXTS) {
      const hit = await readIcon(safeJoin(cacheDir, `${serviceId}.${ext}`));
      if (hit) return hit;
    }
    return null;
  }

  // A local function rather than a method, because refreshFavicon calls it.
  // Reaching it through `this` would break the moment a caller destructured the
  // store, which is a normal thing to do to a factory result.
  async function forget(serviceId) {
    for (const ext of CACHE_EXTS) {
      const file = safeJoin(cacheDir, `${serviceId}.${ext}`);
      if (!file) continue;
      try { await fs.unlink(file); } catch { /* already gone */ }
    }
  }

  return {
    readCatalogIcon,
    readCached,
    forget,

    async resolve(svc) {
      if (!svc) return null;
      // 'none' is an explicit suppression, not a failure to fall through.
      if (svc.icon === 'none') return null;
      // An explicit slug the catalog does not carry falls through rather than
      // 404ing: a catalog that has not been fetched yet should still yield the
      // scraped favicon.
      if (svc.icon) {
        const hit = await readCatalogIcon(svc.icon);
        if (hit) return hit;
      }
      for (const slug of slugCandidates(svc)) {
        const hit = await readCatalogIcon(slug);
        if (hit) return hit;
      }
      return readCached(svc.id);
    },

    async listCatalog() {
      let names;
      // A catalog that was never fetched is an empty picker, not an error.
      try { names = await fs.readdir(catalogDir); } catch { return []; }
      const slugs = new Set();
      for (const name of names) {
        const ext = path.extname(name).slice(1).toLowerCase();
        if (!CATALOG_EXTS.includes(ext)) continue;
        const slug = name.slice(0, -(ext.length + 1));
        if (isSafeSlug(slug)) slugs.add(slug);
      }
      return [...slugs].sort();
    },

    // Best-effort, and the caller must treat it that way: losing an icon is a
    // cosmetic outcome and must never fail a service save. Never called from
    // the polling path — the sweep interval must not become a favicon crawl.
    async refreshFavicon(svc) {
      if (!svc?.id || !svc?.url) return { ok: false, reason: 'no url' };
      let candidates = [];
      let origin;
      try { origin = new URL(svc.url).origin; } catch { return { ok: false, reason: 'invalid url' }; }
      try {
        const page = await get(svc.url);
        if (page.contentType.startsWith('text/html')) {
          candidates = parseIconLinks(page.body.subarray(0, HTML_PREFIX_BYTES).toString('utf8'), page.url);
        }
      } catch { /* the page is optional; /favicon.ico may still answer */ }
      candidates.push(`${origin}/favicon.ico`);

      let lastReason = 'no icon found';
      for (const url of candidates) {
        let res;
        try { res = await get(url); } catch (e) { lastReason = e.message; continue; }
        if (res.status !== 200) { lastReason = `HTTP ${res.status}`; continue; }
        const ext = EXT_FOR_TYPE[res.contentType];
        if (!ext) { lastReason = `unsupported content type ${res.contentType || 'absent'}`; continue; }
        if (!res.body.length) { lastReason = 'empty response'; continue; }
        const dest = safeJoin(cacheDir, `${svc.id}.${ext}`);
        if (!dest) return { ok: false, reason: 'unsafe cache path' };
        // One service holds at most one cached icon; a kind change that swaps
        // the extension must not leave the old file to win the CACHE_EXTS scan.
        await forget(svc.id);
        const tmp = `${dest}.part`;
        try {
          await fs.mkdir(cacheDir, { recursive: true });
          await fs.writeFile(tmp, res.body, { mode: 0o600 });
          fsSync.renameSync(tmp, dest);
        } catch (e) {
          try { fsSync.unlinkSync(tmp); } catch { /* nothing to clean */ }
          return { ok: false, reason: e.message };
        }
        return { ok: true };
      }
      return { ok: false, reason: lastReason };
    },
  };
}
