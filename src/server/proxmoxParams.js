// Pure preset -> Proxmox `POST /nodes/{node}/lxc` parameter mapping. No I/O.

import { isCidr, isIp } from './proxmoxValidate.js';

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

// --- net0 as PVE reports it (the re-address job's input) ---
// PVE emits `key=value` tokens joined by commas and never quotes a value, so a
// plain split is exact. A token without `=` is not something PVE writes and is
// rejected rather than guessed at. Order is preserved so the rebuilt string
// differs from the original only where this feature means it to.
export function parseNet0(str) {
  const s = String(str || '').trim();
  if (!s) throw new Error('net0 is empty');
  return s.split(',').map((token) => {
    const i = token.indexOf('=');
    if (i <= 0) throw new Error(`unparseable net0 token: ${JSON.stringify(token)}`);
    return [token.slice(0, i), token.slice(i + 1)];
  });
}

export function net0Field(pairs, key) {
  const hit = pairs.find(([k]) => k === key);
  return hit ? hit[1] : null;
}

// The IPv4 view the dialog shows and the job records. `ip=dhcp`/`ip=manual`
// read as null: the interface has no static address for the job to "move".
export function describeNet0(pairs) {
  const ip = net0Field(pairs, 'ip');
  const gw = net0Field(pairs, 'gw');
  const tag = net0Field(pairs, 'tag');
  return {
    bridge: net0Field(pairs, 'bridge'),
    vlan: tag != null && /^\d{1,4}$/.test(tag) ? Number(tag) : null,
    ip: ip && isCidr(ip) ? ip : null,
    gateway: gw && isIp(gw) ? gw : null,
  };
}

// Rewrite only tag/ip/gw; every other pair keeps its position and value
// (hwaddr, bridge, firewall, mtu, rate, ip6, gw6, …), so the MAC and bridge
// never change and IPv6 is untouched. A managed key that is absent is
// appended, so a previously untagged interface gains its tag.
export function buildNet0Readdress(pairs, { vlan, ip, gateway }) {
  const managed = new Map([['tag', String(vlan)], ['ip', ip], ['gw', gateway]]);
  const out = [];
  for (const [k, v] of pairs) {
    if (managed.has(k)) { out.push(`${k}=${managed.get(k)}`); managed.delete(k); }
    else out.push(`${k}=${v}`);
  }
  for (const [k, v] of managed) out.push(`${k}=${v}`);
  return out.join(',');
}
