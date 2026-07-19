import { el } from './dom';
import { NOTIFY_KINDS, loadNotifyPrefs, saveNotifyPrefs } from './notifyPrefs';

// Settings → Notifications: browser-notification permission flow plus per-kind
// toggles. Per-browser (localStorage + the Notification permission are both
// per-browser). Every event still enters the events log regardless of these.
export function renderNotificationsSection(content: HTMLElement): void {
  const prefs = loadNotifyPrefs();
  const supported = typeof Notification !== 'undefined';

  const permLine = el('div', { class: 'pve-sub' });
  const enableBtn = el('button', { type: 'button', class: 'pve-primary' }, ['Enable browser notifications']) as HTMLButtonElement;
  const refreshPerm = () => {
    if (!supported) { permLine.textContent = 'This browser does not support notifications.'; enableBtn.style.display = 'none'; return; }
    const p = Notification.permission;
    permLine.textContent = p === 'granted'
      ? 'Browser notifications: enabled.'
      : p === 'denied'
        ? 'Browser notifications are blocked — re-enable them in your browser\'s site settings for this page.'
        : 'Browser notifications are not enabled yet.';
    enableBtn.style.display = p === 'default' ? '' : 'none';
  };
  enableBtn.onclick = () => { void Notification.requestPermission().then(refreshPerm); };
  refreshPerm();

  const rows = NOTIFY_KINDS.map(({ kind, label }) => {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = !!prefs[kind];
    cb.onchange = () => {
      prefs[kind] = cb.checked;
      saveNotifyPrefs(prefs);
      // Let the badge recount immediately instead of waiting up to POLL_MS for
      // the next health poll to pick up the new filter.
      window.dispatchEvent(new Event('tmuxifier:notify-prefs-changed'));
    };
    return el('label', { class: 'check-field' }, [cb, el('span', {}, [label])]);
  });

  content.replaceChildren(
    el('h3', {}, ['Notifications']),
    permLine,
    enableBtn,
    el('div', { class: 'pve-eyebrow' }, ['Notify me about']),
    ...rows,
    el('p', { class: 'pve-sub' }, ['These settings are per-browser. Every event always appears in the events log regardless of what is selected here.']),
  );
}
