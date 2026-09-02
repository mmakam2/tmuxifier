// src/web/themes.ts
// The theme catalog — pure and node-testable (no DOM, no CSS imports; the
// side-effect CSS imports live in theme.ts, the DOM half). Adding a theme:
// 1. src/web/themes/<id>.css with every rule scoped :root[data-theme="<id>"]
//    (test/styleTokens.test.js enforces the scoping),
// 2. one entry here (+ its import in theme.ts),
// and the Appearance picker, persistence, terminals and editor follow.
export interface ThemeDef { id: string; label: string; description: string }

// Two ids, and they are deliberately not the same theme:
// - DEFAULT_THEME_ID is what a null ("never set") or unknown preference
//   resolves to — the theme a fresh install wears. It is also listed first in
//   the picker (test/themes.test.js pins that).
// - ROOT_THEME_ID is the theme :root's own token block paints when <html>
//   carries NO data-theme attribute. It has no themes/<id>.css of its own,
//   because the token fence in style.css IS its stylesheet, and DESIGN.md is
//   written about it.
// Vercel became the default in v1.24.58; Instrument stayed the root. Splitting
// the two names is what let that happen without moving a single token or
// rewriting the default's own CSS as a scoped theme.
export const DEFAULT_THEME_ID = 'vercel';
export const ROOT_THEME_ID = 'instrument';

export const THEMES: ThemeDef[] = [
  { id: 'vercel', label: 'Vercel', description: 'pure black, hairline gray, deployment blue — the triangle dashboard' },
  { id: 'instrument', label: 'Bench Instrument', description: 'charcoal chassis, amber phosphor — the machined desk instrument' },
  { id: 'original', label: 'Original', description: 'the first tmuxifier look: deep navy, cyan glow' },
];

// Unknown/stale ids (removed theme, hand-edited store) read as the default
// rather than propagating an unresolvable id — the clawd normalize pattern.
export function normalizeThemeId(raw: unknown): string {
  return THEMES.some((t) => t.id === raw) ? (raw as string) : DEFAULT_THEME_ID;
}
