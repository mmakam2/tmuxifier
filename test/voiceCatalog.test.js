import { test, expect } from 'vitest';
import {
  resolveModel, MODEL_IDS, DEFAULT_MODEL_ID, WHISPER_REPO, WHISPER_REF,
} from '../src/server/voiceCatalog.js';

test('every catalog entry carries a verifiable download', () => {
  expect(MODEL_IDS.length).toBeGreaterThan(0);
  for (const id of MODEL_IDS) {
    const m = resolveModel(id);
    expect(m.id).toBe(id);
    expect(m.file).toMatch(/^ggml-[A-Za-z0-9.\-_]+\.bin$/);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.bytes).toBeGreaterThan(1_000_000);
    expect(m.url.startsWith('https://huggingface.co/')).toBe(true);
  }
});

test('the default model is in the catalog', () => {
  expect(MODEL_IDS).toContain(DEFAULT_MODEL_ID);
});

test('unknown and traversal ids resolve to null, never a path', () => {
  for (const bad of ['', '  ', 'nope', '../../etc/passwd', 'small.en/../x',
                     '/abs/path', 'small.en ', 'HTTP://evil.example.com/x.bin']) {
    expect(resolveModel(bad)).toBeNull();
  }
});

test('resolveModel rejects non-string input', () => {
  expect(resolveModel(null)).toBeNull();
  expect(resolveModel(undefined)).toBeNull();
  expect(resolveModel({ id: 'small.en' })).toBeNull();
  expect(resolveModel(['small.en'])).toBeNull();
});

test('the upstream repo and ref are pinned constants, not floating', () => {
  expect(WHISPER_REPO).toBe('https://github.com/ggerganov/whisper.cpp.git');
  expect(WHISPER_REF).toMatch(/^v\d+\.\d+\.\d+$/);
});

test('returned entries are copies — a caller cannot mutate the catalog', () => {
  const first = resolveModel(DEFAULT_MODEL_ID);
  first.url = 'https://evil.example.com/payload.bin';
  expect(resolveModel(DEFAULT_MODEL_ID).url.startsWith('https://huggingface.co/')).toBe(true);
});
