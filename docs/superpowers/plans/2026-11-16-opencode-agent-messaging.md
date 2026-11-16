# OpenCode Agent Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode sessions send, receive and are woken by Tmuxifier agent mail with the same guarantees Claude Code sessions have.

**Architecture:** The existing OpenCode state plugin (`src/server/assets/tmuxifier-opencode-agent.js`, one ESM file running inside `opencode serve`) gains a mail part: per eligible tmux pane it holds `GET /v1/wait` on `~/.tmuxifier-mail/sock`, wakes the mapped OpenCode session with `ctx.session.synthetic` (`queue` + `resume`), and acks on delivery. Plugin hooks give each shell command its caller's pane (`TMUXIFIER_MAIL_PANE`), allow plain `tmx` unless the operator has bash rules, and add the mail skill. Setup installs `tmx` and the skill file on boxes with Claude Code **or** OpenCode. Hub, listener, store, forward and wire format are unchanged.

**Tech Stack:** Node ESM (server, plugin asset: node builtins only, also run by OpenCode's embedded Bun), POSIX sh (`tmx`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-opencode-agent-messaging-design.md` (read it first; section numbers below are its own).

## Global Constraints

- Plugin asset: plain ESM, node builtins only, no imports from the repo, nothing at module load, **nothing may throw out of any handler, hook or timer into OpenCode**; every entry point wrapped like the existing ones (`debug()` only under `TMUXIFIER_OPENCODE_DEBUG`).
- Plugin timestamps written to markers stay epoch **seconds**; the mail part's timers use milliseconds internally.
- First verified OpenCode version: `2.3.0` (constant `OPENCODE_MAIL_MIN = '2.3.0'`); below it the mail part is inert.
- Wake call: `synthetic({ sessionID, text, delivery: 'queue', resume: true, metadata: { tmuxifierMail: '<m-id>' } })`. Never `steer`.
- Re-offer fallback = the hub's `REOFFER_MS` = `600_000` ms. Socket backoff: 30 s doubling to 30 min.
- Identity variable: `TMUXIFIER_MAIL_PANE`, value a pane id `%N` (≤ 9 digits) or the literal `none`.
- Message ids: `m-` + 8 chars of `abcdefghjkmnpqrstuvwxyz23456789` (`MSG_ID_RE` in `agentMailStore.js`; the asset keeps its own copy, pinned equal by a test).
- Hub delivery rules, listener wire format, store, policy and forward stay unchanged.
- No real hostnames, IPs, box names or emails in any committed file (public repo): fixtures use `/home/user`, `proj`, `proj2`; docs say "a test box".
- Tests use real code (real listener on a real unix socket, real hub via `test/helpers/agentMailHarness.js`, the real `tmx` script); only OpenCode's `ctx` is faked, and its fake emits events copied from the 2.3.0 recording.
- Never run `npm run build` in the main checkout; build only in this worktree.
- Conventional commits, each ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The tmux session is renamed while its pane waits** → the old wait is aborted on the next sync and a new one names the new session; no mail is acked under the old name. Test in Task 6.
2. **Messaging switched off, or Tmuxifier restarts, mid-wait** (socket removed or listener closed) → the pane backs off (30 s doubling), never a reconnect loop; it re-arms when the socket answers again. Test in Task 6.
3. **The OpenCode server restarts with one of our synthetic items still queued** → the new core adopts the item by `metadata.tmuxifierMail`, acks it on delivery and posts no second synthetic for that message. Test in Task 6.
4. **The TUI exits (pane back to a shell) after the synthetic was posted but before delivery** → no new wait for that pane, but the already-posted item is still acked when OpenCode delivers it. Test in Task 6.
5. **A home directory whose socket path exceeds 107 bytes** (`MAX_SOCKET_PATH_BYTES`) → the mail part stays inert with one debug line, no throw, no retry loop. Test in Task 5.

---

### Task 1: Record OpenCode 2.3.0 and write down the facts the mail part depends on

This is a live task on the OpenCode test box (the operator gives the host; never commit it). Every later task reads its README's **Facts** table.

**Files:**
- Create: `test/fixtures/tools/opencode-recorder.js` (the throwaway V2 recorder, committed so the recording can be redone)
- Create: `test/fixtures/opencode-2.3-event-trace.jsonl`
- Create: `test/fixtures/README-opencode-2.3-event-trace.md`

**Interfaces:**
- Produces: the fixture (one JSON object per line, same `kind` scheme as `opencode-event-trace.jsonl`: `event`, `hook.<name>`, `plugin.*`, plus `kind: "probe.<name>"` for results of the recorder's own API calls) and a README with a **Facts** table F1–F10 (below), each answered with fixture line numbers.

- [ ] **Step 1: Write the recorder.** `default { id: 'tmuxifier-recorder', setup(ctx) }` appends to `$TMUXIFIER_RECORD_FILE`: every `ctx.event.subscribe()` event; the hooks `ctx.tool.hook` `execute.before`/`after`, `ctx.shell.hook` `create.before`, `ctx.permission.hook` `evaluate`, `ctx.session.hook` `prompt` and `experimental.idle` (each logged, never modified); `plugin.setup` with `ctx.location` and `Object.keys(ctx)`. It exposes probes triggered by touching files in `$TMUXIFIER_RECORD_DIR/probe/` (`synthetic-<sessionID>`, `skill-add`), logging the call's input and resolved value or error.
- [ ] **Step 2: Run it isolated from the operator's own OpenCode.** Separate `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` under a temp dir, its own tmux server (`tmux -L rec`), so the operator's `opencode serve` and sessions are untouched. If OpenCode cannot run a second server that way, stop and ask the operator before using their server. Model: whatever free model the box's OpenCode offers.
- [ ] **Step 3: Drive the scenarios** with `tmux -L rec send-keys`: (a) plain turn; (b) permission ask → once / reject; (c) question form; (d) ctrl+b background shell; (e) second TUI in `proj2`; (f) second TUI in the same `proj`, and switching sessions in a TUI; (g) synthetic `queue`+`resume` on an idle session, on a busy one, and while a permission prompt is open; (h) the agent runs `tmx who`, `tmx reply t-aaaaaaaa "x"`, `tmx reply t-aaaaaaaa "$(env)"`, `tmx who; id` (a stub `tmx` on PATH that prints its argv); (i) two TUIs in `proj` and `proj2` running a bash command at the same moment; (j) `skill-add` probe, then ask the agent which skills it has; (k) restart the server with a queued synthetic item.
- [ ] **Step 4: Scrub** exactly as the 2.2.6 README does (home → `/home/user`, dirs → `/home/user/proj`, `/home/user/proj2`; ids and timestamps kept) and run `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'` on the fixture (expect no output).
- [ ] **Step 5: Write the README**: scenario/line table like the 2.2.6 one, and the **Facts** table:
  - F1 `synthetic`'s return value and the `inbox.enqueued`/`inbox.delivered`/`inbox.cancelled` events for our item: which fields carry the item id and our `metadata`.
  - F2 when `session.viewed` fires (TUI start, session switch, every turn?) and its payload.
  - F3 `permission.evaluate` `action`/`resources` for each command in (h), and whether OpenCode already denies/asks.
  - F4 order and fields of `tool.execute.before` vs `shell.create.before` for one call and for (i); whether anything in `create.before` names the call or session.
  - F5 whether a hook registered in one directory's `setup` fires for another directory's sessions, and whether `synthetic` through `proj`'s `ctx` reaches a `proj2` session.
  - F6 whether a skill added through `ctx.skill.transform` is listed to and invocable by the agent; else which skills directory 2.3.0 reads.
  - F7 which config files 2.3.0 merges for permissions (global and project names, `.jsonc`, `.opencode/`).
  - F8 every event type in the trace the 2.2.6 reducer does not handle, and whether `session.status`/`session.idle` now fire.
  - F9 whether a restarted server replays a queued item, and whether its event carries our `metadata`.
  - F10 what a `queue` synthetic does while a permission prompt or question form is open.
- [ ] **Step 6: Commit** `test(fixtures): record OpenCode 2.3.0 events for agent mail`.

### Task 2: The state plugin reads 2.3.0 correctly

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (reducer: `RELEVANT`, `applyUnsafe`, `STATE_VERSION` if the session shape changes)
- Create: `test/opencodeAgentReplay23.test.js`

**Interfaces:**
- Consumes: Task 1 fixture and F8.
- Produces: unchanged exports; `STATE_VERSION` bumped to `2` only if `newSession`'s shape changes here.

- [ ] **Step 1: Write the failing replay test** modelled on `test/opencodeAgentReplay.test.js` (same helper style): replay every `kind: "event"` line through `createReducer` + `foldForPanes`, asserting the marker per scenario from the README's table, e.g. after (b)'s `permission.asked` line → `blocked/permission`; after its reject → `ready/stop`; during (d)'s background shell after `execution.succeeded` → `working`; (g)'s idle synthetic → `working/resume` then `ready/stop`.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentReplay23.test.js`; expect the failures F8 predicts (if it passes outright, record that in the commit message and keep the test).
- [ ] **Step 3: Fix the reducer** for each F8 difference. Keep the 2.2.6 replay green.
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js`; expect all PASS.
- [ ] **Step 5: Commit** `fix(opencode): read OpenCode 2.3.0 events`.

### Task 3: Operator evidence and mail targets (pure)

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js`
- Create: `test/opencodeAgentMailTargets.test.js`

**Interfaces:**
- Produces:
  - `newSession` gains `evidenceAt: 0` (epoch s of the newest `session.viewed` or `user` inbox item); bump `STATE_VERSION`.
  - `PANE_FORMAT` gains a sixth field `#{pane_id}`; `parsePanes` rows gain `pane` (must match `/^%\d{1,9}$/`, else the row is dropped).
  - `mailTargets(reducer, panes, since) → Map<tmuxSession, { pane: string, sessionID: string, dir: string }>` implementing spec 6.3 rules 1–3 (rule 4, `ready`, is checked by Task 6). A tmux session is absent from the map when it has no target or is ambiguous.

- [ ] **Step 1: Write failing tests**:
  - `evidence: session.viewed and a user inbox item set evidenceAt; a synthetic item does not` (assert `sessions.get(id).evidenceAt` equals the event's `created/1000` floor).
  - `a pane with only persisted, unviewed sessions in its directory has no target`.
  - `the newest evidence since hosting wins among root sessions in the directory`; evidence older than `since.get(session)` does not count; child sessions never targets.
  - `two tmux sessions hosting opencode in one directory: neither is in the map`, including when the second TUI is in a non-active window or pane.
  - `different directories on one box: each tmux session maps to its own session`.
  - `parsePanes drops a row whose pane id is not %N` and keeps `pane` otherwise; the 2.2.6 fold tests still pass with the 6-field format.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentMailTargets.test.js` → FAIL (`mailTargets` not exported).
- [ ] **Step 3: Implement** `evidenceAt` in `applyUnsafe` (`session.viewed` per F2 payload; `session.inbox.enqueued` with `item.type === 'user'`), the pane field, and `mailTargets` reusing `dirExact`/`dirUnder`/`isOpencodeCmd`. Ambiguity is decided over **all** panes running opencode (hosting), not only active ones.
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(opencode): map tmux panes to OpenCode sessions for mail`.

### Task 4: A mail wake reads like Claude's

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`applyUnsafe`: `session.inbox.enqueued`, `session.execution.started`)
- Modify: `test/opencodeAgentReducer.test.js`

**Interfaces:**
- Produces: sessions gain `mailWake: boolean` (set by an enqueued item whose metadata, per F1/F9, has `tmuxifierMail` matching `MAIL_MSG_ID_RE`); exported `MAIL_MSG_ID_RE = /^m-[abcdefghjkmnpqrstuvwxyz23456789]{8}$/`.

- [ ] **Step 1: Write failing tests** using event shapes copied from the Task 1 fixture:
  - `a mail wake on an idle session reads working/resume, then ready/stop`.
  - `a mail wake never clears a running background shell` (shell from (d) still holds `working` after the wake's turn ends).
  - `a mail wake while blocked stays blocked/<cause>` until the block's own reply.
  - `MAIL_MSG_ID_RE agrees with the store's MSG_ID_RE`: on 50 ids minted by `createAgentMailStore` and on near misses (7 and 9 chars, each excluded letter `i l o 0 1`, upper case, `t-` prefix) both regexes return the same answer.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentReducer.test.js` → FAIL.
- [ ] **Step 3: Implement**: a mail-wake inbox item sets `lastInbox = 'synthetic'` (so the turn's cause is `resume`) and touches no `shells`/`blocks`; `blocked` already outranks `working` in `deriveState`, so only verify.
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(opencode): treat a mail wake as a resume`.

### Task 5: Mail socket client inside the asset

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js`
- Create: `test/opencodeAgentMailClient.test.js`

**Interfaces:**
- Produces: `createMailSocketClient({ sockPath, request = http.request }) → { wait({ session, pane, signal }) → Promise<{ kind: 'mail', text: string, messageId: string } | { kind: 'idle' } | { kind: 'down', reason: string }>, ack({ session, messageId }) → Promise<boolean> }`. `sockPath` longer than 107 bytes → every call resolves `{ kind: 'down', reason: 'path' }` / `false` without connecting. `messageId` is parsed from the wake text's first line `[tmuxifier-mail <m-id>]` and checked with `MAIL_MSG_ID_RE`; a 200 whose first line does not parse is `down`. Never rejects.

- [ ] **Step 1: Write failing tests** against a real `createAgentMailListener` on a temp socket over `createMailHarness()` (as `test/agentMailTmx.test.js` does): `wait` returns `idle` on 204 after a short `holdMs`; returns `mail` with the right `messageId` when `b` sends to the waiting session with its marker `ready`; `ack` → `true`, the store's message reads `delivered`; a second `ack` → `false`; aborting `signal` ends the request and the hub reports the waiter gone; absent socket → `down`; a 108-byte `sockPath` → `down`/`path` with no connect attempt (spy on `request`).
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentMailClient.test.js` → FAIL.
- [ ] **Step 3: Implement** with `http.request({ socketPath, path, method })`, form-encoded `POST /v1/ack` (`session`, `m`), query-string `GET /v1/wait?session=&pane=` (URLSearchParams), body cap 256 KiB.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(opencode): agent-mail socket client in the plugin`.

### Task 6: The mail part of the core

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`createMailPart`, wired into `createCore`, `attach`, `handle`, `abort`, `takeOver`)
- Create: `test/opencodeAgentMail.test.js`

**Interfaces:**
- Consumes: `mailTargets` (Task 3), `reducer.derive` (existing), `createMailSocketClient` (Task 5), `MAIL_MSG_ID_RE` (Task 4).
- Produces: `createMailPart({ home, client, synthetic: (sessionID, input) => Promise<{ id?: string }>, now = Date.now, setTimeout, clearTimeout }) → { sync(targets: Map, derive: (sessionID) => state|null): void, onEvent(event): void, abort(): void, state: { inflight: Map<m-id, { sessionID, tmuxSession, itemId|null, postedAt }> } }`. `createCore` gains option `mail` (default: a mail part over `~/.tmuxifier-mail/sock` when `home` is set; `null` disables it), calls `mail.sync` after every sweep's fold, `mail.onEvent` in `handle`, `mail.abort` in `abort`; the core exposes the part's `state` as `core.mailState`, and `takeOver` passes `prev.mailState` to the next core's mail part. `synthetic` is supplied by Task 9; until then `createCore` takes it as an option.

- [ ] **Step 1: Write failing tests** with the real listener + harness, a fake `synthetic` that records its calls and returns `{ id: 'msg_test1' }`, and events shaped from the fixture (F1):
  - `an eligible ready pane holds one wait; the hub lists the session as listening`.
  - `mail → synthetic called once with { sessionID, text, delivery: 'queue', resume: true, metadata: { tmuxifierMail } }`.
  - `inbox.delivered for that item → ack; store reads delivered; only then a new wait connects` (assert the hub saw no second wait for that pane before the ack).
  - `inbox.cancelled → no ack; message re-offered to the next wait`.
  - `synthetic rejects → no ack; that pane backs off; message re-offered`.
  - `no delivery event within REOFFER_MS (fake clock) → re-arm`.
  - `a pane that stops being eligible has its wait aborted` (target lost, ambiguity appears, state not ready).
  - Review Focus 1: `tmux session renamed → old wait aborted, new wait under the new name`.
  - Review Focus 2: `socket removed / listener closed → backoff 30 s, 60 s …, capped 30 min; no request in between; re-arms when it answers`.
  - Review Focus 3: `a takeOver core adopts an in-flight item by metadata and acks it on delivery; an inbox.enqueued replay carrying a known m-id posts no second synthetic`.
  - Review Focus 4: `pane gone after synthetic, before delivery → still acked on delivery, no new wait`.
  - `abort() ends every held wait and arms nothing`.
  - `nothing throws`: `synthetic` throwing synchronously, `client.wait` rejecting, malformed events → `handle`/`sync` return normally.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentMail.test.js` → FAIL.
- [ ] **Step 3: Implement** spec 6.2–6.4: per tmux session one pane record `{ pane, sessionID, ac, phase: 'idle'|'waiting'|'posted'|'backoff', retryAt }`; `sync` starts a wait only for targets whose `derive(sessionID).state === 'ready'`, aborts records whose target changed or vanished; on `mail` re-check eligibility+ready, else drop (no ack); messaging-on test is the socket answering (`down` → backoff).
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js test/agentMail*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(opencode): wake OpenCode sessions with agent mail`.

### Task 7: Each shell command knows its pane

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`createPaneTagger`)
- Modify: `src/server/assets/tmuxifier-mail.sh` (`in_tmux`, `session_now`)
- Create: `test/opencodeAgentPaneTag.test.js`
- Modify: `test/agentMailTmx.test.js`

**Interfaces:**
- Consumes: the current `mailTargets` map (Task 3) via a getter.
- Produces: `createPaneTagger({ paneOf: (sessionID) => string|null, now = Date.now, ttlMs = 30000 }) → { beforeTool(payload): void, beforeShell(payload): void }` per spec 6.9 and F4. `beforeTool` records bash calls (`payload.tool` per F4, command from `payload.input`); `beforeShell` sets `payload.env.TMUXIFIER_MAIL_PANE` to the pane or `'none'`. Records expire after `ttlMs`.
- `tmx`: when `TMUXIFIER_MAIL_PANE` is set it replaces `TMUX_PANE` for identity (same `%N` check); `none` → every user command prints `tmx: this agent's tmux session cannot be identified for messaging` to stderr and exits 2. `hook-wait`/`hook-ack` ignore the variable.

- [ ] **Step 1: Write failing tests**: tagger — one call → pane; unknown session → `none`; no matching record → `none`; two pending identical commands for different panes → `none` for both; records expire; never throws on a malformed payload. `tmx` (real script, real listener): `TMUXIFIER_MAIL_PANE=%3` with `TMUX_PANE=%9` acts as `%3`'s session; `none` → exit 2 and the message; unset → today's behaviour (existing tests stay green).
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentPaneTag.test.js test/agentMailTmx.test.js` → FAIL.
- [ ] **Step 3: Implement** both sides. If F4 shows `create.before` names the call or session, correlate by that instead of command text and keep the same tests.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mail): name the calling pane for OpenCode's shell commands`.

### Task 8: Plain `tmx` is allowed unless the operator has bash rules

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`isPlainTmx`, `readJsonc`, `createOperatorRules`, `createPermissionHandler`)
- Create: `test/opencodeAgentPermission.test.js`

**Interfaces:**
- Produces:
  - `isPlainTmx(command: string) → boolean`: true only for one command whose program is `tmx`, `~/.local/bin/tmx` or `$HOME/.local/bin/tmx`, subcommand in `who|send|reply|wait|read|inbox`, and no `$(`, backtick, `|`, `;`, `&`, `>`, `<`, newline.
  - `readJsonc(text) → object|null` (comments and trailing commas tolerated, `null` on any parse failure).
  - `createOperatorRules({ home, env, fs = node:fs }) → { hasBashRules(dir: string) → boolean }`: the files F7 lists (global via `OPENCODE_CONFIG_DIR` or `~/.config/opencode/`; project `opencode.json[c]` and `.opencode/` under `dir`), cached by mtime; true if any sets `permission.bash` (string or object) or a top-level `permission` string, for any agent; true on an unreadable or unparseable file.
  - `createPermissionHandler({ rules, dirOf: (sessionID) => string|null }) → (evaluation) => void`: sets `evaluation.effect = 'allow'` only when the action and resources are the bash tool running a plain `tmx` (shape per F3), the current effect is not `deny`, and `!rules.hasBashRules(dir)`.

- [ ] **Step 1: Write failing tests**: `isPlainTmx` true for `tmx who`, `tmx reply t-aaaaaaaa "done, 3 tests pass"`, `~/.local/bin/tmx inbox`; false for `tmx reply t "$(env)"`, `` tmx reply t `id` ``, `tmx who; id`, `tmx who | cat`, `tmx who && id`, `tmx who > f`, `tmxx who`, `echo tmx who`, `tmx rm`. `readJsonc` parses a commented `.jsonc` with trailing commas; returns null for garbage. Rules: no files → false; global `{"permission":{"bash":"ask"}}` → true; project `.opencode/opencode.jsonc` with `bash` patterns → true; an agent-scoped bash rule → true; unparseable → true; editing the file flips the answer without a new instance. Handler: plain `tmx` with no rules → `allow`; with rules → unchanged; current `deny` → unchanged; `$(env)` → unchanged; never throws on a malformed evaluation.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentPermission.test.js` → FAIL.
- [ ] **Step 3: Implement.** Match the bash command from F3's `resources` (if OpenCode splits a compound command into several resources, any resource other than one plain `tmx` makes it not plain).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(opencode): allow plain tmx unless the operator set bash rules`.

### Task 9: Register hooks and the skill per directory

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`createRegistry`, the default export's `setup`, `takeOver`)
- Create: `test/opencodeAgentRegistry.test.js`
- Modify: `test/opencodeAgentPlugin.test.js` (hand-over cases)

**Interfaces:**
- Consumes: Tasks 6–8's `createMailPart`, `createPaneTagger`, `createPermissionHandler`.
- Produces: `createRegistry({ home, core }) → { add(ctx): void, synthetic(sessionID, input): Promise, dispose(): void }`. `add` keys `ctx` by `ctx.location.directory`; when `typeof ctx.session?.synthetic !== 'function'` or `ctx.app?.version` is below `OPENCODE_MAIL_MIN`, the mail part stays off for the whole core. It registers on that ctx `ctx.tool.hook` `execute.before` → tagger, `ctx.shell.hook` `create.before` → tagger, `ctx.permission.hook` `evaluate` → handler, each deduplicated by call/request id (F5), and the skill: reads `~/.tmuxifier-mail/SKILL.md` and adds it via `ctx.skill.transform(editor => editor.add({ id: 'tmuxifier-mail', name: 'tmuxifier-mail', description, path, content }))` with `description` from the file's front matter (or, if F6 says so, nothing here: Task 10 writes the skills directory). `synthetic` calls through the ctx of the session's directory, falling back to any. `dispose` disposes every `Registration`. `setup(ctx)` → `takeOver` then `registry.add(ctx)` for this and every later setup; the old core's registry is disposed in `takeOver`.

- [ ] **Step 1: Write failing tests** with a fake ctx per directory that records registrations and exposes `fire(hookName, payload)`: two setups → hooks registered on both ctxs, one effect per call id even when both fire; `synthetic` for a `proj2` session goes through `proj2`'s ctx; `ctx.session.synthetic` missing or `ctx.app.version = '2.2.6'` → no mail wait is ever made, state markers still written; hand-over disposes the old registrations and re-registers; a throwing `ctx.skill.transform` leaves the plugin running; `SKILL.md` absent → no skill, no throw.
- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentRegistry.test.js test/opencodeAgentPlugin.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(opencode): register mail hooks and skill per directory`.

### Task 10: Setup installs mail for OpenCode boxes

**Files:**
- Modify: `src/server/claudeAgentMail.js` (`buildAgentMailInstallScript`, `createAgentMailPusher` result parsing)
- Modify: `src/server/setupManager.js:259` (gate)
- Modify: `src/server/opencodeAgentPlugin.js` (version note)
- Modify: `test/claudeAgentMail.test.js`, `test/opencodeAgentPlugin.pusher.test.js`, the setup-manager test that covers phase gating (find it with `grep -l "agent-mail" test/setup*.test.js`)

**Interfaces:**
- Produces: install script detects `claude` (as today) and `opencode` (`command -v opencode` or `$HOME/.opencode/bin/opencode`); neither → `AGENTMAIL: skipped-no-agent` (result `skipped: 'no Claude Code or OpenCode on the box'`, replacing `skipped-no-claude`); with either it installs `tmx`, the `~/.local/bin/tmx` link and `~/.tmuxifier-mail/SKILL.md` (the same skill bytes, by rename); the Claude skill dir, `settings.json` merge and `autoMode` run only with `claude`; OpenCode-only prints `AGENTMAIL: opencode-only` → ok with `note: "OpenCode's part arrives with the OpenCode plugin"`. If F6 chose a skills directory, the script also writes it there when `opencode` is present. `setupManager` runs the phase when tools include `claude` or `opencode` (or the legacy `claudeStatusline` flag). The OpenCode pusher's script prints `OPENCODEPLUGIN: version <v>`; below `OPENCODE_MAIL_MIN` the result carries `note: 'agent messaging needs OpenCode 2.3.0 or later'`.

- [ ] **Step 1: Write failing tests** (run the real scripts under `sh`, `bash` and `zsh` with a temp HOME and stub binaries, as the existing tests do): Claude only → unchanged behaviour and settings; OpenCode only → `tmx`, link and `SKILL.md` present, no `~/.claude` created, note; both → everything; neither → skipped, nothing written; foreign `tmx` → still skipped; setupManager runs `agent-mail` for `tools: ['opencode']`; OpenCode 2.2.6 stub → note, 2.3.0 → none.
- [ ] **Step 2: Run** `npx vitest run test/claudeAgentMail.test.js test/opencodeAgentPlugin.pusher.test.js` plus the setup test → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS (if `test/voiceWriter.test.js` "two writers started at once" fails alone in the full run, rerun it by itself; it is the known flake #17).
- [ ] **Step 5: Commit** `feat(setup): install agent mail on OpenCode boxes`.

### Task 11: Docs

**Files:**
- Modify: `docs/agent-messaging.md` (receivers: Claude Code and OpenCode ≥ 2.3.0; setup; the limits from spec §8; the permission rule and the operator-rules exception; `TMUXIFIER_MAIL_PANE`), `docs/boxes-and-setup.md` (phase text), `CLAUDE.md` and `AGENTS.md` (the `opencodeAgentPlugin.js` and `claudeAgentMail.js` bullets, the agent-mail load-bearing rule now names OpenCode's waiter), `test/fixtures/README-opencode-2.3-event-trace.md` cross-links.

- [ ] **Step 1: Edit** the docs; keep CLAUDE.md and AGENTS.md identical in the changed bullets.
- [ ] **Step 2: PII scrub** the staged diff as CLAUDE.md's shipping checklist says (no real domains, IPs, hostnames, box names or emails; the operator's own patterns stay outside the repo).
- [ ] **Step 3: Commit** `docs: agent messaging with OpenCode`.

### Task 12: Live validation on the test boxes

**Files:** none committed beyond fixes found here.

- [ ] **Step 1: Deploy the candidate** per CLAUDE.md "Shipping": build in this worktree, `rsync -a --delete dist/ /root/tmuxifier/dist/`, copy the changed `src/server/` files into the main checkout, restart only when no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`, and fetch one hashed asset to check its content type. Coordinate with any other Claude session sharing the service first (`ListAgents`).
- [ ] **Step 2: Rerun setup** on the OpenCode box (OpenCode ticked) and the Claude box; confirm the plugin file, `~/.tmuxifier-mail/SKILL.md`, and the `agent-mail` / `opencode-plugin` result lines.
- [ ] **Step 3: Walk spec §7.4** and record each result: every direction (OpenCode → Claude, Claude → OpenCode, OpenCode ↔ OpenCode using two tmux sessions in different directories); send to idle, working, blocked; Stop; switch off mid-thread; Tmuxifier restart with a wait armed; OpenCode server restart; setup rerun with a wait armed; two TUIs in one directory read not listening; two TUIs in different directories each reply as their own session; `tmx reply t "$(env)"` prompts in OpenCode.
- [ ] **Step 4: Hand the operator the results** and wait for their validation before merge and the release checklist.
