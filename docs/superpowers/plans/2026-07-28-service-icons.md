# Service Tile Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the free-form Nerd Font `glyph` field from service records and replace it with an automatically resolved logo — a vendored SVG from a pinned catalog, or the service's own scraped favicon — rendered on plain tiles and on the wide `pihole`/`truenas`/`unifi` cards alike.

**Architecture:** A pure resolution module (`iconResolve.js`) turns a service record into an ordered list of candidate slugs; a factory (`iconStore.js`) walks those candidates against a vendored catalog directory and a scraped-favicon cache directory and returns bytes; two authenticated routes serve them. The web client renders every icon through an `<img>` that hides itself on error, so an unresolvable icon degrades silently to today's appearance.

**Tech Stack:** Node 20+ ESM, Fastify, `node:http`/`node:https` (no fetch — the favicon scrape needs `rejectUnauthorized: false`), vitest, TypeScript + Vite for the web client.

**Spec:** `docs/superpowers/specs/2026-07-28-service-icons-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+. Server is plain `.js`; web client is `.ts`.
- TDD: the failing test is written and **run** before the implementation. Tests use real code, not mocks — real temp directories, real loopback HTTP servers.
- Vitest runs `environment: 'node'`. **There is no DOM.** Never write a test that renders DOM; the card and tile DOM layers are verified by their pure model functions and by live validation.
- Modules are factory functions with dependencies injected as arguments (`createIconStore({ ... })`), following `createServicesStore` / `createStatusChecker`.
- The repo is **public**. Committed code, tests and docs use placeholders only — `example.com`, RFC1918 addresses like `192.168.1.10`, `you@example.com`. Never a real domain, hostname, public IP or email.
- Conventional-commit messages (`feat(icons): …`, `refactor(services): …`).
- The icon slug regex is exactly `/^[a-z0-9][a-z0-9-]{0,63}$/`, named `ICON_SLUG`.
- The catalog CDN base is exactly `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/`.
- Icons are **always** rendered through `<img src>` and **never** inlined into the DOM. This is the XSS mitigation, not a style preference.
- `data/` and `vendor/` are already in `.gitignore`; `data/icons/` and `vendor/icons/` need no new ignore rules.
- Run `npm test` (typecheck + vitest) before every commit.

## File Structure

**Create — server**
- `src/server/iconResolve.js` — pure: `ICON_SLUG`, `isSafeSlug`, `normalizeSlug`, `hostLabel`, `slugCandidates`, `parseIconLinks`. No I/O, no state.
- `src/server/iconCatalog.js` — the pinned slug list and `iconUrl(slug)`. The chokepoint: no user-supplied string ever reaches a download.
- `src/server/iconStore.js` — the I/O layer: `resolve`, `listCatalog`, `readCatalogIcon`, `refreshFavicon`, `forget`.

**Create — scripts**
- `scripts/fetch-icons.mjs` — `npm run fetch-icons`, populating `vendor/icons/`.

**Create — web**
- `src/web/serviceIcon.ts` — the one `<img>` builder used by tiles, cards and the settings list.

**Create — tests**
- `test/iconResolve.test.js`, `test/iconCatalog.test.js`, `test/iconStore.test.js`

**Modify**
- `src/server/servicesStore.js` — `glyph` out, `icon` in.
- `src/server/server.js` — three routes, the delete hook, the best-effort refresh on add/update.
- `src/server/index.js` — construct and wire `iconStore`.
- `src/web/api.ts`, `dashboard.ts`, `truenasCard.ts`, `unifiCard.ts`, `settingsServices.ts`, `style.css`
- `test/servicesStore.test.js`, `test/serviceRoutes.test.js`, `test/settingsServices.test.js`
- `package.json`, `CLAUDE.md`, `AGENTS.md`, `README.md`

**Two refinements to the spec, made deliberately here:**
1. `resolve()` returns `{ bytes, contentType, etag }` rather than the spec's `{ path, contentType, etag }`. The route needs the content to compute the ETag anyway, so returning a path would mean reading the file twice.
2. A third route, `GET /api/icons/:slug`, is added. The spec listed only `GET /api/icons` (the slug list), but the Settings picker has to *preview* each catalog entry, and under `img-src 'self'` those previews must come from Tmuxifier.

---

### Task 1: Pure slug resolution

**Files:**
- Create: `src/server/iconResolve.js`
- Test: `test/iconResolve.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ICON_SLUG: RegExp`
  - `isSafeSlug(value: unknown) => boolean`
  - `normalizeSlug(raw: unknown) => string` — `''` when unusable
  - `hostLabel(url: string) => string` — `''` for IP literals and unparseable URLs
  - `slugCandidates(svc: { name, url, check }) => string[]` — ordered, deduped
  - `parseIconLinks(html: string, baseUrl: string) => string[]` — absolute URLs, best first

- [ ] **Step 1: Write the failing test**

Create `test/iconResolve.test.js`:

```js
import { test, expect } from 'vitest';
import { isSafeSlug, normalizeSlug, hostLabel, slugCandidates, parseIconLinks } from '../src/server/iconResolve.js';

test('isSafeSlug accepts lowercase slugs and refuses everything that could escape a directory', () => {
  expect(isSafeSlug('unifi')).toBe(true);
  expect(isSafeSlug('pi-hole')).toBe(true);
  expect(isSafeSlug('a')).toBe(true);
  expect(isSafeSlug('none')).toBe(true);
  for (const bad of ['', '../etc/passwd', '/abs', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', 'sp ace', 'uni.fi', 'ünifi', 'a'.repeat(65), null, undefined, 42, {}]) {
    expect(isSafeSlug(bad)).toBe(false);
  }
});

test('normalizeSlug lowercases, collapses punctuation to single hyphens, and trims', () => {
  expect(normalizeSlug('Grafana')).toBe('grafana');
  expect(normalizeSlug('Home Assistant')).toBe('home-assistant');
  expect(normalizeSlug('  Nginx__Proxy  Manager ')).toBe('nginx-proxy-manager');
  expect(normalizeSlug('Pi-Hole!')).toBe('pi-hole');
  expect(normalizeSlug('   ')).toBe('');
  expect(normalizeSlug('!!!')).toBe('');
  expect(normalizeSlug(null)).toBe('');
});

test('hostLabel takes the first label and refuses IP literals', () => {
  expect(hostLabel('https://jellyfin.example.com/')).toBe('jellyfin');
  expect(hostLabel('http://grafana.example.com:3000/d/abc')).toBe('grafana');
  expect(hostLabel('https://192.168.1.10:8006/')).toBe('');
  expect(hostLabel('http://[2001:db8::1]/')).toBe('');
  expect(hostLabel('not a url')).toBe('');
});

test('slugCandidates leads with the check kind, then the name, then the hostname', () => {
  expect(slugCandidates({ name: 'Controller', url: 'https://unifi.example.com/', check: { kind: 'unifi' } }))
    .toEqual(['unifi', 'controller']);
  expect(slugCandidates({ name: 'Blocky', url: 'https://dns.example.com/', check: { kind: 'pihole' } }))
    .toEqual(['pi-hole', 'blocky', 'dns']);
  expect(slugCandidates({ name: 'Media Box', url: 'https://jellyfin.example.com/', check: { kind: 'http' } }))
    .toEqual(['media-box', 'jellyfin']);
});

test('slugCandidates dedupes and drops candidates that cannot be slugs', () => {
  expect(slugCandidates({ name: 'Grafana', url: 'https://grafana.example.com/', check: { kind: 'http' } }))
    .toEqual(['grafana']);
  expect(slugCandidates({ name: '!!!', url: 'https://192.168.1.10/', check: { kind: 'none' } }))
    .toEqual([]);
  expect(slugCandidates({ name: 'NAS', url: 'https://192.168.1.20/', check: { kind: 'truenas' } }))
    .toEqual(['truenas', 'nas']);
});

test('parseIconLinks prefers SVG, then the largest declared size, and resolves relative hrefs', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="touch.png" sizes="180x180">
    <link rel="icon" type="image/svg+xml" href="https://cdn.example.com/logo.svg">
  </head></html>`;
  expect(parseIconLinks(html, 'https://app.example.com/dash/')).toEqual([
    'https://cdn.example.com/logo.svg',
    'https://app.example.com/dash/touch.png',
    'https://app.example.com/favicon-32.png',
  ]);
});

test('parseIconLinks ignores non-icon links and non-http schemes', () => {
  const html = `<link rel="canonical" href="/x"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AA">`;
  expect(parseIconLinks(html, 'https://app.example.com/')).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/iconResolve.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/iconResolve.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/iconResolve.js`:

```js
// Pure resolution logic for service icons: turning a service record into the
// ordered list of catalog slugs worth trying, and turning a page of HTML into
// the favicon URLs worth fetching. No I/O and no state, so iconStore.js can be
// the only module that touches disk or the network.

// The slug is a path component, so this regex is a security boundary rather
// than input hygiene. iconStore re-checks it and additionally verifies the
// resolved path stays inside its directory — belt and braces, because the
// containment check is what stays correct if this regex is ever relaxed.
export const ICON_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeSlug(value) {
  return typeof value === 'string' && ICON_SLUG.test(value);
}

// The check kind is the one identification that is declared rather than
// guessed: the user chose the software when they chose the check.
const KIND_SLUGS = { unifi: 'unifi', truenas: 'truenas', pihole: 'pi-hole' };

export function normalizeSlug(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ICON_SLUG.test(s) ? s : '';
}

// An address is not a product name. `192.168.1.10` would normalize to the
// perfectly valid slug `192-168-1-10` and then miss every catalog entry, so it
// is dropped here rather than wasting a lookup.
export function hostLabel(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname;
  if (!host || host.startsWith('[') || /^[0-9.]+$/.test(host)) return '';
  return normalizeSlug(host.split('.')[0]);
}

export function slugCandidates(svc) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  push(KIND_SLUGS[svc?.check?.kind]);
  push(normalizeSlug(svc?.name));
  push(hostLabel(svc?.url ?? ''));
  return out;
}

const LINK_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

// Deliberately a scan rather than a parser: this reads at most the first chunk
// of a page purely to find icon declarations, and pulling in an HTML parser to
// do it would be a dependency for one regex's worth of work.
export function parseIconLinks(html, baseUrl) {
  const found = [];
  for (const tag of String(html).match(LINK_RE) ?? []) {
    const attrs = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag)) !== null) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
    if (!/\bicon\b/.test((attrs.rel || '').toLowerCase())) continue;
    if (!attrs.href) continue;
    let abs;
    try { abs = new URL(attrs.href, baseUrl); } catch { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    const svg = attrs.type === 'image/svg+xml' || /\.svg(\?|$)/i.test(abs.pathname);
    const sizes = String(attrs.sizes || '').split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite);
    found.push({ url: abs.href, svg, size: sizes.length ? Math.max(...sizes) : 0 });
  }
  // Array.prototype.sort is stable, so ties keep document order.
  found.sort((a, b) => (b.svg ? 1 : 0) - (a.svg ? 1 : 0) || b.size - a.size);
  return found.map((x) => x.url);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/iconResolve.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/iconResolve.js test/iconResolve.test.js
git commit -m "feat(icons): pure slug candidates and favicon link parsing"
```

---

### Task 2: Data model — `glyph` out, `icon` in

**Files:**
- Modify: `src/server/servicesStore.js:179-180` (the glyph lines), `:143-146` (`redact`)
- Test: `test/servicesStore.test.js`

**Interfaces:**
- Consumes: `isSafeSlug` from Task 1.
- Produces: a service record carrying optional `icon: string` and never `glyph`.

- [ ] **Step 1: Write the failing test**

In `test/servicesStore.test.js`, change the shared fixture at the top — it currently carries a `glyph` key:

```js
const spec = { name: 'Grafana', url: 'https://192.168.1.20:3000/', group: 'Monitoring' };
```

Then append these tests:

```js
test('icon accepts a slug, clears with null, and refuses anything that is not one', async () => {
  const svc = await store.addService({ ...spec, icon: 'grafana' });
  expect(svc.icon).toBe('grafana');
  const cleared = await store.updateService(svc.id, { icon: null });
  expect(cleared.icon).toBeUndefined();
  await expect(store.addService({ ...spec, icon: '../etc/passwd' })).rejects.toThrow(/icon/);
  await expect(store.addService({ ...spec, icon: 'Grafana' })).rejects.toThrow(/icon/);
  await expect(store.addService({ ...spec, icon: 'a'.repeat(65) })).rejects.toThrow(/icon/);
});

test('icon "none" is a storable value — it means suppress, not clear', async () => {
  const svc = await store.addService({ ...spec, icon: 'none' });
  expect(svc.icon).toBe('none');
});

test('glyph is neither accepted nor returned, and a legacy stored glyph is hidden', async () => {
  const svc = await store.addService({ ...spec, glyph: '' });
  expect(svc.glyph).toBeUndefined();

  // Simulate a record written before this change by editing the file directly.
  const file = path.join(dir, 'services.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.services[0].glyph = '';
  await fs.writeFile(file, JSON.stringify(raw));

  const [listed] = await store.listServices();
  expect(listed.glyph).toBeUndefined();
  expect(listed.name).toBe('Grafana');
});
```

Also update every other occurrence of `glyph` in this file — search for it and delete the key from each fixture. `git grep -n glyph test/servicesStore.test.js` must return nothing but the test above.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — `icon` is not persisted (`expect(svc.icon).toBe('grafana')` receives `undefined`), and the legacy-glyph test fails because `redact` still spreads it through.

- [ ] **Step 3: Write the implementation**

In `src/server/servicesStore.js`, add the import at the top alongside the existing ones:

```js
import { isSafeSlug } from './iconResolve.js';
```

Replace `redact` (currently at `:143`) so it strips the legacy field in the same destructure that strips the secret:

```js
  // `glyph` is the removed Nerd Font field. Dropping it here rather than
  // migrating the file means no rewrite pass: normalize() already builds its
  // output fresh, so a legacy key disappears from disk on that record's next
  // update, and never reaches the browser in the meantime.
  function redact(svc) {
    const { secret, glyph, ...rest } = svc;
    return { ...rest, hasPassword: !!secret };
  }
```

Replace the two glyph lines in `normalize` (currently at `:179-180`) with:

```js
    // A catalog slug, or the reserved value 'none' meaning "render no icon".
    // Absent means resolve automatically. The slug becomes a path component in
    // iconStore, so it is constrained here rather than at the point of use.
    const icon = optionalString(spec.icon, base.icon, { label: 'icon', max: 64 });
    if (icon !== undefined) {
      if (!isSafeSlug(icon)) throw new Error('icon must be a lowercase slug (a-z, 0-9 and hyphens)');
      out.icon = icon;
    }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/servicesStore.test.js`
Expected: PASS.

Run: `npm test`
Expected: the web tests now FAIL on `glyph` — `test/settingsServices.test.js` still passes a `glyph` key and `tsc` still sees `Service.glyph`. That is correct and is fixed in Tasks 7 and 8; do not chase it here.

- [ ] **Step 5: Commit**

```bash
git add src/server/servicesStore.js test/servicesStore.test.js
git commit -m "refactor(services): replace the glyph field with a validated icon slug"
```

---

### Task 3: Pinned catalog and the fetch script

**Files:**
- Create: `src/server/iconCatalog.js`, `scripts/fetch-icons.mjs`
- Modify: `package.json` (scripts block)
- Test: `test/iconCatalog.test.js`

**Interfaces:**
- Consumes: `ICON_SLUG` from Task 1.
- Produces:
  - `ICON_CDN: string`
  - `CATALOG_SLUGS: string[]`
  - `iconUrl(slug: string) => string | null`

- [ ] **Step 1: Write the failing test**

Create `test/iconCatalog.test.js`:

```js
import { test, expect } from 'vitest';
import { CATALOG_SLUGS, ICON_CDN, iconUrl } from '../src/server/iconCatalog.js';
import { ICON_SLUG } from '../src/server/iconResolve.js';

test('every catalog slug is a valid slug and appears once', () => {
  for (const slug of CATALOG_SLUGS) expect(slug).toMatch(ICON_SLUG);
  expect(new Set(CATALOG_SLUGS).size).toBe(CATALOG_SLUGS.length);
});

test('the catalog covers the four check kinds and never reserves "none"', () => {
  for (const slug of ['unifi', 'truenas', 'pi-hole', 'proxmox']) expect(CATALOG_SLUGS).toContain(slug);
  expect(CATALOG_SLUGS).not.toContain('none');
});

test('iconUrl is a closed allowlist, not a URL builder', () => {
  expect(iconUrl('proxmox')).toBe(`${ICON_CDN}proxmox.svg`);
  for (const bad of ['../../etc/passwd', 'not-in-the-catalog', 'constructor', 'toString', '', null, undefined]) {
    expect(iconUrl(bad)).toBe(null);
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/iconCatalog.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/iconCatalog.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/iconCatalog.js`:

```js
// The pinned slug list, playing exactly the role voiceCatalog.js plays for
// speech models: the single chokepoint guaranteeing no user-supplied string
// ever reaches a download. fetch-icons iterates this list and nothing else —
// there is no "fetch an arbitrary slug" path from the CLI or from the API.
//
// Unlike voiceCatalog.js there are deliberately no pinned digests. A speech
// model is a fixed artifact whose hash is the correctness guarantee; a logo is
// redesigned by its vendor from time to time, and pinning would turn every
// upstream refresh into a failed run demanding a commit to fix. The guarantees
// kept instead are this list, a content-type check, a size cap, and the rule
// that icons are only ever rendered through <img> (which makes SVG inert).

export const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

export const CATALOG_SLUGS = [
  // The four check kinds and this project's own integrations.
  'unifi', 'truenas', 'pi-hole', 'proxmox', 'netbox',
  // Observability.
  'grafana', 'prometheus', 'influxdb', 'uptime-kuma', 'netdata', 'zabbix', 'graylog',
  // Home and media.
  'home-assistant', 'jellyfin', 'plex', 'emby', 'navidrome', 'audiobookshelf',
  'immich', 'photoprism', 'frigate', 'esphome', 'zigbee2mqtt', 'mosquitto', 'node-red',
  // Media automation.
  'sonarr', 'radarr', 'prowlarr', 'bazarr', 'jellyseerr', 'overseerr',
  'qbittorrent', 'transmission', 'sabnzbd',
  // Files, docs and backup.
  'nextcloud', 'seafile', 'filebrowser', 'paperless-ngx', 'syncthing', 'duplicati', 'mealie',
  // Networking and access.
  'traefik', 'nginx-proxy-manager', 'caddy', 'pfsense', 'opnsense', 'openwrt',
  'mikrotik', 'wireguard', 'tailscale', 'guacamole', 'authentik', 'authelia',
  // Platform and development.
  'portainer', 'docker', 'kubernetes', 'rancher', 'gitea', 'forgejo', 'gitlab',
  'jenkins', 'minio', 'n8n', 'ollama', 'open-webui',
  // Storage appliances and other dashboards.
  'synology', 'unraid', 'homarr', 'homepage', 'dashy',
  // Secrets, wikis and utilities.
  'vaultwarden', 'bitwarden', 'wikijs', 'bookstack', 'stirling-pdf', 'it-tools',
  'vikunja', 'firefly-iii', 'actual-budget', 'watchtower', 'speedtest-tracker',
  'adguard-home',
];

const SLUG_SET = new Set(CATALOG_SLUGS);

// Set membership rather than object indexing: a bare object lookup would
// resolve 'constructor' and 'toString' to Object.prototype members, the same
// trap voiceCatalog.js guards against with hasOwnProperty.
export function iconUrl(slug) {
  if (typeof slug !== 'string' || !SLUG_SET.has(slug)) return null;
  return `${ICON_CDN}${slug}.svg`;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/iconCatalog.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the fetch script**

Create `scripts/fetch-icons.mjs`:

```js
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
import { CATALOG_SLUGS, iconUrl } from '../src/server/iconCatalog.js';

const MAX_BYTES = 256 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'vendor', 'icons');
const force = process.argv.includes('--force');

fs.mkdirSync(outDir, { recursive: true });

let fetched = 0;
let skipped = 0;
const missing = [];

for (const slug of CATALOG_SLUGS) {
  const dest = path.join(outDir, `${slug}.svg`);
  if (!force && fs.existsSync(dest)) { skipped += 1; continue; }
  const url = iconUrl(slug);
  try {
    const res = await fetch(url);
    if (!res.ok) { missing.push(`${slug} (HTTP ${res.status})`); continue; }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (type !== 'image/svg+xml') { missing.push(`${slug} (content-type ${type || 'absent'})`); continue; }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) { missing.push(`${slug} (${body.length} bytes exceeds the cap)`); continue; }
    // Temp then rename, so an interrupted run never leaves a truncated icon
    // that the server would later serve as a valid one.
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
    fetched += 1;
    process.stderr.write(`  ${slug}\n`);
  } catch (e) {
    missing.push(`${slug} (${e.message})`);
  }
}

console.error(`\nfetched ${fetched}, skipped ${skipped} already present, missing ${missing.length}`);
if (missing.length) {
  console.error('Missing (the catalog entry is wrong, or upstream renamed it):');
  for (const m of missing) console.error(`  - ${m}`);
}
console.error(`\nIcons in ${path.relative(repoRoot, outDir)}/`);
```

Add to the `"scripts"` block in `package.json`, after `"setup-voice"`:

```json
    "fetch-icons": "node scripts/fetch-icons.mjs"
```

- [ ] **Step 6: Run the script and fix any catalog slug it reports missing**

Run: `npm run fetch-icons`
Expected: `fetched 78, skipped 0 already present, missing 0`.

**If any slug is reported missing, that catalog entry is wrong — correct or delete it in `iconCatalog.js` now.** A dead slug is not harmless: it would ship as an entry the Settings picker offers and that renders nothing. Re-run until `missing 0`.

Verify the bytes landed and nothing became a git-tracked file:

```bash
ls vendor/icons | wc -l
git status --porcelain vendor/   # must be empty: vendor/ is gitignored
```

- [ ] **Step 7: Commit**

```bash
git add src/server/iconCatalog.js scripts/fetch-icons.mjs package.json test/iconCatalog.test.js
git commit -m "feat(icons): pinned icon catalog and the fetch-icons script"
```

---

### Task 4: Icon store — catalog and cache resolution

**Files:**
- Create: `src/server/iconStore.js`
- Test: `test/iconStore.test.js`

**Interfaces:**
- Consumes: `slugCandidates`, `isSafeSlug` from Task 1.
- Produces:
  - `createIconStore({ catalogDir, cacheDir }) => store`
  - `store.resolve(svc) => Promise<{ bytes: Buffer, contentType: string, etag: string } | null>`
  - `store.listCatalog() => Promise<string[]>` — sorted
  - `store.readCatalogIcon(slug) => Promise<{ bytes, contentType, etag } | null>`
  - `store.forget(serviceId) => Promise<void>`
  - `store.refreshFavicon(svc)` arrives in Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/iconStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
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
const putCatalog = (slug, body = '<svg/>') => fs.writeFile(path.join(catalogDir, `${slug}.svg`), body);
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

test('listCatalog reports the slugs on disk, sorted, without extensions', async () => {
  await putCatalog('unifi');
  await putCatalog('grafana');
  await fs.writeFile(path.join(catalogDir, 'notes.txt'), 'ignored');
  expect(await store.listCatalog()).toEqual(['grafana', 'unifi']);
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/iconStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/iconStore.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/iconStore.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSafeSlug, slugCandidates } from './iconResolve.js';

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
  async function readCatalogIcon(slug) {
    if (!isSafeSlug(slug)) return null;
    return readIcon(safeJoin(catalogDir, `${slug}.svg`));
  }

  // A local function rather than a method, because refreshFavicon (Task 5)
  // calls it. Reaching it through `this` would break the moment a caller
  // destructured the store, which is a normal thing to do to a factory result.
  async function forget(serviceId) {
    for (const ext of CACHE_EXTS) {
      const file = safeJoin(cacheDir, `${serviceId}.${ext}`);
      if (!file) continue;
      try { await fs.unlink(file); } catch { /* already gone */ }
    }
  }

  async function readCached(serviceId) {
    if (typeof serviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(serviceId)) return null;
    for (const ext of CACHE_EXTS) {
      const hit = await readIcon(safeJoin(cacheDir, `${serviceId}.${ext}`));
      if (hit) return hit;
    }
    return null;
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
      return names.filter((n) => n.endsWith('.svg')).map((n) => n.slice(0, -4)).filter(isSafeSlug).sort();
    },
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/iconStore.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/iconStore.js test/iconStore.test.js
git commit -m "feat(icons): catalog and favicon-cache resolution with path containment"
```

---

### Task 5: Favicon scrape

**Files:**
- Modify: `src/server/iconStore.js` (add `refreshFavicon` and the HTTP helper)
- Test: `test/iconStore.test.js` (append)

**Interfaces:**
- Consumes: `parseIconLinks` from Task 1; `createIconStore` from Task 4.
- Produces: `store.refreshFavicon(svc) => Promise<{ ok: boolean, reason?: string }>`

- [ ] **Step 1: Write the failing test**

Append to `test/iconStore.test.js` (and add `import http from 'node:http';` at the top):

```js
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
    res.setHeader('content-type', req.url === '/favicon.ico' ? 'text/html' : 'text/html');
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

test('refreshFavicon reports a failure rather than throwing when the host is unreachable', async () => {
  const r = await store.refreshFavicon(svc({ url: 'http://127.0.0.1:1/' }));
  expect(r.ok).toBe(false);
  expect(typeof r.reason).toBe('string');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/iconStore.test.js`
Expected: FAIL — `store.refreshFavicon is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/server/iconStore.js`, extend the imports:

```js
import fsSync from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isSafeSlug, slugCandidates, parseIconLinks } from './iconResolve.js';
```

Add these constants beside `CACHE_EXTS`:

```js
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
```

Add the HTTP helper above `createIconStore`:

```js
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
```

Add `refreshFavicon` inside the returned object, after `forget`:

```js
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
```

Note the `res.destroy(new Error('response too large'))` in `get` surfaces as the request's `error` event, so the `too large` reason reaches the caller.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/iconStore.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/iconStore.js test/iconStore.test.js
git commit -m "feat(icons): best-effort favicon scrape with a size cap and redirect limit"
```

---

### Task 6: Routes and server wiring

**Files:**
- Modify: `src/server/server.js:788-801` (the services routes), `src/server/index.js:268-277`
- Test: `test/serviceRoutes.test.js`

**Interfaces:**
- Consumes: `createIconStore` from Tasks 4-5.
- Produces:
  - `GET /api/services/:id/icon` → bytes, or 404
  - `POST /api/services/:id/icon/refresh` → `{ ok, reason? }`
  - `GET /api/icons` → `{ slugs: string[] }`
  - `GET /api/icons/:slug` → catalog SVG bytes, or 404
  - `buildServer({ ..., iconStore })` — optional, defaulting to a null object

- [ ] **Step 1: Write the failing test**

Append to `test/serviceRoutes.test.js`. Add `import { createIconStore } from '../src/server/iconStore.js';` at the top, and inside `beforeEach` create the directories and pass the store into `buildServer`:

```js
  // added inside beforeEach, before buildServer:
  const catalogDir = path.join(dir, 'catalog');
  await fs.mkdir(catalogDir, { recursive: true });
  await fs.writeFile(path.join(catalogDir, 'unifi.svg'), '<svg id="unifi"/>');
  iconStore = createIconStore({ catalogDir, cacheDir: path.join(dir, 'icons') });
```

Declare `let iconStore;` beside the other module-scope lets, and add `iconStore,` to the `buildServer({ ... })` argument object.

Then append these tests:

```js
test('icon routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/icons' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/icons/unifi' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/services/svc-x/icon' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/services/svc-x/icon/refresh' })).statusCode).toBe(401);
});

test('GET /api/icons lists the catalog slugs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/icons', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ slugs: ['unifi'] });
});

test('GET /api/icons/:slug serves a catalog icon and refuses a traversal', async () => {
  const h = await headers();
  const ok = await app.inject({ method: 'GET', url: '/api/icons/unifi', headers: h });
  expect(ok.statusCode).toBe(200);
  expect(ok.headers['content-type']).toMatch(/image\/svg\+xml/);
  expect(ok.body).toBe('<svg id="unifi"/>');
  expect((await app.inject({ method: 'GET', url: '/api/icons/grafana', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/icons/..%2Funifi', headers: h })).statusCode).toBe(404);
});

test('a service icon resolves from the catalog, revalidates, and 304s on a matching ETag', async () => {
  const h = await headers();
  const svc = (await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'Controller', url: 'https://unifi.example.com/', check: { kind: 'unifi', tls: 'verify' } },
  })).json();

  const res = await app.inject({ method: 'GET', url: `/api/services/${svc.id}/icon`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
  expect(res.headers['cache-control']).toBe('private, no-cache');
  expect(res.body).toBe('<svg id="unifi"/>');

  const again = await app.inject({
    method: 'GET', url: `/api/services/${svc.id}/icon`,
    headers: { ...h, 'if-none-match': res.headers.etag },
  });
  expect(again.statusCode).toBe(304);
});

test('a service with no resolvable icon 404s, and an unknown service 404s', async () => {
  const h = await headers();
  const svc = (await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    // A port that refuses immediately, so the fire-and-forget favicon scrape
    // this POST kicks off cannot outlive the test on a 5s connect timeout.
    payload: { name: 'Notes', url: 'http://127.0.0.1:1/', check: { kind: 'none' } },
  })).json();
  expect((await app.inject({ method: 'GET', url: `/api/services/${svc.id}/icon`, headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/services/svc-nope/icon', headers: h })).statusCode).toBe(404);
});

test('creating a service succeeds even when its favicon host is unreachable', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'Dead', url: 'http://127.0.0.1:1/', check: { kind: 'none' } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().name).toBe('Dead');
});

test('removing a service forgets its cached icon', async () => {
  const h = await headers();
  const svc = (await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    // A port that refuses immediately, so the fire-and-forget favicon scrape
    // this POST kicks off cannot outlive the test on a 5s connect timeout.
    payload: { name: 'Notes', url: 'http://127.0.0.1:1/', check: { kind: 'none' } },
  })).json();
  await fs.mkdir(path.join(dir, 'icons'), { recursive: true });
  await fs.writeFile(path.join(dir, 'icons', `${svc.id}.png`), 'PNGDATA');
  expect((await app.inject({ method: 'GET', url: `/api/services/${svc.id}/icon`, headers: h })).statusCode).toBe(200);

  await app.inject({ method: 'DELETE', url: `/api/services/${svc.id}`, headers: h });
  expect(await fs.readdir(path.join(dir, 'icons'))).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL — the icon routes return 404 from the SPA/not-found path rather than 401/200.

- [ ] **Step 3: Write the implementation**

In `src/server/server.js`, add `iconStore` to the `buildServer` destructured arguments with a null-object default, so every existing caller and test that does not pass one keeps working and simply resolves no icons:

```js
  // Defaulted rather than required: a caller without an icon store (older
  // tests, embedders) gets a server whose icon routes honestly 404 instead of
  // one that throws.
  iconStore = {
    resolve: async () => null,
    listCatalog: async () => [],
    readCatalogIcon: async () => null,
    refreshFavicon: async () => ({ ok: false, reason: 'icons are not configured' }),
    forget: async () => {},
  },
```

Add a helper just above the services routes block (near `:788`):

```js
  // One sender for all three icon reads. Cache-Control is `no-cache`, which is
  // revalidate-every-load rather than don't-cache: the URL is stable while its
  // content is not — an icon changes under it when a favicon is refreshed or
  // the catalog is fetched — so a max-age would strand a stale logo for its
  // duration. Paired with the ETag, revalidation costs a 304.
  function sendIcon(req, reply, hit) {
    if (!hit) { reply.code(404); return { error: 'no icon' }; }
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('ETag', hit.etag);
    if (req.headers['if-none-match'] === hit.etag) { reply.code(304); return null; }
    reply.type(hit.contentType);
    return hit.bytes;
  }
```

Add the two catalog routes beside the other services routes:

```js
  app.get('/api/icons', { preHandler: requireAuth }, async () => ({ slugs: await iconStore.listCatalog() }));
  app.get('/api/icons/:slug', { preHandler: requireAuth }, async (req, reply) =>
    sendIcon(req, reply, await iconStore.readCatalogIcon(req.params.slug)));
```

Add the per-service routes after the existing `DELETE /api/services/:id`:

```js
  app.get('/api/services/:id/icon', { preHandler: requireAuth }, async (req, reply) => {
    const svc = await servicesStore.getService(req.params.id);
    if (!svc) { reply.code(404); return { error: 'not found' }; }
    return sendIcon(req, reply, await iconStore.resolve(svc));
  });
  app.post('/api/services/:id/icon/refresh', { preHandler: requireAuth }, async (req, reply) => {
    const svc = await servicesStore.getService(req.params.id);
    if (!svc) { reply.code(404); return { error: 'not found' }; }
    return iconStore.refreshFavicon(svc);
  });
```

Add the best-effort scrape to the add and update handlers. Deliberately **not** awaited: a slow or hung LAN host must not hold the save open, and a failure here is cosmetic.

```js
  // Scrape only when the catalog misses. A UniFi service already has a real
  // logo, and scraping the controller for a favicon nothing will render is
  // pure waste. Fire-and-forget with a swallowed rejection: the save has
  // already succeeded and an icon is not worth failing it over.
  function maybeScrapeIcon(svc) {
    void (async () => {
      if (await iconStore.resolve(svc)) return;
      await iconStore.refreshFavicon(svc);
    })().catch(() => {});
  }
```

Call it from both handlers:

```js
  app.post('/api/services', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const svc = await servicesStore.addService(req.body || {});
      maybeScrapeIcon(svc);
      return svc;
    } catch (e) { reply.code(400); return { error: e.message }; }
  });
  app.patch('/api/services/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const svc = await servicesStore.updateService(req.params.id, req.body || {});
      maybeScrapeIcon(svc);
      return svc;
    } catch (e) { reply.code(/not found/.test(e.message) ? 404 : 400); return { error: e.message }; }
  });
```

And extend the delete handler so a removed service leaves no bytes behind:

```js
  app.delete('/api/services/:id', { preHandler: requireAuth }, async (req) => {
    await servicesStore.removeService(req.params.id);
    await iconStore.forget(req.params.id);
    return { ok: true };
  });
```

In `src/server/index.js`, add the import beside the other server imports:

```js
import { createIconStore } from './iconStore.js';
```

Construct it after `servicesStore` (around `:268`) and pass it into `buildServer`:

```js
// vendor/icons/ is written once by `npm run fetch-icons`; data/icons/ is the
// per-service favicon cache the server fills itself. Separate directories so a
// catalog re-fetch and a favicon scrape can never disturb each other.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const iconStore = createIconStore({
  catalogDir: path.join(repoRoot, 'vendor', 'icons'),
  cacheDir: path.join(config.dataDir, 'icons'),
});
```

If `path` / `fileURLToPath` are already imported in `index.js` (they are — see the `dist` resolution at `:279`), reuse them rather than re-importing, and reuse an existing repo-root constant if one is already in scope.

Add `iconStore,` to the `buildServer({ ... })` argument object at `:277`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: PASS.

Run: `npx vitest run`
Expected: all server tests PASS. The web-side `settingsServices` test still fails on `glyph` — that is Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js test/serviceRoutes.test.js
git commit -m "feat(icons): serve service and catalog icons, scrape on save, forget on delete"
```

---

### Task 7: Web rendering — tiles and cards

**Files:**
- Create: `src/web/serviceIcon.ts`
- Modify: `src/web/api.ts:53-65`, `src/web/dashboard.ts:205,356-369,447-448`, `src/web/truenasCard.ts:120-136,138-150`, `src/web/unifiCard.ts:151-167,168-180`, `src/web/style.css:687,753-780`

**Interfaces:**
- Consumes: `GET /api/services/:id/icon` from Task 6.
- Produces: `buildServiceIcon() => { root: HTMLImageElement; update(svc: Service): void }`

- [ ] **Step 1: Write the module**

There is no failing-test step here: vitest runs `environment: 'node'` in this repo, so a DOM builder cannot be unit-tested. The gate for this task is `npm run typecheck` plus the live validation in Task 9 — the same treatment `truenasCard.ts` and `unifiCard.ts` already get.

Create `src/web/serviceIcon.ts`:

```ts
// The one icon element, shared by plain tiles, the three card layers and the
// settings list. Always an <img>, never inlined SVG: a browser loads SVG in an
// <img> in a restricted mode with scripting and external references disabled,
// which makes the content inert regardless of what the CDN or a LAN host
// served. Inlining it would put that markup in the app's own origin.
import type { Service } from './api';

export interface ServiceIconEls {
  root: HTMLImageElement;
  update(svc: Service): void;
}

export function buildServiceIcon(): ServiceIconEls {
  const root = document.createElement('img');
  root.className = 'dash-icon';
  root.alt = '';
  root.loading = 'lazy';
  // Hidden until it actually loads, so a service with no resolvable icon shows
  // nothing rather than a broken-image glyph. The server's 404 is the whole
  // signal — the client needs no pre-flight request and holds no copy of the
  // resolution state.
  root.hidden = true;
  root.addEventListener('load', () => { root.hidden = false; });
  root.addEventListener('error', () => { root.hidden = true; });

  let shown = '';
  function update(svc: Service): void {
    if (svc.id === shown) return; // a poll repaint must not retrigger the fetch
    shown = svc.id;
    root.hidden = true;
    root.src = `/api/services/${encodeURIComponent(svc.id)}/icon`;
  }

  return { root, update };
}
```

- [ ] **Step 2: Update the API types**

In `src/web/api.ts`, in the `Service` interface (`:53`) replace `glyph?: string;` with `icon?: string;`.

In the `ServiceSpec` type (`:60-65`) replace both `glyph` mentions with `icon`, keeping the existing comment's meaning:

```ts
// icon/group/password accept null: the server's PATCH merge treats null as
// "clear this field", while an absent key means "leave it alone".
export type ServiceSpec =
  Partial<Omit<Service, 'id' | 'createdAt' | 'icon' | 'group' | 'hasPassword'>>
  & { icon?: string | null; group?: string | null; password?: string | null };
```

- [ ] **Step 3: Update `dashboard.ts`**

Add the import beside the other feature-module imports:

```ts
import { buildServiceIcon, type ServiceIconEls } from './serviceIcon';
```

In the `Tile` interface (`:205`), replace `glyph: HTMLElement;` with `icon: ServiceIconEls;`.

In `makeTile()` (`:351-370`), delete the three `glyph` lines and build the icon into the **top** row instead:

```ts
  function makeTile(): Tile {
    const root = document.createElement('a');
    root.className = 'dash-tile';
    root.target = '_blank';
    root.rel = 'noopener';
    const icon = buildServiceIcon();
    const name = div('dash-tile-name');
    const lamp = document.createElement('span');
    lamp.className = 'dot';
    const latency = document.createElement('span');
    latency.className = 'dash-latency';
    const top = div('dash-tile-top');
    top.append(icon.root, lamp, name);
    const bottom = div('dash-tile-bottom');
    bottom.append(latency);
    root.append(top, bottom);
    return { root, icon, name, lamp, latency };
  }
```

In `paintTile()` (`:447-448`), replace the two glyph lines with:

```ts
    tile.icon.update(svc);
```

The Pi-hole card is built by `makeCard()` in this same file, so give it the icon too. Add `icon: ServiceIconEls;` to the `Card` interface, and in `makeCard()`:

```ts
    const icon = buildServiceIcon();
    ...
    const top = div('dash-tile-top');
    top.append(icon.root, lamp, name, chip);
    ...
    return { root, icon, name, lamp, chip, grid, error };
```

and in `paintPiholeCard()`, beside `card.name.textContent = svc.name;`:

```ts
    card.icon.update(svc);
```

- [ ] **Step 4: Update the two card modules**

In `src/web/truenasCard.ts`, add `import { buildServiceIcon } from './serviceIcon';` at the top. In `buildTruenasCard()` (`:120-135`) create the icon and prepend it to the top row:

```ts
  const icon = buildServiceIcon();
  ...
  const top = div('dash-tile-top');
  top.append(icon.root, lamp, name, chip);
```

and inside `update()`, beside `name.textContent = svc.name;`:

```ts
    icon.update(svc);
```

Make exactly the same two edits in `src/web/unifiCard.ts` (`buildUnifiCard`, `:151-167` and its `update`).

- [ ] **Step 5: Update the stylesheet**

In `src/web/style.css`, delete the `.dash-glyph` rule at `:687` and add in its place:

```css
/* Service logo. Fixed square so a tall or wide source cannot shift the row,
   and object-fit keeps the aspect ratio inside it. Hidden by serviceIcon.ts
   until it loads, so an unresolvable icon collapses to nothing. */
.dash-icon { width: 18px; height: 18px; flex: none; object-fit: contain; }
```

Delete the `.svc-glyph-palette`, `.svc-glyph-key`, `.svc-glyph-key:hover`, `.svc-glyph-key:active` and `.svc-glyph-input` rules (`:753-780`), including the per-glyph advance-width comment block above them — it exists only to explain a problem that no longer exists.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS for `dashboard.ts`, `truenasCard.ts`, `unifiCard.ts` and `serviceIcon.ts`. **`settingsServices.ts` will still fail** on `glyph` — that is Task 8, and is the only remaining error permitted at this point.

- [ ] **Step 7: Commit**

```bash
git add src/web/serviceIcon.ts src/web/api.ts src/web/dashboard.ts src/web/truenasCard.ts src/web/unifiCard.ts src/web/style.css
git commit -m "feat(icons): render service logos on tiles and cards"
```

---

### Task 8: Settings form — the icon control

**Files:**
- Modify: `src/web/settingsServices.ts` (whole file), `src/web/style.css` (append)
- Test: `test/settingsServices.test.js`

**Interfaces:**
- Consumes: `buildServiceIcon` from Task 7; `GET /api/icons`, `GET /api/icons/:slug`, `POST /api/services/:id/icon/refresh` from Task 6.
- Produces: `buildServicePayload({ ..., icon?: string })` — `undefined` for Auto, `'none'` for None, a slug for a pick.

- [ ] **Step 1: Write the failing test**

In `test/settingsServices.test.js`, remove every `glyph: ''` from the existing fixtures and change the two expectations that assert `glyph: null` to `icon: null`. Then append:

```js
test('buildServicePayload maps the three icon states', () => {
  const base = { name: 'Grafana', url: 'http://192.168.1.20:3000/', group: '', kind: 'http', target: '', section: 'services' };
  // Auto: absent from the form, cleared on the server, which is what "resolve
  // automatically" is stored as.
  expect(buildServicePayload(base).icon).toBe(null);
  expect(buildServicePayload({ ...base, icon: 'none' }).icon).toBe('none');
  expect(buildServicePayload({ ...base, icon: 'grafana' }).icon).toBe('grafana');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/settingsServices.test.js`
Expected: FAIL — `buildServicePayload` still emits `glyph` and the returned object has no `icon`.

- [ ] **Step 3: Update `buildServicePayload`**

In `src/web/settingsServices.ts`, delete the `GLYPHS` constant block (`:7-20`) entirely. Change the payload builder's parameter type and body:

```ts
export function buildServicePayload(f: {
  name: string; url: string; icon?: string; group: string;
  kind: ServiceCheckKind; target: string; section: ServiceSection;
  username?: string; password?: string; clearPassword?: boolean; insecure?: boolean;
  site?: string; tls?: UnifiTlsMode; fingerprint?: string;
}): ServiceSpec {
```

and in the returned `payload` object replace the glyph line with:

```ts
    // undefined (Auto) sends null, which the server's PATCH merge reads as
    // "clear this field" — and a cleared icon is exactly what resolve-
    // automatically is stored as.
    icon: f.icon ?? null,
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/settingsServices.test.js`
Expected: PASS.

- [ ] **Step 5: Build the icon control**

Still in `src/web/settingsServices.ts`. Add to the imports:

```ts
import { buildServiceIcon } from './serviceIcon';
```

Delete the `glyphIn` input (`:98`) and the `palette` block (`:110-111`). In their place, after the other input declarations, add:

```ts
  // Three states rather than a free-form field: Auto is the default and covers
  // the fleet without typing, Choose is the escape hatch when the guess is
  // wrong, and None suppresses. The catalog is fetched once per render.
  const iconRadios: Record<'auto' | 'pick' | 'none', { wrap: HTMLElement; input: HTMLInputElement }> = {
    auto: makeRadio('svc-icon', 'auto', 'Auto', true),
    pick: makeRadio('svc-icon', 'pick', 'Choose', false),
    none: makeRadio('svc-icon', 'none', 'None', false),
  };
  const iconMode = (): 'auto' | 'pick' | 'none' =>
    (Object.entries(iconRadios).find(([, r]) => r.input.checked)?.[0] as 'auto' | 'pick' | 'none') ?? 'auto';

  const iconFilter = el('input', { type: 'text', placeholder: 'filter icons', autocomplete: 'off' }) as HTMLInputElement;
  const iconGrid = el('div', { class: 'svc-icon-grid' });
  const iconPicker = el('div', { class: 'svc-icon-picker' }, [iconFilter, iconGrid]);
  const refreshBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Refresh icon']);
  let picked = '';
  let catalog: string[] = [];

  function paintIconGrid() {
    const q = iconFilter.value.trim().toLowerCase();
    const shown = catalog.filter((s) => !q || s.includes(q)).slice(0, 200);
    iconGrid.replaceChildren(...shown.map((slug) => {
      const img = el('img', { src: `/api/icons/${encodeURIComponent(slug)}`, alt: '', class: 'svc-icon-img' });
      const key = el('button', {
        type: 'button',
        class: `svc-icon-key${slug === picked ? ' selected' : ''}`,
        title: slug,
        onclick: () => { picked = slug; paintIconGrid(); },
      }, [img]);
      return key;
    }));
  }
  iconFilter.addEventListener('input', paintIconGrid);

  function syncIcon() {
    iconPicker.hidden = iconMode() !== 'pick';
  }
  for (const r of Object.values(iconRadios)) r.input.addEventListener('change', syncIcon);

  refreshBtn.addEventListener('click', async () => {
    if (!editing) { setStatus('Save the service first, then refresh its icon.', true); return; }
    setStatus('Fetching the favicon…');
    try {
      const r = await api.refreshServiceIcon(editing.id);
      setStatus(r.ok ? 'Icon updated.' : `No icon found: ${r.reason ?? 'unknown reason'}`, !r.ok);
      changed();
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });

  try { catalog = (await api.icons()).slugs; } catch { catalog = []; }
```

In `fillForm`, replace the `glyphIn.value = …` line with:

```ts
    picked = svc?.icon && svc.icon !== 'none' ? svc.icon : '';
    const mode = svc?.icon === 'none' ? 'none' : svc?.icon ? 'pick' : 'auto';
    for (const [key, r] of Object.entries(iconRadios)) r.input.checked = key === mode;
    iconFilter.value = '';
    paintIconGrid();
    syncIcon();
```

In the `saveBtn` click handler, replace `glyph: glyphIn.value,` with:

```ts
      icon: iconMode() === 'none' ? 'none' : iconMode() === 'pick' && picked ? picked : undefined,
```

In the list rows, replace the glyph-prefixed name span with a real icon element:

```ts
  const rows = services.map((svc) => {
    const icon = buildServiceIcon();
    icon.update(svc);
    return el('div', { class: 'svc-row' }, [
      icon.root,
      el('span', { class: 'svc-row-name' }, [svc.name]),
      el('span', { class: 'svc-row-group' }, [
        `${svc.section === 'infrastructure' ? 'Infrastructure' : 'Services'}${svc.group ? ` → ${svc.group}` : ''}`,
      ]),
      el('span', { class: 'svc-row-check' }, [svc.check.kind]),
      el('button', { type: 'button', class: 'pve-btn', onclick: () => fillForm(svc) }, ['Edit']),
      el('button', { type: 'button', class: 'pve-btn danger', onclick: () => confirmRemove(svc) }, ['Remove']),
    ]);
  });
```

In the `content.replaceChildren(...)` call, replace the `field('Glyph (optional)', glyphIn),` and `palette,` lines with:

```ts
      field('Icon', el('div', { class: 'svc-check-radios' }, [iconRadios.auto.wrap, iconRadios.pick.wrap, iconRadios.none.wrap])),
      iconPicker,
      el('div', { class: 'pve-inline' }, [refreshBtn]),
```

- [ ] **Step 6: Add the two API methods**

In `src/web/api.ts`, add to the `api` object beside the other service methods (`:216-220`), matching their `j<T>(await fetch(...))` convention exactly:

```ts
  async icons() { return j<{ slugs: string[] }>(await fetch('/api/icons')); },
  async refreshServiceIcon(id: string) {
    return j<{ ok: boolean; reason?: string }>(await fetch(`/api/services/${id}/icon/refresh`, { method: 'POST' }));
  },
```

- [ ] **Step 7: Add the picker styles**

Append to `src/web/style.css`, where the deleted `.svc-glyph-*` rules were:

```css
/* Icon picker: a scrolling grid of catalog logos. Capped in height so the
   settings form does not become a page-long scroll of icons. */
.svc-icon-picker { margin: 4px 0 8px; }
.svc-icon-grid {
  display: flex; flex-wrap: wrap; gap: 4px;
  max-height: 168px; overflow-y: auto;
  padding: 4px; border: 1px solid var(--line); border-radius: 4px;
}
.svc-icon-key {
  width: 34px; height: 34px; padding: 4px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
}
.svc-icon-key:hover { border-color: var(--line); }
.svc-icon-key.selected { border-color: var(--amber); }
.svc-icon-img { width: 24px; height: 24px; object-fit: contain; }
.svc-row .dash-icon { margin-right: 6px; }
```

If `--line` or `--amber` are not the variable names this stylesheet uses, read the `:root` block and substitute the real ones — do not invent variables.

- [ ] **Step 8: Verify the whole suite**

Run: `npm test`
Expected: PASS — typecheck clean and every vitest file green.

Run: `git grep -n glyph -- src test`
Expected: **no output.** Any remaining hit is a missed reference; remove it.

- [ ] **Step 9: Commit**

```bash
git add src/web/settingsServices.ts src/web/api.ts src/web/style.css test/settingsServices.test.js
git commit -m "feat(icons): icon picker in settings, replacing the glyph palette"
```

---

### Task 9: Documentation and live validation

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a validated branch ready for the shipping checklist.

- [ ] **Step 1: Update the two agent-facing docs**

`CLAUDE.md` and `AGENTS.md` are kept in sync — make each edit in both.

In the Commands block, after the `setup-voice` line:

```
npm run fetch-icons  # downloads the pinned service-logo catalog into vendor/icons/ (one-time; the server never contacts the CDN)
```

In the self-contained section's `vendor/` bullet, note that it also holds `vendor/icons/`, written by `npm run fetch-icons`. In the `data/` bullet, add `data/icons/` (the per-service scraped-favicon cache).

In the architecture module list, after the `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` entry, add:

```
- `iconResolve.js` / `iconCatalog.js` / `iconStore.js` — service tile icons, replacing the
  removed free-form Nerd Font `glyph` field. `iconResolve.js` is the pure half: the ordered
  slug candidates for a service (check kind first — `unifi`/`truenas`/`pihole` are declared
  rather than guessed — then name, then URL hostname) and the favicon `<link>` scan.
  `iconCatalog.js` is the pinned slug list and the chokepoint that keeps no user-supplied
  string from reaching a download, in the mold of `voiceCatalog.js` — but with no pinned
  digests, deliberately: a logo is redesigned by its vendor from time to time and pinning
  would turn every upstream refresh into a failed run. `iconStore.js` is the only half that
  touches disk or the network: it walks the candidates against `vendor/icons/` (the catalog)
  then `data/icons/` (the per-service favicon cache), and scrapes a favicon best-effort on
  save when the catalog misses. Every slug is re-checked against `ICON_SLUG` and the resolved
  path verified to stay inside its directory before any read. Icons are served by the
  authenticated `GET /api/services/:id/icon` and `GET /api/icons/:slug` — dynamic routes, not
  a second static mount, because `wildcard: false` registers static assets at boot and a
  favicon scraped afterwards would be unservable until restart.
```

In the web-client paragraph, add `serviceIcon.ts` (the single `<img>` builder shared by the tiles, the three cards and the settings list; always an `<img>` and never inlined SVG, which is what makes the content inert) and update the `settingsServices.ts` description: the Nerd Font starter glyph palette becomes an Auto/Choose/None icon control with a filterable catalog picker.

In the Security notes, add:

```
- Service icons are served from two directories the operator controls: `vendor/icons/`
  (written only by `npm run fetch-icons` from a pinned slug list) and `data/icons/` (favicons
  scraped from the LAN services the user configured). The slug is a path component, so it is
  validated against `ICON_SLUG` at the store and re-checked before every read, with the
  resolved path verified to stay inside its directory. Icons are always rendered through
  `<img>` and never inlined: a browser loads SVG in an `<img>` with scripting and external
  references disabled, which makes the content inert regardless of its source. The favicon
  scrape uses `rejectUnauthorized: false`, matching the `http`/`tcp` liveness checks and for
  the same reason — it sends no credential; the credentialed integrations keep verified TLS.
```

- [ ] **Step 2: Update `README.md`**

In the services/dashboard section, add a short paragraph: tiles resolve a logo automatically from the check kind, the service name, or the URL hostname; `npm run fetch-icons` downloads the catalog once into `vendor/icons/`; anything not in the catalog falls back to the service's own favicon; Settings → Services can override or suppress the icon per service.

- [ ] **Step 3: Verify the docs and the suite**

Run: `npm test`
Expected: PASS.

Run: `git grep -n -i glyph -- src test README.md CLAUDE.md AGENTS.md`
Expected: only the surviving legitimate uses — the terminal-font comments in `style.css` and `termFont.ts` about Nerd Font glyph rendering, and `DESIGN.md`'s icon-key vocabulary. **No `glyph` remaining in any services context.**

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs(icons): document the icon catalog, resolution order, and security posture"
```

- [ ] **Step 5: Validate on the live app**

This repo's standing rule: a feature is validated on the live app **before** it merges. This change touches the server, so the `rsync dist/` shortcut is not enough — the service must run the branch's server code.

First confirm nothing is mid-flight, because a restart would interrupt it:

```bash
curl -sk "$BASE/api/setup" ; curl -sk "$BASE/api/provision" ; curl -sk "$BASE/api/fleet"
```

None may show a `running` job. Then, from the branch checkout:

```bash
npm run fetch-icons
npm run build
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

Health-check the deployed bind address, deriving it from config rather than assuming loopback:

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"
```

Then hand these to the user to confirm in the browser:

1. The standby dashboard shows a UniFi logo on the UniFi card, a TrueNAS logo on the TrueNAS card, and the Pi-hole logo on all five Pi-hole cards.
2. Settings → Services → Edit on any service: the Icon control reads **Auto**; switching to **Choose** shows the filterable grid with logos rendering; picking one and saving changes the card.
3. Setting a service to **None** removes its icon; setting it back to **Auto** restores it.
4. **Refresh icon** on a service with no catalog match reports either success or a specific reason.
5. No console errors, and no CSP violation reports.

Do not merge until the user confirms. A failure is fixed on the branch and redeployed; rollback is `npm run build` from `main`.

- [ ] **Step 6: Ship**

Once the user confirms, run the release checklist in `CLAUDE.md` — `npm version patch`, rebuild, restart, health check, PII scrub of the staged diff, commit, tag, push, `gh release create`.

---

## Self-Review

**Spec coverage.** Data model → Task 2. Resolution order (`iconResolve.js`) → Task 1. Catalog and `fetch-icons` → Task 3. Serving, dynamic-route rationale, `no-cache` + ETag → Task 6. Favicon fallback with cap, allowlist, redirect limit, `rejectUnauthorized: false` → Task 5. Security posture: slug validation → Tasks 1-2, containment → Task 4, `<img>`-only rendering → Task 7. Web client: `serviceIcon.ts` → Task 7, `api.ts`/`dashboard.ts`/cards/`style.css` → Task 7, settings form → Task 8. Testing → distributed across Tasks 1-6 and 8. Docs → Task 9.

**Two deliberate refinements**, both stated in the File Structure section: `resolve()` returns bytes rather than a path (the route needs the content to compute the ETag), and `GET /api/icons/:slug` is added (the Settings picker must preview catalog entries, and under `img-src 'self'` those previews must come from Tmuxifier).

**One spec item intentionally not implemented as written.** The spec's `serviceIcon.ts` note says the Settings preview "busts its own URL with a counter query parameter". Task 8 instead re-renders the whole settings section after a refresh (`changed()` + the existing `rerender()` path), which remounts the list and its `<img>` elements — achieving the same visible result through machinery that already exists. Neither approach adds a cross-module invalidation signal, which was the point.
