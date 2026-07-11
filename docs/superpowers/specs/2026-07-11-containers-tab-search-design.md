# Containers tab: live search filter — design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-11-proxmox-lifecycle-deprovisioning-design.md` (the hub's Containers tab).

## Goal

A search box on the Proxmox hub's Containers tab that dynamically filters the container list as
you type, matching the main sidebar's search behavior. Web-client only.

## Design

- **Placement:** a text input (placeholder `Search…`) joins the existing
  `pve-container-toolbar` beside the Refresh button.
- **Filtering mechanics:** rows are built once, exactly as today; an `input` listener toggles
  each row's `hidden` by the match result. No re-render on keystroke — in-flight action-button
  state, inline errors, and the `focusBoxId` highlight survive typing. A `No containers match`
  line (`pve-sub`) shows when every row is hidden and containers exist.
- **Refresh keeps the term:** `renderContainersTab` reads the previous input's value from the
  outgoing DOM before `replaceChildren` and re-applies it (value + filter) after the rebuild.
  Switching tabs resets the term (tab renders are fresh, as everywhere in the hub).
- **Match semantics** — pure exported helper, sidebar-style case-insensitive substring over the
  fields a row displays:

  `containerMatches(container, term)` returns true when the trimmed, lowercased term is empty or
  is a substring of any of: `boxLabel`, `hostName ?? hostId`, `node`, `String(vmid)`, `state`.
  (So `stopped` filters by state, `proxmox02` by node, `164` by VMID.)

## Files

- `src/web/proxmoxContainers.ts` — export `containerMatches`; toolbar input; hidden-toggling +
  empty-match line; term restore across Refresh.
- `src/web/style.css` — one rule for the toolbar search input, matching the hub's existing
  input look (`.pve-hub`-style colors/border/radius); the toolbar keeps Refresh aligned.
- `test/proxmoxContainers.test.js` — `containerMatches` matrix: empty term matches all; label /
  hostName / hostId-fallback / node / vmid / state matches; case-insensitivity; no-match.

## Error handling

Unchanged — load/refresh errors render exactly as today (the search input simply isn't shown on
the error state, matching the current toolbar-only-on-success structure; if the toolbar shows,
the input shows).

## Testing

Unit: the `containerMatches` matrix (vitest, real module import — the `termFont.ts` pattern).
Gate: `npm run typecheck` + `npm run build` + client tests green. Manual/scripted check: type a
node name → other rows hide; clear → all rows return; Refresh with a term → term and filtering
persist.

## Out of scope

- Persisting the term across tab switches or hub reopens.
- Any server-side filtering (the list is small; this is display filtering).
- Search in other hub tabs.
