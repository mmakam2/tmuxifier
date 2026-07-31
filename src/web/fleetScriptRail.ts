// The saved-script rail inside the Fleet script modal. DOM layer only — the
// pure half lives in fleetScripts.ts. update() rewrites in place (paneHeader.ts's
// shape) so a refresh never steals focus from the editor beside it.
import { el } from './dom';
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';
import type { FleetScript } from './fleetScripts';

export interface RailState {
  scripts: FleetScript[];
  /** null selects the unnamed draft row. */
  selectedId: string | null;
  dirty: boolean;
}

export interface RailHooks {
  onSelect(script: FleetScript | null): void;
  onDelete(script: FleetScript): void;
}

export interface FleetScriptRail {
  readonly dom: HTMLElement;
  update(state: RailState): void;
  destroy(): void;
}

export function buildFleetScriptRail(hooks: RailHooks): FleetScriptRail {
  const list = el('ul', { class: 'fs-list' });
  const newBtn = el('button', { type: 'button', class: 'fs-new' }, ['+ New']);
  const dom = el('div', { class: 'fleet-script-rail' }, [
    el('div', { class: 'fs-eyebrow' }, ['Saved']),
    list,
    newBtn,
  ]);

  // Delete is destructive, so it arms before it fires — the same reducer the
  // Proxmox lifecycle keys and the Reconnect buttons use.
  let arm: ArmState = IDLE;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let last: RailState = { scripts: [], selectedId: null, dirty: false };

  function disarm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    arm = IDLE;
  }

  newBtn.addEventListener('click', () => { disarm(); hooks.onSelect(null); });

  function render(state: RailState) {
    last = state;
    list.innerHTML = '';

    // The unnamed draft is a real row so it can be returned to after clicking a
    // saved script — the buffer is never orphaned by a selection.
    const draftRow = el('li', { class: `fs-row fs-draft${state.selectedId === null ? ' selected' : ''}` });
    const draftOpen = el('button', { type: 'button', class: 'fs-open' }, ['Draft']);
    draftOpen.addEventListener('click', () => { disarm(); hooks.onSelect(null); });
    if (state.selectedId === null && state.dirty) draftOpen.append(el('span', { class: 'fs-dot', title: 'Unsaved' }, ['•']));
    draftRow.appendChild(draftOpen);
    list.appendChild(draftRow);

    if (!state.scripts.length) {
      list.appendChild(el('li', { class: 'fs-empty' }, ['No saved scripts yet — name one and hit Save.']));
      return;
    }

    for (const script of state.scripts) {
      const selected = script.id === state.selectedId;
      const row = el('li', { class: `fs-row${selected ? ' selected' : ''}` });
      const open = el('button', { type: 'button', class: 'fs-open', title: script.description || script.name }, [script.name]);
      open.addEventListener('click', () => { disarm(); hooks.onSelect(script); });
      if (selected && state.dirty) open.append(el('span', { class: 'fs-dot', title: 'Unsaved changes' }, ['•']));

      const armed = arm.armed === script.id;
      const del = el('button', {
        type: 'button',
        class: `fs-del${armed ? ' armed' : ''}`,
        title: armed ? `Click again to delete "${script.name}"` : `Delete "${script.name}"`,
        'aria-label': armed ? `Confirm delete ${script.name}` : `Delete ${script.name}`,
      }, [armed ? 'Delete?' : '✕']);
      del.addEventListener('click', () => {
        const out = armReduce(arm, { type: 'click', id: script.id, armable: true });
        arm = out.state;
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        if (arm.armed) armTimer = setTimeout(() => { arm = IDLE; render(last); }, ARM_MS);
        render(last);
        if (out.fire) hooks.onDelete(script);
      });

      row.append(open, del);
      list.appendChild(row);
    }
  }

  render(last);
  return {
    dom,
    update(state) { render(state); },
    destroy() { disarm(); },
  };
}
