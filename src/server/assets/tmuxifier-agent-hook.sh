#!/bin/sh
# Tmuxifier agent-state hook (installed by box setup; safe to delete — the
# next setup run reinstalls it). Claude Code invokes it with the event name
# as $1 and the event JSON on stdin; the JSON is drained and discarded.
# Writes one line — <session>:<state>:<epoch> — to ~/.tmuxifier-agent/<file>
# for the Tmuxifier status probe. Colons are safe separators: tmux forbids
# them in session names. No set -e: a hook failure must never surface into
# the Claude session, so every path is guarded instead.
cat >/dev/null 2>&1 || true
[ -n "${TMUX:-}" ] || exit 0
SESSION=$(tmux display-message -p '#S' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
DIR="$HOME/.tmuxifier-agent"
SAFE=$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')
FILE="$DIR/$SAFE"
case "${1:-}" in
  prompt) STATE=working ;;
  stop|notify|start) STATE=waiting ;;
  end) rm -f "$FILE"; exit 0 ;;
  *) exit 0 ;;
esac
mkdir -p "$DIR"
# Self-prune markers for sessions that died without a SessionEnd.
find "$DIR" -type f -mtime +7 -exec rm -f {} + 2>/dev/null || true
printf '%s:%s:%s\n' "$SESSION" "$STATE" "$(date +%s)" > "$FILE.$$.tmp" && mv "$FILE.$$.tmp" "$FILE"
