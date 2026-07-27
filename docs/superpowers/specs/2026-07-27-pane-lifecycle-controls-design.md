# Pane lifecycle controls — design

Date: 2026-07-27
Status: approved

## Summary

A pane whose box is linked to a Proxmox container gets that container's lifecycle controls
in its own header bar, immediately after the `user@host` target: `⏻` shutdown, `↺` reboot,
and `⏹` force stop while it is running, `▶` start while it is stopped. Today those actions
exist only in the Proxmox hub's Containers tab, which means rebooting the box you are
already looking at costs a modal, a tab switch, and a row hunt. The controls are state-gated,
guarded against a mis-click by an arm-then-fire interaction inside the bezel strip, and
report the resulting server-side job as a chip in the same slot.

No server change. `/api/status` already carries `proxmoxState`, and
`POST /api/proxmox/lifecycle-jobs` plus `GET /api/proxmox/lifecycle-jobs/:id` already exist
and are already authenticated.

## Decisions (from brainstorming)

- **Action set:** start, shutdown, reboot, and force stop. Deprovision stays in the Proxmox
  hub only — it destroys volumes and removes the box, and a 28px strip one pixel from where
  panes are dragged is the wrong home for it, even behind the typed-name confirm.
- **Form:** inline icon keys, matching the header's existing `↻`/`✕` icon-key part and
  `DESIGN.md`'s icon-key rules. Chosen over a single `⏻` key opening a popup menu (hides
  what the user asked to have visible, and adds a popup component) and over uppercase text
  legends (unmistakable, but eats the horizontal room `user@host` and the state chip need in
  a four-pane split).
- **Mis-click guard:** arm-then-fire in the bezel, not a confirm modal and not the hub's
  current no-confirm behavior. A modal over a live terminal for a routine reboot is heavy;
  no confirm at all is defensible in the hub — a deliberate destination — but not here.
- **Progress feedback:** an in-bezel chip driven by a client-side poll of the job the header
  itself created. Chosen over adding the box's `activeJob` to `/api/status`: that would also
  paint jobs started from the hub or a second tab, but costs a server change for a case the
  pane already handles correctly once the status poll catches up.

## Behavior

### Which keys, and when

One pure function decides, from the pane's derived state (`paneState` in `main.ts`) and the
status snapshot's `proxmoxState`:

| Condition | Keys |
| --- | --- |
| pane state `stopped` | `▶` start |
| `proxmoxState === 'running'` | `⏻` shutdown, `↺` reboot, `⏹` stop (danger) |
| `missing`, `unknown`, no Proxmox link, `__local__`, pane state `setup` | none |

Reading the pane state rather than `proxmoxState` alone is deliberate: `paneState` already
treats an `unknown` PVE read as sticky for a pane that is showing its stopped panel, so a
failed read cannot silently strip the Start key from a stopped box. Panes with no keys
render exactly the header they render today — an empty slot adds no spacing.

A pane mid-setup shows no keys: its box was just provisioned, its setup job is running, and
every one of these actions would interrupt it.

### Arm-then-fire

`▶` start is not armable — it fires on first click, since starting a stopped container
cannot lose work.

The three destructive keys arm instead:

1. First click arms that key alone. It turns LED red and swaps its glyph for a legend
   (`SHUTDOWN?`, `REBOOT?`, `STOP?`). The other keys stay idle and unchanged.
2. A second click on the armed key within 3 seconds fires it.
3. Anything else disarms: the 3s timeout, Escape, the key losing focus, a click anywhere
   else in the document, arming a different key, or a state update that changes the key set.

Arming never survives a rebuild, and a rebuild never happens while a key is armed or a job
chip is live (see *Update discipline* below).

### Firing and the job chip

Firing calls `pve.createLifecycleJob({ boxId, action })`. The keys then give way, in the
same slot, to a `.pane-chip` reading `starting…`, `shutting down…`, `rebooting…`, or
`stopping…`.

The chip is driven by `createSetupJobPoller` — already generic over its job type `<J>`, so
it is reused verbatim with `fetchJob: () => pve.lifecycleJob(id)` — at roughly 1.5s:

- `running` → keep the chip, poll again.
- `done` → clear the chip and call the injected `onSettled`, which triggers an immediate
  status poll so the pane flips to its stopped panel (or back to a terminal) instead of
  waiting out the 30s tick.
- `error` / `interrupted` → the chip turns LED red reading `shutdown failed` (etc.), with
  the job's error text as its `title`. Clicking it opens the Proxmox hub straight to that
  job's log. A red chip is settled, not in flight: it clears when clicked, or when the next
  update brings a different key set.
- A rejected fetch reaches the policy as `null` (the poller's existing contract). Treated as
  transient and retried; after three consecutive nulls the chip settles red reading
  `lost track of job`, with the same click-through to the hub. `chipFor` takes this as a
  `'lost'` pseudo-status alongside the four real `LifecycleStatus` values.

The server re-verifies container state when the job starts (`proxmoxLifecycle.js` checks
`current.state !== REQUIRED[job.action]`), so a key rendered from a stale snapshot does not
act on a wrong assumption — it produces a job that fails with `shutdown requires running`,
which lands in the red chip. Likewise a second action fired while another job is in flight
is refused by `assertTargetIdle` with a 409 (`container already has an active lifecycle
job`) and surfaces the same way.

## Modules and data flow

- **`src/web/paneLifecycle.ts` (new)** — house pattern: pure core plus a thin DOM layer, the
  same split as `paneHeader.ts` and `stagePanes.ts`, and the reason the core is unit-testable
  in the `node` vitest environment.
  - Pure: `lifecycleKeysFor(paneState, pveState)` → an ordered list of key descriptors
    (`{ action, glyph, label, danger }`); `armReduce(state, event)` → the arm/fire/disarm
    machine; `chipFor(action, jobStatus)` → `{ text, cls }`.
  - DOM: `buildPaneLifecycle({ boxId, onOpenJobLog, onSettled })` →
    `{ el, update({ paneState, pveState }), destroy() }`. The control owns its arm timer and
    its job poller; `destroy()` stops both.
- **`src/web/paneHeader.ts`** — `buildPaneHeader` exposes a `lifecycleSlot` element placed in
  `.pane-header-id` after `.pane-target`, mirroring the existing `voiceSlot` seam. Nothing
  else changes: the model, the chip precedence, and the right-hand action cluster are
  untouched. The module's existing comment — action buttons are fixed at build time because
  refresh/undock availability changes only on a repaint — stays true, and is exactly why
  lifecycle keys are a mounted part with their own update path rather than more
  `PaneHeaderActions` entries.
- **`src/web/main.ts`** — `headerFor` builds the control for a Proxmox-linked box and mounts
  it into `built.lifecycleSlot`, registering its `update` in a `paneLifecycles` map alongside
  `paneHeaders`. `updatePaneHeaders()` pushes the latest `paneState`/`proxmoxState` on every
  status poll. `repaintStage()` calls `destroy()` on the controls whose DOM is about to die,
  then clears the map — without that, an orphaned control's poller and arm timer outlive its
  pane. `onOpenJobLog` opens the hub; `onSettled` calls the existing status poll.
- **`src/web/proxmoxUi.ts`** — `HubInitial` gains `lifecycleJobId?: string`, and
  `openProxmoxHub` calls its existing internal `showLifecycleJob` for it after mount. This
  is what the red chip clicks through to.
- **`src/web/style.css`** — a `.pane-lifecycle` group plus armed and danger states, per
  `DESIGN.md`: flat legend-dim glyphs on 4px hit pads, hover raises one chassis step and
  brightens, destructive hover turns LED Red. The armed key uses the LED-red fill the
  design language already reserves for destructive state.

### Update discipline

`update({ paneState, pveState })` is called on every status poll (30s) and must not disturb
live interaction:

- It rebuilds the keys only when the computed key set differs from what is rendered.
- It never rebuilds while a job is in flight — that chip is the authority until its poller
  settles. A settled red chip does not block a rebuild; it is replaced by the new key set.
- If the key set changes while a key is armed, the arm is dropped and the keys rebuild. A
  container that stopped out from under an armed `SHUTDOWN?` must not leave a live armed key
  pointing at an action the server would now refuse.

## Testing

`test/paneLifecycle.test.js`, vitest over the pure core with real code (no mocks), covering:

- `lifecycleKeysFor` for every combination in the table above, including the sticky-stopped
  case (`paneState 'stopped'` with `pveState 'unknown'` still yields Start) and the empty
  results for `missing`/`unknown`/`setup`.
- `armReduce`: arming a key, a second click on it firing, a click on a different key moving
  the arm rather than firing, timeout and foreign-click and Escape all disarming, a key-set
  change dropping the arm, and start never entering the armed state.
- `chipFor`: text and class per action for `running`, `done`, `error`, and `interrupted`.

The DOM layer stays thin and is exercised by the existing split e2e the way
`buildPaneHeader`'s is. A true end-to-end lifecycle test would need a live Proxmox cluster,
so it is out of scope; the server-side lifecycle manager already has its own tests.

## Out of scope

- Deprovision from the pane header.
- A chip for jobs started outside this pane (the hub, another browser tab). Rejected above;
  revisit by adding `activeJob` to `/api/status` if it proves annoying in use.
- Any change to the Proxmox hub's Containers tab, which remains the full-control surface.
