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

// ~4 lines at the field's 20px line-height plus padding; past this the field
// scrolls internally instead of eating more terminal rows.
export const COMPOSER_FIELD_MAX_PX = 96;

export interface ComposerRow {
  el: HTMLElement;
  field: HTMLTextAreaElement;
  appendDraft(text: string): void;
}

// DOM half — e2e-covered. Bar conventions throughout: pointerdown +
// preventDefault so a tap never moves focus off the element that should hold
// it (here, the FIELD keeps focus when ➤ is tapped, so the soft keyboard
// stays up), plus the `detail === 0` click path for keyboard/AT activation.
export function buildComposerRow(deps: { send(d: string): boolean; onGrow?(): void }): ComposerRow {
  const el = document.createElement('div');
  el.className = 'composer-row';
  const field = document.createElement('textarea');
  field.className = 'composer-field';
  field.rows = 1;
  field.setAttribute('aria-label', 'message composer');
  const grow = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_FIELD_MAX_PX)}px`;
    deps.onGrow?.();
  };
  field.addEventListener('input', grow);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = '➤';
  sendBtn.setAttribute('aria-label', 'send');
  const fire = () => {
    // An empty (or whitespace-only) draft sends bare Enter — the keyboard-less
    // submit for "press Enter to continue" prompts. The field clears only when
    // a live pane accepted the bytes: Send must never destroy a draft it could
    // not deliver (setup/stopped panes have no terminal behind them).
    if (deps.send(sendTextOf(field.value) + '\r')) {
      field.value = '';
      grow();
    }
  };
  sendBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fire(); });
  sendBtn.addEventListener('click', (ev) => { if (ev.detail === 0) fire(); });
  el.append(field, sendBtn);
  return {
    el,
    field,
    appendDraft(text: string): void {
      const t = text.trim();
      if (!t) return;
      const v = field.value;
      field.value = v && !/\s$/.test(v) ? `${v} ${t}` : v + t;
      grow();
    },
  };
}
