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

export function buildServiceIcon(): ServiceIconEls {
  const root = document.createElement('img');
  root.className = 'dash-icon';
  root.alt = '';
  root.loading = 'lazy';
  // Hidden until it actually loads, so a service with no resolvable icon shows
  // nothing rather than a broken-image glyph. The server's 404 is the whole
  // signal — the client needs no pre-flight request and holds no copy of the
  // resolution state.
  root.hidden = true;
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
