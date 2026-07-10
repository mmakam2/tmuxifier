# Tabbed settings modal: centralize Proxmox host & secret setup — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-10-settings-modal-netbox-design.md` (the ⚙ settings modal shipped in v1.4.24)

## Goal

Make the ⚙ settings modal the single place where integrations are configured. It gains a tab
strip — **NetBox** | **Proxmox** — and the Proxmox tab absorbs the credential-shaped setup that
today lives in the Proxmox hub: host profiles (endpoint, API token, TLS verify mode) and the LXC
secrets (default management key display, added SSH keys, root password). The Proxmox hub slims to
pure operations — **Presets / Provision / History** — and its workflow is unchanged: pick any
host configured in Settings, build presets against it, provision.

This is a web-client reorganization only. **No server, route, store, or validation changes.**

## Approach decision

Per-section modules behind a small tab shell, with the DOM helpers extracted for sharing:

- Rejected: piling everything into `settingsUi.ts` (~500-line grab-bag, recreating the
  `proxmoxUi.ts` size problem).
- Rejected: importing the hub's renderers from `proxmoxUi.ts` into Settings (couples Settings to
  the hub module; the configuration-vs-operations boundary never materializes).

## File structure

- **New `src/web/dom.ts`** — the `el` / `input` / `field` / `err` / `group` helpers, moved
  verbatim from `proxmoxUi.ts` (where they are currently private), plus the `Attrs` type.
  `proxmoxUi.ts` imports them; behavior identical.
- **New `src/web/settingsNetbox.ts`** — the current NetBox form, moved out of `settingsUi.ts`
  mostly verbatim. Exports `renderNetboxSection(content: HTMLElement, onClose: () => void)` (or
  equivalent single render entry); keeps its form semantics (Save / Cancel / Clear / Test
  Connection, pin flow) unchanged.
- **New `src/web/settingsProxmox.ts`** — `renderHosts` and `renderSecrets` moved out of
  `proxmoxUi.ts` mostly verbatim (same `pve.*` calls: `hosts`/`inspect`/`addHost`/`removeHost`/
  `testHost`, `keys`/`addKey`/`removeKey`, `defaultKey`, root-password status/set/clear).
  Rendered stacked in one scrollable tab: "Hosts" section, then "LXC Secrets" section (matching
  the hub's current visual language: lists + add forms, immediate CRUD).
- **Modified `src/web/settingsUi.ts`** — becomes the shell: backdrop + modal chrome (header with
  ✕, tab strip, content area), tab switching, close handling. Signature widens to
  `openSettingsModal(tab?: 'netbox' | 'proxmox')` (default `'netbox'`; the gear button keeps
  calling it with no argument).
- **Modified `src/web/proxmoxUi.ts`** — drops the two renderers and the helper definitions;
  `TABS` becomes `['Presets', 'Provision', 'History']` with `Presets` the default tab; imports
  helpers from `dom.ts`. Net shrink ≈ 180 lines.
- **Modified `src/web/style.css`** — the settings modal adopts the hub's tab chrome.
- **Untouched:** all of `src/server/`, `netbox.ts`, `settingsForm.ts`, `proxmox.ts`, `main.ts`
  (except no change needed — the gear wiring already calls `openSettingsModal()`).

## Settings shell behavior

- Chrome mirrors the hub: `modal-backdrop` + modal with a header row (`Settings` + ✕ close), a
  `pve-tabs`-style strip, and a scrollable content area; **560px** wide (same as `.pve-hub`),
  `max-height: 86vh`.
- Appended to `document.body` (not `#app`) so it stacks above the Proxmox hub when opened from a
  hub pointer (same nesting pattern as the hub's add-disk modal).
- Close: ✕ button, Escape, and genuine-backdrop-click (mousedown-tracked, matching every other
  modal); the keydown listener is removed on every close path.
- Tab switching re-renders the section (`content.replaceChildren(...)`); each section owns its
  own state. Switching tabs with unsaved NetBox form edits discards them (same as closing the
  modal today — no dirty-state tracking in v1).
- Per-tab semantics are deliberately different and stay that way: NetBox is a form with explicit
  Save; Proxmox is immediate CRUD (add/remove take effect on click), exactly as in the hub today.

## Proxmox hub slimming

- `TABS = ['Presets', 'Provision', 'History']`; `selectTab('Presets')` on open.
- Empty-host pointer: wherever a hub tab needs hosts and `pve.hosts()` returns none (today the
  Presets tab's "Add at least one Proxmox host before creating a preset." message; apply the same
  where Provision dead-ends without presets/hosts), the message becomes
  "Add a Proxmox host in Settings → Proxmox" with an **Open Settings** button that calls
  `openSettingsModal('proxmox')`. The hub stays open underneath; closing Settings returns to it
  (the user can hit the tab's refresh path by re-selecting the tab — v1 does not auto-refresh the
  hub when Settings closes).
- `proxmoxUi.ts` gains one import (`openSettingsModal` from `./settingsUi`) for the pointer
  button. Import direction is Settings ← hub only (no cycle: `settingsUi` never imports the hub).

## Error handling

Unchanged per section — both moved renderers keep their existing error rendering (`err(...)`
rows, inline messages), and the NetBox form keeps its inline `err` paragraph and test-status
line. The shell adds no new error surface.

## Testing

- No DOM tests exist in this repo; the gate is `npm run typecheck` + `npm run build`, plus the
  existing client unit tests (`settingsForm`, `proxmoxWebClient`, `webIndex`) staying green.
- Manual walkthrough: gear → NetBox tab renders the existing form (save/test/pin/clear all work);
  Proxmox tab lists hosts, Inspect→pin→Add host works, Test/Remove work, keys + root password
  CRUD works; hub shows only three tabs, defaults to Presets, empty-state pointer opens Settings
  on the Proxmox tab above the hub; a Settings-created host appears in the preset editor's host
  dropdown and provisioning succeeds against it.

## Out of scope

- Any server-side change (routes, stores, validation are already shared and unchanged).
- Dirty-state tracking / confirm-on-tab-switch for the NetBox form.
- Auto-refreshing hub tabs when the Settings modal closes.
- Host editing (rotation remains remove + re-add, as today).
- Moving Presets into Settings (presets are operational, per owner's choice).
