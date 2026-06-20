# Self-Contained `.env` Configuration — Design

**Date:** 2026-06-20
**Status:** Approved

## Goal

Keep Tmuxifier self-contained: configuration that today must live in shell
environment variables (`TMUXIFIER_*`) should instead live in a file **inside the
repo folder**, loaded automatically. No reliance on external shell state to run
the app.

## Current state

`loadConfig()` merges, low → high precedence:

```
defaults  →  config.json (camelCase, cwd)  →  TMUXIFIER_* shell env  →  overrides
```

- `config.json` already lives in the repo and is gitignored — a self-contained
  path technically exists but is under-documented.
- README and `npm run set-password` push **shell env vars** as the primary path,
  which live outside the repo.
- `.env` is gitignored but **nothing reads it**.
- Node is v20.18.1 (native `.env` support available; we use a small parser for
  testability — no new dependencies).

## Design

### 1. Auto-load `.env` from the repo root

New module `src/server/envFile.js` (zero dependencies, pure + testable):

- `parseEnvFile(text) -> object` — handles `KEY=value`, `# comments`, blank
  lines, optional single/double quotes, optional `export ` prefix.
- `readEnvFile(file) -> object` — reads file, returns `{}` if missing/unreadable.
- `upsertEnvFile(file, updates)` — rewrites only the given keys in place,
  preserving other lines and comments; creates the file if absent. Writes the
  file `0o600` (owner-only) since it holds the password hash and cookie secret,
  and chmods an already-existing file to tighten loose permissions.

`loadConfig()` reads `<cwd>/.env` via `readEnvFile` and folds it into the merge.
New precedence (low → high):

```
defaults  →  config.json  →  .env file  →  shell env  →  overrides
```

Shell env still wins (12-factor friendly); `config.json` still works. `.env` is
parsed directly inside `loadConfig` (not mutated into global `process.env`) so
the function stays pure and unit-testable via the existing injectable `cwd`.

Implementation: build `effectiveEnv = { ...dotenvObject, ...env }` and map the
`TMUXIFIER_*` keys from `effectiveEnv`, so shell env overrides the file.

### 2. `npm run set-password` writes `.env` directly

`scripts/hash-password.js` upserts into `<repo>/.env` instead of printing
copy-paste lines:

- Always updates `TMUXIFIER_PASSWORD_HASH`.
- Generates `TMUXIFIER_COOKIE_SECRET` only if not already present (changing the
  password does not silently rotate the secret / log everyone out).
- Preserves any other keys already in `.env`.
- Prints a confirmation, **not** the secret value.

### 3. Committed `.env.example` template

A tracked `.env.example` listing every `TMUXIFIER_*` key with comments and
defaults. `.env` stays gitignored (already is; the `.env` ignore pattern does not
match `.env.example`).

Setup becomes:
```
npm install && npm run build && npm run set-password && npm start
```

### 4. Documentation

- **README**: rewrite Setup + Configuration to lead with `.env`; document
  precedence; keep `config.json` as a documented alternative; drop the
  copy-paste step.
- **CLAUDE.md** (new): architecture overview, config/precedence model, dev/test
  commands, conventions, security notes.
- Historical specs under `docs/superpowers/` are left as point-in-time records;
  this doc is the record for the change.

### 5. Tests

- Unit tests for `parseEnvFile` / `upsertEnvFile`.
- Unit tests for `.env`-precedence in `loadConfig` (file used; shell env
  overrides file; config.json below file).
- Existing e2e (sets env on the spawned process) is unaffected — shell env still
  overrides.

## Out of scope

ssh/pty/session internals, data dir layout, the dashboard UI. Only configuration
entry points and documentation change.

## Decisions

- Shell env **overrides** `.env` (confirmed with user), not the reverse.
- `.env` parsed directly (not via `process.loadEnvFile`) for purity/testability;
  no observable behavior difference at runtime.
