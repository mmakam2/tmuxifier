import { test, expect, describe, afterAll } from 'vitest';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCore,
  createOperatorRules,
  createPermissionHandler,
  createReducer,
  dirOfSession,
  isPlainTmx,
  readJsonc,
} from '../src/server/assets/tmuxifier-opencode-agent.js';

// Plain `tmx` is allowed unless the operator has bash rules (agent messaging spec §6.7, rulings
// R8, R9, R26). Claude Code gets `Bash(tmx *)` from setup; OpenCode's plugin answers
// `permission.evaluate` itself. The payload shape is the OpenCode 2.3.0 recording's
// (test/fixtures/README-opencode-2.3-event-trace.md F3, F7): `{ sessionID, agent, action: 'shell',
// resources: [one entry per command], source, effect }` with a mutable `effect`. The operator's own
// rules win: when any config OpenCode reads sets a shell/bash rule, the hook does nothing.

const ROOT = mkdtempSync(path.join(tmpdir(), 'oc-perm-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
// A fresh world under ROOT: a home, a project below it, and an fs that sees nothing outside ROOT
// (the walk up from a project reaches `/`, and a stray /tmp/opencode.json must not change a result).
function world() {
  const base = path.join(ROOT, `w${++seq}`);
  const home = path.join(base, 'home');
  const proj = path.join(home, 'work', 'proj');
  mkdirSync(proj, { recursive: true });
  return { base, home, proj, globalDir: path.join(home, '.config', 'opencode') };
}

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
function scopedFs(onRead = () => {}) {
  const inside = (p) => p === ROOT || p.startsWith(ROOT + path.sep);
  return {
    statSync: (p) => { if (!inside(p)) throw enoent(p); return statSync(p); },
    readFileSync: (p, enc) => { onRead(p); if (!inside(p)) throw enoent(p); return readFileSync(p, enc); },
  };
}
function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
}
const rulesFor = (w, env = {}, fs = scopedFs()) => createOperatorRules({ home: w.home, env, fs });

describe('isPlainTmx', () => {
  test('one tmx command with a known subcommand is plain', () => {
    for (const c of [
      'tmx who',
      'tmx reply t-aaaaaaaa "done, 3 tests pass"',
      '~/.local/bin/tmx inbox',
      '$HOME/.local/bin/tmx inbox',
      'tmx send box-2 "run the tests"',
      "tmx send box-2 'it is fine'",
      'tmx wait',
      'tmx wait --timeout 30',
      'tmx read t-aaaaaaaa',
      'tmx inbox',
      '  tmx who  ',
      'tmx\twho',
      'tmx reply t-aaaaaaaa x',
    ]) expect(isPlainTmx(c), c).toBe(true);
  });

  test('anything that can run, pipe, chain or redirect something else is not plain', () => {
    for (const c of [
      'tmx reply t "$(env)"',
      'tmx reply t `id`',
      'tmx who; id',
      'tmx who | cat',
      'tmx who && id',
      'tmx who || id',
      'tmx who > f',
      'tmx who >> f',
      'tmx who < f',
      'tmx who 2>&1',
      'tmx who &',
      'tmx who\nid',
      'tmx who\rid',
      'tmx who a\nid',
      'tmx who a\rid',
      'tmx who a\u000bid',
      'tmx who a\u000cid',
      'tmx reply t-aaaaaaaa "line one\nline two"',
      'tmx reply t-aaaaaaaa "a; b"',
      'tmx reply t-aaaaaaaa "a $(echo hi)"',
      'tmx who <(id)',
      'tmx who >(id)',
      'tmx who $((1+1))',
    ]) expect(isPlainTmx(c), c).toBe(false);
  });

  test('another program, a lookalike or an unknown subcommand is not plain', () => {
    for (const c of [
      'tmxx who',
      'xtmx who',
      'echo tmx who',
      'tmx rm',
      'tmx',
      'tmx ',
      'tmx whoami',
      'tmx who2',
      'tmx WHO',
      'sudo tmx who',
      'FOO=1 tmx who',
      '/usr/bin/tmx who',
      './tmx who',
      '~/.local/bin/tmxx who',
      '$HOME/.local/bin/tmx',
      '"tmx" who',
      "'tmx' who",
      'env tmx who',
      '',
      ' ',
    ]) expect(isPlainTmx(c), c).toBe(false);
  });

  test('conservative additions: variable expansion and other control bytes are not plain', () => {
    // A `$VAR` argument would send the agent's environment (a key) to the other agent.
    for (const c of [
      'tmx reply t "$OPENAI_API_KEY"',
      'tmx reply t ${HOME}',
      'tmx reply t "cost $5"',
      'tmx who\u0000',
      'tmx who\u0007',
      'tmx who\u007f',
      'tmx who\u001b[0m',
    ]) expect(isPlainTmx(c), JSON.stringify(c)).toBe(false);
  });

  test('anything that is not a string is not plain', () => {
    for (const v of [undefined, null, 0, 42, true, {}, [], ['tmx who'], Symbol('x'), () => 'tmx who']) {
      expect(isPlainTmx(v)).toBe(false);
    }
  });
});

describe('readJsonc', () => {
  test('parses comments and trailing commas', () => {
    const text = `// the operator's config
{
  /* block comment */
  "permission": {
    "shell": {
      "tmx *": "ask", // trailing comment
      "git *": "allow",
    },
  },
  "list": [1, 2, 3,],
  "empty": {},
}
`;
    expect(readJsonc(text)).toEqual({
      permission: { shell: { 'tmx *': 'ask', 'git *': 'allow' } },
      list: [1, 2, 3],
      empty: {},
    });
  });

  test('plain JSON parses, and so does a leading byte order mark', () => {
    expect(readJsonc('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, 'x'] });
    expect(readJsonc('\ufeff{"a":1}')).toEqual({ a: 1 });
    expect(readJsonc('  \n{"a":1}\n\n')).toEqual({ a: 1 });
  });

  test('comment markers inside strings are text, not comments', () => {
    expect(readJsonc('{"url":"https://example.com/a//b","c":1}')).toEqual({ url: 'https://example.com/a//b', c: 1 });
    expect(readJsonc('{"a":"/* not a comment */","b":2}')).toEqual({ a: '/* not a comment */', b: 2 });
    expect(readJsonc('{"a":"x // y" // real comment\n}')).toEqual({ a: 'x // y' });
  });

  test('an escaped quote or backslash does not end a string early', () => {
    expect(readJsonc('{"a":"say \\"hi\\" // still the string","b":1}')).toEqual({ a: 'say "hi" // still the string', b: 1 });
    // The string ends at the quote after the doubled backslash, so the // after it IS a comment.
    expect(readJsonc('{"a":"C:\\\\" // comment\n,"b":1}')).toEqual({ a: 'C:\\', b: 1 });
    // One escaped quote, then a comment marker that is still inside the string.
    expect(readJsonc('{"a":"say \\"//hi","b":1}')).toEqual({ a: 'say "//hi', b: 1 });
    expect(readJsonc('{"a":"say \\"/*hi","b":1}')).toEqual({ a: 'say "/*hi', b: 1 });
    expect(readJsonc('{"a":"tail\\\\","b":"//"}')).toEqual({ a: 'tail\\', b: '//' });
  });

  test('a comma inside a string is never taken for a trailing comma', () => {
    expect(readJsonc('{"a":"x,}","b":"[1,]"}')).toEqual({ a: 'x,}', b: '[1,]' });
    expect(readJsonc('{"a":[1,"b,"],}')).toEqual({ a: [1, 'b,'] });
  });

  test('a trailing comma may be followed by comments and whitespace before the close', () => {
    expect(readJsonc('{"a":1, // c\n /* d */ }')).toEqual({ a: 1 });
    expect(readJsonc('{"a":[1,2, /* x */\n],}')).toEqual({ a: [1, 2] });
  });

  test('a comment between tokens does not glue them together', () => {
    expect(readJsonc('{"a":1/**/,"b":2}')).toEqual({ a: 1, b: 2 });
    expect(readJsonc('{"a":tr/**/ue}')).toBeNull();
  });

  test('null on any parse failure, never a throw', () => {
    for (const bad of [
      '',
      '   ',
      'garbage',
      '{',
      '{"a":}',
      '{"a":1',
      '{"a":1}}',
      '{"a":"unterminated}',
      '{"a":1 /* never closed }',
      '{"a":1} /* never closed',
      '{"a":1} /*',
      '{,}',
      '[,]',
      '{"a":1,,}',
      '[1,,2]',
      '{a:1}',
      "{'a':1}",
      '{"a":1} {"b":2}',
      '{"a": undefined}',
      '{"a":"x\ny"}',
    ]) expect(readJsonc(bad), JSON.stringify(bad)).toBeNull();
  });

  test('only a plain object is a config: arrays, scalars and null are not', () => {
    for (const v of ['[]', '[1]', '5', '"x"', 'true', 'null']) expect(readJsonc(v), v).toBeNull();
  });

  test('a non-string input is null', () => {
    for (const v of [undefined, null, 5, {}, [], Buffer.from('{}')]) expect(readJsonc(v)).toBeNull();
  });

  test('a prototype-poisoning key parses as an ordinary own key and pollutes nothing', () => {
    const o = readJsonc('{"__proto__":{"polluted":true},"a":1}');
    expect(o.a).toBe(1);
    expect({}.polluted).toBeUndefined();
  });
});

describe('createOperatorRules', () => {
  test('no config files anywhere: no rules', () => {
    const w = world();
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
  });

  test('a global opencode.json with permission.bash is rules (string and pattern object)', () => {
    const w = world();
    put(path.join(w.globalDir, 'opencode.json'), { permission: { bash: 'ask' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(path.join(w.globalDir, 'opencode.json'), { permission: { bash: { 'tmx *': 'ask', '*': 'allow' } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
  });

  test('permission.shell, OpenCode 2.3.0\'s own key, is rules too', () => {
    const w = world();
    put(path.join(w.globalDir, 'opencode.json'), { permission: { shell: { 'tmx *': 'ask' } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
  });

  test('a top-level permission string, and a "*" key, are rules', () => {
    const w = world();
    put(path.join(w.globalDir, 'opencode.json'), { permission: 'ask' });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(path.join(w.globalDir, 'opencode.json'), { permission: { '*': 'ask' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    // A glob key can match `shell` or `bash` as well.
    put(path.join(w.globalDir, 'opencode.json'), { permission: { 'sh*': 'ask' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(path.join(w.globalDir, 'opencode.json'), { permission: { 'sh?ll': 'ask' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
  });

  test('a config that sets other permissions only is not rules', () => {
    const w = world();
    put(path.join(w.globalDir, 'opencode.json'), {
      theme: 'x',
      permission: { edit: 'ask', webfetch: 'deny', external_directory: { '/tmp/*': 'allow' } },
      agent: { build: { permission: { edit: 'ask' }, model: 'm' } },
    });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
    put(path.join(w.globalDir, 'opencode.json'), { permission: {} });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
  });

  test('a malformed permission value is rules (fail closed); an absent one is not', () => {
    const w = world();
    for (const bad of [null, 5, true, ['bash']]) {
      put(path.join(w.globalDir, 'opencode.json'), { permission: bad });
      expect(rulesFor(w).hasBashRules(w.proj), JSON.stringify(bad)).toBe(true);
    }
    put(path.join(w.globalDir, 'opencode.json'), { model: 'x' });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
  });

  test('an agent-scoped rule is rules (shell, bash, string), under agent and the legacy mode', () => {
    const w = world();
    const f = path.join(w.globalDir, 'opencode.json');
    put(f, { agent: { build: { permission: { shell: { 'tmx *': 'ask' } } } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, { agent: { build: { permission: { edit: 'ask' } }, plan: { permission: { bash: 'deny' } } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, { agent: { plan: { permission: 'ask' } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, { mode: { build: { permission: { bash: 'ask' } } } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, { agent: { build: { model: 'x' }, plan: null, odd: 'text' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
  });

  test('the global config dir: OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME/opencode, or ~/.config/opencode', () => {
    const rules = { permission: { bash: 'ask' } };
    // The default.
    let w = world();
    put(path.join(w.home, '.config', 'opencode', 'opencode.json'), rules);
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    // XDG_CONFIG_HOME replaces ~/.config.
    w = world();
    const xdg = path.join(w.base, 'xdg');
    put(path.join(xdg, 'opencode', 'opencode.json'), rules);
    expect(rulesFor(w, { XDG_CONFIG_HOME: xdg }).hasBashRules(w.proj)).toBe(true);
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
    // OPENCODE_CONFIG_DIR names the opencode directory itself (the installer's plugins/ lives in it).
    w = world();
    const own = path.join(w.base, 'own-config');
    put(path.join(own, 'opencode.jsonc'), '// c\n{"permission":{"bash":"ask",},}');
    expect(rulesFor(w, { OPENCODE_CONFIG_DIR: own }).hasBashRules(w.proj)).toBe(true);
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
    // Setting OPENCODE_CONFIG_DIR does not hide the default global config (OpenCode reads both).
    w = world();
    put(path.join(w.home, '.config', 'opencode', 'opencode.json'), rules);
    expect(rulesFor(w, { OPENCODE_CONFIG_DIR: path.join(w.base, 'empty') }).hasBashRules(w.proj)).toBe(true);
  });

  test('a global opencode.jsonc with comments and trailing commas is read', () => {
    const w = world();
    put(path.join(w.globalDir, 'opencode.jsonc'), `{
  // keep tmx quiet
  "permission": { "shell": { "tmx *": "ask", }, },
}`);
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
  });

  test('a project .opencode/opencode.jsonc with bash patterns is rules (the F7 recording\'s shape)', () => {
    const w = world();
    put(path.join(w.proj, '.opencode', 'opencode.jsonc'), `{
  // project rules
  "permission": {
    "shell": { "tmx *": "ask", /* more */ },
  },
}`);
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
  });

  test('every project file name counts: opencode.json[c] and .opencode/opencode.json[c]', () => {
    for (const rel of ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']) {
      const w = world();
      expect(rulesFor(w).hasBashRules(w.proj)).toBe(false);
      put(path.join(w.proj, rel), { permission: { bash: 'ask' } });
      expect(rulesFor(w).hasBashRules(w.proj), rel).toBe(true);
    }
  });

  test('a config in any parent directory up to the root applies; a sibling\'s does not', () => {
    const w = world();
    put(path.join(w.home, 'work', 'opencode.json'), { permission: { bash: 'ask' } });
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    expect(rulesFor(w).hasBashRules(path.join(w.home, 'work'))).toBe(true);
    expect(rulesFor(w).hasBashRules(w.home)).toBe(false);
    const other = path.join(w.home, 'other');
    mkdirSync(other, { recursive: true });
    expect(rulesFor(w).hasBashRules(other)).toBe(false);
    // And a config in the home directory and in `.opencode` of a grandparent.
    const w2 = world();
    put(path.join(w2.home, '.opencode', 'opencode.jsonc'), { permission: 'ask' });
    expect(rulesFor(w2).hasBashRules(w2.proj)).toBe(true);
  });

  test('the walk reaches the filesystem root', () => {
    const seen = new Set();
    const fs = { statSync: (p) => { seen.add(p); throw enoent(p); }, readFileSync: () => { throw enoent('x'); } };
    const rules = createOperatorRules({ home: '/home/u', env: {}, fs });
    expect(rules.hasBashRules('/a/b')).toBe(false);
    for (const p of ['/a/b/opencode.json', '/a/b/opencode.jsonc', '/a/b/.opencode/opencode.json',
      '/a/b/.opencode/opencode.jsonc', '/a/opencode.json', '/a/.opencode/opencode.jsonc',
      '/opencode.json', '/opencode.jsonc', '/.opencode/opencode.json', '/.opencode/opencode.jsonc',
      '/home/u/.config/opencode/opencode.json', '/home/u/.config/opencode/opencode.jsonc']) {
      expect(seen.has(p), p).toBe(true);
    }
  });

  test('an unparseable file is rules (fail closed), so is an empty one', () => {
    const w = world();
    const f = path.join(w.proj, 'opencode.json');
    put(f, '{ this is not json');
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, '');
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    put(f, '[]');
    expect(rulesFor(w).hasBashRules(w.proj)).toBe(true);
    // A file that is a directory cannot be read as config.
    const w2 = world();
    mkdirSync(path.join(w2.proj, 'opencode.json'));
    expect(rulesFor(w2).hasBashRules(w2.proj)).toBe(true);
  });

  test('an unreadable file is rules, and the answer recovers once it is readable again', () => {
    const w = world();
    const f = path.join(w.globalDir, 'opencode.json');
    put(f, { model: 'x' });
    let broken = true;
    const fs = {
      statSync: scopedFs().statSync,
      readFileSync: (p, enc) => {
        if (broken && p === f) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return readFileSync(p, enc);
      },
    };
    const rules = createOperatorRules({ home: w.home, env: {}, fs });
    expect(rules.hasBashRules(w.proj)).toBe(true);
    broken = false;
    expect(rules.hasBashRules(w.proj)).toBe(false);
  });

  test('a stat failure other than "no such file" is rules; a missing one is not', () => {
    const w = world();
    for (const code of ['EACCES', 'EIO', 'ELOOP']) {
      const fs = { statSync: (p) => { throw Object.assign(new Error(code), { code }); }, readFileSync };
      expect(createOperatorRules({ home: w.home, env: {}, fs }).hasBashRules(w.proj), code).toBe(true);
    }
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const fs = { statSync: (p) => { throw Object.assign(new Error(code), { code }); }, readFileSync };
      expect(createOperatorRules({ home: w.home, env: {}, fs }).hasBashRules(w.proj), code).toBe(false);
    }
    const noCode = { statSync: () => { throw new Error('odd'); }, readFileSync };
    expect(createOperatorRules({ home: w.home, env: {}, fs: noCode }).hasBashRules(w.proj)).toBe(true);
  });

  test('an enormous config is rules without being read', () => {
    const w = world();
    const f = path.join(w.proj, 'opencode.json');
    put(f, `{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`);
    let reads = 0;
    const rules = rulesFor(w, {}, scopedFs(() => { reads++; }));
    expect(rules.hasBashRules(w.proj)).toBe(true);
    expect(reads).toBe(0);
  });

  test('editing a file flips the answer on the same instance, in both directions', () => {
    const w = world();
    const f = path.join(w.proj, '.opencode', 'opencode.jsonc');
    const rules = rulesFor(w);
    expect(rules.hasBashRules(w.proj)).toBe(false);
    put(f, { permission: { bash: 'ask' } });
    expect(rules.hasBashRules(w.proj)).toBe(true);
    put(f, { model: 'a-different-and-longer-config' });
    expect(rules.hasBashRules(w.proj)).toBe(false);
    put(f, '{"permission":{"shell":{"tmx *":"ask"}}}');
    expect(rules.hasBashRules(w.proj)).toBe(true);
    rmSync(f);
    expect(rules.hasBashRules(w.proj)).toBe(false);
    // A global edit applies to the next command too.
    const g = path.join(w.globalDir, 'opencode.json');
    put(g, { permission: 'ask' });
    expect(rules.hasBashRules(w.proj)).toBe(true);
  });

  test('an edit that keeps the size is seen through the modification time', () => {
    const w = world();
    const f = path.join(w.proj, 'opencode.json');
    const rules = rulesFor(w);
    put(f, '{"permission":{"bash":"ask"}}');
    expect(rules.hasBashRules(w.proj)).toBe(true);
    put(f, '{"permission":{"edit":"ask"}}'); // same length
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    expect(rules.hasBashRules(w.proj)).toBe(false);
  });

  test('an edit within the same modification time is seen through the size', () => {
    const w = world();
    const f = path.join(w.proj, 'opencode.json');
    const rules = rulesFor(w);
    const T = new Date('2026-01-01T00:00:00Z');
    put(f, '{"model":"x"}');
    utimesSync(f, T, T);
    expect(rules.hasBashRules(w.proj)).toBe(false);
    put(f, '{"permission":{"bash":"ask"}}'); // a different size
    utimesSync(f, T, T); // the very same modification time
    expect(rules.hasBashRules(w.proj)).toBe(true);
  });

  test('an unchanged file is read once, and a changed one again', () => {
    const w = world();
    const f = path.join(w.proj, 'opencode.json');
    put(f, '{"model":"x"}');
    const reads = [];
    const rules = rulesFor(w, {}, scopedFs((p) => reads.push(p)));
    for (let i = 0; i < 5; i++) expect(rules.hasBashRules(w.proj)).toBe(false);
    expect(reads).toEqual([f]);
    put(f, '{"model":"x","theme":"longer"}');
    expect(rules.hasBashRules(w.proj)).toBe(false);
    expect(reads).toEqual([f, f]);
  });

  test('a directory that is not an absolute path is rules (cannot be located)', () => {
    const w = world();
    const rules = rulesFor(w);
    for (const d of [undefined, null, '', 'relative/dir', './x', 5, {}, []]) {
      expect(rules.hasBashRules(d), String(d)).toBe(true);
    }
  });

  test('a global directory that cannot be located is rules', () => {
    const fs = { statSync: (p) => { throw enoent(p); }, readFileSync };
    expect(createOperatorRules({ home: '', env: {}, fs }).hasBashRules('/a')).toBe(true);
    expect(createOperatorRules({ home: 'rel', env: {}, fs }).hasBashRules('/a')).toBe(true);
    expect(createOperatorRules({ home: '/h', env: { OPENCODE_CONFIG_DIR: 'rel' }, fs }).hasBashRules('/a')).toBe(true);
    expect(createOperatorRules({ home: '/h', env: { XDG_CONFIG_HOME: 'rel' }, fs }).hasBashRules('/a')).toBe(true);
    // An empty variable is unset.
    expect(createOperatorRules({ home: '/h', env: { OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' }, fs }).hasBashRules('/a')).toBe(false);
  });

  test('hasBashRules never throws, whatever the fs does', () => {
    const w = world();
    const evil = {
      statSync: () => { throw 'a string'; },
      readFileSync: () => { throw null; },
    };
    expect(() => createOperatorRules({ home: w.home, env: {}, fs: evil }).hasBashRules(w.proj)).not.toThrow();
    expect(createOperatorRules({ home: w.home, env: {}, fs: evil }).hasBashRules(w.proj)).toBe(true);
    const weirdStat = { statSync: () => null, readFileSync };
    expect(createOperatorRules({ home: w.home, env: {}, fs: weirdStat }).hasBashRules(w.proj)).toBe(true);
    expect(createOperatorRules({ home: w.home, env: {}, fs: { statSync: () => ({ size: 1 }), readFileSync: () => 5 } }).hasBashRules(w.proj)).toBe(true);
  });

  test('with the real fs (no injection) a project file in a temp directory is found', () => {
    const w = world();
    put(path.join(w.proj, 'opencode.json'), { permission: { bash: 'ask' } });
    expect(createOperatorRules({ home: w.home, env: {} }).hasBashRules(w.proj)).toBe(true);
  });
});

describe('createPermissionHandler', () => {
  const SES = 'ses_e1b5dba6cffeeqBRex5168FE6A';
  const ev = (resources, effect = 'ask', over = {}) => ({
    sessionID: SES, agent: 'build', action: 'shell', resources,
    source: { type: 'tool', messageID: 'msg_1', id: 'call_1' }, effect, ...over,
  });
  function setup(w = world(), env = {}) {
    const rules = rulesFor(w, env);
    const dirOf = (id) => (id === SES ? w.proj : null);
    return { w, rules, handler: createPermissionHandler({ rules, dirOf }) };
  }

  test('plain tmx with no rules is allowed', () => {
    const { handler } = setup();
    for (const c of ['tmx who', 'tmx reply t-aaaaaaaa "done, 3 tests pass"', '~/.local/bin/tmx inbox']) {
      const e = ev([c]);
      handler(e);
      expect(e.effect, c).toBe('allow');
    }
  });

  test('only the effect is touched', () => {
    const { handler } = setup();
    const e = ev(['tmx who']);
    const before = JSON.stringify({ ...e, effect: null });
    handler(e);
    expect(JSON.stringify({ ...e, effect: null })).toBe(before);
    expect(Object.keys(e).sort()).toEqual(['action', 'agent', 'effect', 'resources', 'sessionID', 'source']);
  });

  test('with any bash rules the effect is left to OpenCode, ask stays ask', () => {
    for (const [where, rules] of [
      ['global', { file: (w) => path.join(w.globalDir, 'opencode.json'), cfg: { permission: { bash: 'ask' } } }],
      ['project', { file: (w) => path.join(w.proj, '.opencode', 'opencode.jsonc'), cfg: '// c\n{"permission":{"shell":{"tmx *":"ask",},},}' }],
      ['project json', { file: (w) => path.join(w.proj, 'opencode.json'), cfg: { permission: { shell: { 'tmx *': 'ask' } } } }],
      ['agent', { file: (w) => path.join(w.globalDir, 'opencode.json'), cfg: { agent: { build: { permission: { shell: { '*': 'ask' } } } } } }],
    ]) {
      const w = world();
      put(rules.file(w), rules.cfg);
      const { handler } = setup(w);
      const e = ev(['tmx who'], 'ask');
      handler(e);
      expect(e.effect, where).toBe('ask');
    }
  });

  test('an unparseable config means rules, so nothing changes', () => {
    const w = world();
    put(path.join(w.proj, 'opencode.json'), '{ nope');
    const { handler } = setup(w);
    const e = ev(['tmx who']);
    handler(e);
    expect(e.effect).toBe('ask');
  });

  test('editing the config between two commands changes the second answer', () => {
    const w = world();
    const { handler } = setup(w);
    const f = path.join(w.proj, 'opencode.json');
    let e = ev(['tmx who']);
    handler(e);
    expect(e.effect).toBe('allow');
    put(f, { permission: { bash: { 'tmx *': 'ask' } } });
    e = ev(['tmx who']);
    handler(e);
    expect(e.effect).toBe('ask');
    put(f, { model: 'a-config-without-rules' });
    e = ev(['tmx who']);
    handler(e);
    expect(e.effect).toBe('allow');
  });

  test('a current deny is never raised', () => {
    const { handler } = setup();
    const e = ev(['tmx who'], 'deny');
    handler(e);
    expect(e.effect).toBe('deny');
  });

  test('an effect that is already allow stays allow', () => {
    const { handler } = setup();
    const e = ev(['tmx who'], 'allow');
    handler(e);
    expect(e.effect).toBe('allow');
  });

  test('anything that is not one plain tmx is left alone', () => {
    const { handler } = setup();
    for (const resources of [
      ['tmx reply t "$(env)"'],
      ['tmx reply t-aaaaaaaa "$(echo hi)"', 'echo hi'], // OpenCode's split of a substitution (130)
      ['tmx who', 'id'], // `tmx who; id` (206)
      ['tmx who', 'tmx who'],
      ['tmx who; id'],
      ['tmx who | cat'],
      ['id'],
      ['tmx rm'],
      [],
      ['tmx who', 'tmx inbox'],
    ]) {
      const e = ev(resources);
      handler(e);
      expect(e.effect, JSON.stringify(resources)).toBe('ask');
    }
  });

  test('only the shell action is considered', () => {
    const { handler } = setup();
    for (const action of ['edit', 'read', 'bash', 'webfetch', 'external_directory', '', undefined, null, 7]) {
      const e = ev(['tmx who'], 'ask', { action });
      handler(e);
      expect(e.effect, String(action)).toBe('ask');
    }
  });

  test('a session whose directory is unknown is treated as having rules', () => {
    const w = world();
    const handler = createPermissionHandler({ rules: rulesFor(w), dirOf: () => null });
    const e = ev(['tmx who']);
    handler(e);
    expect(e.effect).toBe('ask');
    const h2 = createPermissionHandler({ rules: rulesFor(w), dirOf: (id) => (id === SES ? w.proj : null) });
    const e2 = ev(['tmx who'], 'ask', { sessionID: 'ses_unknown' });
    h2(e2);
    expect(e2.effect).toBe('ask');
    for (const sessionID of [undefined, null, 5, {}]) {
      const e3 = ev(['tmx who'], 'ask', { sessionID });
      h2(e3);
      expect(e3.effect, String(sessionID)).toBe('ask');
    }
  });

  test('a throwing dirOf, rules or fs leaves the effect alone and throws nothing', () => {
    const w = world();
    const boom = () => { throw new Error('boom'); };
    for (const opts of [
      { rules: rulesFor(w), dirOf: boom },
      { rules: { hasBashRules: boom }, dirOf: () => w.proj },
      { rules: null, dirOf: () => w.proj },
      { rules: rulesFor(w), dirOf: null },
      {},
    ]) {
      const handler = createPermissionHandler(opts);
      const e = ev(['tmx who']);
      expect(() => handler(e)).not.toThrow();
      expect(e.effect).toBe('ask');
    }
    expect(() => createPermissionHandler()).not.toThrow();
    expect(() => createPermissionHandler()(ev(['tmx who']))).not.toThrow();
  });

  test('a malformed evaluation is left alone and never throws', () => {
    const { handler } = setup();
    for (const bad of [
      undefined, null, 0, 'tmx who', [], {}, () => {},
      { action: 'shell' },
      { action: 'shell', resources: 'tmx who', sessionID: SES, effect: 'ask' },
      { action: 'shell', resources: [5], sessionID: SES, effect: 'ask' },
      { action: 'shell', resources: [null], sessionID: SES, effect: 'ask' },
      { action: 'shell', resources: [['tmx who']], sessionID: SES, effect: 'ask' },
      { action: 'shell', resources: { 0: 'tmx who', length: 1 }, sessionID: SES, effect: 'ask' },
      { action: 'shell', resources: ['tmx who'], effect: 'ask' },
    ]) {
      const before = bad && typeof bad === 'object' ? JSON.stringify(bad) : null;
      expect(() => handler(bad)).not.toThrow();
      if (before) expect(JSON.stringify(bad)).toBe(before);
    }
  });

  test('a frozen evaluation (the assignment throws) does not escape', () => {
    const { handler } = setup();
    const e = Object.freeze(ev(['tmx who']));
    expect(() => handler(e)).not.toThrow();
    expect(e.effect).toBe('ask');
  });

  test('the handler returns nothing and never sets deny', () => {
    const { handler } = setup();
    for (const c of ['tmx who', 'tmx who; id', 'id']) {
      for (const effect of ['allow', 'ask', 'deny', undefined, 'other']) {
        const e = ev([c], effect);
        expect(handler(e)).toBeUndefined();
        expect(e.effect).not.toBe(effect === 'deny' ? 'allow' : 'deny');
      }
    }
  });

  describe('against the real OpenCode 2.3.0 recording', () => {
    const lines = readFileSync(
      fileURLToPath(new URL('./fixtures/opencode-2.3-event-trace.jsonl', import.meta.url)), 'utf8',
    ).split('\n');
    const recorded = (n) => {
      const r = JSON.parse(lines[n - 1]);
      expect(r.kind).toBe('hook.evaluate');
      return structuredClone(r.input);
    };
    const handlerFor = (w, sessionID) => createPermissionHandler({
      rules: rulesFor(w), dirOf: (id) => (id === sessionID ? w.proj : null),
    });

    test('no config: `tmx who` (48) and `tmx reply t-aaaaaaaa "x"` (87) are allowed; 130 and 206 stay as OpenCode had them', () => {
      for (const [n, expected] of [[48, 'allow'], [87, 'allow'], [130, 'ask'], [206, 'ask']]) {
        const input = recorded(n);
        expect(input.effect).toBe('allow'); // no config: OpenCode itself allowed all of them
        input.effect = 'ask'; // what a default-ask OpenCode would have said
        handlerFor(world(), input.sessionID)(input);
        expect(input.effect, `line ${n}`).toBe(expected);
      }
    });

    test('the F7 operator configs: `ask` at 1371, 1515, 1623 and 1757 stays `ask`', () => {
      const configs = {
        1371: [(w) => path.join(w.globalDir, 'opencode.json'), '{"permission":{"bash":"ask"}}'],
        1515: [(w) => path.join(w.proj, '.opencode', 'opencode.jsonc'),
          '// project rules\n{\n  "permission": {\n    "shell": { "tmx *": "ask", },\n  },\n}\n'],
        1623: [(w) => path.join(w.proj, 'opencode.json'), '{"permission":{"shell":{"tmx *":"ask"}}}'],
        1757: [(w) => path.join(w.globalDir, 'opencode.json'),
          '{"agent":{"build":{"permission":{"shell":{"tmx *":"ask"}}}}}'],
      };
      for (const [n, [file, text]] of Object.entries(configs)) {
        const w = world();
        put(file(w), text);
        const input = recorded(Number(n));
        expect(input.effect).toBe('ask');
        handlerFor(w, input.sessionID)(input);
        expect(input.effect, `line ${n}`).toBe('ask');
      }
    });
  });
});

describe('dirOfSession', () => {
  function reducerWith() {
    const r = createReducer({ now: () => 1 });
    let i = 0;
    const created = (sid, dir, parentID) => r.apply({
      id: `e${++i}`, type: 'session.created', created: 1000,
      data: { sessionID: sid, ...(parentID ? { parentID } : {}) },
      ...(dir ? { location: { directory: dir } } : {}),
    });
    return { r, created };
  }

  test('a session\'s own directory', () => {
    const { r, created } = reducerWith();
    created('ses_root', '/home/user/proj');
    expect(dirOfSession(r, 'ses_root')).toBe('/home/user/proj');
  });

  test('a subagent with no directory of its own takes its root\'s, and its own wins when it has one', () => {
    const { r, created } = reducerWith();
    created('ses_root', '/home/user/proj');
    created('ses_kid', null, 'ses_root');
    created('ses_grandkid', null, 'ses_kid');
    created('ses_other', '/home/user/elsewhere', 'ses_root');
    expect(dirOfSession(r, 'ses_kid')).toBe('/home/user/proj');
    expect(dirOfSession(r, 'ses_grandkid')).toBe('/home/user/proj');
    expect(dirOfSession(r, 'ses_other')).toBe('/home/user/elsewhere');
  });

  test('unknown, directory-less roots, broken chains and loops are null', () => {
    const { r, created } = reducerWith();
    created('ses_nodir');
    created('ses_kid', null, 'ses_gone');
    created('ses_a', null, 'ses_b');
    created('ses_b', null, 'ses_a');
    for (const id of ['ses_unknown', 'ses_nodir', 'ses_kid', 'ses_a', undefined, null, 5, {}]) {
      expect(dirOfSession(r, id), String(id)).toBeNull();
    }
    expect(dirOfSession(null, 'ses_nodir')).toBeNull();
    expect(dirOfSession({}, 'ses_nodir')).toBeNull();
  });

  test('a chain deeper than the cap is null, not a hang', () => {
    const { r, created } = reducerWith();
    created('s0', '/deep');
    for (let i = 1; i <= 60; i++) created(`s${i}`, null, `s${i - 1}`);
    expect(dirOfSession(r, 's10')).toBe('/deep');
    expect(dirOfSession(r, 's60')).toBeNull();
  });

  test('the core exposes it, bound to its reducer', () => {
    const core = createCore({ home: '/home/user', mail: null, listPanes: async () => null, setInterval: () => 0, clearInterval: () => {} });
    core.reducer.apply({ id: 'e1', type: 'session.created', created: 1000, data: { sessionID: 'ses_a' }, location: { directory: '/home/user/proj' } });
    expect(core.dirOfSession('ses_a')).toBe('/home/user/proj');
    expect(core.dirOfSession('ses_none')).toBeNull();
    expect(core.dirOfSession(undefined)).toBeNull();
    // Detached from `this`: Task 9 hands it to the permission handler as a bare function.
    const { dirOfSession: bare } = core;
    expect(bare('ses_a')).toBe('/home/user/proj');
  });
});
