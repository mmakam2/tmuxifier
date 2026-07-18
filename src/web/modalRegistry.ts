// Registry of open modals mounted on document.body (Proxmox hub, settings).
// The logout / session-expiry teardown re-renders #app, which wipes modals
// mounted there — but body-mounted modals survive it and would sit on top of
// the login screen with their pollers still running. Every body-mounted modal
// registers its close() here; teardown calls closeAllModals().
const closers = new Set<() => void>();

export function registerModal(close: () => void): () => void {
  closers.add(close);
  return () => { closers.delete(close); };
}

export function closeAllModals(): void {
  for (const close of [...closers]) {
    try { close(); } catch { /* one bad closer must not strand the rest */ }
  }
  closers.clear();
}
