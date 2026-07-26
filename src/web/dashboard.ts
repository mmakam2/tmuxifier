// The standby dashboard: what the screen bay shows when no terminal is docked.
// Pure view-model helpers (unit-tested in node) + a DOM layer that updates in
// place on poll ticks — the sidebar's "the poll never rebuilds whole rows"
// contract, so hover states and tooltips survive repaints. main.ts owns all
// polling and calls update(); this module never fetches.
import type { Box, Status, Sample, Service, ServiceStatusSnapshot } from './api';
import type { NetboxSummary } from './netbox';
import type { PveLinkedContainer } from './proxmox';
import { sparkline } from './sparkline';
import { dotClassFor, dotTitleFor } from './statusDot';

export interface DashboardData {
  boxes: Box[];
  status: Record<string, Status>;
  series: Record<string, Sample[]>;
  services: Service[];
  serviceStatus: ServiceStatusSnapshot | null;
  containers: PveLinkedContainer[] | null; // null = Proxmox not configured (module hidden)
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

export function fmtLatency(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function serviceLamp(svc: Service, snap: ServiceStatusSnapshot | null): 'up' | 'down' | 'unknown' | 'none' {
  if (svc.check.kind === 'none') return 'none';
  const r = snap?.results[svc.id];
  return r ? r.state : 'unknown';
}

export function dashboardMode(boxCount: number, serviceCount: number): 'standby' | 'dash' {
  return boxCount === 0 && serviceCount === 0 ? 'standby' : 'dash';
}

export function pveHostRollup(containers: PveLinkedContainer[]): { hostName: string; running: number; stopped: number; other: number }[] {
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

const SPARK_W = 64;
const SPARK_H = 16;
const SVG_NS = 'http://www.w3.org/2000/svg';

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
  chip: HTMLElement; meta: HTMLElement; path: SVGPathElement;
}

interface Tile {
  root: HTMLAnchorElement; glyph: HTMLElement; name: HTMLElement;
  lamp: HTMLElement; latency: HTMLElement;
}

export function createDashboard(hooks: DashboardHooks): { el: HTMLElement; update(patch: Partial<DashboardData>): void; destroy(): void } {
  const data: DashboardData = { boxes: [], status: {}, series: {}, services: [], serviceStatus: null, containers: null, netbox: null };
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
  const sublegend = (text: string) => {
    const l = legend(text);
    l.classList.add('dash-sublegend');
    return l;
  };
  const pveGroup = div('dash-infra-group');
  const pveRow = div('dash-infra-row');
  pveGroup.append(sublegend('PROXMOX'), pveRow);
  const ipamGroup = div('dash-infra-group');
  const ipamRow = div('dash-infra-row');
  ipamGroup.append(sublegend('IPAM'), ipamRow);
  const infraGroups = div('dash-infra-groups');
  infraGroups.append(pveGroup, ipamGroup);
  infra.append(legend('INFRASTRUCTURE'), infraGroups);

  el.append(head, standby, fleet, services, infra);

  // Per-entity element caches: update() mutates and *moves* nodes (appendChild
  // reorders without recreating), so hover and focus survive poll repaints.
  const boxEls = new Map<string, FleetRow>();
  const tileEls = new Map<string, Tile>();
  const groupEls = new Map<string | null, { root: HTMLElement; legendEl: HTMLElement | null; grid: HTMLElement }>();

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
    const meta = div('dash-box-meta');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('dash-spark');
    svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    svg.append(path);
    const top = div('dash-box-top');
    top.append(lamp, name, chip);
    root.append(top, meta, svg);
    return { root, lamp, name, chip, meta, path };
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
      const sessions = st?.sessions?.length ?? 0;
      row.meta.textContent = sessions === 1 ? '1 session' : `${sessions} sessions`;
      row.path.setAttribute('d', sparkline(samples, 'cpuPct', { w: SPARK_W, h: SPARK_H }));
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
    const glyph = document.createElement('span');
    glyph.className = 'dash-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    const name = div('dash-tile-name');
    const lamp = document.createElement('span');
    lamp.className = 'dot';
    const latency = document.createElement('span');
    latency.className = 'dash-latency';
    const top = div('dash-tile-top');
    top.append(lamp, name);
    const bottom = div('dash-tile-bottom');
    bottom.append(glyph, latency);
    root.append(top, bottom);
    return { root, glyph, name, lamp, latency };
  }

  function paintServices() {
    const groups = groupServices(data.services);
    const seenTiles = new Set<string>();
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
      for (const svc of g.services) {
        seenTiles.add(svc.id);
        let tile = tileEls.get(svc.id);
        if (!tile) { tile = makeTile(); tileEls.set(svc.id, tile); }
        tile.root.href = svc.url;
        tile.name.textContent = svc.name;
        tile.glyph.textContent = svc.glyph ?? '';
        tile.glyph.hidden = !svc.glyph;
        const lampState = serviceLamp(svc, data.serviceStatus);
        tile.lamp.hidden = lampState === 'none';
        tile.lamp.className = `dot${lampState === 'up' ? ' green' : lampState === 'down' ? ' red' : ''}`;
        const result = data.serviceStatus?.results[svc.id];
        tile.latency.textContent = lampState === 'none' ? '' : fmtLatency(result?.latencyMs);
        tile.root.title = result?.state === 'down' && result.error ? result.error : '';
        block.grid.appendChild(tile.root);
      }
      servicesBody.appendChild(block.root);
    }
    for (const [id, tile] of tileEls) {
      if (!seenTiles.has(id)) { tile.root.remove(); tileEls.delete(id); }
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
    // Non-interactive readouts: wholesale swaps are safe (no hover state to keep).
    const pveMods: HTMLElement[] = [];
    if (data.containers !== null) {
      const rollup = pveHostRollup(data.containers);
      if (rollup.length === 0) {
        pveMods.push(infraModule('', 'PROXMOX', 'no linked containers'));
      }
      for (const host of rollup) {
        const extra = host.other > 0 ? ` · ${host.other} other` : '';
        pveMods.push(infraModule(host.running > 0 ? 'green' : '', host.hostName, `${host.running} running · ${host.stopped} stopped${extra}`));
      }
    }
    pveRow.replaceChildren(...pveMods);
    pveGroup.hidden = pveMods.length === 0;

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
    ipamGroup.hidden = ipamMods.length === 0;

    infra.hidden = pveMods.length === 0 && ipamMods.length === 0;
  }

  function repaint() {
    const mode = dashboardMode(data.boxes.length, data.services.length);
    head.hidden = mode === 'standby';
    standby.hidden = mode === 'dash';
    fleet.hidden = mode === 'standby' || data.boxes.length === 0;
    services.hidden = mode === 'standby';
    if (mode === 'dash') { paintFleet(); paintServices(); }
    paintInfra();
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
    groupEls.clear();
  }

  return { el, update, destroy };
}
