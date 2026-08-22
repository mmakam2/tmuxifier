import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// scripts/fetch-apk.mjs is a CLI whose functional path is a network download,
// so — like test/setupVoiceScript.test.js — this pins the WIRING rather than the
// behaviour: that the script goes through the shared verified downloader with a
// pinned digest instead of hand-rolling a fetch, and that the pin actually
// matches the release it claims to fetch. The download behaviour itself is
// covered by test/voiceDownload.test.js.

const url = new URL('../scripts/fetch-apk.mjs', import.meta.url);
const src = readFileSync(fileURLToPath(url), 'utf8');
// Assertions about what the script DOES must not be satisfied by what it SAYS:
// the header comment explains the buffering and signing pitfalls by name.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('fetch-apk downloads through the shared verified downloader', () => {
  expect(src).toContain("import { downloadVerified } from '../src/server/voiceDownload.js'");
  expect(code).toMatch(/await downloadVerified\(\{[^}]*sha256/s);
});

test('fetch-apk never buffers the APK in memory', () => {
  // The two shapes that hold a whole file at once, which downloadVerified exists
  // to avoid on a small host.
  expect(code).not.toContain('arrayBuffer');
  expect(code).not.toContain('writeFileSync');
});

test('fetch-apk pins a digest rather than trusting whatever the URL serves', () => {
  const sha = code.match(/sha256:\s*'([0-9a-f]{64})'/);
  expect(sha, 'a full 64-char SHA-256 must be pinned in the release manifest').not.toBeNull();
  // A digest that is not wired into the download call is decoration: the pinned
  // value and the call must be the same object.
  expect(code).toMatch(/downloadVerified\(\{\s*url:\s*RELEASE\.url,\s*dest,\s*sha256:\s*RELEASE\.sha256/);
});

test('the pinned URL and the declared version agree', () => {
  // A manifest whose URL points at a different release than its version claims
  // would install something other than what the docs say — and the digest would
  // still "verify", because it was updated alongside the wrong URL.
  const version = code.match(/version:\s*'([^']+)'/)[1];
  const url = code.match(/url:\s*'([^']+)'/)[1];
  expect(url).toContain(`android-v${version}`);
  expect(url).toContain(`tmuxifier-console-v${version}.apk`);
});

test('fetch-apk writes the filename the server serves', () => {
  // server.js reads data/app/tmuxifier-console.apk; a different name here is a
  // download that silently changes nothing about Settings → Devices.
  expect(code).toMatch(/'data',\s*'app',\s*'tmuxifier-console\.apk'/);
});
