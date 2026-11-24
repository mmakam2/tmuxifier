import { el } from './dom';

// Curated provision-time tools. Ids must mirror TOOL_IDS in
// src/server/boxActions.js (locked by test/provisionTools.test.js); the server
// is the validation authority.
//
// `group` only decides which labelled block of the checklist a tool is shown
// in. Each group is one contiguous run of the catalog (pinned by
// test/boxModalView.test.js), so the checklist still reads in install order.
export type ToolGroupKey = 'system' | 'agent';
export const TOOL_GROUPS: { key: ToolGroupKey; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'agent', label: 'Agent CLIs' },
];

export const PROVISION_TOOLS: { id: string; label: string; group: ToolGroupKey }[] = [
  { id: 'upgrade', label: 'System update & upgrade', group: 'system' },
  { id: 'curl', label: 'curl', group: 'system' },
  { id: 'git', label: 'git', group: 'system' },
  { id: 'gh', label: 'GitHub CLI (gh)', group: 'system' },
  // The major mirrors NODE_MAJOR in boxActions.js (pinned by the same test).
  { id: 'node', label: 'Node.js 26 + npm', group: 'system' },
  { id: 'bubblewrap', label: 'Bubblewrap', group: 'system' },
  { id: 'codex', label: 'Codex', group: 'agent' },
  { id: 'claude', label: 'Claude Code', group: 'agent' },
  { id: 'agy', label: 'Antigravity (agy)', group: 'agent' },
  { id: 'opencode', label: 'OpenCode', group: 'agent' },
  { id: 'pi', label: 'pi', group: 'agent' },
];

export function toolsByGroup() {
  return TOOL_GROUPS.map((g) => ({ ...g, tools: PROVISION_TOOLS.filter((t) => t.group === g.key) }));
}

// Shared "Tools" checkbox group for the provision form and the Add/Edit Box
// modal. DOM-building only — keep logic out so the node-env tests can import
// PROVISION_TOOLS without a document.
//
// `notes` maps a tool id to what ticking it does beyond installing the CLI. A
// note is shown only while its tool is ticked: that is when it is a fact about
// this run, and the rest of the time it is a paragraph nobody asked for.
export function toolsCheckboxGroup(notes: Record<string, string> = {}): { element: HTMLFieldSetElement; selected: () => string[] } {
  const inputs: { id: string; input: HTMLInputElement; note: HTMLElement | null }[] = [];
  const noteBox = el('div', { class: 'tools-notes' });
  const syncNotes = () => {
    for (const x of inputs) if (x.note) x.note.hidden = !x.input.checked;
    noteBox.hidden = !inputs.some((x) => x.note && x.input.checked);
  };
  const blocks = toolsByGroup().map((g) => {
    const grid = el('div', { class: 'tools-grid' });
    for (const t of g.tools) {
      const input = el('input', { type: 'checkbox', value: t.id }) as HTMLInputElement;
      input.addEventListener('change', syncNotes);
      grid.append(el('label', { class: 'check-field' }, [input, el('span', {}, [t.label])]));
      const note = Object.hasOwn(notes, t.id) ? el('div', { class: 'setup-hint' }, [notes[t.id]]) : null;
      if (note) noteBox.append(note);
      inputs.push({ id: t.id, input, note });
    }
    // role=group, not a nested fieldset: one legend per level is enough chrome.
    return el('div', { class: 'tools-group', role: 'group', 'aria-label': g.label }, [el('div', { class: 'tools-group-label' }, [g.label]), grid]);
  });
  const group = el('fieldset', { class: 'setup-section' }, [el('legend', {}, ['Tools']), ...blocks, noteBox]) as HTMLFieldSetElement;
  syncNotes();
  return {
    element: group,
    selected: () => inputs.filter((x) => x.input.checked).map((x) => x.id),
  };
}
