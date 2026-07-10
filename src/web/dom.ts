// Shared DOM builders for the imperative views (Proxmox hub, settings modal).
// All text lands as text nodes / attributes — never innerHTML.
export type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
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
export function input(value = '', attrs: Attrs = {}) { const i = el('input', attrs); i.value = value; return i; }
export function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
export function err(msg: string) { return el('div', { class: 'pve-err' }, [msg]); }
export function group(label: string, ...children: (Node | string)[]) { return el('div', { class: 'pve-group' }, [el('div', { class: 'pve-eyebrow' }, [label]), ...children]); }
