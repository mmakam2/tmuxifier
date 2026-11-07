import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/agent-seen.json: the "seen" watermark.
// Shape: { [boxId]: { [tmuxSession]: markerTs } }, where markerTs is the
// agent-marker timestamp of the newest finished Claude turn (ready/stop) the
// operator has looked at; a `done` at or below it reads as `idle`.
//
// Kept apart from health-events.json: that file is an append-mostly event log,
// this is a small map overwritten in place on every acknowledgement, so the
// write cadence and shape differ. A non-object file is quarantined by
// jsonFile.js and reads as empty (everything unseen, the safe direction).
export function createAgentSeenStore({ dataDir }) {
  return createDebouncedJsonStore({
    dataDir,
    filename: 'agent-seen.json',
    fallback: {},
    validate: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  });
}
