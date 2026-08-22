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

// A CSS `filter` paints the element's WHOLE box — its border and box-shadow
// included, not just the raster inside it. The Original theme used one to
// rotate the mark's baked-in amber to cyan, and it rotated the token-colored
// `border: 1px solid var(--border)` right along with it: #202938 navy landed
// on #352524, a warm reddish rim around a cool logo. Themes recolor the mark
// by swapping the asset (theme.ts), never by filtering it.
test('theme files: the logo mark is swapped, never filtered', () => {
  const dir = path.join(WEB, 'themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')) : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const chunk of text.split('}')) {
      const [sel, body = ''] = chunk.split('{');
      if (!/\.login-logo|\.brand-home\s+img|\.brand\s+img/.test(sel)) continue;
      expect(/(^|[\s;])filter\s*:/.test(body), `${f}: filter on the logo mark ("${sel.trim()}")`).toBe(false);
    }
  }
});

// theme.ts owns which raster a theme wears, so it must be the only door to the
// asset: a module importing the logo directly would render the default mark
// under every theme and silently reintroduce the need for a CSS filter.
test('the logo raster is imported only by theme.ts', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets') walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || e.name === 'theme.ts') continue;
      if (/from\s+'[^']*tmuxifier-logo[^']*'/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(WEB, p));
    }
  };
  walk(WEB);
  expect(offenders, `import the logo through theme.ts instead: ${offenders.join(', ')}`).toEqual([]);
});
