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
#                                            when there is no socket file (messaging is not
#                                            turned on for this box: said at once, no retry),
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
#                   The lock holds the owner's pid and, when known, its Claude pid. Every read of
#                   the lock and every action on it goes through one decision table
#                   (`lock_decide`, at start, at the top of each turn and after each held
#                   request; the table is above it). In short: an orphan never claims, reclaims
#                   or removes a lock; an absent, pid-less or dead-owner lock, or one whose
#                   owner's Claude Code is gone, is cleared and claimed; a newcomer under another
#                   live Claude Code takes over (the newest Claude Code in a pane wins), while a
#                   second waiter of the same Claude Code, one whose Claude Code runs under the
#                   owner's (a `claude -p` from the owner's Bash tool inherits the pane and the
#                   hooks) or one that cannot tell, stands down; a holder never takes the lock
#                   back from a live waiter of a live Claude Code. A claim that loses the mkdir
#                   decides again, for at most 3 passes, then stands down. A waiter's exit
#                   cleanup removes the lock only when it names the waiter; that check and the
#                   delete are two steps, so a successor can lose its new directory to a dying
#                   predecessor's cleanup, and its next decision claims it again.
#                   Before any of that, a waiter whose Claude Code has no controlling terminal
#                   and is known not to run under the pane's first process (`foreign`: a
#                   `claude -p` left in the background and re-parented away, which still carries
#                   the pane's $TMUX_PANE) exits 0 without reading the lock.
#   tmx hook-ack    Claude Code UserPromptSubmit hook. Confirms each distinct
#                   [tmuxifier-mail m-xxxxxxxx] tag in the prompt with POST /v1/ack. Its stdout
#                   would become prompt context, so it prints nothing on either stream and always
#                   exits 0. Under a `foreign` Claude Code it confirms nothing.
#
# Who is calling. A caller is a tmux pane: $TMUX_PANE (with $TMUX set), the pane of the agent's
# own shell. Under OpenCode that is wrong: the agent's shell commands run from OpenCode's one
# shared server, whose environment is the first TUI's forever, so the Tmuxifier plugin tags each
# command with its own pane in TMUXIFIER_MAIL_PANE (design 6.9). The user commands (who, send,
# reply, wait, read, inbox; never hook-wait or hook-ack, which Claude Code starts in its own
# pane and which ignore the variable entirely) read it first:
#   unset or empty          under OpenCode (OPENCODE or OPENCODE_TERMINAL non-empty: OpenCode
#                           sets OPENCODE_TERMINAL=1 in every shell it runs, the agent's and the
#                           operator's `!` ones, and OPENCODE=1 in the agent's) refused like
#                           `none` below: $TMUX_PANE there is the first TUI's, never a fallback
#                           (an un-hooked directory, an OpenCode without the hooks, a shell the
#                           plugin did not tag). Elsewhere nothing changes: $TMUX and $TMUX_PANE
#                           decide. (A Claude Code started from an OpenCode shell inherits the
#                           marker and is refused too: fail closed.)
#   a pane id (%N)          replaces $TMUX_PANE, and $TMUX is not required (the server may have
#                           been started outside tmux; tmux then resolves the pane on the server
#                           of $TMUX's socket when $TMUX is set, else on its default server). A
#                           pane tmux cannot resolve is refused like `none`.
#   `none`, or anything     "this agent's tmux session cannot be identified for messaging" on
#   else                    stderr, exit 2, before any argument is read and with no request: the
#                           plugin found no pane for the calling session, so $TMUX_PANE (the first
#                           TUI's) must not stand in for it. A malformed value is `none`.
# Nothing but the pane id's digits is ever used from it, and it is validated like $TMUX_PANE.
#
# Test-only knob (read by nothing else): TMUXIFIER_MAIL_TEST_SLEEP, when set to a number of
# seconds (digits and dots), replaces the duration of every sleep: the 1 s between attempts of a
# user command, the waiter's back-off and its 1 s grace for a lock without a pid.
# TMUXIFIER_MAIL_TEST_MAX_TIME, likewise, replaces curl's -m for every user command (`wait`
# included; not hook-wait's 330 s nor hook-ack's 3 s). TMUXIFIER_MAIL_TEST_NO_PROC=1 makes
# hook-wait read no /proc/<pid>/stat, as on a box without /proc. TMUXIFIER_MAIL_TEST_CLAIM_PAUSE,
# a number of seconds, makes hook-wait sleep between creating its lock and writing its pid;
# TMUXIFIER_MAIL_TEST_CLEANUP_PAUSE, likewise, between its exit cleanup's check that the lock
# names it and the delete; TMUXIFIER_MAIL_TEST_CLEAR_PAUSE between clearing a stale lock
# (its rmdir) and claiming it (its mkdir).

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
  tmx send [--fresh [--project <name>]] <target> ["text"]
                                     start a thread; text from the argument or stdin; prints the id
                                     --fresh starts a new agent on the box
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

# A usage error with its own words: exit 2, before any request.
misuse() {
  printf 'tmx: %s\n' "$1" >&2
  exit 2
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

# A pane id: % and 1 to 9 digits. Nothing else is ever used to name a pane.
valid_pane() {
  case $1 in
    %*) _d=${1#%} ;;
    *) return 1 ;;
  esac
  case $_d in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#_d}" -le 9 ]
}

# Inside tmux: TMUX set and TMUX_PANE a pane id (%N, at most 9 digits), or, for a user command
# the plugin tagged, VIA_PANE (TMUXIFIER_MAIL_PANE's pane id, see mail_pane) with no TMUX needed.
# Sets PANE (the pane id) and PANE_DIGITS.
VIA_PANE= # never from the environment
in_tmux() {
  if [ -n "$VIA_PANE" ]; then
    PANE=$VIA_PANE
  else
    [ -n "${TMUX:-}" ] || return 1
    PANE=${TMUX_PANE:-}
  fi
  valid_pane "$PANE" || return 1
  PANE_DIGITS=${PANE#%}
}

# Sets SESSION to this pane's tmux session; fails (SESSION unchanged) when tmux cannot say.
session_now() {
  _s=$(tmux display-message -p -t "$PANE" '#{session_name}' 2>/dev/null) || return 1
  [ -n "$_s" ] || return 1
  SESSION=$_s
}

unidentified() {
  printf "tmx: this agent's tmux session cannot be identified for messaging\n" >&2
  exit 2
}

# User commands only: TMUXIFIER_MAIL_PANE (see the header) names the calling pane, or refuses.
mail_pane() {
  if [ -z "${TMUXIFIER_MAIL_PANE:-}" ]; then
    [ -z "${OPENCODE:-}${OPENCODE_TERMINAL:-}" ] || unidentified
    return 0
  fi
  valid_pane "$TMUXIFIER_MAIL_PANE" || unidentified
  VIA_PANE=$TMUXIFIER_MAIL_PANE
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
# without an answer (52/56: what an ssh forward whose far end is down gives). No connection with
# no socket file at all is not a wait: Tmuxifier puts the file there when messaging is turned on
# for the box and removes it when it is turned off, so the agent is told that, at once, exit 3
# (a file that is there and does not answer is the unreachable case, with its retries). With ONCE set (a
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
      7)
        if [ ! -e "$SOCK" ]; then
          printf 'tmx: agent messaging is not turned on for this box; tell your operator\n' >&2
          exit 3
        fi
        ;;
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
  if [ -n "$VIA_PANE" ]; then
    in_tmux && session_now || unidentified
  else
    in_tmux && session_now || { printf 'tmx: run this inside a tmux session\n' >&2; exit 2; }
  fi
  command -v curl >/dev/null 2>&1 || fail 'curl is not installed'
}

cmd_who() {
  [ "$#" -le 1 ] || usage
  ready
  request GET /v1/who 30
  case $CODE in 2??) ;; *) finish ;; esac
  [ "$#" = 1 ] || finish
  # Only the lines of that box. A session row is "<box>/<session>  <state>, ..." and sessions
  # never contain a "/", so its box is all before the last "/". A starter line is
  # "<box>  can start an agent (...)": its box is the whole first field, a "/" in a label
  # included.
  _want=$(fold "$1")
  _rows=$(printf '%s' "$RESP" | while IFS= read -r _line; do
    _entry=${_line%%"  "*}
    [ "$_entry" != "$_line" ] || continue
    case ${_line#*"  "} in
      'can start an agent ('*) _box=$_entry ;;
      *) _box=${_entry%/*} ;;
    esac
    [ "$(fold "$_box")" = "$_want" ] && printf '%s\n' "$_line"
  done)
  if [ -n "$_rows" ]; then
    printf '%s\n' "$_rows"
  else
    printf 'nobody: no session on box "%s" is available to this one\n' "$1"
  fi
  exit 0
}

# tmx send [--fresh [--project <name>]] <target> ["text"]. --fresh asks the box for a new agent
# (the `fresh` field: empty, or the project name). The name is checked here for its characters,
# its first one and its length, as a courtesy that says so before any request: the listener is
# the authority (PROJECT_NAME_RE). An option after the target is refused rather than sent as the
# message text (only an argument that is exactly `--fresh` or `--project`: a text that merely
# starts with one is a text).
cmd_send() {
  _fresh= _project= _named=
  while [ "$#" -gt 0 ]; do
    case $1 in
      --fresh)
        [ -z "$_fresh" ] || misuse '--fresh is given more than once'
        _fresh=1
        shift
        ;;
      --project)
        [ "$#" -ge 2 ] || misuse '--project needs a project name'
        case $2 in -*) misuse '--project needs a project name' ;; esac
        [ -z "$_named" ] || misuse '--project is given more than once'
        case $2 in
          ''|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*)
            misuse 'a project name is lower-case letters, digits and -, at most 24 characters' ;;
        esac
        [ "${#2}" -le 24 ] || misuse 'a project name is lower-case letters, digits and -, at most 24 characters'
        _named=1 _project=$2
        shift 2
        ;;
      *) break ;;
    esac
  done
  case $# in 1|2) ;; *) usage ;; esac
  if [ "$#" = 2 ]; then
    case $2 in --fresh|--project) misuse 'options come before the target' ;; esac
  fi
  _target=$1
  if [ -n "$_named" ] && [ -z "$_fresh" ]; then
    misuse '--project goes with --fresh: tmx send --fresh --project <name> <box> ["text"]'
  fi
  case $_target in
    */*) [ -z "$_fresh" ] || misuse '--fresh takes a box name, not box/session' ;;
  esac
  ready
  if [ "$#" = 2 ]; then take_body 1 "$2"; else take_body 0; fi
  ONCE='ask the operator, or look for an answer with "tmx inbox"'
  if [ -n "$_fresh" ]; then
    request POST /v1/threads 30 --data-urlencode "to=$_target" --data-urlencode "fresh=$_project"
  else
    request POST /v1/threads 30 --data-urlencode "to=$_target"
  fi
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
# Also sets TTY_NR, the fifth: the process's controlling terminal, 0 when it has none.
parent_of() {
  PARENT= TTY_NR=
  [ "${TMUXIFIER_MAIL_TEST_NO_PROC:-}" = 1 ] && return 1
  _st=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  _st=${_st##*)}
  set -- $_st
  case ${2:-} in ''|*[!0-9]*) return 1 ;; esac
  PARENT=$2 TTY_NR=${5:-}
}

# Sets CLAUDE (the Claude Code that started this hook) and WATCH (the process whose parent
# it is); both empty when that cannot be known. $1 is the hook's name, `hook-wait` or
# `hook-ack`: the word a `sh -c` wrapper's command line carries.
find_claude() {
  CLAUDE= WATCH=
  parent_of "$$" || return 0
  _p=$PARENT
  if grep -q "$1" "/proc/$_p/cmdline" 2>/dev/null; then
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

# Walks up the parents of this hook's Claude Code looking for process $1. Sets WALK: `yes`
# when $1 is that Claude Code or one of its ancestors, `no` when the walk reaches init without
# meeting it, `unknown` when a parent cannot be read or after 64 steps.
walk_to() {
  _a=$CLAUDE _n=0 WALK=unknown
  while [ "$_a" != "$1" ]; do
    case $_a in 0|1) WALK=no; return 0 ;; esac
    [ "$_n" -lt 64 ] || return 0
    parent_of "$_a" || return 0
    _a=$PARENT _n=$((_n + 1))
  done
  WALK=yes
}

# True when this waiter's Claude Code runs under process $1 (a `claude -p` started from the
# Bash tool of the Claude Code that owns the lock inherits its pane and its hooks), or when that
# cannot be told.
descends_from() {
  walk_to "$1"
  [ "$WALK" != no ]
}

# True only when this hook's Claude Code is known NOT to be the pane's own: it has no
# controlling terminal, and the walk up its parents reaches init without meeting the pane's
# first process (`#{pane_pid}`). Everything started in a pane inherits $TMUX and $TMUX_PANE, so
# a `claude -p` that a plugin or a script left running in the background, re-parented away
# from the pane, fires these hooks as if it were the pane's Claude Code: its waiter would take
# the lock from the real one and then die with its Claude Code, leaving the pane with no waiter
# until the next turn. False when anything cannot be told (no Claude pid, no pane pid from
# tmux, an unreadable /proc), and for a Claude Code with a terminal of its own: an interactive
# one under screen or dtach started in the pane hangs off init too.
foreign() {
  [ -n "$CLAUDE" ] || return 1
  parent_of "$CLAUDE" || return 1
  [ "$TTY_NR" = 0 ] || return 1
  _pp=$(tmux display-message -p -t "$PANE" '#{pane_pid}' 2>/dev/null) || return 1
  case $_pp in ''|*[!0-9]*) return 1 ;; esac
  walk_to "$_pp"
  [ "$WALK" = no ]
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

# Makes the lock directory and writes this waiter's Claude pid and pid into it. 1 when the
# directory already exists. 0 once the mkdir succeeded, even when a write then fails into a
# directory that a dying predecessor's cleanup removed in between: the next lock decision finds
# the directory gone and claims it again.
claim() {
  mkdir "$LOCK" 2>/dev/null || return 1
  OWN=1
  case ${TMUXIFIER_MAIL_TEST_CLAIM_PAUSE:-} in
    ''|*[!0-9.]*) ;;
    *) sleep "$TMUXIFIER_MAIL_TEST_CLAIM_PAUSE" ;;
  esac
  [ -z "$CLAUDE" ] || printf '%s\n' "$CLAUDE" > "$LOCK/claude"
  printf '%s\n' "$$" > "$LOCK/pid"
  return 0
}

# Removes a stale lock and claims it: 0 when this waiter got the directory, 1 when another
# waiter made it first (the caller then decides again on what is there now).
clear_and_claim() {
  orphaned && exit 0
  rm -f "$LOCK/pid" "$LOCK/claude" "$LOCK/resp" "$LOCK/code" 2>/dev/null
  rmdir "$LOCK" 2>/dev/null
  case ${TMUXIFIER_MAIL_TEST_CLEAR_PAUSE:-} in
    ''|*[!0-9.]*) ;;
    *) sleep "$TMUXIFIER_MAIL_TEST_CLEAR_PAUSE" ;;
  esac
  orphaned && exit 0
  claim
}

# The lock decision: the one place that reads the lock and acts on it. $1 is who is looking:
# `new` (a waiter that has never held the lock, at start) or `held` (a waiter that
# holds it, at the top of each turn and after each held request). 0: this waiter holds the lock
# now; 1: stand down, leaving the lock alone. An orphan (its Claude Code gone) exits 0 at once,
# before reading anything, and again right before any removal or claim, so it never claims,
# reclaims or removes a lock; its exit cleanup removes only a lock that names it.
#
#   lock state                                    new                  held
#   absent                                        claim                claim
#   present, no pid (after a 1 s grace)           clear, claim         clear, claim
#   names this waiter                             (held)               keep
#   names a dead waiter                           clear, claim         clear, claim
#   live waiter, no Claude pid recorded           stand down           stand down
#   live waiter, its Claude Code gone             clear, claim         clear, claim
#   live waiter, this waiter has no Claude pid    stand down           stand down
#   live waiter of the same Claude Code           stand down           stand down
#   live waiter of an ancestor Claude Code
#     (or the walk up cannot tell)                stand down           stand down
#   live waiter of another live Claude Code       clear, claim         stand down
#
# "Live waiter" is `alive`; "gone" is `kill -0` on the recorded Claude pid. A newcomer under
# another live Claude Code takes over (the newest Claude Code in a pane wins), and a holder never
# takes back from a live waiter whose Claude Code is alive, so two waiters never take it from
# each other. A claim that loses the mkdir to another waiter reads the lock again and decides
# on what is there now, for at most 3 passes; when 3 passes do not settle it, the waiter stands
# down. A clear is a check and then a delete: two live waiters clearing the same stale lock at
# once can delete each other's new directory, and the loser's next decision claims it again.
lock_decide() {
  _pass=0
  while [ "$_pass" -lt 3 ]; do
    _pass=$((_pass + 1))
    orphaned && exit 0
    lock_owner
    [ "$OWNER" = "$$" ] && return 0
    if [ ! -d "$LOCK" ]; then
      claim && return 0
      continue
    fi
    if [ -z "$OWNER" ]; then
      # Its owner may be between mkdir and writing its pid: give it a moment.
      sleep "$(pace 1)"
      lock_owner
      [ "$OWNER" = "$$" ] && return 0
    fi
    if [ -n "$OWNER" ] && alive "$OWNER"; then
      _oc=
      { read -r _oc < "$LOCK/claude"; } 2>/dev/null
      case $_oc in ''|*[!0-9]*) return 1 ;; esac
      if kill -0 "$_oc" 2>/dev/null; then
        [ "$1" = new ] || return 1
        [ -n "$CLAUDE" ] || return 1
        [ "$_oc" != "$CLAUDE" ] || return 1
        descends_from "$_oc" && return 1
      fi
    fi
    clear_and_claim && return 0
  done
  return 1
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
    # over between them can still lose its directory here; its next lock decision finds the
    # directory gone and claims it again.
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
  find_claude hook-wait
  foreign && exit 0
  lock_decide new || exit 0
  _delay=2
  while :; do
    # Orphaned: exit. Taken over: stand down and leave the lock to its owner. Lost: claim again.
    lock_decide held || { OWN=; exit 0; }
    session_now # a renamed session is followed; on failure the last name is kept
    rm -f "$LOCK/resp" "$LOCK/code" 2>/dev/null
    hold curl -q -s --noproxy '*' --unix-socket "$SOCK" -m 330 -G -o "$LOCK/resp" -w '%{http_code}' \
      --data-urlencode "session=$SESSION" --data-urlencode "pane=$PANE" "$URL/v1/wait" \
      > "$LOCK/code" 2>/dev/null </dev/null
    _rc=$?
    # The same decision after the held request: orphaned, taken over, or lost meanwhile. A
    # directory claimed again is empty, so the answer below reads as a failure and the request
    # is made again (the hub offers a message handed on this pane again).
    lock_decide held || { OWN=; exit 0; }
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
  find_claude hook-ack
  foreign && exit 0
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
    mail_pane
    _cmd=$1
    shift
    "cmd_$_cmd" "$@"
    ;;
  hook-wait) hook_wait ;;
  hook-ack) hook_ack ;;
  *) usage ;;
esac
