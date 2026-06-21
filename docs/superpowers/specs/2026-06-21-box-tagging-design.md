# Box Tagging And Grouped Sidebar

## Summary

Add a lightweight tagging workflow so boxes can be grouped and collapsed in the sidebar. Tags are managed implicitly from the Add/Edit Box modal, and the sidebar is always grouped by each box's single primary tag.

This activates the existing `Box.tags` field without introducing a new storage file, migration step, or tag-management screen.

## Goals

- Let each box belong to exactly one sidebar group.
- Keep tag assignment low-friction while adding or editing a box.
- Make large box lists easier to scan with collapsible tag groups.
- Remember collapsed groups per browser.
- Preserve the existing sidebar collapse behavior and terminal layout behavior.

## Current Context

- `src/server/store.js` already normalizes boxes with `tags: spec.tags || base.tags || []`.
- `src/web/api.ts` already includes `tags: string[]` on `Box`.
- `src/web/main.ts` currently renders a flat list in `paint()` and search only matches label and host.
- The whole sidebar has a remembered collapsed state via `tmuxifier.sidebarCollapsed`.

## Data Model

Use the existing `Box.tags: string[]` field, but treat it as a single primary tag in this release.

Server normalization should:

- Accept missing tags, an empty array, or one or more string values.
- Trim leading and trailing whitespace.
- Collapse internal whitespace runs to a single space.
- Drop empty tags.
- Persist at most the first normalized tag.

Blank or missing tags persist as `[]` and render as `Untagged`.

Existing boxes that somehow contain multiple tags should continue to load. The UI uses the first tag as the primary group. When the box is edited, the normal save path rewrites the field to the single-tag shape.

## Sidebar UX

The sidebar always renders grouped sections:

```text
prod (4)
  box rows...
staging (2)
  box rows...
Untagged (3)
  box rows...
```

Each group header is a compact button row with:

- A chevron indicating expanded or collapsed state.
- The tag name.
- The visible group count.

Header behavior:

- Clicking a header toggles that group's collapsed state.
- Collapsed state is stored in `localStorage` under a new key separate from `tmuxifier.sidebarCollapsed`.
- New tags default expanded.
- Tagged groups sort alphabetically by display name.
- `Untagged` always appears last.
- Boxes inside a group keep the current order returned by `boxes.json`.

Active state:

- The active box row keeps the current active styling when visible.
- If the active box is hidden inside a collapsed group, the group header shows a subtle active state so the current terminal still has a visible sidebar anchor.
- Opening a box does not permanently expand or collapse its group.

Search behavior:

- Search matches box label, host, and primary tag.
- During search, groups with matches are shown expanded regardless of saved collapse state.
- Clearing search restores the saved collapsed/expanded state.
- Search does not mutate saved group collapse preferences.

Whole-sidebar collapse:

- The existing narrow collapsed sidebar state remains unchanged.
- When the whole sidebar is collapsed, grouped box content remains hidden as it is today for the flat list.

## Add/Edit Box UX

Add one `Tag` input below `Label` in the Add/Edit Box modal.

Behavior:

- The input accepts one free-form tag.
- Blank means `Untagged`.
- Existing tags are exposed through a native `<datalist>`, populated from the currently loaded boxes.
- The edit modal pre-fills the box's current primary tag.
- Adding a box persists `tags: [tag]` when the field is non-empty.
- Editing a box persists `tags: [tag]` or `tags: []` when cleared.

Case handling:

- Grouping should be case-insensitive to avoid separate groups like `prod` and `Prod`.
- When the typed tag case-insensitively matches an existing tag, reuse the existing tag's display casing.
- Otherwise, preserve the user's typed casing after whitespace normalization.

Imported boxes:

- SSH config imports do not ask for a tag.
- Imported boxes start as `Untagged` and can be tagged later through Edit Box.

## Code Structure

Keep the implementation small, but do not bury all logic in `paint()`.

Add focused helpers in the web client for:

- Reading the primary tag for a box.
- Normalizing tag display/input values.
- Looking up an existing tag with case-insensitive matching.
- Grouping and sorting boxes for display.
- Reading and writing group collapse state.

The server should get a small tag normalization helper inside `store.js` so add/update paths share behavior.

## Testing

Unit tests should cover store normalization:

- Missing tags become `[]`.
- Blank tags become `[]`.
- Whitespace is trimmed and collapsed.
- Multiple tags persist as only the first normalized tag.
- Updating with `tags: []` clears a tag.
- Updating with a new tag replaces the old primary tag.

Browser/e2e coverage should verify:

- Tagged and untagged boxes render under group headers.
- Collapsing a group hides its rows.
- Group collapse state survives reload.
- Search matches tags and temporarily reveals matching groups.

## Not Included

- No separate tag manager.
- No multi-tag sidebar membership.
- No drag-and-drop reordering.
- No server-side grouping endpoint.
- No tag colors in this iteration.

## Acceptance Criteria

- A user can assign or clear one tag while adding or editing a box.
- The sidebar always groups boxes by tag with `Untagged` last.
- Groups can be collapsed and expanded.
- Group collapsed state is remembered after reload.
- Search matches tags and reveals matching groups without changing saved collapse state.
- Existing boxes with no tags continue to work and render under `Untagged`.
- Existing whole-sidebar collapse behavior still works.
