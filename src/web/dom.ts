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

// Elements a modal focus trap cycles through. A display:none subtree reports a
// null offsetParent, which filters hidden controls without a computed-style read.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
}

// Stack of open modal backdrops, newest last. Escape must only close the
// top-most modal: every openModal call listens on document, so without this a
// stacked modal (disk modal over the Proxmox hub) closed BOTH on one press.
const openBackdrops: HTMLElement[] = [];

// Shared modal scaffold — the backdrop, the genuine-backdrop-click guard, the
// Escape handler, dialog semantics (role/aria-modal, initial focus, Tab trap,
// focus restore), and one idempotent teardown path. Previously copy-pasted at
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
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  // Focusable as a last resort so the trap always has somewhere to put focus.
  if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
  const restoreTo = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    const i = openBackdrops.indexOf(backdrop);
    if (i !== -1) openBackdrops.splice(i, 1);
    backdrop.remove();
    onClose?.();
    // Hand focus back to the opener (skipped when it left the DOM, e.g. a
    // logout re-render replaced the dashboard under this modal).
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
  };
  function onKey(e: KeyboardEvent) {
    if (closeOnEscape && e.key === 'Escape' && openBackdrops[openBackdrops.length - 1] === backdrop) close();
  }
  document.addEventListener('keydown', onKey);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });
  // Tab trap: focus cycles within the modal while it is open. Runs on the
  // backdrop (not document), so a stacked modal traps only its own subtree.
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(modal);
    if (!f.length) { e.preventDefault(); modal.focus(); return; }
    const active = document.activeElement;
    if (e.shiftKey && (active === f[0] || active === modal)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && active === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  backdrop.append(modal);
  mount.append(backdrop);
  openBackdrops.push(backdrop);
  (focusables(modal)[0] ?? modal).focus();
  return { backdrop, close };
}

// Roving-tabindex tab-strip navigation: which tab a Left/Right/Home/End press
// lands on. Pure so the wrap-around edges are unit-testable; null means "not a
// navigation key — let it through".
export function nextTabKey(keys: string[], current: string, key: string): string | null {
  if (!keys.length) return null;
  const i = keys.indexOf(current);
  if (key === 'ArrowRight') return keys[(i + 1) % keys.length];
  if (key === 'ArrowLeft') return keys[(i - 1 + keys.length) % keys.length];
  if (key === 'Home') return keys[0];
  if (key === 'End') return keys[keys.length - 1];
  return null;
}

// Wire WAI-ARIA tab semantics onto a strip of buttons (each carrying data-tab)
// and its content panel: roles plus arrow-key navigation. The caller's own
// selectTab must call syncTabSelection so aria-selected and the roving
// tabindex follow the active class no matter what triggered the switch.
export function wireTabStrip(strip: HTMLElement, panel: HTMLElement, select: (key: string) => void): void {
  strip.setAttribute('role', 'tablist');
  panel.setAttribute('role', 'tabpanel');
  for (const b of strip.children) (b as HTMLElement).setAttribute('role', 'tab');
  strip.addEventListener('keydown', (e) => {
    const keys = [...strip.children].map((b) => (b as HTMLElement).dataset.tab || '');
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.tab;
    const activeIdx = [...strip.children].findIndex((b) => (b as HTMLElement).classList.contains('active'));
    const next = nextTabKey(keys, focused ?? keys[activeIdx] ?? '', e.key);
    if (next == null) return;
    e.preventDefault();
    select(next);
    (strip.querySelector(`[data-tab="${CSS.escape(next)}"]`) as HTMLElement | null)?.focus();
  });
}

export function syncTabSelection(strip: HTMLElement, active: string): void {
  for (const b of strip.children) {
    const btn = b as HTMLElement;
    const is = btn.dataset.tab === active;
    btn.classList.toggle('active', is);
    btn.setAttribute('aria-selected', is ? 'true' : 'false');
    btn.setAttribute('tabindex', is ? '0' : '-1');
  }
}

// Shared radio-with-label builder (was duplicated near-identically in main.ts).
export function makeRadio(name: string, value: string, label: string, checked = false): { wrap: HTMLElement; input: HTMLInputElement } {
  const radio = el('input', { type: 'radio', name, value }) as HTMLInputElement;
  radio.checked = checked;
  const wrap = el('label', { class: 'check-field' }, [radio, el('span', {}, [label])]);
  return { wrap, input: radio };
}
export function field(label: string, control: HTMLElement) { return el('label', { class: 'field' }, [el('span', {}, [label]), control]); }
export function err(msg: string) { return el('div', { class: 'pve-err', role: 'alert' }, [msg]); }
export function group(label: string, ...children: (Node | string)[]) { return el('div', { class: 'pve-group' }, [el('div', { class: 'pve-eyebrow' }, [label]), ...children]); }
