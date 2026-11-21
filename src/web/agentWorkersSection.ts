// The Edit Box modal's "Agent workers" section (design 5.4): the box's projects
// (name, directory, the folder-trust tick), whether an agent message may start an
// agent here (shown only while messaging is on), and the cap on worker sessions.
// Same contract as agentMailSection.ts: `element` goes into the modal body,
// `commit(boxId)` is awaited by the save handler after the box itself is saved.
//
// The record loads when the modal opens. Until it has loaded (or when the load
// failed) commit does nothing: it must never save a record the operator did not
// see. commit sends the PUT only when the edited record differs from the loaded
// one, and refuses while any row has a problem, throwing the row's own message
// behind the same "Box saved, but…" prefix a failed PUT gets.
// Rows are built once per add/remove and edited in place, so typing never loses
// focus; every message comes from agentWorkersView.ts.
import type { Box } from './api';
import { workersApi, type WorkerProject, type WorkerSettings } from './agentWorkers';
import { MAX_PROJECTS, WORKERS_MAX_LIMIT, maxProblem, projectProblem, workersChanged, workersProblem } from './agentWorkersView';
import { el } from './dom';

const copy = (w: WorkerSettings): WorkerSettings => ({
  projects: w.projects.map((p) => ({ name: p.name, dir: p.dir, trust: p.trust })), mailStart: w.mailStart, max: w.max,
});

export function createAgentWorkersSection(box: Box) {
  const section = el('section', { class: 'wk-section' });
  const eyebrow = () => el('div', { class: 'pve-eyebrow' }, ['Agent workers']);
  section.append(eyebrow(), el('div', { class: 'pve-sub' }, ['Loading agent worker settings…']));

  let loaded: WorkerSettings | null = null;
  let draft: WorkerSettings | null = null;

  const list = el('div', { class: 'wk-projects' });
  const notes: HTMLElement[] = [];
  const addBtn = el('button', { type: 'button', class: 'pve-btn wk-add' }, ['Add project']) as HTMLButtonElement;

  function setNote(node: HTMLElement, problem: string | null) {
    node.textContent = problem ?? '';
    node.classList.toggle('bad', problem !== null);
  }

  function paintNotes() {
    draft!.projects.forEach((p, i) => setNote(notes[i], projectProblem(p, draft!.projects.slice(0, i))));
  }

  function projectRow(p: WorkerProject, i: number) {
    const name = el('input', { type: 'text', class: 'wk-input wk-name', placeholder: 'name', 'aria-label': `Project ${i + 1} name`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    name.value = p.name;
    name.addEventListener('input', () => { p.name = name.value; paintNotes(); });
    const dir = el('input', { type: 'text', class: 'wk-input wk-dir', placeholder: '/opt/billing-api', 'aria-label': `Project ${i + 1} directory`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    dir.value = p.dir;
    dir.addEventListener('input', () => { p.dir = dir.value; paintNotes(); });
    const trust = el('input', { type: 'checkbox' }) as HTMLInputElement;
    trust.checked = p.trust;
    trust.addEventListener('change', () => { p.trust = trust.checked; });
    const remove = el('button', {
      type: 'button', class: 'wk-remove', 'aria-label': `Remove project ${i + 1}`,
      onclick: () => { draft!.projects.splice(i, 1); paintRows(); },
    }, ['×']);
    const note = el('div', { class: 'wk-note' });
    notes[i] = note;
    return el('div', { class: 'wk-row' }, [
      name, dir, remove,
      el('label', { class: 'check-field wk-trust' }, [trust, el('span', {}, ["Skip Claude's folder-trust question"])]),
      note,
    ]);
  }

  function paintRows(focusLast = false) {
    notes.length = 0;
    const rows = draft!.projects.map(projectRow);
    list.replaceChildren(...(rows.length ? rows : [el('div', { class: 'pve-sub' }, ['No projects: no agent can be started on this box'])]));
    addBtn.disabled = draft!.projects.length >= MAX_PROJECTS;
    paintNotes();
    if (focusLast && rows.length) rows[rows.length - 1].querySelector('input')?.focus();
  }

  addBtn.addEventListener('click', () => {
    if (draft!.projects.length >= MAX_PROJECTS) return;
    draft!.projects.push({ name: '', dir: '', trust: false });
    paintRows(true);
  });

  function render(view: { workers: WorkerSettings; mail: boolean }) {
    loaded = copy(view.workers);
    draft = copy(view.workers);
    paintRows();

    const mailStart = el('input', { type: 'checkbox' }) as HTMLInputElement;
    mailStart.checked = draft.mailStart;
    mailStart.addEventListener('change', () => { draft!.mailStart = mailStart.checked; });

    const max = el('input', { type: 'number', class: 'wk-input wk-max', min: '1', max: String(WORKERS_MAX_LIMIT), step: '1' }) as HTMLInputElement;
    max.value = String(draft.max);
    const maxNote = el('div', { class: 'wk-note' });
    // An empty or partial field reads as NaN, which maxProblem refuses.
    max.addEventListener('input', () => { draft!.max = max.value === '' ? Number.NaN : Number(max.value); setNote(maxNote, maxProblem(draft!.max)); });

    section.replaceChildren(
      eyebrow(),
      el('div', { class: 'wk-lead' }, ['Projects']),
      list,
      el('div', {}, [addBtn]),
      ...(view.mail ? [el('label', { class: 'check-field' }, [mailStart, el('span', {}, ['Let agent messages start an agent here'])])] : []),
      el('label', { class: 'wk-max-row' }, [el('span', {}, ['At most']), max, el('span', {}, ['worker sessions'])]),
      maxNote,
    );
  }

  void workersApi.get(box.id).then(render, () => {
    section.replaceChildren(eyebrow(), el('div', { class: 'pve-sub' }, ['Agent worker settings are unavailable']));
  });

  return {
    element: section,
    async commit(boxId: string) {
      if (!loaded || !draft || !workersChanged(loaded, draft)) return;
      // The box is already saved when this runs, so every refusal says so.
      const notSaved = (why: string) => new Error(`Box saved, but the agent worker settings were not: ${why}`);
      const problem = workersProblem(draft);
      if (problem) throw notSaved(problem);
      let saved: WorkerSettings;
      try {
        saved = (await workersApi.save(boxId, draft)).workers;
      } catch (error) {
        throw notSaved(error instanceof Error && error.message ? error.message : 'request failed');
      }
      loaded = copy(saved);
    },
  };
}
