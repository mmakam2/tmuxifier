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
