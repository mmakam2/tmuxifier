// Settings → Boxes: export/import the box list as a JSON file, fronted by a
// preview of what the export actually contains and a note on what it doesn't.
// Relocated out of the sidebar brand actions, which are reserved for the
// routinely used controls (collapse, settings, logout).
import { el } from './dom';
import { api, type Box } from './api';
import { fmtBytes } from './fmt';

// Pure so it can be tested without a DOM (the repo's web-test convention).
export function importSummary(added: number, skipped: number): string {
  const noun = added === 1 ? 'box' : 'boxes';
  return `Imported ${added} ${noun}${skipped ? `, ${skipped} skipped` : ''}`;
}

// The export-preview figures. Derived from the literal /api/export payload so
// the numbers describe the actual backup file, not a parallel computation.
export interface ExportStats {
  total: number; manual: number; proxmox: number; tagged: number;
  proxyJump: number; startupCommand: number; customPort: number; customUser: number;
}

const usedString = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

export function exportStats(payload: unknown): ExportStats {
  const stats: ExportStats = {
    total: 0, manual: 0, proxmox: 0, tagged: 0,
    proxyJump: 0, startupCommand: 0, customPort: 0, customUser: 0,
  };
  const boxes = (payload as { boxes?: unknown } | null)?.boxes;
  if (!Array.isArray(boxes)) return stats;
  stats.total = boxes.length;
  for (const raw of boxes) {
    const box = (raw ?? {}) as Partial<Box>;
    if (box.source === 'proxmox') stats.proxmox += 1; else stats.manual += 1;
    if (Array.isArray(box.tags) && box.tags.length > 0) stats.tagged += 1;
    if (usedString(box.proxyJump)) stats.proxyJump += 1;
    if (usedString(box.startupCommand)) stats.startupCommand += 1;
    if (box.port != null) stats.customPort += 1; // present = custom, even 22
    if (usedString(box.user)) stats.customUser += 1;
  }
  return stats;
}

export function exportSizeBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Mirrors the filename the server mints in its Content-Disposition
// (server.js: `tmuxifier-boxes-${payload.exportedAt.slice(0, 10)}.json`).
export function exportFilename(exportedAt: string): string {
  const stamp = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0];
  return stamp ? `tmuxifier-boxes-${stamp}.json` : 'tmuxifier-boxes.json';
}

export function renderBoxesSection(content: HTMLElement): void {
  // Settings sections have no access to main.ts's private showToast, so results
  // land on an inline status line — the convention every other section follows.
  const status = el('div', { class: 'pve-sub' });
  const setStatus = (msg: string, isError = false) => {
    status.className = isError ? 'pve-err' : 'pve-sub';
    status.textContent = msg;
  };

  // Export preview: filename, true byte size, and a stat grid, filled async.
  // The Export/Import buttons never depend on this fetch — backup and restore
  // must keep working when the preview doesn't.
  const previewHead = el('div', { class: 'boxes-stats-head' }, ['measuring…']);
  const previewGrid = el('div', { class: 'boxes-stats-grid' });
  const preview = el('div', { class: 'boxes-stats' }, [previewHead, previewGrid]);

  const statCell = (label: string, value: string) =>
    el('div', { class: 'boxes-stat' }, [
      el('span', { class: 'boxes-stat-label' }, [label]),
      el('span', { class: 'boxes-stat-value' }, [value]),
    ]);

  const loadPreview = async () => {
    try {
      const { payload, text } = await api.exportPreview();
      const s = exportStats(payload);
      previewHead.replaceChildren(
        el('span', {}, [exportFilename(payload.exportedAt)]),
        el('span', { class: 'boxes-stats-size' }, [fmtBytes(exportSizeBytes(text))]),
      );
      previewGrid.replaceChildren(
        statCell('boxes', String(s.total)),
        statCell('manual · pve', `${s.manual} · ${s.proxmox}`),
        statCell('tagged', String(s.tagged)),
        statCell('proxy jump', String(s.proxyJump)),
        statCell('startup command', String(s.startupCommand)),
        statCell('custom port', String(s.customPort)),
        statCell('custom user', String(s.customUser)),
      );
    } catch {
      previewHead.textContent = "Couldn't load export preview";
      previewGrid.replaceChildren();
    }
  };
  void loadPreview();

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
      void loadPreview(); // the figures should visibly reflect the new state
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
    el('p', { class: 'pve-sub' }, ['Export writes your box list to a JSON file — a portable backup you can move between Tmuxifier instances. It carries no SSH secrets; boxes rely on your keys, agent, and ~/.ssh/config at connect time.']),
    el('div', { class: 'boxes-legend' }, ['What gets exported']),
    preview,
    el('div', { class: 'pve-inline' }, [exportBtn, importBtn]),
    el('p', { class: 'pve-sub' }, ['Import re-mints each id and skips duplicates (same host or label). Proxmox links are not restored — re-link from the box\'s Edit dialog afterwards.']),
    el('div', { class: 'boxes-legend' }, ['Not in this backup']),
    el('p', { class: 'pve-sub' }, ['Proxmox host profiles & presets, service tiles, fleet scripts & job history, NetBox settings, passkeys, and voice configuration live only in the data/ directory on the Tmuxifier host.']),
    status,
    file,
  );
}
