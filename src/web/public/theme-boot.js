// src/web/public/theme-boot.js
// Classic blocking script, loaded in <head> BEFORE the stylesheet: stamps the
// mirrored theme onto <html> pre-paint so the body background never flashes
// another theme. Lives in public/ because CSP is script-src 'self' — this
// must stay an external same-origin file, never inlined into index.html.
// Kept dumb on purpose: unknown-but-well-formed ids stamp an attribute no CSS
// matches (harmless — :root defaults apply); theme.ts normalizes properly
// once the bundle runs.
//
// Two literals, both pinned to src/web/themes.ts by test/themes.test.js since
// this script has no imports: an EMPTY mirror (fresh browser, cleared storage)
// stamps the default theme ('vercel'), and the root theme ('instrument') stamps
// nothing at all, because :root's own tokens are that theme.
(function () {
  try {
    var t = localStorage.getItem('tmuxifier.theme') || 'vercel';
    if (t !== 'instrument' && /^[a-z0-9-]{1,32}$/.test(t)) {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* private mode: default until login */ }
})();
