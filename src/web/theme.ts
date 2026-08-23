// src/web/theme.ts
// The DOM half of the themes engine (themes.ts is the pure catalog). Applies
// a theme by stamping data-theme on <html> — :root[data-theme] token blocks
// in themes/*.css do the rest — mirrors the choice into localStorage so
// public/theme-boot.js can paint the login screen pre-auth on the next visit,
// and notifies subscribers (open terminals re-resolve their xterm theme).
//
// Theme CSS side-effect imports live HERE, not in themes.ts: node tests
// import the manifest, and they must never pull CSS through vitest.
import './themes/original.css';
import './themes/vercel.css';
import { DEFAULT_THEME_ID, normalizeThemeId } from './themes';
import logoDefault from './assets/tmuxifier-logo.png';
import logoOriginal from './assets/tmuxifier-logo-original.png';
import logoVercel from './assets/tmuxifier-logo-vercel.png';

const KEY = 'tmuxifier.theme';
const listeners = new Set<() => void>();

// The mark is a raster no token can reach, so each theme's variant is a real
// asset — NOT a CSS filter. A filter paints the element's whole box, so the
// hue-rotate that recolored Original's mark rotated the token-colored
// `border: 1px solid var(--border)` with it: navy #202938 came out #352524, a
// warm rim around a cool logo. tmuxifier-logo-original.png is the default mark
// put through that exact matrix once (hue-rotate(134deg) saturate(0.75), via
// Chromium canvas), so the swap is pixel-equivalent to the filter it replaces
// while the chrome around it stays on its tokens. One asset covers the
// on-screen marks and the <link rel=icon> favicon — which a filter could never
// have reached at all — so the tab icon and the login/sidebar marks cannot
// disagree. A theme that wants its own mark drops the asset beside the default
// and registers it here, in theme.ts and not themes.ts, because node tests
// import the manifest and must never pull binary assets through vitest.
// tmuxifier-logo-vercel.png is the same recipe at hue-rotate(185deg): the
// matrix is a linear approximation, so 185° (not the naive 172°) is what lands
// the amber glyphs on Vercel blue's ~213° hue.
const LOGOS: Record<string, string> = { original: logoOriginal, vercel: logoVercel };

// Re-points every mark already in the DOM. Render sites that build their own
// <img> read themedLogo() instead, so a live theme switch and a later render
// agree without either half owning the rule.
function applyLogo(id: string): void {
  const href = LOGOS[id] ?? logoDefault;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = href;
  for (const img of document.querySelectorAll<HTMLImageElement>('.login-logo, .brand-home img')) img.src = href;
}

function readMirror(): string {
  try { return localStorage.getItem(KEY) ?? DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}

let current = normalizeThemeId(readMirror());

export function currentTheme(): string { return current; }

// The mark for the theme in force, for render sites building <img> markup.
export function themedLogo(): string { return LOGOS[current] ?? logoDefault; }

export function applyTheme(raw: unknown): void {
  const id = normalizeThemeId(raw);
  // The default carries no attribute: :root tokens ARE the Instrument theme,
  // and theme-boot.js only ever sets a non-default id.
  if (id === DEFAULT_THEME_ID) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  // Before the same-id early return, not after: the first applyTheme of a boot
  // is usually a no-op *change* (theme-boot.js already stamped the attribute)
  // but the favicon still starts on the static index.html default.
  applyLogo(id);
  try { localStorage.setItem(KEY, id); } catch { /* private mode: login flash only */ }
  if (id === current) return;
  current = id;
  // Each subscriber is isolated: one pane's failure must not stop the rest of
  // the notify pass, or a single stale terminal handle would leave every other
  // open pane wearing the previous theme.
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* one pane's failure must not stop the rest */ }
  }
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// xterm needs concrete color strings. Reading a raw custom property returns
// its UNRESOLVED text ("color-mix(…)", "var(--x)"), so resolve through a
// probe element instead — computed `color` comes back as usable rgb()/rgba().
// Terminal-facing theme tokens must still be plain literals (see style.css
// --term-sel comment): a color-mix() there can serialize as color(srgb …),
// which xterm's parser refuses — the startsWith guard falls back if so.
const SCREEN_FALLBACK = {
  background: '#0a0b0d',
  foreground: '#e6e2da',
  cursor: '#ffb000',
  cursorAccent: '#0a0b0d',
  selectionBackground: 'rgba(255, 176, 0, 0.25)',
};

function resolveColor(varName: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${varName})`;
    document.documentElement.append(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v && (v.startsWith('rgb') || v.startsWith('#')) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function resolveScreenTheme(): typeof SCREEN_FALLBACK {
  const background = resolveColor('--screen', SCREEN_FALLBACK.background);
  return {
    background,
    foreground: resolveColor('--text', SCREEN_FALLBACK.foreground),
    cursor: resolveColor('--accent', SCREEN_FALLBACK.cursor),
    cursorAccent: background,
    selectionBackground: resolveColor('--term-sel', SCREEN_FALLBACK.selectionBackground),
  };
}
