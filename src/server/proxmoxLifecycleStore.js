import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/proxmox-lifecycle-jobs.json (LXC power and
// deprovision job history).
export function createProxmoxLifecycleStore({ dataDir }) {
  return createDebouncedJsonStore({ dataDir, filename: 'proxmox-lifecycle-jobs.json' });
}
