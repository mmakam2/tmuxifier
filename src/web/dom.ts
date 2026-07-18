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

// Shared modal scaffold — the backdrop, the genuine-backdrop-click guard, the
// Escape handler, and one idempotent teardown path. Previously copy-pasted at
// eight call sites, where the copies had already drifted (two lacked Escape).
// The mousedown guard: a text selection that starts inside the modal and ends
// on the backdrop produces a click whose target is the backdrop (the common
// ancestor), which would otherwise close the modal — so the press must have
// started on the backdrop too.
export function openModal({ modal, mount = document.body, onClose, closeOnEscape = true }: {
  modal: HTMLElement;
  mount?: HTMLElement;
  onClose?: () => void;
  closeOnEscape?: boolean;
}): { backdrop: HTMLElement; close: () => void } {
  const backdrop = el('div', { class: 'modal-backdrop' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
  };
  function onKey(e: KeyboardEvent) { if (closeOnEscape && e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });
  backdrop.append(modal);
  mount.append(backdrop);
  return { backdrop, close };
}

// Shared radio-with-label builder (was duplicated near-identically in main.ts).
export function makeRadio(name: string, value: string, label: string, checked = false): { wrap: HTMLElement; input: HTMLInputElement } {
  const radio = el('input', { type: 'radio', name, value }) as HTMLInputElement;
  radio.checked = checked;
  const wrap = el('label', { class: 'check-field' }, [radio, el('span', {}, [label])]);
  return { wrap, input: radio };
}
export function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
export function err(msg: string) { return el('div', { class: 'pve-err' }, [msg]); }
export function group(label: string, ...children: (Node | string)[]) { return el('div', { class: 'pve-group' }, [el('div', { class: 'pve-eyebrow' }, [label]), ...children]); }
