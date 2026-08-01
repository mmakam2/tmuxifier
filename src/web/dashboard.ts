// The standby dashboard: what the screen bay shows when no terminal is docked.
// Pure view-model helpers (unit-tested in node) + a DOM layer that updates in
// place on poll ticks — the sidebar's "the poll never rebuilds whole rows"
// contract, so hover states and tooltips survive repaints. main.ts owns all
// polling and calls update(); this module never fetches.
import type { Box, BoxMetrics, Status, Sample, Service, ServiceStatusSnapshot } from './api';
import type { NetboxSummary } from './netbox';
import type { PveLinkedGuest, PveClusterNode } from './proxmox';
import { dotClassFor, dotTitleFor } from './statusDot';
import { fmtLatency, fmtCount, fmtCompact, fmtUptime, fmtBytes } from './fmt';
import { buildTruenasCard, type TruenasCardEls } from './truenasCard';
import { buildUnifiCard, type UnifiCardEls } from './unifiCard';
import { buildImmichCard, type ImmichCardEls } from './immichCard';
import { buildCatalogIcon, buildServiceIcon, type ServiceIconEls } from './serviceIcon';

// Re-exported so existing importers (and the dashboard tests) keep reaching for
// them here, while card modules import them from ./fmt without a cycle.
export { fmtLatency, fmtCount, fmtCompact, fmtUptime } from './fmt';

export interface DashboardData {
  boxes: Box[];
  status: Record<string, Status>;
  series: Record<string, Sample[]>;
  services: Service[];
  serviceStatus: ServiceStatusSnapshot | null;
  containers: PveLinkedGuest[] | null; // null = Proxmox not configured (module hidden)
  nodes: PveClusterNode[] | null;          // null = not configured / nodes fetch failed
  netbox: NetboxSummary | null;            // null = not fetched yet
}

export interface DashboardHooks {
  onOpenBox(id: string): void;
  onAddBox(): void;
  onAddService(): void;
}

// --- pure view-model -------------------------------------------------------

export function groupServices(services: Service[]): { name: string | null; services: Service[] }[] {
  const order: (string | null)[] = [];
  const byName = new Map<string | null, Service[]>();
  for (const s of services) {
    const name = s.group?.trim() || null;
    if (!byName.has(name)) { byName.set(name, []); order.push(name); }
    byName.get(name)!.push(s);
  }
  // Ungrouped first; the rest keep first-appearance order (stable sort).
  return order
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : 0))
    .map((name) => ({ name, services: byName.get(name)! }));
}


export function serviceLamp(svc: Service, snap: ServiceStatusSnapshot | null): 'up' | 'down' | 'auth' | 'unknown' | 'none' {
  if (svc.check.kind === 'none') return 'none';
  const r = snap?.results[svc.id];
  return r ? r.state : 'unknown';
}




export interface PiholeCard {
  lamp: 'green' | 'red' | 'auth' | '';
  chip: string;
  rows: { label: string; value: string }[];
  error: string;
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded Pi-hole shows one error line rather than a grid
// of dashes — six blank readings say less than one sentence does.
export function piholeCardModel(svc: Service, snap: ServiceStatusSnapshot | null): PiholeCard {
  const r = snap?.results[svc.id];
  if (!r) return { lamp: '', chip: '', rows: [], error: '' };
  if (r.state === 'auth') return { lamp: 'auth', chip: '', rows: [], error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.pihole) return { lamp: 'red', chip: '', rows: [], error: r.error || 'unreachable' };

  const m = r.pihole;
  const timer = m.blocking === 'disabled' && m.blockingTimer != null
    ? ` · ${fmtUptime(m.blockingTimer)} left`
    : '';
  return {
    lamp: 'green',
    chip: `blocking ${m.blocking === 'disabled' ? 'off' : 'on'}${timer}`,
    error: '',
    rows: [
      { label: 'QUERIES', value: fmtCount(m.queriesTotal) },
      { label: 'BLOCKED', value: m.percentBlocked == null ? '—' : `${m.percentBlocked.toFixed(1)}%` },
      { label: 'CLIENTS', value: `${fmtCount(m.clientsActive)}/${fmtCount(m.clientsTotal)}` },
      { label: 'DOMAINS', value: fmtCompact(m.gravityDomains) },
      { label: 'VERSION', value: `${m.versionCore ?? '—'}${m.updateAvailable ? ' ↑' : ''}` },
      { label: 'UPTIME', value: fmtUptime(m.uptimeSec) },
    ],
  };
}

// Display names for the distro ids that carry casing the generic rule would get
// wrong ('almalinux' → 'Almalinux', 'nixos' → 'Nixos'). Anything not listed falls
// back to capitalizing the id, which is right for most of the long tail.
const OS_NAMES: Record<string, string> = {
  almalinux: 'AlmaLinux', alpine: 'Alpine', arch: 'Arch', centos: 'CentOS',
  debian: 'Debian', devuan: 'Devuan', fedora: 'Fedora', gentoo: 'Gentoo',
  linuxmint: 'Linux Mint', nixos: 'NixOS', ol: 'Oracle Linux',
  opensuse: 'openSUSE', 'opensuse-leap': 'openSUSE Leap',
  'opensuse-tumbleweed': 'openSUSE Tumbleweed', raspbian: 'Raspberry Pi OS',
  rhel: 'RHEL', rocky: 'Rocky', sles: 'SLES', ubuntu: 'Ubuntu',
};

// "Debian 12" from the probe's `ID`/`VERSION_ID`. A rolling distro reports no
// VERSION_ID, so the version is appended only when it exists rather than being
// faked with a dash — a name alone is a complete answer there.
export function osLabel(m: BoxMetrics | undefined): string | null {
  const id = m?.osId?.trim();
  if (!id) return null;
  const name = OS_NAMES[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);
  const ver = m?.osVer?.trim();
  return ver ? `${name} ${ver}` : name;
}

// fmtBytes holds one decimal below 100 so a card's numeric column stays aligned.
// A spec line has no column to align to, and an exact capacity is a round number:
// "16.0 GB RAM" reads as a measurement where "16 GB RAM" reads as the spec it is.
// Only a trailing `.0` goes — 29.8 GB of disk really is 29.8.
function fmtSpecBytes(bytes: number): string {
  return fmtBytes(bytes).replace(/\.0 /, ' ');
}

// Used-of-total disk. When both land in the same unit the unit is printed once
// ("29.8/49.1 GB") — the pair reads as one measurement, which is the point;
// across units each keeps its own, since "879/49.1 GB" would be a lie.
export function fmtDiskPair(usedKb: number | undefined, totalKb: number | undefined): string | null {
  if (!totalKb) return null;
  const total = fmtSpecBytes(totalKb * 1024);
  if (usedKb == null) return total;
  const used = fmtSpecBytes(usedKb * 1024);
  const [usedNum, usedUnit] = used.split(' ');
  return usedUnit === total.split(' ')[1] ? `${usedNum}/${total}` : `${used} / ${total}`;
}

// A fleet card's two-line spec sheet: what the box *is* (distro, cores) over
// what it *has* (memory, disk). Deliberately not the cpu/mem/disk percentages —
// the sidebar rows already carry those, and repeating a live gauge here told the
// operator nothing the row beside it didn't. A line with nothing known is
// dropped rather than rendered as a row of dashes.
export function boxSpecLines(st: Status | undefined): string[] {
  const m = st?.metrics;
  if (!m) return [];
  const identity: string[] = [];
  const os = osLabel(m);
  if (os) identity.push(os);
  if (m.cpus) identity.push(`${m.cpus} ${m.cpus === 1 ? 'core' : 'cores'}`);
  const capacity: string[] = [];
  if (m.memTotalKb) capacity.push(`${fmtSpecBytes(m.memTotalKb * 1024)} RAM`);
  const disk = fmtDiskPair(m.diskUsedKb, m.diskTotalKb);
  if (disk) capacity.push(`${disk} disk`);
  return [identity.join(' · '), capacity.join(' · ')].filter(Boolean);
}

export function dashboardMode(boxCount: number, serviceCount: number): 'standby' | 'dash' {
  return boxCount === 0 && serviceCount === 0 ? 'standby' : 'dash';
}

// Tiles that render in the Services section (legacy records without a
// section field predate sections and belong here).
export function sectionServices(services: Service[]): Service[] {
  return services.filter((s) => (s.section ?? 'services') === 'services');
}

// Infrastructure-section tiles, split into the built-in categories they merge
// with (case-insensitive "Proxmox"/"IPAM") and the remaining custom
// categories (ungrouped first, then first-appearance order).
export function partitionInfraGroups(services: Service[]): { proxmox: Service[]; ipam: Service[]; extra: { name: string | null; services: Service[] }[] } {
  const proxmox: Service[] = [];
  const ipam: Service[] = [];
  const rest: Service[] = [];
  for (const s of services) {
    if (s.section !== 'infrastructure') continue;
    const g = (s.group ?? '').trim().toLowerCase();
    if (g === 'proxmox') proxmox.push(s);
    else if (g === 'ipam') ipam.push(s);
    else rest.push(s);
  }
  return { proxmox, ipam, extra: groupServices(rest) };
}

// One module per physical cluster node: online lamp + cpu/mem/disk readout,
// with this node's linked-guest tally appended when any exist. An error
// record (node: null — the whole cluster unreachable) renders as the host
// profile's name with a red lamp.
export function nodeModules(
  nodes: PveClusterNode[],
  containers: PveLinkedGuest[] | null,
): { name: string; lamp: '' | 'green' | 'red'; readout: string }[] {
  return nodes.map((n) => {
    if (n.node === null) {
      return { name: n.hostName ?? 'proxmox', lamp: 'red' as const, readout: n.error ?? 'unreachable' };
    }
    const parts: string[] = [];
    if (n.cpuPct != null) parts.push(`cpu ${n.cpuPct}%`);
    if (n.memPct != null) parts.push(`mem ${n.memPct}%`);
    if (n.diskPct != null) parts.push(`disk ${n.diskPct}%`);
    const linked = (containers ?? []).filter((c) => c.node === n.node);
    if (linked.length) parts.push(`${linked.filter((c) => c.state === 'running').length}/${linked.length} guests`);
    return {
      name: n.node,
      lamp: n.status === 'online' ? 'green' as const : n.status === 'unknown' ? '' as const : 'red' as const,
      readout: parts.join(' · ') || '—',
    };
  });
}

export function pveHostRollup(containers: PveLinkedGuest[]): { hostName: string; running: number; stopped: number; other: number }[] {
  const order: string[] = [];
  const acc = new Map<string, { hostName: string; running: number; stopped: number; other: number }>();
  for (const c of containers) {
    const key = c.hostName ?? '(unnamed host)';
    if (!acc.has(key)) { acc.set(key, { hostName: key, running: 0, stopped: 0, other: 0 }); order.push(key); }
    const row = acc.get(key)!;
    if (c.state === 'running') row.running++;
    else if (c.state === 'stopped') row.stopped++;
    else row.other++;
  }
  return order.map((k) => acc.get(k)!);
}

// --- DOM layer -------------------------------------------------------------

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function legend(text: string): HTMLElement {
  const el = div('dash-legend');
  el.textContent = text;
  return el;
}

// The product's own prompt vocabulary — shared by the masthead and the
// fresh-install hero. Decorative: the copy carries the state for AT.
function prompt(): HTMLElement {
  const p = div('empty-prompt');
  p.setAttribute('aria-hidden', 'true');
  const tilde = document.createElement('span');
  tilde.className = 'empty-tilde';
  tilde.textContent = '~';
  const dollar = document.createElement('span');
  dollar.className = 'empty-dollar';
  dollar.textContent = '$';
  const cursor = document.createElement('span');
  cursor.className = 'empty-cursor';
  p.append(tilde, ' ', dollar, ' ', cursor);
  return p;
}

interface FleetRow {
  root: HTMLButtonElement; lamp: HTMLElement; name: HTMLElement;
  chip: HTMLElement; spec: HTMLElement[];
}

interface Tile {
  root: HTMLAnchorElement; icon: ServiceIconEls; name: HTMLElement;
  lamp: HTMLElement; latency: HTMLElement;
}

// A Pi-hole reports numbers, so it renders as a wide card rather than a lamp.
interface Card {
  root: HTMLAnchorElement; icon: ServiceIconEls; name: HTMLElement;
  lamp: HTMLElement; chip: HTMLElement; grid: HTMLElement; error: HTMLElement;
}

export function createDashboard(hooks: DashboardHooks): { el: HTMLElement; update(patch: Partial<DashboardData>): void; destroy(): void } {
  const data: DashboardData = { boxes: [], status: {}, series: {}, services: [], serviceStatus: null, containers: null, nodes: null, netbox: null };
  let stale = false; // a failed services poll dims the section, keeps the paint

  const el = div('dash');

  // Masthead: shrunken prompt + engraved legend (dash mode only).
  const head = div('dash-head');
  head.append(prompt(), legend('FLEET STANDBY'));

  // Fresh-install hero: the original empty-stage signature, kept as the floor.
  const standby = div('dash-standby');
  {
    const hero = div('empty');
    const title = document.createElement('strong');
    title.className = 'empty-title';
    title.textContent = 'No terminal attached';
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    const kbd = document.createElement('button');
    kbd.type = 'button';
    kbd.className = 'empty-kbd';
    kbd.textContent = '+ Add box';
    kbd.addEventListener('click', () => hooks.onAddBox());
    hint.append('Select a box to open its terminal, or connect a new one with ', kbd, '.');
    hero.append(prompt(), title, hint);
    standby.append(hero);
  }

  const fleet = document.createElement('section');
  fleet.className = 'dash-fleet';
  const fleetGrid = div('dash-fleet-grid');
  fleet.append(legend('FLEET'), fleetGrid);

  const services = document.createElement('section');
  services.className = 'dash-services';
  const servicesHead = div('dash-section-head');
  const servicesLegend = legend('SERVICES');
  const addSvc = document.createElement('button');
  addSvc.type = 'button';
  addSvc.className = 'dash-add-svc';
  addSvc.textContent = '+ ADD SERVICE';
  addSvc.addEventListener('click', () => hooks.onAddService());
  servicesHead.append(servicesLegend, addSvc);
  const servicesBody = div('dash-services-body');
  services.append(servicesHead, servicesBody);

  const infra = document.createElement('section');
  infra.className = 'dash-infra';
  // The optional slug draws the product's own logo from the icon catalog, so
  // the built-in readouts are badged the same way service tiles are. It stays
  // hidden if the catalog was never fetched — the label carries the meaning.
  const sublegend = (text: string, slug?: string) => {
    const l = legend(text);
    l.classList.add('dash-sublegend');
    if (slug) l.prepend(buildCatalogIcon(slug));
    return l;
  };
  const pveGroup = div('dash-infra-group');
  const pveRow = div('dash-infra-row');
  const pveTiles = div('dash-grid');
  pveGroup.append(sublegend('PROXMOX', 'proxmox'), pveRow, pveTiles);
  const ipamGroup = div('dash-infra-group');
  const ipamRow = div('dash-infra-row');
  const ipamTiles = div('dash-grid');
  // NetBox is the only IPAM this dashboard integrates, and the built-in rows
  // under this legend are its prefixes, so its logo is the honest badge.
  ipamGroup.append(sublegend('IPAM', 'netbox'), ipamRow, ipamTiles);
  const infraExtra = div('dash-infra-extra');
  const infraGroups = div('dash-infra-groups');
  infraGroups.append(pveGroup, ipamGroup, infraExtra);
  infra.append(legend('INFRASTRUCTURE'), infraGroups);

  el.append(head, standby, fleet, services, infra);

  // Per-entity element caches: update() mutates and *moves* nodes (appendChild
  // reorders without recreating), so hover and focus survive poll repaints.
  const boxEls = new Map<string, FleetRow>();
  const tileEls = new Map<string, Tile>();
  const cardEls = new Map<string, Card>();
  const truenasEls = new Map<string, TruenasCardEls>();
  const unifiEls = new Map<string, UnifiCardEls>();
  const immichEls = new Map<string, ImmichCardEls>();
  const groupEls = new Map<string | null, { root: HTMLElement; legendEl: HTMLElement | null; grid: HTMLElement }>();
  const infraGroupEls = new Map<string | null, { root: HTMLElement; grid: HTMLElement }>();
  // Tiles render across two sections (Services + Infrastructure categories);
  // this repaint-scoped set lets one cleanup pass at the end of repaint()
  // retire tiles that vanished from either.
  let tilesSeen = new Set<string>();

  function makeFleetRow(id: string): FleetRow {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'dash-box';
    root.addEventListener('click', () => hooks.onOpenBox(id));
    const lamp = document.createElement('span');
    lamp.className = 'dot';
    const name = div('dash-box-name');
    const chip = document.createElement('span');
    chip.className = 'dash-chip';
    chip.hidden = true;
    // Two fixed slots rather than a rebuilt list: boxSpecLines returns at most
    // two, and writing in place keeps the tile contract (a poll never disturbs
    // hover or text selection).
    const spec = [div('dash-box-meta'), div('dash-box-meta')];
    const specBox = div('dash-box-spec');
    specBox.append(...spec);
    const top = div('dash-box-top');
    top.append(lamp, name, chip);
    root.append(top, specBox);
    return { root, lamp, name, chip, spec };
  }

  function paintFleet() {
    const seen = new Set<string>();
    for (const box of data.boxes) {
      seen.add(box.id);
      let row = boxEls.get(box.id);
      if (!row) { row = makeFleetRow(box.id); boxEls.set(box.id, row); }
      const st = data.status[box.id];
      row.lamp.className = `dot ${dotClassFor(st)}`;
      row.root.title = dotTitleFor(st);
      row.name.textContent = box.label;
      const samples = data.series[box.id] ?? [];
      const agent = samples.length ? samples[samples.length - 1].agent : undefined;
      const chipState = agent === 'working' || agent === 'waiting' ? agent : null;
      row.chip.hidden = chipState === null;
      if (chipState) {
        row.chip.textContent = chipState.toUpperCase();
        row.chip.className = `dash-chip dash-chip-${chipState}`;
      }
      // An em dash in the first slot when the box reported no metrics at all
      // (unreachable, mid-setup, or a host the probe can't read) — the lamp and
      // its title carry the reason, so the card only has to not look broken.
      const lines = boxSpecLines(st);
      row.spec.forEach((slot, i) => {
        const text = lines[i] ?? (i === 0 && lines.length === 0 ? '—' : '');
        slot.textContent = text;
        slot.hidden = text === '';
      });
      fleetGrid.appendChild(row.root); // moves into stored order
    }
    for (const [id, row] of boxEls) {
      if (!seen.has(id)) { row.root.remove(); boxEls.delete(id); }
    }
    fleet.hidden = data.boxes.length === 0;
  }

  function makeTile(): Tile {
    const root = document.createElement('a');
    root.className = 'dash-tile';
    root.target = '_blank';
    root.rel = 'noopener';
    const icon = buildServiceIcon();
    const name = div('dash-tile-name');
    const lamp = document.createElement('span');
    lamp.className = 'dot';
    const latency = document.createElement('span');
    latency.className = 'dash-latency';
    const top = div('dash-tile-top');
    top.append(icon.root, lamp, name);
    const bottom = div('dash-tile-bottom');
    bottom.append(latency);
    root.append(top, bottom);
    return { root, icon, name, lamp, latency };
  }

  // Create-or-update one tile and record the sighting; the caller appends the
  // returned element into whichever grid the tile belongs to this repaint
  // (appendChild moves an existing node, so hover survives regrouping too).
  function makeCard(): Card {
    const root = document.createElement('a');
    root.className = 'dash-tile dash-tile-wide';
    root.target = '_blank';
    root.rel = 'noopener';
    const icon = buildServiceIcon();
    const lamp = document.createElement('span');
    lamp.className = 'dot';
    const name = div('dash-tile-name');
    const chip = document.createElement('span');
    chip.className = 'dash-card-chip';
    const top = div('dash-tile-top');
    top.append(icon.root, lamp, name, chip);
    const grid = div('dash-card-grid');
    const error = div('dash-card-error');
    root.append(top, grid, error);
    return { root, icon, name, lamp, chip, grid, error };
  }

  function paintPiholeCard(svc: Service): HTMLElement {
    let card = cardEls.get(svc.id);
    if (!card) { card = makeCard(); cardEls.set(svc.id, card); }
    const model = piholeCardModel(svc, data.serviceStatus);
    card.root.href = svc.url;
    card.icon.update(svc);
    card.name.textContent = svc.name;
    card.lamp.className = `dot ${model.lamp}`.trim();
    card.chip.textContent = model.chip;
    card.chip.hidden = !model.chip;
    card.error.textContent = model.error;
    card.error.hidden = !model.error;
    card.root.title = model.error;

    // Rebuild only when the row count changes; otherwise write in place so the
    // poll never disturbs hover or text selection (the tile contract).
    if (card.grid.children.length !== model.rows.length) {
      card.grid.replaceChildren(...model.rows.map(() => {
        const cell = div('dash-card-cell');
        cell.append(div('dash-card-label'), div('dash-card-value'));
        return cell;
      }));
    }
    const grid = card.grid;
    model.rows.forEach((row, i) => {
      const cell = grid.children[i] as HTMLElement;
      (cell.firstChild as HTMLElement).textContent = row.label;
      (cell.lastChild as HTMLElement).textContent = row.value;
    });
    grid.hidden = model.rows.length === 0;
    return card.root;
  }

  function paintTile(svc: Service): HTMLElement {
    tilesSeen.add(svc.id);
    // A Pi-hole reports numbers, a TrueNAS reports storage, a UniFi reports the
    // network and an Immich reports its library, so all four render as cards
    // rather than lamps; everything downstream (grouping, ordering, cleanup)
    // treats them as tiles.
    if (svc.check.kind === 'pihole') return paintPiholeCard(svc);
    if (svc.check.kind === 'truenas') {
      let card = truenasEls.get(svc.id);
      if (!card) { card = buildTruenasCard(); truenasEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
    if (svc.check.kind === 'unifi') {
      let card = unifiEls.get(svc.id);
      if (!card) { card = buildUnifiCard(); unifiEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
    if (svc.check.kind === 'immich') {
      let card = immichEls.get(svc.id);
      if (!card) { card = buildImmichCard(); immichEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
    let tile = tileEls.get(svc.id);
    if (!tile) { tile = makeTile(); tileEls.set(svc.id, tile); }
    tile.root.href = svc.url;
    tile.icon.update(svc);
    tile.name.textContent = svc.name;
    const lampState = serviceLamp(svc, data.serviceStatus);
    tile.lamp.hidden = lampState === 'none';
    tile.lamp.className = `dot${lampState === 'up' ? ' green' : lampState === 'down' ? ' red' : lampState === 'auth' ? ' auth' : ''}`;
    const result = data.serviceStatus?.results[svc.id];
    tile.latency.textContent = lampState === 'none' ? '' : fmtLatency(result?.latencyMs);
    tile.root.title = result?.state === 'down' && result.error ? result.error : '';
    return tile.root;
  }

  function paintServices() {
    const groups = groupServices(sectionServices(data.services));
    const seenGroups = new Set<string | null>();
    for (const g of groups) {
      seenGroups.add(g.name);
      let block = groupEls.get(g.name);
      if (!block) {
        const root = div('dash-group');
        const legendEl = g.name === null ? null : legend(g.name.toUpperCase());
        const grid = div('dash-grid');
        if (legendEl) root.append(legendEl);
        root.append(grid);
        block = { root, legendEl, grid };
        groupEls.set(g.name, block);
      }
      for (const svc of g.services) block.grid.appendChild(paintTile(svc));
      servicesBody.appendChild(block.root);
    }
    for (const [name, block] of groupEls) {
      if (!seenGroups.has(name)) { block.root.remove(); groupEls.delete(name); }
    }
    servicesLegend.classList.toggle('stale', stale);
  }

  function infraModule(lampClass: string, name: string, readout: string): HTMLElement {
    const mod = div('dash-mod');
    const lamp = document.createElement('span');
    lamp.className = `dot ${lampClass}`.trim();
    const label = div('dash-mod-name');
    label.textContent = name;
    const value = div('dash-mod-readout');
    value.textContent = readout;
    mod.append(lamp, label, value);
    return mod;
  }

  function paintInfra() {
    const parts = partitionInfraGroups(data.services);

    // Module readouts are non-interactive: wholesale swaps are safe there.
    const pveMods: HTMLElement[] = [];
    if (data.nodes !== null && data.nodes.length > 0) {
      // Physical nodes are the primary readout; container tallies fold into them.
      for (const m of nodeModules(data.nodes, data.containers)) {
        pveMods.push(infraModule(m.lamp, m.name, m.readout));
      }
    } else if (data.containers !== null) {
      // Fallback when the nodes fetch failed: the old per-host container rollup.
      const rollup = pveHostRollup(data.containers);
      if (rollup.length === 0) {
        pveMods.push(infraModule('', 'PROXMOX', 'no linked guests'));
      }
      for (const host of rollup) {
        const extra = host.other > 0 ? ` · ${host.other} other` : '';
        pveMods.push(infraModule(host.running > 0 ? 'green' : '', host.hostName, `${host.running} running · ${host.stopped} stopped${extra}`));
      }
    }
    pveRow.replaceChildren(...pveMods);
    for (const svc of parts.proxmox) pveTiles.appendChild(paintTile(svc));
    pveTiles.hidden = parts.proxmox.length === 0;
    pveGroup.hidden = pveMods.length === 0 && parts.proxmox.length === 0;

    const ipamMods: HTMLElement[] = [];
    if (data.netbox?.configured) {
      if (!data.netbox.ok) {
        ipamMods.push(infraModule('red', 'NETBOX', '—'));
      } else if (data.netbox.prefixes.length === 0) {
        ipamMods.push(infraModule('green', 'NETBOX', 'connected'));
      } else {
        for (const p of data.netbox.prefixes) {
          ipamMods.push(infraModule('green', p.prefix, `${p.used}/${p.total}`));
        }
      }
    }
    ipamRow.replaceChildren(...ipamMods);
    for (const svc of parts.ipam) ipamTiles.appendChild(paintTile(svc));
    ipamTiles.hidden = parts.ipam.length === 0;
    ipamGroup.hidden = ipamMods.length === 0 && parts.ipam.length === 0;

    // Custom infrastructure categories (e.g. DNS Filtering): tile-only groups.
    const seenExtra = new Set<string | null>();
    for (const g of parts.extra) {
      seenExtra.add(g.name);
      let block = infraGroupEls.get(g.name);
      if (!block) {
        const root = div('dash-infra-group');
        const grid = div('dash-grid');
        if (g.name !== null) root.append(sublegend(g.name.toUpperCase()));
        root.append(grid);
        block = { root, grid };
        infraGroupEls.set(g.name, block);
      }
      for (const svc of g.services) block.grid.appendChild(paintTile(svc));
      infraExtra.appendChild(block.root);
    }
    for (const [name, block] of infraGroupEls) {
      if (!seenExtra.has(name)) { block.root.remove(); infraGroupEls.delete(name); }
    }

    infra.hidden = pveGroup.hidden && ipamGroup.hidden && parts.extra.length === 0;
  }

  function repaint() {
    const mode = dashboardMode(data.boxes.length, data.services.length);
    head.hidden = mode === 'standby';
    standby.hidden = mode === 'dash';
    tilesSeen = new Set();
    paintFleet();
    paintServices();
    paintInfra();
    // One cleanup across both sections: a tile absent from every grid this
    // repaint has been deleted (or its record vanished) — retire it.
    for (const [id, tile] of tileEls) {
      if (!tilesSeen.has(id)) { tile.root.remove(); tileEls.delete(id); }
    }
    for (const [id, card] of cardEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); cardEls.delete(id); }
    }
    for (const [id, card] of truenasEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); truenasEls.delete(id); }
    }
    for (const [id, card] of unifiEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); unifiEls.delete(id); }
    }
    for (const [id, card] of immichEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); immichEls.delete(id); }
    }
    fleet.hidden = mode === 'standby' || data.boxes.length === 0;
    services.hidden = mode === 'standby';
    if (mode === 'standby') infra.hidden = true;
  }

  function update(patch: Partial<DashboardData>) {
    // A failed services poll must not blank the tiles: null after real data
    // marks the section stale and keeps the last snapshot painted.
    if ('serviceStatus' in patch) {
      if (patch.serviceStatus === null && data.serviceStatus !== null) {
        stale = true;
      } else {
        data.serviceStatus = patch.serviceStatus ?? null;
        stale = false;
      }
      delete patch.serviceStatus;
    }
    Object.assign(data, patch);
    repaint();
  }

  function destroy() {
    el.remove();
    boxEls.clear();
    tileEls.clear();
    cardEls.clear();
    truenasEls.clear();
    unifiEls.clear();
    immichEls.clear();
    groupEls.clear();
    infraGroupEls.clear();
  }

  return { el, update, destroy };
}
