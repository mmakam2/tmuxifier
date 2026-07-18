import { test, expect } from 'vitest';
import { createSetupManager } from '../src/server/setupManager.js';

const BOX = { id: 'b1', label: 'web-1', host: '192.168.1.10', user: 'root', sessionName: 'web' };

// Fake sshStream: drives onData with the planned chunks, then resolves the code.
// A pending plan (no code) never resolves — used for dedupe/cancel tests.
function fakeSsh(plan) {
  const calls = [];
  const fn = (argv, { onData } = {}) => {
    calls.push(argv);
    let killed = false;
    const done = plan.pending
      ? new Promise(() => {})
      : (async () => {
          for (const [stream, chunk] of (plan.chunks || [])) onData?.(chunk, stream);
          return { code: killed ? 137 : plan.code };
        })();
    return { done, kill: () => { killed = true; }, _killed: () => killed };
  };
  fn.calls = calls;
  return fn;
}

// Fake sshStream that emits a single sudo-password-prompt phrase on stderr, then
// resolves with the given exit code. Replaces the brief's inline `require` trick.
const sudoSsh = (phrase, code) => (argv, { onData }) => { onData?.(phrase, 'stderr'); return { done: Promise.resolve({ code }), kill() {} }; };

function make(overrides = {}) {
  let seq = 0;
  const saved = [];
  return createSetupManager({
    sshStream: fakeSsh({ chunks: [['stdout', 'ok\n']], code: 0 }),
    buildSetupArgv: () => ['argv'],
    buildScript: () => 'SCRIPT',
    load: () => [],
    save: (jobs) => saved.push(jobs),
    now: () => '2026-07-18T00:00:00.000Z',
    makeId: () => `job-${++seq}`,
    sleep: async () => {},
    _saved: saved,
    ...overrides,
  });
}

test('happy path: streams to log and finishes done', async () => {
  const m = make();
  const s = m.start(BOX, { ohMyTmux: true, tools: [] });
  expect(s.status).toBe('running');
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.log).toContain('ok');
  expect(job.finishedAt).toBeTruthy();
});

test('sudo-password stderr -> needs-interactive', async () => {
  const m = make({ sshStream: sudoSsh('sudo: a terminal is required to read the password; see below\n', 1) });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
});

test('hard non-zero exit -> error (box never touched by manager)', async () => {
  const m = make({ sshStream: (argv, { onData }) => { onData?.('nope\n', 'stderr'); return { done: Promise.resolve({ code: 2 }), kill() {} }; } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('error');
  expect(job.error).toContain('2');
});

test('timeout code 124 -> error with timeout note', async () => {
  const m = make({ sshStream: () => ({ done: Promise.resolve({ code: 124 }), kill() {} }) });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).error).toMatch(/tim(e|ed) out/i);
});

test('waitForSsh probes until ready, then runs', async () => {
  let n = 0;
  const probe = async () => (++n >= 3);
  const m = make({ probe });
  const s = m.start(BOX, { tools: [] }, { waitForSsh: true });
  await m._settled(s.id);
  expect(n).toBeGreaterThanOrEqual(3);
  expect(m.getJob(s.id).status).toBe('done');
});

test('one active job per box: second start returns the running job', async () => {
  const m = make({ sshStream: fakeSsh({ pending: true }) });
  const a = m.start(BOX, { tools: [] });
  const b = m.start(BOX, { tools: [] });
  expect(b.id).toBe(a.id);
});

test('markInteractiveResult(0) -> done; non-zero leaves needs-interactive', async () => {
  const m = make({ sshStream: sudoSsh('sudo: a password is required\n', 1) });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
  m.markInteractiveResult(BOX.id, 1);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
  m.markInteractiveResult(BOX.id, 0);
  expect(m.getJob(s.id).status).toBe('done');
});

test('reconciles a running job to interrupted on load', () => {
  const m = make({ load: () => [{ id: 'old', boxId: 'b9', status: 'running', phase: 'running', createdAt: '2026-01-01T00:00:00.000Z', log: '' }] });
  expect(m.getJob('old').status).toBe('interrupted');
});

test('caps terminal history at maxJobs, evicting the oldest terminal job', async () => {
  const m = make({ maxJobs: 2 });
  const a = m.start({ ...BOX, id: 'x1' }, { tools: [] });
  const b = m.start({ ...BOX, id: 'x2' }, { tools: [] });
  const c = m.start({ ...BOX, id: 'x3' }, { tools: [] });
  await Promise.all([m._settled(a.id), m._settled(b.id), m._settled(c.id)]);
  expect(m.listJobs().length).toBe(2);       // only newest 2 terminal kept
  expect(m.getJob(a.id)).toBeUndefined();     // oldest evicted
  expect(m.getJob(c.id)).toBeTruthy();        // newest kept
});

test('sudo phrase split across stderr chunks still -> needs-interactive', async () => {
  const m = make({ sshStream: (argv, { onData }) => {
    onData?.('sudo: a terminal is required to ', 'stderr');
    onData?.('read the password; see below\n', 'stderr');
    return { done: Promise.resolve({ code: 1 }), kill() {} };
  } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
});

test('matching text on stdout does NOT trigger needs-interactive (stderr-scoped)', async () => {
  const m = make({ sshStream: (argv, { onData }) => {
    onData?.('installing ssh-askpass helper\n', 'stdout'); // regex-matching text, but on stdout
    onData?.('E: apt failed\n', 'stderr');
    return { done: Promise.resolve({ code: 1 }), kill() {} };
  } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('error');
});

test('needs-interactive job is NOT reconciled on load', () => {
  const m = make({ load: () => [{ id: 'ni', boxId: 'bni', status: 'needs-interactive', phase: null, createdAt: '2026-01-01T00:00:00.000Z', log: '' }] });
  expect(m.getJob('ni').status).toBe('needs-interactive');
});

test('prune keeps an in-flight running job even when newer terminal jobs arrive', async () => {
  let call = 0;
  const pending = { done: new Promise(() => {}), kill() {} };
  const m = make({ maxJobs: 1, sshStream: () => (call++ === 0 ? pending : { done: Promise.resolve({ code: 0 }), kill() {} }) });
  const a = m.start({ ...BOX, id: 'b1' }, { tools: [] }); // stays running (pending)
  const b = m.start({ ...BOX, id: 'b2' }, { tools: [] }); // completes
  await m._settled(b.id);
  expect(m.getJob(a.id)).toBeTruthy();
  expect(m.getJob(a.id).status).toBe('running');
  expect(m.getJob(b.id)).toBeTruthy();
  expect(m.getJob(b.id).status).toBe('done');
});

test('cancelForBox kills the running job handle', async () => {
  let killed = false;
  const m = make({ sshStream: () => ({ done: new Promise(() => {}), kill: () => { killed = true; } }) });
  m.start(BOX, { tools: [] });
  m.cancelForBox(BOX.id);
  expect(killed).toBe(true);
});
