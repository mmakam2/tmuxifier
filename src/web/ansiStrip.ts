// Escape stripper and preview shaping for the agent switcher. Pane content comes from
// `tmux capture-pane -e` and is untrusted box output: it is shown only as plain text.
// The three expressions mirror src/mcp/shape.js (stripSgr); a test compares the two.

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC2 = /\x1b[@-Z\\-_]/g;
// Every C0 control except \t (0x09) and \n (0x0a), DEL, and C1. This also removes the
// ESC byte of any escape the patterns above did not match (unterminated at the end).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function stripAnsi(text: string): string {
  return String(text ?? '').replace(OSC, '').replace(CSI, '').replace(ESC2, '').replace(CONTROLS, '');
}

export function previewText(content: string, maxLines = 40): string {
  // trimEnd, not /\s+$/: the regex backtracks quadratically on a long blank run.
  const rows = stripAnsi(content).split('\n').map((r) => r.trimEnd());
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.slice(-maxLines).join('\n');
}
