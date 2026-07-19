import type { PvePreset } from './proxmox';

// One-line description of what a preset provisions, shown live under the
// preset select in the hub's Provision tab. Pure — node tests import this
// without a DOM.
export function presetSummary(p: PvePreset): string {
  const template = (p.template.split('/').pop() ?? p.template).replace(/\.tar\.(gz|xz|zst)$/, '');
  const gib = p.memoryMiB / 1024;
  const mem = Number.isInteger(gib) ? `${gib}` : gib.toFixed(1);
  const parts = [template, `${p.cores}c / ${mem} GiB`, `disk ${p.diskGiB} GiB`];
  if (p.net.vlan != null) parts.push(`vlan ${p.net.vlan}`);
  parts.push(p.net.ipMode === 'auto-static' ? 'IP auto (NetBox)' : p.net.ipMode === 'static' ? 'static IP' : 'DHCP');
  return parts.join(' · ');
}
