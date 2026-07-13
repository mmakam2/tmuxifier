// Pure helpers for terminal file uploads (paste/drag-drop). Like clipboard.ts,
// no direct DOM/global access — callers hand in the event payloads — so all of
// this is unit-testable in Node.

// Mirror of the server allowlist in src/server/uploads.js (NAME_RE) — keep in
// sync. The server is authoritative; this only makes friendly names client-side.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

// Coerce a filename toward the server's allowlist: replace disallowed chars,
// strip a leading '-'/'.'/space run (option/hidden-file safety), cap length.
// Returns '' when nothing salvageable remains (caller synthesizes a name).
export function sanitizeUploadName(name: string): string {
  const replaced = String(name || '').replace(/[^A-Za-z0-9 ._-]/g, '_');
  const trimmed = replaced.replace(/^[-._ ]+/, '').slice(0, 128).trim();
  return NAME_RE.test(trimmed) ? trimmed : '';
}

// Pasted clipboard images arrive as nameless blobs ("image.png" or '') —
// synthesize a timestamped name from the MIME type for those.
export function uploadName(file: { name?: string; type?: string }, now: number): string {
  const sanitized = sanitizeUploadName(file.name || '');
  if (sanitized) return sanitized;
  const ext = EXT_BY_MIME[file.type || ''] || 'bin';
  return `pasted-${now}.${ext}`;
}

// Extract the file entries from a paste/drop DataTransfer. Structural typing
// (not the DOM DataTransfer) so tests can pass plain objects.
export function filesFromDataTransfer<T>(
  dt: { items?: ArrayLike<{ kind: string; getAsFile(): T | null }>; files?: ArrayLike<T> } | null | undefined,
): T[] {
  if (!dt) return [];
  const out: T[] = [];
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files) out.push(...Array.from(dt.files));
  return out;
}

// What gets typed into the PTY after an upload: the absolute path, always
// single-quoted (embedded quotes escaped the sh way), plus a trailing space —
// the same convention terminals use for drag-drop, which CLIs parse as a path.
export function pathInjection(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}' `;
}

export function sizeError(size: number, maxBytes: number): string | null {
  if (size <= maxBytes) return null;
  return `file too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`;
}

// Server error messages get echoed into the terminal — strip anything that
// could act as an escape sequence.
export function termSafe(s: string): string {
  return String(s).replace(/[^\x20-\x7e]/g, '');
}
