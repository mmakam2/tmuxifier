// The session/window picker: a trigger button plus an anchored popup whose rows
// each carry a kill ×. Replaces the native <select> both surfaces used, which
// could not host a per-row control — an <option> takes no markup, no click
// handler and no styling.
//
// Split like paneHeader.ts and stagePanes.ts: the pure half below is
// unit-tested, the DOM half is covered by Playwright (vitest runs
// environment: 'node' with no jsdom).
import type { SessionTarget } from './paneHeader';

// tmux destroys a session when its last window is killed. This does not
// special-case that — it just refuses to let it be a surprise, by letting the
// arm legend say so.
export function isSoleWindow(targets: SessionTarget[], t: SessionTarget): boolean {
  if (t.kind !== 'window') return false;
  return targets.filter((x) => x.kind === 'window' && x.session === t.session).length === 1;
}

// What the armed × states before the second click commits. The row's own label
// carries the indent used to draw the tree; strip it so the sentence reads.
export function killLegend(t: SessionTarget, sole: boolean): string {
  const name = t.label.replace(/^[\s ]*→[\s ]*/, '').trim();
  if (t.kind === 'session') return `kill session ${name}?`;
  return sole ? `kill ${name}? last window — the session goes too` : `kill ${name}?`;
}

// The identity an arm is held against. SessionTarget.value already carries the
// session for exactly this class of reason: a grouped session shares its window
// objects, so '@7' alone names two rows, and an arm keyed by id could migrate
// onto a different session between the arming click and the firing one.
export function rowKey(t: SessionTarget): string {
  return t.value;
}
