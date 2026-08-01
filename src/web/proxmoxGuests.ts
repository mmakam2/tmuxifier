import { pve, type LifecycleAction, type PveGuestKind, type PveGuestState, type PveLinkedGuest } from './proxmox';
import { el, err, input, openModal } from './dom';
import { registerModal } from './modalRegistry';

export const kindLabel = (kind: PveGuestKind): 'CT' | 'VM' => (kind === 'qemu' ? 'VM' : 'CT');

export function actionsForState(state: PveGuestState): LifecycleAction[] {
  if (state === 'running') return ['shutdown', 'stop', 'reboot', 'deprovision'];
  if (state === 'stopped') return ['start', 'deprovision'];
  if (state === 'missing') return ['deprovision'];
  // 'unknown' and 'mismatch' both offer nothing: one because we cannot see the
  // guest, the other because the guest we can see may not be ours.
  return [];
}

// Sidebar-style live filter: case-insensitive substring over the fields a row
// displays, so "stopped" filters by state, a node name by node, a VMID by id,
// and "vm"/"ct" filters by the kind badge the row shows.
export function guestMatches(guest: PveLinkedGuest, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [guest.boxLabel, guest.hostName ?? guest.hostId, guest.node, String(guest.vmid), kindLabel(guest.kind), guest.state]
    .some((field) => field.toLowerCase().includes(t));
}

function openDeprovisionDialog(guest: PveLinkedGuest, onConfirm: (name: string) => Promise<void>) {
  const modal = el('form', { class: 'modal pve-deprovision-modal' });
  const typed = input('', { autocomplete: 'off' });
  const submit = el('button', { type: 'submit', class: 'pve-primary', disabled: true }, ['Deprovision']);
  const errorLine = el('div', { class: 'pve-err' });
  // Body-mounted, so teardown must be able to reach it: an expiring session
  // otherwise leaves a live Deprovision button over the login screen.
  const { close } = openModal({ modal, onClose: () => unregister() });
  const unregister = registerModal(close);
  typed.addEventListener('input', () => { submit.disabled = typed.value !== guest.boxLabel; });
  modal.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; errorLine.textContent = '';
    try { await onConfirm(typed.value); close(); }
    catch (error) { errorLine.textContent = error instanceof Error ? error.message : 'Deprovision failed'; submit.disabled = typed.value !== guest.boxLabel; }
  });
  modal.append(
    el('h2', {}, ['Deprovision guest']),
    el('div', {}, [`${guest.boxLabel} | ${kindLabel(guest.kind)} | ${guest.hostName ?? guest.hostId} | ${guest.node} | VMID ${guest.vmid}`]),
    el('p', { class: 'pve-warning' }, [guest.state === 'missing'
      ? 'Proxmox already reports this guest missing. Tmuxifier will remove only the stale linked box.'
      : `Tmuxifier will ask Proxmox to shut the guest down gracefully, force it off if it has not stopped within the grace period, then destroy it and its ${guest.kind === 'qemu' ? 'disks' : 'volumes'}, keep independent backups, and remove the linked box.`]),
    el('label', { class: 'field' }, [el('span', {}, [`Type ${guest.boxLabel} to confirm`]), typed]),
    errorLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), submit]),
  );
  typed.focus();
}

export async function renderGuestsTab(content: HTMLElement, deps: {
  focusBoxId?: string;
  showLifecycleJob: (id: string) => void;
  openEditBox: (boxId: string) => void;
}) {
  // Refresh rebuilds the whole tab; carry the outgoing search term across so
  // the filter survives (tab switches render fresh and reset it, as everywhere).
  const previousTerm = content.querySelector<HTMLInputElement>('.pve-guest-search')?.value ?? '';
  const refresh = el('button', { type: 'button', class: 'pve-btn', title: 'Refresh guest state' }, ['Refresh']);
  const search = input(previousTerm, { type: 'text', class: 'pve-guest-search', placeholder: 'Search…', autocomplete: 'off' });
  const toolbar = el('div', { class: 'pve-guest-toolbar' }, [search, refresh]);
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void renderGuestsTab(content, deps).catch((error) => {
      content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not refresh guests'));
      refresh.disabled = false;
    });
  });
  let guests: PveLinkedGuest[];
  try { guests = await pve.linkedGuests(); }
  catch (error) {
    content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not load guests'));
    return;
  }
  const list = el('div', { class: 'pve-guest-list' });
  // Rows are built once; the filter only toggles `hidden`, so in-flight action
  // buttons, inline errors, and the focused-row highlight survive typing.
  const rowPairs: { row: HTMLElement; guest: PveLinkedGuest }[] = [];
  const noMatch = el('div', { class: 'pve-sub' }, ['No guests match.']);
  const applyFilter = () => {
    let visible = 0;
    for (const pair of rowPairs) {
      const show = guestMatches(pair.guest, search.value);
      pair.row.hidden = !show;
      if (show) visible += 1;
    }
    noMatch.hidden = rowPairs.length === 0 || visible > 0;
  };
  search.addEventListener('input', applyFilter);
  for (const guest of guests) {
    const actions = el('div', { class: 'pve-row-actions' });
    const row = el('div', { class: `pve-row pve-guest-row${deps.focusBoxId === guest.boxId ? ' focused' : ''}` }, [
      el('div', {}, [el('strong', {}, [guest.boxLabel]), el('div', { class: 'pve-sub' }, [`${guest.hostName ?? guest.hostId} | ${guest.node} | VMID ${guest.vmid}`])]),
      el('span', { class: `pve-badge kind ${guest.kind}` }, [kindLabel(guest.kind)]),
      el('span', { class: `pve-badge ${guest.state}` }, [guest.state]),
      actions,
    ]);
    if (guest.state === 'mismatch' && guest.error) row.append(err(guest.error));
    if (guest.activeJob) {
      actions.append(el('button', {
        type: 'button', class: 'pve-btn',
        onclick: () => deps.showLifecycleJob(guest.activeJob!.id),
      }, [`View ${guest.activeJob.action}`]));
    } else {
      for (const action of actionsForState(guest.state)) {
        const label = action === 'deprovision' ? 'Deprovision' : action === 'stop' ? 'Stop now' : action[0].toUpperCase() + action.slice(1);
        const button = el('button', {
          type: 'button',
          class: action === 'deprovision' ? 'danger' : action === 'stop' ? 'warn' : '',
          ...(action === 'stop' ? { title: 'Force an immediate stop' } : {}),
        }, [label]);
        button.addEventListener('click', () => {
          const run = async (confirmName?: string) => {
            button.disabled = true;
            row.querySelector('.pve-err')?.remove();
            try {
              const job = await pve.createLifecycleJob({ boxId: guest.boxId, action, ...(confirmName ? { confirmName } : {}) });
              deps.showLifecycleJob(job.id);
            } finally { button.disabled = false; }
          };
          if (action === 'deprovision') openDeprovisionDialog(guest, run);
          else void run().catch((error) => { row.append(err(error instanceof Error ? error.message : 'Lifecycle action failed')); });
        });
        actions.append(button);
      }
    }
    if (guest.state === 'unknown' || guest.state === 'missing' || guest.state === 'mismatch') {
      actions.append(el('button', { type: 'button', onclick: () => deps.openEditBox(guest.boxId) }, ['Edit link']));
    }
    list.append(row);
    rowPairs.push({ row, guest });
    if (deps.focusBoxId === guest.boxId) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
  }
  content.replaceChildren(toolbar, guests.length ? list : el('div', { class: 'pve-sub' }, ['No linked Proxmox guests.']), noMatch);
  applyFilter();
}
