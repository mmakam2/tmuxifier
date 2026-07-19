import { el, makeRadio } from './dom';
import { toolsCheckboxGroup } from './provisionTools';
import { api, type AiAuthStatus, type AiAuthCliStatus } from './api';

export interface SetupOptionsValues { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean }

// Pure text for one CLI's readiness row — exported for node-env tests, so it
// must stay DOM-free.
export function seedStatusLine(cli: 'claude' | 'codex', s: AiAuthCliStatus | null): string {
  if (!s) return `${cli}: status unknown`;
  if (s.ready) return `${cli}: ● ready`;
  const fix = cli === 'claude'
    ? 'run `claude setup-token` on the Tmuxifier host, put the token in .env as TMUXIFIER_CLAUDE_OAUTH_TOKEN, then restart Tmuxifier'
    : 'run `codex login` on the Tmuxifier host';
  return `${cli}: ○ not set up — ${fix}`;
}

// Two forms can be open at once (hub tab + box modal); a per-instance radio
// name keeps their shell selections independent.
let shellRadioSeq = 0;

const SEED_TRUST_TITLE = 'Copies subscription credentials from the Tmuxifier host to this box — seed only boxes you trust with your own login';

// Shared post-create setup options — Terminal (tmux + shell framework),
// Tools, AI auth seeding — used by the Add/Edit Box modal and the Proxmox
// hub's Provision tab. Fetches seed readiness on creation; a failed fetch
// degrades to "status unknown" with the checkbox left enabled (the
// post-provision per-target results still report the truth).
export function createSetupOptionsForm(initial: { ohMyTmux?: boolean } = {}): {
  element: HTMLElement;
  values: () => SetupOptionsValues;
  applySeedStatus: (s: AiAuthStatus | null) => void;
} {
  const section = (title: string, ...children: (Node | string)[]) =>
    el('fieldset', { class: 'setup-section' }, [el('legend', {}, [title]), ...children]);

  const omt = el('input', { type: 'checkbox' }) as HTMLInputElement;
  omt.checked = initial.ohMyTmux !== false;
  const omtField = el('label', { class: 'check-field' }, [omt, el('span', {}, ['Install Oh My Tmux if missing'])]);

  const shellName = `setup-shell-${++shellRadioSeq}`;
  const shNone = makeRadio(shellName, 'none', 'None', true);
  const shZsh = makeRadio(shellName, 'omz', 'Oh My Zsh', false);
  const shBash = makeRadio(shellName, 'omb', 'Oh My Bash', false);
  const shellGroup = el('fieldset', { class: 'radio-group' }, [el('legend', {}, ['Shell framework']), shNone.wrap, shZsh.wrap, shBash.wrap]);

  const tools = toolsCheckboxGroup();
  tools.element.classList.add('setup-section');

  const seedInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const seedField = el('label', {
    class: 'check-field',
    title: SEED_TRUST_TITLE,
  }, [seedInput, el('span', {}, ['Seed AI CLI auth (claude/codex) from this host'])]);
  const claudeRow = el('div', { class: 'seed-status' }, ['claude: checking…']);
  const codexRow = el('div', { class: 'seed-status' }, ['codex: checking…']);

  function applySeedStatus(s: AiAuthStatus | null) {
    claudeRow.textContent = seedStatusLine('claude', s?.claude ?? null);
    codexRow.textContent = seedStatusLine('codex', s?.codex ?? null);
    const bothUnready = !!s && !s.claude.ready && !s.codex.ready;
    seedInput.disabled = bothUnready;
    seedField.title = bothUnready
      ? 'Nothing to seed yet — set up claude and/or codex auth on the Tmuxifier host first'
      : SEED_TRUST_TITLE;
    if (bothUnready) {
      seedInput.checked = false;
    }
  }
  void api.aiAuthStatus().then(applySeedStatus).catch(() => applySeedStatus(null));

  const element = el('div', { class: 'setup-options' }, [
    section('Terminal', omtField, shellGroup),
    tools.element,
    section('AI auth seeding', seedField, claudeRow, codexRow),
  ]);

  return {
    element,
    values: () => ({
      ohMyTmux: omt.checked,
      ohMyZsh: shZsh.input.checked,
      ohMyBash: shBash.input.checked,
      tools: tools.selected(),
      seedAiAuth: seedInput.checked,
    }),
    applySeedStatus,
  };
}
