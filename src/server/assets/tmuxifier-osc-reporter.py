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
import sys

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


def main(argv):
    # Roles (listen, loop, sweep) are added by later tasks; unknown roles are a no-op.
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except Exception:
        sys.exit(0)
