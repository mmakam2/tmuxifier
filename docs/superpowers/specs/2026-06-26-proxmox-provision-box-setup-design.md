# Proxmox Provision: single mgmt key, provision-form options, and post-create box setup

## Summary

Three refinements to the Phase-1 Proxmox provisioning flow, plus reuse of the existing
box-provisioning (tmux + oh-my-*) machinery as a post-create step:

1. **Single management key.** The SSH Keys tab allows exactly one key — once a key exists, the
   add form is hidden. Presets no longer show per-key checkboxes; the single key is injected
   automatically.
2. **Richer Provision form.** The Provision screen gains a **tag** input (same single-tag datalist
   as the box modal), an **Oh My Tmux** checkbox (default on), and a **shell framework** radio
   (None / Oh My Zsh / Oh My Bash), mirroring the box add/edit modal.
3. **Post-create setup.** After the PVE job links the box, the job panel waits briefly for SSH,
   then streams the **same** box-provisioning install inline (reusing `openProvisionTerminal`):
   tmux is always installed (hard requirement); oh-my-tmux/zsh/bash run only when selected.

## Behavior

- **SSH Keys tab:** if `keys.length >= 1`, render the existing key(s) with Remove but omit the
  "add key" form. The add form returns only when there are zero keys.
- **Presets editor:** remove the "Inject keys" checkbox group. On submit, `keyIds = [theKey.id]`.
  The pre-existing "add a host and a key first" guard still gates preset creation, so there is
  always exactly one key to inject. Server validation (≥1 keyId) is unchanged.
- **Provision form additions** (between the existing fields and the Provision button):
  - **Tag** — `<input list=datalist>` populated from existing box tags (`api.boxes()` →
    deduped). Tags are singular in this app (the store keeps the first), matching the box modal.
  - **Oh My Tmux** — checkbox, default **checked**.
  - **Shell framework** — radio group None (default) / Oh My Zsh / Oh My Bash (mutually exclusive).
- **On Provision submit:** `pve.createProvision({ presetId, hostname, vmid?, ip?, tags: tag ? [tag] : [] })`.
  The oh-my-* selections are held in the hub closure (ephemeral, never stored) and passed to
  `showJob(jobId, { ohMyTmux, ohMyZsh, ohMyBash })`.
- **Job panel after `done` + linked box, when setup options were provided** (i.e. a fresh
  provision, not a History view):
  1. show "Container <vmid> up — waiting for SSH…" and poll `api.probeSessions(box)` until
     reachable, up to ~30 s (10 × 3 s),
  2. embed `openProvisionTerminal(area, boxId, { ohMyTmux, ohMyZsh, ohMyBash }, onComplete)` to
     stream the install,
  3. on completion show ✓/✗ and the **Open terminal** button; call `onBoxLinked()` to refresh.
  Viewing a **past** job from History passes no setup options and only offers Open terminal.
- **Keep the box on setup failure.** The provision WebSocket handler currently removes the box on a
  non-zero exit. Skip that removal when `box.source === 'proxmox'` — the LXC really exists and the
  box is how the user reaches it to retry.

## Data flow

```
Provision form (preset, hostname, vmid?, ip?, tag, ohMyTmux, shellFramework)
  ├─ tag  ─▶ createProvision({…, tags:[tag]}) ─▶ link step boxStore.addBox({…, tags})
  └─ ohMyTmux/shell (ephemeral) ─▶ showJob(jobId, setupOptions)
        └─ on done+linked: waitForSsh(box) ─▶ openProvisionTerminal(boxId, setupOptions)
              └─ /term?box=…&mode=provision&ohMyTmux=…&ohMyZsh=…&ohMyBash=…
                    └─ buildEnsureTmuxRemote (tmux always; oh-my-* conditional) over ssh
        on non-zero exit: server keeps the box because source==='proxmox'
```

## Changes

**Server**
- `proxmoxValidate.js` — `assertProvisionInput` accepts an optional `tags` array of strings.
- `proxmoxProvision.js` — `createProvision` accepts `tags`, stores them on the job, and applies
  them at the link step (`tags: job.tags?.length ? job.tags : (boxDefaults.tags || [])`).
- `server.js` — provision WS handler: skip `store.removeBox` on failure when `box.source === 'proxmox'`.

**Web**
- `proxmox.ts` — `createProvision` spec type gains `tags?: string[]`.
- `proxmoxUi.ts` — SSH Keys single-key gating; Presets key-checkbox removal + auto `keyIds`;
  Provision form tag + oh-my-* controls; `showJob` post-link readiness wait + inline
  `openProvisionTerminal`; dispose the setup terminal on modal close. Imports `openProvisionTerminal`
  from `./terminal`.

## Testing

- `proxmoxValidate.test.js` — `assertProvisionInput` accepts a valid `tags` array, rejects a
  non-array / non-string-element `tags`.
- `proxmoxProvision.test.js` — a provision with `tags` links a box carrying those tags; without
  `tags`, falls back to the preset's `boxDefaults.tags`.
- `server.test.js` — (covered by existing provision-route tests; the rollback-skip is exercised
  by the live flow and the existing provision WS tests for non-proxmox boxes stay green).
- Web UI verified by `tsc --noEmit` + `npm run build`; the post-create setup reuses the already
  tested box-provisioning path, so no new web unit test (consistent with the existing UI).

## Out of scope

- Multi-tag support (the store is singular by design).
- Re-running setup from History (a past job only offers Open terminal).
- Changing the box-provisioning script itself (`buildEnsureTmuxRemote` is reused unchanged).
