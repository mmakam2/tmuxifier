# Box modal: two-column layout with pinned footer — design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-11-proxmox-lifecycle-deprovisioning-design.md` (whose Edit Box association
section pushed the modal past viewport height — the actions row clips off-screen because the base
`.modal` has no max-height and the flex-centered backdrop crops an overflowing child at both ends).

## Goal

Restructure the Add/Edit Box modal to use horizontal space: a 560px two-column layout in which
compact fields pair up, with the Cancel/Save actions pinned at the bottom and only the field area
scrolling when the viewport is short. The cut-off-buttons failure becomes structurally impossible.

Web-client change only (`src/web/main.ts` + `src/web/style.css`). No server changes, no behavior
changes — same fields, same validation, same submit path.

## Approach decision

Two-column grid + pinned footer, chosen over a scroll-only fix (keeps the modal a long thin tube;
doesn't use the space) and over collapsible sections (hides state, more clicks).

## Markup — `openBoxDialog` in `src/web/main.ts`

Only the assembly changes; every existing element, handler, and the submit path stay as-is.

- The form gains a class: `form.className = 'modal box-modal'`.
- New structure: `title → div.modal-body (scrollable) → err → actions`, so the error line and the
  actions are always visible outside the scroll region (a failed save can never be scrolled away).
- Inside `.modal-body`, in order:
  1. `div.field-grid` #1 — six paired fields in DOM order Host, Label, Tag, User, Port, ProxyJump
     (CSS grid auto-places two per row → Host|Label, Tag|User, Port|ProxyJump). The `tagDatalist`
     is appended alongside (it renders nothing).
  2. `sessionWrap` — full-width (input + ⟳ refresh + chips + hint), unchanged.
  3. `div.field-grid` #2 — `shellGroup` (radio fieldset) left, `installOhMyTmux` checkbox right,
     top-aligned.
  4. The Proxmox association section (`proxmoxAssociation.element`, edit mode only) — full-width.
- `fields.host.focus()` and all pre-population logic unchanged.

## CSS — `src/web/style.css`

Appended after the existing `.modal` rules; the new classes are opt-in so the local-shell, fleet,
and confirm modals keep their current 340px single-column look.

```css
.modal.box-modal { width: 560px; max-height: 92vh; }
.modal.box-modal .modal-body { display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 14px; margin-right: -14px; }
.modal .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
@media (max-width: 620px) { .modal .field-grid { grid-template-columns: 1fr; } }
```

- `max-height: 92vh` + `overflow: auto` on the body is the pinned-footer mechanism: the flex
  column distributes the height to the body, which scrolls; title/err/actions never leave view.
- The `padding-right: 14px; margin-right: -14px` pair is the same scrollbar-clearance trick the
  v1.4.27 fix applied to `.pve-content`, so an appearing scrollbar never overlaps the inputs.
- Under 620px the grid collapses to one column — phones get the previous stacked layout (inside
  the existing `max-width: 92vw` bound).

## Error handling

Unchanged — the same `err` paragraph renders validation and save failures; it just lives beside
the pinned actions now.

## Testing

- No DOM tests exist in this repo: gate is `npm run typecheck` + `npm run build` + existing client
  tests staying green.
- Manual walkthrough: Add-box mode (no Proxmox section) and Edit mode (with and without a linked
  container) render two columns with nothing clipped; shrinking the window to a short viewport
  scrolls only the field area while Cancel/Save stay visible; under-620px width stacks to one
  column; session-chip picking, ⟳ probe, Proxmox link/unlink, save, and cancel all behave exactly
  as before.

## Out of scope

- Any other modal's layout (settings/hub/fleet/local-shell are already sized or unaffected).
- Field-level changes, validation changes, or reordering beyond the stated pairing.
- Dirty-state / confirm-on-close behavior.
