// Phone composer: type in a real native field (where the IME can word-replace,
// autocorrect and cursor-edit freely — the pty sees nothing until Send), then
// one tap transmits the text plus Enter. Pure half here is unit-tested; the
// DOM row builder added alongside is e2e-covered (vitest has no DOM).

// Collapse first, then strip: a raw newline reaching the pty IS Enter (it
// would submit mid-text), and a tab would trigger shell completion — both are
// \s, so they fold to spaces. What survives the fold (ESC, DEL, C1) is
// stripped so a pasted artefact can never open an escape sequence in the pane.
// Same posture as voiceText.js's transcript normalization.
export function sendTextOf(draft: string): string {
  return draft
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
}
