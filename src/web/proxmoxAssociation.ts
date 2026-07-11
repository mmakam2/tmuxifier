import { api, type Box, type PveBoxLink } from './api';
import { pve, type PveNodeContainer } from './proxmox';
import { el, field } from './dom';

type Draft = { mode: 'unlinked' } | { mode: 'linked'; hostId: string; node: string; vmid: number };

export function associationMutation(current: PveBoxLink | undefined, draft: Draft) {
  if (draft.mode === 'unlinked') return current ? { kind: 'unlink' as const } : null;
  if (!draft.hostId || !draft.node || !Number.isInteger(draft.vmid) || draft.vmid < 100) throw new Error('select a Proxmox container');
  if (current && current.hostId === draft.hostId && current.node === draft.node && current.vmid === draft.vmid) return null;
  return { kind: 'link' as const, link: { hostId: draft.hostId, node: draft.node, vmid: draft.vmid } };
}

// box is null in add mode: the box doesn't exist yet, so the caller passes the
// freshly created id to commit() after api.addBox resolves. The link/unlink
// calls themselves are unchanged — the server validates the target either way.
export function createProxmoxAssociationEditor(box: Box | null) {
  const current = box?.proxmox;
  let draft: Draft = current
    ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid }
    : { mode: 'unlinked' };
  const section = el('section', { class: 'box-pve-association' });
  const message = el('div', { class: 'pve-err' });
  const host = el('select') as HTMLSelectElement;
  const node = el('select') as HTMLSelectElement;
  const container = el('select') as HTMLSelectElement;
  const showError = (error: unknown) => { message.textContent = error instanceof Error ? error.message : 'Could not load Proxmox containers'; };

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
    await loadContainers(draft.mode === 'linked' ? draft.vmid : 0);
  }
  async function loadContainers(selected = 0) {
    const containers = await pve.nodeContainers(host.value, node.value);
    container.replaceChildren(...containers.map((item: PveNodeContainer) => el('option', {
      value: item.vmid,
      disabled: !!item.linkedBoxId && item.linkedBoxId !== box?.id,
    }, [`${item.vmid} | ${item.name} | ${item.state}${item.linkedBoxId && item.linkedBoxId !== box?.id ? ' | linked' : ''}`])));
    if (selected) container.value = String(selected);
    syncDraft();
  }
  const syncDraft = () => { draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: Number(container.value) }; };
  host.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: '', vmid: 0 };
    node.replaceChildren(); container.replaceChildren();
    void loadNodes().catch(showError);
  });
  node.addEventListener('change', () => {
    draft = { mode: 'linked', hostId: host.value, node: node.value, vmid: 0 };
    container.replaceChildren();
    void loadContainers().catch(showError);
  });
  container.addEventListener('change', syncDraft);

  async function hydrateSummary(details: HTMLElement) {
    if (!current) return;
    const hosts = await pve.hosts();
    const hostName = hosts.find((item) => item.id === current.hostId)?.name ?? current.hostId;
    const containers = await pve.nodeContainers(current.hostId, current.node);
    const target = containers.find((item) => item.vmid === current.vmid);
    details.textContent = `${hostName} | ${current.node} | VMID ${current.vmid} | ${target?.name ?? 'missing'} | ${target?.state ?? 'missing'}`;
  }

  function renderSummary() {
    if (!current) {
      section.replaceChildren(el('div', { class: 'pve-eyebrow' }, ['Proxmox association']), el('div', { class: 'pve-sub' }, ['Not linked']), el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Link container']), message);
      return;
    }
    const details = el('div', {}, [`${current.hostId} | ${current.node} | VMID ${current.vmid}`]);
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      details,
      el('div', { class: 'pve-inline' }, [
        el('button', { type: 'button', class: 'pve-btn', onclick: () => void renderPicker() }, ['Change association']),
        el('button', { type: 'button', class: 'pve-btn danger', onclick: () => {
          if (confirm('Unlink this box? The Proxmox container will not be stopped or destroyed.')) {
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
      ? { mode: 'linked', hostId: current.hostId, node: current.node, vmid: current.vmid }
      : { mode: 'linked', hostId: '', node: '', vmid: 0 };
    section.replaceChildren(
      el('div', { class: 'pve-eyebrow' }, ['Proxmox association']),
      el('div', { class: 'pve-picker-grid' }, [field('Host', host), field('Node', node), field('Container', container)]),
      message,
    );
    await loadHosts(current?.hostId).catch(showError);
  }
  renderSummary();
  return {
    element: section,
    async commit(boxId: string) {
      const mutation = associationMutation(current, draft);
      if (mutation?.kind === 'link') await api.setProxmoxLink(boxId, mutation.link);
      if (mutation?.kind === 'unlink') await api.clearProxmoxLink(boxId);
    },
  };
}
