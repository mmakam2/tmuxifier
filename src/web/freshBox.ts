import type { Box } from './api';

// The Edit Box modal builds its Proxmox section from a box object, and the
// page's box list is fetched only on boot and after the page's own edits —
// but the server rewrites a link on its own (the node auto-follow, the
// cross-cluster follow, a healed host profile). So the modal is opened from a
// freshly fetched copy; `list` is null when that fetch failed, and a box the
// fresh list no longer holds falls back to the cached copy as well, so opening
// the modal never gets worse than it was.
export function freshBoxFrom(list: Box[] | null, cached: Box): Box {
  return list?.find((box) => box.id === cached.id) ?? cached;
}
