#!/usr/bin/env node
// Populate the repo-local vendor/icons/ directory from the pinned catalog.
// Structural twin of scripts/setup-voice.mjs: everything lands under the repo
// folder, nothing in $HOME, and the running server never repeats this work —
// it reads the directory this leaves behind.
//
// Run: npm run fetch-icons [-- --force]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_EXTS, CATALOG_SLUGS, iconUrl } from '../src/server/iconCatalog.js';

const MAX_BYTES = 256 * 1024;
const TYPE_FOR_EXT = { svg: 'image/svg+xml', png: 'image/png' };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'vendor', 'icons');
const force = process.argv.includes('--force');

fs.mkdirSync(outDir, { recursive: true });

let fetched = 0;
let skipped = 0;
const missing = [];

for (const slug of CATALOG_SLUGS) {
  if (!force && CATALOG_EXTS.some((ext) => fs.existsSync(path.join(outDir, `${slug}.${ext}`)))) {
    skipped += 1;
    continue;
  }
  // SVG first, PNG only if upstream carries no vector for this app. A fifth of
  // the upstream collection is PNG-only, so stopping at the first 404 would
  // quietly drop real apps from the catalog.
  const reasons = [];
  let done = false;
  for (const ext of CATALOG_EXTS) {
    try {
      const res = await fetch(iconUrl(slug, ext));
      if (!res.ok) { reasons.push(`${ext} HTTP ${res.status}`); continue; }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (type !== TYPE_FOR_EXT[ext]) { reasons.push(`${ext} content-type ${type || 'absent'}`); continue; }
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) { reasons.push(`${ext} ${body.length} bytes exceeds the cap`); continue; }
      // Temp then rename, so an interrupted run never leaves a truncated icon
      // that the server would later serve as a valid one.
      const dest = path.join(outDir, `${slug}.${ext}`);
      const tmp = `${dest}.part`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dest);
      fetched += 1;
      process.stderr.write(`  ${slug}.${ext}\n`);
      done = true;
      break;
    } catch (e) {
      reasons.push(`${ext} ${e.message}`);
    }
  }
  if (!done) missing.push(`${slug} (${reasons.join('; ')})`);
}

console.error(`\nfetched ${fetched}, skipped ${skipped} already present, missing ${missing.length}`);
if (missing.length) {
  console.error('Missing (the catalog entry is wrong, or upstream renamed it):');
  for (const m of missing) console.error(`  - ${m}`);
}
console.error(`\nIcons in ${path.relative(repoRoot, outDir)}/`);
