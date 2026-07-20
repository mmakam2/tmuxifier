// Pure normalization of a whisper transcript before it is typed into a tmux
// pane. Three of these rules are load-bearing rather than cosmetic:
//
//  - Newline collapse: whisper emits one line per segment, and a newline
//    delivered through `tmux send-keys` is Enter — it would submit a
//    half-finished prompt.
//  - Control-character stripping: a transcription artefact must never be able
//    to emit an escape sequence into the pane. This is the same class of
//    control as upload.js's filename allowlist, but deliberately wider: we
//    keep non-ASCII, because a multilingual model produces legitimate
//    non-English text. Only C0/C1 controls and DEL are removed.
//  - Length cap: bounds the argv a single dictation can produce.

export const MAX_TRANSCRIPT_CHARS = 4000;

// [00:00:00.000 --> 00:00:05.000] segment headers, emitted when whisper is
// asked for timestamped output.
const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g;

// whisper's own silence sentinels.
const SENTINEL_RE = /\[(?:BLANK_AUDIO|SOUND|MUSIC|NOISE)\]/gi;

// C0 controls, DEL, and C1 controls, written as explicit escapes so this
// source stays pure ASCII. Deliberately NOT a general "non-printable"
// filter: accented and astral-plane characters must survive, because a
// multilingual model produces legitimate non-English text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export function normalizeTranscript(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw
    .replace(TIMESTAMP_RE, ' ')
    .replace(SENTINEL_RE, ' ')
    // Control removal runs after the marker passes but before whitespace
    // collapse, so a stripped \n still becomes a word separator rather than
    // gluing two segments together.
    .replace(/[\r\n\t]/g, ' ')
    .replace(CONTROL_RE, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TRANSCRIPT_CHARS
    ? collapsed.slice(0, MAX_TRANSCRIPT_CHARS).trimEnd()
    : collapsed;
}
