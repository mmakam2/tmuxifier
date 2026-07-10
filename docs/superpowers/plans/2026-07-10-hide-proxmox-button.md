# Hide Sidebar Proxmox Button Without Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sidebar Proxmox button is hidden while no Proxmox host profiles exist and appears (without a reload) once the first host is added in Settings → Proxmox.

**Architecture:** Event-driven visibility in the web client: the button renders `hidden`; `syncProxmoxButton()` in `main.ts` fetches `pve.hosts()` and toggles it, running at dashboard render and via a new optional `onClose` callback on `openSettingsModal`. No server changes.

**Tech Stack:** TypeScript web client (`src/web/`), Vite, existing `pve` fetch layer.

**Spec:** `docs/superpowers/specs/2026-07-10-hide-proxmox-button-design.md`

## Global Constraints

- Web-client change only — nothing under `src/server/`.
- A `pve.hosts()` fetch error leaves the button hidden (no usable hosts ⇒ no button; never show a dead button).
- `onClose` fires exactly once per modal lifetime, after teardown, from the shell's single `close()` — every close path (✕, Escape, backdrop, Cancel, Save-success, Clear-success) already funnels there.
- The hub's "Open Settings" pointer keeps calling `openSettingsModal('proxmox')` with no callback.
- No `innerHTML` beyond the existing static dashboard template; no new interpolation into it.
- Gate: `npm run typecheck && npm run build` clean + `npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js` green. (No DOM test harness exists in this repo, and the change is a one-line hidden-toggle around a fetch — no new unit test; the per-task review traces the DOM logic.)

---

### Task 1: Hidden-until-hosts Proxmox button

**Files:**
- Modify: `src/web/main.ts` (template line ~388, imports ~line 10, gear handler ~line 425, new helper + render-time call)
- Modify: `src/web/settingsUi.ts:16-23` (signature + `close()`)
- Modify: `README.md` (one clause where the Proxmox hub/button is introduced)

**Interfaces:**
- Consumes: `pve.hosts(): Promise<PveHost[]>` from `src/web/proxmox.ts` (not currently imported by `main.ts`); the settings shell's `close()` at `src/web/settingsUi.ts:23`.
- Produces: `openSettingsModal(tab: SettingsTab = 'netbox', onClose?: () => void): void`.

- [ ] **Step 1: Add the `onClose` parameter to the settings shell**

In `src/web/settingsUi.ts`, change the signature and `close()`:

```ts
export function openSettingsModal(tab: SettingsTab = 'netbox', onClose?: () => void): void {
```

```ts
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); onClose?.(); }
```

(No other change in the file. The first Escape removes the keydown listener, so `close()` cannot run twice — `onClose` fires exactly once.)

- [ ] **Step 2: Hide the button in the dashboard template**

In `src/web/main.ts`'s `renderDashboard` template (the `fleet-actions` line), add `hidden` to the Proxmox button only:

```html
<button id="proxmox" type="button" class="proxmox-btn" title="Provision Proxmox LXC containers" hidden>Proxmox</button>
```

- [ ] **Step 3: Add the sync helper and wire it**

Add to the imports at the top of `src/web/main.ts`:

```ts
import { pve } from './proxmox';
```

Add this function next to `renderDashboard` (module level):

```ts
// The Proxmox hub is useless until a host profile exists (setup lives in
// Settings → Proxmox), so the sidebar button only appears once one does.
// A fetch error keeps it hidden — never show a dead button.
async function syncProxmoxButton() {
  const btn = app.querySelector<HTMLButtonElement>('#proxmox');
  if (!btn) return;
  try { btn.hidden = (await pve.hosts()).length === 0; } catch { btn.hidden = true; }
}
```

Call it inside `renderDashboard` right after the existing `#proxmox` click-handler wiring (~line 475):

```ts
  void syncProxmoxButton();
```

Change the gear handler (~line 425) to re-sync when the settings modal closes:

```ts
  app.querySelector('#settings')!.addEventListener('click', () => { openSettingsModal('netbox', () => { void syncProxmoxButton(); }); });
```

(The previous `void openSettingsModal()` wrapper is obsolete — the function is synchronous.)

- [ ] **Step 4: README note**

Find the sentence introducing the Proxmox hub/button (`grep -n -i "proxmox" README.md`, the dashboard/hub description — not the setup steps) and append a clause stating the sidebar Proxmox button appears once at least one host is configured in Settings (⚙) → Proxmox. Match the surrounding phrasing; placeholders only.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build && npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js`
Expected: all clean/green.

Static self-check: trace that every close path of the settings modal reaches the new `onClose?.()` (they all call the one `close()`), and that the hub pointer call site (`src/web/proxmoxUi.ts`, `openSettingsModal('proxmox')`) still typechecks with the widened signature.

- [ ] **Step 6: Commit**

```bash
git add src/web/main.ts src/web/settingsUi.ts README.md
git commit -m "feat(ui): hide the sidebar Proxmox button until a host is configured"
```
