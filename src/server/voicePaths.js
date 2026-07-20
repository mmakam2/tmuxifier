import path from 'node:path';
import fs from 'node:fs';
import { resolveModel } from './voiceCatalog.js';

// Where `npm run setup-voice` and the install job put whisper.cpp. Repo-local
// per the self-contained principle: nothing lands in $HOME.
export const VENDOR_DIR = 'vendor/whisper';

export function vendorBinPath(repoRoot) {
  return path.join(repoRoot, VENDOR_DIR, 'build', 'bin', 'whisper-server');
}

export function vendorModelPath(repoRoot, file) {
  return path.join(repoRoot, VENDOR_DIR, 'models', file);
}

// Decide what is actually in effect. Pure: `exists` is injected so this is
// testable without a filesystem, and so config.js stays free of I/O.
//
// data/voice.json is authoritative for the enable flag and the model choice
// because it is read per request — a Settings change applies immediately.
// TMUXIFIER_WHISPER_BIN/MODEL remain deliberate escape hatches (a custom
// whisper build, or the e2e suite pointing at a fixture); when set they win,
// and `pinned` tells the UI to explain that rather than offer a picker that
// silently does nothing.
export function resolveVoicePaths({ repoRoot, config = {}, settings = {}, exists = fs.existsSync } = {}) {
  const pinned = { bin: null, model: null };

  let bin = null;
  if (config.whisperBin) {
    pinned.bin = 'env';
    // A pinned path that does not exist disables voice rather than falling
    // back to the vendored build: silently ignoring a typo in .env would look
    // like it worked, and the operator would never find out.
    bin = exists(config.whisperBin) ? config.whisperBin : null;
  } else {
    const candidate = vendorBinPath(repoRoot);
    if (exists(candidate)) { bin = candidate; pinned.bin = 'vendor'; }
  }

  let model = null;
  if (config.whisperModel) {
    pinned.model = 'env';
    model = exists(config.whisperModel) ? config.whisperModel : null;
  } else {
    const entry = resolveModel(settings.model);
    if (entry) {
      const candidate = vendorModelPath(repoRoot, entry.file);
      if (exists(candidate)) { model = candidate; pinned.model = 'store'; }
    }
  }

  const enabled = Boolean(bin) && Boolean(model) && settings.enabled === true && config.voiceOff !== true;
  return { bin, model, enabled, pinned };
}
