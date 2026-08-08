import { el, field, makeRadio } from './dom';
import { toolsCheckboxGroup } from './provisionTools';
import { fleetScripts, sortScripts, type FleetScript } from './fleetScripts';
import { api, type AiAuthStatus, type AiAuthCliStatus } from './api';

// No claudeStatusline field: the statusline (and the agent-state hooks) ride
// the `claude` TOOLS entry — one knob for the whole Claude stack. The server
// still accepts the legacy flag from stale bundles.
export interface SetupOptionsValues {
  ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean;
  // The saved Fleet Command script to run last. `scriptId` is what selects;
  // `scriptName` rides along only as a display label the server freezes onto
  // the job, so a later rename cannot rewrite what that job says it ran.
  scriptId: string | null; scriptName: string | null;
}

export type SeedTone = 'ok' | 'bad' | 'unknown';

// The `POST /api/boxes/:id/setup` body for a form's values. A spread, not a
// field list: `openProvisionPanel` used to rebuild this object by hand and
// named every option except `claudeStatusline`, so the Add/Edit Box modal's
// "Push Claude Code statusline" checkbox opened a setup panel, ran a job, and
// never told the server to push anything. The Proxmox hub's Provision tab
// forwards `values()` whole and was unaffected. Spreading means the next
// option the form collects reaches the server without a second edit at the
// call site — the omission that caused this bug becomes unexpressible.
export function setupStartPayload(values: SetupOptionsValues): SetupOptionsValues {
  return { ...values, tools: values.tools ? [...values.tools] : [] };
}

// One CLI's readiness row, split around its status dot so the dot alone can be
// coloured (the row text stays muted). Pure — exported for node-env tests, so
// it must stay DOM-free. `before + dot + after` is the whole line.
export function seedStatusParts(cli: 'claude' | 'codex', s: AiAuthCliStatus | null): {
  tone: SeedTone; before: string; dot: string; after: string;
} {
  if (!s) return { tone: 'unknown', before: `${cli}: status unknown`, dot: '', after: '' };
  if (s.ready) return { tone: 'ok', before: `${cli}: `, dot: '●', after: ' ready' };
  const fix = cli === 'claude'
    ? 'run `claude setup-token` on the Tmuxifier host, put the token in .env as TMUXIFIER_CLAUDE_OAUTH_TOKEN, then restart Tmuxifier'
    : 'run `codex login` on the Tmuxifier host';
  return { tone: 'bad', before: `${cli}: `, dot: '○', after: ` not set up — ${fix}` };
}

/**
 * The two fields a script selection contributes to the setup payload. Pure, so
 * the picker's one piece of logic is testable in a DOM-free suite.
 *
 * `scriptId` is what selects — the server resolves it against
 * data/fleet-scripts.json — and `scriptName` rides along only as a display
 * label the server freezes onto the job. An id with no matching record still
 * selects (the server records a skip for it) but contributes no label: an
 * invented one would be a label for a script nobody can see.
 */
export function scriptSelection(list: FleetScript[], selectedId: string): { scriptId: string | null; scriptName: string | null } {
  if (!selectedId) return { scriptId: null, scriptName: null };
  return { scriptId: selectedId, scriptName: list.find((s) => s.id === selectedId)?.name ?? null };
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

  // One knob for the Claude stack: the `claude` TOOLS entry means CLI install
  // (skipped when already present) + statusline push + agent-state hooks. The
  // hint names all three so the checkbox says what it does; the old separate
  // "Push Claude Code statusline" checkbox is gone.
  const claudeHint = el('div', { class: 'seed-status' }, ['Claude Code also pushes this host’s statusline and the agent-state hooks; an existing install only gains what is missing.']);
  tools.element.append(claudeHint);

  const seedInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const seedField = el('label', {
    class: 'check-field',
    title: SEED_TRUST_TITLE,
  }, [seedInput, el('span', {}, ['Seed AI CLI auth (claude/codex) from this host'])]);
  const claudeRow = el('div', { class: 'seed-status' }, ['claude: checking…']);
  const codexRow = el('div', { class: 'seed-status' }, ['codex: checking…']);

  // Post-setup saved script. The select is a LOOKUP KEY picker — its values are
  // script ids and the server resolves them against data/fleet-scripts.json, so
  // nothing chosen here can reach a shell as text. Populated once on creation;
  // both empty-list and failed-fetch degrade in place to a disabled control with
  // a reason, the same posture the seed rows take, rather than presenting an
  // empty dropdown the operator cannot explain.
  const scriptSel = el('select', {}, [el('option', { value: '' }, ['None'])]) as HTMLSelectElement;
  const scriptWhen = el('div', { class: 'seed-status' }, [
    'Runs on the box after the tools, shell framework and AI-auth seeding, and before its tmux session is created.',
  ]);
  const scriptDesc = el('div', { class: 'seed-status' });
  let scriptList: FleetScript[] = [];

  function syncScriptDesc() {
    scriptDesc.textContent = scriptList.find((s) => s.id === scriptSel.value)?.description || '';
  }
  scriptSel.addEventListener('change', syncScriptDesc);

  function applyScripts(list: FleetScript[] | null) {
    if (!list) {
      scriptSel.disabled = true;
      scriptDesc.textContent = 'Saved scripts are unavailable.';
      return;
    }
    scriptList = sortScripts(list);
    if (!scriptList.length) {
      scriptSel.disabled = true;
      scriptDesc.textContent = 'No saved scripts — create one in Fleet Command.';
      return;
    }
    scriptSel.disabled = false;
    scriptSel.replaceChildren(
      el('option', { value: '' }, ['None']),
      ...scriptList.map((s) => el('option', { value: s.id }, [s.name])),
    );
    syncScriptDesc();
  }
  void fleetScripts.list().then(applyScripts).catch(() => applyScripts(null));

  function renderSeedRow(row: HTMLElement, cli: 'claude' | 'codex', s: AiAuthCliStatus | null) {
    const { tone, before, dot, after } = seedStatusParts(cli, s);
    row.replaceChildren(before, ...(dot ? [el('span', { class: `seed-dot ${tone}` }, [dot])] : []), after);
  }

  function applySeedStatus(s: AiAuthStatus | null) {
    renderSeedRow(claudeRow, 'claude', s?.claude ?? null);
    renderSeedRow(codexRow, 'codex', s?.codex ?? null);
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
    section('Post-setup script', field('Saved script', scriptSel), scriptWhen, scriptDesc),
  ]);

  return {
    element,
    values: () => ({
      ohMyTmux: omt.checked,
      ohMyZsh: shZsh.input.checked,
      ohMyBash: shBash.input.checked,
      tools: tools.selected(),
      seedAiAuth: seedInput.checked,
      ...scriptSelection(scriptList, scriptSel.value),
    }),
    applySeedStatus,
  };
}
