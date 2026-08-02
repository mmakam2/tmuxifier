import { test, expect } from 'vitest';
import { CLAWD_BODY, CLAWD_FEET } from '../src/web/clawd.ts';

// The sprite must stay renderable by the bundled mono face: Unicode block
// elements (U+2580–U+259F) and spaces only. Anything else risks tofu in the
// chip, which a node test can catch even though the DOM builder cannot be
// exercised here (vitest runs environment:'node' — no DOM by convention).
test('clawd frames: block-element glyphs only, feet narrower than body', () => {
  const blockOrSpace = /^[▀-▟ ]+$/;
  expect(CLAWD_BODY).toMatch(blockOrSpace);
  expect(CLAWD_FEET).toMatch(blockOrSpace);
  expect(CLAWD_BODY.length).toBe(7);
  expect(CLAWD_FEET.length).toBe(5);
  // Feet are strictly narrower so the centered stack reads as a body on legs.
  expect(CLAWD_FEET.length).toBeLessThan(CLAWD_BODY.length);
});
