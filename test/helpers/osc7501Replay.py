#!/usr/bin/env python3
# Replay harness for the OSC 7501 reporter core (test only). Imports the real
# asset by path; markers live in a dict instead of files.
#   osc7501Replay.py fixture <jsonl> [pane=session ...]
#   osc7501Replay.py chunks [--marker state/cause]     (base64 lines on stdin)
# Prints {"line": n, "pane": p, "session": s, "marker": "state/cause" | null}
# whenever a pane's marker changes; fixture mode ends with {"lines": <count>}.
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
        self.markers = dict(markers or {})   # pane -> (state, cause)
        self.written = {}                    # pane -> (state, cause) this reporter last wrote
        self.readers = {}                    # pane -> PaneReader

    def feed(self, line, pane, data):
        """One pipe chunk through the asset's own chunk gate (PaneReader), so
        the harness folds exactly as run_listen does: every report in the
        chunk, one fold, and a probe-only chunk is not an observation. Each
        pane has its own marker, as each listener does."""
        reader = self.readers.setdefault(pane, rep.PaneReader())
        got = reader.feed(data)
        if got is None:
            return []
        what, fold = got
        row = {'line': line, 'pane': pane, 'session': self.session_of(pane)}
        if what == 'clear':
            if pane in self.markers and self.markers[pane] == self.written.get(pane):
                del self.markers[pane]
                del self.written[pane]
                return [dict(row, marker=None)]
            return []
        act = rep.next_action(self.markers.get(pane), fold)
        if act is None:
            return []
        self.markers[pane] = (act[1], act[2])
        self.written[pane] = (act[1], act[2])
        return [dict(row, marker='%s/%s' % (act[1], act[2]))]


def emit(rows):
    for r in rows:
        print(json.dumps(r))


def main(argv):
    mode = argv[1] if len(argv) > 1 else ''
    if mode == 'chunks':
        markers = {}
        if '--marker' in argv:
            st, cause = argv[argv.index('--marker') + 1].split('/')
            markers['p'] = (st, cause)
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
