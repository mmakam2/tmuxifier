// Settings → Services: CRUD for the standby dashboard's service tiles.
// Master-detail scaled down: the list on top, one add/edit form below it.
import { el, field, makeRadio, openModal } from './dom';
import { registerModal } from './modalRegistry';
import { buildServiceIcon } from './serviceIcon';
import { api, type Service, type ServiceCheck, type ServiceCheckKind, type ServiceSection, type ServiceSpec, type UnifiTlsMode } from './api';

// Check kinds that authenticate, and so carry a stored credential.
const CREDENTIAL_KINDS: ServiceCheckKind[] = ['pihole', 'truenas', 'unifi', 'immich'];

// Pure so it can be tested without a DOM (the repo's web-test convention).
// null (not undefined) for cleared optionals: the server's PATCH merge treats
// null as "clear this field", while an absent key means "leave it alone" —
// which is exactly what an untouched password field must send.
export function buildServicePayload(f: {
  name: string; url: string; icon?: string; group: string;
  kind: ServiceCheckKind; target: string; section: ServiceSection;
  username?: string; password?: string; clearPassword?: boolean; insecure?: boolean;
  site?: string; tls?: UnifiTlsMode; fingerprint?: string;
}): ServiceSpec {
  const target = f.target.trim();
  let check: ServiceCheck;
  // Every optional field a form control owns is stated outright, never omitted
  // when falsy. The server's PATCH merge is {...base, ...raw}, so an absent key
  // means "keep what is stored" — omitting `insecure` when the box was
  // unchecked made the setting silently revert to its saved value, and the same
  // held for clearing a UniFi site override. `target` is stated the same way: it
  // was the last field still sent on omit, which meant emptying the Probe URL
  // could never clear a stored one (the server kept probing the old address).
  // An empty string is the clear; only kind 'none', which has no target field at
  // all, omits it — sending one there is a contradiction the server refuses.
  if (f.kind === 'pihole') {
    check = { kind: 'pihole', target, insecure: f.insecure === true };
  } else if (f.kind === 'immich') {
    check = { kind: 'immich', target, insecure: f.insecure === true };
  } else if (f.kind === 'unifi') {
    const tls: UnifiTlsMode = f.tls ?? 'verify';
    const site = (f.site ?? '').trim();
    const fingerprint = (f.fingerprint ?? '').trim();
    check = {
      kind: 'unifi',
      target,
      site,
      tls,
      // The pin is meaningless outside pin mode, so it is dropped rather than
      // carried along to confuse a later read of the record.
      ...(tls === 'pin' && fingerprint ? { fingerprint } : {}),
    };
  } else if (f.kind === 'truenas') {
    check = {
      kind: 'truenas',
      username: (f.username ?? '').trim(),
      target,
      insecure: f.insecure === true,
    };
  } else if (f.kind === 'none') {
    check = { kind: 'none' };
  } else {
    check = { kind: f.kind, target };
  }
  const payload: ServiceSpec = {
    name: f.name.trim(),
    url: f.url.trim(),
    // undefined (Auto) sends null, which the server's PATCH merge reads as
    // "clear this field" — and a cleared icon is exactly what resolve-
    // automatically is stored as.
    icon: f.icon ?? null,
    group: f.group.trim() || null,
    section: f.section,
    check,
  };
  if (CREDENTIAL_KINDS.includes(f.kind)) {
    if (f.clearPassword) payload.password = null;
    else if (f.password?.trim()) payload.password = f.password;
  }
  return payload;
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
  const groupIn = el('input', { type: 'text', placeholder: 'e.g. Monitoring', autocomplete: 'off' }) as HTMLInputElement;
  const targetIn = el('input', { type: 'text', autocomplete: 'off' }) as HTMLInputElement;
  const usernameIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'truenas_admin' }) as HTMLInputElement;
  const passwordIn = el('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const insecureIn = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const siteIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'leave blank for the first site' }) as HTMLInputElement;
  const fingerprintIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'run Test connection to capture it' }) as HTMLInputElement;
  const clearPwBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Clear']);
  const testBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Test connection']);
  let clearPassword = false;

  // Three states rather than a free-form field: Auto is the default and covers
  // the fleet without typing, Choose is the escape hatch when the guess is
  // wrong, and None suppresses. The catalog is fetched once per render.
  const iconRadios: Record<'auto' | 'pick' | 'none', { wrap: HTMLElement; input: HTMLInputElement }> = {
    auto: makeRadio('svc-icon', 'auto', 'Auto', true),
    pick: makeRadio('svc-icon', 'pick', 'Choose', false),
    none: makeRadio('svc-icon', 'none', 'None', false),
  };
  const iconMode = (): 'auto' | 'pick' | 'none' =>
    (Object.entries(iconRadios).find(([, r]) => r.input.checked)?.[0] as 'auto' | 'pick' | 'none') ?? 'auto';

  const iconFilter = el('input', { type: 'text', class: 'svc-icon-filter', placeholder: 'filter icons', autocomplete: 'off' }) as HTMLInputElement;
  const iconGrid = el('div', { class: 'svc-icon-grid' });
  const iconPicker = el('div', { class: 'svc-icon-picker' }, [iconFilter, iconGrid]);
  const refreshBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Refresh icon']);
  let picked = '';
  let catalog: string[] = [];

  function paintIconGrid() {
    if (!catalog.length) {
      iconGrid.replaceChildren(el('div', { class: 'svc-icon-empty' }, ['No icon catalog on disk — run npm run fetch-icons to download it.']));
      return;
    }
    const q = iconFilter.value.trim().toLowerCase();
    const shown = catalog.filter((s) => !q || s.includes(q)).slice(0, 200);
    if (!shown.length) {
      iconGrid.replaceChildren(el('div', { class: 'svc-icon-empty' }, [`No catalog icon matches “${iconFilter.value.trim()}”.`]));
      return;
    }
    iconGrid.replaceChildren(...shown.map((slug) => el('button', {
      type: 'button',
      class: `svc-icon-key${slug === picked ? ' selected' : ''}`,
      title: slug,
      onclick: () => { picked = slug; paintIconGrid(); },
    }, [el('img', { src: `/api/icons/${encodeURIComponent(slug)}`, alt: '', class: 'svc-icon-img' })])));
  }
  iconFilter.addEventListener('input', paintIconGrid);

  const syncIcon = () => { iconPicker.hidden = iconMode() !== 'pick'; };
  for (const r of Object.values(iconRadios)) r.input.addEventListener('change', syncIcon);

  refreshBtn.addEventListener('click', async () => {
    if (!editing) { setStatus('Save the service first, then refresh its icon.', true); return; }
    setStatus('Fetching the favicon…');
    try {
      const r = await api.refreshServiceIcon(editing.id);
      setStatus(r.ok ? 'Icon updated.' : `No icon found: ${r.reason ?? 'unknown reason'}`, !r.ok);
      changed();
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });

  // An empty catalog is a picker that explains itself, not an error: a fresh
  // clone that has never run fetch-icons still resolves favicons.
  try { catalog = (await api.icons()).slugs; } catch { catalog = []; }

  const radios: Record<ServiceCheckKind, { wrap: HTMLElement; input: HTMLInputElement }> = {
    http: makeRadio('svc-check', 'http', 'HTTP', true),
    tcp: makeRadio('svc-check', 'tcp', 'TCP', false),
    pihole: makeRadio('svc-check', 'pihole', 'Pi-hole', false),
    truenas: makeRadio('svc-check', 'truenas', 'TrueNAS', false),
    unifi: makeRadio('svc-check', 'unifi', 'UniFi', false),
    immich: makeRadio('svc-check', 'immich', 'Immich', false),
    none: makeRadio('svc-check', 'none', 'None (link only)', false),
  };
  const kind = (): ServiceCheckKind =>
    (Object.entries(radios).find(([, r]) => r.input.checked)?.[0] as ServiceCheckKind) ?? 'http';

  // Parent category on the dashboard; `group` is the sub-category within it.
  // Infrastructure tiles whose category is Proxmox or IPAM merge into those
  // built-in groups next to the node/prefix readouts.
  const sectionRadios: Record<ServiceSection, { wrap: HTMLElement; input: HTMLInputElement }> = {
    services: makeRadio('svc-section', 'services', 'Services', true),
    infrastructure: makeRadio('svc-section', 'infrastructure', 'Infrastructure', false),
  };
  const section = (): ServiceSection =>
    (Object.entries(sectionRadios).find(([, r]) => r.input.checked)?.[0] as ServiceSection) ?? 'services';

  // UniFi gets a three-way TLS choice rather than the shared insecure checkbox:
  // a controller's certificate is self-signed by default, so the checkbox path
  // would have almost everyone sending a write-capable key over an
  // unauthenticated connection. Pinning makes the common case safe.
  const tlsRadios: Record<UnifiTlsMode, { wrap: HTMLElement; input: HTMLInputElement }> = {
    verify: makeRadio('svc-tls', 'verify', 'Verify certificate', true),
    pin: makeRadio('svc-tls', 'pin', 'Pin this certificate', false),
    insecure: makeRadio('svc-tls', 'insecure', 'Accept any certificate', false),
  };
  const tlsMode = (): UnifiTlsMode =>
    (Object.entries(tlsRadios).find(([, r]) => r.input.checked)?.[0] as UnifiTlsMode) ?? 'verify';

  // Pi-hole v6 and TrueNAS both read their stats over an authenticated API, so
  // these checks need a credential the others don't — and, because they send
  // one, they verify TLS by default rather than tolerating any certificate the
  // way http/tcp do. Only one kind is active at a time, so the widgets are
  // shared and only their wording swaps.
  const passwordField = field('App password', el('div', { class: 'pve-inline' }, [passwordIn, clearPwBtn]));
  const credentialLabel = passwordField.querySelector('span') as HTMLElement;
  const usernameField = field('Username the API key belongs to', usernameIn);
  const insecureField = field('TLS', el('label', { class: 'svc-inline-check' }, [insecureIn, ' Allow a self-signed certificate']));
  const credentialHelp = el('p', { class: 'pve-sub' }, ['']);
  const siteField = field('Site (optional)', siteIn);
  const tlsModeField = field('TLS', el('div', { class: 'svc-check-radios' }, [tlsRadios.verify.wrap, tlsRadios.pin.wrap, tlsRadios.insecure.wrap]));
  const fingerprintField = field('Certificate fingerprint (SHA-256)', fingerprintIn);
  const credentialGroup = el('div', {}, [
    credentialHelp, usernameField, passwordField, siteField, insecureField, tlsModeField, fingerprintField,
    el('div', { class: 'pve-inline' }, [testBtn]),
  ]);

  const PIHOLE_HELP = 'Pi-hole v6 only. Create the credential on the Pi-hole under Settings → Web interface / API → Configure app password; an app password works even when two-factor is enabled, the web login password does not.';
  const TRUENAS_HELP = 'TrueNAS 25.04 or later (it speaks JSON-RPC over WebSocket; the old REST API is gone in TrueNAS 26). Create a user-linked key under Credentials → Users → API Keys and give it the READONLY_ADMIN role. The URL must be https — TrueNAS permanently revokes any API key sent over plain HTTP.';
  const IMMICH_HELP = 'Immich v1.118 or later. Create an API key under Account Settings → API Keys and grant it these read-only permissions: server.about, server.storage, server.statistics, server.versionCheck, job.read, systemConfig.read. Library counts and job state come from admin-scoped endpoints — a key without them still reports storage and version, and the card says which are missing.';
  const UNIFI_HELP = 'UniFi Network 9.0 or later. Create an API key under Control Plane → Integrations. The key inherits its admin account’s role and the local API has no read-only key scope, so create it under a View Only admin — this integration only ever reads. The URL must be https.';

  const targetField = field('Probe URL (optional)', targetIn);
  const syncTarget = () => {
    const k = kind();
    const isUnifi = k === 'unifi';
    const needsCredential = k === 'pihole' || k === 'truenas' || k === 'immich' || isUnifi;
    targetField.hidden = k === 'none';
    credentialGroup.hidden = !needsCredential;
    usernameField.hidden = k !== 'truenas';
    // The three-way TLS control and the shared insecure checkbox are mutually
    // exclusive: whichever the active kind uses, the other stays hidden.
    siteField.hidden = !isUnifi;
    tlsModeField.hidden = !isUnifi;
    fingerprintField.hidden = !isUnifi || tlsMode() !== 'pin';
    insecureField.hidden = isUnifi;
    credentialLabel.textContent = k === 'pihole' ? 'App password' : 'API key';
    credentialHelp.textContent = isUnifi ? UNIFI_HELP
      : k === 'truenas' ? TRUENAS_HELP
        : k === 'immich' ? IMMICH_HELP
          : PIHOLE_HELP;
    (targetField.querySelector('span') as HTMLElement).textContent =
      k === 'tcp' ? 'Host:port'
        : needsCredential ? 'API base URL (optional — defaults to the link URL)'
          : 'Probe URL (optional — defaults to the link URL)';
    targetIn.placeholder = k === 'tcp' ? '192.168.1.10:53'
      : k === 'pihole' ? 'https://pihole.example.com'
        : k === 'truenas' ? 'https://nas.example.com'
          : k === 'immich' ? 'https://immich.example.com'
            : isUnifi ? 'https://192.168.1.1'
              : 'https://192.168.1.10:3000/health';
  };
  for (const r of Object.values(radios)) r.input.addEventListener('change', syncTarget);
  // Switching to pin mode is what reveals the fingerprint field.
  for (const r of Object.values(tlsRadios)) r.input.addEventListener('change', syncTarget);

  // Typing re-arms "replace"; Clear is the only way to send an explicit null.
  passwordIn.addEventListener('input', () => { clearPassword = false; });
  clearPwBtn.addEventListener('click', () => {
    clearPassword = true;
    passwordIn.value = '';
    passwordIn.placeholder = 'will be cleared on save';
  });

  testBtn.addEventListener('click', async () => {
    setStatus('Testing…');
    const url = targetIn.value.trim() || urlIn.value.trim();
    try {
      if (kind() === 'unifi') {
        const res = await api.testUnifi({
          url, apiKey: passwordIn.value, site: siteIn.value.trim(),
          tls: tlsMode(), fingerprint: fingerprintIn.value.trim(), id: editing?.id,
        });
        // Arming pin mode means accepting a fingerprint, so a probe that saw one
        // fills the field rather than making the operator copy it by hand. An
        // already-filled field is never overwritten: replacing a pin silently is
        // exactly the trust-on-first-use failure pinning exists to prevent.
        const armed = !!res.fingerprint256 && tlsMode() === 'pin' && !fingerprintIn.value.trim();
        if (armed) fingerprintIn.value = res.fingerprint256!;
        const names = (res.sites ?? []).map((s) => s.reference || s.name).filter(Boolean).join(', ');
        // A first-time pin refusal that captured the certificate is progress, not
        // a failure: the field is now filled and saving completes the arming. Say
        // so rather than reporting the refusal the operator can no longer act on.
        if (!res.ok && armed) {
          setStatus('Certificate captured — review the fingerprint and save to pin it.');
          return;
        }
        setStatus(res.ok ? `Connected — sites: ${names || 'none reported'}` : (res.error || 'Connection failed'), !res.ok);
        return;
      }
      if (kind() === 'truenas') {
        const res = await api.testTruenas({
          url, username: usernameIn.value.trim(), apiKey: passwordIn.value,
          insecure: insecureIn.checked, id: editing?.id,
        });
        setStatus(res.ok ? `Connected — TrueNAS ${res.version ?? ''}`.trim() : (res.error || 'Connection failed'), !res.ok);
        return;
      }
      if (kind() === 'immich') {
        const res = await api.testImmich({
          url, apiKey: passwordIn.value, insecure: insecureIn.checked, id: editing?.id,
        });
        // Naming the missing permissions here is the point of the probe: a
        // scoped key gets fixed before saving rather than producing a card full
        // of dashes afterwards.
        const missing = res.denied?.length ? ` — missing ${res.denied.join(', ')}` : '';
        setStatus(
          res.ok ? `Connected — Immich ${res.version ?? ''}${missing}`.trim() : (res.error || 'Connection failed'),
          !res.ok,
        );
        return;
      }
      const res = await api.testPihole({
        url, password: passwordIn.value, insecure: insecureIn.checked, id: editing?.id,
      });
      setStatus(res.ok ? `Connected — Pi-hole ${res.version ?? 'v6'}` : (res.error || 'Connection failed'), !res.ok);
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });

  const formTitle = el('h4', {}, ['Add service']);
  const saveBtn = el('button', { type: 'button', class: 'pve-primary' }, ['Add service']);
  const cancelBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => rerender() }, ['Reset']);

  function fillForm(svc: Service | null) {
    editing = svc;
    formTitle.textContent = svc ? `Edit ${svc.name}` : 'Add service';
    saveBtn.textContent = svc ? 'Save changes' : 'Add service';
    nameIn.value = svc?.name ?? '';
    urlIn.value = svc?.url ?? '';
    picked = svc?.icon && svc.icon !== 'none' ? svc.icon : '';
    const iconSaved = svc?.icon === 'none' ? 'none' : svc?.icon ? 'pick' : 'auto';
    for (const [key, r] of Object.entries(iconRadios)) r.input.checked = key === iconSaved;
    iconFilter.value = '';
    paintIconGrid();
    syncIcon();
    groupIn.value = svc?.group ?? '';
    targetIn.value = svc?.check.target ?? '';
    usernameIn.value = svc?.check.username ?? '';
    const k = svc?.check.kind ?? 'http';
    for (const [key, r] of Object.entries(radios)) r.input.checked = key === k;
    const sec = svc?.section ?? 'services';
    for (const [key, r] of Object.entries(sectionRadios)) r.input.checked = key === sec;
    // A blank field on an existing Pi-hole must not read as "no password set",
    // so the placeholder carries the stored-credential state instead.
    clearPassword = false;
    passwordIn.value = '';
    passwordIn.placeholder = svc?.hasPassword ? '•••••••• (leave blank to keep)' : '';
    insecureIn.checked = svc?.check.insecure === true;
    siteIn.value = svc?.check.site ?? '';
    fingerprintIn.value = svc?.check.fingerprint ?? '';
    const tlsSaved = svc?.check.tls ?? 'verify';
    for (const [key, r] of Object.entries(tlsRadios)) r.input.checked = key === tlsSaved;
    syncTarget();
  }

  saveBtn.addEventListener('click', async () => {
    const payload = buildServicePayload({
      name: nameIn.value, url: urlIn.value,
      icon: iconMode() === 'none' ? 'none' : iconMode() === 'pick' && picked ? picked : undefined,
      group: groupIn.value, kind: kind(), target: targetIn.value, section: section(),
      username: usernameIn.value, password: passwordIn.value, clearPassword, insecure: insecureIn.checked,
      site: siteIn.value, tls: tlsMode(), fingerprint: fingerprintIn.value,
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
  const rows = services.map((svc) => {
    // The same element the dashboard uses, so the list previews exactly what
    // the tile will render — including nothing, when nothing resolves.
    const icon = buildServiceIcon();
    icon.update(svc);
    return el('div', { class: 'svc-row' }, [
      icon.root,
      el('span', { class: 'svc-row-name' }, [svc.name]),
      el('span', { class: 'svc-row-group' }, [
        `${svc.section === 'infrastructure' ? 'Infrastructure' : 'Services'}${svc.group ? ` → ${svc.group}` : ''}`,
      ]),
      el('span', { class: 'svc-row-check' }, [svc.check.kind]),
      el('button', { type: 'button', class: 'pve-btn', onclick: () => fillForm(svc) }, ['Edit']),
      el('button', { type: 'button', class: 'pve-btn danger', onclick: () => confirmRemove(svc) }, ['Remove']),
    ]);
  });

  content.replaceChildren(
    el('h3', {}, ['Services']),
    el('p', { class: 'pve-sub' }, ['Tiles on the standby dashboard: a name, a link, and an optional liveness check the server sweeps in the background. Checks tolerate self-signed certificates — they answer “is it up”, nothing more.']),
    rows.length ? el('div', { class: 'svc-list' }, rows) : el('p', { class: 'pve-sub' }, ['No services yet — add your first one below.']),
    el('div', { class: 'pve-group' }, [
      formTitle,
      field('Name', nameIn),
      field('URL (opens in a new tab)', urlIn),
      field('Icon', el('div', { class: 'svc-check-radios' }, [iconRadios.auto.wrap, iconRadios.pick.wrap, iconRadios.none.wrap])),
      iconPicker,
      el('div', { class: 'pve-inline' }, [refreshBtn]),
      el('div', { class: 'svc-check-radios' }, [sectionRadios.services.wrap, sectionRadios.infrastructure.wrap]),
      field('Category (optional — e.g. DNS Filtering; under Infrastructure, "Proxmox" and "IPAM" join the built-in groups)', groupIn),
      el('div', { class: 'svc-check-radios' }, [radios.http.wrap, radios.tcp.wrap, radios.pihole.wrap, radios.truenas.wrap, radios.unifi.wrap, radios.immich.wrap, radios.none.wrap]),
      targetField,
      credentialGroup,
      el('div', { class: 'pve-inline' }, [saveBtn, cancelBtn]),
    ]),
    status,
  );
  fillForm(null);
}
