# Move box export/import into a Settings → Boxes tab — design

**Date:** 2026-07-20
**Status:** Approved (brainstorm with owner)

## Goal

Move the box-list export (`⤓`) and import (`⤒`) buttons out of the sidebar brand actions and into
a new **Boxes** tab in the settings modal. The sidebar keeps only the controls used routinely:
collapse, settings, and logout.

Motivation: export/import is a rare, administrative action. It currently occupies two of the four
sidebar brand-action slots, which are the most valuable pixels in the collapsed sidebar. The
settings modal already exists as the home for infrequent configuration surfaces.

**Scope:** a pure UI relocation. No server change — `GET /api/export` and `POST /api/import` and
their handlers in `store.js`/`server.js` are untouched. No change to the export file format or to
import semantics (ids are re-minted, duplicate/unsafe entries skipped).

## UI

New tab in the settings modal, placed **first** in the tab strip:

```
Settings
[ Boxes ] [ NetBox ] [ Proxmox ] [ Passkeys ] [ Notifications ]
```

The Boxes section renders:

- `<h3>Boxes</h3>` heading, matching the other sections.
- A `pve-sub` blurb: the export writes the box list as a JSON file; the import accepts a file
  previously produced by the export button, re-mints ids, and skips duplicate or unsafe entries.
- **Export boxes** button — triggers the download.
- **Import boxes…** button — opens a file picker, then imports the selected file.
- An inline `pve-sub` status line beneath the buttons for the result or error message.

The gear button (`#settings`) continues to open the modal on the **NetBox** tab
(`openSettingsModal` keeps its `tab: SettingsTab = 'netbox'` default). Export/import is rare
enough that it should not become the landing tab; making Boxes leftmost is about grouping, not
about promoting it.

### Feedback surface

Settings sections have no access to `showToast` — it is private to `main.ts`. Every existing
section reports state inline (`pve-sub` lines in `settingsNotifications.ts`,
`settingsPasskeys.ts`). The Boxes section follows that convention rather than exporting
`showToast` or duplicating a toast host.

## Components

### New: `src/web/settingsBoxes.ts`

Exports two things:

- `renderBoxesSection(content: HTMLElement): void` — same signature shape as
  `renderNotificationsSection`. Builds the DOM described above with `el()` from `dom.ts` and
  `content.replaceChildren(...)`.
- `importSummary(added: number, skipped: number): string` — pure, returning
  `"Imported 3 boxes, 1 skipped"` / `"Imported 1 box"` / `"Imported 0 boxes"`. This is the
  section's unit-testable core, extracted from the message currently built inline in `main.ts`.

The hidden `<input type="file" accept="application/json,.json">` is created inside the section
rather than living in the sidebar markup. Its `value` is reset after each pick so re-selecting the
same file fires `change` again — preserving today's behavior.

Export keeps the current mechanism: a transient `<a href="/api/export" download>` appended to the
document, clicked, and removed. It is a same-origin GET navigation, so the session cookie rides
along and the server's `Content-Disposition` names the file.

### Changed: `src/web/settingsUi.ts`

- `SettingsTab` gains `'boxes'`.
- `SECTIONS` gains `boxes: { label: 'Boxes', render: (content) => renderBoxesSection(content) }`
  as the **first** entry — `Object.entries` iteration order defines the tab strip order.

### Changed: `src/web/main.ts`

- Remove the `#export` and `#import` buttons and the `#import-file` input from the dashboard
  template (currently lines 557–558 and 561).
- Remove the three handlers wiring them (currently lines 603–628).
- Add a `window.addEventListener('tmuxifier:boxes-changed', ...)` that calls `refresh()`.

## Data flow: repainting the box list after an import

An import mutates the box list while the settings modal is still open, so the dashboard must
repaint. The section dispatches a window event:

```ts
window.dispatchEvent(new Event('tmuxifier:boxes-changed'));
```

and `main.ts` listens for it and calls `refresh()`.

**Why this over the alternatives:** the repo already uses exactly this pattern —
`settingsNotifications.ts` dispatches `tmuxifier:notify-prefs-changed` so the events badge
recounts without waiting for the next poll. It keeps `settingsBoxes.ts` free of any dependency on
`main.ts` and avoids changing the `render()` signature of all five sections for one consumer's
benefit. Refreshing only on modal close was rejected: the box list would sit visibly stale behind
the open modal.

The listener is registered **once at module scope**, next to the existing
`tmuxifier:notify-prefs-changed` listener near the bottom of `main.ts` — not inside
`renderDashboard()`, which re-runs on every re-login and would accumulate duplicate listeners.
This is safe on the login screen too: `refresh()` already returns early when `#boxes` is absent.

## Error handling

Unchanged in substance, relocated in presentation:

- Malformed JSON in the picked file — the `JSON.parse` throw is caught and shown in the status
  line as `Import failed: <message>`.
- A rejected `POST /api/import` — same catch, same line.
- The status line is styled as an error variant so a failure is not mistaken for a success.
- Export has no error path to handle: it is a browser navigation, and a failure surfaces as the
  browser's own download failure, as today.

## Testing

Following the repo's web-test convention — unit tests target pure helpers, not DOM rendering
(`proxmoxContainers.test.js`, `setupStatus.test.js`, `presetSummary.test.js`):

- New `test/settingsBoxes.test.js` covering `importSummary`: singular vs plural box counts, the
  skipped clause present only when `skipped > 0`, and the zero-added case.

No existing test or README text references the `#export` / `#import` buttons, so nothing breaks by
removing them. `npm test` (typecheck + vitest) and `npm run typecheck` must pass; the `SettingsTab`
union change is compile-checked.

## Non-goals

- No change to the export file format, the import validation, or any server route.
- No new box-related settings in the Boxes tab beyond export/import.
- No rewrite of the point-in-time docs under `docs/superpowers/` that mention the sidebar buttons
  (`2026-06-19-tmuxifier.md`, `2026-07-10-settings-modal-netbox*.md`) — those are historical
  records.
