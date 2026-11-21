import { test, expect } from 'vitest';
import * as webView from '../src/web/agentWorkersView.ts';
import * as serverRules from '../src/server/agentWorkerRules.js';

const {
  projectProblem, maxProblem, workersChanged, workersProblem, startLabel,
} = webView;

const NAME_MSG = 'Name: lowercase letters, digits and dashes, up to 24';
const DIR_MSG = 'Directory: an absolute path with no spaces';
const DUP_MSG = 'That name is already used';

const row = (name, dir = '/opt/billing-api', trust = false) => ({ name, dir, trust });
const rec = (over = {}) => ({ projects: [row('api'), row('web', '/srv/web', true)], mailStart: false, max: 3, ...over });

test('the web rules are the server rules', () => {
  expect(webView.PROJECT_NAME_RE.source).toBe(serverRules.PROJECT_NAME_RE.source);
  expect(webView.PROJECT_NAME_RE.flags).toBe(serverRules.PROJECT_NAME_RE.flags);
  expect(webView.WORKER_DIR_RE.source).toBe(serverRules.WORKER_DIR_RE.source);
  expect(webView.WORKER_DIR_RE.flags).toBe(serverRules.WORKER_DIR_RE.flags);
  expect(webView.MAX_PROJECTS).toBe(serverRules.MAX_PROJECTS);
  expect(webView.WORKERS_MAX_LIMIT).toBe(serverRules.WORKERS_MAX_LIMIT);
});

test('a valid row has no problem', () => {
  expect(projectProblem(row('api'), [])).toBe(null);
  expect(projectProblem(row('a'), [row('b')])).toBe(null);
  expect(projectProblem(row('billing-api-2', '/home/ops/src/billing_api.v2', true), [])).toBe(null);
  expect(projectProblem(row('x'.repeat(24)), [])).toBe(null);
});

test('a bad name says what a name may be', () => {
  for (const name of ['', 'API', '-api', 'api_x', 'my api', 'x'.repeat(25), '../x', 'api\n']) {
    expect(projectProblem(row(name), []), JSON.stringify(name)).toBe(NAME_MSG);
  }
});

test('a bad directory says what a directory may be', () => {
  for (const dir of ['', 'opt/api', '/opt/my api', '/opt/../etc', '/opt//api', '/opt/api/', '/', '~/api']) {
    expect(projectProblem(row('api', dir), []), JSON.stringify(dir)).toBe(DIR_MSG);
  }
});

test('the name is checked before the directory', () => {
  expect(projectProblem(row('API', 'nope'), [])).toBe(NAME_MSG);
});

test('a name another row already has is refused', () => {
  expect(projectProblem(row('api', '/srv/other'), [row('web'), row('api')])).toBe(DUP_MSG);
});

// projectProblem must refuse every directory the server's isWorkerDir refuses, and accept every
// one it accepts: a row the dashboard lets through must not come back as a 400.
const DIRS = [
  '/opt/billing-api', '/a', '/home/ops/src/app.v2', '/srv/a-b_c.d', '/opt/..x', '/opt/x..', '/opt/.hidden', '/opt/.',
  '', 'relative', '/', '//', '/opt//x', '/opt/x/', '/opt/../x', '/..', '/opt/..', '/opt/x/../y', '/opt/my api',
  '/opt/x\n', '/opt/$HOME', "/opt/'x'", '/opt/x;rm', `/${'a'.repeat(199)}`, `/${'a'.repeat(200)}`, '/opt/é',
];

test('the directory verdicts agree with the server', () => {
  for (const dir of DIRS) {
    const webOk = projectProblem(row('api', dir), []) === null;
    expect(webOk, JSON.stringify(dir)).toBe(serverRules.isWorkerDir(dir));
  }
  // The list exercises both verdicts.
  expect(DIRS.some((d) => serverRules.isWorkerDir(d))).toBe(true);
  expect(DIRS.some((d) => !serverRules.isWorkerDir(d))).toBe(true);
});

test('maxProblem takes a whole number from 1 to the limit', () => {
  for (const n of [1, 3, 8]) expect(maxProblem(n), String(n)).toBe(null);
  for (const n of [0, 9, -1, 2.5, Number.NaN, Infinity]) expect(maxProblem(n), String(n)).toBe('Worker sessions: a whole number from 1 to 8');
});

test('workersChanged sees every field and the order', () => {
  expect(workersChanged(rec(), rec())).toBe(false);
  const a = rec();
  expect(workersChanged(a, rec({ projects: [...a.projects].reverse() }))).toBe(true);
  expect(workersChanged(a, rec({ projects: [row('api', '/opt/billing-api', true), row('web', '/srv/web', true)] }))).toBe(true);
  expect(workersChanged(a, rec({ projects: [row('api', '/opt/other'), row('web', '/srv/web', true)] }))).toBe(true);
  expect(workersChanged(a, rec({ projects: [row('api2'), row('web', '/srv/web', true)] }))).toBe(true);
  expect(workersChanged(a, rec({ projects: [row('api')] }))).toBe(true);
  expect(workersChanged(a, rec({ mailStart: true }))).toBe(true);
  expect(workersChanged(a, rec({ max: 4 }))).toBe(true);
});

test('workersProblem reports the first problem, rows before max', () => {
  expect(workersProblem(rec())).toBe(null);
  expect(workersProblem(rec({ projects: [row('api'), row('api', '/srv/x')], max: 0 }))).toBe(DUP_MSG);
  expect(workersProblem(rec({ projects: [row('api', 'x')] }))).toBe(DIR_MSG);
  expect(workersProblem(rec({ max: 9 }))).toBe('Worker sessions: a whole number from 1 to 8');
  const nine = Array.from({ length: 9 }, (_, i) => row(`p${i}`));
  expect(workersProblem(rec({ projects: nine }))).toBe('At most 8 projects');
});

test('startLabel names the project', () => {
  expect(startLabel('api')).toBe('Start Claude in api');
});
