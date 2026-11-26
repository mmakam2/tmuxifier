// Which agent runs in a pane, by its foreground command. Keep the opencode
// pattern identical to the plugin's own pane check, and the codex/pi/agy patterns
// identical to the OSC reporter asset's `OSC_AGENTS` (pinned by a test).
export function agentKindOf(paneCmd) {
  const c = String(paneCmd || '');
  if (/^claude(-|$)/.test(c)) return 'claude';
  if (/^opencode(-|$)/.test(c)) return 'opencode';
  if (/^codex(-|$)/.test(c)) return 'codex';
  if (/^pi(-|$)/.test(c)) return 'pi';
  if (/^agy(-|$)/.test(c)) return 'agy';
  return null;
}
