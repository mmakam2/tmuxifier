// Pure preset -> Proxmox `POST /nodes/{node}/lxc` parameter mapping. No I/O.

export function buildNet0(net, ipOverride, gwOverride) {
  const parts = ['name=eth0', `bridge=${net.bridge}`];
  if (net.vlan) parts.push(`tag=${net.vlan}`);
  // auto-static stores neither cidr nor gateway — the provision flow allocates
  // an address from NetBox and infers the gateway (prefix's first usable IP),
  // passing both as overrides so it takes the same ip/gw branch as static.
  if (net.ipMode === 'static' || net.ipMode === 'auto-static') {
    parts.push(`ip=${ipOverride || net.cidr}`);
    const gw = gwOverride || net.gateway;
    if (gw) parts.push(`gw=${gw}`);
  } else {
    parts.push('ip=dhcp');
  }
  return parts.join(',');
}

export function buildCreateParams(preset, { vmid, hostname, ip, gateway, publicKeys, password }) {
  const params = {
    vmid,
    hostname,
    ostemplate: preset.template,
    rootfs: `${preset.storage}:${preset.diskGiB}`,
    cores: preset.cores,
    memory: preset.memoryMiB,
    swap: preset.swapMiB,
    unprivileged: preset.unprivileged ? 1 : 0,
    onboot: preset.onboot ? 1 : 0,
    net0: buildNet0(preset.net, ip, gateway),
  };
  const feats = Object.entries(preset.features || {}).filter(([, v]) => v).map(([k]) => `${k}=1`);
  if (feats.length) params.features = feats.join(',');
  if (preset.dns?.nameserver) params.nameserver = preset.dns.nameserver;
  if (preset.dns?.searchdomain) params.searchdomain = preset.dns.searchdomain;
  if (publicKeys && publicKeys.length) params['ssh-public-keys'] = publicKeys.join('\n') + '\n';
  if (password) params.password = password;
  // Additional disks → Proxmox mount points: mpN=<storage>:<sizeGiB>,mp=<path>[,backup=1]
  for (const m of preset.mounts || []) {
    params[m.id] = `${m.storage}:${m.sizeGiB},mp=${m.path}${m.backup ? ',backup=1' : ''}`;
  }
  return params;
}
