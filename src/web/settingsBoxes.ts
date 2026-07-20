// Settings → Boxes: export/import the box list as a JSON file. Relocated out of
// the sidebar brand actions, which are reserved for the routinely used controls
// (collapse, settings, logout) — export/import is a rare admin action.
import { el } from './dom';
import { api } from './api';

// Pure so it can be tested without a DOM (the repo's web-test convention).
export function importSummary(added: number, skipped: number): string {
  const noun = added === 1 ? 'box' : 'boxes';
  return `Imported ${added} ${noun}${skipped ? `, ${skipped} skipped` : ''}`;
}

export function renderBoxesSection(content: HTMLElement): void {
  // Settings sections have no access to main.ts's private showToast, so results
  // land on an inline status line — the convention every other section follows.
  const status = el('div', { class: 'pve-sub' });
  const setStatus = (msg: string, isError = false) => {
    status.className = isError ? 'pve-err' : 'pve-sub';
    status.textContent = msg;
  };

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true }) as HTMLInputElement;
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = ''; // reset so re-selecting the same file fires change again
    if (!picked) return;
    try {
      const payload = JSON.parse(await picked.text());
      const { added, skipped } = await api.importBoxes(payload);
      // The dashboard owns the box list and repaints on this event (main.ts).
      window.dispatchEvent(new Event('tmuxifier:boxes-changed'));
      setStatus(importSummary(added.length, skipped));
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`, true);
    }
  });

  const exportBtn = el('button', {
    type: 'button', class: 'pve-primary', onclick: () => {
      // Same-origin GET navigation: the session cookie rides along and the
      // server's Content-Disposition names the saved file.
      const a = document.createElement('a');
      a.href = '/api/export';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  }, ['Export boxes']);

  const importBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => file.click() }, ['Import boxes…']);

  content.replaceChildren(
    el('h3', {}, ['Boxes']),
    el('p', { class: 'pve-sub' }, ['Export writes your box list to a JSON file. Import accepts a file produced by the export button — ids are re-minted, and duplicate or unsafe entries are skipped.']),
    el('div', { class: 'pve-inline' }, [exportBtn, importBtn]),
    status,
    file,
  );
}
