// Pure preset -> Proxmox `POST /nodes/{node}/lxc` parameter mapping. No I/O.

export function buildNet0(net, ipOverride) {
  const parts = ['name=eth0', `bridge=${net.bridge}`];
  if (net.vlan) parts.push(`tag=${net.vlan}`);
  if (net.ipMode === 'static') {
    parts.push(`ip=${ipOverride || net.cidr}`);
    if (net.gateway) parts.push(`gw=${net.gateway}`);
  } else {
    parts.push('ip=dhcp');
  }
  return parts.join(',');
}

export function buildCreateParams(preset, { vmid, hostname, ip, publicKeys }) {
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
    net0: buildNet0(preset.net, ip),
  };
  const feats = Object.entries(preset.features || {}).filter(([, v]) => v).map(([k]) => `${k}=1`);
  if (feats.length) params.features = feats.join(',');
  if (preset.dns?.nameserver) params.nameserver = preset.dns.nameserver;
  if (preset.dns?.searchdomain) params.searchdomain = preset.dns.searchdomain;
  if (publicKeys && publicKeys.length) params['ssh-public-keys'] = publicKeys.join('\n') + '\n';
  return params;
}
