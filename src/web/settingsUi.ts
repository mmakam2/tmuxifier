// The app-wide settings modal: a tabbed shell (hub-style chrome); each tab is
// a self-contained section module rendering into the content area.
import { el, openModal, syncTabSelection, wireTabStrip } from './dom';
import { registerModal } from './modalRegistry';
import { renderBoxesSection } from './settingsBoxes';
import { renderServicesSection } from './settingsServices';
import { renderNetboxSection } from './settingsNetbox';
import { renderProxmoxSection } from './settingsProxmox';
import { renderPasskeysSection } from './settingsPasskeys';
import { renderVoiceSection, stopVoiceWatch } from './settingsVoice';
import { renderNotificationsSection } from './settingsNotifications';

export type SettingsTab = 'boxes' | 'services' | 'netbox' | 'proxmox' | 'passkeys' | 'voice' | 'notifications';

// `dispose` tears down anything a section leaves running after its content is
// replaced. Sections are otherwise stateless: only Voice owns a background job
// watch, and without a seam to stop it, it repainted whichever tab was open when
// the install finished and kept polling after the modal closed.
type Section = {
  label: string;
  render: (content: HTMLElement, close: () => void) => void | Promise<void>;
  dispose?: () => void;
};

const SECTIONS: Record<SettingsTab, Section> = {
  // Object.entries order builds the tab strip, so this is the leftmost tab.
  boxes: { label: 'Boxes', render: (content) => renderBoxesSection(content) },
  services: { label: 'Services', render: async (content) => { await renderServicesSection(content); } },
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
  passkeys: { label: 'Passkeys', render: (content) => renderPasskeysSection(content) },
  // renderVoiceSection resolves with the status it painted (the install-settle
  // loop checks it); the tab shell only cares that it finished.
  voice: { label: 'Voice', render: async (content) => { await renderVoiceSection(content); }, dispose: stopVoiceWatch },
  notifications: { label: 'Notifications', render: (content) => renderNotificationsSection(content) },
};

export function openSettingsModal(tab: SettingsTab = 'boxes', onClose?: () => void): void {
  const modal = el('div', { class: 'modal settings-modal' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });

  let current: SettingsTab | null = null;
  const disposeCurrent = () => {
    if (current) SECTIONS[current].dispose?.();
    current = null;
  };

  const { close } = openModal({ modal, onClose: () => { disposeCurrent(); unregister(); onClose?.(); } });
  // Body-mounted: logout/session-expiry teardown closes it via the registry.
  const unregister = registerModal(close);

  function selectTab(t: SettingsTab) {
    // Leaving a tab stops whatever it left running, before the next section
    // paints over its content.
    disposeCurrent();
    current = t;
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
