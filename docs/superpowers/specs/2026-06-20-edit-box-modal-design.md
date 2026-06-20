# Edit Box Modal

## Summary
Add an edit button to each box in the sidebar that opens a modal pre-populated with the box's current values. Host is locked (readonly). Provisioning checkboxes (Oh My Tmux, Oh My Zsh) are included; if checked on save, the provision panel opens after the PATCH.

## Approach
Parameterize the existing `openAddDialog` into `openBoxDialog(box?)`. Edit mode shares the same form structure, validation, and provision-trigger flow as add mode.

## Changes

### `src/web/api.ts`
- Add `updateBox(id, patch)` calling `PATCH /api/boxes/:id`

### `src/web/main.ts`
- Add an edit button (pencil) between refresh and remove in `paint()`
- Refactor `openAddDialog` → `openBoxDialog(box?)`:
  - Title: "Edit box" / "Add box"
  - Host: disabled in edit mode
  - Fields pre-populated from box in edit mode
  - Submit button: "Save" / "Add"
  - Add mode: POST → provision panel (unchanged)
  - Edit mode: PATCH → refresh → provision panel if checkboxes checked

### Not changed
- Server `PATCH /api/boxes/:id` already exists
- Host is never sent in edit patch (server preserves existing)
