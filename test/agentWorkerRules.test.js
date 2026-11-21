import { describe, expect, test } from 'vitest';
import {
  EMPTY_WORKERS,
  MAX_PROJECTS,
  PROJECT_NAME_RE,
  WORKER_AGENTS,
  WORKER_DIR_RE,
  WORKER_MODES,
  WORKER_PREFIX,
  WORKERS_MAX_DEFAULT,
  WORKERS_MAX_LIMIT,
  isWorkerDir,
  normalizeWorkers,
  runningWorkers,
  workerSessionName,
} from '../src/server/agentWorkerRules.js';
import { SESSION_NAME_RE } from '../src/server/sshCommand.js';

describe('constants', () => {
  test('are the values the design names, and frozen', () => {
    expect([MAX_PROJECTS, WORKERS_MAX_LIMIT, WORKERS_MAX_DEFAULT, WORKER_PREFIX]).toEqual([8, 8, 3, 'worker-']);
    expect(WORKER_MODES).toEqual(['interactive']);
    expect(WORKER_AGENTS).toEqual({ claude: { launch: 'claude', kind: 'claude' } });
    expect(EMPTY_WORKERS).toEqual({ projects: [], mailStart: false, max: 3 });
    for (const o of [WORKER_MODES, WORKER_AGENTS, WORKER_AGENTS.claude, EMPTY_WORKERS, EMPTY_WORKERS.projects])
      expect(Object.isFrozen(o)).toBe(true);
    expect(PROJECT_NAME_RE.test('a0-b')).toBe(true);
    expect(WORKER_DIR_RE.test('/opt/x')).toBe(true);
  });
});

describe('isWorkerDir', () => {
  test('accepts absolute paths in the allowlist only', () => {
    for (const ok of ['/opt/billing-api', '/root/dir', '/srv/a.b_c-d/e']) expect(isWorkerDir(ok)).toBe(true);
    for (const bad of ['', '/', 'opt/x', '/opt/x/', '/opt//x', '/opt/../etc', '/opt/x y', "/opt/x'", '/opt/$HOME', '/opt/x;ls', `/${'a'.repeat(200)}`, 7, null])
      expect(isWorkerDir(bad)).toBe(false);
  });
  test('a dot-dot segment is refused wherever it stands, a longer dotted name is not', () => {
    for (const bad of ['/..', '/../x', '/opt/..', '/opt/../x']) expect(isWorkerDir(bad)).toBe(false);
    for (const ok of ['/opt/...', '/opt/..x', '/opt/x..y', '/.hidden']) expect(isWorkerDir(ok)).toBe(true);
  });
  test('a newline or a non-string never passes', () => {
    for (const bad of ['/opt/x\n', '/opt/\nx', '/opt/x\r', undefined, {}, ['/opt/x'], true]) expect(isWorkerDir(bad)).toBe(false);
  });
  test('the longest allowed path passes, one more character does not', () => {
    expect(isWorkerDir(`/${'a'.repeat(199)}`)).toBe(true);
    expect(isWorkerDir(`/${'a'.repeat(200)}`)).toBe(false);
  });
});

describe('normalizeWorkers', () => {
  test('fills defaults and keeps order', () => {
    expect(normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/billing-api' }, { name: 'web', dir: '/opt/web', trust: true }] }))
      .toEqual({ projects: [{ name: 'api', dir: '/opt/billing-api', trust: false }, { name: 'web', dir: '/opt/web', trust: true }], mailStart: false, max: 3 });
  });
  test('an empty object is the empty record, as a fresh copy', () => {
    const w = normalizeWorkers({});
    expect(w).toEqual(EMPTY_WORKERS);
    expect(w).not.toBe(EMPTY_WORKERS);
    expect(Object.isFrozen(w.projects)).toBe(false);
  });
  test('refuses bad input, naming the field', () => {
    const p = (name, dir) => ({ name, dir });
    expect(() => normalizeWorkers(null)).toThrow('workers must be an object');
    expect(() => normalizeWorkers([])).toThrow('workers must be an object');
    expect(() => normalizeWorkers('x')).toThrow('workers must be an object');
    expect(() => normalizeWorkers({ projects: 'x' })).toThrow('projects must be an array');
    expect(() => normalizeWorkers({ projects: Array.from({ length: 9 }, (_, i) => p(`p${i}`, '/opt/x')) })).toThrow('too many projects');
    expect(() => normalizeWorkers({ projects: [p('API', '/opt/x')] })).toThrow('bad project name');
    expect(() => normalizeWorkers({ projects: [p('api', '/opt/../x')] })).toThrow('bad directory');
    expect(() => normalizeWorkers({ projects: [p('api', '/opt/x'), p('api', '/opt/y')] })).toThrow('duplicate project name');
    for (const max of [0, 9, 1.5, '3']) expect(() => normalizeWorkers({ projects: [], max })).toThrow('max must be 1 to 8');
  });
  test('a name that is not a project name is refused', () => {
    for (const name of ['', '-a', 'a_b', 'a b', 'a'.repeat(25), '../x', 7, null, undefined])
      expect(() => normalizeWorkers({ projects: [{ name, dir: '/opt/x' }] })).toThrow('bad project name');
    expect(normalizeWorkers({ projects: [{ name: 'a'.repeat(24), dir: '/opt/x' }] }).projects[0].name).toBe('a'.repeat(24));
  });
  test('a project that is not an object is refused', () => {
    for (const project of [null, 'api', 7, [], undefined])
      expect(() => normalizeWorkers({ projects: [project] })).toThrow('project must be an object');
  });
  test('eight projects pass, and the limits of max are inclusive', () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, dir: '/opt/x' }));
    expect(normalizeWorkers({ projects }).projects).toHaveLength(8);
    expect(normalizeWorkers({ projects: [], max: 1 }).max).toBe(1);
    expect(normalizeWorkers({ projects: [], max: 8 }).max).toBe(8);
  });
  test('max is never defaulted for a value that was sent', () => {
    expect(() => normalizeWorkers({ max: null })).toThrow('max must be 1 to 8');
    expect(() => normalizeWorkers({ max: NaN })).toThrow('max must be 1 to 8');
    expect(normalizeWorkers({}).max).toBe(3);
  });
  test('trust and mailStart are on only for a literal true', () => {
    const w = normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/x', trust: 'yes' }], mailStart: 1 });
    expect(w.projects[0].trust).toBe(false);
    expect(w.mailStart).toBe(false);
    expect(normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/x', trust: true }], mailStart: true }))
      .toMatchObject({ mailStart: true, projects: [{ trust: true }] });
  });
  test('only the three project fields survive', () => {
    const w = normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/x', launch: 'rm -rf /', mode: 'x' }], extra: 1 });
    expect(w).toEqual({ projects: [{ name: 'api', dir: '/opt/x', trust: false }], mailStart: false, max: 3 });
  });
  test('the result does not share the input objects', () => {
    const input = { name: 'api', dir: '/opt/x' };
    const w = normalizeWorkers({ projects: [input] });
    expect(w.projects[0]).not.toBe(input);
  });
});

describe('workerSessionName', () => {
  test('takes the lowest free number, skipping leftovers', () => {
    expect(workerSessionName('api', [])).toBe('worker-api-1');
    expect(workerSessionName('api', ['main', 'worker-api-1', 'worker-api-3', 'worker-web-2'])).toBe('worker-api-2');
  });
  test('a number is taken only by the same project, and the name is exact', () => {
    expect(workerSessionName('api', ['worker-api-10', 'worker-api-x', 'worker-api-1-2', 'xworker-api-1'])).toBe('worker-api-1');
    expect(workerSessionName('api', ['worker-api-1', 'worker-api-2', 'worker-api-3'])).toBe('worker-api-4');
  });
  test('always passes SESSION_NAME_RE, even for the longest project name', () => {
    const name = workerSessionName('a'.repeat(24), []);
    expect(name).toBe(`worker-${'a'.repeat(24)}-1`);
    expect(SESSION_NAME_RE.test(name)).toBe(true);
  });
  test('refuses a project that is not a project name instead of rewriting it', () => {
    for (const bad of ['API', '', '../x', "a'b", 'a'.repeat(25), 7, null, undefined])
      expect(() => workerSessionName(bad, [])).toThrow('bad project name');
  });
});

describe('runningWorkers', () => {
  test('counts worker sessions whose pane runs claude', () => {
    expect(runningWorkers([
      { name: 'worker-api-1', paneCmd: 'claude' }, { name: 'worker-api-2', paneCmd: 'zsh' },
      { name: 'worker-x', paneCmd: 'claude' }, { name: 'main', paneCmd: 'claude' }, { name: 'worker-web-1', paneCmd: 'codex' },
    ])).toBe(2);
  });
  test('an empty listing, and a listing with malformed rows, count what is well formed', () => {
    expect(runningWorkers([])).toBe(0);
    expect(runningWorkers([null, undefined, 7, {}, { name: 7, paneCmd: 'claude' }, { name: 'worker-a-1' }, { name: 'worker-a-2', paneCmd: 'claude' }])).toBe(1);
  });
  test('claude with a version suffix is claude, and the prefix must lead the name', () => {
    expect(runningWorkers([{ name: 'worker-a-1', paneCmd: 'claude-2.1' }, { name: 'my-worker-a-1', paneCmd: 'claude' }])).toBe(1);
  });
});
