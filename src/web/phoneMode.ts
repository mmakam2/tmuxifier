// Phone-mode shell controller: the media-query flag, the sidebar drawer, and
// the desktop-collapse suppression. DOM-only module — e2e covered.
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';

// What dismisses the drawer: the whole box row (matching its own click handler,
// which opens the box from anywhere on the row — not just the name button), the
// Host Shell, and every sidebar control that opens an overlay or leaves the
// workspace. Controls that operate INSIDE the drawer — the search field, group
// headers, the fleet checkboxes — are deliberately absent, and every icon
// control that must not close it (Reconnect's arm-then-fire, ✎, ✕, ⚷, the
// sparkline cycle, the row checkbox) already calls stopPropagation on its own
// click, so it never reaches this delegated listener at all.
const CLOSES_DRAWER = [
  '.box',
  '.local-name',
  '#home',
  '#settings',
  '#logout',
  '#add',
  '#fleet-toggle',
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

export function createPhoneMode(deps: { layout: HTMLElement; onFlip: () => void }): PhoneMode {
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

  const onChange = () => { closeDrawer(); applyCollapse(); deps.onFlip(); };
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
      mq.removeEventListener('change', onChange);
      menuBtn?.removeEventListener('click', onMenu);
      scrim?.removeEventListener('click', onScrim);
      sidebar?.removeEventListener('click', onSidebarClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
