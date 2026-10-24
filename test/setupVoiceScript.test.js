import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// E1 (2026-07-29 review). scripts/setup-voice.mjs hand-rolled its own model
// download and buffered the whole file: `Buffer.from(await res.arrayBuffer())`
// holds the arrayBuffer AND its copy, roughly 2x 540 MB for the largest catalog
// entry — the exact ~1 GB peak voiceDownload.js was written to avoid on a 4 GB
// host, in a script that already imported from src/server/ and could simply have
// called it.
//
// The script is a CLI with no functional coverage (running it builds whisper.cpp),
// so this pins the wiring; the download behaviour itself is covered by
// test/voiceDownload.test.js.

const src = readFileSync(fileURLToPath(new URL('../scripts/setup-voice.mjs', import.meta.url)), 'utf8');
// Assertions about what the script DOES must not be satisfied (or broken) by what
// it SAYS: the comment above the download quotes the buffering call it replaced,
// deliberately, so the negative checks below run against code only.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('setup-voice streams the model through the shared verified downloader', () => {
  expect(src).toContain("import { downloadVerified } from '../src/server/voiceDownload.js'");
  expect(src).toMatch(/await downloadVerified\(\{[^}]*sha256/s);
});

test('setup-voice never buffers the model in memory', () => {
  // The two ways the old block held the whole file at once.
  expect(code).not.toContain('arrayBuffer');
  expect(code).not.toContain('writeFileSync(tmp');
});

test('setup-voice does not re-implement digest verification', () => {
  // Verification belongs to the one tested chokepoint. A second copy here is how
  // the two halves drifted in the first place.
  expect(code).not.toContain('createHash');
});

test('setup-voice still reports a download failure as a clean CLI error', () => {
  // Not an unhandled rejection: the thrown message already names the expected and
  // actual digest on a mismatch, which is the diagnostic worth keeping.
  expect(src).toMatch(/catch \(e\)[\s\S]{0,200}Download failed/);
  expect(src).toMatch(/Download failed[\s\S]{0,120}process\.exit\(1\)/);
});

// F9: the CLI clones the same mutable tag as the Settings installer, so it must
// run the same commit check — and run it before cmake configures anything.
test('setup-voice verifies the pinned whisper.cpp commit before building', () => {
  expect(src).toMatch(/import \{[^}]*verifyWhisperCommit[^}]*\} from '\.\.\/src\/server\/voiceCatalog\.js'/);
  const at = (needle) => {
    const i = code.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0); // a missing anchor must not pass vacuously
    return i;
  };
  const revParse = at("'rev-parse', 'HEAD'");
  const verify = at('verifyWhisperCommit(');
  const configure = at("run('cmake', ['-B'");
  expect(revParse).toBeGreaterThan(at("'checkout', WHISPER_REF"));
  expect(revParse).toBeGreaterThan(at("'clone', '--depth', '1', '--branch', WHISPER_REF"));
  expect(verify).toBeGreaterThan(revParse);
  expect(configure).toBeGreaterThan(verify);
});
