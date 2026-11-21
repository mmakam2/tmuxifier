// Agent workers, the pure half (design 5.1, 5.4): the rules the Edit Box section
// checks before it saves, and every word it shows. agentWorkersSection.ts is the
// DOM half.
//
// The rules are the server's (src/server/agentWorkerRules.js), copied because the
// web bundle does not import server code; test/agentWorkersView.test.js pins the
// regexes and limits equal and runs one list of directories through both
// `projectProblem` and the server's `isWorkerDir`. The server stays the
// authority: a row passing here is still checked on PUT and again before the
// directory reaches a shell.
//
// Explicit values are validated, never rewritten: nothing here trims or
// lower-cases what the operator typed.
import type { WorkerProject, WorkerSettings } from './agentWorkers';

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const WORKER_DIR_RE = /^\/[A-Za-z0-9._/-]{1,199}$/;
export const MAX_PROJECTS = 8;
export const WORKERS_MAX_LIMIT = 8;

const NAME_MSG = 'Name: lowercase letters, digits and dashes, up to 24';
const DIR_MSG = 'Directory: an absolute path with no spaces';
const DUP_MSG = 'That name is already used';
const MAX_MSG = `Worker sessions: a whole number from 1 to ${WORKERS_MAX_LIMIT}`;
const COUNT_MSG = `At most ${MAX_PROJECTS} projects`;

// The server's isWorkerDir: absolute, in the allowlist, no `..` segment, no `//`,
// no trailing `/`.
function isWorkerDir(dir: string): boolean {
  return WORKER_DIR_RE.test(dir) && !dir.includes('//') && !dir.endsWith('/') && !dir.split('/').includes('..');
}

/** What is wrong with one row, or null. `others` are the rows its name must not repeat
 *  (the section passes the rows above it, so only the later of two equal names is flagged). */
export function projectProblem(p: WorkerProject, others: readonly WorkerProject[]): string | null {
  if (!PROJECT_NAME_RE.test(p.name)) return NAME_MSG;
  if (!isWorkerDir(p.dir)) return DIR_MSG;
  if (others.some((o) => o.name === p.name)) return DUP_MSG;
  return null;
}

export function maxProblem(n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= WORKERS_MAX_LIMIT ? null : MAX_MSG;
}

/** The first problem in the record, rows in order and then `max`, or null. */
export function workersProblem(w: WorkerSettings): string | null {
  if (w.projects.length > MAX_PROJECTS) return COUNT_MSG;
  for (let i = 0; i < w.projects.length; i += 1) {
    const problem = projectProblem(w.projects[i], w.projects.slice(0, i));
    if (problem) return problem;
  }
  return maxProblem(w.max);
}

/** Order counts: the first project is the default. */
export function workersChanged(a: WorkerSettings, b: WorkerSettings): boolean {
  if (a.mailStart !== b.mailStart || a.max !== b.max || a.projects.length !== b.projects.length) return true;
  return a.projects.some((p, i) => {
    const q = b.projects[i];
    return p.name !== q.name || p.dir !== q.dir || p.trust !== q.trust;
  });
}

export function startLabel(project: string): string {
  return `Start Claude in ${project}`;
}
