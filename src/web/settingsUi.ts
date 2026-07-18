// The app-wide settings modal: a tabbed shell (hub-style chrome); each tab is
// a self-contained section module rendering into the content area.
import { el } from './dom';
import { registerModal } from './modalRegistry';
import { renderNetboxSection } from './settingsNetbox';
import { renderProxmoxSection } from './settingsProxmox';

export type SettingsTab = 'netbox' | 'proxmox';

type Section = { label: string; render: (content: HTMLElement, close: () => void) => void | Promise<void> };

const SECTIONS: Record<SettingsTab, Section> = {
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
};

export function openSettingsModal(tab: SettingsTab = 'netbox', onClose?: () => void): void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal settings-modal' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { unregister(); document.removeEventListener('keydown', onKey); backdrop.remove(); onClose?.(); }
  document.addEventListener('keydown', onKey);
  // Body-mounted: logout/session-expiry teardown closes it via the registry.
  const unregister = registerModal(close);
  // Only close on a genuine backdrop click (see the box modal for why mousedown
  // must also have started on the backdrop).
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  function selectTab(t: SettingsTab) {
    for (const b of tabStrip.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    void SECTIONS[t].render(content, close);
  }
  for (const [key, s] of Object.entries(SECTIONS) as [SettingsTab, Section][]) {
    tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': key, onclick: () => selectTab(key) }, [s.label]));
  }

  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Settings']), el('button', { type: 'button', class: 'pve-close', title: 'Close', onclick: close }, ['✕'])]),
    tabStrip, content,
  );
  backdrop.append(modal);
  document.body.append(backdrop);
  selectTab(tab);
}
