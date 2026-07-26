// The app-wide settings modal: a tabbed shell (hub-style chrome); each tab is
// a self-contained section module rendering into the content area.
import { el, openModal, syncTabSelection, wireTabStrip } from './dom';
import { registerModal } from './modalRegistry';
import { renderBoxesSection } from './settingsBoxes';
import { renderServicesSection } from './settingsServices';
import { renderNetboxSection } from './settingsNetbox';
import { renderProxmoxSection } from './settingsProxmox';
import { renderPasskeysSection } from './settingsPasskeys';
import { renderVoiceSection } from './settingsVoice';
import { renderNotificationsSection } from './settingsNotifications';

export type SettingsTab = 'boxes' | 'services' | 'netbox' | 'proxmox' | 'passkeys' | 'voice' | 'notifications';

type Section = { label: string; render: (content: HTMLElement, close: () => void) => void | Promise<void> };

const SECTIONS: Record<SettingsTab, Section> = {
  // Object.entries order builds the tab strip, so this is the leftmost tab.
  boxes: { label: 'Boxes', render: (content) => renderBoxesSection(content) },
  services: { label: 'Services', render: async (content) => { await renderServicesSection(content); } },
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
  passkeys: { label: 'Passkeys', render: (content) => renderPasskeysSection(content) },
  // renderVoiceSection resolves with the status it painted (the install-settle
  // loop checks it); the tab shell only cares that it finished.
  voice: { label: 'Voice', render: async (content) => { await renderVoiceSection(content); } },
  notifications: { label: 'Notifications', render: (content) => renderNotificationsSection(content) },
};

export function openSettingsModal(tab: SettingsTab = 'netbox', onClose?: () => void): void {
  const modal = el('div', { class: 'modal settings-modal' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });

  const { close } = openModal({ modal, onClose: () => { unregister(); onClose?.(); } });
  // Body-mounted: logout/session-expiry teardown closes it via the registry.
  const unregister = registerModal(close);

  function selectTab(t: SettingsTab) {
    syncTabSelection(tabStrip, t);
    void SECTIONS[t].render(content, close);
  }
  for (const [key, s] of Object.entries(SECTIONS) as [SettingsTab, Section][]) {
    tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': key, onclick: () => selectTab(key) }, [s.label]));
  }
  wireTabStrip(tabStrip, content, (k) => selectTab(k as SettingsTab));

  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Settings']), el('button', { type: 'button', class: 'pve-close', title: 'Close', 'aria-label': 'Close settings', onclick: close }, ['✕'])]),
    tabStrip, content,
  );
  selectTab(tab);
}
