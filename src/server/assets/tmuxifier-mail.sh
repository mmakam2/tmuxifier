#!/bin/sh
# tmuxifier-mail
#
# tmx: agent mail on a Tmuxifier box (design 6.6, 6.7). Installed as ~/.tmuxifier-mail/tmx and
# always run as `sh <path>`, so it never depends on the login shell. POSIX sh only (dash, bash
# --posix, busybox ash); tools: curl, tmux, sed, grep (with -o), sort, mkdir, rm, sleep, cat,
# printf.
#
# It speaks HTTP over the unix socket ${TMUXIFIER_MAIL_SOCK:-$HOME/.tmuxifier-mail/sock}, which
# Tmuxifier forwards onto the box. Every parameter travels through `curl --data-urlencode` (`-G`
# for a GET); a message body is always fed to curl on stdin (`body@-`), so it never appears in
# curl's argv. The server's answers are already worded for the agent: they are printed, never
# evaluated, and nothing from them, from an argument or from stdin builds a path or a command.
# The only path built from input is the waiter's lock, from the pane id's digits, validated.
#
#   tmx who|send|reply|wait|read|inbox ...   user commands (usage below). Exit 0 on a 2xx answer
#                                            (printed to stdout), 1 on a refusal or bad input
#                                            (to stderr), 2 on a usage error or outside tmux, 3
#                                            when the socket stays unreachable after 5 attempts,
#                                            or when a send/reply failed after connecting
#                                            (never retried: it may have arrived).
#   tmx hook-wait   Claude Code SessionStart/Stop hook (asyncRewake). One waiter per pane, through
#                   the lock directory $HOME/.tmuxifier-mail/wait.<pane digits>.lock holding its
#                   pid. Holds GET /v1/wait: 200 prints the wake text to stderr and exits 2 (Claude
#                   Code wakes with it); 204 asks again; any failure backs off 2 s doubling to 30 s.
#                   It never exits on an error. It can run for days, so it waits only in the held
#                   request and the back-off sleep, both run in the background and reaped with
#                   `wait`, so a signal from its parent ends it at once (a shell defers traps
#                   until a foreground child returns). Its lock is removed on every exit it
#                   controls.
#                   It follows its Claude Code, not its parent. Claude Code runs a hook command
#                   through `/bin/sh -c` in a new session; a dash wrapper does not exec the
#                   command, so $PPID is that wrapper, which lives exactly as long as the waiter
#                   and survives a Claude Code killed with SIGKILL (it is re-parented, never
#                   signalled). So at start the waiter records its Claude Code: $PPID's parent
#                   when $PPID is such a wrapper (its command line names hook-wait), else $PPID
#                   itself (a `sh -c` that execs, as bash does). At every turn of the loop it
#                   checks that the process it watches (the wrapper, or itself) still has that
#                   parent; when not, Claude Code is gone and the waiter exits 0 (so an orphan
#                   can hold its request for up to one hold period after its Claude Code dies).
#                   The parent is read from /proc/<pid>/stat, so this is Linux-only, which is
#                   what boxes are; without a readable /proc (or a parent of 0 or 1) there is no
#                   Claude pid and no such check (fail open).
#                   The lock holds the owner's pid and, when known, its Claude pid. A lock is
#                   taken over when its owner is dead or is no longer a hook-wait (a pid reused
#                   after a reboot), or when the owner's Claude pid is known and either gone or
#                   different from this waiter's own known Claude pid: a new Claude Code in the
#                   same pane always wins, a second waiter of the same Claude Code stands down, and
#                   so does a waiter whose Claude Code runs under the owner's (a `claude -p` from
#                   the owner's Bash tool inherits the pane and the hooks), or when that cannot
#                   be told. A waiter removes its lock only when the lock names it; since that
#                   check and the delete are two steps, a successor can still lose its directory
#                   to a dying predecessor's cleanup, and then reclaims it at its next lock check
#                   (the top of a turn, and after each held request). A waiter stands down only
#                   when the lock names another live waiter.
#   tmx hook-ack    Claude Code UserPromptSubmit hook. Confirms each distinct
#                   [tmuxifier-mail m-xxxxxxxx] tag in the prompt with POST /v1/ack. Its stdout
#                   would become prompt context, so it prints nothing on either stream and always
#                   exits 0.
#
# Test-only knob (read by nothing else): TMUXIFIER_MAIL_TEST_SLEEP, when set to a number of
# seconds (digits and dots), replaces the duration of every sleep: the 1 s between attempts of a
# user command, the waiter's back-off and its 1 s grace for a lock without a pid.
# TMUXIFIER_MAIL_TEST_MAX_TIME, likewise, replaces curl's -m for every user command (`wait`
# included; not hook-wait's 330 s nor hook-ack's 3 s). TMUXIFIER_MAIL_TEST_NO_PROC=1 makes
# hook-wait read no /proc/<pid>/stat, as on a box without /proc. TMUXIFIER_MAIL_TEST_CLAIM_PAUSE,
# a number of seconds, makes hook-wait sleep between creating its lock and writing its pid;
# TMUXIFIER_MAIL_TEST_CLEANUP_PAUSE, likewise, between its exit cleanup's check that the lock
# names it and the delete.

umask 077
set -f
IFS=$(printf ' \t\n.')
IFS=${IFS%.}

SOCK=${TMUXIFIER_MAIL_SOCK:-$HOME/.tmuxifier-mail/sock}
URL=http://localhost
ID_CH='[abcdefghjkmnpqrstuvwxyz23456789]'
ID_BRE="$ID_CH\\{8\\}"
UPPER=ABCDEFGHIJKLMNOPQRSTUVWXYZ
LOWER=abcdefghijklmnopqrstuvwxyz

usage() {
  cat >&2 <<'EOF'
usage:
  tmx who [box]                      who this session may message, and who is listening
  tmx send <target> ["text"]         start a thread; text from the argument or stdin; prints the id
  tmx reply <thread> ["text"]        answer, or ask a question back
  tmx wait <thread>... [-t seconds]  block until a reply arrives on any of them (default 90 s)
  tmx read <thread>                  print the whole thread
  tmx inbox                          print messages waiting for this session
EOF
  exit 2
}

fail() {
  printf 'tmx: %s\n' "$1" >&2
  exit 1
}

# Seconds to sleep: $1, or the test override.
pace() {
  case ${TMUXIFIER_MAIL_TEST_SLEEP:-} in
    ''|*[!0-9.]*) printf '%s' "$1" ;;
    *) printf '%s' "$TMUXIFIER_MAIL_TEST_SLEEP" ;;
  esac
}

is_thread() {
  case $1 in
    t-$ID_CH$ID_CH$ID_CH$ID_CH$ID_CH$ID_CH$ID_CH$ID_CH) return 0 ;;
  esac
  return 1
}

# Inside tmux: TMUX set and TMUX_PANE a pane id (%N, at most 9 digits). Sets PANE_DIGITS.
in_tmux() {
  [ -n "${TMUX:-}" ] || return 1
  case ${TMUX_PANE:-} in
    %*) PANE_DIGITS=${TMUX_PANE#%} ;;
    *) return 1 ;;
  esac
  case $PANE_DIGITS in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#PANE_DIGITS}" -le 9 ]
}

# Sets SESSION to this pane's tmux session; fails (SESSION unchanged) when tmux cannot say.
session_now() {
  _s=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || return 1
  [ -n "$_s" ] || return 1
  SESSION=$_s
}

# ASCII lower case, surrounding blanks trimmed.
fold() {
  printf '%s' "$1" | sed "s/^[[:space:]]*//; s/[[:space:]]*\$//; y/$UPPER/$LOWER/"
}

# ---- user commands ----

# One request. call METHOD PATH MAXTIME [curl data args...]. With HAS_BODY set, $BODY goes to
# curl on stdin as the `body` field. Sets RESP (the answer) and CODE (the HTTP status, 000 when
# none came); returns curl's exit status.
call() {
  _method=$1 _path=$2 _max=$3
  case ${TMUXIFIER_MAIL_TEST_MAX_TIME:-} in
    ''|*[!0-9.]*) ;;
    *) _max=$TMUXIFIER_MAIL_TEST_MAX_TIME ;;
  esac
  shift 3
  [ "$_method" = GET ] && set -- -G "$@"
  if [ -n "${HAS_BODY:-}" ]; then
    _out=$(printf '%s' "$BODY" | curl -q -s --noproxy '*' --unix-socket "$SOCK" -m "$_max" -H 'Expect:' \
      -w '%{http_code}' --data-urlencode "session=$SESSION" "$@" --data-urlencode 'body@-' "$URL$_path")
  else
    _out=$(curl -q -s --noproxy '*' --unix-socket "$SOCK" -m "$_max" \
      -w '%{http_code}' --data-urlencode "session=$SESSION" "$@" "$URL$_path" </dev/null)
  fi
  _rc=$?
  RESP=${_out%???}
  CODE=${_out#"$RESP"}
  return $_rc
}

# call with up to 5 attempts 1 s apart while the socket cannot be reached: no connection (7) or
# 503 busy, which provably never reached the mail hub; and, for reads only, a connection closed
# without an answer (52/56: what an ssh forward whose far end is down gives). With ONCE set (a
# send or a reply, which must never arrive twice) every other transport failure happened after
# the connection was made (52/56, a timeout through a stalled forward, a send error...), so the
# message may have arrived: no retry, exit 3 with a warning saying how to check ($ONCE). For a
# read, a failure other than 7/52/56 is reported as unreachable at once and never retried.
ONCE=
request() {
  _n=1
  while :; do
    call "$@"
    _rc=$?
    case $_rc in
      0) [ "$CODE" = 503 ] || return 0 ;;
      7) ;;
      *)
        if [ -n "$ONCE" ]; then
          printf 'tmx: the connection was lost before an answer came back, so the message may or may not have been sent; do not send it again without checking (%s)\n' "$ONCE" >&2
          exit 3
        fi
        case $_rc in
          52|56) ;;
          *) printf 'tmx: mail service unreachable, try again shortly\n' >&2; exit 3 ;;
        esac
        ;;
    esac
    if [ "$_n" -ge 5 ]; then
      printf 'tmx: mail service unreachable, try again shortly\n' >&2
      exit 3
    fi
    _n=$((_n + 1))
    sleep "$(pace 1)"
  done
}

# Prints the answer: stdout and exit 0 on 2xx, else stderr and exit 1.
finish() {
  case $CODE in
    2??) printf '%s' "$RESP"; exit 0 ;;
  esac
  [ -n "$RESP" ] || RESP="tmx: the mail service answered $CODE
"
  printf '%s' "$RESP" >&2
  exit 1
}

# The message text: the argument when one was given ($1 = 1), else all of stdin.
take_body() {
  HAS_BODY=1
  if [ "$1" = 1 ]; then
    BODY=$2
    return
  fi
  [ -t 0 ] && usage
  BODY=$(cat; printf .)
  BODY=${BODY%.}
}

ready() {
  in_tmux && session_now || { printf 'tmx: run this inside a tmux session\n' >&2; exit 2; }
  command -v curl >/dev/null 2>&1 || fail 'curl is not installed'
}

cmd_who() {
  [ "$#" -le 1 ] || usage
  ready
  request GET /v1/who 30
  case $CODE in 2??) ;; *) finish ;; esac
  [ "$#" = 1 ] || finish
  # Only the rows of that box: "<box>/<session>  <state>, ..."; sessions never contain a "/".
  _want=$(fold "$1")
  _rows=$(printf '%s' "$RESP" | while IFS= read -r _line; do
    _entry=${_line%%"  "*}
    [ "$_entry" != "$_line" ] || continue
    [ "$(fold "${_entry%/*}")" = "$_want" ] && printf '%s\n' "$_line"
  done)
  if [ -n "$_rows" ]; then
    printf '%s\n' "$_rows"
  else
    printf 'nobody: no session on box "%s" is available to this one\n' "$1"
  fi
  exit 0
}

cmd_send() {
  case $# in 1|2) ;; *) usage ;; esac
  _target=$1
  ready
  if [ "$#" = 2 ]; then take_body 1 "$2"; else take_body 0; fi
  ONCE='ask the operator, or look for an answer with "tmx inbox"'
  request POST /v1/threads 30 --data-urlencode "to=$_target"
  finish
}

cmd_reply() {
  case $# in 1|2) ;; *) usage ;; esac
  is_thread "$1" || fail 'not a thread id (t- and 8 letters or digits)'
  _thread=$1
  ready
  if [ "$#" = 2 ]; then take_body 1 "$2"; else take_body 0; fi
  ONCE="run \"tmx read $_thread\""
  request POST "/v1/threads/$_thread/messages" 30
  finish
}

cmd_read() {
  [ "$#" = 1 ] || usage
  is_thread "$1" || fail 'not a thread id (t- and 8 letters or digits)'
  ready
  request GET "/v1/threads/$1" 30
  finish
}

cmd_inbox() {
  [ "$#" = 0 ] || usage
  ready
  request GET /v1/inbox 30
  finish
}

cmd_wait() {
  _threads= _secs=90
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -t ]; then
      [ "$#" -ge 2 ] || usage
      case $2 in
        ''|*[!0-9]*) fail 'the -t value is not a whole number of seconds' ;;
      esac
      [ "${#2}" -le 6 ] || fail 'the -t value is not a whole number of seconds'
      _secs=${2#"${2%%[!0]*}"} # no leading zeros: shell arithmetic would read them as octal
      _secs=${_secs:-0}
      shift 2
      continue
    fi
    is_thread "$1" || fail 'not a thread id (t- and 8 letters or digits)'
    _threads=${_threads:+$_threads,}$1
    shift
  done
  [ -n "$_threads" ] || usage
  ready
  request GET /v1/replies $((_secs + 30)) --data-urlencode "threads=$_threads" --data-urlencode "timeout=$_secs"
  finish
}

# ---- hook-wait ----

LOCK= OWN= CHILD= CLAUDE= WATCH=

# Sets PARENT to the parent pid of process $1 from /proc/$1/stat: the second field after the
# last `)` (the command name before it may hold spaces and parentheses). Fails when unreadable.
parent_of() {
  PARENT=
  [ "${TMUXIFIER_MAIL_TEST_NO_PROC:-}" = 1 ] && return 1
  _st=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  _st=${_st##*)}
  set -- $_st
  case ${2:-} in ''|*[!0-9]*) return 1 ;; esac
  PARENT=$2
}

# Sets CLAUDE (the Claude Code that started this waiter) and WATCH (the process whose parent
# it is); both empty when that cannot be known.
find_claude() {
  CLAUDE= WATCH=
  parent_of "$$" || return 0
  _p=$PARENT
  if grep -q hook-wait "/proc/$_p/cmdline" 2>/dev/null; then
    parent_of "$_p" || return 0
    WATCH=$_p
  else
    WATCH=$$
  fi
  case $PARENT in 0|1) return 0 ;; esac
  CLAUDE=$PARENT
}

# True when the Claude Code this waiter belongs to is known and gone: the watched process has
# a different parent now (re-parented after Claude Code died), or is gone itself.
orphaned() {
  [ -n "$CLAUDE" ] || return 1
  parent_of "$WATCH" || return 0
  [ "$PARENT" != "$CLAUDE" ]
}

# True when this waiter's Claude Code runs under process $1 (a `claude -p` started from the
# Bash tool of the Claude Code that owns the lock inherits its pane and its hooks), or when that
# cannot be told: the walk up the parents fails or takes more than 64 steps.
descends_from() {
  _a=$CLAUDE _n=0
  while [ "$_a" -gt 1 ]; do
    [ "$_n" -lt 64 ] || return 0
    parent_of "$_a" || return 0
    _a=$PARENT _n=$((_n + 1))
    [ "$_a" = "$1" ] && return 0
  done
  return 1
}

# Sets OWNER to the pid in the lock (empty when there is none or it is not a number).
lock_owner() {
  OWNER=
  { read -r OWNER < "$LOCK/pid"; } 2>/dev/null
  case $OWNER in ''|*[!0-9]*) OWNER= ;; esac
}

# A live hook-wait: the pid exists and, where /proc can tell, is still a hook-wait.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  grep -q hook-wait "/proc/$1/cmdline" 2>/dev/null
}

claim() {
  mkdir "$LOCK" 2>/dev/null || return 1
  OWN=1
  case ${TMUXIFIER_MAIL_TEST_CLAIM_PAUSE:-} in
    ''|*[!0-9.]*) ;;
    *) sleep "$TMUXIFIER_MAIL_TEST_CLAIM_PAUSE" ;;
  esac
  [ -z "$CLAUDE" ] || printf '%s\n' "$CLAUDE" > "$LOCK/claude"
  printf '%s\n' "$$" > "$LOCK/pid"
  # The writes can fail into a directory a dying predecessor's cleanup just removed; the loop's
  # lock check then finds no pid and reclaims it.
  return 0
}

# The loop's lock check. 0: the lock names this waiter, or it had lost its directory (gone, or
# present without a pid, or naming a dead waiter) and reclaimed it. 1: another live waiter
# holds it, or three attempts did not settle it: stand down, leaving the lock alone. A reclaim
# never takes a lock from a live waiter, so two waiters can never take it from each other here.
hold_lock() {
  _try=0
  while [ "$_try" -lt 3 ]; do
    _try=$((_try + 1))
    lock_owner
    [ "$OWNER" = "$$" ] && return 0
    if [ ! -d "$LOCK" ]; then
      claim # lost to whoever made it first, if anyone: the next attempt reads it
      continue
    fi
    if [ -z "$OWNER" ]; then
      # Its owner may be between mkdir and writing its pid: give it a moment.
      sleep "$(pace 1)"
      lock_owner
      [ "$OWNER" = "$$" ] && return 0
    fi
    [ -n "$OWNER" ] && alive "$OWNER" && return 1
    # Still without a pid after the grace, or naming a dead waiter: stale.
    rm -f "$LOCK/pid" "$LOCK/claude" "$LOCK/resp" "$LOCK/code" 2>/dev/null
    rmdir "$LOCK" 2>/dev/null
  done
  lock_owner
  [ "$OWNER" = "$$" ]
}

take_lock() {
  claim && return 0
  lock_owner
  if [ -z "$OWNER" ]; then
    # Its owner may be between mkdir and writing its pid: give it a moment.
    sleep "$(pace 1)"
    lock_owner
  fi
  if [ -n "$OWNER" ] && alive "$OWNER"; then
    # A live owner keeps the lock unless it belongs to a Claude Code that is gone, or to
    # another one than this waiter's (a new Claude Code in the same pane wins).
    _oc=
    { read -r _oc < "$LOCK/claude"; } 2>/dev/null
    case $_oc in ''|*[!0-9]*) return 1 ;; esac
    if kill -0 "$_oc" 2>/dev/null; then
      [ -n "$CLAUDE" ] && [ "$_oc" != "$CLAUDE" ] || return 1
      descends_from "$_oc" && return 1
    fi
  fi
  rm -f "$LOCK/pid" "$LOCK/claude" "$LOCK/resp" "$LOCK/code" 2>/dev/null
  rmdir "$LOCK" 2>/dev/null
  claim
}

cleanup() {
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
    CHILD=
  fi
  if [ -n "$OWN" ]; then
    OWN=
    lock_owner
    # Only a lock that names this waiter: a lock with no pid may be a successor's, between its
    # mkdir and its pid write (one this waiter never finished writing is taken over after the
    # 1 s grace). The check and the delete are two steps, so a successor that takes the lock
    # over between them can still lose its directory here; its next lock check (hold_lock)
    # finds the directory gone and reclaims it.
    if [ "$OWNER" = "$$" ]; then
      case ${TMUXIFIER_MAIL_TEST_CLEANUP_PAUSE:-} in
        ''|*[!0-9.]*) ;;
        *) sleep "$TMUXIFIER_MAIL_TEST_CLEANUP_PAUSE" ;;
      esac
      rm -f "$LOCK/pid" "$LOCK/claude" "$LOCK/resp" "$LOCK/code" 2>/dev/null
      rmdir "$LOCK" 2>/dev/null
    fi
  fi
}

# Runs a command in the background and waits for it, so a trapped signal interrupts the wait.
hold() {
  "$@" 3>&- &
  CHILD=$!
  wait "$CHILD"
  _rc=$?
  CHILD=
  return $_rc
}

hook_wait() {
  # stderr is the wake channel (Claude Code shows all of it on exit 2): only the wake text goes
  # out, on fd 3; every diagnostic of the shell or a tool lands in /dev/null.
  exec 3>&2 >/dev/null 2>/dev/null
  in_tmux || exit 0
  command -v curl >/dev/null 2>&1 || exit 0
  session_now || exit 0
  [ -n "${HOME:-}" ] || exit 0
  mkdir -p "$HOME/.tmuxifier-mail" 2>/dev/null || exit 0
  LOCK=$HOME/.tmuxifier-mail/wait.$PANE_DIGITS.lock
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  find_claude
  take_lock || exit 0
  _delay=2
  while :; do
    # Orphaned: the Claude Code that started this waiter is gone.
    orphaned && exit 0
    # Taken over: stand down and leave the lock to its owner (or reclaim a lost directory).
    hold_lock || { OWN=; exit 0; }
    session_now # a renamed session is followed; on failure the last name is kept
    rm -f "$LOCK/resp" "$LOCK/code" 2>/dev/null
    hold curl -q -s --noproxy '*' --unix-socket "$SOCK" -m 330 -G -o "$LOCK/resp" -w '%{http_code}' \
      --data-urlencode "session=$SESSION" --data-urlencode "pane=$TMUX_PANE" "$URL/v1/wait" \
      > "$LOCK/code" 2>/dev/null </dev/null
    _rc=$?
    # Taken over while the request was held: the files in the lock are no longer this waiter's.
    # A directory lost meanwhile is reclaimed empty, so the answer below reads as a failure and
    # the request is made again (the hub offers a message handed on this pane again).
    hold_lock || { OWN=; exit 0; }
    _code=
    { read -r _code < "$LOCK/code"; } 2>/dev/null
    if [ "$_rc" = 0 ]; then
      if [ "$_code" = 200 ] && [ -s "$LOCK/resp" ]; then
        cat "$LOCK/resp" >&3
        exit 2
      fi
      if [ "$_code" = 204 ]; then
        _delay=2
        continue
      fi
    fi
    hold sleep "$(pace "$_delay")"
    _delay=$((_delay * 2))
    [ "$_delay" -le 30 ] || _delay=30
  done
}

# ---- hook-ack ----

hook_ack() {
  exec >/dev/null 2>&1
  _payload=$(cat)
  case $_payload in
    *'[tmuxifier-mail m-'*) ;;
    *) exit 0 ;;
  esac
  in_tmux || exit 0
  command -v curl >/dev/null 2>&1 || exit 0
  session_now || exit 0
  _ids=$(printf '%s' "$_payload" | grep -o "\\[tmuxifier-mail m-$ID_BRE\\]" | sed 's/^\[tmuxifier-mail //; s/\]$//' | sort -u)
  _n=0
  for _m in $_ids; do
    _n=$((_n + 1))
    [ "$_n" -le 16 ] || break
    curl -q -s --noproxy '*' --unix-socket "$SOCK" -m 3 -o /dev/null \
      --data-urlencode "session=$SESSION" --data-urlencode "m=$_m" "$URL/v1/ack" </dev/null
  done
  exit 0
}

case ${1:-} in
  who|send|reply|wait|read|inbox)
    _cmd=$1
    shift
    "cmd_$_cmd" "$@"
    ;;
  hook-wait) hook_wait ;;
  hook-ack) hook_ack ;;
  *) usage ;;
esac
