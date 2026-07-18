import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/setup-jobs.json (server-side box setup jobs).
export function createSetupStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'setup-jobs.json' });
}
