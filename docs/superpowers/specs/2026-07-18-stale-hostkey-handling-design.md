# Graceful Stale Host Key Handling — Design

**Date:** 2026-07-18
**Status:** Approved

## Problem

Auto-static provisioning reuses IPs: an address allocated, released, and re-allocated in NetBox
lands on a brand-new container with a brand-new SSH host key. The Tmuxifier host's
`~/.ssh/known_hosts` still holds the old key, and `StrictHostKeyChecking=accept-new` (the
default `hostKeyPolicy`, set in `sshCommand.js`) hard-rejects changed keys exactly like `yes` —
ssh exits non-zero with `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` / `Host key
verification failed.`. Today that surfaces as a generic red "Unreachable" dot; the only hint is
a client-side tooltip regex in `statusDot.ts`.

## Security rationale

The changed-key error is SSH's man-in-the-middle defense. The design never auto-clears a key
merely because a connection failed. A key is removed in exactly three situations:

1. **Tmuxifier destroyed the machine** (verified deprovision) — the old identity is provably dead.
2. **Tmuxifier just created a machine at that address** (provision, IP newly known) — any stale
   entry is by definition not this guest.
3. **The user explicitly clicks "Forget host key"** — human consent replaces lifecycle proof,
   for boxes Tmuxifier never provisioned.

Ordinary box removal (`boxRemoval.removeBox`) does **not** forget keys: the machine still
exists, and `~/.ssh/known_hosts` is shared with the user's regular ssh usage.

## Components

### `src/server/knownHosts.js` (new)

```js
export function createKnownHosts({ run } = {})   // run: DI exec, defaults to execFile wrapper
  → { forget(host, port) }
```

- `forget` runs `ssh-keygen -R <host>` and, when `port` is set and ≠ 22, also
  `ssh-keygen -R [<host>]:<port>` (known_hosts bracket form for nonstandard ports).
- Invocation is `execFile('ssh-keygen', ['-R', target])` — argv array, never a shell string.
  Hosts are already allowlist-validated (`assertBoxSafe`), but no shell means no interpolation
  surface at all.
- Best-effort: resolves `{ code, stdout, stderr }`, never throws (same contract as
  `runLocalShellScript` in `localShellActions.js`, which is the DI pattern to mirror).
- `ssh-keygen -R` operates on the default `~/.ssh/known_hosts` of the service user and handles
  hashed entries. **Known limitation:** if `TMUXIFIER_SSH_CONFIG` points at a config with a
  custom `UserKnownHostsFile`, that file is not edited. Accepted — the option is off by default
  and used for tests; document in README if it ever becomes user-facing.

### Layer 1 — verified deprovision (`proxmoxLifecycle.js`)

In `runDeprovision`'s `unlink` phase (after `waitForState(job, 'missing')` confirms the
container is gone; `box` is in scope from `resolveTarget`), call
`knownHosts.forget(box.host, box.port)` best-effort alongside `releaseNetboxIp` — before
`removeLinkedBox`. Also applies on the missing-at-entry short-circuit path.

### Layer 2 — provision (`proxmoxProvision.js`)

In the `link` phase, once the container's IP is known (auto-static `j.ip`, static preset CIDR,
or DHCP `discoverIp`), call `knownHosts.forget(ip, 22)` before `boxStore.addBox(...)`.
Provisioned boxes use port 22. First SSH contact happens later (status poller / terminal), so
clearing here is strictly before any key comparison.

### Layer 3 — detect + user-consent forget (manual boxes)

**Server classification (`status.js`):** add

```js
const HOSTKEY_CHANGE_RE = /remote host identification has changed|host key verification failed/i;
```

checked in the same `code !== 0 && empty stdout` block as `AUTH_FAIL_RE` (host-key test first —
the two never legitimately co-occur; key verification aborts before auth). Emits
`{ reachable: false, hostKeyChanged: true, error }`.

**API (`server.js`):** `POST /api/boxes/:id/forget-hostkey`, `preHandler: requireAuth`,
mirroring the `reconnect` route shape: 404 on unknown box, then best-effort
`knownHosts.forget(box.host, box.port)`, `boxActions.exitMaster(box)`,
`statusChecker.resetBackoff(box.id)`; returns `{ ok: true }`. `createKnownHosts` is wired in
`index.js` and injected into `server.js` (and `proxmoxLifecycle`/`proxmoxProvision`).

**UI (`main.ts` / `statusDot.ts` / `api.ts`):** a conditional ⚷ "Forget host key" button in the
box row's `.box-actions`, appended only when the latest status has `hostKeyChanged`. Click →
`api.forgetHostKey(id)` → same refresh dance as the ↻ Reconnect button. Dot stays red;
`classifyError`'s existing "Host key changed — verify the box" tooltip remains the explanation.
The button carries a `title` warning that forgetting a key should only be done when the box was
legitimately rebuilt.

**Health events (`healthHistory.js` / `healthEvents.ts`):** `sampleOf` gains
`keyChanged: !!status.hostKeyChanged`; `classifyTransitions` emits a new `'key-changed'` kind on
the rising edge (analogous to `needs-auth`); `healthEvents.ts` gets a formatter line for it.

## Testing

Real code, no mocks (DI fakes only), TDD:

- `test/knownHosts.test.js` (new): argv shape (`ssh-keygen -R host`), bracket form fires only
  for port ≠ 22, never throws when `run` fails.
- `test/status.test.js`: changed-key stderr → `hostKeyChanged: true` (next to the needsAuth
  classification test); auth stderr still classifies as needsAuth, not hostKeyChanged.
- `test/proxmoxLifecycle.test.js`: deprovision unlink phase calls `forget(host, port)`; ordinary
  `boxRemoval` path does **not** (negative assertion).
- `test/proxmoxProvision.test.js`: link phase calls `forget(ip, 22)` before `addBox`.
- `test/server` route test: 404, happy path calls forget/exitMaster/resetBackoff, auth gate.
- `test/statusDot.test.js` / web: `hostKeyChanged` gating logic (pure helpers only — no jsdom).
- `test/healthHistory.test.js`: `'key-changed'` edge event.

## Out of scope

- Per-box `UserKnownHostsFile` under `data/` (would isolate Tmuxifier's trust store; rejected
  for now — diverges from "rely on the user's SSH setup" and loses already-established trust).
- Any automatic clearing on connection failure outside the three sanctioned situations.
- Deriving the known_hosts path from a custom `TMUXIFIER_SSH_CONFIG`.
