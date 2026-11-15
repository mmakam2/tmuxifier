// The Edit Box modal's "Agent messaging" section (design 6.11): this box's send
// and receive switches, each with its list of boxes, the "also write the
// matching entry" tick, the per-pair lines and the status line. Same shape as
// proxmoxAssociation.ts: `element` goes into the modal body, `commit(boxId)` is
// awaited by the save handler after the box itself is saved.
//
// The policy loads when the modal opens. Until it has loaded (or when the load
// failed) commit does nothing: it must never save a policy the operator did not
// see. commit sends the PUT only when the edited policy differs from the loaded
// one. Every word comes from agentMailView.ts and lands via textContent / el()
// children only.
import type { Box } from './api';
import { mailApi, type MailBoxView, type MailPolicy } from './agentMail';
import { nameOf, pairLine, policyChanged, statusLine, type MailBoxRef } from './agentMailView';
import { el } from './dom';

type ListKey = 'sendTo' | 'receiveFrom';

const copyPolicy = (p: MailPolicy): MailPolicy => ({ send: p.send, sendTo: [...p.sendTo], receive: p.receive, receiveFrom: [...p.receiveFrom] });

export function createAgentMailSection(box: Box, boxes: readonly MailBoxRef[]) {
  const section = el('section', { class: 'box-mail' });
  const eyebrow = () => el('div', { class: 'pve-eyebrow' }, ['Agent messaging']);
  section.append(eyebrow(), el('div', { class: 'pve-sub' }, ['Loading messaging settings…']));

  let loaded: MailPolicy | null = null;
  let draft: MailPolicy | null = null;
  // Ids added while the tick was on, and not in that list when the modal opened.
  const mirror = new Set<string>();

  function listRow(switchKey: 'send' | 'receive', listKey: ListKey, label: string, lead: string, listName: string) {
    const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = draft![switchKey];
    toggle.addEventListener('change', () => { draft![switchKey] = toggle.checked; });
    const list = el('div', { class: 'mail-list' });

    function paint() {
      const ids = draft![listKey];
      const chips = ids.map((id) => {
        const name = nameOf(id, boxes);
        return el('span', { class: 'mail-chip' }, [
          el('span', {}, [name]),
          el('button', {
            type: 'button', class: 'mail-chip-x', 'aria-label': `Remove ${name} from the ${listName}`,
            onclick: () => {
              draft![listKey] = draft![listKey].filter((x) => x !== id);
              paint();
            },
          }, ['×']),
        ]);
      });
      const add = el('select', { class: 'mail-add', 'aria-label': `Add a box to the ${listName}` }) as HTMLSelectElement;
      add.append(el('option', { value: '' }, ['add box']));
      for (const b of boxes) {
        if (b.id === box.id || ids.includes(b.id)) continue;
        add.append(el('option', { value: b.id }, [b.label]));
      }
      add.disabled = add.options.length === 1;
      add.addEventListener('change', () => {
        const id = add.value;
        if (!id || draft![listKey].includes(id)) return;
        draft![listKey] = [...draft![listKey], id];
        if (mirrorTick.checked && !loaded![listKey].includes(id)) mirror.add(id);
        paint();
      });
      list.replaceChildren(el('span', { class: 'mail-lead' }, [lead]), ...chips, add);
    }
    paint();
    return el('div', { class: 'mail-row' }, [
      el('label', { class: 'check-field' }, [toggle, el('span', {}, [label])]),
      list,
    ]);
  }

  const mirrorTick = el('input', { type: 'checkbox' }) as HTMLInputElement;
  mirrorTick.checked = true;

  function render(view: MailBoxView) {
    loaded = copyPolicy(view.policy);
    draft = copyPolicy(view.policy);
    const pairs = view.pairs.map((p) => el('div', { class: 'mail-pair' }, [pairLine(p, boxes, box.label)]));
    section.replaceChildren(
      eyebrow(),
      listRow('send', 'sendTo', 'Agents here may send', 'to:', 'send list'),
      listRow('receive', 'receiveFrom', 'Agents here may receive', 'from:', 'receive list'),
      el('label', { class: 'check-field' }, [mirrorTick, el('span', {}, ['When adding a box, also write the matching entry on that box'])]),
      ...(pairs.length ? [el('div', { class: 'mail-pairs' }, pairs)] : []),
      el('div', { class: 'mail-status' }, [statusLine(view.status)]),
    );
  }

  void mailApi.boxMail(box.id).then(render, (error: unknown) => {
    const why = error instanceof Error && error.message ? `: ${error.message}` : '';
    section.replaceChildren(eyebrow(), el('div', { class: 'pve-err' }, [`Messaging settings could not be loaded${why}`]));
  });

  return {
    element: section,
    async commit(boxId: string) {
      if (!loaded || !draft || !policyChanged(loaded, draft)) return;
      const listed = new Set([...draft.sendTo, ...draft.receiveFrom]);
      const body = { ...copyPolicy(draft), mirror: [...mirror].filter((id) => listed.has(id)) };
      try {
        await mailApi.saveBoxMail(boxId, body);
      } catch (error) {
        const why = error instanceof Error && error.message ? error.message : 'request failed';
        throw new Error(`Box saved, but the agent messaging settings were not: ${why}`);
      }
      loaded = copyPolicy(draft);
      mirror.clear();
    },
  };
}
