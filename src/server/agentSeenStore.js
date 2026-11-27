import { createDebouncedJsonStore } from './debouncedJsonStore.js';

// Debounced persistence for data/agent-seen.json: the "seen" watermark.
// Shape: { [boxId]: { [paneId]: markerTs } }, keyed by tmux pane id (`%N`),
// where markerTs is the agent-marker timestamp of the newest finished turn
// (ready/stop) the operator has looked at in that pane; a `done` at or below it
// reads as `idle`. healthHistory.js drops keys that are not pane ids on load (a
// file from before watermarks were per pane is keyed by tmux session name) and
// prunes the watermark of a pane a complete pane listing no longer has.
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
