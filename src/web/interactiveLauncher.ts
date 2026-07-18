// At most one interactive setup terminal per viewer at a time. Both setup-job
// viewers (the provision panel and the Proxmox hub) offer a "Finish
// interactively" button that opens a WS PTY running the setup script with the
// user present; clicking it again while a session is live must not start a
// second concurrent script run on the same box, and replacing a session must
// never leak the previous one.
export function createInteractiveLauncher<T extends { dispose: () => void }>() {
  let current: T | null = null;
  return {
    active: () => current !== null,
    // Refuses a double-launch: while a session is live, the existing handle is
    // returned and open() is not called.
    launch(open: () => T): T {
      if (current) return current;
      current = open();
      return current;
    },
    // The session ended on its own (its onComplete ran) — clear without
    // disposing, so a later stop() cannot touch the finished terminal.
    done() { current = null; },
    // Viewer torn down mid-session: dispose the live terminal.
    stop() { current?.dispose(); current = null; },
  };
}
