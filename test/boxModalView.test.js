import { test, expect } from 'vitest';
import { boxModalTabs, BOX_MODAL_TAB_LABELS, setupSelectionCount, tabMark } from '../src/web/boxModalView.ts';
import { PROVISION_TOOLS, TOOL_GROUPS, toolsByGroup } from '../src/web/provisionTools.ts';
import { TOOL_IDS } from '../src/server/boxActions.js';

const NONE = { ohMyTmux: false, ohMyZsh: false, ohMyBash: false, tools: [], seedAiAuth: false, scriptId: null, scriptName: null };

// Agent messaging and workers belong to a box that exists (their routes take a
// box id), so Add Box never offers the tab rather than showing it empty.
test('Edit Box has three tabs, Add Box has no Agents tab', () => {
  expect(boxModalTabs(true)).toEqual(['box', 'setup', 'agents']);
  expect(boxModalTabs(false)).toEqual(['box', 'setup']);
  for (const t of boxModalTabs(true)) expect(BOX_MODAL_TAB_LABELS[t].trim().length).toBeGreaterThan(0);
});

// The Setup tab is not on screen when the modal opens, and Add Box opens with
// Oh My Tmux ticked: the count on the tab is what keeps a selection that will
// change the box from being out of sight.
test('setupSelectionCount counts every thing a setup run was asked to install', () => {
  expect(setupSelectionCount(NONE)).toBe(0);
  expect(setupSelectionCount({ ...NONE, ohMyTmux: true })).toBe(1);
  expect(setupSelectionCount({ ...NONE, ohMyZsh: true })).toBe(1);
  expect(setupSelectionCount({ ...NONE, ohMyBash: true })).toBe(1);
  expect(setupSelectionCount({ ...NONE, tools: ['git', 'pi'] })).toBe(2);
  expect(setupSelectionCount({ ...NONE, seedAiAuth: true })).toBe(1);
  expect(setupSelectionCount({ ...NONE, scriptId: 'fs-1', scriptName: 'bootstrap' })).toBe(1);
  expect(setupSelectionCount({ ohMyTmux: true, ohMyZsh: true, ohMyBash: false, tools: ['claude'], seedAiAuth: true, scriptId: 'fs-1', scriptName: null })).toBe(5);
});

test('a tab is marked only when it holds something Save will act on, and the mark is in its accessible name', () => {
  expect(tabMark('box', { setupCount: 3, agentsEdited: true })).toBeNull();
  expect(tabMark('setup', { setupCount: 0, agentsEdited: true })).toBeNull();
  expect(tabMark('setup', { setupCount: 1, agentsEdited: false })).toEqual({ text: '1', label: 'Setup, 1 selected' });
  expect(tabMark('setup', { setupCount: 4, agentsEdited: false })).toEqual({ text: '4', label: 'Setup, 4 selected' });
  expect(tabMark('agents', { setupCount: 4, agentsEdited: false })).toBeNull();
  expect(tabMark('agents', { setupCount: 0, agentsEdited: true })).toEqual({ text: 'edited', label: 'Agents, unsaved changes' });
});

// The checklist is shown in two labelled groups. Each group must be one
// contiguous run of the server's catalog, so reading the groups top to bottom
// is still the install order and no tool can fall out of both.
test('every tool sits in exactly one group and the groups follow the catalog order', () => {
  const keys = TOOL_GROUPS.map((g) => g.key);
  for (const t of PROVISION_TOOLS) expect(keys).toContain(t.group);
  expect(toolsByGroup().flatMap((g) => g.tools.map((t) => t.id))).toEqual(TOOL_IDS);
  expect(toolsByGroup().map((g) => g.label)).toEqual(['System', 'Agent CLIs']);
  expect(toolsByGroup().find((g) => g.key === 'agent').tools.map((t) => t.id)).toEqual(['codex', 'claude', 'agy', 'opencode', 'pi']);
});
