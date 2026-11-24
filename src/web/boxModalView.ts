// Pure half of the Add/Edit Box modal's tab strip (the DOM half is in main.ts).
//
// The modal holds three jobs that used to share one long scroll: the box's own
// record, a setup run, and what the box's agents may do. Each is a tab. One
// Save still applies all of them, so a tab that is not on screen carries a mark
// whenever it holds something that Save will act on.
import type { SetupOptionsValues } from './setupOptions';

export type BoxModalTab = 'box' | 'setup' | 'agents';

export const BOX_MODAL_TAB_LABELS: Record<BoxModalTab, string> = { box: 'Box', setup: 'Setup', agents: 'Agents' };

// Agent messaging and workers are settings of a box that exists (their routes
// take its id), so Add Box has no Agents tab.
export function boxModalTabs(isEdit: boolean): BoxModalTab[] {
  return isEdit ? ['box', 'setup', 'agents'] : ['box', 'setup'];
}

// How many things the setup run was asked to install. A shell framework is one
// choice however it is stored; a script counts once, by its id.
export function setupSelectionCount(v: SetupOptionsValues): number {
  return (v.ohMyTmux ? 1 : 0) + (v.ohMyZsh || v.ohMyBash ? 1 : 0) + v.tools.length + (v.seedAiAuth ? 1 : 0) + (v.scriptId ? 1 : 0);
}

export interface TabMarkState { setupCount: number; agentsEdited: boolean }

// `text` is what the chip shows; `label` is the tab's whole accessible name.
export function tabMark(tab: BoxModalTab, s: TabMarkState): { text: string; label: string } | null {
  if (tab === 'setup' && s.setupCount > 0) return { text: String(s.setupCount), label: `${BOX_MODAL_TAB_LABELS.setup}, ${s.setupCount} selected` };
  if (tab === 'agents' && s.agentsEdited) return { text: 'edited', label: `${BOX_MODAL_TAB_LABELS.agents}, unsaved changes` };
  return null;
}
