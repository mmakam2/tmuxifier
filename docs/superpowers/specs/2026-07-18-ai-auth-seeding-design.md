# AI CLI Auth Seeding — Design

**Date:** 2026-07-18
**Status:** Draft (pending user review)

## Problem

The provision-time tool catalog can install Claude Code and Codex CLI, but both arrive
unauthenticated. Subscription auth is interactive-OAuth by design: Claude Code prints a URL +
paste-back code (workable in a terminal, but manual per box); Codex needs a localhost browser
callback (effectively impossible per headless box). The user wants provisioned boxes to come
up with working `claude` and `codex` without per-box ritual.

## Approach (decided)

One-time interactive auth on the Tmuxifier host; Tmuxifier seeds each box on request:

- **Claude Code:** the user runs `claude setup-token` once and puts the resulting long-lived
  OAuth token in `.env` as `TMUXIFIER_CLAUDE_OAUTH_TOKEN`. Seeding exports
  `CLAUDE_CODE_OAUTH_TOKEN` on the box. Chosen over copying `~/.claude/.credentials.json`
  because a shared refresh token rotated by many boxes can race; the setup-token is built for
  headless use. (Decision: user, 2026-07-18.)
- **Codex CLI:** seeding copies the Tmuxifier host's live `~/.codex/auth.json` (the documented
  headless pattern — no token equivalent exists). Read fresh at seed time from the service
  user's home; **never stored** in Tmuxifier config or `data/`.

Seeding is **opt-in per provision** via a checkbox — explicit consent per box, matching the
blast-radius reality: these credentials are full account access to the subscriptions.

## Components

### Config (`src/server/config.js`, `envFile`/`.env.example`)

- New optional `TMUXIFIER_CLAUDE_OAUTH_TOKEN` → `config.claudeOauthToken` (string, default
  `null`). No format validation beyond non-empty trim (token shape is Anthropic's business).
- `.env.example` gains a commented placeholder entry. `.env` is already gitignored + `0600`.

### `src/server/aiAuthSeed.js` (new)

Pure builders + a small orchestrator, `knownHosts.js`-style DI:

```js
export function buildClaudeSeedScript()      // stdin = token; writes the rc export line
export function buildCodexSeedScript()       // stdin = auth.json bytes; writes ~/.codex/auth.json
export function createAiAuthSeeder({ runStdin, readLocal, token })
  → { seed(box) : Promise<Array<{ target: 'claude'|'codex', ok: boolean, skipped?: string }>> }
```

- **Secrets travel on stdin only** — never in the script text, never in argv, never logged.
  Same transport as uploads: `boxActions`' `sshRunStdin` over the shared ControlMaster.
- **claude script** (stdin = token):
  - `umask 077`, read stdin into a shell var via `token="$(cat)"`.
  - Delete-then-append a `# tmuxifier-claude-token`-tagged
    `export CLAUDE_CODE_OAUTH_TOKEN=…` line into `~/.profile`, `~/.bashrc`, `~/.zshrc`
    (exact `LOCAL_BIN_PATH_BLOCK` idiom from `boxActions.js`; single-quoted value, token
    itself shell-escaped server-side by rejecting `'` — setup tokens are URL-safe base64ish;
    a token containing `'` is refused with `skipped: 'unsupported token characters'`).
  - If `~/.claude.json` is absent, write `{"hasCompletedOnboarding": true}` so first run
    skips the interactive onboarding wizard (guarded — never overwrite an existing file).
- **codex script** (stdin = file bytes): `umask 077; mkdir -p ~/.codex; cat > ~/.codex/auth.json`
  (mirrors the upload writer; `chmod 600` explicit for pre-existing files).
- **Skip semantics** (per target, non-fatal): claude skipped when `token` is null
  (`'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured'`); codex skipped when the local
  `~/.codex/auth.json` is missing/unreadable (`'no codex auth on the Tmuxifier host'`).
  `readLocal` is injected for tests (defaults to `fs.readFile` of `os.homedir()`-based path).
- rc files on provisioned boxes are typically `0644`: the token line is readable by any local
  user. Accepted — boxes are single-user root LXCs (same posture as `~/.ssh/authorized_keys`
  trust already injected at provision).

### Route (`src/server/server.js`)

`POST /api/boxes/:id/seed-ai-auth`, `preHandler: requireAuth` (plus the existing global
trusted-origin hook). 404 on unknown box; `__local__`/local-shell has no seeding (the host is
already authed) — 400 `'local shell does not need seeding'`. Calls `aiAuthSeeder.seed(box)`
and returns `{ results }` — target/ok/skipped only, **no secret material, no stderr echo**
(stderr may quote script text; return a generic `'seed failed'` reason on nonzero exit).

### UI (`src/web/`)

- Checkbox **"Seed AI CLI auth (claude/codex) from this host"** rendered next to the
  Additional-tools group in both the Proxmox provision form (`proxmoxUi.ts`) and the Add/Edit
  Box modal (`main.ts`). Independent of tool selection (a box may already have the CLIs).
  Title text spells out what it does: copies subscription credentials from the Tmuxifier host.
- Plumbing: `SetupOptions`/`openProvisionPanel` options gain `seedAiAuth: boolean`. After the
  provision terminal exits `0`, the existing `onExit` hook calls
  `api.seedAiAuth(boxId)` and appends a one-line result to the panel/phase text
  (e.g. `auth: claude ✓ · codex skipped (no local auth)`). Ticking only the seed checkbox
  still opens the provision panel (the ensure script is idempotent).
- `api.ts`: `seedAiAuth(id)` fetch helper + result types.

### Wiring (`src/server/index.js`)

`createAiAuthSeeder({ runStdin, token: config.claudeOauthToken })` where `runStdin(box, script,
stdinBytes)` is built on `sshRun.js`'s `sshRunStdin` with the same ControlMaster opts
`boxActions.uploadFile` uses (copy that wiring verbatim — the plan pins the exact call site);
the seeder is injected into `buildServer`.

## Security

- The Claude token lives only in `.env` (gitignored, `0600`) — same class as the password
  hash. It is never returned by any API, never logged, never placed in script text or argv.
- Codex `auth.json` is read fresh from the host home at seed time and exists nowhere in
  Tmuxifier's config or `data/`.
- Per-box copies land `0600` (`umask 077`) under the box user's home.
- Explicit opt-in checkbox per provision; docs state the blast radius plainly: seeded boxes
  hold full-account subscription credentials — seed only boxes you'd trust with your laptop's
  own login.
- Public-repo rules: `.env.example` placeholder only; docs/tests use dummy tokens.

## Testing

Real code, DI fakes, TDD:

- `test/aiAuthSeed.test.js`: script builders (umask/paths/tag lines present; codex script
  byte-shape), seeder skip semantics (no token; missing local auth.json), stdin payload routing
  (fake `runStdin` captures `{script, stdin}` — assert token/file bytes arrive via stdin and
  never appear inside script text), quote-rejection path, real-shell rc idempotency (run the
  claude rc block twice under `/bin/sh` with a scratch HOME — exactly one tagged line survives;
  reuse the existing `runShell` pattern in `test/boxActions.test.js`).
- Route test in `test/server.test.js`: 404, local-shell 400, happy path returns redacted
  results, response never contains the token (assert on serialized body).
- Config test: env var → `claudeOauthToken`, absent → null.

## Out of scope

- Storing codex credentials in Tmuxifier (sealed or otherwise) — live host file only.
- Auto-refresh/rotation management of either credential.
- Seeding other CLIs (gh auth, etc.) — same mechanism could extend later.
- Fleet-wide bulk seeding of existing boxes (could be a Fleet Command later; route is per-box).

## Erratum (2026-07-19)

Two spec details didn't match final-review implementation:

- **Route (`src/server/server.js`)**: the local-shell 400 branch (`'local shell does not need
  seeding'`) was dropped at implementation time — `__local__` is not addressable via
  `/api/boxes/:id` (ids are server-minted, never `__local__`), so the existing 404-on-unknown-box
  path already covers it. There is no dedicated local-shell branch.
- **UI (`src/web/`)**: seeding is not triggered by a provision-terminal exit-`0` hook. It fires
  from the shared server-side setup-job poller (`onJob`) when a job's `status` reaches `done` —
  both in `main.ts`'s `openProvisionPanel` and `proxmoxUi.ts`'s hub Provision tab — reflecting
  the v1.7.9 refactor to poll-based, resumable server-side setup jobs (`setupManager.js`)
  instead of a live provision-terminal WebSocket exit event.
