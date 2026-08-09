// test/styleTokens.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The themes-engine contract: every color in style.css flows from the token
// block, so a theme file overriding tokens re-skins the whole app. Allowed
// outside the fence: pure black/white washes (highlight/shade "physics" —
// both shipped themes are dark) and non-color text.
const WEB = path.join(process.cwd(), 'src/web');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const OPEN = '/* === THEME TOKENS (color literals allowed) === */';
const CLOSE = '/* === END THEME TOKENS === */';

const BW_WASH = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,[^)]*)?\)|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,[^)]*)?\)/g;
// #hex, rgb()/rgba(), hsl()/hsla(), and %23-encoded hex inside data: URIs.
const COLOR = /#[0-9a-fA-F]{3,8}\b|%23[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

test('style.css: color literals live only inside the token fence', () => {
  const open = css.indexOf(OPEN);
  const close = css.indexOf(CLOSE);
  expect(open, 'token fence opening marker missing').toBeGreaterThan(-1);
  expect(close, 'token fence closing marker missing').toBeGreaterThan(open);
  const outside = (css.slice(0, open) + css.slice(close + CLOSE.length)).replace(BW_WASH, '');
  const hits = outside.match(COLOR) ?? [];
  expect(hits, `color literals outside the token fence (first 15): ${hits.slice(0, 15).join(' ')}`).toEqual([]);
});

test('theme files: every rule is [data-theme]-scoped, no at-rules', () => {
  const dir = path.join(WEB, 'themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')) : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = text.split('}').map((chunk) => chunk.split('{')[0].trim()).filter(Boolean);
    for (const sel of selectors) {
      // An @media line fails this on purpose: theme files hold flat rules only,
      // so this naive parser stays valid.
      expect(sel.includes('[data-theme='), `${f}: unscoped selector "${sel}"`).toBe(true);
    }
  }
});
