# Association picker row + add-mode container linking — design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-11-box-modal-two-column-design.md` (the two-column box modal) and
`2026-07-11-proxmox-lifecycle-deprovisioning-design.md` (the Edit Box association editor).

## Goal

Two fixes to the box modal's Proxmox association section:

1. **Picker overflow:** clicking "Link container" swaps the two-row summary for three stacked
   full-width selects (Host, Node, Container), adding ~200px and forcing a small scroll. The
   three selects move into one 3-wide row, recovering the height exactly where it is lost.
2. **Add-mode gap:** the association editor exists only in edit mode
   (`isEdit ? createProxmoxAssociationEditor(box!) : null`, `commit()` hardcodes `box.id`), so a
   freshly added box cannot be linked without reopening it in Edit. The section now renders in
   both modes; in add mode the link commits against the id returned by `api.addBox`.

Web-client change only (`src/web/proxmoxAssociation.ts`, `src/web/main.ts`,
`src/web/style.css`). No server changes — the existing `PUT/DELETE /api/boxes/:id/proxmox`
routes already serve both flows.

## Approach decision

A 3-wide row **inside the picker**, not a whole-modal 3-column grid: the modal-wide variant
saves only one row (~66px) while narrowing every identity input to ~160px, whereas the picker
row recovers ~130px at the exact overflow point and leaves the just-shipped 560px two-column
layout untouched. ("Both" was offered and declined.)

## Part 1 — picker row

- **`proxmoxAssociation.ts` `renderPicker()`:** the three `field('Host'|'Node'|'Container', …)`
  wrappers go inside `el('div', { class: 'pve-picker-grid' }, […])`; the section otherwise
  renders as today (eyebrow, grid, message).
- **`style.css`:**

```css
.box-pve-association .pve-picker-grid { display: grid; grid-template-columns: 1fr 1fr 1.6fr; gap: 8px; align-items: start; }
.box-pve-association select { width: 100%; min-width: 0; }
@media (max-width: 620px) { .box-pve-association .pve-picker-grid { grid-template-columns: 1fr; } }
```

  The container select gets the widest track (longest labels: `131 | dev-01 | running`);
  `width: 100%; min-width: 0` stops a long option's intrinsic min-content width from blowing the
  grid tracks apart — the closed select truncates, the native dropdown list still shows full
  text. The existing `.box-pve-association select` rule (padding/border/colors) is extended, not
  duplicated.

## Part 2 — add-mode linking

- **`createProxmoxAssociationEditor(box: Box | null)`:**
  - Null box → the same "Not linked" summary + "Link container" button the unlinked edit case
    shows. All `box.proxmox` / `box.id` reads become null-safe (`box?.…`): the initial draft is
    `{ mode: 'unlinked' }`, `hydrateSummary` early-returns, and `renderPicker`'s prefill is
    empty.
  - Container-disable check becomes `!!item.linkedBoxId && item.linkedBoxId !== box?.id` — for a
    null box every already-linked container is disabled (no own-id exemption exists yet).
  - `commit()` → **`commit(boxId: string)`**; the mutation logic is unchanged
    (`associationMutation(box?.proxmox, draft)` — for a null box `current` is undefined, so
    "unlinked" drafts are a no-op and only a real selection produces a link call).
- **`main.ts` `openBoxDialog`:**
  - `const proxmoxAssociation = createProxmoxAssociationEditor(box ?? null);` — constructed and
    appended in **both** modes (the `…(proxmoxAssociation ? […] : [])` spread becomes
    unconditional).
  - Edit submit: `await proxmoxAssociation.commit(box!.id)` — same position and same
    refresh-and-rethrow failure handling as today.
  - Add submit: `const newBox = await api.addBox(spec)` → `await proxmoxAssociation.commit(newBox.id)`
    → close + provision panel as today. **Link-failure path:** the box exists but the link
    failed — the modal stays open showing
    `Box added, but linking failed: <message> — retry from Edit box`, the box list refreshes so
    the new box is visible, and the submit button stays **disabled** so a second click cannot
    re-add a duplicate. No provision panel on this path (the message directs to Edit).

## Error handling

Unchanged elsewhere: picker load failures render in the section's `pve-err` line; edit-mode
commit failures keep the existing refresh-and-rethrow → modal-level error. The add-mode
partial-failure semantics are specified above.

## Testing

- `associationMutation` unit tests are unaffected (pure logic unchanged). If
  `test/proxmoxAssociation.test.js` exercises `commit`, its call sites update to the new
  signature.
- Gate: `npm run typecheck` + `npm run build` + existing client tests green.
- Playwright screenshot pass (throwaway script, mocked APIs): picker-open state fits without
  body scroll at 1280×900 in BOTH add and edit modes; the three selects render side-by-side;
  under 620px they stack; add-mode link flow drives `POST /api/boxes` then
  `PUT /api/boxes/:id/proxmox` (assert both intercepted requests, in order).

## Out of scope

- Whole-modal 3-column layout (declined).
- Server-side changes of any kind.
- Autofilling the Host field from a selected container's address (containers' IPs are not in the
  `nodeContainers` payload; a future enhancement).
- A back-to-summary button in the picker (previously recorded ledger minor; unchanged here).
