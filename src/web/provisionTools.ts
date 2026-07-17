// Curated provision-time tools. Ids must mirror TOOL_IDS in
// src/server/boxActions.js (locked by test/provisionTools.test.js); the server
// is the validation authority.
export const PROVISION_TOOLS: { id: string; label: string }[] = [
  { id: 'upgrade', label: 'System update & upgrade' },
  { id: 'curl', label: 'curl' },
  { id: 'git', label: 'git' },
  { id: 'gh', label: 'GitHub CLI (gh)' },
  { id: 'node', label: 'Node.js + npm' },
  { id: 'bubblewrap', label: 'Bubblewrap' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'agy', label: 'Antigravity CLI (agy)' },
];

// Shared "Additional tools" checkbox group for the provision form and the
// Add/Edit Box modal. DOM-building only — keep logic out so the node-env
// tests can import PROVISION_TOOLS without a document.
export function toolsCheckboxGroup(): { element: HTMLFieldSetElement; selected: () => string[] } {
  const group = document.createElement('fieldset');
  group.className = 'radio-group';
  const legend = document.createElement('legend');
  legend.textContent = 'Additional tools';
  group.append(legend);
  const inputs: { id: string; input: HTMLInputElement }[] = [];
  for (const t of PROVISION_TOOLS) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = t.id;
    const span = document.createElement('span');
    span.textContent = t.label;
    wrap.append(input, span);
    group.append(wrap);
    inputs.push({ id: t.id, input });
  }
  return {
    element: group,
    selected: () => inputs.filter((x) => x.input.checked).map((x) => x.id),
  };
}
