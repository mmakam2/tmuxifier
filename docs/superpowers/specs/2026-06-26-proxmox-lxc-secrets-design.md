# Proxmox LXC Secrets: default host key, additional keys, root password

## Summary

Rework the Proxmox provisioning secrets: rename the *SSH Keys* tab to **LXC Secrets**, inject the
**Tmuxifier host's own public key** as an always-on default management key, allow **additional**
named keys (sealed at rest, masked in the UI), and add an **optional root password** (sealed,
write-only) applied at container create. Every provision injects the default key + all additional
keys; presets no longer reference keys.

## Decisions (confirmed)

- **Default key source:** the Tmuxifier host's own public key, auto-detected from
  `~/.ssh/id_ed25519.pub` → `id_rsa.pub` → `id_ecdsa.pub` (first found), overridable via
  `TMUXIFIER_PVE_DEFAULT_PUBKEY`. Guarantees Tmuxifier can SSH into what it provisions.
- **Injection:** every provision injects `[default key (if found)] + [all additional keys]`. Not
  preset-gated. Presets drop the `keyIds` field/requirement.
- **Root password:** included. Optional, sealed at rest, write-only, applied at create.

## Behavior

- **LXC Secrets tab** (renamed from SSH Keys):
  1. **Default management key** — read-only display of the host's detected public key (or a note +
     the env-var hint if none found). Always injected.
  2. **Additional keys** — add (name + public key) / remove, multiple allowed. Sealed at rest;
     listed **masked** (`name · ••• set`, no key value returned to the browser).
  3. **Root password** — two masked inputs (password + confirm). Save requires them to match and
     be ≥5 chars (PVE's `pct` minimum). Sealed at rest; shown as `••• set` with Replace / Clear;
     never returned to the browser.
- **Provisioning:** `buildCreateParams` receives `publicKeys = [defaultKey, ...additionalKeys]`
  (falsy filtered) and `password` (when set). The create call gets `ssh-public-keys` and, if set,
  `password`.
- **Presets:** the "add a host and a key first" gate becomes "add a host first"; the preset editor
  no longer sends `keyIds`; `assertPresetInput` no longer requires keyIds; `normalize` drops the
  `keyIds` field.

## Architecture

- **`config.js`** — `pveDefaultPubKeyPath` from `TMUXIFIER_PVE_DEFAULT_PUBKEY` (default undefined →
  auto-detect).
- **`defaultKey.js` (new)** — `readDefaultPublicKey({ configuredPath, home, readFileSync, existsSync })`
  → trimmed key string or `null`. Pure/injectable (tests pass fake fs). Order: configured path,
  else `~/.ssh/id_ed25519.pub`, `id_rsa.pub`, `id_ecdsa.pub`.
- **`proxmoxStore.js`** —
  - `addKey` seals `publicKey`; `listKeys()` redacts (`{ id, name, createdAt, hasKey:true }`, no
    key value); `listKeys({ withSecret:true })` decrypts (sealed-or-legacy-plaintext).
  - `setRootPassword(pw)` (validate + seal), `clearRootPassword()`, `getRootPassword({withSecret})`
    → plaintext|null, `hasRootPassword()` → boolean.
  - presets: drop `keyIds` from `normalize`; pass only `hostIds` to `assertPresetInput`.
- **`proxmoxValidate.js`** — `assertRootPassword(pw)` (≥5 chars); `assertPresetInput` drops the
  keyId requirement.
- **`proxmoxParams.js`** — `buildCreateParams(preset, { vmid, hostname, ip, publicKeys, password })`
  sets `params.password` when `password` is non-empty.
- **`proxmoxProvision.js`** — `createProvisionManager({ ..., defaultPublicKey })`. `createProvision`
  builds `publicKeys = [defaultPublicKey(), ...listKeys({withSecret}).map(publicKey)].filter(Boolean)`
  and `password = getRootPassword({withSecret})`; passes both through `run` to `buildCreateParams`.
  No longer reads `preset.keyIds`.
- **`server.js`** — `buildServer({ ..., defaultPublicKey })`. Routes: `GET /keys` (redacted),
  `POST/DELETE /keys`; `GET /default-key` → `{ publicKey|null }`; `GET /root-password` → `{ set }`;
  `PUT /root-password` `{ password }` → seal (400 if <5); `DELETE /root-password` → clear.
- **`index.js`** — construct `defaultPublicKey = () => readDefaultPublicKey({ configuredPath:
  config.pveDefaultPubKeyPath, home: os.homedir() })`; pass to the provision manager and buildServer.
- **`proxmox.ts` / `proxmoxUi.ts`** — redacted `PveKey` (no `publicKey`); `defaultKey()`,
  `rootPasswordStatus()`, `setRootPassword()`, `clearRootPassword()`; tab rename + the three
  sections; preset editor drops `keyIds` + the key-required gate.

## Security

Additional keys and the root password are AES-256-GCM sealed (`secretBox`, key from cookie secret)
in `data/proxmox.json` (`0600`), decrypted only server-side at provision time, never returned to the
browser (redacted reads). The default host key is read from the host's `~/.ssh` at provision time
(not stored). A public key is not truly secret; sealing additional keys is for tab consistency.
Backward-compatible: a previously-stored cleartext key still reads (sealed-or-plaintext check).

## Testing (TDD on the server)

- `defaultKey.test.js` — configured path wins; auto-detect order; null when none.
- `config.test.js` — `pveDefaultPubKeyPath` from env.
- `proxmoxValidate.test.js` — `assertRootPassword` (<5 throws); `assertPresetInput` no longer
  requires keyIds.
- `proxmoxParams.test.js` — `password` set when provided, omitted when not.
- `proxmoxStore.test.js` — key sealed on disk + redacted read + withSecret reveal + legacy
  cleartext read; root password seal/reveal/clear/status; preset without keyIds persists.
- `proxmoxProvision.test.js` — provision injects default + additional keys and passes the password;
  the fake client captures the create params.
- `server.test.js` — keys response carries no key value; root-password set/clear/status; default-key
  route; <5-char password → 400.
- Web verified by `tsc --noEmit` + `npm run build`.

## Out of scope

- Per-key or per-preset selection (injection is global now).
- Generating a host key if none exists (we only read an existing one; the env hint guides the user).
