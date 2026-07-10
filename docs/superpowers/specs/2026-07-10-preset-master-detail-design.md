# Proxmox Presets tab: master-detail with editing — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-10-settings-tabs-proxmox-design.md` (the hub is operations-only: Presets / Provision / History)

## Goal

Replace the Presets tab's tile list + always-visible create form with a master-detail layout:
a left column listing preset names with a **+ New preset** button, and a right pane holding the
form. Selecting a preset loads it for **editing** (Save / Delete); "New preset" shows the blank
form (Create). Preset editing does not exist anywhere in the stack today — the store has only
`addPreset`/`removePreset` — so this feature adds the server-side update path too.

## Approach decision

Full-replace update: `updatePreset(id, spec)` revalidates the complete spec with the existing
`assertPresetInput` and replaces the stored preset, exposed as `PUT /api/proxmox/presets/:id`.
Rejected: field-level PATCH merge (partial validation + deep-merge semantics for `net`/`dns`/
`mounts` with no consumer — the form always holds the full spec).

## Server

- **`src/server/proxmoxStore.js`** — new `updatePreset(id, spec)`:
  - Returns `undefined` for an unknown id (caller maps to 404), mirroring `getPreset`.
  - Validates via `assertPresetInput(spec, { hostIds })` exactly like `addPreset`.
  - Name-uniqueness check ignores the preset's own id (`assertUniqueName(list, name, ignoreId)`
    already supports this).
  - Normalizes via the existing `normalizePreset`, preserving the original `id` and `createdAt`.
- **`src/server/server.js`** — `PUT /api/proxmox/presets/:id` (`preHandler: requireAuth`):
  200 with the updated preset; 400 `{ error }` on validation failure; 404 `{ error }` on unknown
  id.
- **`src/web/proxmox.ts`** — `pve.updatePreset(id, spec)` (PUT, JSON body), typed like
  `addPreset`.

## UI — `src/web/proxmoxPresets.ts` (new)

The Presets tab renderer moves out of `proxmoxUi.ts` into its own module (same extraction
pattern as the settings sections; the hub file keeps Provision/History and the tab shell).
Export: `renderPresetsTab(content: HTMLElement, deps)` where `deps` carries what the current
renderer closes over (`setContent`-equivalent is replaced by rendering into `content`; the
no-hosts pointer keeps calling `openSettingsModal('proxmox')`).

Layout: a two-column body inside the tab —

- **Left column:** one selectable row per preset (name; the active one highlighted) and a
  **+ New preset** button. Re-renders after create/save/delete. After create, the new preset
  becomes the selection; after delete, selection falls back to "New preset".
- **Right pane:** the existing form (host/node/template/storage/bridge dropdowns, disk/cores/
  mem/swap, ipMode with static cidr/gateway, vlan, mounts list + add-disk modal), driven by
  `selected: PvePreset | null`:
  - `null` (New preset; also the initial state) → blank form, **Create** button (existing
    `pve.addPreset` flow).
  - A preset → form prefilled from the saved spec; **Save** (PUT via `pve.updatePreset`) and
    **Delete** (confirm-guarded, existing `pve.removePreset`) buttons.
- **Prefill and dependent dropdowns:** selecting a preset triggers the existing loaders for its
  host (nodes → storages/templates/bridges). If a saved value is absent from what the host
  returns (template renamed, storage removed, host unreachable), the saved value is inserted
  into the select as a chosen option so the form still renders and can be saved unchanged.
  A failed loader shows the saved-value fallback rather than an empty select.
- **Unsaved edits are discarded silently** when switching selection or tabs — consistent with
  the settings modal's tab-switch behavior. No dirty-state tracking.
- The no-hosts empty state (pointer to Settings → Proxmox + Open Settings button) is unchanged.

The Provision tab needs no change (it re-fetches presets on every render).

## Error handling

- Store/route: invalid spec → 400 with the validator's message; unknown id → 404; both rendered
  inline in the detail pane via the existing `err()` rows.
- Renaming a preset does not disturb provision history (jobs snapshot `presetName` at creation).

## Testing

- TDD server-side, real code:
  - `test/proxmoxStore.test.js` — `updatePreset` replaces fields and keeps `id`/`createdAt`;
    rejects an invalid spec (store unchanged); rejects a name that duplicates a *different*
    preset but accepts keeping its own name; returns `undefined` for an unknown id.
  - `test/server.test.js` — PUT route: 401 unauthenticated; 200 round-trip; 400 invalid; 404
    unknown id.
- Client: `npm run typecheck` + `npm run build` + existing client tests green; manual
  walkthrough — create a preset, select it, change fields (including host-dependent ones),
  Save, re-select and confirm persisted values, Delete; a preset whose template/storage no
  longer exists on the host still opens with its saved values selected.

## Out of scope

- Dirty-state confirmation on selection/tab switch.
- Preset duplication ("clone") and reordering.
- Host profile editing (rotation remains remove + re-add).
- Any Provision-tab changes.
