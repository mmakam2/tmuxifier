import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/provision-jobs.json (LXC provision history).
export function createProvisionStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'provision-jobs.json' });
}
