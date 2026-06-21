# Sidebar Collapse

## Summary
Make the dashboard sidebar slightly wider by default and add a remembered collapse control. The terminal area should refit after the sidebar changes size so active xterm sessions remain usable.

## Approach
Use the existing client-only dashboard structure. The sidebar width is a CSS grid concern, and the collapsed/open preference can live in `localStorage` because it is a per-browser UI preference with no server impact.

## Changes

### `src/web/style.css`
- Increase the default sidebar column from `280px` to `320px`.
- Add a `.layout.sidebar-collapsed` state that reduces the sidebar to a narrow rail.
- Hide sidebar-only controls while collapsed, leaving the brand/logo row and expand control visible.
- Keep the collapse/expand button visually consistent with the existing small icon buttons.

### `src/web/main.ts`
- Add a sidebar toggle button to the brand row.
- Read `tmuxifier.sidebarCollapsed` when rendering the dashboard.
- Update the class, button title, and `aria-expanded` state when toggled.
- Store the preference in `localStorage`.
- Refit active terminal tabs after the layout has changed.

### `test/e2e/tmuxifier.spec.ts`
- Add a focused browser check that collapses the sidebar, reloads, and verifies the collapsed state is remembered.

## Not Changed
- No server API or persisted repo data changes.
- No change to terminal sessions, box CRUD, authentication, or provisioning behavior.
