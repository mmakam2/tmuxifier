# Design: clamp shell-framework auto-updates on every box and the host shell

**Date:** 2026-07-30
**Status:** implemented in v1.23.1
**Origin:** the e2e suite went red because this host's root zsh began blocking on
`[oh-my-zsh] Would you like to update? [Y/n]`, so every test waiting for a live shell prompt
timed out. Investigating that turned up a clamp that has never worked and a second framework
with no clamp at all.

## Problem

Tmuxifier's box setup script already states the intended policy, in a comment in
`boxActions.js`:

> Unattended fleet boxes must not self-update their shell framework at random shell starts —
> updates happen deliberately, via Fleet Command.

Three things are wrong with the implementation.

### 1. The oh-my-zsh clamp has never fired

The guard is unanchored:

```sh
if [ -f .zshrc ] && ! grep -q "zstyle ':omz:update' mode disabled" .zshrc; then
  sed -i "/oh-my-zsh\.sh/i zstyle ':omz:update' mode disabled" .zshrc
fi
```

Every stock oh-my-zsh install writes a `.zshrc` containing this template block:

```
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time
```

`grep -q` matches the **commented** first line, the guard concludes the clamp is already in
place, and the real setting is never inserted. Confirmed on this host: `.zshrc` sources
oh-my-zsh, the grep matches, and no active `zstyle` line exists.

The oh-my-bash clamp beside it anchors its guard (`grep -q '^DISABLE_AUTO_UPDATE='`) and works
correctly. The two were written differently and only one is right; OMB is the reference.

### 2. oh-my-tmux has no clamp, and ships with auto-update on

`.tmux.conf.local`, which the setup script copies verbatim from the upstream clone, contains:

```
tmux_conf_update_plugins_on_launch=true
tmux_conf_update_plugins_on_reload=true
```

Both active, not commented. Every box with oh-my-tmux therefore runs `git fetch` against
GitHub for tpm and each plugin on every tmux server launch and every config reload — a network
round trip at session start and non-deterministic plugin versions on an unattended box.
Nothing in the codebase touches these flags.

### 3. The clamps only run when Tmuxifier installs the framework

Each clamp lives inside its own `installOhMy*` branch, so it is reachable only when the
operator ticks that framework's checkbox. A framework installed by hand — which is the case on
this host for all three — is never clamped, even with the anchor bug fixed.

## Design

### One always-on clamp block

Move the clamps out of the three install branches into a single block that runs on **every**
setup, with each clamp guarded by evidence that the framework is actually present:

| Framework | Guard | Action |
|---|---|---|
| oh-my-zsh | `.zshrc` exists and sources `oh-my-zsh.sh`, and no line matching `^zstyle ':omz:update' mode disabled` | insert `zstyle ':omz:update' mode disabled` immediately before the source line |
| oh-my-bash | `.bashrc` exists and no line matching `^DISABLE_AUTO_UPDATE=` | insert `DISABLE_AUTO_UPDATE="true"` before the `oh-my-bash.sh` source line (unchanged from today) |
| oh-my-tmux | `.tmux.conf.local` exists | two anchored `sed` expressions flipping `tmux_conf_update_plugins_on_launch` and `..._on_reload` from `true` to `false` |

Notes on the mechanics:

- **Anchoring is the fix.** `sed`'s `i` command inserts at column 0, so the inserted line
  starts at line-start and an anchored `^zstyle` guard matches it on a re-run. Idempotent.
- **Insert position gives precedence.** The line lands immediately before
  `source $ZSH/oh-my-zsh.sh`, therefore after any operator-written `zstyle ':omz:update' mode
  auto`. zsh applies the last `zstyle` before the source, so the clamp wins without having to
  find and delete a competing line.
- **Two `sed` expressions for oh-my-tmux, not one with `\|` alternation.** busybox `sed` on
  Alpine is unreliable with BRE alternation, and the project already documents Alpine/musl as a
  supported-with-caveats target. The existing mouse clamp in that block is the pattern being
  followed:
  `sed -i 's/^set -g mouse on/set -g mouse off/' .tmux.conf.local`.
- **A custom rc file is left alone.** Every action is an insert keyed to the framework's own
  source line, or a substitution keyed to the upstream default text. An rc file that does not
  match is not modified.

### Accepted policy change: a bare setup now edits rc files

`boxActions.js` currently reasons that a bare setup — no framework checkboxes ticked — must not
mutate the box's packages, and by extension has left rc files alone too. Under this design a
bare setup **does** edit `.zshrc`, `.bashrc`, and `.tmux.conf.local` when it finds a framework
installed there.

This is deliberate and was approved explicitly. It is what "disable auto-updates by default for
all boxes" requires: the boxes most likely to carry a hand-installed framework are exactly the
ones that never tick a framework checkbox. Package installation remains untouched by a bare
setup; only these three guarded rc edits are added.

**Two existing test assertions are therefore inverted, not fixed:**

```js
expect(bare).not.toContain('omz:update');        // test/boxActions.test.js:642
expect(bare).not.toContain('DISABLE_AUTO_UPDATE'); // :643
```

These encode the superseded policy. They become positive assertions. This paragraph exists so a
later reader does not restore them as a regression fix.

### The host shell comes along for free

`buildEnsureLocalShellScript` delegates to `buildEnsureTmuxRemote`, so moving the clamps into
the always-on block means `localShellActions.ensureReady` applies them to the Tmuxifier host on
its next run — including this host's hand-installed oh-my-tmux, which neither the box setup path
nor a Fleet Command could otherwise reach (Fleet runs against boxes, not the host).

### No configuration knob

Matching the existing clamps, which have none. The framework's own update command remains
available on any box for an operator who wants to update one deliberately; nothing here
prevents updating, it only stops updates from happening at shell start.

## Existing boxes

The clamp runs at setup time, so boxes that already exist need one sweep. Ship this as a
documented Fleet Command snippet rather than new code — it is the same set of edits the setup
path applies, is safe on a box missing any given framework, and is idempotent:

```sh
# oh-my-zsh
[ -f ~/.zshrc ] && ! grep -q "^zstyle ':omz:update' mode disabled" ~/.zshrc \
  && sed -i "/oh-my-zsh\.sh/i zstyle ':omz:update' mode disabled" ~/.zshrc
# oh-my-bash
[ -f ~/.bashrc ] && ! grep -q '^DISABLE_AUTO_UPDATE=' ~/.bashrc \
  && sed -i '/oh-my-bash\.sh/i DISABLE_AUTO_UPDATE="true"' ~/.bashrc
# oh-my-tmux
[ -f ~/.tmux.conf.local ] \
  && sed -i 's/^tmux_conf_update_plugins_on_launch=true/tmux_conf_update_plugins_on_launch=false/' ~/.tmux.conf.local \
  && sed -i 's/^tmux_conf_update_plugins_on_reload=true/tmux_conf_update_plugins_on_reload=false/' ~/.tmux.conf.local
true
```

The trailing `true` keeps the command's exit status zero when the last guard is false, so Fleet
Command does not report a failure on a box that simply has no oh-my-tmux.

## Updating deliberately

Commands verified against the copies installed on this host, not written from memory:

| Framework | Update command |
|---|---|
| oh-my-zsh | `omz update` (the `omz` function is defined in `~/.oh-my-zsh/lib/cli.zsh`; `~/.oh-my-zsh/tools/upgrade.sh` is the underlying script) |
| oh-my-bash | `upgrade_oh_my_bash` (defined in `~/.oh-my-bash/lib/functions.sh`; `~/.oh-my-bash/tools/upgrade.sh` is the underlying script) |
| oh-my-tmux | `git -C ~/.tmux pull` — `~/.tmux` is a git clone. Plugin updates are tpm's `prefix + U` |

Both shell-framework commands are shell functions rather than binaries, so a Fleet Command run
(non-interactive `sh`) must call the `tools/upgrade.sh` scripts directly.

## Scope boundaries

Out of scope, deliberately:

- **A curated "update frameworks" Fleet action or saved preset.** Considered and declined —
  free-form Fleet Command plus command history already covers it.
- **Any change to the e2e suite.** Clamping the host fixes the immediate symptom, but the
  suite's real fragility is that its boxes read the host operator's interactive rc files at all.
  That is separate, unfiled work.
- **Retroactive automatic repair.** No code walks existing boxes; the Fleet snippet is the
  operator-driven path.

## Testing

`buildEnsureTmuxRemote` is a pure string builder, so these are assertions on the emitted script.

1. **The regression test for the anchor bug.** A `.zshrc` fixture whose only match is the
   commented template line must not satisfy the guard — assert the emitted guard is anchored
   (`^zstyle`), which is what makes the commented line a non-match.
2. Both oh-my-tmux flags are clamped, anchored, and as two separate expressions.
3. All three clamps are present for a **bare** setup (no framework flags) — the inverted
   assertions above.
4. All three clamps are present for each single-framework setup, and appear once, not per
   framework.
5. Idempotency: every clamp is either guarded by an anchored grep or is a substitution keyed to
   the upstream default, so a second run is a no-op.
6. `buildEnsureLocalShellScript` for `omz` and `omb` carries the clamp block, covering the host
   shell.

Full `npm test` and a build must pass. The e2e suite is currently red for an unrelated
environmental reason (the oh-my-zsh prompt this work removes on the host); re-running it after
the host is clamped is the check that it goes green again.

## Files touched

- `src/server/boxActions.js` — clamps move out of the three install branches into one always-on
  block; oh-my-zsh guard anchored; oh-my-tmux clamp added.
- `test/boxActions.test.js` — two assertions inverted, new cases per Testing above.
- `README.md` — the policy, the Fleet snippet, the deliberate-update commands.
- `CLAUDE.md` and `AGENTS.md` — the policy in the `boxActions.js` module description, kept in
  sync per the repo's convention.
