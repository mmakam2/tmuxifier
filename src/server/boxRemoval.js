export function createBoxRemoval({ store, sessions, boxActions }) {
  return async function removeBox(id) {
    const box = await store.getBox(id);
    if (!box) return { ok: true };
    sessions?.closeKey?.(box.id);
    sessions?.closeKey?.(`provision:${box.id}`);
    await store.removeBox(box.id);
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
        try { await boxActions.exitMaster(box); } catch { /* stale or absent master */ }
      }
    })();
    return { ok: true };
  };
}
