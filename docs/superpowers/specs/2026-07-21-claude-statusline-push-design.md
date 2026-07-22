# Claude Code Statusline Push — Design

**Date:** 2026-07-21
**Status:** Draft (pending user review)

## Problem

The operator maintains a custom Claude Code statusline (`~/.claude/statusline-command.sh` +
a `statusLine` block in `~/.claude/settings.json`) that shows the model + reasoning effort,
working directory, git branch/dirty-count/ahead-behind, and project version/commit. Every box
that runs Claude Code should be able to get this statusline without hand-copying two files and
merging JSON per box.

We want a per-setup checkbox that pushes the statusline to a box, with one nuance: the
statusline is only meaningful when Claude Code is actually installed on the box. The two contexts
where setup runs — provisioning a **new** box and re-running setup from the **Edit box** menu —
imply different expectations:

- New box: if the statusline is checked but Claude Code is **not** among the selected tools,
  nothing should happen (there is no Claude to configure).
- Edit box: if the statusline is checked but Claude Code is not (re-)selected, we should still
  try, because the box may already have Claude Code installed from an earlier setup.

## Approach (decided)

**The box decides at push time.** Rather than branch on new-vs-edit context in the browser (which
cannot see the box's filesystem and would be guessing), the push runs a presence check *on the
box* over the already-authenticated SSH ControlMaster and applies the statusline only if Claude
Code is really there. (Decision: user, 2026-07-21.)

The presence check is the exact test the codebase already uses in front of the Claude installer
(`boxActions.js`, `TOOLS.claude`):

```sh
command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]
```

Two install locations because the official installer drops the binary in `~/.local/bin/claude`,
which is not necessarily on a non-interactive `$PATH`.

This single rule produces both required behaviors, and one extra robustness win, with no
add-vs-edit distinction anywhere:

| Case | Claude on box at push time? | Result |
| --- | --- | --- |
| New box, statusline✓, claude✗ | no | skip — nothing happens |
| New box, statusline✓, claude✓ | yes (installed earlier in the same setup run) | apply |
| Edit box, statusline✓, Claude already installed | yes | apply |
| Edit box, statusline✓, no Claude anywhere | no | skip gracefully (reported) |
| New box, statusline✓, claude✓ but install failed | no | skip gracefully (no pointless push) |

The statusline push is structurally a twin of AI-auth seeding: an opt-in boolean, a dedicated
server module, invoked as a post-setup step in `setupManager.completeDone`, gated on a box-side
condition, with the per-box outcome recorded on the job and never promoted to a job failure.

**Timing.** The step runs *after* the setup script (so a `claude` tool selected in the same run
is already installed and passes the presence check) and *after* the AI-auth seed, but strictly
**before** `ensureSession` — `ensureSession` must remain the last step, as its existing comments
require. The statusline touches only `~/.claude/*` and never shell rc files, so it is independent
of the seed's rc/token writes; placing it between seed and `ensureSession` is for ordering
hygiene, not correctness.

## Components

### `src/server/assets/claude-statusline.sh` (new)

The canonical statusline script, now version-controlled in the repo — the single source of truth.
Content is the portable script already built and verified on the host and on a provisioned box:
fields resolved via `jq` from the stdin JSON, the caveman badge resolved
by glob under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/caveman/caveman/*/…` (a silent
no-op on any box with no caveman plugin), and all paths `$HOME`/`CLAUDE_CONFIG_DIR`-relative so
the same bytes work for root and any user. Boxes receive a byte-for-byte copy.

The caveman-badge block ships as-is (inert on boxes) so there is one canonical file rather than a
host/box fork. (Decision: user, 2026-07-21.)

### `src/server/claudeStatusline.js` (new)

Mirrors `aiAuthSeed.js`: pure builder(s) + a small DI orchestrator.

- `buildStatuslineInstallScript()` — pure builder for the **remote installer** script. The script
  text goes into ssh argv and contains **no interpolated input**; the statusline file content
  arrives on **stdin**. On the box it, in order:
  1. Presence check. If Claude Code is absent, print `STATUSLINE: skipped-no-claude` and `exit 0`.
     Skipping is a success, not a failure — nothing is wrong with the box.
  2. `mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`.
  3. `cat > "$dir/statusline-command.sh"` (consuming stdin), then `chmod 755`.
  4. Ensure `jq` best-effort via the multi-package-manager pattern used by the tool catalog
     (`apt-get`/`dnf`/`yum`/`pacman`/`apk`/`zypper`, `$SUDO` when not root). `jq` is needed by the
     statusline at render time for the model/dir/version fields (the git segment does not need it).
  5. Merge the `statusLine` block into `settings.json`:
     - Absent file → write it fresh (no JSON parser needed):
       `{"statusLine":{"type":"command","command":"bash \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh\""}}`.
       Note the command value is written **literally** (the `${…}` is expanded by the shell that
       runs the statusline command later, not at install time) — the installer must single-quote
       to prevent its own shell from expanding it.
     - Present file → set `.statusLine` with `jq` (primary), falling back to `node` then `python3`
       if `jq` is unavailable, writing to a temp file and `mv`-ing into place (atomic; a crash
       never truncates the user's settings). Existing keys are preserved.
     - Present file but no `jq`/`node`/`python3` available → cannot safely merge; print
       `STATUSLINE: error-no-json-tool` and `exit 4`. (Rare: a box with Claude settings but none of
       three ubiquitous tools.)
  6. Print `STATUSLINE: applied` and `exit 0`.

- `createStatuslinePusher({ runStdin, readAsset })` — `readAsset()` returns the asset bytes
  (cached read of `claude-statusline.sh`). `.push(box)`:
  - `const res = await runStdin(box, buildStatuslineInstallScript(), assetBytes)`.
  - Classify from `res.code` + the final `STATUSLINE:` marker on `res.stdout`, to a result of the
    same shape `seed()` returns (a `SeedResult`):
    - `code === 0` and marker `applied` → `{ target: 'statusline', ok: true }`
    - `code === 0` and marker `skipped-no-claude` → `{ target: 'statusline', ok: false, skipped: 'no Claude on the box' }`
    - anything else (non-zero, or no recognizable marker) → `{ target: 'statusline', ok: false, error: 'statusline push failed' }`
      (never echo raw stderr — same discipline as the seed).

  Both success outcomes (applied and skipped-no-claude) `exit 0` on the box; only a genuine error
  (`error-no-json-tool`) exits non-zero. Classification therefore reads the marker on the exit-0
  path and treats every non-zero exit as an error.

Transport is `boxActions.execScriptStdin` — the same validated `buildProbeArgv` path (`assertBoxSafe`
on all connection fields) that AI-auth seeding and uploads already ride. The statusline content is
not secret; it travels on stdin anyway to keep a multi-KB file out of argv and avoid quoting it.

**Required change to `boxActions.execScriptStdin`.** Today it returns a bare `{ ok: true }` on
success and `{ ok: false, error }` on failure — no stdout, no exit code — so the pusher cannot read
the `STATUSLINE:` marker through it. Extend it to also surface `code`, `stdout`, and `stderr` on
both the success and failure returns. This is backward-compatible: the only existing caller
(`aiAuthSeed.js`) reads `res.ok` only, and `test/aiAuthSeed*`/`test/setupManager` tests assert on
`ok` alone. A regression test confirms seeding still keys off `ok`.

### `src/server/setupManager.js`

- `normalizeOptions` gains `claudeStatusline: !!o.claudeStatusline`.
- `summary` gains `statusline: j.statusline ?? null`.
- New injected dependency `pushStatusline = null` (default `null` → the step is skipped entirely,
  which is what every existing test constructs — no test churn).
- In `completeDone`, after the `seed` block and before the `ensureSession` block:

  ```js
  if (pushStatusline && j.options.claudeStatusline && box && !j.cancelled) {
    j.phase = 'statusline';
    persist();
    try { j.statusline = await pushStatusline(box); }
    catch { j.statusline = { target: 'statusline', ok: false, error: 'statusline push failed' }; }
  }
  ```

  A skip or failure is recorded, never promoted — setup itself succeeded, and a box without Claude
  Code must not turn red.

### `src/server/index.js`

Construct the pusher and wire it into `createSetupManager`:

```js
const statuslinePusher = createStatuslinePusher({
  runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
  readAsset: () => fs.readFile(new URL('./assets/claude-statusline.sh', import.meta.url)),
});
// …
pushStatusline: (box) => statuslinePusher.push(box),
```

### Web client

- `src/web/setupOptions.ts`
  - `SetupOptionsValues` gains `claudeStatusline: boolean`.
  - A checkbox is rendered **inside the Additional tools fieldset** (appended to `tools.element`),
    labeled "Push Claude Code statusline", with a muted help line "Applied only when Claude Code is
    installed on the box." It is read as its own boolean in `values()`, **not** added to
    `PROVISION_TOOLS`/`TOOL_IDS` — `resolveTools` (the command-injection chokepoint) is untouched.
- `src/web/main.ts`
  - The Edit-box submit gate at ~L1481 (`if (so.ohMyTmux || … || so.seedAiAuth)`) gains
    `|| so.claudeStatusline`, so re-running setup with only the statusline checked still opens the
    provision panel and starts the job.
- `src/web/setupStatus.ts`
  - Add a `phase === 'statusline'` progress label ("Configuring statusline…"), mirroring the
    existing `phase === 'seeding'` → "Seeding AI credentials…".
  - Add a `formatStatuslineResult(statusline: SeedResult | null)` helper mirroring
    `formatSeedResults` (empty string when nothing was pushed, so old jobs with no `statusline`
    field render nothing).
- `src/web/main.ts`
  - Alongside the existing `formatSeedResults(job.seed)` render (~L1192), render
    `formatStatuslineResult(job.statusline)` so the setup panel reports applied / skipped: no
    Claude / failed.
- `src/web/api.ts`
  - The setup-job type gains `statusline: SeedResult | null` (mirroring the existing `seed` field).

## Testing (TDD)

- `test/claudeStatusline.test.js` (new): the builder emits the `command -v claude` presence check
  and the `STATUSLINE:` markers; the pusher maps `applied`/`skipped-no-claude`/error+nonzero to the
  three result shapes; the pusher pipes the asset bytes (asserted via a fake `runStdin`).
- `test/setupManager.test.js` (additions): with `pushStatusline` wired and `claudeStatusline: true`,
  `completeDone` runs the step, records `j.statusline`, and reaches `done`; with the option off it
  is skipped; a thrown/failed push is recorded, not promoted; the step runs before `ensureSession`.
- `test/setupOptions.test.js` (additions): `values()` carries `claudeStatusline`; the checkbox
  exists in the tools section.
- `test/boxActions.test.js` (additions, or the relevant existing suite): `execScriptStdin` now
  returns `code`/`stdout`/`stderr` on both success and failure, and still sets `ok` correctly — a
  regression guard for the AI-auth seed, which keys off `ok` alone.

## Out of scope / non-goals

- No host-side readiness endpoint (unlike AI-auth seeding, there is no host credential to check —
  the script is bundled).
- No live UI coupling between the statusline checkbox and the `claude` tool checkbox; the box-side
  presence check is the single authority, and the post-run result reports what actually happened.
- No change to how the operator's own host statusline is managed; this feature ships the same
  script the host uses, but does not link or symlink the host copy.
