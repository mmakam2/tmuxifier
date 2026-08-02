import { el } from './dom';
import { CLAWD_VARIANTS, buildClawdVariant, loadClawdVariant, saveClawdVariant } from './clawd';

// Settings → Appearance: which animation the working-agent indicator plays.
// Per-browser (localStorage, the notifyPrefs pattern) — a display preference,
// not server state. No Save button: selecting a row persists immediately, and
// the chips pick it up on their next status repaint because every render site
// rebuilds its indicator via buildClawd().
export function renderAppearanceSection(content: HTMLElement): void {
  const current = loadClawdVariant();
  const rows = CLAWD_VARIANTS.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'clawd-anim', value: id }) as HTMLInputElement;
    radio.checked = id === current;
    radio.onchange = () => { if (radio.checked) saveClawdVariant(id); };
    // The preview is the real builder + the real CSS classes, so it cannot
    // drift from what the chips render.
    const preview = el('span', { class: 'appearance-prev' }, [buildClawdVariant(id)]);
    return el('label', { class: 'check-field appearance-row' }, [
      radio, preview, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  content.replaceChildren(
    el('h3', {}, ['Appearance']),
    el('div', { class: 'pve-eyebrow' }, ['Working-agent animation']),
    ...rows,
    el('p', { class: 'pve-sub' }, ['Per-browser. Applies to the sidebar badge, pane chips, and the dashboard fleet strip on their next status refresh. Reduced-motion keeps every choice still.']),
  );
}
