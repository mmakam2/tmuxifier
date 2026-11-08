#!/usr/bin/env python3
# Tmuxifier OSC 7501 pane reporter (installed by box setup; safe to delete — the
# next setup run reinstalls it). Turns OSC 7501 "Program Status" sequences in
# tmux pane output into the agent-state markers the Tmuxifier status probe reads:
# ~/.tmuxifier-agent/<session>, one line <session>:<state>:<epoch>:<cause>.
# Interpolates nothing from the server; stdlib only.
#
# Roles (argv[1]):
#   listen %N   a `tmux pipe-pane` reader for one pane: parses OSC 7501 from the
#               pane's raw bytes, folds the records, writes the session marker.
#   loop        one resident process per box: attaches/detaches listeners by
#               pane_current_command every 2 s.
#   sweep       what the status probe runs each poll: one attach pass, and keeps
#               a loop of the current asset version alive.
# This file's pure core (extract, parse_report, Records, next_action,
# session_fold, PaneReader) is importable with no side effects; the roles live
# in main(). The registry entry shared by loop and listener, and the version
# handover that moves a pane from one listener to the next without losing the
# fold, are specified in the "handover protocol" block above run_listen; the
# loop's rules for whose pipe it may open or close are above the loop role.
#
# Why pipe-pane: tmux receives the pane bytes through pipe-pane BEFORE its own
# parser, so OSC 7501 arrives intact (either terminator), while tmux itself
# drops the sequence and answers DA1 on its own. Programs that probe first
# (OSC 7501 ; ? then DA1) therefore conclude "unsupported" inside tmux and stay
# silent — Claude Code is one; its state belongs to the hook. Programs that
# report unprobed (Codex, pi with PI_PROGRAM_STATUS=1, OpenCode) are visible.
#
# Caveat: OpenCode's root record aggregates EVERY session of the user's shared
# `opencode serve`, so a root `blocked` may belong to a pane that no longer
# exists; it is folded as reported. The OpenCode plugin is the better writer
# and takes precedence whenever it is installed.
#
# Fail open: the reporter never writes to the pane, never raises out of its
# loops, and prints nothing unless TMUXIFIER_OSC_DEBUG=1.
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time

# Spec 0.4 limits (see the plan's Global Constraints).
TAIL_CAP = 4096
STATES = frozenset(('idle', 'working', 'done', 'blocked', 'error', 'clear'))
KINDS = frozenset(('permission', 'question', 'auth'))
OSC_AGENTS = {'codex': r'^codex(-|$)', 'pi': r'^pi(-|$)', 'opencode': r'^opencode(-|$)'}

KIND_CAUSE = {'permission': 'permission', 'question': 'question', 'auth': 'elicitation', None: 'permission'}
CAUSE_KIND = {'permission': 'permission', 'question': 'question', 'elicitation': 'auth'}

_START = b'\x1b]7501;'
_BODY_BYTES = frozenset(b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.,+/=:-')
_ID_SEG_BYTES = frozenset(b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.+-')


def _partial_prefix_len(buf):
    """Length of the longest suffix of buf that is a proper prefix of _START."""
    for k in range(min(len(_START) - 1, len(buf)), 0, -1):
        if buf.endswith(_START[:k]):
            return k
    return 0


def extract(buf):
    """Return (bodies, tail): every complete OSC 7501 body in order, plus the
    unconsumed trailing partial to carry to the next read."""
    bodies = []
    pos = 0
    n = len(buf)
    while True:
        start = buf.find(_START, pos)
        if start < 0:
            k = _partial_prefix_len(buf[pos:])
            return bodies, (buf[n - k:] if k else b'')
        body_start = start + len(_START)
        j = body_start
        outcome = 'partial'  # ran off the end of the buffer
        while j < n:
            c = buf[j]
            if c == 0x07:
                outcome, end = 'done', j + 1
                break
            if c == 0x1b:
                if j + 1 >= n:
                    break  # lone trailing ESC: may be the first half of ST
                if buf[j + 1] == 0x5c:
                    outcome, end = 'done', j + 2
                    break
                outcome = 'abort'  # any other ESC ends this sequence
                break
            j += 1
            if j - body_start > TAIL_CAP:
                outcome = 'overflow'
                break
        if outcome == 'done':
            bodies.append(buf[body_start:j])
            pos = end
        elif outcome in ('abort', 'overflow'):
            pos = j
        else:
            return bodies, buf[start:]


def _valid_id(s):
    if s == '':
        return True
    if len(s.encode()) > 128:
        return False
    segs = s.split('/')
    if len(segs) > 8:
        return False
    for seg in segs:
        if not 1 <= len(seg) <= 32 or not all(ord(ch) in _ID_SEG_BYTES for ch in seg):
            return False
    return True


def parse_report(body):
    """Parse one OSC 7501 body into a report dict, or None to ignore it."""
    if body == b'?' or not body:
        return None
    if any(b not in _BODY_BYTES for b in body):
        return None
    kv = {}
    for pair in body.decode('ascii').split(':'):
        if '=' not in pair:
            continue
        k, v = pair.split('=', 1)
        k, v = k.strip(), v.strip()
        if k:
            kv[k] = v
    state = kv.get('state')
    if state not in STATES:
        return None
    rid = kv.get('id', '')
    if not _valid_id(rid):
        return None
    kind = kv.get('kind')
    app = kv.get('app')
    if app is not None and not (1 <= len(app) <= 32 and all(ord(ch) in _ID_SEG_BYTES for ch in app)):
        app = None
    return {'state': state, 'id': rid, 'kind': kind if kind in KINDS else None, 'app': app}


class Records:
    """One pane's OSC 7501 records: id -> {state, kind} (root id is '')."""

    def __init__(self):
        self.recs = {}

    def apply(self, report):
        rid = report['id']
        if report['state'] == 'clear':
            if rid == '':
                self.recs.clear()
            else:
                prefix = rid + '/'
                for k in [k for k in self.recs if k == rid or k.startswith(prefix)]:
                    del self.recs[k]
            return
        self.recs[rid] = {'state': report['state'], 'kind': report['kind']}

    def fold(self):
        for r in self.recs.values():
            if r['state'] == 'blocked':
                return ('blocked', r['kind'])
        for r in self.recs.values():
            if r['state'] == 'working':
                return ('working', None)
        return ('idle', None)

    def to_json(self):
        return {k: {'state': r['state'], 'kind': r['kind']} for k, r in self.recs.items()}

    @classmethod
    def from_json(cls, d):
        out = cls()
        if not isinstance(d, dict):
            return out
        for k, r in d.items():
            if (isinstance(k, str) and isinstance(r, dict) and _valid_id(k)
                    and r.get('state') in STATES and r.get('state') != 'clear'
                    and (r.get('kind') is None or r.get('kind') in KINDS)):
                out.recs[k] = {'state': r['state'], 'kind': r.get('kind')}
        return out


def session_fold(folds):
    """Blocked (first blocked's kind) > working > idle across pane folds."""
    for state, kind in folds:
        if state == 'blocked':
            return ('blocked', kind)
    for state, _ in folds:
        if state == 'working':
            return ('working', None)
    return ('idle', None)


def next_action(marker, new):
    """Spec 5.3 table. marker = (state, cause) of the session's current marker
    file or None; the marker is the only memory. Returns ('write', state, cause)
    or None. Removal (bare clear, EOF) is the caller's decision."""
    cur = marker[0] if marker else None
    state, kind = new
    if state == 'working':
        if cur == 'blocked':
            return ('write', 'working', 'unblock')
        if cur == 'working':
            return None
        return ('write', 'working', 'prompt')
    if state == 'blocked':
        if cur == 'blocked' and CAUSE_KIND.get(marker[1]) == (kind or 'permission'):
            return None
        return ('write', 'blocked', KIND_CAUSE.get(kind, 'permission'))
    if cur in ('working', 'blocked'):
        return ('write', 'ready', 'stop')
    if cur == 'ready':
        return None
    return ('write', 'ready', 'start')


# ---------------------------------------------------------------- box I/O

def debug(home, msg):
    """Append a line to ~/.tmuxifier-osc/log, only under TMUXIFIER_OSC_DEBUG=1."""
    if os.environ.get('TMUXIFIER_OSC_DEBUG') != '1':
        return
    try:
        d = os.path.join(home, '.tmuxifier-osc')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'log'), 'a') as f:
            f.write('%d %s\n' % (time.time(), msg))
    except Exception:
        pass


def asset_sha():
    """sha256 hex of this asset's own bytes."""
    with open(os.path.abspath(__file__), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def entry_path(home, pane_id):
    return os.path.join(home, '.tmuxifier-osc', 'panes', pane_id.lstrip('%'))


def read_entry(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _atomic_write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.%d.tmp' % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644 if mode is None else mode)
    try:
        if mode is not None:
            os.fchmod(fd, mode)
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    os.replace(tmp, path)


def write_entry(path, entry):
    _atomic_write(path, json.dumps(entry))


def resolve_session(pane_id):
    """The pane's current tmux session name, or None on any failure. A pane of
    a window shared by grouped sessions resolves to the most recently used of
    them (tmux's own choice for a bare pane target): the marker then follows
    whichever grouped session the operator last touched."""
    try:
        r = subprocess.run(['tmux', 'display-message', '-p', '-t', pane_id, '#{session_name}'],
                           capture_output=True, timeout=5)
        if r.returncode != 0:
            return None
        name = r.stdout.decode('utf-8', 'replace').rstrip('\n')
        return name or None
    except Exception:
        return None


def marker_path(home, session):
    return os.path.join(home, '.tmuxifier-agent', re.sub(r'[^A-Za-z0-9._-]', '_', session))


def read_marker(path):
    """(state, cause) from the marker's first line, or None."""
    try:
        with open(path) as f:
            parts = f.readline().rstrip('\n').split(':')
        if len(parts) >= 4:
            return (parts[1], parts[3])
    except Exception:
        pass
    return None


def read_marker_state(path):
    m = read_marker(path)
    return m[0] if m else None


def write_marker(path, session, state, cause):
    """Write the hook's marker format byte for byte; returns the content."""
    content = '%s:%s:%d:%s\n' % (session, state, int(time.time()), cause)
    _atomic_write(path, content, 0o644)
    return content


def _read_text(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return None


def pid_alive(pid):
    """True when pid is a positive int naming a process that exists."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        pass  # EPERM: alive, owned by someone else
    return True


def live_entries(home, session, exclude_pane):
    """Registry entries of other panes in `session` whose listener is alive
    (or being handed over / just attached: unclaimed but inside the grace)."""
    d = os.path.join(home, '.tmuxifier-osc', 'panes')
    out = []
    try:
        names = os.listdir(d)
    except Exception:
        return out
    skip = exclude_pane.lstrip('%')
    for n in names:
        if n == skip or not n.isdigit():
            continue
        e = read_entry(os.path.join(d, n))
        if e.get('session') != session or not entry_live(e):
            continue  # a handed-over entry in grace still carries its pane's records
        out.append(e)
    return out


def _sibling_folds(home, session, pane_id):
    return [Records.from_json(e.get('records')).fold() for e in live_entries(home, session, pane_id)]


def _bare_clear(home, pane_id, session, own_fold, last_written):
    """The program exited. Returns the new lastWritten."""
    if not session:
        return last_written
    mpath = marker_path(home, session)
    sibs = _sibling_folds(home, session, pane_id)
    if not sibs:
        if last_written is not None and _read_text(mpath) == last_written:
            try:
                os.unlink(mpath)
            except FileNotFoundError:
                pass
            return None
        return last_written  # not ours: leave it alone
    act = next_action(read_marker(mpath), session_fold([own_fold] + sibs))
    if act:
        return write_marker(mpath, session, act[1], act[2])
    return last_written


# ------------------------------------------------------ handover protocol
#
# A pane's registry entry (~/.tmuxifier-osc/panes/<N>) is shared by the loop,
# which decides WHICH process reads the pane, and the listener, which reads it.
# A version handover (setup rerun) replaces the listener mid-turn and must lose
# nothing but the bytes in one pipe-pane round trip; the marker file is the
# only memory of the fold, so a predecessor that mistakes the handover for
# "the agent exited" deletes the very state the successor needs.
#
# Fields and who writes them:
#   handover    the LOOP only. True = "I am about to close this pipe on
#               purpose and attach a successor"; written BEFORE the pipe is
#               closed. The listener never sets it True; it clears it (False)
#               only by claiming the entry (below).
#   pid         the LISTENER only, by claiming. The loop never writes a pid;
#               it strips the pid when it hands over (the predecessor's pid is
#               about to be dead and must not look like a corpse to heal).
#   attachedAt  the LOOP stamps it when it creates the entry (attach) and
#               restamps it on a handover; it is the listener's GENERATION
#               token. A listener keeps the stamp it read at start-up and
#               never changes it.
#   sha         both: the loop writes the asset sha it expects the next
#               listener to run; the listener writes the sha it runs.
#   session, records, lastWritten   the listener's fold memory, rewritten on
#               every change; the loop copies them through a handover
#               untouched so the successor seeds from them.
#
# Claiming: at start-up and after every fold change the listener persists its
# state (pid, handover False, attachedAt = its generation) — but under the
# entries lock and only if the entry on disk still carries its generation. An
# entry restamped by the loop (a handover in flight) is never written again
# by that listener. Every read-modify-write of an entry, by loop or listener,
# holds ~/.tmuxifier-osc/entries.lock, and the loop builds its handover
# write from an entry re-read INSIDE the lock (never from the pass's earlier
# unlocked listing), so a claim cannot land between the loop's read and its
# handover write and a predecessor's last persist is never seeded stale.
#
# Handover, loop side, in this order and nothing after step 3:
#   1. write the entry pid-less, handover True, new sha, fresh attachedAt
#      (records/session/lastWritten carried over)        — under the lock
#   2. pipe-pane -t %N        the predecessor reads EOF
#   3. pipe-pane -o %N listen the successor starts, seeds from the entry and
#                             claims it (pid, handover False, same attachedAt)
# If step 2 or 3 fails (tmux refused mid-handover) the entry stays pid-less
# with handover True: it is dropped after ATTACH_GRACE_S and, if the pane
# still matches, re-attached cold (the marker file is consulted as usual).
# Should the pane vanish inside that window, its marker leaks until the
# session's next agent rewrites it — accepted: the alternative is the loop
# deleting markers, which only a listener that wrote one may do.
# The loop's next pass cannot misread the successor as dead: between 1 and the
# claim the entry is pid-less with a fresh attachedAt, which counts as live
# for ATTACH_GRACE_S (30 s, a python start-up is ~30 ms); after the claim the
# pid is alive. The old post-attach "fix up the sha" rewrite is gone: it could
# re-plant the dead predecessor's pid over the successor's claim.
#
# EOF, listener side — re-read the entry under the lock and act on what the
# loop left there, never on the listener's own idea of it:
#   handover True                      a successor is coming (or already
#                                      claimed): keep marker, touch nothing.
#   pid is not mine (absent/another)   superseded: the loop stripped me, or
#                                      a successor claimed — keep marker,
#                                      touch nothing.
#   attachedAt is not my generation    same, even if the pid were still mine.
#   otherwise (pid mine, handover False, my generation) — or NO entry at all
#   (the loop already dropped it for a gone/unpiped pane; it never deletes an
#   entry during a handover)
#                                      a real end (pane gone, detached after
#                                      three non-matching passes): bare-clear
#                                      rule on the marker, delete the entry.
# A listener whose start-up claim failed (disk full) therefore never deletes
# a marker it cannot prove it owns, and a double handover inside one python
# start-up (two reruns within ~50 ms) ends with the middle listener seeing a
# foreign generation and exiting silently.
#
# Attach seed. An OSC agent emits its start-up `idle` 0.4-1.2 s after it
# starts, before the loop's 2 s attach, so a fresh listener usually sees
# nothing until the first `working`; if that first turn runs working →
# blocked inside one ~30 s probe poll, the server's edge detector
# (healthHistory: an event needs a PREVIOUS state) first sees the session
# already `blocked` and never pushes "needs you" for that prompt. The Claude
# hook has no such gap because SessionStart writes ready/start. So a FRESH
# attach — the entry it seeds from has no records and no lastWritten — whose
# session resolves and has NO marker file writes the first observation at
# start-up through the normal fold path (idle folded with the live siblings:
# ready/start, or the siblings' blocked/working). It sets lastWritten, so the
# bare-clear and EOF ownership rules apply to it like any other write. A
# marker file that exists (the hook's, a sibling's, a predecessor's) is never
# touched, and a seeded start (handover, or a listener restarted on a pane
# whose entry still holds records/lastWritten) never writes before its first
# chunk. The replay harness models the chunk gate only, so its trail shows
# ready/start at the agent's own idle report, not at attach.
# --------------------------------------------------------------------------

class PaneReader:
    """One pane's chunk gate, shared by run_listen and the replay harness so
    the two cannot drift. feed(data) applies every parseable report in the
    chunk and returns None when nothing changed, ('clear', fold) when the last
    applied report was a bare clear that emptied the records (the program
    exited), or ('fold', fold) when the pane fold changed. A chunk whose
    bodies all fail parse_report (the `?` probe OpenCode, pi and Claude send
    first) is NOT an observation and must never become a first idle."""

    def __init__(self, records=None):
        self.recs = records if records is not None else Records()
        self.tail = b''
        self.last_fold = None

    def feed(self, data):
        bodies, self.tail = extract(self.tail + data)
        applied = 0
        cleared = False
        for body in bodies:
            rep = parse_report(body)
            if rep is None:
                continue
            applied += 1
            self.recs.apply(rep)
            cleared = rep['state'] == 'clear' and rep['id'] == ''
        if not applied:
            return None
        fold = self.recs.fold()
        if cleared and not self.recs.recs:
            self.last_fold = None  # the next report is a first observation
            return ('clear', fold)
        if fold == self.last_fold:
            return None
        self.last_fold = fold
        return ('fold', fold)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def run_listen(pane_id, *, home, stdin_fd=0):
    """Read one pane's raw output, fold its OSC 7501 reports, write the marker.
    Protocol: the comment block above."""
    epath = entry_path(home, pane_id)
    entry = read_entry(epath)
    reader = PaneReader(Records.from_json(entry.get('records')))
    lw = entry.get('lastWritten')
    last_written = lw if isinstance(lw, str) else None
    ses = entry.get('session')
    session = ses if isinstance(ses, str) else None
    gen = entry.get('attachedAt') if _is_num(entry.get('attachedAt')) else time.time()
    sha = ''
    try:
        sha = asset_sha()
    except Exception:
        pass
    state = {'pid': os.getpid(), 'sha': sha, 'session': session, 'records': reader.recs.to_json(),
             'lastWritten': last_written, 'handover': False, 'attachedAt': gen}

    def superseded(cur):
        return _is_num(cur.get('attachedAt')) and cur.get('attachedAt') != gen

    def persist():
        """Claim the entry unless the loop restamped it since we started."""
        state['records'] = reader.recs.to_json()
        state['session'] = session
        state['lastWritten'] = last_written
        try:
            with entries_locked(home):
                if superseded(read_entry(epath)):
                    return
                write_entry(epath, state)
        except Exception as e:
            debug(home, 'persist: %r' % (e,))

    # Attach seed (protocol block): a FRESH attach — no records and no
    # lastWritten to seed from — whose session has no marker file yet writes
    # the first observation itself, through the normal fold path.
    if not entry.get('records') and last_written is None:
        try:
            s = resolve_session(pane_id)
            if s is not None:
                session = s
                mpath = marker_path(home, s)
                if not os.path.exists(mpath):
                    act = next_action(None, session_fold([('idle', None)] + _sibling_folds(home, s, pane_id)))
                    if act:
                        last_written = write_marker(mpath, s, act[1], act[2])
        except Exception as e:
            debug(home, 'attach seed: %r' % (e,))
    persist()

    while True:
        try:
            data = os.read(stdin_fd, 65536)
        except InterruptedError:
            continue
        except OSError:
            data = b''
        if not data:
            break
        try:
            got = reader.feed(data)
            if got is None:
                continue
            what, fold = got
            if what == 'clear':
                s = resolve_session(pane_id) or session
                last_written = _bare_clear(home, pane_id, s, fold, last_written)
                session = s
                persist()
                continue
            s = resolve_session(pane_id)
            if s is None:
                persist()
                continue
            session = s
            new = session_fold([fold] + _sibling_folds(home, s, pane_id))
            mpath = marker_path(home, s)
            act = next_action(read_marker(mpath), new)
            if act:
                last_written = write_marker(mpath, s, act[1], act[2])
            persist()
        except Exception as e:
            debug(home, 'chunk: %r' % (e,))

    # EOF: the pane is gone, this listener was detached, or it was handed over.
    try:
        s = resolve_session(pane_id) or session  # tmux call outside the lock
        with entries_locked(home):
            cur = read_entry(epath)
            # An absent entry is a real end: the loop already dropped it for a
            # gone/unpiped pane (it never deletes an entry during a handover).
            if cur and (cur.get('handover') is True or cur.get('pid') != os.getpid() or superseded(cur)):
                return 0
            _bare_clear(home, pane_id, s, ('idle', None), last_written)
            _unlink(epath)
    except Exception as e:
        debug(home, 'eof: %r' % (e,))
    return 0


# ------------------------------------------------------- loop and sweep roles
#
# Both `sweep` (the probe, every poll) and `loop` (every 2 s) run pass_once,
# so the "three consecutive passes" behind a detach are three passes of EITHER
# and can complete in about 4 s when a probe lands between two loop ticks;
# the miss counter lives in miss.json so the two share it. Only the loop hands
# listeners over to a new asset version (pass_once gets the loop's sha): a
# sweep of the new version racing a still-running loop of the old one would
# otherwise ping-pong listeners until the loop is replaced.
#
# Whose pipe is it (the foreign-pipe window)? tmux has no format naming a
# pipe's owner, only #{pane_pipe}. The loop therefore only ever
#   - OPENS a pipe on a pane it just listed with pane_pipe = 0 (`-o`, so a
#     pipe that appeared in between wins silently), and
#   - CLOSES a pipe whose entry holds a LIVE pid — a listener that is reading
#     this pane right now, which is the one proof that the pipe is ours (an
#     operator pipe replacing ours ends our listener within milliseconds,
#     and its EOF path deletes the entry).
# An entry that never got a pid (our -o lost to a foreign pipe, or python
# failed to start) is dropped after ATTACH_GRACE_S and its pipe left alone; a
# dead pid's entry is dropped and its pipe left alone too — a dead listener's
# pipe closes itself on the pane's next output byte (tmux gets EPIPE), after
# which the pane lists as pane_pipe = 0 and is re-attached. Residual window:
# an operator who replaces a DEAD listener's pipe (`pipe-pane cmd` without
# -o) before that next byte gets left alone as well, so nothing is ever
# closed on evidence weaker than a live pid.

LOOP_INTERVAL = 2.0
MISS_LIMIT = 3
IDLE_EXIT_S = 3600
ATTACH_GRACE_S = 30
_NO_SERVER_RE = re.compile(r'no server running|error connecting to .*\(No such file or directory\)')


def osc_dir(home):
    return os.path.join(home, '.tmuxifier-osc')


class entries_locked:
    """Context manager: hold ~/.tmuxifier-osc/entries.lock around a
    read-modify-write of a registry entry. Fails open (runs unlocked) when
    the lock file cannot be opened."""

    def __init__(self, home):
        self.home = home
        self.fd = None

    def __enter__(self):
        try:
            os.makedirs(osc_dir(self.home), exist_ok=True)
            fd = os.open(os.path.join(osc_dir(self.home), 'entries.lock'), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except Exception:
                os.close(fd)
                raise
            self.fd = fd
        except Exception as e:
            debug(self.home, 'entries lock: %r' % (e,))
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)  # releases the flock
        return False


def agent_kind(cmd, home):
    """The OSC agent a pane command names, or None. opencode yields to the
    OpenCode plugin whenever its plugin file is installed."""
    for kind, rx in OSC_AGENTS.items():
        if re.match(rx, cmd):
            if kind == 'opencode':
                cfg = os.environ.get('OPENCODE_CONFIG_DIR') or os.path.join(home, '.config', 'opencode')
                if os.path.exists(os.path.join(cfg, 'plugins', 'tmuxifier-agent.js')):
                    return None
            return kind
    return None


def list_panes():
    """(rows, no_server): rows is [(pane_id, piped, cmd, session)] or None when
    tmux could not be listed; no_server is True when there is no tmux server
    (or no tmux at all)."""
    try:
        r = subprocess.run(['tmux', 'list-panes', '-a', '-F',
                            '#{pane_id}\t#{pane_pipe}\t#{pane_current_command}\t#{session_name}'],
                           capture_output=True, timeout=5)
    except FileNotFoundError:
        return None, True
    except Exception:
        return None, False
    if r.returncode != 0:
        err = r.stderr.decode('utf-8', 'replace')
        return None, bool(_NO_SERVER_RE.search(err))
    rows = []
    for line in r.stdout.decode('utf-8', 'replace').split('\n'):
        f = line.split('\t', 3)
        if len(f) < 4 or not re.match(r'^%[0-9]+$', f[0]):
            continue
        rows.append((f[0], f[1] == '1', f[2], f[3]))
    return rows, False


def _tmux(*args):
    try:
        return subprocess.run(['tmux'] + list(args), capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def _asset_path(home):
    return os.path.join(osc_dir(home), 'reporter.py')


def _listen_cmd(home, pane_id):
    """The pipe-pane command. tmux gives a pipe job stdin = the pane's output
    and /dev/null for stderr, and never reports its exit, so no wrapper."""
    return "exec python3 '%s' listen %s" % (_asset_path(home), pane_id)


def _loop_cmd(home):
    """The run-shell -b command. tmux prints a run-shell job's output, a
    non-zero exit ('returned 127') or a signal death ('terminated by signal
    15') into the current pane as a view-mode overlay that swallows the
    operator's keystrokes until `q` — so: no python3 on the server's PATH
    (which is not the probe's PATH) exits 0 before exec, python's output goes
    to /dev/null, and run_loop turns SIGTERM (the sweep's replace path) into
    exit 0."""
    return ("command -v python3 >/dev/null 2>&1 || exit 0; "
            "exec python3 '%s' loop >/dev/null 2>&1" % _asset_path(home))


def _create_entry(path, entry):
    """Create the entry only if absent (tmp + link, so readers never see a
    partial file). Returns True when this call created it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.%d.new' % (path, os.getpid())
    with open(tmp, 'w') as f:
        f.write(json.dumps(entry))
    try:
        os.link(tmp, path)
        return True
    except FileExistsError:
        return False
    finally:
        _unlink(tmp)


def attach(pane_id, home):
    """Pipe the pane's output to a listener. The entry is registered BEFORE the
    pipe starts, so the listener's own first write can never be overwritten by
    ours; an existing entry (a handover's step 1) is never touched."""
    epath = entry_path(home, pane_id)
    created = False
    try:
        created = _create_entry(epath, {'sha': asset_sha(), 'attachedAt': time.time(), 'handover': False})
    except Exception as e:
        debug(home, 'attach entry: %r' % (e,))
    if not _tmux('pipe-pane', '-o', '-t', pane_id, _listen_cmd(home, pane_id)):
        if created:
            _unlink(epath)
        return False
    return True


def detach(pane_id, home):
    """Close the pane's pipe; the listener reads EOF with handover False and
    applies the bare-clear rule."""
    return _tmux('pipe-pane', '-t', pane_id)


def hand_over(pane_id, home, e):
    """Replace a live listener with one of this asset version: steps 1-3 of
    the protocol above run_listen. Nothing touches the entry after step 3."""
    epath = entry_path(home, pane_id)
    try:
        with entries_locked(home):
            # Re-read under the lock: `e` came from pass_once's unlocked read
            # and a predecessor persist since then must not be seeded stale.
            cur = read_entry(epath)
            if not cur or cur.get('pid') != e.get('pid'):
                return False  # gone or already someone else's: next pass decides
            fresh = {k: v for k, v in cur.items() if k != 'pid'}
            fresh.update({'sha': asset_sha(), 'attachedAt': time.time(), 'handover': True})
            write_entry(epath, fresh)
    except Exception as ex:
        debug(home, 'handover entry: %r' % (ex,))
        return False  # without the flag the predecessor would read a real EOF
    _tmux('pipe-pane', '-t', pane_id)
    return attach(pane_id, home)


def _in_grace(e):
    at = e.get('attachedAt')
    return _is_num(at) and time.time() - at < ATTACH_GRACE_S


def entry_live(e):
    """A claimed entry with a live pid, or an unclaimed one still in grace."""
    pid = e.get('pid')
    if pid is None:
        return _in_grace(e)
    return pid_alive(pid)


def _unlink(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _load_miss(home):
    try:
        with open(os.path.join(osc_dir(home), 'miss.json')) as f:
            d = json.load(f)
        return {k: v for k, v in d.items() if isinstance(v, int) and not isinstance(v, bool)} if isinstance(d, dict) else {}
    except Exception:
        return {}


def pass_once(home, loop_sha=None):
    """One attach/detach/staleness pass. Returns (no_server, active); active
    means a tmux pane exists (spec 5.2: the loop idles out only with no agent
    pane AND no session, which in practice means the server is gone, the
    no_server path). loop_sha, passed by the loop only, hands live listeners
    of another asset version over."""
    rows, no_server = list_panes()
    if rows is None:
        return no_server, True  # unknown: do not count toward the idle exit
    panes = {r[0]: r for r in rows}
    miss = _load_miss(home)
    new_miss = {}
    active = bool(rows)
    d = os.path.join(osc_dir(home), 'panes')
    try:
        names = [n for n in os.listdir(d) if n.isdigit()]
    except Exception:
        names = []
    for n in names:
        pid_id = '%' + n
        epath = os.path.join(d, n)
        row = panes.get(pid_id)
        if row is None or not row[1]:
            _unlink(epath)  # pane gone, or its pipe gone: re-attached below if it still matches
            continue
        e = read_entry(epath)
        pid = e.get('pid')
        if pid is None:
            if not _in_grace(e):
                _unlink(epath)  # never claimed: that pipe is not provably ours
            continue
        if not pid_alive(pid):
            _unlink(epath)  # died; its pipe closes on the pane's next byte
            continue
        kind = agent_kind(row[2], home)
        if kind and loop_sha is not None and e.get('sha') not in (None, loop_sha):
            hand_over(pid_id, home, e)
            continue
        if kind:
            continue
        count = miss.get(pid_id, 0) + 1
        if count >= MISS_LIMIT:
            detach(pid_id, home)
        else:
            new_miss[pid_id] = count
    for pid_id, piped, cmd, _s in rows:
        if piped or not agent_kind(cmd, home):
            continue
        if not os.path.exists(os.path.join(d, pid_id.lstrip('%'))):
            attach(pid_id, home)
    if new_miss != miss:
        try:
            _atomic_write(os.path.join(osc_dir(home), 'miss.json'), json.dumps(new_miss))
        except Exception as e:
            debug(home, 'miss: %r' % (e,))
    return False, active


def _open_lock(home):
    os.makedirs(osc_dir(home), exist_ok=True)
    return os.open(os.path.join(osc_dir(home), 'loop.lock'), os.O_RDWR | os.O_CREAT, 0o644)


def run_loop(home):
    # The sweep replaces an outdated loop with SIGTERM; tmux would report the
    # default disposition ("terminated by signal 15") into the operator's
    # pane. Exit 0 at once, from anywhere (even the lock wait below).
    try:
        signal.signal(signal.SIGTERM, lambda *_a: os._exit(0))
    except Exception:
        pass
    try:
        fd = _open_lock(home)
    except Exception as e:
        debug(home, 'lock open: %r' % (e,))
        return 0
    deadline = time.time() + 5  # a replaced loop may still be dying
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.time() > deadline:
                return 0
            time.sleep(0.1)
    sha = asset_sha()
    try:
        os.ftruncate(fd, 0)
        os.write(fd, ('%d %s\n' % (os.getpid(), sha)).encode())
    except Exception as e:
        debug(home, 'lock write: %r' % (e,))
    once = os.environ.get('TMUXIFIER_OSC_LOOP_ONCE') == '1'
    idle_since = time.time()
    while True:
        try:
            no_server, active = pass_once(home, loop_sha=sha)
        except Exception as e:
            debug(home, 'pass: %r' % (e,))
            no_server, active = False, True
        if once or no_server:
            return 0
        if active:
            idle_since = time.time()
        elif time.time() - idle_since >= IDLE_EXIT_S:
            return 0
        time.sleep(LOOP_INTERVAL)


def _start_loop(home):
    _tmux('run-shell', '-b', _loop_cmd(home))


def run_sweep(home, once):
    try:
        no_server, _ = pass_once(home)
    except Exception as e:
        debug(home, 'sweep pass: %r' % (e,))
        no_server = False
    if once or no_server:
        return 0
    try:
        fd = _open_lock(home)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            held = _read_text(os.path.join(osc_dir(home), 'loop.lock')) or ''
            parts = held.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1] != asset_sha():
                try:
                    os.kill(int(parts[0]), signal.SIGTERM)
                except Exception:
                    pass
                _start_loop(home)
            return 0
        finally:
            os.close(fd)  # releases our flock if we took it
        _start_loop(home)
    except Exception as e:
        debug(home, 'sweep: %r' % (e,))
    return 0


def main(argv):
    # Unknown roles are a no-op.
    try:
        home = os.environ.get('HOME') or os.path.expanduser('~')
        if len(argv) >= 3 and argv[1] == 'listen' and re.match(r'^%[0-9]+$', argv[2]):
            return run_listen(argv[2], home=home)
        if len(argv) >= 2 and argv[1] == 'loop':
            return run_loop(home)
        if len(argv) >= 2 and argv[1] == 'sweep':
            return run_sweep(home, '--once' in argv[2:])
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except Exception:
        sys.exit(0)
