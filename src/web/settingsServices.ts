// Settings → Services: CRUD for the standby dashboard's service tiles.
// Master-detail scaled down: the list on top, one add/edit form below it.
import { el, field, makeRadio, openModal } from './dom';
import { registerModal } from './modalRegistry';
import { api, type Service, type ServiceCheckKind, type ServiceSpec } from './api';

// Starter palette of Nerd Font glyphs (the bundled Meslo NF renders these);
// free-form entry stays open for anything not listed.
const GLYPHS: { glyph: string; label: string }[] = [
  { glyph: '', label: 'server' },
  { glyph: '', label: 'database' },
  { glyph: '', label: 'globe' },
  { glyph: '', label: 'home' },
  { glyph: '', label: 'cloud' },
  { glyph: '', label: 'film' },
  { glyph: '', label: 'music' },
  { glyph: '', label: 'key' },
  { glyph: '', label: 'chart' },
  { glyph: '', label: 'code' },
];

// Pure so it can be tested without a DOM (the repo's web-test convention).
// null (not undefined) for cleared optionals: the server's PATCH merge treats
// null as "clear this field".
export function buildServicePayload(f: { name: string; url: string; glyph: string; group: string; kind: ServiceCheckKind; target: string }): ServiceSpec {
  const target = f.target.trim();
  const check = f.kind === 'none' || !target ? { kind: f.kind } : { kind: f.kind, target };
  return {
    name: f.name.trim(),
    url: f.url.trim(),
    glyph: f.glyph.trim() || null,
    group: f.group.trim() || null,
    check,
  };
}

export async function renderServicesSection(content: HTMLElement): Promise<void> {
  let services: Service[] = [];
  let loadError = '';
  try { services = await api.services(); } catch (e) { loadError = (e as Error).message; }

  const status = el('div', { class: 'pve-sub' });
  const setStatus = (msg: string, isError = false) => {
    status.className = isError ? 'pve-err' : 'pve-sub';
    status.textContent = msg;
  };
  if (loadError) setStatus(`Could not load services: ${loadError}`, true);

  const rerender = () => { void renderServicesSection(content); };
  const changed = () => window.dispatchEvent(new Event('tmuxifier:services-changed'));

  // --- form (add or edit) --------------------------------------------------
  let editing: Service | null = null;
  const nameIn = el('input', { type: 'text', autocomplete: 'off' }) as HTMLInputElement;
  const urlIn = el('input', { type: 'text', placeholder: 'http://192.168.1.10:3000/', autocomplete: 'off' }) as HTMLInputElement;
  const glyphIn = el('input', { type: 'text', class: 'svc-glyph-input', autocomplete: 'off' }) as HTMLInputElement;
  const groupIn = el('input', { type: 'text', placeholder: 'e.g. Monitoring', autocomplete: 'off' }) as HTMLInputElement;
  const targetIn = el('input', { type: 'text', autocomplete: 'off' }) as HTMLInputElement;

  const palette = el('div', { class: 'svc-glyph-palette' }, GLYPHS.map(({ glyph, label }) =>
    el('button', { type: 'button', class: 'svc-glyph-key', title: label, onclick: () => { glyphIn.value = glyph; } }, [glyph])));

  const radios: Record<Exclude<ServiceCheckKind, never>, { wrap: HTMLElement; input: HTMLInputElement }> = {
    http: makeRadio('svc-check', 'http', 'HTTP', true),
    tcp: makeRadio('svc-check', 'tcp', 'TCP', false),
    none: makeRadio('svc-check', 'none', 'None (link only)', false),
  };
  const kind = (): ServiceCheckKind =>
    (Object.entries(radios).find(([, r]) => r.input.checked)?.[0] as ServiceCheckKind) ?? 'http';

  const targetField = field('Probe URL (optional)', targetIn);
  const syncTarget = () => {
    const k = kind();
    targetField.hidden = k === 'none';
    (targetField.querySelector('span') as HTMLElement).textContent =
      k === 'tcp' ? 'Host:port' : 'Probe URL (optional — defaults to the link URL)';
    targetIn.placeholder = k === 'tcp' ? '192.168.1.10:53' : 'https://192.168.1.10:3000/health';
  };
  for (const r of Object.values(radios)) r.input.addEventListener('change', syncTarget);

  const formTitle = el('h4', {}, ['Add service']);
  const saveBtn = el('button', { type: 'button', class: 'pve-primary' }, ['Add service']);
  const cancelBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => rerender() }, ['Reset']);

  function fillForm(svc: Service | null) {
    editing = svc;
    formTitle.textContent = svc ? `Edit ${svc.name}` : 'Add service';
    saveBtn.textContent = svc ? 'Save changes' : 'Add service';
    nameIn.value = svc?.name ?? '';
    urlIn.value = svc?.url ?? '';
    glyphIn.value = svc?.glyph ?? '';
    groupIn.value = svc?.group ?? '';
    targetIn.value = svc?.check.target ?? '';
    const k = svc?.check.kind ?? 'http';
    for (const [key, r] of Object.entries(radios)) r.input.checked = key === k;
    syncTarget();
  }

  saveBtn.addEventListener('click', async () => {
    const payload = buildServicePayload({
      name: nameIn.value, url: urlIn.value, glyph: glyphIn.value,
      group: groupIn.value, kind: kind(), target: targetIn.value,
    });
    try {
      if (editing) await api.updateService(editing.id, payload);
      else await api.addService(payload);
      changed();
      rerender();
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });

  function confirmRemove(svc: Service) {
    const modal = el('div', { class: 'modal' });
    const { close } = openModal({ modal, onClose: () => unregister() });
    const unregister = registerModal(close);
    modal.append(
      el('h2', {}, ['Remove service']),
      el('p', {}, [`Remove “${svc.name}” from the dashboard? The service itself is untouched — this only deletes the tile.`]),
      el('div', { class: 'modal-actions' }, [
        el('button', { type: 'button', onclick: () => close() }, ['Cancel']),
        el('button', {
          type: 'button', class: 'danger', onclick: async () => {
            try { await api.removeService(svc.id); changed(); close(); rerender(); }
            catch (e) { setStatus((e as Error).message, true); close(); }
          },
        }, ['Remove']),
      ]),
    );
  }

  // --- list ----------------------------------------------------------------
  const rows = services.map((svc) => el('div', { class: 'svc-row' }, [
    el('span', { class: 'svc-row-name' }, [svc.glyph ? `${svc.glyph}  ${svc.name}` : svc.name]),
    el('span', { class: 'svc-row-group' }, [svc.group ?? '']),
    el('span', { class: 'svc-row-check' }, [svc.check.kind]),
    el('button', { type: 'button', class: 'pve-btn', onclick: () => fillForm(svc) }, ['Edit']),
    el('button', { type: 'button', class: 'pve-btn danger', onclick: () => confirmRemove(svc) }, ['Remove']),
  ]));

  content.replaceChildren(
    el('h3', {}, ['Services']),
    el('p', { class: 'pve-sub' }, ['Tiles on the standby dashboard: a name, a link, and an optional liveness check the server sweeps in the background. Checks tolerate self-signed certificates — they answer “is it up”, nothing more.']),
    rows.length ? el('div', { class: 'svc-list' }, rows) : el('p', { class: 'pve-sub' }, ['No services yet — add your first one below.']),
    el('div', { class: 'pve-group' }, [
      formTitle,
      field('Name', nameIn),
      field('URL (opens in a new tab)', urlIn),
      field('Glyph (optional)', glyphIn),
      palette,
      field('Group (optional)', groupIn),
      el('div', { class: 'svc-check-radios' }, [radios.http.wrap, radios.tcp.wrap, radios.none.wrap]),
      targetField,
      el('div', { class: 'pve-inline' }, [saveBtn, cancelBtn]),
    ]),
    status,
  );
  fillForm(null);
}
