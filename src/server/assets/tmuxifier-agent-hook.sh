#!/bin/sh
# Tmuxifier agent-state hook (installed by box setup; safe to delete — the
# next setup run reinstalls it). Claude Code invokes it with the event name
# as $1 and the event JSON on stdin.
# Writes one line — <session>:<state>:<epoch>:<cause>:<pane> — to
# ~/.tmuxifier-agent/<session><pane> (e.g. web%12) for the Tmuxifier status probe.
# Colons are safe separators: tmux forbids them in session names. Each pane keeps
# its own marker, busy tokens and blocked record, because split panes share a
# session and a single file would make the last writer win; the server folds a
# session's panes. Without a usable $TMUX_PANE it falls back to the four-field
# session-wide marker. No set -e: a hook failure must never surface into
# the Claude session, so every path is guarded instead.
#
# State vocabulary (state/cause):
#   ready/start, ready/stop      idle at the prompt (session began / turn ended)
#   working/prompt, /resume, /unblock   a turn is running
#   blocked/permission, /question, /elicitation   Claude is waiting on the operator
# Dispatch: start -> ready/start; stop -> ready/stop (working/prompt while
# background work is outstanding); prompt -> working/prompt (working/resume for
# a <task-notification>; a mail wake, which also carries the [tmuxifier-mail tag,
# keeps the busy tokens and leaves a blocked marker untouched); permission -> blocked/question when the payload's
# tool_name is AskUserQuestion (Claude Code also fires PermissionRequest for
# it), else blocked/permission; ask -> blocked/question; unblock -> working;
# notify: permission_prompt -> blocked/permission, but only when the marker is
# not already blocked (the AskUserQuestion Notification must not downgrade
# blocked/question); elicitation_dialog|elicitation_url_dialog ->
# blocked/elicitation; agent_needs_input -> blocked/question; idle_prompt|
# agent_completed -> ready/stop ONLY over a working marker (and gated by the
# busy tokens): timers never clear `blocked` and never mint a new ts over
# `ready` (or an absent marker); any other type writes nothing.
# A plain "No" to a permission prompt fires nothing afterwards: the marker stays
# blocked until the operator's next prompt or Claude's next tool call.
# A GRANTED permission is not observable either: the block clears only on the
# tool's PostToolUse, so a long granted command reads blocked until it ends.
#
# blocked/<session><pane> holds the blocker's agent_id (empty = main agent) so
# `unblock` only clears a block its own agent raised. Like busy/, the directory
# is invisible to the probe, which reads only `[ -f ]` entries of .tmuxifier-agent/*.
#
# `unblock` (PostToolUse / PostToolUseFailure) fires after EVERY tool call, so
# it short-circuits before stdin is read: when the marker is not `blocked` it
# exits 0 having spent two forks (`sh` and `tmux`) and no more.
#
# `Stop` fires whenever the main agent finishes responding, which INCLUDES a
# turn that ended only to await a background subagent or shell — work the
# harness resumes on its own, with nobody waiting on the operator. So
# outstanding background work is tracked as token files under
# .tmuxifier-agent/busy/<session><pane>/ and gates the two events that would
# otherwise announce a turn that isn't really over. The probe enumerates
# .tmuxifier-agent/* and reads each `[ -f ]` entry, so the busy DIRECTORY is
# invisible to it.
#
# The event JSON is read rather than discarded: it is the only source of
# agent_id, run_in_background and notification_type. It is never eval'd —
# only substring-matched — and every value taken from it is re-sanitized
# before it reaches a path.
#
# Whose hook this is. Everything started in a pane inherits $TMUX and $TMUX_PANE, so a
# `claude -p` run there (from the session's Bash tool, or left behind in the background by a
# plugin or a script) fires these same hooks: its SessionStart, prompt and Stop would write over
# the session's marker and its SessionEnd would delete it. So the hook acts only for the pane's
# own Claude Code (`own_claude`, read from /proc with no fork unless the owner record changes)
# and exits 0, having written nothing, when the Claude Code that started it
#   - does not descend from the pane's first process (`#{pane_pid}`) and has no controlling
#     terminal: it was re-parented away (or it is gone and this hook is an orphan); or
#   - runs under the pane's owner: the Claude Code recorded in owner/<session><pane> (pid and
#     start time, so a reused pid never matches) is one of its ancestors.
# The owner record is written by a hook that found its Claude Code under the pane, when the
# record changed and when the hook itself has no controlling terminal (Claude Code starts a
# hook in a new session; one run by hand from the pane's shell must not claim the pane for
# that shell). Nothing here goes by a process name: a wrapper script or launcher called
# `claude` is not a Claude Code, and it never runs this hook.
# It fails OPEN: without a pane id, a pane pid or a readable /proc, and for a Claude Code that
# is outside the pane's process tree but has a terminal (screen or dtach started in the pane),
# the hook acts as it always did.
# Test-only knob (read by nothing else): TMUXIFIER_AGENT_TEST_PROC replaces /proc.
[ -n "${TMUX:-}" ] || exit 0
# Allowlisted because it becomes part of a path and of the marker line.
PANE=${TMUX_PANE:-}
case "$PANE" in
  %|%*[!0-9]*) PANE='' ;;
  %*) ;;
  *) PANE='' ;;
esac
# The session and, in the same call, the pid of the pane's first process. The pane is named
# with -t: without a target tmux answers for the ACTIVE pane of the session's current window,
# which is the right session but another pane's pid. A session name holds no colon, so the last
# one splits the two; a tmux that answers with the name alone leaves the pane pid empty.
if [ -n "$PANE" ]; then
  SESSION=$(tmux display-message -p -t "$PANE" '#S:#{pane_pid}' 2>/dev/null) || exit 0
else
  SESSION=$(tmux display-message -p '#S' 2>/dev/null) || exit 0
fi
case "$SESSION" in
  *:*) PANE_PID=${SESSION##*:} SESSION=${SESSION%:*} ;;
  *) PANE_PID='' ;;
esac
case "$PANE_PID" in *[!0-9]*) PANE_PID='' ;; esac
[ -n "$SESSION" ] || exit 0
DIR="$HOME/.tmuxifier-agent"
SAFE=$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')
KEY="$SAFE$PANE"
FILE="$DIR/$KEY"
BUSY="$DIR/busy/$KEY"

# Sets CUR to the state field of this session's marker (empty when absent).
# Sets a variable rather than printing, so no command substitution forks.
cur_state() {
  CUR=''
  [ -f "$FILE" ] && { IFS=: read -r _ CUR _ < "$FILE"; } 2>/dev/null
  return 0
}

# Runs BEFORE stdin is read: leaving a pipe unread is tolerated by Claude Code.
if [ "${1:-}" = unblock ]; then cur_state; [ "$CUR" = blocked ] || exit 0; fi

PROC=${TMUXIFIER_AGENT_TEST_PROC:-/proc}

# Sets P_PARENT, P_TTY and P_START from $PROC/$1/stat: fields 4, 7 and 22. Field 2, the command
# name, may hold spaces and parentheses, so everything up to the last ") " goes first. Fails
# when the file cannot be read or is not a stat line.
stat_of() {
  _st=''
  { IFS= read -r _st < "$PROC/$1/stat"; } 2>/dev/null
  case "$_st" in *') '*) ;; *) return 1 ;; esac
  _st=${_st##*) }
  set -f; set -- $_st; set +f
  P_PARENT=${2:-} P_TTY=${5:-} P_START=${20:-}
  case "$P_PARENT" in ''|*[!0-9]*) return 1 ;; esac
  case "$P_START" in ''|*[!0-9]*) return 1 ;; esac
  return 0
}

# 0 when this hook belongs to the pane's own Claude Code, or when that cannot be told; 1 only on
# evidence that it belongs to another one (the two cases in the header). $1 is the hook's event
# argument. On 0 it records the pane's owner, see the header.
own_claude() {
  [ -n "$PANE" ] && [ -n "$PANE_PID" ] || return 0
  # The Claude Code that started this hook. It runs a hook command through `/bin/sh -c`, and a
  # shell that does not exec its one command (dash) stays as this script's parent: that shell's
  # command line ends with this script's name and argument, and Claude Code is its parent. A
  # shell that execs (bash) leaves Claude Code as $PPID. `read` drops the NULs between the
  # arguments (zsh keeps them, hence the second pattern).
  _mine=$PPID _c=''
  { IFS= read -r _c < "$PROC/$PPID/cmdline"; } 2>/dev/null
  case "$_c" in
    *tmuxifier-agent-hook*" $1"|*tmuxifier-agent-hook*" $1"?)
      stat_of "$PPID" || return 0
      _mine=$P_PARENT ;;
  esac
  stat_of "$_mine" || return 0
  _mine_start=$P_START _mine_tty=$P_TTY
  _owner='' _owner_start=''
  { read -r _owner _owner_start < "$DIR/owner/$KEY"; } 2>/dev/null
  # Up the parents until the pane's first process. Each step is an ancestor of this hook's
  # Claude Code. The recorded owner: it runs under the pane's own. Init: it is not under the
  # pane, which is evidence only when it has no terminal either (a `claude -p` left in the
  # background has none; an interactive one under screen or dtach hangs off init too, with one).
  _a=$_mine _n=0
  while [ "$_a" != "$PANE_PID" ]; do
    _a=$P_PARENT
    case "$_a" in 0|1) [ "$_mine_tty" = 0 ] && return 1; return 0 ;; esac
    _n=$((_n + 1))
    [ "$_n" -le 64 ] || return 0
    stat_of "$_a" || return 0
    [ "$_a" = "$_owner" ] && [ "$P_START" = "$_owner_start" ] && return 1
  done
  # Under the pane: record it as the owner. Through a rename, so a reader never sees half.
  if [ "$_owner $_owner_start" != "$_mine $_mine_start" ] && stat_of self && [ "$P_TTY" = 0 ]; then
    mkdir -p "$DIR/owner" 2>/dev/null \
      && printf '%s %s\n' "$_mine" "$_mine_start" > "$DIR/owner/$KEY.$$.tmp" 2>/dev/null \
      && mv "$DIR/owner/$KEY.$$.tmp" "$DIR/owner/$KEY" 2>/dev/null
  fi
  return 0
}
own_claude "${1:-}" || exit 0

IN=$(cat 2>/dev/null) || IN=''

# First "<key>":"<value>" string out of the event JSON, sanitized to the same
# charset as a session name because both callers use it as a path component.
json_str() {
  printf '%s' "$IN" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1 \
    | tr -d '\r\n' \
    | tr -c 'A-Za-z0-9._-' '_'
}

# True when this session has an unexpired background-work token. The gate fails
# OPEN — a missed notification is worse than a spurious one — so every token
# expires, and the two kinds expire on very different clocks because only one
# of them is exact.
#
# A `sub.` token is bracketed: SubagentStop always fires, mid-turn or not, so it
# is cleared by its own event and the TTL only catches a killed subagent.
#
# A `bg.` token is a HEURISTIC. Claude Code has no background-shell completion
# hook at all: if the shell finishes while the turn is still running, nothing
# fires (UserPromptSubmit only fires when the harness RESUMES an ended turn), so
# the token silently goes stale and would suppress the next real `Stop`. The
# short TTL bounds that to turns ending within ~2min of the launch — a window in
# which a just-launched job is far more likely to still be running than not.
busy_live() {
  [ -d "$BUSY" ] || return 1
  find "$BUSY" -type f -name 'bg.*' -mmin +2 -exec rm -f {} + 2>/dev/null
  find "$BUSY" -type f -name 'sub.*' -mmin +120 -exec rm -f {} + 2>/dev/null
  for f in "$BUSY"/*; do
    [ -f "$f" ] && return 0
  done
  return 1
}

busy_add() {
  mkdir -p "$BUSY" 2>/dev/null || return 0
  : > "$BUSY/$1" 2>/dev/null || true
}

case "${1:-}" in
  prompt)
    # A new turn — from the operator OR from the harness resuming the agent
    # after background work finished. The two must clear DIFFERENT tokens.
    #
    # A resume is the only completion signal a backgrounded shell ever gives, so
    # it still clears every `bg.` token. It must NOT touch `sub.` tokens: every
    # background subagent that finishes resumes the main agent this way, so a
    # blanket clear destroys the tokens of the siblings still running and the
    # next `Stop` reads `waiting` for their whole remaining runtime — the bug
    # this branch exists to avoid, arriving through the door left open for it.
    # A subagent is bracketed by its own SubagentStop; that is what ends it.
    #
    # The operator's own prompt IS a clean slate: they are at the keyboard, the
    # turn is genuinely new, and clearing everything is what bounds a `sub.`
    # token whose SubagentStop never fired (a killed subagent) to the next time
    # a human types, rather than to its 120min TTL. A pasted prompt that happens
    # to contain the marker only costs that reset, since every token still
    # expires on its own clock.
    #
    # A delivered agent message wakes the agent through a Stop-hook block, which
    # reaches this hook as a <task-notification> carrying the mail tag. It is not
    # a shell completion, so it clears nothing, and it never writes over a block:
    # a wake that lands while a permission dialog is open must leave `blocked`
    # (and its owner record) alone, hence the exit before the marker rewrite.
    case "$IN" in
      *'<task-notification>'*'[tmuxifier-mail '*)
        cur_state; [ "$CUR" = blocked ] && exit 0
        CAUSE=resume ;;
      *'<task-notification>'*) rm -f "$BUSY"/bg.* 2>/dev/null; CAUSE=resume ;;
      *) rm -rf "$BUSY" 2>/dev/null; CAUSE=prompt ;;
    esac
    STATE=working ;;
  subagent-start)
    # agent_id pairs start with stop exactly. A payload without one still gets
    # a token, keyed by pid, so it expires by TTL rather than never existing.
    ID=$(json_str agent_id)
    busy_add "sub.${ID:-anon.$$}"
    exit 0 ;;
  subagent-stop)
    ID=$(json_str agent_id)
    [ -n "$ID" ] || exit 0
    rm -f "$BUSY/sub.$ID" 2>/dev/null
    exit 0 ;;
  pretool)
    # Only a BACKGROUNDED tool call leaves work outstanding past the turn; a
    # foreground one holds the turn open and needs no token. Both spellings,
    # since the payload's whitespace is not ours to assume.
    case "$IN" in
      *'"run_in_background":true'*|*'"run_in_background": true'*) ;;
      *) exit 0 ;;
    esac
    busy_add "bg.$$"
    exit 0 ;;
  stop)
    if busy_live; then STATE=working CAUSE=prompt; else STATE=ready CAUSE=stop; fi ;;
  permission)
    # Claude Code also fires PermissionRequest for AskUserQuestion; that is a
    # question, not a tool permission.
    if [ "$(json_str tool_name)" = AskUserQuestion ]; then CAUSE=question; else CAUSE=permission; fi
    STATE=blocked ;;
  ask) STATE=blocked CAUSE=question ;;
  unblock)
    # Owner-scoped: only the agent that raised the block (main = empty
    # agent_id) may clear it, so a running subagent's tool calls cannot dismiss
    # the main agent's dialog, nor the reverse.
    AID=$(json_str agent_id)
    OWNER=''
    [ -f "$DIR/blocked/$KEY" ] && { IFS= read -r OWNER < "$DIR/blocked/$KEY"; } 2>/dev/null
    [ "$AID" = "$OWNER" ] || exit 0
    STATE=working CAUSE=unblock ;;
  notify)
    # idle_prompt is a TIMER, not a request: it fires a fixed interval after
    # any turn ends, including one that ended awaiting background work.
    # agent_completed announces that ONE background agent finished, which is not
    # the operator's turn while its siblings are still running. Both are
    # therefore gated on outstanding work — and both still land once none is
    # left. They only ever END a working turn: over `blocked` the operator
    # still owes an answer (a timer firing past an open dialog, or after a
    # plain "No", is not an answer), and over `ready` rewriting would mint a
    # fresh ts that re-arms a `done` the operator already acknowledged.
    # The blocked types — permission_prompt, agent_needs_input, … — are
    # Claude Code saying it genuinely wants the operator, so they always land.
    NT=$(json_str notification_type)
    case "$NT" in
      idle_prompt|agent_completed)
        busy_live && exit 0
        cur_state; [ "$CUR" = working ] || exit 0
        STATE=ready CAUSE=stop ;;
      permission_prompt)
        cur_state; [ "$CUR" = blocked ] && exit 0
        STATE=blocked CAUSE=permission ;;
      elicitation_dialog|elicitation_url_dialog) STATE=blocked CAUSE=elicitation ;;
      agent_needs_input) STATE=blocked CAUSE=question ;;
      *) exit 0 ;;
    esac ;;
  start) STATE=ready CAUSE=start ;;
  end) rm -f "$FILE" "$DIR/blocked/$KEY" "$DIR/owner/$KEY"; rm -rf "$BUSY" 2>/dev/null; exit 0 ;;
  *) exit 0 ;;
esac
mkdir -p "$DIR"
# Record who raised a block (empty = main agent); drop the record otherwise.
if [ "$STATE" = blocked ]; then
  mkdir -p "$DIR/blocked" 2>/dev/null && printf '%s\n' "$(json_str agent_id)" > "$DIR/blocked/$KEY" 2>/dev/null
else
  rm -f "$DIR/blocked/$KEY" 2>/dev/null
fi
# Self-prune markers, and owner records, for sessions that died without a
# SessionEnd (a live session whose record goes writes it again at its next
# hook). Depth-capped: the busy tokens below have their own, far shorter, TTL.
find "$DIR" "$DIR/owner" -maxdepth 1 -type f -mtime +7 -exec rm -f {} + 2>/dev/null || true
printf '%s:%s:%s:%s%s\n' "$SESSION" "$STATE" "$(date +%s)" "$CAUSE" "${PANE:+:$PANE}" > "$FILE.$$.tmp" && mv "$FILE.$$.tmp" "$FILE"
