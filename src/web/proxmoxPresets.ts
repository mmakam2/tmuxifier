import { pve, type PveHost, type PveMount, type PvePreset } from './proxmox';
import { el, err, field, group, input, openModal } from './dom';
import { nbx } from './netbox';

export type PresetsDeps = { openSettingsModal: (tab: 'proxmox') => void };

// The auto-static option stays when NetBox is configured or when it is
// already the current value (removing a selected option would silently
// rewrite the preset's saved mode on the next save).
export function allowAutoStatic(netboxConfigured: boolean, currentMode: string) {
  return netboxConfigured || currentMode === 'auto-static';
}

type Option = { value: string; label?: string };

function replaceSelectOptions(
  select: HTMLSelectElement,
  options: Option[],
  savedValue: string | null = null,
) {
  const rows = [...options];
  if (savedValue && !rows.some((option) => option.value === savedValue)) {
    rows.unshift({ value: savedValue, label: `${savedValue} (saved)` });
  }
  select.replaceChildren(...rows.map((option) =>
    el('option', { value: option.value }, [option.label ?? option.value])));
  if (savedValue) select.value = savedValue;
}

function templateStorage(template: string) {
  const separator = template.indexOf(':');
  return separator > 0 ? template.slice(0, separator) : '';
}

function openAddDiskModal(opts: { id: string; storages: string[]; onAdd: (mount: PveMount) => void }) {
  const modal = el('div', { class: 'modal pve-disk-modal' });
  // openModal also gives this dialog Escape-to-close, which its hand-rolled
  // scaffold had drifted away from.
  const { close } = openModal({ modal });

  const storage = el('select', {}, opts.storages.map((name) =>
    el('option', { value: name }, [name]))) as HTMLSelectElement;
  const size = input('8', { type: 'number', min: '1' });
  const path = input('', { placeholder: '/data' });
  const backup = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const box = el('div', {});
  const add = el('button', {
    type: 'submit', class: 'pve-primary', onclick: (event: Event) => {
      event.preventDefault();
      box.querySelector('.pve-err')?.remove();
      const mountPath = path.value.trim();
      if (!storage.value) { box.append(err('Pick a storage for the disk.')); return; }
      if (!mountPath.startsWith('/')) { box.append(err('Path must be absolute, e.g. /data.')); return; }
      opts.onAdd({
        id: opts.id, storage: storage.value, sizeGiB: Number(size.value) || 1,
        path: mountPath, backup: backup.checked,
      });
      close();
    },
  }, ['Add disk']);
  const cancel = el('button', { type: 'button', class: 'pve-btn', onclick: close }, ['Cancel']);

  box.append(
    el('h3', {}, ['Add disk']),
    field('Storage', storage), field('Disk size (GiB)', size), field('Path', path),
    el('label', { class: 'check-field' }, [backup, el('span', {}, ['Include in backups'])]),
    el('div', { class: 'modal-actions' }, [cancel, add]),
  );
  modal.append(box);
}

export async function renderPresetsTab(content: HTMLElement, deps: PresetsDeps): Promise<void> {
  const [initialPresets, hosts] = await Promise.all([
    pve.presets().catch(() => [] as PvePreset[]),
    pve.hosts().catch(() => [] as PveHost[]),
  ]);
  let presets = initialPresets;
  let selected: PvePreset | null = null;

  const master = el('div', { class: 'pve-preset-master' });
  const detail = el('div', { class: 'pve-preset-detail' });
  const layout = el('div', { class: 'pve-presets-layout' }, [master, detail]);
  content.replaceChildren(layout);

  function selectPreset(preset: PvePreset | null) {
    selected = preset;
    renderMaster();
    void renderDetail();
  }

  function renderMaster() {
    const list = el('div', { class: 'pve-preset-master-list' }, presets.map((preset) =>
      el('button', {
        type: 'button',
        class: `pve-preset-master-row${selected?.id === preset.id ? ' active' : ''}`,
        onclick: () => selectPreset(preset),
      }, [preset.name])));
    const create = el('button', {
      type: 'button',
      class: `pve-btn pve-preset-new${selected === null ? ' active' : ''}`,
      onclick: () => selectPreset(null),
    }, ['+ New preset']);
    master.replaceChildren(create, list);
  }

  async function renderDetail() {
    if (!hosts.length) {
      detail.replaceChildren(
        el('div', { class: 'pve-sub' }, [
          'Add a Proxmox host in Settings → Proxmox before creating a preset.',
        ]),
        el('div', {}, [el('button', {
          type: 'button', class: 'pve-btn',
          onclick: () => deps.openSettingsModal('proxmox'),
        }, ['Open Settings'])]),
      );
      return;
    }

    const editing = selected;
    const name = input(editing?.name ?? '', { placeholder: 'debian-dev' });
    const host = el('select', {}) as HTMLSelectElement;
    replaceSelectOptions(host, hosts.map((item) => ({ value: item.id, label: item.name })), editing?.hostId ?? null);
    const node = el('select', {}) as HTMLSelectElement;
    const template = el('select', {}) as HTMLSelectElement;
    const templateStore = el('select', {}) as HTMLSelectElement;
    const storage = el('select', {}) as HTMLSelectElement;
    const bridge = el('select', {}) as HTMLSelectElement;
    const disk = input(String(editing?.diskGiB ?? 8), { type: 'number', min: '1' });
    const cores = input(String(editing?.cores ?? 2), { type: 'number', min: '1' });
    const memory = input(String(editing?.memoryMiB ?? 2048), { type: 'number', min: '16' });
    const swap = input(String(editing?.swapMiB ?? 512), { type: 'number', min: '0' });
    const ipMode = el('select', {}, [
      el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static']),
      el('option', { value: 'auto-static' }, ['auto-static (NetBox)']),
    ]) as HTMLSelectElement;
    ipMode.value = editing?.net.ipMode ?? 'dhcp';
    const cidr = input(editing?.net.cidr ?? '', { placeholder: '192.168.1.50/24' });
    const gateway = input(editing?.net.gateway ?? '', { placeholder: '192.168.1.1' });
    const vlan = input(editing?.net.vlan == null ? '' : String(editing.net.vlan), {
      placeholder: 'vlan (optional)', type: 'number',
    });
    const cidrField = field('CIDR', cidr);
    const gatewayField = field('Gateway', gateway);
    const cidrGateway = el('div', { class: 'pve-grid' }, [cidrField, gatewayField]);
    const autoHint = el('div', { class: 'pve-sub' });
    let netboxConfigured = true;
    const syncNetwork = () => {
      const mode = ipMode.value;
      // auto-static needs neither field: the IP is allocated from NetBox and
      // the gateway is inferred (the prefix's first usable IP).
      cidrGateway.style.display = mode === 'static' ? '' : 'none';
      vlan.placeholder = mode === 'auto-static' ? 'vlan (required)' : 'vlan (optional)';
      autoHint.textContent = mode === 'auto-static'
        ? `IP + gateway auto-derived from the NetBox prefix for VLAN ${vlan.value || 'N'}.${netboxConfigured ? '' : ' — configure NetBox in Settings first'}`
        : '';
    };
    ipMode.addEventListener('change', syncNetwork);
    vlan.addEventListener('input', syncNetwork);
    void nbx.get().then(({ settings }) => {
      netboxConfigured = !!settings;
      // Gate fails open on fetch errors (option kept): the server guard in
      // createProvision is the real gate; hiding on a blip would mask a
      // configured capability.
      if (!allowAutoStatic(netboxConfigured, ipMode.value)) {
        ipMode.querySelector('option[value="auto-static"]')?.remove();
      }
      syncNetwork();
    }).catch(() => {});

    const box = el('div', { class: 'pve-preset-form' });
    const mounts = (editing?.mounts ?? []).map((mount) => ({ ...mount }));
    const mountsList = el('div', { class: 'pve-list' });
    let rootdirStorages: string[] = [];

    function renderMounts() {
      mountsList.replaceChildren(...mounts.map((mount, index) =>
        el('div', { class: 'pve-row' }, [
          el('div', {}, [
            el('strong', {}, [mount.id]),
            el('span', { class: 'pve-sub' }, [
              ` ${mount.storage}:${mount.sizeGiB} → ${mount.path}${mount.backup ? ' · backup' : ''}`,
            ]),
          ]),
          el('button', {
            type: 'button', class: 'danger', onclick: () => {
              mounts.splice(index, 1);
              renderMounts();
            },
          }, ['Remove']),
        ])));
    }

    const addDisk = el('button', {
      type: 'button', class: 'pve-btn', onclick: () => {
        const used = new Set(mounts.map((mount) => mount.id));
        let number = 0;
        while (used.has(`mp${number}`)) number += 1;
        openAddDiskModal({
          id: `mp${number}`, storages: rootdirStorages,
          onAdd: (mount) => { mounts.push(mount); renderMounts(); },
        });
      },
    }, ['+ Add disk']);

    async function loadTemplates(saved: PvePreset | null) {
      const storageName = templateStore.value;
      if (!node.value || !storageName) {
        replaceSelectOptions(template, [], saved?.template ?? null);
        return;
      }
      const templates = await pve.templates(host.value, node.value, storageName).catch(() => []);
      replaceSelectOptions(
        template,
        templates.map((item) => ({
          value: item.volid, label: item.volid.split('/').pop() || item.volid,
        })),
        saved?.template ?? null,
      );
    }

    async function loadNodeScoped(saved: PvePreset | null) {
      if (!node.value) {
        rootdirStorages = [];
        replaceSelectOptions(storage, [], saved?.storage ?? null);
        replaceSelectOptions(bridge, [], saved?.net.bridge ?? null);
        replaceSelectOptions(templateStore, [], saved ? templateStorage(saved.template) : null);
        await loadTemplates(saved);
        return;
      }
      const [groups, bridges] = await Promise.all([
        pve.storage(host.value, node.value).catch(() => ({ rootdir: [], vztmpl: [] })),
        pve.bridges(host.value, node.value).catch(() => []),
      ]);
      rootdirStorages = groups.rootdir.map((item) => item.storage);
      replaceSelectOptions(
        storage, groups.rootdir.map((item) => ({ value: item.storage })), saved?.storage ?? null,
      );
      replaceSelectOptions(
        bridge, bridges.map((item) => ({ value: item.iface })), saved?.net.bridge ?? null,
      );
      replaceSelectOptions(
        templateStore,
        groups.vztmpl.map((item) => ({ value: item.storage })),
        saved ? templateStorage(saved.template) : null,
      );
      await loadTemplates(saved);
    }

    async function loadNodes(saved: PvePreset | null) {
      node.replaceChildren(el('option', {}, ['Loading...']));
      const nodes = await pve.nodes(host.value).catch(() => []);
      replaceSelectOptions(
        node, nodes.map((item) => ({ value: item.node })), saved?.node ?? null,
      );
      await loadNodeScoped(saved);
    }

    host.addEventListener('change', () => void loadNodes(null));
    node.addEventListener('change', () => void loadNodeScoped(null));
    templateStore.addEventListener('change', () => void loadTemplates(null));

    function buildSpec() {
      return {
        name: name.value.trim(), hostId: host.value, node: node.value || null,
        template: template.value, storage: storage.value, diskGiB: Number(disk.value),
        cores: Number(cores.value), memoryMiB: Number(memory.value), swapMiB: Number(swap.value),
        unprivileged: editing?.unprivileged ?? true,
        features: editing?.features ?? { nesting: true },
        net: {
          bridge: bridge.value, vlan: vlan.value ? Number(vlan.value) : null,
          ipMode: ipMode.value, cidr: cidr.value.trim() || null,
          gateway: gateway.value.trim() || null,
        },
        dns: editing?.dns ?? { nameserver: null, searchdomain: null },
        onboot: editing?.onboot ?? false,
        startAfterCreate: editing?.startAfterCreate ?? true,
        mounts,
        boxDefaults: editing?.boxDefaults ?? { user: 'root', sessionName: 'web', tags: [] },
      };
    }

    const submit = el('button', { type: 'submit', class: 'pve-primary' }, [editing ? 'Save' : 'Create']);
    submit.addEventListener('click', async (event) => {
      event.preventDefault();
      box.querySelector('.pve-err')?.remove();
      submit.disabled = true;
      try {
        const preset = editing
          ? await pve.updatePreset(editing.id, buildSpec())
          : await pve.addPreset(buildSpec());
        presets = editing
          ? presets.map((item) => item.id === preset.id ? preset : item)
          : [...presets, preset];
        selected = preset;
        renderMaster();
        await renderDetail();
      } catch (error) {
        box.append(err((error as Error).message));
        submit.disabled = false;
      }
    });

    const actions: HTMLElement[] = [];
    if (editing) {
      const remove = el('button', { type: 'button', class: 'pve-btn danger' }, ['Delete']);
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove preset ${editing.name}?`)) return;
        box.querySelector('.pve-err')?.remove();
        remove.disabled = true;
        try {
          await pve.removePreset(editing.id);
          presets = presets.filter((preset) => preset.id !== editing.id);
          selected = null;
          renderMaster();
          await renderDetail();
        } catch (error) {
          box.append(err((error as Error).message));
          remove.disabled = false;
        }
      });
      actions.push(remove);
    }
    actions.push(submit);

    box.append(
      el('h3', {}, [editing ? 'Edit container preset' : 'Create a container preset']),
      group('Identity', field('Preset Name', name), field('Host', host), field('Node', node)),
      group('Template', field('Template storage', templateStore), field('Template', template)),
      group('Disk', el('div', { class: 'pve-grid' }, [
        field('Storage (rootfs)', storage), field('Disk GiB', disk),
      ])),
      group('Additional disks', mountsList, addDisk),
      group('Resources', el('div', { class: 'pve-grid-3' }, [
        field('Cores', cores), field('Memory MiB', memory), field('Swap MiB', swap),
      ])),
      group('Network', field('Bridge', bridge), field('IP mode', ipMode),
        cidrGateway, autoHint, field('VLAN', vlan)),
      el('div', { class: 'modal-actions pve-preset-actions' }, actions),
    );
    detail.replaceChildren(box);
    renderMounts();
    syncNetwork();
    await loadNodes(editing);
  }

  renderMaster();
  await renderDetail();
}
