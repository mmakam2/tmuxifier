import { el } from './dom';
import { DEFAULT_HOTKEYS, HOTKEY_LABEL, comboLabel, hotkeys, validateRecorded, type HotkeyAction } from './hotkeys';

// Settings → Hotkeys: remap the agent switcher's and voice dictation's chords
// for this browser (hotkeys.ts owns the rules and the localStorage mapping;
// nothing here reaches the server).
//
// Record listens on `document` in the CAPTURE phase and swallows every keydown
// it reads (preventDefault + stopPropagation), bare modifiers, Tab and Escape
// included: that is what keeps openModal's document Escape handler and its
// backdrop Tab trap from ever seeing a recorded key. Escape therefore cancels
// the recording only, and a second Escape closes Settings as usual. While a
// recording runs, `hotkeys.recording()` is true, which the switcher and the
// voice handler read to stay inert. stopHotkeyRecording is the section's
// dispose, so leaving the tab or closing the modal mid-record ends it.

const ACTIONS: HotkeyAction[] = ['switcher', 'voice'];
const otherOf = (a: HotkeyAction): HotkeyAction => (a === 'switcher' ? 'voice' : 'switcher');

// Ends the one live recording, if any (at most one row records at a time).
let stopActive: (() => void) | null = null;

export function stopHotkeyRecording(): void {
  const stop = stopActive;
  stopActive = null;
  stop?.();
}

export function renderHotkeysSection(content: HTMLElement): void {
  const rows = ACTIONS.map((action) => {
    const combo = el('kbd', { class: 'hotkey-combo' }, [comboLabel(hotkeys.get(action))]);
    const record = el('button', { type: 'button', class: 'pve-btn hotkey-record', 'aria-pressed': 'false' }, ['Record']);
    const reset = el('button', { type: 'button', class: 'pve-btn hotkey-reset', title: `Reset to ${comboLabel(DEFAULT_HOTKEYS[action])}` }, ['Reset to default']);
    const error = el('p', { class: 'hotkey-error', role: 'alert' });
    const node = el('div', { class: 'hotkey-row', 'data-action': action }, [
      el('span', { class: 'hotkey-name' }, [HOTKEY_LABEL[action]]), combo, record, reset, error,
    ]);
    return { action, node, combo, record, reset, error };
  });

  // A change to one row can free (or take) the other's default, so both repaint.
  const repaint = () => {
    for (const r of rows) r.combo.textContent = comboLabel(hotkeys.get(r.action));
  };

  for (const r of rows) {
    const start = () => {
      stopHotkeyRecording();
      const onKey = (ev: KeyboardEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Escape') {
          stopHotkeyRecording();
          return;
        }
        const other = otherOf(r.action);
        const verdict = validateRecorded(ev, { action: other, combo: hotkeys.get(other) });
        if (!verdict) return; // a bare modifier: keep listening
        const stored = verdict.ok ? hotkeys.set(r.action, verdict.combo) : verdict;
        if (!stored.ok) {
          r.error.textContent = stored.reason;
          return;
        }
        stopHotkeyRecording();
        repaint();
      };
      document.addEventListener('keydown', onKey, true);
      hotkeys.setRecording(true);
      r.error.textContent = '';
      r.record.textContent = 'Press a combo…';
      r.record.setAttribute('aria-pressed', 'true');
      stopActive = () => {
        document.removeEventListener('keydown', onKey, true);
        hotkeys.setRecording(false);
        r.error.textContent = '';
        r.record.textContent = 'Record';
        r.record.setAttribute('aria-pressed', 'false');
      };
    };
    r.record.onclick = () => {
      // The pressed button toggles: clicking it again cancels.
      if (r.record.getAttribute('aria-pressed') === 'true') stopHotkeyRecording();
      else start();
    };
    r.reset.onclick = () => {
      stopHotkeyRecording();
      const v = hotkeys.reset(r.action);
      if (!v.ok) {
        r.error.textContent = v.reason;
        return;
      }
      r.error.textContent = '';
      repaint();
    };
  }

  content.replaceChildren(
    el('h3', {}, ['Hotkeys']),
    el('div', { class: 'pve-eyebrow' }, ['Keyboard chords']),
    el('div', { class: 'hotkey-list' }, rows.map((r) => r.node)),
    el('p', { class: 'pve-sub' }, ['These mappings apply to this browser only.']),
    el('p', { class: 'pve-sub' }, ['Some browsers keep certain combos for themselves. Edge and Firefox on Windows use Ctrl+Shift+K for "duplicate tab" and the web console. If the switcher doesn\'t respond, record another combo.']),
  );
}
