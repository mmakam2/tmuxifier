# Proxmox preset: additional disks (mount points)

## Summary

Let a container preset declare **additional disks** (Proxmox LXC mount points `mp0`, `mp1`, …)
beyond the rootfs. The preset editor's Disk section gains an **Additional disks** list and a
**+ Add disk** button that opens a small modal (Proxmox-style: Mount Point ID, Storage, Disk size,
Path, Backup). Added disks are stored on the preset and created on every provision.

## Behavior

- **Add disk modal** (small modal on top of the hub):
  - **Mount Point ID** — auto-assigned to the next free `mpN`, shown read-only.
  - **Storage** — dropdown of the host's container (`rootdir`) storages, same source as the rootfs
    storage (captured when the preset's node loads).
  - **Disk size (GiB)** — number, 1–8192.
  - **Path** — absolute container mount path (e.g. `/data`), required.
  - **Backup** — checkbox (include the mount in backups).
  - **Add disk** / **Cancel**. On Add, the disk joins the preset editor's in-memory list; Remove
    drops it. Saving the preset persists the list.
- **Provisioning:** each mount becomes one create param `mpN=<storage>:<sizeGiB>,mp=<path>[,backup=1]`
  (e.g. `mp0=local-lvm:8,mp=/data,backup=1`).

## Architecture

- **`proxmoxValidate.js`** — `assertPresetInput` validates an optional `mounts` array: each
  `{ id matches /^mp\d+$/ and unique, storage is a safe id, sizeGiB 1–8192, path is absolute
  (`/^\/[A-Za-z0-9._/-]+$/`), backup boolean }`.
- **`proxmoxParams.js`** — `buildCreateParams` emits one param per mount after `rootfs`:
  `params[m.id] = \`${m.storage}:${m.sizeGiB},mp=${m.path}${m.backup ? ',backup=1' : ''}\``.
- **`proxmoxStore.js`** — `normalizePreset` carries a normalized `mounts: [{ id, storage, sizeGiB,
  path, backup:boolean }]` (default `[]`).
- **`proxmox.ts`** — `PveMount` type; `PvePreset.mounts: PveMount[]`.
- **`proxmoxUi.ts`** — preset editor holds an in-memory `mounts` list + a renderer; `+ Add disk`
  computes the next free `mpN` and opens `openAddDiskModal({ id, storages, onAdd })`; the modal
  reuses the app's modal/field/button styles (`.pve-disk-modal` for width). Submit includes `mounts`.

## Testing (TDD on the server)

- `proxmoxValidate.test.js` — valid mounts pass; bad id / duplicate id / non-absolute path /
  out-of-range size rejected.
- `proxmoxParams.test.js` — mounts emit `mpN=storage:size,mp=path` with/without `,backup=1`; no
  `mpN` params when `mounts` is empty/absent.
- `proxmoxStore.test.js` — a preset with mounts persists them normalized (backup coerced to bool).
- Web verified by `tsc --noEmit` + `npm run build`.

## Out of scope

- Editing an existing disk in place (remove + re-add).
- Attaching pre-existing volumes (only newly-allocated `storage:size` disks).
- bind/device mount types (only allocated mount points).
