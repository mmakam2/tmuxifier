import { api, type Box } from './api';
import { nbx } from './netbox';
import { pve, type PvePreset, type ProvisionStatus } from './proxmox';
import { openProvisionTerminal } from './terminal';
import { el, input, field, err, openModal } from './dom';
import { openSettingsModal } from './settingsUi';
import { renderPresetsTab } from './proxmoxPresets';
import { renderContainersTab } from './proxmoxContainers';
import { renderActivityTab } from './proxmoxActivity';
import { setupStatusText, formatSeedResults } from './setupStatus';
import { createInteractiveLauncher } from './interactiveLauncher';
import { registerModal } from './modalRegistry';
import { createSetupJobPoller } from './setupPoller';
import { createSetupOptionsForm, type SetupOptionsValues } from './setupOptions';
import { presetSummary } from './presetSummary';

type SetupOptions = SetupOptionsValues;

type HubOpts = {
  openBox: (box: Box) => void;
  openEditBox: (boxId: string) => void;
  onBoxLinked: () => void;
};
type HubInitial = { tab?: Tab; focusBoxId?: string };
const TABS = ['Containers', 'Presets', 'Provision', 'Activity'] as const;
type Tab = typeof TABS[number];

export function openProxmoxHub(opts: HubOpts, initial: HubInitial = {}) {
  let pollTimer: number | null = null;
  let pollGen = 0;
  // One interactive setup session at a time (same rule as the provision panel).
  const setupLauncher = createInteractiveLauncher<{ dispose: () => void }>();
  let setupPoller: { start: () => void; stop: () => void } | null = null;
  const stopPoll = () => { pollGen++; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } setupPoller?.stop(); setupPoller = null; setupLauncher.stop(); };

  const modal = el('div', { class: 'modal pve-hub' });
  const tabStrip = el('div', { class: 'pve-tabs' });
  const content = el('div', { class: 'pve-content' });
  // openModal also gives the hub Escape-to-close, which its hand-rolled
  // scaffold had drifted away from.
  const { close } = openModal({ modal, onClose: () => { unregister(); stopPoll(); } });
  // Body-mounted: register so logout/session-expiry teardown can close the hub
  // (it survives the #app re-render and its pollers would run forever).
  const unregister = registerModal(close);

  let active: Tab = initial.tab ?? 'Containers';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Containers: () => renderContainersTab(content, { focusBoxId: initial.focusBoxId, showLifecycleJob, openEditBox: opts.openEditBox }),
    Presets: () => renderPresetsTab(content, { openSettingsModal }),
    Provision: renderProvision,
    Activity: () => renderActivityTab(content, { showProvisionJob: showJob, showLifecycleJob }),
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

    const setupForm = createSetupOptionsForm();

    const box = el('div', {});
    const curPreset = (): PvePreset | undefined => presets.find((p) => p.id === sel.value);
    // Live one-line description of the selected preset; also decides whether
    // the static-IP override field applies.
    const summary = el('div', { class: 'pve-sub' });
    // Non-binding next-IP preview for auto-static presets. Generation-guarded:
    // a response landing after the user switched presets must not paint
    // (same stale-response discipline as fleetPoll.ts / setupPoller.ts).
    const preview = el('div', { class: 'pve-sub' });
    let previewGen = 0;
    async function syncPreview(p: PvePreset | undefined) {
      const gen = ++previewGen;
      if (!p || p.net.ipMode !== 'auto-static' || p.net.vlan == null) { preview.textContent = ''; return; }
      preview.textContent = 'next IP: …';
      try {
        const r = await nbx.nextIp(p.net.vlan);
        if (gen !== previewGen) return;
        preview.textContent = r.ok
          ? `next IP: ${r.address.split('/')[0]} (from ${r.prefix}, non-binding)`
          : `next IP unavailable: ${r.error}`;
      } catch (e) {
        if (gen !== previewGen) return;
        preview.textContent = `next IP unavailable: ${(e as Error).message}`;
      }
    }
    const syncPreset = () => {
      const p = curPreset();
      summary.textContent = p ? presetSummary(p) : '';
      ipField.style.display = p?.net.ipMode === 'static' ? '' : 'none';
      void syncPreview(p);
    };
    sel.addEventListener('change', syncPreset);

    const go = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      const t = tag.value.trim();
      const setupOptions: SetupOptions = setupForm.values();
      try {
        const job = await pve.createProvision({ presetId: sel.value, hostname: hostname.value.trim(), ip: curPreset()?.net.ipMode === 'static' ? (ip.value.trim() || undefined) : undefined, tags: t ? [t] : [], setupOptions });
        showJob(job.id, setupOptions);
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Provision']);

    box.append(
      el('h3', {}, ['Provision a container']),
      el('fieldset', { class: 'setup-section' }, [
        el('legend', {}, ['Container']),
        field('Preset', sel), summary, preview,
        field('Hostname', hostname), ipField,
        field('Tag', tag), tagDatalist,
      ]),
      setupForm.element,
      el('div', { class: 'modal-actions' }, [go]),
    );
    setContent(box);
    syncPreset();
  }

  // --- Job panel (shared) ---
  // `setup` is provided only for a fresh provision (not an Activity view): when the box links,
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

    async function runSetup(boxId: string, vmid: number | null) {
      // The provision manager auto-started a server-side setup job on link (Task 6): the
      // SSH-readiness wait and the setup run itself now happen server-side. Discover that
      // job and poll it; the WS terminal is opened only as the "Finish interactively"
      // fallback below, never to run setup itself.
      setupArea.style.marginTop = '8px';
      const setupLog = el('pre', { class: 'pve-log' });
      setupArea.replaceChildren(setupLog);

      // Shared poll loop (setupPoller.ts); the policy renders this tab's chrome.
      setupPoller?.stop();
      const poller = createSetupJobPoller<import('./api').SetupJob>({
        fetchJob: () => api.getBoxSetup(boxId),
        onJob: (job) => {
          if (!job) return 1500; // job not discovered yet / transient fetch error
          phase.textContent = `vmid ${vmid ?? ''} · ${setupStatusText(job)}`;
          setupLog.textContent = job.log || '';
          setupLog.scrollTop = setupLog.scrollHeight;
          if (job.status === 'running') return 1500;
          opts.onBoxLinked();
          footer.replaceChildren();
          // Seeding happened inside the job, before this status flip — read it
          // off the job rather than firing a request from the tab.
          const seedTxt = formatSeedResults(job.seed);
          if (seedTxt) phase.textContent = `${phase.textContent} · auth: ${seedTxt}`;
          if (job.status === 'needs-interactive') {
            const finishBtn = el('button', { type: 'button', class: 'pve-primary' }, ['Finish interactively']) as HTMLButtonElement;
            finishBtn.disabled = setupLauncher.active();
            finishBtn.onclick = () => {
              if (setupLauncher.active()) return;
              finishBtn.disabled = true;
              const term = el('div', {}); (term as HTMLElement).style.height = '320px'; setupArea.append(term);
              setupLauncher.launch(() => openProvisionTerminal(term as HTMLElement, boxId, job.options, () => { setupLauncher.done(); poller.start(); }));
            };
            footer.append(finishBtn, openTerminalBtn(boxId));
          } else {
            footer.append(openTerminalBtn(boxId));
          }
          return null; // settled — the interactive fallback re-enters via poller.start()
        },
      });
      setupPoller = poller;
      poller.start();
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
        if (setup && !setupStarted) { setupStarted = true; void runSetup(job.boxId, job.vmid); return; }
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
