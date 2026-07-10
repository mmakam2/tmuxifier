import { api, type Box } from './api';
import { pve, type PvePreset, type PveMount, type ProvisionStatus } from './proxmox';
import { openProvisionTerminal } from './terminal';
import { el, input, field, err, group } from './dom';
import { openSettingsModal } from './settingsUi';

type SetupOptions = { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean };

type HubOpts = { openBox: (b: Box) => void; onBoxLinked: () => void };

// Small modal (on top of the hub) to add a container mount point, Proxmox-style.
function openAddDiskModal(opts: { id: string; storages: string[]; onAdd: (m: PveMount) => void }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal pve-disk-modal' });
  const close = () => backdrop.remove();
  let pressed = false;
  backdrop.addEventListener('mousedown', (e) => { pressed = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressed) close(); });
  const storageSel = el('select', {}, opts.storages.map((s) => el('option', { value: s }, [s]))) as HTMLSelectElement;
  const size = input('8', { type: 'number', min: '1' });
  const path = input('', { placeholder: '/data' });
  const backup = el('input', { type: 'checkbox' });
  const box = el('div', {});
  const add = el('button', { type: 'submit', class: 'pve-primary', onclick: (e: Event) => {
    e.preventDefault(); box.querySelector('.pve-err')?.remove();
    const p = path.value.trim();
    if (!storageSel.value) { box.append(err('Pick a storage for the disk.')); return; }
    if (!p.startsWith('/')) { box.append(err('Path must be absolute, e.g. /data.')); return; }
    opts.onAdd({ id: opts.id, storage: storageSel.value, sizeGiB: Number(size.value) || 1, path: p, backup: (backup as HTMLInputElement).checked });
    close();
  } }, ['Add disk']);
  const cancel = el('button', { type: 'button', class: 'pve-btn', onclick: close }, ['Cancel']);
  box.append(
    el('h3', {}, ['Add disk']),
    field('Storage', storageSel), field('Disk size (GiB)', size), field('Path', path),
    el('label', { class: 'check-field' }, [backup, el('span', {}, ['Include in backups'])]),
    el('div', { class: 'modal-actions' }, [cancel, add]),
  );
  modal.append(box);
  backdrop.append(modal);
  document.body.append(backdrop);
}

const TABS = ['Presets', 'Provision', 'History'] as const;
type Tab = typeof TABS[number];

export function openProxmoxHub(opts: HubOpts) {
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

  let active: Tab = 'Presets';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Presets: renderPresets, Provision: renderProvision, History: renderHistory,
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
  selectTab('Presets');

  function setContent(...nodes: (Node | string)[]) { content.replaceChildren(...nodes); }

  // --- Presets ---
  async function renderPresets() {
    const [presets, hosts] = await Promise.all([pve.presets().catch(() => []), pve.hosts().catch(() => [])]);
    const list = el('div', { class: 'pve-list' }, presets.map((p) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [p.name]), el('span', { class: 'pve-sub' }, [` ${p.cores}c/${p.memoryMiB}MiB · ${p.net.ipMode}`])]),
      el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove preset ${p.name}?`)) { await pve.removePreset(p.id); void renderPresets(); } } }, ['Remove']),
    ])));

    if (!hosts.length) {
      setContent(list, el('hr', { class: 'pve-hr' }),
        el('div', { class: 'pve-sub' }, ['Add a Proxmox host in Settings → Proxmox before creating a preset.']),
        el('div', {}, [el('button', { type: 'button', class: 'pve-btn', onclick: () => openSettingsModal('proxmox') }, ['Open Settings'])]),
      );
      return;
    }

    const name = input('', { placeholder: 'debian-dev' });
    const hostSel = el('select', {}, hosts.map((h) => el('option', { value: h.id }, [h.name])));
    const nodeSel = el('select', {});
    const tmplSel = el('select', {});
    const tmplStoreSel = el('select', {});
    const storeSel = el('select', {});
    const bridgeSel = el('select', {});
    const disk = input('8', { type: 'number', min: '1' });
    const cores = input('2', { type: 'number', min: '1' });
    const mem = input('2048', { type: 'number', min: '16' });
    const swap = input('512', { type: 'number', min: '0' });
    const ipMode = el('select', {}, [el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static'])]);
    const cidr = input('', { placeholder: '192.168.1.50/24' });
    const gateway = input('', { placeholder: '192.168.1.1' });
    const vlan = input('', { placeholder: 'vlan (optional)', type: 'number' });
    const cidrGwRow = el('div', { class: 'pve-grid' }, [field('CIDR', cidr), field('Gateway', gateway)]);
    const syncNet = () => { cidrGwRow.style.display = (ipMode as HTMLSelectElement).value === 'static' ? '' : 'none'; };
    ipMode.addEventListener('change', syncNet);
    const box = el('div', {});
    const mounts: PveMount[] = [];
    let rootdirStorages: string[] = [];
    const mountsList = el('div', { class: 'pve-list' });
    function renderMounts() {
      mountsList.replaceChildren(...mounts.map((m, i) => el('div', { class: 'pve-row' }, [
        el('div', {}, [el('strong', {}, [m.id]), el('span', { class: 'pve-sub' }, [` ${m.storage}:${m.sizeGiB} → ${m.path}${m.backup ? ' · backup' : ''}`])]),
        el('button', { type: 'button', class: 'danger', onclick: () => { mounts.splice(i, 1); renderMounts(); } }, ['Remove']),
      ])));
    }
    const addDiskBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => {
      const used = new Set(mounts.map((m) => m.id));
      let n = 0; while (used.has(`mp${n}`)) n += 1;
      openAddDiskModal({ id: `mp${n}`, storages: rootdirStorages, onAdd: (m) => { mounts.push(m); renderMounts(); } });
    } }, ['+ Add disk']);

    async function loadNodes() {
      nodeSel.replaceChildren(el('option', {}, ['…']));
      const nodes = await pve.nodes(hostSel.value).catch(() => []);
      nodeSel.replaceChildren(...nodes.map((n) => el('option', { value: n.node }, [n.node])));
      await loadNodeScoped();
    }
    async function loadNodeScoped() {
      const id = hostSel.value, node = nodeSel.value;
      if (!node) return;
      const [sg, br] = await Promise.all([pve.storage(id, node).catch(() => ({ rootdir: [], vztmpl: [] })), pve.bridges(id, node).catch(() => [])]);
      storeSel.replaceChildren(...sg.rootdir.map((s) => el('option', { value: s.storage }, [s.storage])));
      rootdirStorages = sg.rootdir.map((s) => s.storage);
      bridgeSel.replaceChildren(...br.map((b) => el('option', { value: b.iface }, [b.iface])));
      // Template storage drives the template list: list the storages that can hold templates
      // (content includes vztmpl), then load whatever templates exist on the selected one.
      tmplStoreSel.replaceChildren(...sg.vztmpl.map((s) => el('option', { value: s.storage }, [s.storage])));
      await loadTemplates();
    }
    async function loadTemplates() {
      const id = hostSel.value, node = nodeSel.value, storage = (tmplStoreSel as HTMLSelectElement).value;
      if (!node || !storage) { tmplSel.replaceChildren(); return; }
      const tmpls = await pve.templates(id, node, storage).catch(() => []);
      tmplSel.replaceChildren(...tmpls.map((t) => el('option', { value: t.volid }, [t.volid.split('/').pop() || t.volid])));
    }
    hostSel.addEventListener('change', () => void loadNodes());
    nodeSel.addEventListener('change', () => void loadNodeScoped());
    tmplStoreSel.addEventListener('change', () => void loadTemplates());

    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      const spec = {
        name: name.value.trim(), hostId: hostSel.value, node: nodeSel.value,
        template: tmplSel.value, storage: storeSel.value, diskGiB: Number(disk.value),
        cores: Number(cores.value), memoryMiB: Number(mem.value), swapMiB: Number(swap.value),
        unprivileged: true, features: { nesting: true }, // sensible defaults; not exposed in the UI
        net: { bridge: bridgeSel.value, vlan: vlan.value ? Number(vlan.value) : null, ipMode: ipMode.value, cidr: cidr.value.trim() || null, gateway: gateway.value.trim() || null },
        onboot: false, startAfterCreate: true, mounts,
      };
      try { await pve.addPreset(spec); void renderPresets(); }
      catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add preset']);

    box.append(
      el('h3', {}, ['Add a container preset']),
      group('Identity', field('Preset Name', name), field('Host', hostSel), field('Node', nodeSel)),
      group('Template', field('Template storage', tmplStoreSel), field('Template', tmplSel)),
      group('Disk', el('div', { class: 'pve-grid' }, [field('Storage (rootfs)', storeSel), field('Disk GiB', disk)])),
      group('Additional disks', mountsList, addDiskBtn),
      group('Resources', el('div', { class: 'pve-grid-3' }, [field('Cores', cores), field('Memory MiB', mem), field('Swap MiB', swap)])),
      group('Network', field('Bridge', bridgeSel), field('IP mode', ipMode), cidrGwRow, field('VLAN', vlan)),
      el('div', { class: 'modal-actions' }, [save]),
    );
    setContent(list, el('hr', { class: 'pve-hr' }), box);
    syncNet();
    await loadNodes();
  }

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
}
