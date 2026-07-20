import { test, expect } from 'vitest';
import { resolveVoicePaths, vendorBinPath, vendorModelPath, VENDOR_DIR } from '../src/server/voicePaths.js';
import { DEFAULT_MODEL_ID } from '../src/server/voiceCatalog.js';

const ROOT = '/repo';
const BIN = vendorBinPath(ROOT);
const MODEL = vendorModelPath(ROOT, 'ggml-small.en.bin');

// `exists` is injected so these tests never touch a filesystem.
const existsOnly = (...paths) => (p) => paths.includes(p);
const settings = (over = {}) => ({ enabled: true, model: DEFAULT_MODEL_ID, ...over });

test('vendor paths live under the repo folder', () => {
  expect(VENDOR_DIR).toBe('vendor/whisper');
  expect(BIN.startsWith(`${ROOT}/${VENDOR_DIR}`)).toBe(true);
  expect(MODEL.startsWith(`${ROOT}/${VENDOR_DIR}`)).toBe(true);
});

test('resolves the vendored build and the selected model when both are present', () => {
  const r = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(BIN, MODEL) });
  expect(r.bin).toBe(BIN);
  expect(r.model).toBe(MODEL);
  expect(r.enabled).toBe(true);
  expect(r.pinned).toEqual({ bin: 'vendor', model: 'store' });
});

test('env vars win over the vendored paths and are reported as pinned', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT,
    config: { whisperBin: '/opt/w/whisper-server', whisperModel: '/opt/w/custom.bin' },
    settings: settings(),
    exists: existsOnly('/opt/w/whisper-server', '/opt/w/custom.bin'),
  });
  expect(r.bin).toBe('/opt/w/whisper-server');
  expect(r.model).toBe('/opt/w/custom.bin');
  expect(r.pinned).toEqual({ bin: 'env', model: 'env' });
  expect(r.enabled).toBe(true);
});

test('a pinned env path that does not exist disables voice rather than falling back', () => {
  // Silently falling back would make a typo in .env look like it worked.
  const r = resolveVoicePaths({
    repoRoot: ROOT,
    config: { whisperBin: '/opt/typo/whisper-server' },
    settings: settings(),
    exists: existsOnly(BIN, MODEL),
  });
  expect(r.bin).toBe(null);
  expect(r.enabled).toBe(false);
  expect(r.pinned.bin).toBe('env');
});

test('missing binary or missing model both disable voice', () => {
  const noBin = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(MODEL) });
  expect(noBin.bin).toBe(null);
  expect(noBin.enabled).toBe(false);

  const noModel = resolveVoicePaths({ repoRoot: ROOT, config: {}, settings: settings(), exists: existsOnly(BIN) });
  expect(noModel.model).toBe(null);
  expect(noModel.enabled).toBe(false);
});

test('the stored enable flag gates usability even when everything is installed', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: {}, settings: settings({ enabled: false }), exists: existsOnly(BIN, MODEL),
  });
  expect(r.bin).toBe(BIN);
  expect(r.model).toBe(MODEL);
  expect(r.enabled).toBe(false);
});

test('TMUXIFIER_VOICE=off overrides the stored flag', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: { voiceOff: true }, settings: settings(), exists: existsOnly(BIN, MODEL),
  });
  expect(r.enabled).toBe(false);
});

test('an unknown stored model resolves to no model rather than a fabricated path', () => {
  const r = resolveVoicePaths({
    repoRoot: ROOT, config: {}, settings: settings({ model: 'nope' }), exists: () => true,
  });
  expect(r.model).toBe(null);
  expect(r.enabled).toBe(false);
});
