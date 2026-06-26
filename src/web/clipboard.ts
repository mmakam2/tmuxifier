// Browser-clipboard wiring for the terminal. xterm.js never copies a selection
// to the system clipboard on its own (it only emits onSelectionChange and
// exposes getSelection), and it handles paste only via the browser's native
// paste event — so without this, "copy" does nothing and keyboard "paste" works
// only on macOS (Cmd+V). These helpers are kept pure and dependency-injected so
// they unit-test under node without a DOM; terminal.ts supplies the real
// navigator.clipboard / xterm objects (see openTerminal).

export type ClipboardAction = 'copy' | 'paste' | 'none';

export interface KeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface ClipboardEnv {
  // Whether the dashboard is running on macOS, which decides the shortcut set.
  mac: boolean;
}

export interface ClipboardDeps {
  // navigator.clipboard — absent in insecure contexts (plain HTTP off localhost).
  clipboard?: {
    writeText?: (text: string) => Promise<void>;
    readText?: () => Promise<string>;
  };
  // Synchronous execCommand('copy') fallback for when the async API is missing
  // or rejects (e.g. the document isn't focused). Returns whether it succeeded.
  fallbackCopy?: (text: string) => boolean;
}

// Classify a key event as an intentional copy/paste shortcut.
//
// macOS:        Cmd+C copies. Paste stays 'none' — xterm's built-in native
//               paste already handles Cmd+V (and right/middle-click) without a
//               clipboard-read permission prompt, so we must not override it.
// Other (PC):   Ctrl+Shift+C copies, Ctrl+Shift+V pastes — the terminal
//               convention, because bare Ctrl+C / Ctrl+V are SIGINT and a
//               literal byte and MUST pass through to the PTY untouched.
//
// Only keydown counts, so a single press can't fire twice (keydown + keyup).
export function clipboardActionForKey(ev: KeyEventLike, env: ClipboardEnv): ClipboardAction {
  if (ev.type !== 'keydown') return 'none';
  const key = (ev.key || '').toLowerCase();
  if (key !== 'c' && key !== 'v') return 'none';

  if (env.mac) {
    // Cmd+C only (clean — no Ctrl, no Shift). Paste is left to xterm native.
    if (key === 'c' && ev.metaKey && !ev.ctrlKey && !ev.shiftKey) return 'copy';
    return 'none';
  }
  // Ctrl+Shift+C / Ctrl+Shift+V (no Meta).
  if (ev.ctrlKey && ev.shiftKey && !ev.metaKey) return key === 'c' ? 'copy' : 'paste';
  return 'none';
}

// Write text to the system clipboard, preferring the async Clipboard API and
// falling back to a synchronous execCommand copy. Empty text is a no-op.
// Resolves to whether the text reached the clipboard.
export async function writeClipboard(text: string, deps: ClipboardDeps): Promise<boolean> {
  if (!text) return false;
  const writeText = deps.clipboard?.writeText;
  if (writeText) {
    try {
      await writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand fallback (e.g. document not focused).
    }
  }
  return deps.fallbackCopy ? deps.fallbackCopy(text) : false;
}

// Read the system clipboard for the explicit paste shortcut. Returns '' when
// reading is unavailable (insecure context), in which case the caller should
// simply do nothing and let native paste cover the working cases.
export async function readClipboard(deps: ClipboardDeps): Promise<string> {
  const readText = deps.clipboard?.readText;
  if (!readText) return '';
  try {
    return (await readText()) || '';
  } catch {
    return '';
  }
}
