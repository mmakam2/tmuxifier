// Phone-mode shell controller: the media-query flag, the sidebar drawer, and
// the desktop-collapse suppression. DOM-only module — e2e covered.
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';

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

  // Activating anything that changes the stage closes the drawer: box rows,
  // the Host Shell, the nameplate. Delegated so rebuilt rows stay covered.
  const sidebar = layout.querySelector('.sidebar');
  const onSidebarClick = (ev: Event) => {
    if (!mq.matches) return;
    const t = ev.target as HTMLElement;
    if (t.closest('.box .name') || t.closest('.local-name') || t.closest('#home')) closeDrawer();
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
      sidebar?.removeEventListener('click', onSidebarClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
