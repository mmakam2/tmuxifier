import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/apk-build-jobs.json (server-side Android
// builds). Persisted so a browser refresh mid-build re-attaches to the
// running job — and wired into the shutdown flush like its four siblings.
export function createApkBuildStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'apk-build-jobs.json' });
}
