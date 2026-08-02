// Clawd: the Claude Code mascot beside WORKING agent chips (sidebar badge,
// pane chip, dashboard fleet strip). The Appearance settings tab picks one of
// five variants; the choice is a per-browser display preference (localStorage,
// the notifyPrefs pattern). Everything renders as currentColor glyphs from the
// bundled mono stack — no new hue, no new font — and all motion is pure CSS
// (.clawd-v-* in style.css); this module is just the catalog, the pref, and
// the DOM.
export type ClawdVariantId = 'off' | 'star' | 'wiggle' | 'pace' | 'big-hop';

export const CLAWD_BODY = '▐▛███▜▌';
export const CLAWD_FEET = '▘▘ ▝▝';

// The Claude Code CLI spinner, as a ping-pong glyph cycle: the star blooms
// out and closes back the way it came. One stacked span per frame; CSS delays
// make exactly one visible at a time.
export const STAR_FRAMES = ['·', '✢', '*', '✶', '✻', '✽', '✻', '✶', '*', '✢'];

export const DEFAULT_CLAWD_VARIANT: ClawdVariantId = 'star';

// Ordered: this array drives both the Appearance picker rows and the build
// switch, so the picker can never offer a variant the builder lacks.
export const CLAWD_VARIANTS: { id: ClawdVariantId; label: string; description: string }[] = [
  { id: 'off', label: 'Off — static Clawd', description: 'no motion' },
  { id: 'star', label: 'CLI star', description: 'Claude Code spinner' },
  { id: 'wiggle', label: 'Wiggle', description: 'leans on a beat' },
  { id: 'pace', label: 'Pace', description: 'shuffles side to side' },
  { id: 'big-hop', label: 'Big hop', description: 'squash-stretch jump' },
];

const KEY = 'tmuxifier.clawdAnim';

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeClawdVariant(raw: unknown): ClawdVariantId {
  return CLAWD_VARIANTS.some((v) => v.id === raw) ? (raw as ClawdVariantId) : DEFAULT_CLAWD_VARIANT;
}

export function loadClawdVariant(storage?: PrefStorage): ClawdVariantId {
  try {
    return normalizeClawdVariant((storage ?? localStorage).getItem(KEY));
  } catch {
    return DEFAULT_CLAWD_VARIANT; // private mode, or node where localStorage does not exist
  }
}

export function saveClawdVariant(id: ClawdVariantId, storage?: PrefStorage): void {
  try { (storage ?? localStorage).setItem(KEY, id); } catch { /* private mode / quota — in-memory only */ }
}

// aria-hidden: the adjacent "working" text is the accessible label; the
// sprite is decoration for sighted users only.
export function buildClawdVariant(variant: ClawdVariantId): HTMLElement {
  const root = document.createElement('span');
  root.className = `clawd clawd-v-${variant}`;
  root.setAttribute('aria-hidden', 'true');
  if (variant === 'star') {
    for (const frame of STAR_FRAMES) {
      const f = document.createElement('span');
      f.className = 'clawd-star-f';
      f.textContent = frame;
      root.append(f);
    }
    return root;
  }
  const body = document.createElement('span');
  body.className = 'clawd-body';
  body.textContent = CLAWD_BODY;
  const feet = document.createElement('span');
  feet.className = 'clawd-feet';
  feet.textContent = CLAWD_FEET;
  root.append(body, feet);
  return root;
}

export function buildClawd(): HTMLElement {
  return buildClawdVariant(loadClawdVariant());
}
