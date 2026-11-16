# Agent messaging: a reply blocked by auto mode

**Date:** 2026-11-16
**Status:** point-in-time record, written on branch `fix/agent-mail-followups`. It is not
updated as the code moves on; the operator guide is `docs/agent-messaging.md`, the module map
is in `CLAUDE.md`.

Box names (`orders`, `billing`) are placeholders.

## What happened

On a production box (call it `orders`), a Claude Code session that had received a message from
another box (`billing`) tried to answer with `tmx reply`. Claude Code's auto mode (the classifier
that reviews actions; the default permission mode of current Claude Code) refused the command
with the label `[Unsanctioned Communication]`. The message had been delivered; the reply was
never sent.

## What the reproduction on this host established

With Claude Code 2.1.325:

- A plain `tmx reply <thread> "literal text"` matches the permission rule `Bash(tmx *)` that
  setup installs, and runs without the classifier being consulted.
- A `tmx` command containing `$( )` (and, by the same documented rule, backticks or a pipe) is
  a compound command the rule does not match, so the classifier decides. It sees no evidence
  that the operator sanctioned this channel: the operator typed nothing that asked for the
  message.
- The block itself was not reproduced here. `[Unsanctioned Communication]` is not among 2.1.325's built-in rules
  (`claude auto-mode defaults`), so where the production label came from is not known.

## The two changes

1. **Plain-text wording** (commit 699534b). The wake, `tmx inbox` and the skill ask the agent
   to run any commands first and send plain text after, and no longer suggest stdin or a pipe.
   This makes the rule-covered form the likely one; it cannot guarantee it.
2. **Classifier entries.** The `agent-mail` setup phase now merges two entries into `autoMode`
   in the box's Claude Code user `settings.json`, each ending with `[tmuxifier-mail]`
   (`MAIL_AUTOMODE_ENVIRONMENT`, `MAIL_AUTOMODE_ALLOW` in `src/server/claudeAgentMail.js`): an
   environment entry naming Tmuxifier's messaging as a key internal service that only reaches
   the operator's own agents (in other tmux sessions on the box or on the operator's other
   machines), and an allow entry saying a `tmx` message to another of the operator's agents is
   sanctioned communication, including a reply to a hook-delivered message. The allow entry
   sanctions the channel only: it excludes credentials, tokens, private keys, environment dumps
   and secret stores, and says it does not sanction any other command run inside or alongside a
   `tmx` command, since a peer could ask for `tmx reply <thread> "$(env)"`. A list setup creates
   starts with `"$defaults"` so the built-in rules stay in effect; a list the operator already
   has only loses its marked entries and gains the current one. The entries are written only
   when the box's `claude --version` reads 2.1.228 or later (the version the documentation names
   for `/auto-mode-setup`, which writes `"$defaults"` itself); setup never upgrades Claude Code,
   and an older one might read `"$defaults"` as prose and lose its built-ins. Below that, or with
   an unreadable version, `autoMode` is left exactly as it is and the result carries a note.
   `claude auto-mode config` against an installed config directory shows both entries and the
   built-ins (pinned by a test that runs when `claude` is on `PATH`).

## Still unverified

That the entries make a blocked reply go through has not been observed. It can only be checked
on a box whose classifier blocks a `tmx` reply, and none here has been seen to.
