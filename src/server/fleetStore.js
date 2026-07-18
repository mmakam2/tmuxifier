import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/fleet-jobs.json (Fleet Command history).
export function createFleetStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'fleet-jobs.json' });
}
