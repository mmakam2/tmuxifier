# Configuration-gated Proxmox/NetBox UI — design

Date: 2026-07-12
Status: implemented same-session (autonomous run); pending owner review

## Problem

Proxmox- and NetBox-dependent features render even when the integration they depend on is
not configured, producing dead UI and late failures:

- The Add Box / Edit Box modals always show the "Proxmox association" section, even with no
  Proxmox host profile configured — the picker can only error. (The sidebar Proxmox button
  already hides itself via `syncProxmoxButton`.)
- The preset form always offers the `auto-static (NetBox)` IP mode, even when the NetBox
  integration is not configured; it only shows a hint appended to the auto-derive text.
- Provisioning with an existing `auto-static` preset while NetBox is unconfigured creates a
  job that starts, reaches the `allocate-ip` phase, and *then* errors — the failure should be
  rejected before a job exists at all.

## Goal

1. Hide the Proxmox association section in the Add/Edit Box modals when no Proxmox host is
   configured.
2. Hide the `auto-static` IP-mode option in the preset form when NetBox is not configured.
3. `POST /api/proxmox/provisions` with an `auto-static` preset fails fast (HTTP 400, no job
   record created) when NetBox is not configured.

## Approaches considered

1. **Per-component client checks with extracted pure helpers (chosen).** Each gated component
   fetches the data it already depends on (`pve.hosts()`, `nbx.get()`) and hides itself; the
   show/hide decisions live in exported pure functions so node-environment vitest can cover
   them (the `associationMutation`/`settingsForm.ts` pattern). Matches the existing
   `syncProxmoxButton` precedent exactly.
2. **Server-driven feature flags via `GET /api/ui-config`.** One authoritative source, but adds
   a new API surface and cross-module coupling for state the client already fetches; the flags
   would also go stale the moment settings change in another tab. Rejected (YAGNI).
3. **Client-global integration-state module with caching.** Avoids duplicate fetches but
   introduces shared mutable state and cache-invalidation concerns for two lightweight calls
   that each fire only when a modal/tab opens. Rejected.

## Design

### 1. Box modals: Proxmox association section (`src/web/proxmoxAssociation.ts`)

New exported pure helper:

```ts
// Linked boxes always show the section (a stale link must stay visible so it
// can be unlinked); unlinked boxes only see it when a host profile exists.
export function associationSectionVisible(hostCount: number, linked: boolean): boolean
```

`createProxmoxAssociationEditor` gates itself: when the box has no current link, the section
starts `hidden` and a `pve.hosts()` fetch unhides it only if at least one host exists. A fetch
failure keeps it hidden (same "never show a dead button" rule as `syncProxmoxButton`). A box
that is already linked always shows the section, even with zero hosts — the user must still be
able to see and unlink a stale association. No changes in `main.ts`: the editor's element is
already the only Proxmox surface in both modals.

### 2. Preset form: `auto-static` option (`src/web/proxmoxPresets.ts`)

New exported pure helper:

```ts
// The option stays when NetBox is configured or when it is already the
// current value (hiding a selected option would silently rewrite the preset).
export function allowAutoStatic(netboxConfigured: boolean, currentMode: string): boolean
```

The form already fetches `nbx.get()` to set `netboxConfigured` for the hint text. In that same
`.then`, when `allowAutoStatic(...)` is false the `auto-static` option is removed from the
select. `currentMode` is the select's live value at fetch-resolution time, which covers both
the editing-a-preset-that-uses-it case and the race where the user selects it before the fetch
resolves. The existing "configure NetBox in Settings first" hint continues to cover the
kept-because-selected case.

### 3. Server fail-fast (`src/server/proxmoxProvision.js`)

`createProvision` calls the existing `requireNetboxSettings()` after resolving the preset and
before constructing the job object, whenever `preset.net.ipMode === 'auto-static'`. The throw
propagates to the route's catch and returns 400 with the existing message
(`auto-static requires the NetBox integration — configure it in Settings (⚙)`); no job is
created, persisted, or listed. The in-job `allocate-ip` check stays as a defense-in-depth
backstop (settings can be cleared between job creation and the phase running).

## Error handling

- Client fetch failures (hosts or NetBox settings) fail closed for pure-UI affordances: the
  association section stays hidden; the auto-static option gating, however, fails *open*
  (option kept) because removal on a transient fetch error would hide a legitimately
  configured capability — the server guard is the real gate.
- The server guard treats a `netboxStore.getSettings` error the same as "not configured"
  (existing `requireNetboxSettings` semantics).

## Testing

Node-environment vitest, real code, no mocks:

- `test/proxmoxAssociation.test.js` — `associationSectionVisible` truth table.
- `test/proxmoxPresets.test.js` (new) — `allowAutoStatic` truth table.
- `test/proxmoxProvision.test.js` — an `auto-static` preset with no `netboxStore` rejects from
  `createProvision` with the settings message and leaves `listProvisions()` empty; a configured
  store still provisions (existing tests already cover the happy path).

Manual/visual: modal section hidden with zero hosts, visible after adding one; preset ipMode
select shows two options until NetBox is configured.

## Out of scope

- Hiding `auto-static` *presets* from the Provision tab picker (the fail-fast 400 surfaces the
  actionable message instead — explicitly requested behavior).
- Any server-driven UI feature-flag endpoint.
