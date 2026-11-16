import { test, expect, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createCore,
  createPaneTagger,
} from '../src/server/assets/tmuxifier-opencode-agent.js';

// The pane tagger (agent messaging, spec §6.9, ruling R7/R23). OpenCode runs every agent shell
// command from its one shared server, whose TMUX_PANE is the first TUI's forever, so `tmx` would
// speak as the wrong tmux session. OpenCode 2.3.0 (test/fixtures/README-opencode-2.3-event-trace.md
// F4) calls `tool.execute.before` ({ tool: 'shell', sessionID, id, input: { command } }) and, in the
// same millisecond, `shell.create.before` ({ command, cwd, timeout, shell, env }): the second names
// neither the call nor the session, so the tagger remembers the first by command text and tags the
// second's mutable `env` with TMUXIFIER_MAIL_PANE (a pane id, or `none`).

const PANES = { ses_a: '%3', ses_b: '%5' };
const paneOf = (sessionID) => PANES[sessionID] ?? null;

const tool = (sessionID, command, id = `call_${command}_${sessionID}`, over = {}) => ({
  tool: 'shell', sessionID, agent: 'build', messageID: 'msg_1', id, input: { command }, ...over,
});
const shell = (command, env = { PATH: '/usr/bin', TMUX_PANE: '%0' }) => ({
  command, cwd: '/home/user/proj', timeout: 120000, shell: '/usr/bin/bash', env,
});
const tagged = (tagger, command) => {
  const p = shell(command);
  tagger.beforeShell(p);
  return p.env.TMUXIFIER_MAIL_PANE;
};

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('createPaneTagger', () => {
  test('one call: the shell command is tagged with its session\'s pane, and the shell\'s own env is kept', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx who'));
    const p = shell('tmx who');
    t.beforeShell(p);
    expect(p.env).toEqual({ PATH: '/usr/bin', TMUX_PANE: '%0', TMUXIFIER_MAIL_PANE: '%3' });
  });

  test('two sessions in turn each get their own pane; a record is used once', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx inbox'));
    expect(tagged(t, 'tmx inbox')).toBe('%3');
    t.beforeTool(tool('ses_b', 'tmx inbox'));
    expect(tagged(t, 'tmx inbox')).toBe('%5');
    // The first call's record is gone: a command nobody announced is `none`.
    expect(tagged(t, 'tmx inbox')).toBe('none');
  });

  test('a session with no pane (not a mail target) is `none`; so is a call nobody announced', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_unknown', 'tmx who'));
    expect(tagged(t, 'tmx who')).toBe('none');
    expect(tagged(t, 'tmx read t-aaaaaaaa')).toBe('none');
    // Different text is a different call: the record is kept for its own command.
    t.beforeTool(tool('ses_a', 'tmx who'));
    expect(tagged(t, 'tmx who ')).toBe('none');
    expect(tagged(t, 'tmx who')).toBe('%3');
  });

  test('anything paneOf says that is not a pane id is `none`, and a throwing paneOf never escapes', () => {
    for (const answer of [null, undefined, '', 'none', '%', '%x', '%1234567890', '%3; id', 3, {}, ['%3']]) {
      const t = createPaneTagger({ paneOf: () => answer });
      t.beforeTool(tool('ses_a', 'tmx who'));
      expect(tagged(t, 'tmx who'), String(answer)).toBe('none');
    }
    const t = createPaneTagger({ paneOf: () => { throw new Error('boom'); } });
    expect(() => t.beforeTool(tool('ses_a', 'tmx who'))).not.toThrow();
    expect(tagged(t, 'tmx who')).toBe('none');
  });

  test('only the shell tool is recorded, and its command comes from input.command', () => {
    const t = createPaneTagger({ paneOf });
    for (const name of ['bash', 'question', 'skill', 'Shell', 'edit', undefined]) {
      t.beforeTool(tool('ses_a', 'tmx who', `call_${name}`, { tool: name }));
    }
    expect(tagged(t, 'tmx who')).toBe('none');
    // A command that is not a string is not recorded either.
    for (const input of [undefined, null, 'tmx who', {}, { command: 7 }, { command: ['tmx who'] }, { cmd: 'tmx who' }]) {
      t.beforeTool({ tool: 'shell', sessionID: 'ses_a', id: 'x', input });
    }
    expect(tagged(t, 'tmx who')).toBe('none');
  });

  test('two pending calls with one command text for different panes: `none` for both, in either order', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx inbox'));
    t.beforeTool(tool('ses_b', 'tmx inbox'));
    expect(tagged(t, 'tmx inbox')).toBe('none');
    expect(tagged(t, 'tmx inbox')).toBe('none'); // the second shell never inherits the survivor's pane
    expect(tagged(t, 'tmx inbox')).toBe('none');

    // One of the two has no pane at all: still not told apart.
    t.beforeTool(tool('ses_a', 'tmx who'));
    t.beforeTool(tool('ses_unknown', 'tmx who'));
    expect(tagged(t, 'tmx who')).toBe('none');
    expect(tagged(t, 'tmx who')).toBe('none');
  });

  test('two pending calls with one command text for the SAME pane are that pane, one record each', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx inbox', 'call_1'));
    t.beforeTool(tool('ses_a', 'tmx inbox', 'call_2'));
    expect(tagged(t, 'tmx inbox')).toBe('%3');
    expect(tagged(t, 'tmx inbox')).toBe('%3');
    expect(tagged(t, 'tmx inbox')).toBe('none');
  });

  test('the oldest record is the one a shell consumes, so the newer one outlives it', () => {
    const c = clock();
    const t = createPaneTagger({ paneOf, now: c.now, ttlMs: 30000 });
    t.beforeTool(tool('ses_a', 'tmx who', 'call_1'));
    c.t += 20000;
    t.beforeTool(tool('ses_a', 'tmx who', 'call_2'));
    c.t += 1000;
    expect(tagged(t, 'tmx who')).toBe('%3'); // call_1's
    c.t += 19000; // call_1 would be 40 s old, call_2 is 20 s
    expect(tagged(t, 'tmx who')).toBe('%3'); // call_2's, still alive
  });

  test('a call of another command in between never disturbs the match', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx who'));
    t.beforeTool(tool('ses_b', 'tmx inbox'));
    t.beforeTool(tool('ses_b', 'tmx who')); // collides with a's: ambiguous
    expect(tagged(t, 'tmx inbox')).toBe('%5');
    expect(tagged(t, 'tmx who')).toBe('none');
    expect(tagged(t, 'tmx who')).toBe('none');
  });

  test('records expire after ttlMs on the injected clock', () => {
    const c = clock();
    const t = createPaneTagger({ paneOf, now: c.now, ttlMs: 30000 });
    t.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 30000; // exactly ttl: still there
    expect(tagged(t, 'tmx who')).toBe('%3');

    t.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 30001;
    expect(tagged(t, 'tmx who')).toBe('none');

    // An expired record never makes a fresh call ambiguous.
    t.beforeTool(tool('ses_b', 'tmx who'));
    c.t += 20000;
    t.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 20000; // b's is 40 s old, a's 20 s
    expect(tagged(t, 'tmx who')).toBe('%3');
  });

  test('the default ttl is 30 seconds and a short one is honoured', () => {
    const c = clock();
    const d = createPaneTagger({ paneOf, now: c.now });
    d.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 29999;
    expect(tagged(d, 'tmx who')).toBe('%3');
    d.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 30001;
    expect(tagged(d, 'tmx who')).toBe('none');
    const s = createPaneTagger({ paneOf, now: c.now, ttlMs: 50 });
    s.beforeTool(tool('ses_a', 'tmx who'));
    c.t += 51;
    expect(tagged(s, 'tmx who')).toBe('none');
  });

  test('the same call announced twice (one hook registered twice) is one record', () => {
    const t = createPaneTagger({ paneOf });
    t.beforeTool(tool('ses_a', 'tmx who', 'call_dup'));
    t.beforeTool(tool('ses_a', 'tmx who', 'call_dup'));
    expect(tagged(t, 'tmx who')).toBe('%3');
    // Even after its shell was created: a late duplicate leaves nothing for another session's call.
    t.beforeTool(tool('ses_a', 'tmx who', 'call_dup'));
    t.beforeTool(tool('ses_b', 'tmx who', 'call_other'));
    expect(tagged(t, 'tmx who')).toBe('%5');
  });

  test('the pending list is bounded', () => {
    const t = createPaneTagger({ paneOf });
    for (let i = 0; i < 5000; i++) t.beforeTool(tool('ses_a', `cmd ${i}`, `call_${i}`));
    expect(tagged(t, 'cmd 0')).toBe('none'); // the oldest were dropped
    expect(tagged(t, 'cmd 4999')).toBe('%3');
  });

  test('every shell it sees is tagged, including a stale TMUXIFIER_MAIL_PANE already in env', () => {
    const t = createPaneTagger({ paneOf });
    const p = shell('ls', { TMUXIFIER_MAIL_PANE: '%9' });
    t.beforeShell(p);
    expect(p.env.TMUXIFIER_MAIL_PANE).toBe('none');
    t.beforeTool(tool('ses_b', 'tmx who'));
    const q = shell('tmx who', { TMUXIFIER_MAIL_PANE: '%9' });
    t.beforeShell(q);
    expect(q.env.TMUXIFIER_MAIL_PANE).toBe('%5');
  });

  test('a malformed payload is a no-op or `none`, never a throw', () => {
    const t = createPaneTagger({ paneOf });
    const junk = [undefined, null, 0, 'x', [], () => {}, { tool: 'shell' }, { tool: 'shell', input: null }, { env: null }, { env: 3 }, { command: 'x', env: 'str' }];
    for (const j of junk) {
      expect(() => t.beforeTool(j), String(j)).not.toThrow();
      expect(() => t.beforeShell(j), String(j)).not.toThrow();
    }
    // No env to tag: nothing is invented on the payload.
    const noEnv = { command: 'tmx who' };
    t.beforeShell(noEnv);
    expect(noEnv).toEqual({ command: 'tmx who' });
    // A shell with no usable command is `none`.
    for (const command of [undefined, null, 5, {}]) {
      const p = { command, env: {} };
      t.beforeShell(p);
      expect(p.env.TMUXIFIER_MAIL_PANE).toBe('none');
    }
    // A frozen env cannot be written: still no throw.
    const frozen = { command: 'tmx who', env: Object.freeze({ A: '1' }) };
    expect(() => t.beforeShell(frozen)).not.toThrow();
    // A hostile payload whose getters throw.
    const evil = { get tool() { throw new Error('tool'); }, get input() { throw new Error('input'); } };
    expect(() => t.beforeTool(evil)).not.toThrow();
    const evilShell = { get command() { throw new Error('command'); }, get env() { throw new Error('env'); } };
    expect(() => t.beforeShell(evilShell)).not.toThrow();
    // And the tagger still works afterwards.
    t.beforeTool(tool('ses_a', 'tmx who'));
    expect(tagged(t, 'tmx who')).toBe('%3');
  });

  test('a missing or broken paneOf or clock tags `none` and never throws', () => {
    for (const opts of [{}, { paneOf: 'x' }, { paneOf: null }]) {
      const t = createPaneTagger(opts);
      expect(() => t.beforeTool(tool('ses_a', 'tmx who'))).not.toThrow();
      expect(tagged(t, 'tmx who')).toBe('none');
    }
    const t = createPaneTagger({ paneOf, now: () => { throw new Error('clock'); } });
    expect(() => t.beforeTool(tool('ses_a', 'tmx who'))).not.toThrow();
    expect(() => t.beforeShell(shell('tmx who'))).not.toThrow();
    expect(() => createPaneTagger(undefined)).not.toThrow();
  });
});

// The real 2.3.0 recording: every shell call of the run, announced by `hook.execute.before` and
// created by `hook.create.before` in the same instance (tag), in the order OpenCode made them.
describe('createPaneTagger on the 2.3.0 recording', () => {
  const TRACE = fileURLToPath(new URL('./fixtures/opencode-2.3-event-trace.jsonl', import.meta.url));
  const recs = readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  test('every recorded shell command is tagged with the pane of the session that ran it', () => {
    // Two OpenCode sessions, in two directories, in two tmux panes of two tmux sessions.
    const sessions = [...new Set(recs.filter((r) => r.kind === 'hook.execute.before').map((r) => r.input.sessionID))];
    expect(sessions).toHaveLength(2);
    const panes = new Map([[sessions[0], '%1'], [sessions[1], '%2']]);
    // The plugin's hooks fire only in the instance whose directory owns the session: one tagger per tag.
    const taggers = new Map();
    const taggerOf = (tag) => {
      if (!taggers.has(tag)) taggers.set(tag, createPaneTagger({ paneOf: (id) => panes.get(id) ?? null, now: () => 0 }));
      return taggers.get(tag);
    };
    const expected = new Map(); // create.before line -> the pane of the session of the announcing call
    let announced = [];
    const seen = [];
    for (const [i, r] of recs.entries()) {
      if (r.kind === 'hook.execute.before') {
        taggerOf(r.tag).beforeTool(r.input);
        if (r.input.tool === 'shell') announced.push({ tag: r.tag, command: r.input.input.command, pane: panes.get(r.input.sessionID) });
      } else if (r.kind === 'hook.create.before') {
        const p = { ...r.input, env: { SHELL: '/usr/bin/bash', TMUX_PANE: '%0' } };
        taggerOf(r.tag).beforeShell(p);
        const k = announced.findIndex((a) => a.tag === r.tag && a.command === r.input.command);
        expect(k, `line ${i + 1} (${r.input.command}) has an announcing call`).toBeGreaterThanOrEqual(0);
        expected.set(i + 1, announced[k].pane);
        announced.splice(k, 1);
        seen.push([i + 1, r.input.command, p.env.TMUXIFIER_MAIL_PANE]);
        expect(p.env.TMUX_PANE, 'the server\'s own variable is left alone').toBe('%0');
      }
    }
    expect(seen.length).toBe(16);
    for (const [line, command, pane] of seen) expect(pane, `line ${line} ${command}`).toBe(expected.get(line));
    expect(new Set(seen.map((s) => s[2]))).toEqual(new Set(['%1', '%2']));
    expect(announced).toEqual([]); // every announced shell call reached its create.before
  });
});

// R23: `paneOf(sessionID)` is the pane of the tmux session whose current mail target has that
// OpenCode session. The core keeps the targets map its last complete sweep computed.
describe('the core\'s mail targets, for the tagger', () => {
  const CWD = '/home/user/proj';
  const row = (session, wa, pa, cmd, p, id) => `${session}\t${wa}\t${pa}\t${cmd}\t${p}\t${id}\n`;

  function world(listing) {
    const calls = { n: 0 };
    const core = createCore({
      home: '/nonexistent-home-for-tests',
      mail: null,
      now: () => 100,
      listPanes: async () => {
        calls.n++;
        return typeof listing === 'function' ? listing() : listing;
      },
      paneCacheMs: 0,
    });
    // Evidence: a root session in /home/user/proj with an operator prompt.
    const ev = (type, data, dir) => core.reducer.apply({ id: `e${Math.random()}`, type, created: 100_000, data, ...(dir ? { location: { directory: dir } } : {}) });
    ev('session.created', { sessionID: 'ses_a' }, CWD);
    ev('session.inbox.enqueued', { sessionID: 'ses_a', inboxID: 'i1', item: { type: 'user' } }, CWD);
    return { core, calls };
  }

  test('empty before the first sweep; the pane of the target\'s tmux session after a complete one', async () => {
    const w = world(row('octest', 1, 1, 'opencode', CWD, '%3'));
    expect(w.core.mailTargetsNow().size).toBe(0);
    expect(w.core.paneOfSession('ses_a')).toBeNull();
    await w.core.sweep();
    expect([...w.core.mailTargetsNow()]).toEqual([['octest', { pane: '%3', sessionID: 'ses_a', dir: CWD }]]);
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
    expect(w.core.paneOfSession('ses_other')).toBeNull();
    expect(w.core.paneOfSession(undefined)).toBeNull();
    expect(w.core.paneOfSession(7)).toBeNull();
    // The caller cannot reach into the core's map.
    w.core.mailTargetsNow().clear();
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
  });

  test('an incomplete or failed listing leaves no targets at all (R17)', async () => {
    let text = row('octest', 1, 1, 'opencode', CWD, '%3');
    const w = world(() => text);
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
    text = row('octest', 1, 1, 'opencode', CWD, '%3') + 'a row without its fields\n';
    await w.core.sweep();
    expect(w.core.mailTargetsNow().size).toBe(0);
    expect(w.core.paneOfSession('ses_a')).toBeNull();
    text = row('octest', 1, 1, 'opencode', CWD, '%3');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
    text = null; // tmux not usable
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBeNull();
  });

  test('the target moves with the pane, and a stopped core names nobody', async () => {
    let text = row('octest', 1, 1, 'opencode', CWD, '%3');
    const w = world(() => text);
    await w.core.sweep();
    text = row('octest', 1, 1, 'opencode', CWD, '%8');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBe('%8');
    text = row('octest', 1, 1, 'zsh', CWD, '%8'); // the TUI exited
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBeNull();
    text = row('octest', 1, 1, 'opencode', CWD, '%8');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_a')).toBe('%8');
    w.core.abort();
    expect(w.core.paneOfSession('ses_a')).toBeNull();
  });

  // R24: a subagent runs inside its root's TUI, so its shell commands speak for the root's pane.
  const child = (w, id, parentID, dir = CWD) =>
    w.core.reducer.apply({ id: `e${Math.random()}`, type: 'session.created', created: 100_000, data: { sessionID: id, parentID }, location: { directory: dir } });

  test('a child session, and a grandchild, speak for their root\'s pane (R24)', async () => {
    const w = world(row('octest', 1, 1, 'opencode', CWD, '%3'));
    child(w, 'ses_child', 'ses_a');
    child(w, 'ses_grand', 'ses_child');
    await w.core.sweep();
    // Only the root is a target; its descendants resolve through the parent chain.
    expect([...w.core.mailTargetsNow().values()].map((t) => t.sessionID)).toEqual(['ses_a']);
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
    expect(w.core.paneOfSession('ses_child')).toBe('%3');
    expect(w.core.paneOfSession('ses_grand')).toBe('%3');
    const tagger = createPaneTagger({ paneOf: (id) => w.core.paneOfSession(id) });
    tagger.beforeTool(tool('ses_grand', 'tmx inbox'));
    expect(tagged(tagger, 'tmx inbox')).toBe('%3');
  });

  test('a descendant follows its root\'s target, and goes with it', async () => {
    let text = row('octest', 1, 1, 'opencode', CWD, '%3');
    const w = world(() => text);
    child(w, 'ses_child', 'ses_a');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_child')).toBe('%3');
    text = row('octest', 1, 1, 'opencode', CWD, '%8');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_child')).toBe('%8');
    text = row('octest', 1, 1, 'zsh', CWD, '%8'); // the TUI exited: the root is no target
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_child')).toBeNull();
  });

  test('a child of a session that is no target, or of one the reducer does not know, is `none` (R24)', async () => {
    const w = world(row('octest', 1, 1, 'opencode', CWD, '%3'));
    // A root with no operator evidence is no target, so neither is its child.
    w.core.reducer.apply({ id: 'e-x', type: 'session.created', created: 100_000, data: { sessionID: 'ses_idle' }, location: { directory: CWD } });
    child(w, 'ses_idle_child', 'ses_idle');
    // A child whose parent never appeared.
    child(w, 'ses_orphan', 'ses_missing');
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_idle_child')).toBeNull();
    expect(w.core.paneOfSession('ses_idle')).toBeNull();
    expect(w.core.paneOfSession('ses_orphan')).toBeNull();
    expect(w.core.paneOfSession('ses_missing')).toBeNull();
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
  });

  test('a parent cycle, a session its own parent and an absurdly deep chain are `none`, never a loop (R24)', async () => {
    const w = world(row('octest', 1, 1, 'opencode', CWD, '%3'));
    child(w, 'ses_x', 'ses_y');
    child(w, 'ses_y', 'ses_x');
    child(w, 'ses_self', 'ses_self');
    // 100 levels down from the real root: far past anything a subagent tree has.
    let parent = 'ses_a';
    for (let i = 0; i < 100; i++) {
      child(w, `ses_deep${i}`, parent);
      parent = `ses_deep${i}`;
    }
    await w.core.sweep();
    expect(w.core.paneOfSession('ses_x')).toBeNull();
    expect(w.core.paneOfSession('ses_y')).toBeNull();
    expect(w.core.paneOfSession('ses_self')).toBeNull();
    expect(w.core.paneOfSession('ses_deep99')).toBeNull();
    expect(w.core.paneOfSession('ses_deep3')).toBe('%3'); // a normal depth still resolves
    expect(w.core.paneOfSession('ses_a')).toBe('%3');
  });

  test('a core with no mail part still answers, and the tagger reads it', async () => {
    const w = world(row('octest', 1, 1, 'opencode', CWD, '%3') + row('other', 1, 1, 'zsh', '/tmp', '%4'));
    await w.core.sweep();
    const tagger = createPaneTagger({ paneOf: (id) => w.core.paneOfSession(id) });
    tagger.beforeTool(tool('ses_a', 'tmx who'));
    expect(tagged(tagger, 'tmx who')).toBe('%3');
    tagger.beforeTool(tool('ses_b', 'tmx who')); // not a target
    expect(tagged(tagger, 'tmx who')).toBe('none');
  });
});
