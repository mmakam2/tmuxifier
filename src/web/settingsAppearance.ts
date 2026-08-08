import { el } from './dom';
import { CLAWD_VARIANTS, buildClawdVariant, currentClawdVariant, setClawdVariant } from './clawd';
import { THEMES } from './themes';
import { applyTheme, currentTheme } from './theme';
import { api } from './api';

// Settings → Appearance: theme + working-agent animation. Both persist
// server-side (data/ui-settings.json) so every browser follows one setting;
// no Save button — selecting a row applies instantly and PATCHes. A failed
// save keeps the local apply (it works this session) and says so, rather
// than yanking a theme the operator is already looking at.
export function renderAppearanceSection(content: HTMLElement): void {
  const note = el('p', { class: 'pve-sub appearance-save-note' }, ['']);
  const save = (patch: { theme?: string; clawdAnim?: string }) => {
    api.patchUiSettings(patch)
      .then(() => { note.textContent = ''; })
      .catch(() => { note.textContent = 'Couldn’t save to the server — applied in this browser for now.'; });
  };
  const themeRows = THEMES.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'ui-theme', value: id }) as HTMLInputElement;
    radio.checked = id === currentTheme();
    radio.onchange = () => { if (radio.checked) { applyTheme(id); save({ theme: id }); } };
    return el('label', { class: 'check-field appearance-row' }, [
      radio, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  const clawdRows = CLAWD_VARIANTS.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'clawd-anim', value: id }) as HTMLInputElement;
    radio.checked = id === currentClawdVariant();
    radio.onchange = () => { if (radio.checked) { setClawdVariant(id); save({ clawdAnim: id }); } };
    // The preview is the real builder + the real CSS classes, so it cannot
    // drift from what the chips render.
    const preview = el('span', { class: 'appearance-prev' }, [buildClawdVariant(id)]);
    return el('label', { class: 'check-field appearance-row' }, [
      radio, preview, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  content.replaceChildren(
    el('h3', {}, ['Appearance']),
    el('div', { class: 'pve-eyebrow' }, ['Theme']),
    ...themeRows,
    el('div', { class: 'pve-eyebrow' }, ['Working-agent animation']),
    ...clawdRows,
    note,
    el('p', { class: 'pve-sub' }, ['Saved on the server: every browser follows on its next load; this one switches instantly. Animation applies to the sidebar badge, pane chips, and the dashboard fleet strip on their next status refresh. Reduced-motion keeps every choice still.']),
  );
}
