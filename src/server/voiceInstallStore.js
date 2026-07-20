import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/voice-jobs.json (whisper install jobs).
// Persisted rather than in-memory so a browser refresh — or a reconnect
// partway through a ~2 minute build — can re-attach to the running job.
export function createVoiceInstallStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'voice-jobs.json' });
}
