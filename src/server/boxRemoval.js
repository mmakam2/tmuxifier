export function createBoxRemoval({ store, sessions, boxActions, statusChecker = null }) {
  return async function removeBox(id) {
    const box = await store.getBox(id);
    if (!box) return { ok: true };
    sessions?.closeKey?.(box.id);
    sessions?.closeKey?.(`provision:${box.id}`);
    await store.removeBox(box.id);
    // Drop the checker's per-box backoff/cpu state — ids are UUIDs, so a
    // removed box's entries would otherwise sit in those maps forever.
    statusChecker?.forgetBox?.(box.id);
    // Best-effort remote cleanup runs in the background: killing the on-box
    // tmux session and tearing down the ControlMaster each ride an ssh attempt
    // that takes up to 12s/6s against an unreachable host, and blocking the
    // DELETE on that made removal look broken (silent multi-second hang). The
    // box object is captured above, so the store removal doesn't race it.
    void (async () => {
      if (boxActions?.killSession) {
        try { await boxActions.killSession(box); } catch { /* target may already be stopped/destroyed */ }
      }
      if (boxActions?.exitMaster) {
        // The ControlMaster socket path is derived from host/user/port only.
        // If an identical box was re-added while this cleanup waited (up to
        // ~18s against an unreachable host), the master now belongs to the new
        // box — tearing it down would flip a freshly authenticated box back to
        // needs-auth.
        let readded = false;
        try {
          const boxes = (await store.listBoxes?.()) || [];
          readded = boxes.some((b) => b.host === box.host
            && (b.user || '') === (box.user || '')
            && (Number(b.port) || 22) === (Number(box.port) || 22));
        } catch { readded = false; }
        if (!readded) {
          try { await boxActions.exitMaster(box); } catch { /* stale or absent master */ }
        }
      }
    })();
    return { ok: true };
  };
}
