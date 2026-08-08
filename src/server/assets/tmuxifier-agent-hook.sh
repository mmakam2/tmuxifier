#!/bin/sh
# Tmuxifier agent-state hook (installed by box setup; safe to delete — the
# next setup run reinstalls it). Claude Code invokes it with the event name
# as $1 and the event JSON on stdin.
# Writes one line — <session>:<state>:<epoch> — to ~/.tmuxifier-agent/<file>
# for the Tmuxifier status probe. Colons are safe separators: tmux forbids
# them in session names. No set -e: a hook failure must never surface into
# the Claude session, so every path is guarded instead.
#
# `Stop` fires whenever the main agent finishes responding, which INCLUDES a
# turn that ended only to await a background subagent or shell — work the
# harness resumes on its own, with nobody waiting on the operator. So
# outstanding background work is tracked as token files under
# .tmuxifier-agent/busy/<session>/ and gates the two events that would
# otherwise announce a turn that isn't really over. The probe enumerates
# .tmuxifier-agent/* and reads each `[ -f ]` entry, so the busy DIRECTORY is
# invisible to it.
#
# The event JSON is read rather than discarded: it is the only source of
# agent_id, run_in_background and notification_type. It is never eval'd —
# only substring-matched — and every value taken from it is re-sanitized
# before it reaches a path.
IN=$(cat 2>/dev/null) || IN=''
[ -n "${TMUX:-}" ] || exit 0
SESSION=$(tmux display-message -p '#S' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
DIR="$HOME/.tmuxifier-agent"
SAFE=$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')
FILE="$DIR/$SAFE"
BUSY="$DIR/busy/$SAFE"

# First "<key>":"<value>" string out of the event JSON, sanitized to the same
# charset as a session name because both callers use it as a path component.
json_str() {
  printf '%s' "$IN" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1 \
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
    # after background work finished. The latter is the only completion signal
    # a backgrounded shell ever gives, so it has to clear the tokens.
    rm -rf "$BUSY" 2>/dev/null
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
    if busy_live; then STATE=working; else STATE=waiting; fi ;;
  notify)
    # idle_prompt is a TIMER, not a request: it fires a fixed interval after
    # any turn ends, including one that ended awaiting background work. Every
    # other notification type — permission_prompt, agent_needs_input, … — is
    # Claude Code saying it genuinely wants the operator, so it still lands.
    if [ "$(json_str notification_type)" = idle_prompt ] && busy_live; then exit 0; fi
    STATE=waiting ;;
  start) STATE=waiting ;;
  end) rm -f "$FILE"; rm -rf "$BUSY" 2>/dev/null; exit 0 ;;
  *) exit 0 ;;
esac
mkdir -p "$DIR"
# Self-prune markers for sessions that died without a SessionEnd. Depth-capped:
# the busy tokens below have their own, far shorter, TTL.
find "$DIR" -maxdepth 1 -type f -mtime +7 -exec rm -f {} + 2>/dev/null || true
printf '%s:%s:%s\n' "$SESSION" "$STATE" "$(date +%s)" > "$FILE.$$.tmp" && mv "$FILE.$$.tmp" "$FILE"
