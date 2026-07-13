# Claude-aware tmux-side upload injection — design

Date: 2026-07-13
Status: approved

## Problem

v1.6.0's terminal file paste injects the uploaded path **client-side**: the browser calls
`term.paste()` after the upload returns, typing the path through the PTY. That works, but it is
blind — it types into whatever the pane is doing (vim, a running build) — and it only happens in
the Tmuxifier browser tab that performed the paste, at the browser layer rather than the tmux
layer.

Inspiration: [jkhas8/tmux-paste-image](https://github.com/jkhas8/tmux-paste-image), a tmux plugin
that saves the clipboard to a file and `tmux send-keys` the path, with a Claude Code mode. It
cannot be used verbatim here: it reads the clipboard of the machine tmux runs on via
`xclip`/`wl-paste` (Tmuxifier's boxes are headless — no display server, no clipboard; the image
lives in the user's browser), and its Claude mode sends a `/image` slash command that **does not
exist** in Claude Code (verified against the current commands/interactive-mode docs; the
documented way to hand Claude Code an image in a prompt is a plain file path). What we adopt is
its good half: tmux-level `send-keys` injection and pane-aware behavior.

## Decisions (settled during brainstorming)

- **Approach: server-side injector (Approach 1 of 3).** The browser remains the clipboard
  bridge — nothing is installed on the user's Mac/Windows machines; clipboard paste works
  natively via the browser in both.
- **Transport unchanged.** Browser paste/drop → `POST /api/upload` → file in
  `~/.tmuxifier-uploads/` (v1.6.0's validation, size limit, 24h prune all stay).
- **Last mile moves server-side.** After the upload lands, the server — over the same
  ControlMaster — captures the box session's active pane, classifies it, and either
  `tmux send-keys` the quoted path or (when the pane is busy) only shows a tmux status message
  with the path. Injection happens at the tmux layer, visible from any attached client.
- **Pane classification: `claude` | `shell` | `busy`.** Claude Code detected via its TUI
  markers (tighter than the plugin's `^>` regex, which false-positives on any `>` prompt);
  a shell detected via trailing prompt characters; anything else is busy → no keystrokes.
- **No auto-Enter.** Both claude and shell modes insert `'<path>' ` (single-quoted + trailing
  space) and leave the user to compose/submit. No `/image`.
- **Classification happens in Node, not in remote sh.** A few cheap round-trips over the
  existing master (capture, then send, then a best-effort status message) instead of one brittle
  sh grep — the classifier becomes a pure, fixture-testable function.
- **Injection failure never fails the upload.** The file is on the box either way; the response
  reports what happened.
- **Non-goals (parked):** the on-box `prefix+P` re-insert binding (possible follow-up),
  auto-submit mode, any Mac/Windows-side tooling, removing the browser transport.
- **Release intent:** once verified, this replaces the v1.6.0 release (user will ask to "blow
  away" v1.6.0 and re-release).

## Design

### New server module: `src/server/tmuxInject.js`

Pure builders + classifier (mirrors the `uploads.js` pattern; uses `sanitizeSession` and
`shSingleQuote` from `sshCommand.js`):

- `classifyPane(text): 'claude' | 'shell' | 'busy'` — input is the last ~25 lines of a pane.
  - **claude** when Claude Code TUI markers appear: a `│ > ` / `│ › ` input-box row between
    `╭─`/`╰─` borders, or footer hints (`esc to interrupt`, `? for shortcuts`,
    `accept edits`, `bypass permissions`, `plan mode`). Any strong marker suffices.
  - **shell** when the last non-empty line ends with a prompt character: `$`, `%`, `#`, `❯`,
    or `>` optionally followed by one space.
  - **busy** otherwise (vim, pagers, running processes, empty capture).
  - Order matters: claude is checked first (its input row would also match the shell rule).
- `buildCapturePaneRemote(session): string` — `tmux capture-pane -p -t '<sess>' | tail -25`
  (session through `sanitizeSession` + `shSingleQuote`; exits 0 with empty output when the
  session is missing — classified busy, so a dead session degrades to message-only… and the
  display-message then also no-ops).
- `buildSendKeysRemote(session, text): string` — `tmux send-keys -t '<sess>' -l -- '<text>'`
  (text through `shSingleQuote`; `-l` = literal, no key-name interpretation).
- `buildDisplayMessageRemote(session, msg): string` — `tmux display-message -t '<sess>' '<msg>'`
  (msg through `shSingleQuote`; caller passes only server-composed strings + the validated
  stored filename).
- `injectionText(path): string` — `'<path>' ` single-quoted with embedded-quote escaping +
  trailing space (the server-side successor of the client's `pathInjection`).

### `boxActions.injectUploadPath(box, session, path)`

New method on `createBoxActions`, using the existing `run` (probe path — BatchMode,
ControlMaster, `assertBoxSafe`):

1. `run(capture)` → `classifyPane(stdout)`.
2. `claude`/`shell` → `run(sendKeys(injectionText(path)))`, then best-effort
   `run(displayMessage("[tmuxifier] image pasted: <name>"))`; returns
   `{ injected: true, mode }`.
3. `busy` → `run(displayMessage("[tmuxifier] image uploaded: <path> (pane busy — not typed)"))`;
   returns `{ injected: false, mode: 'busy' }`.
4. Any ssh/tmux error → `{ injected: false, mode: 'error' }` (upload already succeeded; never
   throw).

### Local shell

The `__local__` terminal runs inside a real local tmux session (default `local`,
`sessions.openLocal`). A small `localInject(session, path)` (same module or `localShellActions`)
runs the identical three scripts via `/bin/sh -c` on the host. Same return contract.

### Route change (`POST /api/upload`)

After a successful upload (box or local), call the matching injector with the box's
`sessionName` (or the local session name) and the returned absolute path. Response becomes:

```
{ path, injected: boolean, mode: 'claude' | 'shell' | 'busy' | 'error' }
```

(Additive change; no consumer depends on the old shape outside `terminal.ts`.)

### Browser changes (`src/web/terminal.ts`, `src/web/upload.ts`, `src/web/api.ts`)

- `terminal.ts` no longer calls `term.paste()` with the path — the injected text arrives
  through the normal tmux attach stream. The dim `[uploading <name>…]` line stays; on
  `injected: false` it writes a yellow info line:
  `[uploaded: <path> — pane busy, not typed]` (termSafe-stripped), so the path is never lost.
- `pathInjection` is removed from `upload.ts` (moved server-side as `injectionText`); its unit
  tests move with it. All other client helpers stay.
- `api.ts` `uploadFile` return type gains `injected`/`mode`.
- Upload batches stay serialized (the promise chain from v1.6.0), so multi-file paste injects
  paths in order, space-separated by the trailing space in each injection.

### Error handling

- Injection errors degrade in order: send-keys failure → try display-message → report
  `mode:'error'`; the client then shows the path locally exactly like the busy case.
- The classifier is deliberately conservative: unknown content is `busy` (never type into an
  unrecognized pane).

### Testing

TDD, real code, no mocks:

- Unit: `classifyPane` against fixture captures — Claude Code screen (input box + footer),
  bash/zsh/root prompts (`$`, `%`, `#`, `❯`), vim screen, running build output, empty pane;
  script builders (session sanitization, quoting, `--` guard); `injectionText` quoting.
- Integration (sshd loopback, extends `test/upload.integration.test.js` patterns): create a real
  tmux session on the loopback box, upload a file through `boxActions.uploadFile` +
  `injectUploadPath`, then `tmux capture-pane` and assert the quoted path appears in the pane
  (shell mode end-to-end); assert the busy path (session running `cat`) does not type and
  returns `injected:false`.
- Route tests (server.test.js): response shape `{ path, injected, mode }` with a stubbed
  injector; injector errors don't fail the upload.

### Docs

- README "Pasting images & files": describe the tmux-side injection, Claude/busy behavior, and
  that the typed path is visible from any attached tmux client.
- CLAUDE.md / AGENTS.md: add `tmuxInject.js`; amend the `uploads.js`/`upload.ts` entries.
