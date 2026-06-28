// Pure helpers for the xterm terminal font. Kept free of xterm/DOM imports so
// they unit-test in plain Node (see test/termFont.test.js) and so terminal.ts
// stays the only place that touches the live Terminal.

// The bundled stack (see @font-face in style.css): MesloLGMDZ Nerd Font (Line Gap
// Medium) is the primary face and carries text/powerline/icons/ballot/sparkle;
// MesloLGSDZ (Line Gap Small, same glyphs) is the next fallback; JuliaMono is the
// per-glyph fallback for the U+2000-2BFF symbols Meslo lacks (Braille, ⎿/⏺ —
// Claude Code's UI). A configured TMUXIFIER_TERM_FONT is PREPENDED onto this,
// never replacing it, so those symbol glyphs keep rendering and a missing/
// unavailable custom font falls through to Meslo on the viewing device. See docs
// and the cell-metric note in terminal.ts.
export const BUNDLED_FONT_STACK =
  "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', 'JuliaMono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

export const DEFAULT_TERM_FONT_SIZE = 12;

// Single family name only: a letter/digit start then letters/digits/space/_/-.
// This is intentionally the same shape the server validates with — the client
// re-checks as defense in depth so a malformed value can never reach the CSS
// font-family string (no quotes, commas, semicolons, braces, or angle brackets).
const SAFE_FONT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

// Build xterm's fontFamily by prepending the user's (validated) family, quoted,
// onto the bundled stack. An empty/unsafe name yields the bundled stack alone —
// i.e. "fall back to the current font".
export function buildFontFamily(userFont: string | null | undefined): string {
  const name = String(userFont ?? '').trim();
  return name && SAFE_FONT.test(name) ? `'${name}', ${BUNDLED_FONT_STACK}` : BUNDLED_FONT_STACK;
}

// Clamp a font size to a sane px range, falling back to the default for
// non-numeric or out-of-range input.
export function clampFontSize(size: number | null | undefined): number {
  const n = Number(size);
  return Number.isFinite(n) && n >= 6 && n <= 32 ? n : DEFAULT_TERM_FONT_SIZE;
}
