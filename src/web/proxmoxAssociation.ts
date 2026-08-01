import { api, type Box, type PveBoxLink } from './api';
import { pve, type PveGuestKind, type PveNodeGuest } from './proxmox';
import { kindLabel } from './proxmoxGuests';
import { el, field } from './dom';

type Draft = { mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number; kind: PveGuestKind };

// The <select>'s option value/draft round-trip, pulled out as pure functions so
// the riskiest new mechanism in this module — encoding/decoding kind alongside
// vmid, since vmid alone no longer identifies a guest — is testable outside a
// DOM closure. An unrecognized (or absent) kind token decodes to 'lxc' rather
// than throwing: the only caller that can produce one is parseGuestOption('')
// (no option selected), and that must fail closed downstream via an unusable
// vmid, not via an exception here.
export function guestOptionValue(item: { kind: PveGuestKind; vmid: number }): string {
  return `${item.kind}:${item.vmid}`;
}

export function parseGuestOption(value: string): { kind: PveGuestKind; vmid: number } {
  const [kind, vmid] = value.split(':');
  return { kind: kind === 'qemu' ? 'qemu' : 'lxc', vmid: Number(vmid) };
}

// A template can be cloned from, never linked to: linking to one and then
// hitting Deprovision from the Guests tab would destroy the template every
// future clone depends on. It gets the same shown-but-unselectable treatment
// a guest already linked to another box gets — hiding it outright would just
// be a vmid that mysteriously vanished from the list.
export function guestOptionDisabled(item: { template: boolean; linkedBoxId: string | null }, boxId?: string): boolean {
  return item.template || (!!item.linkedBoxId && item.linkedBoxId !== boxId);
}

export function guestOptionLabel(item: PveNodeGuest, boxId?: string): string {
  const templateSuffix = item.template ? ' | TEMPLATE' : '';
  const linkedSuffix = item.linkedBoxId && item.linkedBoxId !== boxId ? ' | linked' : '';
  return `${item.vmid} | ${kindLabel(item.kind)} | ${item.name} | ${item.state}${templateSuffix}${linkedSuffix}`;
}

export function associationMutation(current: PveBoxLink | undefined, draft: Draft) {
  if (draft.mode === 'unlinked') return current ? { kind: 'unlink' as const } : null;
  if (!draft.hostId || !draft.node || !Number.isInteger(draft.vmid) || draft.vmid < 100) throw new Error('select a Proxmox guest');
  if (current && current.hostId === draft.hostId && current.node === draft.node && current.vmid === draft.vmid && current.kind === draft.kind) return null;
  return { kind: 'link' as const, link: { hostId: draft.hostId, node: draft.node, vmid: draft.vmid, kind: draft.kind } };
}

// Linked boxes always show the section (a stale link must stay visible so it
// can be unlinked); unlinked boxes only see it once a host profile exists.
export function associationSectionVisible(hostCount: number, linked: boolean) {
  return linked || hostCount > 0;
}

// box is null in add mode: the box doesn't exist yet, so the caller passes the
// freshly created id to commit() after api.addBox resolves. The link/unlink
// calls themselves are unchanged — the server validates the target either way.
export function createProxmoxAssociationEditor(box: Box | null) {
  const current = box?.proxmox;
  let draft: Draft = current
    ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid, kind: current.kind }
    : { mode: 'unlinked' };
  const section = el('section', { class: 'box-pve-association' });
  const message = el('div', { class: 'pve-err' });
  const host = el('select') as HTMLSelectElement;
  const node = el('select') as HTMLSelectElement;
  const guest = el('select') as HTMLSelectElement;
  const showError = (error: unknown) => { message.textContent = error instanceof Error ? error.message : 'Could not load Proxmox guests'; };

  async function loadHosts(selected = '') {
    const hosts = await pve.hosts();
    host.replaceChildren(...hosts.map((item) => el('option', { value: item.id }, [item.name])));
    if (selected && !hosts.some((item) => item.id === selected)) {
      host.prepend(el('option', { value: selected }, [`Unavailable host (${selected})`]));
    }
    if (selected) host.value = selected;
    await loadNodes(draft.mode === 'linked' ? draft.node : '');
  }
  async function loadNodes(selected = '') {
    const nodes = await pve.nodes(host.value);
    node.replaceChildren(...nodes.map((item) => el('option', { value: item.node }, [item.node])));
    if (selected) node.value = selected;
    await loadGuests(draft.mode === 'linked' ? draft.vmid : 0);
  }
  async function loadGuests(selected = 0) {
    const rows = await pve.nodeGuests(host.value, node.value);
    guest.replaceChildren(...rows.map((item: PveNodeGuest) => el('option', {
      value: guestOptionValue(item),
      disabled: guestOptionDisabled(item, box?.id),
    }, [guestOptionLabel(item, box?.id)])));
    if (selected) {
      // Fail closed: when the stored vmid is no longer among the fetched rows
      // (the guest was destroyed/recreated — exactly the mismatch case that
      // routes an operator here via "Edit link"), explicitly clear the value
      // rather than leaving the browser's default first-option selection in
      // place. Leaving it would let syncDraft silently build a draft pointing
      // at an arbitrary, unrelated guest, and Save would re-link to it.
      const match = rows.find((item) => item.vmid === selected);
      guest.value = match ? guestOptionValue(match) : '';
    }
    syncDraft();
  }
  const syncDraft = () => {
    const parsed = parseGuestOption(guest.value);
    draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: parsed.vmid, kind: parsed.kind };
  };
  host.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: '', vmid: 0, kind: 'lxc' };
    node.replaceChildren(); guest.replaceChildren();
    void loadNodes().catch(showError);
  });
  node.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: 0, kind: 'lxc' };
    guest.replaceChildren();
    void loadGuests().catch(showError);
  });
  guest.addEventListener('change', syncDraft);

  async function hydrateSummary(details: HTMLElement) {
    if (!current) return;
    const hosts = await pve.hosts();
    const hostName = hosts.find((item) => item.id === current.hostId)?.name ?? current.hostId;
    const guests = await pve.nodeGuests(current.hostId, current.node);
    const target = guests.find((item) => item.vmid === current.vmid);
    details.textContent = `${hostName} | ${current.node} | ${kindLabel(current.kind)} | VMID ${current.vmid} | ${target?.name ?? 'missing'} | ${target?.state ?? 'missing'}`;
  }

  function renderSummary() {
    if (!current) {
      section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Not linked']), el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Link guest']), message);
      return;
    }
    const details = el('div', {}, [`${current.hostId} | ${current.node} | ${kindLabel(current.kind)} | VMID ${current.vmid}`]);
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      details,
      el('div', { class: 'pve-inline' }, [
        el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Change association']),
        el('button', { type: 'button', class: 'pve-btn danger', onclick: () => {
          if (confirm('Unlink this box? The Proxmox guest will not be stopped or destroyed.')) {
            draft = { mode: 'unlinked' };
            section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Will unlink when you save']));
          }
        } }, ['Unlink']),
      ]), message,
    );
    void hydrateSummary(details).catch(showError);
  }
  async function renderPicker() {
    draft = current
      ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid, kind: current.kind }
      : { mode: 'linked', hostId: '', node: '', vmid: 0, kind: 'lxc' };
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      el('div', { class: 'pve-picker-grid' }, [field('Host', host), field('Node', node), field('Guest', guest)]),
      message,
    );
    await loadHosts(current?.hostId).catch(showError);
  }
  renderSummary();
  // With no hosts and no link the picker could only error — hide the whole
  // section. A fetch failure keeps it hidden (same "never show a dead
  // button" rule as the sidebar Proxmox button in main.ts).
  if (!current) {
    section.hidden = true;
    void pve.hosts()
      .then((hosts) => { section.hidden = !associationSectionVisible(hosts.length, false); })
      .catch(() => {});
  }
  return {
    element: section,
    async commit(boxId: string) {
      const mutation = associationMutation(current, draft);
      if (mutation?.kind === 'link') await api.setProxmoxLink(boxId, mutation.link);
      if (mutation?.kind === 'unlink') await api.clearProxmoxLink(boxId);
    },
  };
}
