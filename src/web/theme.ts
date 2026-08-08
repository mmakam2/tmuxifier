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
import { DEFAULT_THEME_ID, normalizeThemeId } from './themes';

const KEY = 'tmuxifier.theme';
const listeners = new Set<() => void>();

function readMirror(): string {
  try { return localStorage.getItem(KEY) ?? DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}

let current = normalizeThemeId(readMirror());

export function currentTheme(): string { return current; }

export function applyTheme(raw: unknown): void {
  const id = normalizeThemeId(raw);
  // The default carries no attribute: :root tokens ARE the Instrument theme,
  // and theme-boot.js only ever sets a non-default id.
  if (id === DEFAULT_THEME_ID) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
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
