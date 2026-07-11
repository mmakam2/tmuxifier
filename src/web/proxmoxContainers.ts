import { pve, type LifecycleAction, type PveContainerState, type PveLinkedContainer } from './proxmox';
import { el, err, input } from './dom';

export function actionsForState(state: PveContainerState): LifecycleAction[] {
  if (state === 'running') return ['shutdown', 'stop', 'reboot', 'deprovision'];
  if (state === 'stopped') return ['start', 'deprovision'];
  if (state === 'missing') return ['deprovision'];
  return [];
}

// Sidebar-style live filter: case-insensitive substring over the fields a row
// displays, so "stopped" filters by state, a node name by node, a VMID by id.
export function containerMatches(container: PveLinkedContainer, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [container.boxLabel, container.hostName ?? container.hostId, container.node, String(container.vmid), container.state]
    .some((field) => field.toLowerCase().includes(t));
}

function openDeprovisionDialog(container: PveLinkedContainer, onConfirm: (name: string) => Promise<void>) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('form', { class: 'modal pve-deprovision-modal' });
  const typed = input('', { autocomplete: 'off' });
  const submit = el('button', { type: 'submit', class: 'pve-primary', disabled: true }, ['Deprovision']);
  const errorLine = el('div', { class: 'pve-err' });
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKeyDown); backdrop.remove(); };
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (event) => { pressedOnBackdrop = event.target === backdrop; });
  backdrop.addEventListener('click', (event) => { if (pressedOnBackdrop && event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeyDown);
  typed.addEventListener('input', () => { submit.disabled = typed.value !== container.boxLabel; });
  modal.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; errorLine.textContent = '';
    try { await onConfirm(typed.value); close(); }
    catch (error) { errorLine.textContent = error instanceof Error ? error.message : 'Deprovision failed'; submit.disabled = typed.value !== container.boxLabel; }
  });
  modal.append(
    el('h2', {}, ['Deprovision container']),
    el('div', {}, [`${container.boxLabel} | ${container.hostName ?? container.hostId} | ${container.node} | VMID ${container.vmid}`]),
    el('p', { class: 'pve-warning' }, [container.state === 'missing'
      ? 'Proxmox already reports this container missing. Tmuxifier will remove only the stale linked box.'
      : 'Tmuxifier will gracefully shut down the container, destroy it and its attached volumes, keep independent backups, then remove the linked box.']),
    el('label', { class: 'field' }, [el('span', {}, [`Type ${container.boxLabel} to confirm`]), typed]),
    errorLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), submit]),
  );
  backdrop.append(modal); document.body.append(backdrop); typed.focus();
}

export async function renderContainersTab(content: HTMLElement, deps: {
  focusBoxId?: string;
  showLifecycleJob: (id: string) => void;
  openEditBox: (boxId: string) => void;
}) {
  // Refresh rebuilds the whole tab; carry the outgoing search term across so
  // the filter survives (tab switches render fresh and reset it, as everywhere).
  const previousTerm = content.querySelector<HTMLInputElement>('.pve-container-search')?.value ?? '';
  const refresh = el('button', { type: 'button', class: 'pve-btn', title: 'Refresh container state' }, ['Refresh']);
  const search = input(previousTerm, { type: 'text', class: 'pve-container-search', placeholder: 'Search…', autocomplete: 'off' });
  const toolbar = el('div', { class: 'pve-container-toolbar' }, [search, refresh]);
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void renderContainersTab(content, deps).catch((error) => {
      content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not refresh containers'));
      refresh.disabled = false;
    });
  });
  let containers: PveLinkedContainer[];
  try { containers = await pve.linkedContainers(); }
  catch (error) {
    content.replaceChildren(toolbar, err(error instanceof Error ? error.message : 'Could not load containers'));
    return;
  }
  const list = el('div', { class: 'pve-container-list' });
  // Rows are built once; the filter only toggles `hidden`, so in-flight action
  // buttons, inline errors, and the focused-row highlight survive typing.
  const rowPairs: { row: HTMLElement; container: PveLinkedContainer }[] = [];
  const noMatch = el('div', { class: 'pve-sub' }, ['No containers match.']);
  const applyFilter = () => {
    let visible = 0;
    for (const pair of rowPairs) {
      const show = containerMatches(pair.container, search.value);
      pair.row.hidden = !show;
      if (show) visible += 1;
    }
    noMatch.hidden = rowPairs.length === 0 || visible > 0;
  };
  search.addEventListener('input', applyFilter);
  for (const container of containers) {
    const actions = el('div', { class: 'pve-row-actions' });
    const row = el('div', { class: `pve-row pve-container-row${deps.focusBoxId === container.boxId ? ' focused' : ''}` }, [
      el('div', {}, [el('strong', {}, [container.boxLabel]), el('div', { class: 'pve-sub' }, [`${container.hostName ?? container.hostId} | ${container.node} | VMID ${container.vmid}`])]),
      el('span', { class: `pve-badge ${container.state}` }, [container.state]),
      actions,
    ]);
    if (container.activeJob) {
      actions.append(el('button', {
        type: 'button', class: 'pve-btn',
        onclick: () => deps.showLifecycleJob(container.activeJob!.id),
      }, [`View ${container.activeJob.action}`]));
    } else {
      for (const action of actionsForState(container.state)) {
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
              const job = await pve.createLifecycleJob({ boxId: container.boxId, action, ...(confirmName ? { confirmName } : {}) });
              deps.showLifecycleJob(job.id);
            } finally { button.disabled = false; }
          };
          if (action === 'deprovision') openDeprovisionDialog(container, run);
          else void run().catch((error) => { row.append(err(error instanceof Error ? error.message : 'Lifecycle action failed')); });
        });
        actions.append(button);
      }
    }
    if (container.state === 'unknown' || container.state === 'missing') {
      actions.append(el('button', { type: 'button', onclick: () => deps.openEditBox(container.boxId) }, ['Edit link']));
    }
    list.append(row);
    rowPairs.push({ row, container });
    if (deps.focusBoxId === container.boxId) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
  }
  content.replaceChildren(toolbar, containers.length ? list : el('div', { class: 'pve-sub' }, ['No linked Proxmox containers.']), noMatch);
  applyFilter();
}
