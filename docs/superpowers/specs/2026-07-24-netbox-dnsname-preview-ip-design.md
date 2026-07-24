# NetBox dns_name write-back + next-IP preview — design

Date: 2026-07-24
Status: approved

Two small additions to the NetBox integration, both picked from the v1 out-of-scope list of
`2026-07-09-netbox-auto-static-provisioning-design.md`:

1. **dns_name write-back** — the NetBox IP record created for an `auto-static` provision gets a
   `dns_name`, composed from the provision hostname and a new global DNS suffix setting.
2. **Next-IP preview** — the provision form shows the next available IP for an `auto-static`
   preset as soon as the preset is selected, before any job starts.

## Key insight vs the original out-of-scope wording

The 2026-07-09 spec deferred "reconciling the NetBox record's `dns_name`/tags after the box gets
its final identity", implying a post-hoc write. That is unnecessary: the provision hostname is
user-supplied **before** the `allocate-ip` phase runs, and `allocateIp(prefix, fields)` already
passes arbitrary record fields (`status`, `description`). `dns_name` rides the same create POST.
No reconcile step, no second write path, no new failure mode.

Renaming a box later does **not** update NetBox (decided; single write at allocation only).
Tag write-back stays out of scope.

## 1. Settings: `dnsSuffix`

- `assertSettingsInput` (`src/server/netboxValidate.js`) accepts an optional `dnsSuffix`:
  - trimmed and lowercased; empty/whitespace → stored as `null`;
  - otherwise must be dot-separated DNS labels: each label 1–63 chars of `[a-z0-9-]`, no
    leading/trailing hyphen; total length ≤ 253; no leading/trailing dot;
  - invalid → throw (settings-save is the validation chokepoint, so a bad suffix can never
    reach the allocation path).
- Returned in **both** return branches of `assertSettingsInput` — the plain-http branch
  returns early and is easy to miss.
- `netboxStore.setSettings` persists it via the existing normalized spread. It is not a
  secret: it survives `redact()`, so `GET /api/netbox/settings` returns it and the settings
  form can re-display it.
- `settingsNetbox.ts`: one text input, label "DNS suffix (optional)", placeholder
  `lan.example.com`, saved with the rest of the form.

## 2. NetBox client: shared pick helper + `nextIp`

In `src/server/netboxApi.js`:

- Extract the gateway-skip selection currently inline in `allocateIp` into an internal helper
  `findFreeIp(prefix)`: GET `/ipam/prefixes/:id/available-ips/`, skip the inferred gateway
  (`firstUsableIp`), return `{ address, gateway }` or throw
  `prefix <cidr> has no available IPs`.
- `allocateIp(prefix, fields)` becomes: `findFreeIp` + the existing POST. Behavior unchanged.
- New method `nextIp(vid)`: `findPrefixByVlan(vid)` + `findFreeIp`, **no POST**. Returns
  `{ address, prefix }` (address in CIDR form, as NetBox reports it).

Preview and allocation share one selection code path, so the preview can never show an address
the allocator would not pick (modulo time-of-check races, which are inherent and accepted —
the preview is explicitly non-binding).

## 3. Provision write path

`src/server/proxmoxProvision.js`, `allocate-ip` phase (`run()`):

- `requireNetboxSettings()` already returns the decrypted settings object; it now carries
  `dnsSuffix`.
- Compose the record name — `<hostname>.<dnsSuffix>` when a suffix is configured, the bare
  hostname otherwise — and add it as `dns_name` to the existing `allocateIp` fields alongside
  `status: 'active'` and the `tmuxifier:` description.
- The hostname is already validated by `assertProvisionInput`, and the suffix by
  settings-save, so the composed value needs no re-validation.

## 4. Preview route + UI

**Route** — `GET /api/netbox/next-ip?vlan=<vid>` in `server.js`, next to the other
`/api/netbox/*` routes, `preHandler: requireAuth`. Result-shaped (the `testNetbox` pattern),
never a 500 for expected states:

| Condition | Response |
|---|---|
| `vlan` missing or not all digits | 400 `{ ok: false, error }` |
| NetBox not configured / settings unreadable | `{ ok: false, error }` |
| VLAN → 0 or >1 prefixes, prefix full, unreachable, TLS/auth failure | `{ ok: false, error }` (client throw message) |
| Success | `{ ok: true, address, prefix }` |

The route builds a `createNetboxClient` from `netboxStore.getSettings({ withSecret: true })`
per request and calls `nextIp(vlan)`; client errors are caught and mapped to `ok: false`.
The token never appears in responses or error text (client errors already exclude it).

**Fetch layer** — `netbox.ts` gains `nextIp(vlan: number)`.

**UI** — `renderProvision` (`src/web/proxmoxUi.ts`): `syncPreset` already runs on preset
change. When the selected preset's `ipMode === 'auto-static'`, it fires the preview fetch and
renders into the existing summary line area, e.g.:

```
next IP: 192.168.30.7 (from 192.168.30.0/24, non-binding)
```

(`nextIp` returns the address in CIDR form as NetBox reports it; the UI strips the mask for
display.)

- A generation guard discards a response that lands after the user has switched presets
  (same stale-response discipline as `fleetPoll.ts`/`setupPoller.ts`).
- While loading: `next IP: …`. On `ok: false`: the error text inline in the same spot.
- The preview never disables or gates the Provision button — the job performs its own
  fail-fast NetBox check at request time, which remains the authority.

## 5. Error handling summary

- **Preview** failures are informational only: inline text, provisioning unaffected.
- **Allocation** failure model is unchanged: `dns_name` rides the existing create POST, so a
  NetBox rejection fails the `allocate-ip` phase exactly like any allocation failure (job
  `error`, no container created, reservation-release path untouched).
- **Suffix** validity is enforced at settings save; the allocation path trusts stored settings.

## 6. Testing (TDD, real code, no mocks)

- `netboxValidate.test.js`: `dnsSuffix` accept/reject/normalize matrix (case folding, label
  length, hyphen edges, dots, 253 cap, empty → null); retained in the plain-http branch.
- `netboxStore.test.js`: suffix persists through `setSettings` and survives the redacted read.
- `netboxApi.test.js`: `nextIp` picks the first non-gateway available IP; gateway-only/empty →
  "no available IPs"; `allocateIp` behavior unchanged after the helper extraction.
- `proxmoxProvision.test.js`: the allocate call carries the composed `dns_name` with a suffix
  configured, and the bare hostname without one.
- `server` route tests: auth required; `vlan` validation; unconfigured, success, and
  prefix-full shapes.
- Web client: `npm run typecheck` + `npm run build`.

## Out of scope

- Updating NetBox when a box is renamed or removed (allocation-time write only).
- Tag write-back to the NetBox record.
- `netboxStore`'s unserialized read-modify-write (known deferred item; this change adds a
  field but does not alter the concurrency shape).
- Preview for `static`/`dhcp` presets (nothing to preview).
