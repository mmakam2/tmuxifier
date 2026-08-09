// src/web/themes.ts
// The theme catalog — pure and node-testable (no DOM, no CSS imports; the
// side-effect CSS imports live in theme.ts, the DOM half). Adding a theme:
// 1. src/web/themes/<id>.css with every rule scoped :root[data-theme="<id>"]
//    (test/styleTokens.test.js enforces the scoping),
// 2. one entry here (+ its import in theme.ts),
// and the Appearance picker, persistence, terminals and editor follow.
export interface ThemeDef { id: string; label: string; description: string }

export const DEFAULT_THEME_ID = 'instrument';

export const THEMES: ThemeDef[] = [
  { id: 'instrument', label: 'Bench Instrument', description: 'charcoal chassis, amber phosphor — the machined desk instrument' },
  { id: 'original', label: 'Original', description: 'the first tmuxifier look: deep navy, cyan glow' },
];

// Unknown/stale ids (removed theme, hand-edited store) read as the default
// rather than propagating an unresolvable id — the clawd normalize pattern.
export function normalizeThemeId(raw: unknown): string {
  return THEMES.some((t) => t.id === raw) ? (raw as string) : DEFAULT_THEME_ID;
}
