#!/usr/bin/env python3
# Replay harness for the OSC 7501 reporter core (test only). Imports the real
# asset by path; markers live in a dict instead of files.
#   osc7501Replay.py fixture <jsonl> [pane=session ...]
#   osc7501Replay.py chunks [--marker state/cause]     (base64 lines on stdin)
# Prints {"line": n, "session": s, "marker": "state/cause" | null} whenever a
# session's marker changes; fixture mode ends with {"lines": <count>}.
import base64
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET = os.path.join(HERE, '..', '..', 'src', 'server', 'assets', 'tmuxifier-osc-reporter.py')
spec = importlib.util.spec_from_file_location('tmuxifier_osc_reporter', ASSET)
rep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rep)


class Replay:
    def __init__(self, session_of, markers=None):
        self.session_of = session_of
        self.markers = dict(markers or {})   # session -> (state, cause)
        self.written = {}                    # session -> (state, cause) this reporter last wrote
        self.panes = {}                      # pane -> {'reader','active'}

    def _pane(self, name):
        return self.panes.setdefault(name, {'reader': rep.PaneReader(), 'active': False})

    def feed(self, line, pane, data):
        """One pipe chunk through the asset's own chunk gate (PaneReader), so
        the harness folds exactly as run_listen does: every report in the
        chunk, one fold, and a probe-only chunk is not an observation."""
        p = self._pane(pane)
        got = p['reader'].feed(data)
        if got is None:
            return []
        what, _fold = got
        session = self.session_of(pane)
        if what == 'clear':
            p['active'] = False
            return self._after_clear(line, session)
        p['active'] = True
        return self._evaluate(line, session)

    def _session_fold(self, session):
        folds = [q['reader'].recs.fold() for name, q in self.panes.items()
                 if q['active'] and self.session_of(name) == session]
        return rep.session_fold(folds), bool(folds)

    def _evaluate(self, line, session):
        fold, _ = self._session_fold(session)
        act = rep.next_action(self.markers.get(session), fold)
        if act is None:
            return []
        self.markers[session] = (act[1], act[2])
        self.written[session] = (act[1], act[2])
        return [{'line': line, 'session': session, 'marker': '%s/%s' % (act[1], act[2])}]

    def _after_clear(self, line, session):
        _, any_active = self._session_fold(session)
        if any_active:
            return self._evaluate(line, session)
        if session in self.markers and self.markers[session] == self.written.get(session):
            del self.markers[session]
            del self.written[session]
            return [{'line': line, 'session': session, 'marker': None}]
        return []


def emit(rows):
    for r in rows:
        print(json.dumps(r))


def main(argv):
    mode = argv[1] if len(argv) > 1 else ''
    if mode == 'chunks':
        markers = {}
        if '--marker' in argv:
            st, cause = argv[argv.index('--marker') + 1].split('/')
            markers['s'] = (st, cause)
        rp = Replay(lambda pane: 's', markers)
        for n, raw in enumerate(sys.stdin, 1):
            raw = raw.strip()
            if raw:
                emit(rp.feed(n, 'p', base64.b64decode(raw)))
        return 0
    if mode == 'fixture':
        mapping = dict(a.split('=', 1) for a in argv[3:])
        rp = Replay(lambda pane: mapping.get(pane, pane))
        total = 0
        with open(argv[2]) as f:
            for n, raw in enumerate(f, 1):
                total = n
                raw = raw.strip()
                if not raw:
                    continue
                obj = json.loads(raw)
                if 'b64' in obj:
                    emit(rp.feed(n, obj['pane'], base64.b64decode(obj['b64'])))
        print(json.dumps({'lines': total}))
        return 0
    sys.stderr.write('usage: osc7501Replay.py fixture <jsonl> [pane=session ...] | chunks [--marker s/c]\n')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
