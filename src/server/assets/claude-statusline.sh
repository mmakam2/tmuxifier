#!/bin/bash
# Claude Code statusline.
#
# Shows, left to right: the caveman badge (only when caveman mode is
# active), the model name with its reasoning effort level, the working
# directory, the git branch with an uncommitted-change count and
# ahead/behind arrows vs the upstream tracking ref (↑unpushed ↓unpulled,
# hidden when in sync; freshness limited to the last fetch — no network
# calls here), and the project release/version (package.json "version",
# falling back to the nearest git tag) followed by the current short commit
# hash, marked with an orange "*" when the working tree has uncommitted
# changes (so the hash is read as "near this commit", git-describe style).
#
# Colors are chosen to read against Claude Code's dimmed statusline
# background. All git calls use --no-optional-locks so the statusline never
# contends with an in-flight git operation for the repo lock.

input=$(cat)

# Preserve the existing caveman plugin badge. The plugin cache directory is
# named by a per-install hash, so resolve it by glob rather than pinning one
# path — the same copy of this script then works on any host. The config-dir
# base mirrors how the caveman badge script itself resolves its state, so this
# works for root, any real $HOME, and a custom CLAUDE_CONFIG_DIR. First match
# wins; an unmatched glob leaves the badge empty (the [ -f ] test rejects the
# literal pattern bash leaves behind when nothing matches).
CAVEMAN_BADGE=""
for _cm in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/caveman/caveman/*/src/hooks/caveman-statusline.sh; do
  [ -f "$_cm" ] || continue
  CAVEMAN_BADGE=$(bash "$_cm" 2>/dev/null)
  break
done
unset _cm

MODEL=$(printf '%s' "$input" | jq -r '.model.display_name // empty')
EFFORT=$(printf '%s' "$input" | jq -r '.effort.level // empty')
DIR=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')
[ -z "$DIR" ] && DIR="$PWD"
BASE=$(basename "$DIR")

# Release/version: prefer package.json, fall back to the nearest git tag.
VERSION=""
if [ -f "$DIR/package.json" ]; then
  VERSION=$(jq -r '.version // empty' "$DIR/package.json" 2>/dev/null)
fi

GIT_SEG=""
COMMIT_SEG=""
if git -C "$DIR" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git -C "$DIR" --no-optional-locks branch --show-current 2>/dev/null)
  [ -z "$BRANCH" ] && BRANCH=$(git -C "$DIR" --no-optional-locks rev-parse --short HEAD 2>/dev/null)

  if [ -z "$VERSION" ]; then
    VERSION=$(git -C "$DIR" --no-optional-locks describe --tags --always 2>/dev/null)
    VERSION=${VERSION#v}  # tags like v1.2.3 — the segment adds its own "v" prefix
  fi

  DIRTY_COUNT=$(git -C "$DIR" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "${DIRTY_COUNT:-0}" -gt 0 ]; then
    DIRTY_SEG=" \033[38;5;209m✗${DIRTY_COUNT}\033[0m"
  else
    DIRTY_SEG=" \033[38;5;71m✓\033[0m"
  fi

  COMMIT=$(git -C "$DIR" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  if [ -n "$COMMIT" ]; then
    COMMIT_SEG=" \033[2m@${COMMIT}\033[0m"
    [ "${DIRTY_COUNT:-0}" -gt 0 ] && COMMIT_SEG="${COMMIT_SEG}\033[38;5;209m*\033[0m"
  fi

  # Ahead/behind vs upstream (local refs only — fresh as of the last fetch).
  SYNC_SEG=""
  AB=$(git -C "$DIR" --no-optional-locks rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
  if [ -n "$AB" ]; then
    BEHIND=${AB%%$'\t'*}
    AHEAD=${AB##*$'\t'}
    [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null && SYNC_SEG="${SYNC_SEG} \033[38;5;215m↑${AHEAD}\033[0m"
    [ "${BEHIND:-0}" -gt 0 ] 2>/dev/null && SYNC_SEG="${SYNC_SEG} \033[38;5;167m↓${BEHIND}\033[0m"
  fi

  GIT_SEG=" \033[2m|\033[0m \033[38;5;110m${BRANCH}\033[0m${DIRTY_SEG}${SYNC_SEG}"
fi

REL_SEG=""
if [ -n "$VERSION" ]; then
  # git-describe fallback versions already embed the commit hash — don't repeat
  # it, but keep the dirty marker.
  case "$VERSION" in
    *"$COMMIT"*)
      if [ -n "$COMMIT" ]; then
        COMMIT_SEG=""
        [ "${DIRTY_COUNT:-0}" -gt 0 ] && COMMIT_SEG="\033[38;5;209m*\033[0m"
      fi
      ;;
  esac
  REL_SEG=" \033[2m|\033[0m \033[2mv${VERSION}\033[0m${COMMIT_SEG}"
elif [ -n "$COMMIT_SEG" ]; then
  REL_SEG=" \033[2m|\033[0m${COMMIT_SEG}"
fi

OUT=""
[ -n "$CAVEMAN_BADGE" ] && OUT="${CAVEMAN_BADGE} "
if [ -n "$MODEL" ]; then
  MODEL_SEG="\033[2m${MODEL}\033[0m"
  [ -n "$EFFORT" ] && MODEL_SEG="${MODEL_SEG} \033[38;5;140m${EFFORT}\033[0m"
  OUT="${OUT}${MODEL_SEG} \033[2m|\033[0m "
fi
OUT="${OUT}\033[2m${BASE}\033[0m${GIT_SEG}${REL_SEG}"

printf '%b\n' "$OUT"
