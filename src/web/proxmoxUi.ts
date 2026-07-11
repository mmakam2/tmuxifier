import { api, type Box } from './api';
import { pve, type PvePreset, type ProvisionStatus } from './proxmox';
import { openProvisionTerminal } from './terminal';
import { el, input, field, err } from './dom';
import { openSettingsModal } from './settingsUi';
import { renderPresetsTab } from './proxmoxPresets';
import { renderContainersTab } from './proxmoxContainers';

type SetupOptions = { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean };

type HubOpts = {
  openBox: (box: Box) => void;
  openEditBox: (boxId: string) => void;
  onBoxLinked: () => void;
};
type HubInitial = { tab?: Tab; focusBoxId?: string };
const TABS = ['Containers', 'Presets', 'Provision', 'History'] as const;
type Tab = typeof TABS[number];

export function openProxmoxHub(opts: HubOpts, initial: HubInitial = {}) {
  let pollTimer: number | null = null;
  let pollGen = 0;
  let setupTerm: { dispose: () => void } | null = null;
  const stopPoll = () => { pollGen++; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (setupTerm) { setupTerm.dispose(); setupTerm = null; } };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal pve-hub' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });
  const close = () => { stopPoll(); backdrop.remove(); };
  // Only close on a genuine backdrop click. A text selection that starts inside the modal
  // and ends on the backdrop produces a click whose target is the backdrop (the common
  // ancestor), which would otherwise close the modal — so require the press to have
  // started on the backdrop too (matches the box/fleet modals in main.ts).
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  let active: Tab = initial.tab ?? 'Containers';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Containers: () => renderContainersTab(content, { focusBoxId: initial.focusBoxId, showLifecycleJob, openEditBox: opts.openEditBox }),
    Presets: () => renderPresetsTab(content, { openSettingsModal }),
    Provision: renderProvision,
    History: renderHistory,
  };
  function selectTab(t: Tab) {
    active = t; stopPoll();
    for (const b of tabStrip.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    void renderers[t]();
  }
  for (const t of TABS) tabStrip.append(el('button', { type: 'button', class: 'pve-tab', 'data-tab': t, onclick: () => selectTab(t) }, [t]));

  modal.append(
    el('div', { class: 'pve-head' }, [el('h2', {}, ['Proxmox']), el('button', { type: 'button', class: 'pve-close', title: 'Close', onclick: close }, ['✕'])]),
    tabStrip, content,
  );
  backdrop.append(modal);
  document.body.append(backdrop);
  selectTab(active);

  function setContent(...nodes: (Node | string)[]) { content.replaceChildren(...nodes); }

  // --- Provision ---
  async function renderProvision() {
    const [presets, boxes] = await Promise.all([pve.presets().catch(() => []), api.boxes().catch(() => [] as Box[])]);
    if (!presets.length) { setContent(el('div', { class: 'pve-sub' }, ['Create a preset first.'])); return; }
    const sel = el('select', {}, presets.map((p) => el('option', { value: p.id }, [p.name]))) as HTMLSelectElement;
    const hostname = input('', { placeholder: 'dev-01' });
    const ip = input('', { placeholder: 'override IP/CIDR (static only)' });
    const ipField = field('IP/CIDR', ip);

    // Tag input with a datalist of existing box tags (same single-tag pattern as the box modal).
    const tagListId = 'pve-tag-options';
    const tagOptions = [...new Set(boxes.flatMap((b) => b.tags || []))].sort();
    const tagDatalist = el('datalist', { id: tagListId }, tagOptions.map((t) => el('option', { value: t })));
    const tag = input('', { placeholder: 'prod, staging (optional)', list: tagListId });

    // Post-create setup (mirrors the box modal). Base tmux is always installed by the setup
    // script; these toggle the optional frameworks.
    const omt = el('input', { type: 'checkbox' }); (omt as HTMLInputElement).checked = true;
    const radio = (value: string, checked: boolean) => { const r = el('input', { type: 'radio', name: 'pve-shell', value }); (r as HTMLInputElement).checked = checked; return r; };
    const shNone = radio('none', true), shZsh = radio('omz', false), shBash = radio('omb', false);

    const box = el('div', {});
    const curPreset = (): PvePreset | undefined => presets.find((p) => p.id === sel.value);
    const syncStatic = () => { ipField.style.display = curPreset()?.net.ipMode === 'static' ? '' : 'none'; };
    sel.addEventListener('change', syncStatic);

    const go = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      const t = tag.value.trim();
      try {
        const job = await pve.createProvision({ presetId: sel.value, hostname: hostname.value.trim(), ip: ip.value.trim() || undefined, tags: t ? [t] : [] });
        showJob(job.id, { ohMyTmux: (omt as HTMLInputElement).checked, ohMyZsh: (shZsh as HTMLInputElement).checked, ohMyBash: (shBash as HTMLInputElement).checked });
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Provision']);

    box.append(
      el('h3', {}, ['Provision a container']),
      field('Preset', sel), field('Hostname', hostname), ipField,
      field('Tag', tag), tagDatalist,
      el('label', { class: 'check-field' }, [omt, el('span', {}, ['Install Oh My Tmux'])]),
      el('div', { class: 'field' }, [el('span', {}, ['Shell framework']),
        el('label', { class: 'check-field' }, [shNone, el('span', {}, ['None'])]),
        el('label', { class: 'check-field' }, [shZsh, el('span', {}, ['Oh My Zsh'])]),
        el('label', { class: 'check-field' }, [shBash, el('span', {}, ['Oh My Bash'])]),
      ]),
      el('div', { class: 'modal-actions' }, [go]),
    );
    setContent(box);
    syncStatic();
  }

  // --- History ---
  async function renderHistory() {
    const jobs = await pve.provisions().catch(() => []);
    const list = el('div', { class: 'pve-list' }, jobs.map((j) => el('button', { type: 'button', class: 'pve-row pve-row-btn', onclick: () => showJob(j.id) }, [
      el('div', {}, [el('strong', {}, [j.hostname]), el('span', { class: 'pve-sub' }, [` ${j.presetName} · vmid ${j.vmid ?? '—'}`])]),
      el('span', { class: `pve-badge ${j.status}` }, [j.status]),
    ])));
    setContent(jobs.length ? list : el('div', { class: 'pve-sub' }, ['No provisions yet.']));
  }

  // --- Job panel (shared) ---
  // `setup` is provided only for a fresh provision (not a History view): when the box links,
  // run the same tmux + oh-my-* install add-box uses, after a brief SSH-readiness wait.
  function showJob(id: string, setup?: SetupOptions) {
    stopPoll();
    const myGen = pollGen;
    let linked = false;
    let setupStarted = false;
    const phase = el('div', { class: 'pve-phase' });
    const log = el('pre', { class: 'pve-log' });
    const setupArea = el('div', {});
    const footer = el('div', { class: 'modal-actions' });
    setContent(el('h3', {}, ['Provision job']), phase, log, setupArea, footer);

    function openTerminalBtn(boxId: string) {
      return el('button', { type: 'button', class: 'pve-primary', onclick: async () => {
        const b = (await api.boxes()).find((x) => x.id === boxId);
        if (b) { close(); opts.openBox(b); }
      } }, ['Open terminal']);
    }

    async function runSetup(boxId: string, vmid: number | null, opt: SetupOptions) {
      const box = (await api.boxes().catch(() => [] as Box[])).find((b) => b.id === boxId);
      if (!box) { footer.replaceChildren(openTerminalBtn(boxId)); return; }
      // Freshly-started container: wait briefly for sshd to accept the injected mgmt key.
      phase.textContent = `Container ${vmid ?? ''} up — waiting for SSH…`;
      let ready = false;
      for (let i = 0; i < 10 && !ready; i++) {
        if (myGen !== pollGen) return;
        try { ready = !!(await api.probeSessions({ id: box.id, host: box.host, user: box.user, port: box.port, proxyJump: box.proxyJump })).reachable; } catch { /* keep waiting */ }
        if (!ready) await new Promise((r) => setTimeout(r, 3000));
      }
      if (myGen !== pollGen) return;
      phase.textContent = `Container ${vmid ?? ''} — running setup (tmux${opt.ohMyTmux ? ' + oh-my-tmux' : ''}${opt.ohMyZsh ? ' + oh-my-zsh' : ''}${opt.ohMyBash ? ' + oh-my-bash' : ''})…`;
      setupArea.style.height = '320px'; setupArea.style.marginTop = '8px';
      setupTerm = openProvisionTerminal(setupArea, boxId, opt, (code) => {
        if (myGen !== pollGen) return;
        phase.textContent = code === 0 ? `Setup complete ✓ · vmid ${vmid ?? ''}` : `Setup exited ${code} — open a terminal to investigate`;
        opts.onBoxLinked();
        footer.replaceChildren(openTerminalBtn(boxId));
      });
    }

    const RUNNING: ProvisionStatus[] = ['running'];
    async function tick() {
      let job;
      try { job = await pve.provision(id); } catch { if (myGen !== pollGen) return; pollTimer = window.setTimeout(tick, 1500); return; }
      if (myGen !== pollGen) return;
      phase.textContent = `${job.status.toUpperCase()} · ${job.phase}${job.vmid ? ` · vmid ${job.vmid}` : ''}${job.error ? ` · ${job.error}` : ''}`;
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      if (RUNNING.includes(job.status)) { pollTimer = window.setTimeout(tick, 1500); return; }
      // terminal status
      footer.replaceChildren();
      if (job.boxId && !linked) { linked = true; opts.onBoxLinked(); }
      if (job.boxId) {
        if (setup && !setupStarted) { setupStarted = true; void runSetup(job.boxId, job.vmid, setup); return; }
        footer.replaceChildren(openTerminalBtn(job.boxId));
      } else if (job.needsHost) {
        footer.append(el('span', { class: 'pve-sub' }, [`Container ${job.vmid} is up but no IP was discovered — add a box manually.`]));
      }
    }
    void tick();
  }

  // --- Lifecycle job panel (Containers tab) ---
  function showLifecycleJob(id: string) {
    stopPoll();
    const generation = pollGen;
    const phase = el('div', { class: 'pve-phase' });
    const log = el('pre', { class: 'pve-log' });
    const footer = el('div', { class: 'modal-actions' });
    setContent(el('h3', {}, ['Lifecycle job']), phase, log, footer);
    async function tick() {
      const job = await pve.lifecycleJob(id).catch(() => null);
      if (generation !== pollGen) return;
      if (!job) { pollTimer = window.setTimeout(tick, 1500); return; }
      phase.textContent = `${job.action.toUpperCase()} | ${job.status.toUpperCase()} | ${job.phase}${job.error ? ` | ${job.error}` : ''}`;
      log.textContent = job.log || '';
      if (job.status === 'running') { pollTimer = window.setTimeout(tick, 1500); return; }
      opts.onBoxLinked();
      await pve.linkedContainers().catch(() => []);
      if (generation !== pollGen) return;
      footer.replaceChildren(el('button', { type: 'button', onclick: () => selectTab('Containers') }, ['Back to Containers']));
    }
    void tick();
  }
}
