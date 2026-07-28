// The one icon element, shared by plain tiles, the three card layers and the
// settings list. Always an <img>, never inlined SVG: a browser loads SVG in an
// <img> in a restricted mode with scripting and external references disabled,
// which makes the content inert regardless of what the CDN or a LAN host
// served. Inlining it would put that markup in the app's own origin.
import type { Service } from './api';

export interface ServiceIconEls {
  root: HTMLImageElement;
  update(svc: Service): void;
}

// A catalog logo addressed by slug rather than by service. The built-in
// infrastructure readouts (Proxmox nodes, NetBox prefixes) are not service
// records — they have no id to resolve against — but they are the same
// products, so they draw from the same catalog.
export function buildCatalogIcon(slug: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'dash-icon';
  img.alt = '';
  // Same hidden-until-load contract as buildServiceIcon, and the same reason
  // for no loading="lazy": the two together never load at all.
  img.hidden = true;
  img.addEventListener('load', () => { img.hidden = false; });
  img.addEventListener('error', () => { img.hidden = true; });
  img.src = `/api/icons/${encodeURIComponent(slug)}`;
  return img;
}

export function buildServiceIcon(): ServiceIconEls {
  const root = document.createElement('img');
  root.className = 'dash-icon';
  root.alt = '';
  // Hidden until it actually loads, so a service with no resolvable icon shows
  // nothing rather than a broken-image glyph. The server's 404 is the whole
  // signal — the client needs no pre-flight request and holds no copy of the
  // resolution state.
  root.hidden = true;
  // Deliberately NOT loading="lazy". Combined with `hidden` it deadlocks: a
  // display:none element has no layout box, so the browser never decides it is
  // near the viewport, never fetches, never fires `load`, and the handler below
  // never unhides it. Nothing is gained either way — these are a handful of
  // tiny same-origin images, all above the fold on the standby dashboard.
  root.addEventListener('load', () => { root.hidden = false; });
  root.addEventListener('error', () => { root.hidden = true; });

  let shown = '';
  function update(svc: Service): void {
    if (svc.id === shown) return; // a poll repaint must not retrigger the fetch
    shown = svc.id;
    root.hidden = true;
    root.src = `/api/services/${encodeURIComponent(svc.id)}/icon`;
  }

  return { root, update };
}
