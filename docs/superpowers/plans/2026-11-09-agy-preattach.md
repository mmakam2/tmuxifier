# agy start-up prompts: pre-attach the OSC listener — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Antigravity CLI's start-up prompts (folder trust, sign-in menu) read `blocked` instead of `idle`, by putting the OSC 7501 listener on the pane before agy starts.

**Architecture:** agy emits its start-up record about 0.15 s after launch and never repeats it (spike: SIGWINCH, a tmux resize and SIGCONT produce no re-emit), while the reporter's loop attaches by pane command every 2 s. A new reporter role, `attach %N`, opens the listener pipe on one pane on request; a tagged rc line defines a shell function `agy` that runs that role for its own pane and then runs the real agy. Spike on the test box: 5 of 5 wrapped launches read `blocked` at about 200 ms, 0 of 3 unwrapped ones did.

**Tech Stack:** stdlib python (the box-side asset), POSIX sh (the installer and the rc line), vitest, a real private tmux server for the integration suite.

**Spec:** none. This is a small change approved in chat; this plan is the full description.

## Global Constraints

- The asset stays stdlib-only, prints nothing (unless `TMUXIFIER_OSC_DEBUG=1`, through the existing `debug()`), never writes to a pane, and every role exits 0.
- `tmux pipe-pane -o` on a pane that already has a pipe **closes that pipe** and opens nothing (tmux's toggle; verified on tmux 3.6). The new role therefore calls `attach()` only after it has read `#{pane_pipe}` = `0` for that pane. It must never close a pipe.
- Do not change the behaviour of `attach()`, `detach()`, `hand_over()`, `pass_once()`, `run_listen()`, `run_loop()` or `run_sweep()`. Comments in the asset may change where this plan says so.
- The rc line, byte for byte (one line, exported from `src/server/oscReporter.js` as `AGY_ATTACH_RC_LINE`):

  ```
  alias agy >/dev/null 2>&1 || eval 'agy() { [ -z "${TMUX_PANE:-}" ] || python3 "$HOME/.tmuxifier-osc/reporter.py" attach "$TMUX_PANE" </dev/null >/dev/null 2>&1; command agy "$@"; }' # tmuxifier-osc-agy-attach
  ```

- Its tag is `# tmuxifier-osc-agy-attach`. The existing line `export AGY_CLI_OSC7501=on # tmuxifier-osc-agy` stays, unchanged.
- The installer script text interpolates no input: every string in it is a constant.
- Tests use real code. The integration suite runs a real, private tmux server and does not skip when tmux or python3 is missing.
- The repo is public: no real domains, IPs, hostnames, emails or box names anywhere; use `example.com`, `192.168.1.x`, `box01`.
- `CLAUDE.md` and `AGENTS.md` receive the same edit.
- TDD: the failing test first. Conventional-commit messages, each ending with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run the tests with `npx vitest run <file>` from the worktree root.
- A PreToolUse hook reminds you to run graphify before grepping. The graph lives in the main checkout: `graphify query "<question>" --graph /root/tmuxifier/graphify-out/graph.json`. The reminder does not block a tool call.

## Review Focus

1. A pane that already has an operator's pipe (a logging plugin): the pipe must keep receiving output after `attach %N`. Pinned by Task 1's real-tmux test.
2. A pane on a tmux server other than the default one (`tmux -L work`): the listener would resolve `%N` against the default server and write another session's marker, so the role must refuse. Pinned by Task 1's stub and real-tmux tests.
3. An operator alias named `agy` defined earlier in the rc file: the line must produce no error and no function in bash, zsh and dash. Pinned by Task 2.
4. Outside tmux, with python3 or the reporter file missing, or with `set -u`: agy still starts with the same arguments and its own exit status, and nothing is printed. Pinned by Task 2.
5. Setup reruns: exactly one of each tagged line per rc file; the `sed` for `# tmuxifier-osc-agy$` must not delete the attach line. Pinned by Task 2.

---

### Task 1: the `attach %N` role

**Files:**
- Modify: `src/server/assets/tmuxifier-osc-reporter.py` (header "Roles" comment near line 8, the "Whose pipe is it" comment block near line 633, a new `run_attach`, `main()` near line 987)
- Modify: `test/helpers/stubTmux.js`
- Modify: `test/osc7501Sweep.test.js` (the stub-tmux tests of the role; it already has `setup()`)
- Modify: `test/osc7501Tmux.integration.test.js`

**Interfaces:**
- Produces: `python3 ~/.tmuxifier-osc/reporter.py attach %N` — reads `$TMUX` from its environment; exits 0 and prints nothing in every case. Task 2's rc line calls exactly this.
- Produces: `harness({ shell: true })` in `test/osc7501Tmux.integration.test.js` — the session's pane runs `/bin/bash --norc --noprofile` instead of the `codex` copy, and `<bin>/agy` is a copy of `/bin/bash` (so a pane running it reports `#{pane_current_command}` = `agy`). `harness()` with no argument behaves exactly as today. Task 2 uses this.

`run_attach(pane_id, home)` does this, in this order:

1. `sock = os.environ.pop('TMUX', '').rsplit(',', 2)[0]`. Empty: return 0 without calling tmux. The pop is load-bearing: `$TMUX` must not reach the tmux calls below, so they talk to the default server, the one the loop and the listener use (a `pipe-pane` job inherits the server's environment, which has no `$TMUX`). With `$TMUX` left in place step 2 would ask the pane's own server and always agree with itself.
2. One call: `tmux display-message -p -t <pane_id> '#{socket_path}\t#{pane_id}\t#{pane_pipe}'` (literal tab characters in the format). Continue only when it exits 0 and its output, stripped of the trailing newline, splits on tab into exactly three fields with `os.path.realpath(fields[0]) == os.path.realpath(sock)`, `fields[1] == pane_id` and `fields[2] == '0'`. Otherwise return 0 (call `debug(home, ...)` with the reason).
3. `attach(pane_id, home)`; return 0.

`main()` dispatches it like `listen`: `argv[1] == 'attach'` and `argv[2]` matches `^%[0-9]+$`.

- [ ] **Step 1: Extend the stub tmux.** In `test/helpers/stubTmux.js`: `makeStubTmux(dir, { sessionOf, panes, paneInfo = {} })` writes `stub-paneinfo` (`N=<text>` lines, like `stub-sessions`), exposes `setPaneInfo(map)` and adds `STUB_TMUX_PANEINFO` and `STUB_TMUX_ENVLOG` (a file path, `stub-envlog`, returned as `envLogFile`) to `env`. In the script: every call appends `TMUX=${TMUX-unset}` to `$STUB_TMUX_ENVLOG` when that variable is set; `display-message` whose arguments contain `#{socket_path}` prints the `stub-paneinfo` text for the `-t` pane (exit 0), or fails with `can't find pane` when there is no line for it; every other `display-message` behaves as today. Update the header comment listing the env vars.

- [ ] **Step 2: Write the failing stub tests** in `test/osc7501Sweep.test.js`. `setup()` gains nothing; pass `TMUX` through a per-call env (add an optional `extraEnv` to a new `runWith(extraEnv, ...args)` helper returned by `setup`, using `spawnSync` so the test can read status, stdout and stderr). With `SOCK = '/sock/default'`:

  - `attach %5` with `TMUX=/sock/default,123,0` and pane info `5 -> '/sock/default\t%5\t0'`: status 0, stdout + stderr `''`, exactly one `pipe-pane` log line and it equals `` `pipe-pane -o -t %5 exec python3 '${home}/.tmuxifier-osc/reporter.py' listen %5` ``, entry file `5` parses to an object with `sha === SHA`, `handover === false`, a numeric `attachedAt` and no `pid`.
  - the same with pane info `'/sock/default\t%5\t1'` (already piped): no `pipe-pane` line, no entry file.
  - pane info `'/other/sock\t%5\t0'` (another server): no `pipe-pane` line, no entry file.
  - pane info `'/sock/default\t%6\t0'` (the reply names another pane): no `pipe-pane` line, no entry file.
  - no pane info line for `%5` (tmux fails): status 0, no output, no `pipe-pane` line.
  - `STUB_TMUX_NOSERVER=1`: status 0, no output, no `pipe-pane` line.
  - no `TMUX` in the environment: the stub log is empty (no tmux call at all), status 0.
  - `attach 5`, `attach %5x` and `attach` alone, each with a valid `TMUX`: the stub log is empty, status 0.
  - in the first case, every line of the env log is `TMUX=unset`.

- [ ] **Step 3: Run them and see them fail.** `npx vitest run test/osc7501Sweep.test.js` — the new tests fail (unknown role is a no-op: no `pipe-pane` line), the existing ones pass.

- [ ] **Step 4: Implement `run_attach` and the `main()` branch** as specified above. Place `run_attach` after `run_sweep`.

- [ ] **Step 5: Update the asset's comments.**
  - Header "Roles" list: add `attach %N` — "what the `agy` shell function setup adds runs for its own pane before it starts the agent: opens the listener pipe at once, so reports sent in the first two seconds (agy's folder-trust and sign-in prompts, ~0.15 s after launch) are not lost to the loop's 2 s cadence. Only on the default tmux server and only on a pane that has no pipe."
  - The "Whose pipe is it" block: the sentence "(`-o`, so a pipe that appeared in between wins silently)" is wrong. Replace it with what tmux does: `-o` opens nothing over an existing pipe but CLOSES that pipe (the toggle), so a pipe that appears between the listing and the `-o` is closed; the window is the few milliseconds between the two tmux calls. Add the `attach` role as the second opener, under the same rule (it reads `pane_pipe` = 0 for that one pane immediately before), and say what follows it: the pane's command is still the shell for a moment, which is at most one miss of three, and if the agent never starts the loop detaches the listener after three passes and its EOF path removes the `ready/start` it seeded.

- [ ] **Step 6: Run the stub tests.** `npx vitest run test/osc7501Sweep.test.js test/osc7501Listen.test.js test/osc7501Reporter.test.js test/osc7501Replay.test.js` — all pass.

- [ ] **Step 7: Add `harness({ shell })` and write the real-tmux tests** in `test/osc7501Tmux.integration.test.js`. With `shell: true` the session is created with `exec /bin/bash --norc --noprofile`, the harness waits for `#{pane_current_command}` to be `bash`, and copies `/bin/bash` to `<bin>/agy` (mode 755). Add `h.attachRole(paneId, tmuxEnv)`: `spawnSync('python3', [installed, 'attach', paneId], { env: { ...env, TMUX: tmuxEnv } })`, asserting status 0 and empty output, as `h.sweep()` does. Three tests, none of which calls `h.sweep()`:

  1. *pre-attach catches a report sent the moment the agent starts.* Write an agent payload file under `h.tmp` containing `printf '\033]7501;state=blocked:kind=permission:app=antigravity\007'; sleep 30; true`. Type into the pane (two `send-keys`, as `h.report` does): `python3 "$HOME/.tmuxifier-osc/reporter.py" attach "$TMUX_PANE"; agy --norc --noprofile <payload file>`. Expect, by `waitFor`: the marker matches `/^web:blocked:\d+:permission\n$/`; then `h.fmt('#{pane_current_command}')` is `agy`, `h.fmt('#{pane_pipe}')` is `1`, the entry has a numeric live `pid`, and `h.procs('loop')` is empty (no loop ever ran: the pre-attach alone caught it).
  2. *an operator's pipe is left alone.* `h.tmux('pipe-pane', '-t', '%0', "cat > '<tmp>/op.log'")`; `h.attachRole('%0', h.fmt('#{socket_path}') + ',1,0')`; expect `#{pane_pipe}` still `1` and no entry file; type `echo hello-operator`; expect `op.log` to contain `hello-operator`.
  3. *a pane of another tmux server is refused.* Start a second server with the real tmux binary (not the wrapper) on its own `-L` name under the same private `TMUX_TMPDIR`, read its `#{socket_path}`, call `h.attachRole('%0', '<that path>,1,0')`, expect the harness pane's `#{pane_pipe}` to be `0` and no entry file. Kill the second server in a `finally`.

- [ ] **Step 8: Run the integration suite.** `npx vitest run test/osc7501Tmux.integration.test.js` — the three new tests and the two existing ones pass. To see test 1 fail for the right reason, temporarily make `run_attach` return before step 3 and confirm the marker never appears; restore it.

- [ ] **Step 9: Commit.** `git add src/server/assets/tmuxifier-osc-reporter.py test/helpers/stubTmux.js test/osc7501Sweep.test.js test/osc7501Tmux.integration.test.js` and commit `feat(osc7501): attach role, a listener on the pane before the agent starts`.

---

### Task 2: the `agy` shell function in the rc files

**Files:**
- Modify: `src/server/oscReporter.js`
- Modify: `test/oscReporter.test.js`
- Modify: `test/osc7501Tmux.integration.test.js`

**Interfaces:**
- Consumes: the `attach %N` role and `harness({ shell: true })` from Task 1.
- Produces: `export const AGY_ATTACH_RC_LINE` in `src/server/oscReporter.js`, the exact line from Global Constraints (no trailing newline).

The installer's step 3, inside the existing `for rc in …` loop and after the agy export pair, deletes the old line and appends the new one:

```sh
    sed -i '/# tmuxifier-osc-agy-attach$/d' "$rc" 2>/dev/null || true
    printf '%s\n' '<AGY_ATTACH_RC_LINE with every ' written as '\''>' >> "$rc"
```

Build the single-quoted form in JS from the constant (a constant derived from a constant; nothing is interpolated from input). `printf`, not `echo`: the line must arrive byte for byte under dash, bash and zsh.

- [ ] **Step 1: Write the failing installer tests** in `test/oscReporter.test.js` (import `AGY_ATTACH_RC_LINE`):
  - `script text`: the script contains `tmuxifier-osc-agy-attach`; `s.match(/\$\{[^}]*\}/g)` equals `['${TMUX_PANE:-}']` (replaces the blanket `not.toMatch(/\$\{/)`); the allowed variable names gain `$TMUX_PANE`.
  - `applies`: `.zshrc` is exactly `` `alias a=b\n${TAG}\n${AGY_TAG}\n${AGY_ATTACH_RC_LINE}\n` `` after two runs; `.profile` holds each of the three lines exactly once.
  - `untagged operator line`: expected content gains the attach line at the end.
  - new, *an operator's own untagged `agy` function line is kept*: `.zshrc` = `agy() { command agy --mine "$@"; }\n` survives two runs as the first line.

- [ ] **Step 2: Write the failing behaviour tests** in `test/oscReporter.test.js`. Run the installer into a `box()`, add a stub `agy` to the box's bin (`#!/bin/sh`, appends `agy <argc> [<$1>]` to the box's log file, exits 7) and make the stub `python3` also print a line to stdout and one to stderr. Then run a script file through each shell with `env = { PATH: <box bin>, HOME, … }` and, where stated, `TMUX_PANE=%5`. The script sources `"$HOME/.profile"` twice (a login bash reads it and `.bashrc`), then runs `agy "a b" c` and prints `rc=$?`. Shells: `/bin/sh` and `bash` always (resolve with `realPath`; missing is a test failure), `zsh -f` when installed (`test.skipIf`). For each shell:
  - inside tmux: the log, after the installer's own `sweep` line, reads `<home>/.tmuxifier-osc/reporter.py attach %5` then `agy 2 [a b]`; stdout is exactly `rc=7\n`; stderr is empty.
  - outside tmux (no `TMUX_PANE`), and again with `set -u` as the script's first line: no `attach` line in the log, `agy 2 [a b]` present, stdout `rc=7\n`, stderr empty.
  - an alias defined before the line (`alias agy='agy --aliased'` as the first line; for bash add `shopt -s expand_aliases` before it): stderr empty, no `attach` line, and the log shows `agy 3 [--aliased]`.
  - python3 missing (delete the stub after the install), inside tmux: `agy 2 [a b]`, stdout `rc=7\n`, stderr empty.

- [ ] **Step 3: Run and see them fail.** `npx vitest run test/oscReporter.test.js`.

- [ ] **Step 4: Implement.** Add `AGY_ATTACH_RC_LINE`, the two installer lines, and update the file's header comment (three rc lines now; what the third does and why it is an `alias … || eval`: a function definition is parsed with aliases expanded, so defining `agy()` under an operator alias named `agy` is a syntax error in bash and zsh; the `eval` defers the parse until after the alias check) and the step-3 comment in the script.

- [ ] **Step 5: Run.** `npx vitest run test/oscReporter.test.js` — all pass.

- [ ] **Step 6: Write the end-to-end test** in `test/osc7501Tmux.integration.test.js`: *the installed `agy` function pre-attaches.* `harness({ shell: true })`; write `AGY_ATTACH_RC_LINE + '\n'` to `<home>/.bashrc`; type `. "$HOME/.bashrc"`, then `agy --norc --noprofile <payload file>` (the payload of Task 1's test 1). Expect the marker to match `/^web:blocked:\d+:permission\n$/`, `#{pane_current_command}` = `agy`, a claimed entry, and `h.procs('loop')` empty. Then type nothing further: the test ends with the harness cleanup.

- [ ] **Step 7: Run both suites.** `npx vitest run test/oscReporter.test.js test/osc7501Tmux.integration.test.js` — all pass.

- [ ] **Step 8: Commit.** `feat(osc7501): agy shell function pre-attaches the listener at launch`.

---

### Task 3: docs and maps

**Files:**
- Modify: `docs/boxes-and-setup.md` (the "Antigravity CLI (`agy`)" bullet, near line 235)
- Modify: `docs/fleet-and-health.md` (the sentence near line 118)
- Modify: `test/fixtures/README-osc7501-pane-trace.md` (the last sentence of the agy note, near line 91)
- Modify: `CLAUDE.md` and `AGENTS.md` (the `oscReporter.js` entry; identical edits)

**Interfaces:**
- Consumes: the behaviour of Tasks 1 and 2. Nothing produced.

Facts every edit must agree with:

- Setup adds a second tagged agy line to the same rc files under the same rule: a shell function named `agy` (tag `# tmuxifier-osc-agy-attach`). Inside tmux it runs the reporter's `attach` role for its own pane and then the real agy, so the listener is on the pane before agy prints. The folder-trust prompt then reads `blocked` (permission) and the sign-in menu `blocked` (elicitation), about 0.2 s after launch.
- It covers only a launch that goes through the function: `agy` typed in an interactive shell that was started after setup ran. Not covered, and behaving as before (the loop attaches within 2 s, so the start-up prompt usually reads `idle`): `command agy`, a script, a box whose startup command is `agy` (tmux runs it through the shell's `-c`, which reads no rc function), an operator alias named `agy` (the line then defines nothing), and a pane on a tmux server other than the default one.
- Opt-out that survives setup reruns: an alias named `agy` anywhere in the rc file (`alias agy=agy`).
- It costs one python start per launch (about 25 ms on the test box). It never touches a pane that already has a pipe. If agy does not start, the listener is detached after three passes (4-6 s).
- The reporter roles are now `listen %N`, `attach %N`, `loop`, `sweep [--once]`.
- `tmux pipe-pane -o` closes an existing pipe; both openers read `pane_pipe` = 0 first.

- [ ] **Step 1: `docs/boxes-and-setup.md`.** Rewrite the three sentences from "The two start-up prompts…" to "…answer those in the pane." with the facts above, in the guide's voice, and say "two tagged lines" where the bullet now says "one tagged line". Keep the rest of the bullet.
- [ ] **Step 2: `docs/fleet-and-health.md`.** Replace "Antigravity's start-up prompts (folder trust, sign-in) are reported before the reporter attaches and usually read `idle`; see the section linked above." with one sentence: they read `blocked` when agy is launched through the shell function setup adds, and usually `idle` otherwise; see the section linked above.
- [ ] **Step 3: the fixture README.** After "…so a listener that attaches by the pane's command usually misses them." add one sentence pointing at the `attach` role and the `agy` shell function as what catches them on a box.
- [ ] **Step 4: `CLAUDE.md` and `AGENTS.md`.** In the `oscReporter.js` entry: replace the clause "its start-up prompts, folder trust and sign-in, are emitted ~0.15 s after launch, before the 2 s attach, and usually read `ready/start` — only mid-turn approvals and questions are reliably seen" with the new mechanism and its limit in the same compressed style (the `AGY_ATTACH_RC_LINE` function line, tag `# tmuxifier-osc-agy-attach`, runs `attach %N` before agy; launches that bypass the function still race the 2 s attach); add `attach %N` to the roles sentence (default server only, only a pane with `pane_pipe` 0, because `pipe-pane -o` closes an existing pipe); mention the three new real-tmux tests where the entry lists the tests. Then confirm the two edits are identical: `diff <(git diff CLAUDE.md | grep '^[+-][^+-]') <(git diff AGENTS.md | grep '^[+-][^+-]')` prints nothing.
- [ ] **Step 5: Check.** `grep -rn "usually read" README.md docs/*.md CLAUDE.md AGENTS.md` shows no leftover claim that contradicts the facts above; `npm run typecheck` passes; `npx vitest run test/oscReporter.test.js test/osc7501Sweep.test.js` passes.
- [ ] **Step 6: Commit.** `docs(osc7501): agy start-up prompts are caught by the pre-attach function`.
