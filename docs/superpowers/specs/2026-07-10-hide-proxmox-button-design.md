# Hide the sidebar Proxmox button when no hosts are configured — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with owner)
**Builds on:** `2026-07-10-settings-tabs-proxmox-design.md` (host setup lives in Settings → Proxmox)

## Goal

The sidebar **Proxmox** button opens the operations hub (Presets / Provision / History), which is
useless until at least one Proxmox host profile exists. Hide the button when there are no hosts;
show it once the first host is added in Settings → Proxmox — without a page reload.

Web-client change only. No server, route, or store changes.

## Approach decision

Event-driven visibility. Rejected: piggybacking the status poll (an extra HTTP request every few
seconds forever, for a value that changes almost never) and render-time-only checking (the button
would not appear until a reload after adding the first host).

## Design

- **`src/web/main.ts`:**
  - The `#proxmox` button in the `renderDashboard` template gains the `hidden` attribute (starts
    hidden on every render).
  - New `syncProxmoxButton()`: calls `pve.hosts()` and sets the button's `hidden` to
    `hosts.length === 0`. A fetch error leaves the button hidden — no usable hosts means no
    button, and a transient failure must not surface a dead button. (Import `pve` from
    `./proxmox`; `main.ts` does not currently import it.)
  - Called once during `renderDashboard`, and passed to the settings modal as its close callback
    from the gear handler: `openSettingsModal('netbox', () => { void syncProxmoxButton(); })` —
    so adding the first host (or removing the last one) in Settings takes effect the moment the
    modal closes.
- **`src/web/settingsUi.ts`:** `openSettingsModal(tab: SettingsTab = 'netbox', onClose?: () => void)`.
  The shell's single `close()` invokes `onClose?.()` after teardown (listener removal + backdrop
  removal). Every close path already funnels through `close()`, so the callback fires exactly
  once per modal lifetime regardless of how it closes. The hub's "Open Settings" pointer keeps
  calling `openSettingsModal('proxmox')` with no callback — in that flow the hub is already open
  and the dashboard button's state doesn't matter until the next render.

## Accepted behavior notes

- Brief absence of the button on first paint until `pve.hosts()` resolves (milliseconds; the
  server reads a local JSON file — no SSH).
- Other open browser tabs update on their next dashboard render, not live (single-user app).
- While the settings modal is opened *from the hub pointer*, no `onClose` fires; the dashboard
  button re-syncs on the next dashboard render or gear-opened settings close. Accepted: in that
  flow the user is already inside the hub.

## Testing

- No DOM tests exist in this repo: gate is `npm run typecheck` + `npm run build` + the existing
  client unit tests staying green.
- Manual: with zero hosts the sidebar shows no Proxmox button; add a host via ⚙ → Proxmox and
  close the modal → the button appears; remove the last host and close → it disappears.

## Out of scope

- Live cross-tab visibility updates.
- Hiding any other sidebar buttons (Fleet Command / Fleet Jobs / Events are host-independent).
