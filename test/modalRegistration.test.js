import { test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// B11 (2026-07-29 review): five body-mounted modals never called registerModal, so
// logout / session-expiry teardown could not reach them — an expired session left
// the dialog floating over the login screen with live, 401-ing controls. A
// deprovision confirm was the worst of them: a still-clickable Deprovision button.
//
// This asserts the invariant at every call site rather than demonstrating one
// modal, because the bug WAS five call sites forgetting the same line — the next
// one to forget it fails here. The e2e suite cannot cover it: the passkey dialogs
// are disabled in the fixture (passkeys pin to `localhost`, the e2e origin is
// `127.0.0.1`) and the Proxmox dialogs need a host profile with a linked container.
//
// The rule: openModal() mounts on document.body by default, and a body-mounted
// modal outlives the #app re-render that teardown performs, so it must register its
// close(). A modal that passes an explicit `mount:` lives inside #app and dies with
// it, so it needs no registration.

const webDir = fileURLToPath(new URL('../src/web/', import.meta.url));

function callSites() {
  const sites = [];
  for (const file of readdirSync(webDir).filter((f) => f.endsWith('.ts')).sort()) {
    // dom.ts DEFINES openModal; it does not open one.
    if (file === 'dom.ts') continue;
    const src = readFileSync(path.join(webDir, file), 'utf8');
    let from = 0;
    for (;;) {
      const at = src.indexOf('openModal({', from);
      if (at === -1) break;
      from = at + 1;
      // The call's own argument object, and the window after it where the
      // established pattern puts `const unregister = registerModal(close)`.
      const args = src.slice(at, src.indexOf(')', at));
      sites.push({
        file,
        line: src.slice(0, at).split('\n').length,
        mounted: /\bmount:/.test(args),
        registersNearby: /registerModal\(/.test(src.slice(at, at + 600)),
      });
    }
  }
  return sites;
}

test('every body-mounted modal registers its close() for teardown', () => {
  const offenders = callSites()
    .filter((s) => !s.mounted && !s.registersNearby)
    .map((s) => `${s.file}:${s.line}`);
  expect(offenders, 'body-mounted modals that teardown cannot close').toEqual([]);
});

test('the scan actually finds the call sites (guards against a vacuous pass)', () => {
  const sites = callSites();
  // A test that silently matches nothing is worse than no test: this repo has
  // shipped a UI feature that rendered nothing while the suite stayed green.
  expect(sites.length).toBeGreaterThanOrEqual(8);
  // Both kinds must be represented, or the rule above is only half exercised.
  expect(sites.some((s) => s.mounted)).toBe(true);
  expect(sites.some((s) => !s.mounted)).toBe(true);
});

test('the detector recognises an unregistered body-mounted modal', () => {
  // Proves the rule can fail, using the shape the five offenders actually had.
  const bad = "const { close } = openModal({ modal });\nmodal.append(el('h2', {}, ['Remove']));\n";
  expect(/\bmount:/.test(bad)).toBe(false);
  expect(/registerModal\(/.test(bad)).toBe(false);
});
