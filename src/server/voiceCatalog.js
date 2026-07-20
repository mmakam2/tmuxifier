// The allowlist that keeps the (stage 2) installer safe. A model is chosen by
// id; the id resolves here to a fixed URL and a pinned SHA-256. No caller ever
// supplies a URL or a path — without this indirection the install route would
// be an SSRF and arbitrary-file-write primitive, since the downloaded file is
// later mmap'd into the server process.
//
// Same discipline as boxActions.js's TOOL_IDS: ids validated server-side,
// nothing user-typed reaching the script.

export const WHISPER_REPO = 'https://github.com/ggerganov/whisper.cpp.git';
// Pinned release tag — never a branch. A moving ref would silently change what
// gets compiled and run as root on the Tmuxifier host.
export const WHISPER_REF = 'v1.9.1';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// Values below are recorded by Task 2 Step 1. Do not invent them: a wrong
// digest fails every download at the integrity check.
const CATALOG = {
  'base.en': {
    file: 'ggml-base.en.bin',
    bytes: 147964211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  },
  'small.en': {
    file: 'ggml-small.en.bin',
    bytes: 487614201,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  },
  'medium.en-q5_0': {
    file: 'ggml-medium.en-q5_0.bin',
    bytes: 539225533,
    sha256: '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
  },
};

export const MODEL_IDS = Object.keys(CATALOG);
export const DEFAULT_MODEL_ID = 'small.en';

// Own-property lookup only: a bare object index would resolve 'constructor'
// and 'toString' to Object.prototype members.
export function resolveModel(id) {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) return null;
  const entry = CATALOG[id];
  // A fresh object each call so a caller cannot mutate the catalog in place.
  return { id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256, url: HF_BASE + entry.file };
}
