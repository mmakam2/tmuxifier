export function createBoxRemoval({ store, sessions, boxActions }) {
  return async function removeBox(id) {
    const box = await store.getBox(id);
    if (!box) return { ok: true };
    sessions?.closeKey?.(box.id);
    sessions?.closeKey?.(`provision:${box.id}`);
    if (boxActions?.killSession) {
      try { await boxActions.killSession(box); } catch { /* target may already be stopped/destroyed */ }
    }
    if (boxActions?.exitMaster) {
      try { await boxActions.exitMaster(box); } catch { /* stale or absent master */ }
    }
    await store.removeBox(box.id);
    return { ok: true };
  };
}
