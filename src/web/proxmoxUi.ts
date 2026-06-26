import { api, type Box } from './api';
import { pve, type PvePreset, type ProvisionStatus } from './proxmox';

type HubOpts = { openBox: (b: Box) => void; onBoxLinked: () => void };
type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else if (typeof v === 'boolean') { if (v) node.setAttribute(k, ''); }
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}
function input(value = '', attrs: Attrs = {}) { const i = el('input', attrs); i.value = value; return i; }
function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
function err(msg: string) { return el('div', { class: 'pve-err' }, [msg]); }

const TABS = ['Hosts', 'SSH Keys', 'Presets', 'Provision', 'History'] as const;
type Tab = typeof TABS[number];

export function openProxmoxHub(opts: HubOpts) {
  let pollTimer: number | null = null;
  let pollGen = 0;
  const stopPoll = () => { pollGen++; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };

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

  let active: Tab = 'Hosts';
  const renderers: Record<Tab, () => Promise<void> | void> = {
    Hosts: renderHosts, 'SSH Keys': renderKeys, Presets: renderPresets, Provision: renderProvision, History: renderHistory,
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
  selectTab('Hosts');

  function setContent(...nodes: (Node | string)[]) { content.replaceChildren(...nodes); }

  // --- Hosts ---
  async function renderHosts() {
    const hosts = await pve.hosts().catch(() => []);
    const list = el('div', { class: 'pve-list' }, hosts.map((h) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [h.name]), el('span', { class: 'pve-sub' }, [` ${h.endpoint} · ${h.verifyMode}`])]),
      el('div', { class: 'pve-row-actions' }, [
        el('button', { type: 'button', onclick: async () => { try { await pve.testHost(h.id); alert('Reachable ✓'); } catch (e) { alert(`Test failed: ${(e as Error).message}`); } } }, ['Test']),
        el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove host ${h.name}?`)) { await pve.removeHost(h.id); void renderHosts(); } } }, ['Remove']),
      ]),
    ])));

    const name = input('', { placeholder: 'lab-pve' });
    const endpoint = input('', { placeholder: 'pve.example.com:8006' });
    const tokenId = input('', { placeholder: 'user@pam!tmuxifier' });
    const tokenSecret = input('', { placeholder: 'token secret (uuid)', type: 'password' });
    const defaultNode = input('', { placeholder: 'pve (optional default node)' });
    const fpLine = el('div', { class: 'pve-sub' }, ['Click Inspect to fetch and pin the TLS certificate.']);
    let verifyMode: 'pin' | 'ca' | 'insecure' = 'pin';
    let fingerprint256: string | null = null;
    const box = el('div', {});

    const inspectBtn = el('button', { type: 'button', onclick: async () => {
      try {
        const r = await pve.inspect(endpoint.value.trim());
        if (!r.reachable) { fpLine.replaceChildren(err(r.error || 'unreachable')); return; }
        fingerprint256 = r.fingerprint256;
        verifyMode = r.caValid ? 'ca' : 'pin';
        fpLine.replaceChildren(`${r.caValid ? 'CA-valid ✓ (will verify normally)' : 'self-signed → pin'} · ${r.fingerprint256 || ''}`);
      } catch (e) { fpLine.replaceChildren(err((e as Error).message)); }
    } }, ['Inspect']);

    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault();
      box.querySelector('.pve-err')?.remove();
      if (verifyMode === 'pin' && !fingerprint256) { box.append(err('Inspect the endpoint first to pin its certificate.')); return; }
      try {
        await pve.addHost({ name: name.value.trim(), endpoint: endpoint.value.trim(), tokenId: tokenId.value.trim(), tokenSecret: tokenSecret.value, verifyMode, fingerprint256, defaultNode: defaultNode.value.trim() || null });
        void renderHosts();
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add host']);

    box.append(
      el('h3', {}, ['Add a Proxmox host']),
      field('Name', name), field('Endpoint', endpoint), field('Token id', tokenId), field('Token secret', tokenSecret),
      el('div', { class: 'pve-inline' }, [inspectBtn, fpLine]),
      field('Default node', defaultNode),
      el('div', { class: 'modal-actions' }, [save]),
    );
    setContent(list, el('hr', { class: 'pve-hr' }), box);
  }

  // --- SSH Keys ---
  async function renderKeys() {
    const keys = await pve.keys().catch(() => []);
    const list = el('div', { class: 'pve-list' }, keys.map((k) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [k.name]), el('span', { class: 'pve-sub' }, [` ${k.publicKey.slice(0, 40)}…`])]),
      el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove key ${k.name}?`)) { await pve.removeKey(k.id); void renderKeys(); } } }, ['Remove']),
    ])));
    const name = input('', { placeholder: 'mgmt' });
    const pk = el('textarea', { class: 'pve-textarea', placeholder: 'ssh-ed25519 AAAA… you@example.com', rows: 3 });
    const box = el('div', {});
    const save = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      try { await pve.addKey({ name: name.value.trim(), publicKey: (pk as HTMLTextAreaElement).value.trim() }); void renderKeys(); }
      catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add key']);
    box.append(el('h3', {}, ['Add a management public key']), field('Name', name), field('Public key', pk), el('div', { class: 'modal-actions' }, [save]));
    setContent(list, el('hr', { class: 'pve-hr' }), box);
  }

  // --- Presets ---
  async function renderPresets() {
    const [presets, hosts, keys] = await Promise.all([pve.presets().catch(() => []), pve.hosts().catch(() => []), pve.keys().catch(() => [])]);
    const list = el('div', { class: 'pve-list' }, presets.map((p) => el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [p.name]), el('span', { class: 'pve-sub' }, [` ${p.cores}c/${p.memoryMiB}MiB · ${p.net.ipMode}`])]),
      el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove preset ${p.name}?`)) { await pve.removePreset(p.id); void renderPresets(); } } }, ['Remove']),
    ])));

    if (!hosts.length || !keys.length) {
      setContent(list, el('hr', { class: 'pve-hr' }), el('div', { class: 'pve-sub' }, ['Add at least one host and one SSH key before creating a preset.']));
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
    const unpriv = el('input', { type: 'checkbox' }); (unpriv as HTMLInputElement).checked = true;
    const nesting = el('input', { type: 'checkbox' }); (nesting as HTMLInputElement).checked = true;
    const startAfter = el('input', { type: 'checkbox' }); (startAfter as HTMLInputElement).checked = true;
    const ipMode = el('select', {}, [el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static'])]);
    const cidr = input('', { placeholder: '192.168.1.50/24' });
    const gateway = input('', { placeholder: '192.168.1.1' });
    const vlan = input('', { placeholder: 'vlan (optional)', type: 'number' });
    const keyBoxes = keys.map((k) => { const c = el('input', { type: 'checkbox', value: k.id }); return { k, c }; });
    const box = el('div', {});

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
        unprivileged: (unpriv as HTMLInputElement).checked, features: { nesting: (nesting as HTMLInputElement).checked },
        net: { bridge: bridgeSel.value, vlan: vlan.value ? Number(vlan.value) : null, ipMode: ipMode.value, cidr: cidr.value.trim() || null, gateway: gateway.value.trim() || null },
        keyIds: keyBoxes.filter((x) => (x.c as HTMLInputElement).checked).map((x) => x.k.id),
        onboot: false, startAfterCreate: (startAfter as HTMLInputElement).checked,
      };
      try { await pve.addPreset(spec); void renderPresets(); }
      catch (er) { box.append(err((er as Error).message)); }
    } }, ['Add preset']);

    box.append(
      el('h3', {}, ['Add a container preset']),
      field('Name', name), field('Host', hostSel), field('Node', nodeSel), field('Template storage', tmplStoreSel), field('Template', tmplSel), field('Storage (rootfs)', storeSel),
      el('div', { class: 'pve-grid' }, [field('Disk GiB', disk), field('Cores', cores), field('Memory MiB', mem), field('Swap MiB', swap)]),
      el('label', { class: 'check-field' }, [unpriv, el('span', {}, ['Unprivileged'])]),
      el('label', { class: 'check-field' }, [nesting, el('span', {}, ['Nesting'])]),
      field('Bridge', bridgeSel), field('IP mode', ipMode),
      el('div', { class: 'pve-grid' }, [field('CIDR (static)', cidr), field('Gateway (static)', gateway), field('VLAN', vlan)]),
      el('div', { class: 'field' }, [el('span', {}, ['Inject keys']), ...keyBoxes.map((x) => el('label', { class: 'check-field' }, [x.c, el('span', {}, [x.k.name])]))]),
      el('label', { class: 'check-field' }, [startAfter, el('span', {}, ['Start after create'])]),
      el('div', { class: 'modal-actions' }, [save]),
    );
    setContent(list, el('hr', { class: 'pve-hr' }), box);
    await loadNodes();
  }

  // --- Provision ---
  async function renderProvision() {
    const presets = await pve.presets().catch(() => []);
    if (!presets.length) { setContent(el('div', { class: 'pve-sub' }, ['Create a preset first.'])); return; }
    const sel = el('select', {}, presets.map((p) => el('option', { value: p.id }, [p.name]))) as HTMLSelectElement;
    const hostname = input('', { placeholder: 'dev-01' });
    const vmid = input('', { placeholder: 'auto (next free)', type: 'number' });
    const ip = input('', { placeholder: 'override IP/CIDR (static only)' });
    const ipField = field('IP/CIDR', ip);
    const box = el('div', {});
    const curPreset = (): PvePreset | undefined => presets.find((p) => p.id === sel.value);
    const syncStatic = () => { ipField.style.display = curPreset()?.net.ipMode === 'static' ? '' : 'none'; };
    sel.addEventListener('change', syncStatic);

    const go = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      try {
        const job = await pve.createProvision({ presetId: sel.value, hostname: hostname.value.trim(), vmid: vmid.value ? Number(vmid.value) : undefined, ip: ip.value.trim() || undefined });
        showJob(job.id);
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Provision']);

    box.append(el('h3', {}, ['Provision a container']), field('Preset', sel), field('Hostname', hostname), field('VMID', vmid), ipField, el('div', { class: 'modal-actions' }, [go]));
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
  function showJob(id: string) {
    stopPoll();
    const myGen = pollGen;
    let linked = false;
    const phase = el('div', { class: 'pve-phase' });
    const log = el('pre', { class: 'pve-log' });
    const footer = el('div', { class: 'modal-actions' });
    setContent(el('h3', {}, ['Provision job']), phase, log, footer);

    const RUNNING: ProvisionStatus[] = ['running'];
    async function tick() {
      let job;
      try { job = await pve.provision(id); } catch { if (myGen !== pollGen) return; pollTimer = window.setTimeout(tick, 1500); return; }
      if (myGen !== pollGen) return;
      phase.textContent = `${job.status.toUpperCase()} · ${job.phase}${job.vmid ? ` · vmid ${job.vmid}` : ''}${job.error ? ` · ${job.error}` : ''}`;
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      if (RUNNING.includes(job.status)) { pollTimer = window.setTimeout(tick, 1500); return; }
      // terminal
      footer.replaceChildren();
      if (job.boxId && !linked) { linked = true; opts.onBoxLinked(); }
      if (job.boxId) {
        footer.append(el('button', { type: 'button', class: 'pve-primary', onclick: async () => {
          const boxes = await api.boxes(); const b = boxes.find((x) => x.id === job!.boxId);
          if (b) { close(); opts.openBox(b); }
        } }, ['Open terminal']));
      } else if (job.needsHost) {
        footer.append(el('span', { class: 'pve-sub' }, [`Container ${job.vmid} is up but no IP was discovered — add a box manually.`]));
      }
    }
    void tick();
  }
}
