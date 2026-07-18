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

test('persists at most maxJobs newest jobs', async () => {
  const saved = [];
  const m = make({ maxJobs: 2, save: (j) => saved.push(j), _saved: saved });
  m.start({ ...BOX, id: 'x1' }, { tools: [] });
  m.start({ ...BOX, id: 'x2' }, { tools: [] });
  m.start({ ...BOX, id: 'x3' }, { tools: [] });
  const last = saved[saved.length - 1];
  expect(last.length).toBeLessThanOrEqual(2);
});
