// Phone-mode shell controller: the media-query flag, the sidebar drawer, and
// the desktop-collapse suppression. DOM-only module — e2e covered.
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';

// What dismisses the drawer: the whole box row (matching its own click handler,
// which opens the box from anywhere on the row — not just the name button), the
// Host Shell, and every sidebar control that opens an overlay or leaves the
// workspace.
//
// Controls that operate INSIDE the drawer are deliberately absent — the search
// field, the group headers, the fleet checkboxes, and `#fleet-toggle`, which
// only reveals in-drawer chrome (it unhides `#fleet-bar` and the per-box and
// per-group checkboxes via `.layout.fleet-mode`, all of it inside the aside).
// Closing on that one would slide away everything the tap just revealed and
// read as a dead button. `#fleet-run` — the fleet bar's own "Run on N" button,
// one step later in the same flow — DOES close: it opens the fleet confirm
// modal, which mounts into `#app` as a sibling of `.layout`, outside the aside.
// (The ⤢ `.fleet-expand` beside the command input, which opens the script
// editor, is not in this list either; that modal mounts the same way and its
// backdrop sits at z-index 60 — clear of the drawer's 40 — so the drawer just
// stays open behind it.)
//
// Every icon control that must not close it (Reconnect's arm-then-fire, ✎, ✕,
// ⚷, the sparkline cycle, the row checkbox) already calls stopPropagation on
// its own click, so it never reaches this delegated listener at all.
const CLOSES_DRAWER = [
  '.box',
  '.local-name',
  '#home',
  '#settings',
  '#logout',
  '#add',
  '#fleet-jobs',
  '#events',
  '#proxmox',
  '#fleet-run',
].join(', ');

export interface PhoneMode {
  matches(): boolean;
  openDrawer(): void;
  closeDrawer(): void;
  dispose(): void;
}

export function createPhoneMode(deps: {
  layout: HTMLElement;
  onFlip: () => void;
  onViewport: () => void;
}): PhoneMode {
  const mq = window.matchMedia('(max-width: 720px)');
  const { layout } = deps;

  // The collapsed-sidebar CSS hides the box list — fatal inside a drawer. While
  // phone mode matches the class comes off; flipping back restores the stored
  // preference, so the desktop experience is untouched.
  const applyCollapse = () => {
    if (mq.matches) layout.classList.remove('sidebar-collapsed');
    else layout.classList.toggle('sidebar-collapsed', localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  };

  const closeDrawer = () => layout.classList.remove('drawer-open');
  const openDrawer = () => layout.classList.add('drawer-open');

  // iOS Safari does not shrink the layout viewport for the soft keyboard; the
  // visual viewport is the truth. Track it into --vvh so the flex column (bar,
  // stage, key bar) always fits above the keyboard, then refit the terminal.
  // Both events are listened to because iOS fires either one alone.
  //
  // The `* vv.scale` is what keeps this about the keyboard and nothing else:
  // `vv.height` shrinks under ANY zoom, and index.html deliberately sets no
  // maximum-scale, so iOS auto-zooms on focusing any sub-16px field (the
  // drawer's `.search` is 12.5px, modal inputs 14px — only the xterm helper
  // textarea got the 16px bump). Without the multiply, tapping the search box
  // would collapse `.layout` to about screenHeight/scale and refit every open
  // terminal — a resize sent to every box — for a zoom that moved no keyboard.
  // Multiplying converts back to layout-viewport CSS px: zoom cancels out, a
  // keyboard still registers, and a keyboard opened WHILE zoomed still tracks
  // (which an early-return on scale > 1 would have missed).
  let vvTimer: ReturnType<typeof setTimeout> | undefined;
  let lastVvh: number | null = null;
  const vv = window.visualViewport;
  const onVv = () => {
    if (!mq.matches || !vv) return;
    clearTimeout(vvTimer);
    vvTimer = setTimeout(() => {
      // Height-change gate, and it is load-bearing for typing latency: with
      // the soft keyboard open, every caret pan the browser makes to keep the
      // insertion point visible fires a visualViewport scroll event with the
      // height UNCHANGED. Acting on those — the scrollTo(0,0) fighting the
      // browser's own pan, plus a refit and a {t:'r'} tmux resize per open
      // terminal — turned ordinary typing into a yank-and-redraw storm. Only
      // a real height move (keyboard open/close, rotation) does any work.
      const h = Math.round(vv.height * vv.scale);
      if (h === lastVvh) return;
      lastVvh = h;
      document.documentElement.style.setProperty('--vvh', `${h}px`);
      window.scrollTo(0, 0); // iOS scrolls the focused input into view by panning the page
      deps.onViewport();
    }, 50);
  };
  vv?.addEventListener('resize', onVv);
  vv?.addEventListener('scroll', onVv);

  // Flipping to desktop drops the property, so --vvh only ever exists while the
  // phone query matches. A pending debounce is cancelled with it — it was
  // scheduled under the old geometry and would otherwise write the property
  // back 50ms after this cleared it.
  const onChange = () => {
    closeDrawer();
    applyCollapse();
    if (!mq.matches) {
      clearTimeout(vvTimer);
      document.documentElement.style.removeProperty('--vvh');
      lastVvh = null; // property gone — a return to phone must re-apply, not skip
    }
    deps.onFlip();
  };
  mq.addEventListener('change', onChange);

  const menuBtn = layout.querySelector('#phone-menu');
  const onMenu = () => layout.classList.toggle('drawer-open');
  menuBtn?.addEventListener('click', onMenu);

  // The open drawer is fixed and opaque, so it covers the ☰ that opened it —
  // leaving Escape (a hardware keyboard) as the only dismissal on a device that
  // has none. The scrim is the touch-reachable way out.
  const scrim = layout.querySelector('#drawer-scrim');
  const onScrim = () => closeDrawer();
  scrim?.addEventListener('click', onScrim);

  // Activating anything that changes the stage or opens an overlay closes the
  // drawer. Delegated so rebuilt rows stay covered.
  const sidebar = layout.querySelector('.sidebar');
  const onSidebarClick = (ev: Event) => {
    if (!mq.matches) return;
    const t = ev.target as HTMLElement;
    if (t.closest(CLOSES_DRAWER)) closeDrawer();
  };
  sidebar?.addEventListener('click', onSidebarClick);

  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && layout.classList.contains('drawer-open')) closeDrawer(); };
  document.addEventListener('keydown', onKey);

  applyCollapse();
  return {
    matches: () => mq.matches,
    openDrawer,
    closeDrawer,
    dispose: () => {
      clearTimeout(vvTimer);
      // documentElement outlives #app, so a keyboard-squeezed height set before
      // a logout would still be styling `.layout` after the next login — with
      // no listener left alive to correct it until the keyboard next opens.
      document.documentElement.style.removeProperty('--vvh');
      vv?.removeEventListener('resize', onVv);
      vv?.removeEventListener('scroll', onVv);
      mq.removeEventListener('change', onChange);
      menuBtn?.removeEventListener('click', onMenu);
      scrim?.removeEventListener('click', onScrim);
      sidebar?.removeEventListener('click', onSidebarClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
