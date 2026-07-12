# NetBox Scheme Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the NetBox settings scheme-in-URL text field with an explicit http/https selector plus scheme-less host input; TLS options render only for https.

**Architecture:** Client-only, per the spec (`docs/superpowers/specs/2026-07-12-netbox-scheme-selector-design.md`): pure scheme/host helpers in `settingsForm.ts` (node-env testable), thin wiring in `settingsNetbox.ts`. Stored `url` stays canonical; server untouched.

**Tech Stack:** TypeScript web client, vitest (node environment).

## Global Constraints

- Public repo: placeholders only in committed code (`example.com`, RFC1918 IPs).
- Tests use real code with injected fakes; never module mocks.
- Commit only with owner approval (autonomous-session harness rule).

---

### Task 1: Pure helpers — scheme/host state in `settingsForm.ts`

**Files:**
- Modify: `src/web/settingsForm.ts`
- Test: `test/settingsForm.test.js`

**Interfaces:**
- Produces: `NetboxFormState` with `scheme: 'http' | 'https'; host: string` (replacing `url`); `splitNetboxUrl(url: string): { scheme: 'http' | 'https'; host: string }`; `normalizeHostInput(scheme: 'http' | 'https', raw: string): { scheme: 'http' | 'https'; host: string }`; `buildSavePayload` unchanged signature, composed URL. `isHttps` removed.

- [x] **Step 1: Rewrite the test file to the new contract (failing tests)**

Replace the `state` fixture, the `isHttps` test, and the URL-shape cases in `test/settingsForm.test.js`:

```js
import { test, expect } from 'vitest';
import { splitNetboxUrl, normalizeHostInput, buildSavePayload, describeTestResult } from '../src/web/settingsForm.ts';

const state = (over = {}) => ({ scheme: 'https', host: 'netbox.example.com', token: 'tok', tlsMode: 'ca', fingerprint256: null, hasToken: false, ...over });

test('splitNetboxUrl parses stored URLs and defaults scheme-less input to https', () => {
  expect(splitNetboxUrl('https://netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
  expect(splitNetboxUrl('http://192.168.1.20:8000/netbox')).toEqual({ scheme: 'http', host: '192.168.1.20:8000/netbox' });
  expect(splitNetboxUrl('  HTTPS://x ')).toEqual({ scheme: 'https', host: 'x' });
  expect(splitNetboxUrl('')).toEqual({ scheme: 'https', host: '' });
  expect(splitNetboxUrl('netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
});

test('normalizeHostInput passes plain hosts through and adopts a pasted scheme', () => {
  expect(normalizeHostInput('https', 'netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
  expect(normalizeHostInput('https', 'http://192.168.1.20:8000')).toEqual({ scheme: 'http', host: '192.168.1.20:8000' });
  expect(normalizeHostInput('http', 'HTTPS://netbox.example.com/netbox')).toEqual({ scheme: 'https', host: 'netbox.example.com/netbox' });
});
```

And update the payload cases (same test names where kept):

```js
test('buildSavePayload: happy path https/ca', () => {
  expect(buildSavePayload(state())).toEqual({ payload: { url: 'https://netbox.example.com', token: 'tok', tlsMode: 'ca' } });
});

test('buildSavePayload: blank token allowed only when one is already saved', () => {
  expect(buildSavePayload(state({ token: '' })).error).toMatch(/token/);
  expect(buildSavePayload(state({ token: '', hasToken: true })).payload).toEqual({ url: 'https://netbox.example.com', tlsMode: 'ca' });
});

test('buildSavePayload: pin mode requires a fingerprint and includes it', () => {
  expect(buildSavePayload(state({ tlsMode: 'pin' })).error).toMatch(/fingerprint/i);
  expect(buildSavePayload(state({ tlsMode: 'pin', fingerprint256: 'AB:CD' })).payload)
    .toEqual({ url: 'https://netbox.example.com', token: 'tok', tlsMode: 'pin', fingerprint256: 'AB:CD' });
});

test('buildSavePayload: http omits tlsMode even if one is set; empty host errors', () => {
  expect(buildSavePayload(state({ scheme: 'http', host: '192.168.1.10:8000', tlsMode: 'pin' })).payload)
    .toEqual({ url: 'http://192.168.1.10:8000', token: 'tok' });
  expect(buildSavePayload(state({ host: '  ' })).error).toMatch(/host/i);
});
```

(`describeTestResult` test is unchanged.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/settingsForm.test.js`
Expected: FAIL — `splitNetboxUrl`/`normalizeHostInput` not exported; payload cases feed the new state shape into the old `url`-based implementation.

- [x] **Step 3: Implement the helpers**

In `src/web/settingsForm.ts`, replace `NetboxFormState`, `isHttps`, and `buildSavePayload` with:

```ts
export interface NetboxFormState {
  scheme: 'http' | 'https'; host: string; token: string; tlsMode: 'ca' | 'pin' | 'insecure';
  fingerprint256: string | null; hasToken: boolean;
}

// Parse a stored canonical URL into the selector + host controls. Scheme-less
// or empty input (fresh form) defaults to https.
export function splitNetboxUrl(url: string): { scheme: 'http' | 'https'; host: string } {
  const m = /^\s*(https?):\/\/(.*?)\s*$/i.exec(url ?? '');
  if (m) return { scheme: m[1].toLowerCase() as 'http' | 'https', host: m[2] };
  return { scheme: 'https', host: (url ?? '').trim() };
}

// Pasting a full URL into the host field is the common case (browser tab):
// the pasted scheme wins and the prefix moves out of the host text.
export function normalizeHostInput(scheme: 'http' | 'https', raw: string): { scheme: 'http' | 'https'; host: string } {
  return /^\s*https?:\/\//i.test(raw) ? splitNetboxUrl(raw) : { scheme, host: raw };
}

export function buildSavePayload(s: NetboxFormState): { payload?: NetboxSettingsInput; error?: string } {
  const host = s.host.trim();
  if (!host) return { error: 'NetBox host is required' };
  const token = s.token.trim();
  if (!token && !s.hasToken) return { error: 'an API token is required' };
  const payload: NetboxSettingsInput = { url: `${s.scheme}://${host}` };
  if (token) payload.token = token;
  if (s.scheme === 'https') {
    payload.tlsMode = s.tlsMode;
    if (s.tlsMode === 'pin') {
      if (!s.fingerprint256) return { error: 'pin mode needs a certificate fingerprint — run Test Connection to fetch it' };
      payload.fingerprint256 = s.fingerprint256;
    }
  }
  return { payload };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/settingsForm.test.js`
Expected: PASS (6 tests).

### Task 2: Tab wiring in `settingsNetbox.ts` + style + verification

**Files:**
- Modify: `src/web/settingsNetbox.ts`, `src/web/style.css`

**Interfaces:**
- Consumes: Task 1's `splitNetboxUrl`, `normalizeHostInput`, `buildSavePayload`, new `NetboxFormState`.

- [x] **Step 1: Replace the URL input with selector + host**

In `settingsNetbox.ts`, replace the `url` input block and its consumers:

```ts
const stored = splitNetboxUrl(current?.url ?? '');
let scheme: 'http' | 'https' = stored.scheme;
const schemeSel = document.createElement('select');
for (const value of ['https', 'http'] as const) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = `${value}://`;
  schemeSel.append(opt);
}
schemeSel.value = scheme;
const host = document.createElement('input');
host.type = 'text';
host.placeholder = 'netbox.example.com';
host.value = stored.host;
host.autocomplete = 'off';
const urlRow = document.createElement('div');
urlRow.className = 'settings-url-row';
urlRow.append(schemeSel, host);
```

`syncSchemeUi` keys off the selector; the host listener adopts a pasted scheme:

```ts
function syncSchemeUi() {
  tlsGroup.hidden = scheme !== 'https';
  httpNote.hidden = scheme !== 'http';
}
schemeSel.addEventListener('change', () => { scheme = schemeSel.value as 'http' | 'https'; syncSchemeUi(); });
host.addEventListener('input', () => {
  const norm = normalizeHostInput(scheme, host.value);
  if (norm.scheme !== scheme || norm.host !== host.value) {
    scheme = norm.scheme;
    schemeSel.value = scheme;
    host.value = norm.host;
    syncSchemeUi();
  }
});
```

`formState()` returns `{ scheme, host: host.value, token: token.value, tlsMode, fingerprint256, hasToken: !!current?.hasToken }`; the Test Connection body becomes:

```ts
const body: Record<string, unknown> = { url: `${scheme}://${host.value.trim()}` };
if (token.value.trim()) body.token = token.value.trim();
if (scheme === 'https') { body.tlsMode = tlsMode; if (fingerprint256) body.fingerprint256 = fingerprint256; }
```

`form.append(...)` swaps `field('NetBox URL', url)` for `field('NetBox URL', urlRow)`; the import line swaps `isHttps` for `splitNetboxUrl, normalizeHostInput`.

- [x] **Step 2: Style the row**

In `style.css`, next to the other `.settings-*` rules:

```css
.settings-url-row { display: flex; gap: 6px; }
.settings-url-row input { flex: 1; min-width: 0; }
```

- [x] **Step 3: Full verification**

Run: `npm test`
Expected: typecheck clean (the `NetboxFormState` change would break any missed consumer); all vitest files pass.

- [ ] **Step 4: Commit (owner approval required — harness rule: commit only when asked)**

```bash
git add -A
git diff --cached   # PII scrub
git commit -m "feat(ui): explicit http/https selector in NetBox settings"
```

## Self-review

- Spec coverage: selector + gating → Task 2 Step 1; helpers/paste behavior → Task 1; styling → Task 2 Step 2; testing section → Task 1 Step 1. No gaps.
- Placeholder scan: none; all steps carry full code.
- Type consistency: `scheme: 'http' | 'https'` and `{ scheme, host }` return shapes match between tests, helpers, and wiring; `buildSavePayload` keeps its `{ payload?, error? }` return.
