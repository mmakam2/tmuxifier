import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSafeSlug, slugCandidates } from './iconResolve.js';
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
  };
}
