// The Re-address dialog: move a linked LXC container to another
// NetBox-managed VLAN/IP. Split like proxmoxGuests.ts — the pure label
// builders are unit-tested, the DOM half is validated on the live app (vitest
// has no DOM). The dialog only chooses a VLAN and starts the lifecycle job;
// every rule about what happens next lives server-side in proxmoxLifecycle.js.
import { pve, type PveGuestNet, type PveLinkedGuest } from './proxmox';
import { nbx, type NetboxVlan } from './netbox';
import { el, err, field, openModal } from './dom';
import { registerModal } from './modalRegistry';

export function vlanOptionLabel(v: NetboxVlan): string {
  const base = `${v.vid} · ${v.name || 'unnamed'} · ${v.prefix}`;
  return v.allocatable ? base : `${base} — ${v.reason ?? 'not allocatable'}`;
}

export function currentNetLine(net: PveGuestNet): string {
  const parts = [net.bridge ?? '?', net.vlan == null ? 'untagged' : `VLAN ${net.vlan}`, net.ip ?? 'dhcp'];
  if (net.gateway) parts.push(`gw ${net.gateway}`);
  return parts.join(' · ');
}

export function openReaddressDialog(guest: PveLinkedGuest, deps: { showLifecycleJob: (id: string) => void }) {
  const modal = el('form', { class: 'modal pve-readdress-modal' });
  const now = el('div', { class: 'pve-sub' }, ['Reading the container interface…']);
  const select = el('select', { class: 'pve-vlan-select', disabled: true }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, ['Loading NetBox VLANs…']));
  const preview = el('div', { class: 'pve-sub' });
  const submit = el('button', { type: 'submit', class: 'pve-primary', disabled: true }, ['Re-address']);
  const errorLine = el('div', { class: 'pve-err' });
  // Body-mounted, so teardown must be able to reach it: an expiring session
  // otherwise leaves a live Re-address button over the login screen.
  const { close } = openModal({ modal, onClose: () => unregister() });
  const unregister = registerModal(close);

  // Non-binding next-free preview from the existing next-ip route; a stale
  // response for a VLAN the user has already moved off is dropped.
  let previewGen = 0;
  const refreshPreview = async () => {
    const gen = ++previewGen;
    const vid = Number(select.value);
    if (!vid) { preview.textContent = ''; return; }
    preview.textContent = 'Looking up the next free address…';
    const res = await nbx.nextIp(vid).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'lookup failed' }));
    if (gen !== previewGen) return;
    preview.textContent = res.ok ? `Next free: ${res.address} in ${res.prefix} (non-binding — allocated when the job runs)` : `Preview unavailable: ${res.error}`;
  };
  select.addEventListener('change', () => { submit.disabled = !select.value; void refreshPreview(); });

  modal.addEventListener('submit', async (event) => {
    event.preventDefault();
    const vlan = Number(select.value);
    if (!vlan) return;
    submit.disabled = true; errorLine.textContent = '';
    try {
      const job = await pve.createLifecycleJob({ boxId: guest.boxId, action: 'readdress', vlan });
      close();
      deps.showLifecycleJob(job.id);
    } catch (error) {
      errorLine.textContent = error instanceof Error ? error.message : 'Re-address failed';
      submit.disabled = !select.value;
    }
  });

  modal.append(
    el('h2', {}, ['Re-address container']),
    // Inlined rather than importing kindLabel from proxmoxGuests.ts, which
    // imports this module — no cycle. Only ever opened for a container anyway.
    el('div', {}, [`${guest.boxLabel} | ${guest.kind === 'qemu' ? 'VM' : 'CT'} | ${guest.hostName ?? guest.hostId} | ${guest.node} | VMID ${guest.vmid}`]),
    now,
    field('Move to VLAN', select),
    preview,
    el('p', { class: 'pve-warning' }, [
      guest.state === 'running'
        ? 'Proxmox re-plugs eth0 live with the new VLAN tag and address. Open terminals on this box drop and reconnect at the new address once SSH answers there. The old address is released to NetBox.'
        : 'The new VLAN tag and address are written to the container config and take effect at its next start. The old address is released to NetBox.',
    ]),
    errorLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), submit]),
  );

  void (async () => {
    const [net, vlans] = await Promise.allSettled([pve.guestNet(guest.boxId), nbx.vlans()]);
    if (net.status === 'fulfilled') now.textContent = `Now: ${currentNetLine(net.value)}`;
    else {
      now.replaceWith(err(net.reason instanceof Error ? net.reason.message : 'Could not read the container interface'));
      select.replaceChildren(el('option', { value: '' }, ['Unavailable']));
      return;
    }
    if (vlans.status === 'rejected') { select.replaceChildren(el('option', { value: '' }, ['NetBox unavailable'])); errorLine.textContent = vlans.reason instanceof Error ? vlans.reason.message : 'Could not load VLANs'; return; }
    if (!vlans.value.ok) { select.replaceChildren(el('option', { value: '' }, ['NetBox unavailable'])); errorLine.textContent = vlans.value.error; return; }
    select.replaceChildren(el('option', { value: '' }, ['Choose a VLAN…']));
    for (const v of vlans.value.vlans) {
      const opt = el('option', { value: String(v.vid) }, [vlanOptionLabel(v)]) as HTMLOptionElement;
      if (!v.allocatable) opt.disabled = true;
      select.append(opt);
    }
    if (vlans.value.vlans.length === 0) { errorLine.textContent = 'NetBox has no IPv4 prefix with a VLAN to allocate from.'; return; }
    select.disabled = false;
    select.focus();
  })();
}
