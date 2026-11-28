import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'osc7501Replay.py');
const ASSET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'assets', 'tmuxifier-osc-reporter.py');
// Evaluates one Python expression against the real asset (imported as `m`); returns its JSON.
function py(expr) {
  const script = 'import importlib.util,json,sys\nsys.dont_write_bytecode=True\n'
    + 'spec=importlib.util.spec_from_file_location("r",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n'
    + `print(json.dumps(${expr}))`;
  return JSON.parse(execFileSync('python3', ['-c', script, ASSET], { encoding: 'utf8' }));
}
const ST = '\x1b\\';
const BEL = '\x07';
const osc = (body, term = ST) => `\x1b]7501;${body}${term}`;

// Feed raw string chunks (one per line) through the real asset; returns marker lines.
function run(chunks, marker) {
  const input = chunks.map((c) => Buffer.from(c, 'latin1').toString('base64')).join('\n') + '\n';
  const args = [HELPER, 'chunks'];
  if (marker) args.push('--marker', marker);
  const out = execFileSync('python3', args, { input, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const trail = (rows) => rows.map((r) => r.marker);

describe('osc7501 reporter core', () => {
  it('handles ST and BEL terminators', () => {
    const rows = run([osc('state=working:app=x', ST), osc('state=idle', BEL)]);
    expect(rows).toEqual([
      { line: 1, pane: 'p', session: 's', marker: 'working/prompt' },
      { line: 2, pane: 'p', session: 's', marker: 'ready/stop' },
    ]);
  });

  it('recognises a sequence split across chunks', () => {
    const rows = run(['junk\x1b]7501;state=bloc', `ked:kind=question${ST}`]);
    expect(rows).toEqual([{ line: 2, pane: 'p', session: 's', marker: 'blocked/question' }]);
  });

  it('drops an oversized unterminated partial and recovers', () => {
    const rows = run(['\x1b]7501;' + 'a'.repeat(5000), osc('state=working')]);
    expect(rows).toEqual([{ line: 2, pane: 'p', session: 's', marker: 'working/prompt' }]);
  });

  it('recovers when an unterminated sequence is followed by a valid one in the same chunk', () => {
    const rows = run(['\x1b]7501;state=idle:' + osc('state=working')]);
    expect(trail(rows)).toEqual(['working/prompt']);
  });

  it('maps blocked kinds to causes', () => {
    expect(trail(run([osc('state=blocked:kind=auth')]))).toEqual(['blocked/elicitation']);
    expect(trail(run([osc('state=blocked')]))).toEqual(['blocked/permission']);
    expect(trail(run([osc('state=blocked:kind=weird')]))).toEqual(['blocked/permission']);
  });

  it('clear with an id removes the subtree', () => {
    const rows = run([
      osc('state=working:id=a/b'),
      osc('state=blocked:id=a/b/c:kind=permission'),
      osc('state=clear:id=a'),
    ]);
    expect(trail(rows)).toEqual(['working/prompt', 'blocked/permission', 'ready/stop']);
  });

  it('bare clear removes the marker', () => {
    const rows = run([osc('state=working'), osc('state=clear')]);
    expect(rows[1]).toEqual({ line: 2, pane: 'p', session: 's', marker: null });
  });

  it('done and error end the turn', () => {
    expect(trail(run([osc('state=working'), osc('state=done')]))).toEqual(['working/prompt', 'ready/stop']);
    expect(trail(run([osc('state=working'), osc('state=error')]))).toEqual(['working/prompt', 'ready/stop']);
  });

  it('first idle report consults the existing marker', () => {
    expect(trail(run([osc('state=idle')]))).toEqual(['ready/start']);
    expect(trail(run([osc('state=idle')], 'working/prompt'))).toEqual(['ready/stop']);
    expect(trail(run([osc('state=idle')], 'ready/stop'))).toEqual([]);
  });

  it('blocked over an existing blocked marker rewrites only on a kind change', () => {
    expect(trail(run([osc('state=blocked:kind=question')], 'blocked/permission'))).toEqual(['blocked/question']);
    expect(trail(run([osc('state=blocked:kind=question')], 'blocked/question'))).toEqual([]);
  });

  it('ignores probes, unknown states, bad ids; last duplicate key wins', () => {
    expect(trail(run([osc('?')]))).toEqual([]);
    expect(trail(run([osc('state=bogus')]))).toEqual([]);
    expect(trail(run([osc('state=working:id=bad id')]))).toEqual([]);
    expect(trail(run([osc('state=working:state=idle')]))).toEqual(['ready/start']);
  });

  it('repeated working reports emit one line', () => {
    const rows = run([osc('state=working'), osc('state=working:app=x'), osc('state=working')]);
    expect(rows).toHaveLength(1);
  });

  it('gates per chunk like the real listener: all reports in a chunk fold once', () => {
    // run_listen applies every report in a chunk and folds once; the harness
    // shares that gate (PaneReader), so a chunk carrying working then idle is
    // one first observation of idle, never a working/prompt + ready/stop pair.
    expect(trail(run([osc('state=working') + osc('state=idle')]))).toEqual(['ready/start']);
    expect(trail(run([osc('state=working') + osc('state=clear')]))).toEqual([]);
  });

  it('a chunk of only probes or unparseable bodies is not an observation', () => {
    expect(trail(run([osc('?')], 'working/prompt'))).toEqual([]);
    expect(trail(run([osc('?') + osc('state=bogus')], 'working/prompt'))).toEqual([]);
    expect(trail(run([osc('?'), osc('state=idle')], 'working/prompt'))).toEqual(['ready/stop']);
  });

  it('the harness feeds chunks through the asset\'s own PaneReader (the mirror is structural)', () => {
    const src = readFileSync(HELPER, 'utf8');
    expect(src).toMatch(/rep\.PaneReader\(/);
    expect(src).not.toMatch(/rep\.extract\(|rep\.parse_report\(/);
    expect(src).not.toMatch(/session_fold/);
  });

  it('names a marker <safe session><%pane>, byte-wise like the hook, and finds its own file from lastWritten', () => {
    expect(py("m.marker_path('/h', 'web', '%3')")).toBe('/h/.tmuxifier-agent/web%3');
    expect(py("m.marker_path('/h', 'my proj/x', '%12')")).toBe('/h/.tmuxifier-agent/my_proj_x%12');
    expect(py("m.marker_path('/h', 'caf\\u00e9', '%3')")).toBe('/h/.tmuxifier-agent/caf__%3'); // é is two bytes
    expect(py("m.legacy_marker_path('/h', 'my proj')")).toBe('/h/.tmuxifier-agent/my_proj');
    expect(py("m.own_marker_path('/h', '%3', 'web:working:1:prompt:%3\\n')")).toBe('/h/.tmuxifier-agent/web%3');
    expect(py("m.own_marker_path('/h', '%3', 'web:working:1:prompt\\n')")).toBe('/h/.tmuxifier-agent/web');
    expect(py("[m.own_marker_path('/h', '%3', v) for v in ['web:working:1:prompt:%4\\n', 'junk', '', None, 5]]"))
      .toEqual([null, null, null, null, null]);
    expect(py("[hasattr(m, n) for n in ['session_fold', 'live_entries', '_sibling_folds', 'entry_live']]"))
      .toEqual([false, false, false, false]);
  });
});
