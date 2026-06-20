# Live Provisioning Output — Design Spec

**Date:** 2026-06-20
**Status:** approved

## Goal

When a user adds a new box, show a side panel with a live terminal streaming the
provisioning script output in real time. Auto-close on success; stay open on failure
so the user can see what went wrong.

## Current State

- `POST /api/boxes` runs provisioning synchronously via `sshRun` (buffered `execFile`).
  The client waits for the HTTP response with no progress feedback.
- Interactive terminals use WebSocket + node-pty and stream raw PTY output.
- Provisioning and interactive terminals are two completely separate code paths.

## Design

### Flow

```
User submits "Add Box" form
  → POST /api/boxes validates + stores box, returns { id } immediately (201)
  → Side panel slides out from the right with an xterm.js instance
  → Client opens WebSocket: /term?box=<id>&mode=provision&ohMyTmux=0|1&ohMyZsh=0|1
  → Server spawns provisioning script via node-pty, streams raw output over WS
  → Script finishes:
      - Exit 0: panel shows green check, auto-closes after 2s, refreshes box list
      - Exit ≠ 0: server rolls back box, panel stays open showing error + scrollable output
```

### Server

#### `boxActions.js`

New function `ensureReadyPty(socket, box, options)`:
- Builds the provisioning script via the existing `buildEnsureTmuxRemote()`.
- Runs it through a PTY (not buffered `execFile`), forwarding output to the
  WebSocket as raw text frames — identical to how interactive terminals stream.
- On PTY exit, sends a JSON control frame: `{"t":"x","code":<exit-code>}`.
- Returns a promise that resolves when the PTY exits. If exit code ≠ 0, throws.

#### `sessions.js`

New method `provision(box, script)` alongside the existing `open()`:
- Spawns `ssh -tt <host> <script>` via node-pty — no tmux attach, it runs the
  provisioning script directly.
- Keyed as `provision:<boxId>` to avoid colliding with interactive sessions.
- Uses the same listener/refcount pattern. One-shot: auto-cleans up on PTY exit
  with no grace period. Kills the PTY if the WebSocket closes before completion.

#### `server.js`

- **`POST /api/boxes`:** Simplified — validates + stores the box, returns
  `{ id, ...box }` with 201. No provisioning, no rollback here.
- **`GET /term` WebSocket handler:** Extended to accept `mode=provision` query
  param. When present, reads `ohMyTmux`/`ohMyZsh` flags from the query string,
  calls `sessions.provision()`. On provisioning failure, calls
  `store.removeBox(box.id)` to roll back. Auth and origin checks unchanged.

#### `sshCommand.js`

New `buildProvisionArgv(box, script)`:
- Like `buildProbeArgv` but includes `-tt` (force PTY allocation) so remote
  output streams through node-pty naturally.
- Single-quotes the script string. Same allowlist validation as the rest of the
  SSH surface.

### Client

#### `main.ts` — add-box flow changes

- `POST /api/boxes` returns immediately — extract box ID from the response.
- Call `openProvisionPanel(boxId, options)`:
  - Slides out the side panel div.
  - Creates an xterm.js instance inside it.
  - Opens WebSocket to `/term?box=<id>&mode=provision&cols=120&rows=40&ohMyTmux=...&ohMyZsh=...`.
- On exit frame `{"t":"x","code":0}`: flash green success indicator, auto-close
  panel after 2s, call `refresh()`.
- On exit frame `{"t":"x","code":<non-zero>}`: show red error in panel header,
  keep panel open for inspection. Refresh not called (box was rolled back).

#### `terminal.ts` — provisioning terminal mode

New `ProvisionTerminal` class (or a `readonly` mode on the existing `Terminal`):
- Creates an xterm.js instance in the side panel (not main content area).
- Same fit/addon setup as interactive terminals.
- Parses incoming WebSocket messages: raw text → write to terminal; JSON with
  `t: "x"` → emit completion callback with exit code.
- Does NOT send resize or input frames (provisioning is read-only).

#### HTML / CSS — side panel

- `<div id="provision-panel">` slides in from the right (~500–600px wide, full
  height). Dark background matching the terminal aesthetic.
- Header bar: title "Provisioning <label>" + close button (×). Close button
  only functional on error; on success the panel auto-closes.
- xterm.js container fills the panel body.
- The main dashboard/content area resizes or is partially obscured — the panel
  overlays from the right.

### WebSocket Protocol Extension

Add one new server-to-client message type, sent as a JSON text frame:

```json
{"t":"x","code":0}
```

| Field | Type | Meaning |
|-------|------|---------|
| `t`   | `"x"` | Exit — provisioning is complete |
| `code` | number | Exit code of the remote script (0 = success) |

The client distinguishes control frames from terminal data by attempting
`JSON.parse()`. Terminal data (ANSI escape sequences and text) will never
parse as valid JSON with `t: "x"`.

### Error Handling & Edge Cases

| Scenario | Behavior |
|----------|----------|
| WebSocket fails to connect | Show "Connection failed" in the panel, keep it open |
| WebSocket drops mid-provisioning | Server kills the PTY; panel shows "Connection lost", stays open |
| User closes panel mid-provisioning | WebSocket closes → server kills PTY. Box may be left in an inconsistent state (tmux partially installed). Acceptable — the user chose to cancel. Box remains in the list and can be removed or re-provisioned manually |
| User navigates away mid-provisioning | Same as closing the panel |
| Provisioning times out | Server kills PTY after timeout (configurable, default 120s). Sends `{"t":"x","code":124}` (timeout exit code). Panel stays open |
| Box already provisioned | `ensureReady` is idempotent — the script checks for existing tmux/session and skips. Output still streams |
| SSH auth failure during provisioning | PTY exits with SSH's error output visible in the panel. Box is rolled back |

### Non-Goals

- No cancel button in the panel (beyond closing it)
- No progress percentage or structured progress parsing from the script
- No resumability — closing mid-provisioning leaves the box as-is
- No changes to the provisioning script content itself

### Files Touched

| File | Change |
|------|--------|
| `src/server/boxActions.js` | Add `ensureReadyPty()` |
| `src/server/sessions.js` | Add `provision()` method |
| `src/server/server.js` | Simplify `POST /api/boxes`; extend `/term` WS handler for provision mode |
| `src/server/sshCommand.js` | Add `buildProvisionArgv()` |
| `src/web/main.ts` | New add-box flow, `openProvisionPanel()`, panel lifecycle |
| `src/web/terminal.ts` | New `ProvisionTerminal` class or mode |
| `src/web/api.ts` | Update `addBox()` return type |
| `src/web/index.html` | Add provision panel markup |
| `src/web/style.css` | Side panel styles |
| `test/` | New tests for provision PTY lifecycle, WS protocol, rollback on failure |
