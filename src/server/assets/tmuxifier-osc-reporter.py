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
# session_fold) is importable with no side effects; the roles live in main().
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
    """The pane's current tmux session name, or None on any failure."""
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
    """Registry entries of other panes in `session` whose listener is alive."""
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
        if e.get('session') != session or not pid_alive(e.get('pid')):
            continue
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


def run_listen(pane_id, *, home, stdin_fd=0):
    """Read one pane's raw output, fold its OSC 7501 reports, write the marker."""
    epath = entry_path(home, pane_id)
    entry = read_entry(epath)
    recs = Records.from_json(entry.get('records'))
    lw = entry.get('lastWritten')
    last_written = lw if isinstance(lw, str) else None
    ses = entry.get('session')
    session = ses if isinstance(ses, str) else None
    sha = ''
    try:
        sha = asset_sha()
    except Exception:
        pass
    state = {'pid': os.getpid(), 'sha': sha, 'session': session, 'records': recs.to_json(),
             'lastWritten': last_written, 'handover': False, 'attachedAt': time.time()}

    def persist():
        state['records'] = recs.to_json()
        state['session'] = session
        state['lastWritten'] = last_written
        write_entry(epath, state)

    try:
        persist()
    except Exception as e:
        debug(home, 'initial persist: %r' % (e,))

    tail = b''
    last_fold = None
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
            bodies, tail = extract(tail + data)
            cleared = False
            for body in bodies:
                rep = parse_report(body)
                if rep is None:
                    continue
                recs.apply(rep)
                if rep['state'] == 'clear' and rep['id'] == '':
                    cleared = True
                else:
                    cleared = False
            if not bodies:
                continue
            fold = recs.fold()
            if cleared and not recs.recs:
                s = resolve_session(pane_id) or session
                last_written = _bare_clear(home, pane_id, s, fold, last_written)
                session = s
                last_fold = None  # next report is a first observation
                persist()
                continue
            if fold == last_fold:
                continue
            last_fold = fold
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

    # EOF: the pane is gone or this listener was detached.
    try:
        cur = read_entry(epath)
        if cur.get('handover') is True:
            # A successor that already wrote its own pid owns the entry.
            if cur.get('pid') in (None, os.getpid()):
                persist()
            return 0
        s = resolve_session(pane_id) or session
        _bare_clear(home, pane_id, s, ('idle', None), last_written)
        try:
            os.unlink(epath)
        except FileNotFoundError:
            pass
    except Exception as e:
        debug(home, 'eof: %r' % (e,))
    return 0


# ------------------------------------------------------- loop and sweep roles

LOOP_INTERVAL = 2.0
MISS_LIMIT = 3
IDLE_EXIT_S = 3600
ATTACH_GRACE_S = 30
_NO_SERVER_RE = re.compile(r'no server running|error connecting to .*\(No such file or directory\)')


def osc_dir(home):
    return os.path.join(home, '.tmuxifier-osc')


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


def _reporter_cmd(home, role):
    return "exec python3 '%s' %s" % (os.path.join(osc_dir(home), 'reporter.py'), role)


def attach(pane_id, home):
    """Pipe the pane's output to a listener; register it unless already registered."""
    if not _tmux('pipe-pane', '-o', '-t', pane_id, _reporter_cmd(home, 'listen ' + pane_id)):
        return False
    epath = entry_path(home, pane_id)
    if not os.path.exists(epath):
        try:
            write_entry(epath, {'sha': asset_sha(), 'attachedAt': time.time(), 'handover': False})
        except Exception as e:
            debug(home, 'attach entry: %r' % (e,))
    return True


def detach(pane_id, home, handover):
    """Stop the pane's pipe; with handover the listener keeps its marker."""
    epath = entry_path(home, pane_id)
    if handover:
        e = read_entry(epath)
        if e:
            e['handover'] = True
            try:
                write_entry(epath, e)
            except Exception as ex:
                debug(home, 'detach entry: %r' % (ex,))
    return _tmux('pipe-pane', '-t', pane_id)


def _entry_live(e):
    pid = e.get('pid')
    if pid is None:
        at = e.get('attachedAt')
        return isinstance(at, (int, float)) and not isinstance(at, bool) and time.time() - at < ATTACH_GRACE_S
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


def pass_once(home):
    """One attach/detach/staleness pass. Returns (no_server, active); active
    means an agent pane or a registered listener exists."""
    rows, no_server = list_panes()
    if rows is None:
        return no_server, True  # unknown: do not count toward the idle exit
    panes = {r[0]: r for r in rows}
    miss = _load_miss(home)
    new_miss = {}
    active = False
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
            _unlink(epath)
            continue
        e = read_entry(epath)
        if not _entry_live(e):
            if agent_kind(row[2], home):
                # A successor may already be reading the pane: flag the handover
                # so its predecessor's EOF is not taken for "agent exited".
                detach(pid_id, home, True)  # -o would be a no-op on a piped pane
                if attach(pid_id, home):
                    fresh = dict(e)
                    fresh.pop('pid', None)
                    fresh.update({'sha': asset_sha(), 'attachedAt': time.time(), 'handover': True})
                    try:
                        write_entry(epath, fresh)
                    except Exception as ex:
                        debug(home, 'reattach entry: %r' % (ex,))
                active = True
            else:
                _unlink(epath)
            continue
        active = True
        if agent_kind(row[2], home):
            continue
        count = miss.get(pid_id, 0) + 1
        if count >= MISS_LIMIT:
            detach(pid_id, home, False)
        else:
            new_miss[pid_id] = count
    for pid_id, piped, cmd, _s in rows:
        if piped or not agent_kind(cmd, home):
            continue
        active = True
        if not os.path.exists(os.path.join(d, pid_id.lstrip('%'))):
            attach(pid_id, home)
    if new_miss != miss:
        try:
            _atomic_write(os.path.join(osc_dir(home), 'miss.json'), json.dumps(new_miss))
        except Exception as e:
            debug(home, 'miss: %r' % (e,))
    return False, active


def _handover(home, sha):
    """Replace listeners left by an older asset version."""
    rows, _ = list_panes()
    if not rows:
        return
    piped = {r[0] for r in rows if r[1]}
    d = os.path.join(osc_dir(home), 'panes')
    try:
        names = [n for n in os.listdir(d) if n.isdigit()]
    except Exception:
        return
    for n in names:
        pid_id = '%' + n
        epath = os.path.join(d, n)
        e = read_entry(epath)
        if pid_id not in piped or not _entry_live(e) or e.get('sha') in (None, sha):
            continue
        detach(pid_id, home, True)
        if attach(pid_id, home):
            cur = read_entry(epath)
            if cur:
                cur['sha'] = sha
                try:
                    write_entry(epath, cur)
                except Exception as ex:
                    debug(home, 'handover entry: %r' % (ex,))


def _open_lock(home):
    os.makedirs(osc_dir(home), exist_ok=True)
    return os.open(os.path.join(osc_dir(home), 'loop.lock'), os.O_RDWR | os.O_CREAT, 0o644)


def run_loop(home):
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
    try:
        _handover(home, sha)
    except Exception as e:
        debug(home, 'handover: %r' % (e,))
    while True:
        try:
            no_server, active = pass_once(home)
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
    _tmux('run-shell', '-b', _reporter_cmd(home, 'loop'))


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
