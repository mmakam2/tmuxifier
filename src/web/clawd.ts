// Clawd: the Claude Code mascot as a two-row Unicode block-element sprite,
// shown beside WORKING agent chips (sidebar badge, pane chip, dashboard
// fleet strip). Glyphs only — the bundled mono face renders them, so the
// sprite never breaks the one-face discipline, and it is colored by
// currentColor so it inherits the chip's amber rather than introducing a
// hue. Animation is pure CSS (.clawd-* in style.css); this module is just
// the frames and the DOM.
export const CLAWD_BODY = '▐▛███▜▌';
export const CLAWD_FEET = '▘▘ ▝▝';

// aria-hidden: the adjacent "working" text is the accessible label; the
// sprite is decoration for sighted users only.
export function buildClawd(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'clawd';
  el.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span');
  body.className = 'clawd-body';
  body.textContent = CLAWD_BODY;
  const feet = document.createElement('span');
  feet.className = 'clawd-feet';
  feet.textContent = CLAWD_FEET;
  el.append(body, feet);
  return el;
}
