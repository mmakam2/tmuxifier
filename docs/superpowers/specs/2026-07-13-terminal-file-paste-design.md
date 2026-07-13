# Terminal file paste & drop upload — design

Date: 2026-07-13
Status: approved

## Problem

Pasting an image into a CLI tool (Claude Code, Codex) works on a local Mac because the CLI reads
the OS clipboard of the machine it runs on. In Tmuxifier the CLI runs on the remote box, and the
whole path from browser to box — xterm.js → WebSocket → PTY → `ssh` → tmux — is a text byte
stream: keystrokes only. A clipboard image or a dropped file never crosses it, so the only way to
show a screenshot to a remote Claude session today is a manual `scp` plus pasting the path.

## Decisions (settled during brainstorming)

- **Scope: paste + drag-drop, any file.** Ctrl/Cmd+V with a file/image on the clipboard uploads
  it; dragging any file onto the terminal uploads it. Text paste is untouched.
- **Landing spot: `~/.tmuxifier-uploads/` on the target**, filenames uniquified, original name
  preserved. Age-based cleanup: each upload opportunistically deletes files older than 24h in
  that dir. No server-side tracking state.
- **Size limit: 25 MB default**, configurable via `TMUXIFIER_UPLOAD_MAX_MB`.
- **Local shell too:** uploads to the `__local__` terminal write to `~/.tmuxifier-uploads` on the
  Tmuxifier host directly (no SSH), same UX.
- **Transport: dedicated HTTP endpoint** (`POST /api/upload`) with a raw
  `application/octet-stream` body — not WebSocket binary frames (keeps the keystroke hot path
  simple), not `@fastify/multipart` (no new dependency; buffering ≤25 MB is fine for a
  single-user tool). Rides existing cookie auth, origin check, and Fastify `bodyLimit`.
- **Path injection:** after upload the client injects the single-quote-escaped absolute remote
  path plus a trailing space into the PTY via the normal paste path (bracketed paste honored) —
  the same convention terminals use for drag-drop, which Claude Code/Codex parse as a file
  reference. Multiple files upload sequentially and inject space-separated paths.
- **Only the interactive terminal** (`openTerminal`) gets the hook — not the provision terminal.

## Design

### Browser (client) layer

- `src/web/upload.ts` (new, pure — mirrors `clipboard.ts`): extract files from a `DataTransfer`
  / `clipboardData.items`; generate the pasted-image filename (`pasted-<timestamp>.<ext>` from
  the blob MIME type — pasted screenshots have no name); client-side size pre-check against the
  configured limit; build the injected path string (always single-quoted, embedded quotes
  escaped, + trailing space — unconditional quoting keeps the rule simple and safe).
- `src/web/api.ts`: `uploadFile(boxId, name, blob)` → `fetch` POST, returns `{ path }` or a
  typed error.
- `src/web/terminal.ts` (`openTerminal` only): wire a `paste` listener on the terminal element —
  if the clipboard payload contains files, `preventDefault` and upload; if text-only, do nothing
  (today's path runs untouched). Wire `dragover`/`drop` on the terminal container for file
  drops. During an upload write a dim `[uploading <name>…]` status line; on success inject the
  path; on failure write a yellow `[upload failed: <reason>]` line locally (session unaffected).
- The limit reaches the client through the existing `GET /api/ui-config` payload.

### Server layer

- Route: `POST /api/upload?box=<id|__local__>&name=<filename>`, `preHandler: requireAuth`,
  per-route `bodyLimit` = configured max, and a route-scoped `application/octet-stream` raw-body
  content-type parser.
- Filename validation (server-side, pure function): basename only — no `/`, no leading `-`, not
  `.`/`..`, non-empty, length-capped, conservative character allowlist. Stored name is
  uniquified: `<epoch>-<random>-<name>`.
- Box target: new `uploadFile(box, name, buffer)` in `boxActions.js`, built on a new
  `sshRunStdin(argv, input, { timeout })` helper in `sshRun.js` (spawn `ssh` and write the
  buffer to stdin; `execFile` can't stream stdin). Remote command, with the path through the
  existing `shSingleQuote` and the argv through `buildProbeArgv`/`assertBoxSafe`:
  `mkdir -p` the dir → `find <dir> -mmin +1440 -delete` (opportunistic 24h prune, best-effort)
  → `cat > <dir>/<uniquified-name>` → echo the resolved absolute path (so the client never
  guesses `$HOME`). Runs over the existing ControlMaster — no second SSH auth.
- Local target (`box=__local__`): write the file under `~/.tmuxifier-uploads` on the host with
  plain `fs` (0o600), same prune rule, return the absolute path.
- Response: `{ path: "<absolute path on target>" }`.

### Config

- `TMUXIFIER_UPLOAD_MAX_MB` (default 25), parsed in `config.js` like other numeric knobs,
  surfaced via `GET /api/ui-config`. Server `bodyLimit` is the real enforcement; the client
  check just gives a friendly early error.

### Error handling

- Client: oversized file rejected before any bytes move.
- Server: 400 bad filename/unknown box, 413 over limit, 502 with an stderr excerpt when the ssh
  write fails (box down, disk full, needs auth).
- All failures print as the yellow terminal line; the live session is never interrupted. The
  upload uses its own ssh invocation, so a slow/failed upload never stalls keystrokes.
- Same-name concurrent uploads can't collide (uniquified stored names).

### Testing

TDD, real code, no mocks:

- Unit: `upload.ts` pure helpers (file extraction, pasted-image naming, size check, path
  quoting/injection string); server-side filename validator and remote-command builder;
  `config.js` knob parsing.
- Integration: the route against the existing sshd-backed test helper — upload lands with the
  right content, response path is absolute and correct, files older than 24h are pruned on the
  next upload, oversized body → 413, bad filename → 400. Local-shell variant against a temp
  `$HOME`.
- E2E (optional, not required to ship): Playwright drop test.

### Docs

- README: short "Pasting images & files" section (what works, where files land, the size knob).
- CLAUDE.md / AGENTS.md: module lists gain `upload.ts` and the new server pieces.
