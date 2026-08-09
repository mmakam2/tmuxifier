// Clawd: the Claude Code mascot beside WORKING agent chips (sidebar badge,
// pane chip, dashboard fleet strip). The Appearance settings tab picks one of
// six variants; the choice is now authoritative SERVER-side (data/ui-settings.json,
// one setting for every browser), and localStorage is kept only as a boot-seed
// mirror so a render before the first fetch lands is not the default flicker.
// Everything renders as currentColor glyphs from the bundled mono stack — no
// new hue, no new font — and all motion is pure CSS (.clawd-v-* in style.css);
// this module is just the catalog, the pref, and the DOM. 'off' means no
// indicator at all, 'static' the motionless sprite.
export type ClawdVariantId = 'off' | 'static' | 'star' | 'wiggle' | 'pace' | 'big-hop';

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
  { id: 'off', label: 'Off', description: 'no indicator' },
  { id: 'static', label: 'Static Clawd', description: 'no motion' },
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
  try { (storage ?? localStorage).setItem(KEY, id); } catch { /* private mode / quota — the choice is simply lost */ }
}

// The authoritative pref now lives server-side (data/ui-settings.json, one
// setting for every browser). This module keeps a synchronous cache so the
// frequent render sites (sidebar badge, pane chips, fleet strip) never await:
// main.ts seeds it from GET /api/ui-settings at boot, the Appearance tab sets
// it on change. localStorage remains as a mirror that seeds pre-fetch renders.
let cached: ClawdVariantId | null = null;

export function setClawdVariant(raw: unknown, storage?: PrefStorage): ClawdVariantId {
  cached = normalizeClawdVariant(raw);
  saveClawdVariant(cached, storage); // keep the mirror fresh for the next boot
  return cached;
}

export function currentClawdVariant(): ClawdVariantId {
  return cached ?? loadClawdVariant();
}

export function hasStoredClawdPref(storage?: PrefStorage): boolean {
  try { return (storage ?? localStorage).getItem(KEY) !== null; } catch { return false; }
}

// The boot-time migration decision, pure so it is testable: a PATCH payload is
// produced ONLY for a genuine legacy pref (server unset AND a local mirror key
// present). The pref used to live per-browser in localStorage, so the first
// boot against a server that has none should adopt whatever this browser
// already had — normalized, since the stored slug may predate a rename.
//
// A null return for "server unset, nothing stored" is load-bearing: the caller
// must then persist NOTHING. Seeding the cache there would write a phantom
// mirror key that the next boot's hasStoredClawdPref() reads as a legacy pref
// and PATCHes as an explicit choice the user never made.
export function clawdMigrationPatch(
  serverVal: string | null,
  storedLocal: string | null,
): { clawdAnim: ClawdVariantId } | null {
  if (serverVal !== null || storedLocal === null) return null;
  return { clawdAnim: normalizeClawdVariant(storedLocal) };
}

// aria-hidden: the adjacent "working" text is the accessible label; the
// sprite is decoration for sighted users only.
export function buildClawdVariant(variant: ClawdVariantId): HTMLElement {
  const root = document.createElement('span');
  root.className = `clawd clawd-v-${variant}`;
  root.setAttribute('aria-hidden', 'true');
  // 'off' still returns an element — .clawd-v-off is display:none in CSS — so
  // buildClawd() keeps its always-an-element contract and the three render
  // sites never branch on the variant.
  if (variant === 'off') return root;
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
  return buildClawdVariant(currentClawdVariant());
}
