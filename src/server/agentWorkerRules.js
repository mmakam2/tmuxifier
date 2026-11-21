// Agent workers: the per-box settings rules and the worker session rules. Pure, no I/O
// (design sections 5.1 and 5.2).
//
//   <box id>: {
//     projects: [ { name, dir, trust } ],   // 0..8, order kept; the first is the default
//     mailStart: false,                     // may a message start a worker here
//     max: 3                                // worker sessions allowed on this box, 1..8
//   }
//
// A project is the operator's own entry: `name` is only ever a lookup key (a lead names a
// project, the server finds its directory), and `dir` is the operator's directory on the box.
// That directory reaches a shell, so it is checked twice with the same rule: `normalizeWorkers`
// refuses a bad one when the record is written, and the starter calls `isWorkerDir` again on
// the value it is about to single-quote into the remote script, because a record read back
// from `data/agent-workers.json` is a file, not proof (an edit by hand, or an older writer,
// would otherwise reach the box). `isWorkerDir` is the one definition of "a safe directory"
// for both checks, so they cannot drift apart.
//
// Explicit values are validated, never rewritten: a bad name, directory or `max` throws, it is
// not trimmed, lower-cased or clamped. `trust` and `mailStart` are on only for a literal `true`.
// Names are collected in a Set, never as keys of an object, so no user-controlled string is a
// property name here.
//
// A worker is a tmux session named `worker-<project>-<n>`. What is running is counted from the
// box's own session listing (the caller passes it in), so the count survives a restart of
// Tmuxifier and needs no stored state.

import { agentKindOf } from './healthHistory.js';

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const WORKER_DIR_RE = /^\/[A-Za-z0-9._/-]{1,199}$/;

export const MAX_PROJECTS = 8;
export const WORKERS_MAX_LIMIT = 8;
export const WORKERS_MAX_DEFAULT = 3;
export const WORKER_PREFIX = 'worker-';

// Closed lists: a mode or an agent is a lookup key, nothing a caller types reaches a shell.
export const WORKER_MODES = Object.freeze(['interactive']);
export const WORKER_AGENTS = Object.freeze({
  claude: Object.freeze({ launch: 'claude', kind: 'claude' }),
});

export const EMPTY_WORKERS = Object.freeze({
  projects: Object.freeze([]),
  mailStart: false,
  max: WORKERS_MAX_DEFAULT,
});

// Absolute, in the allowlist, no `..` segment, no `//`, no trailing `/`. The regex has no `m`
// flag, so `$` does not match before a trailing newline.
export function isWorkerDir(dir) {
  return typeof dir === 'string'
    && WORKER_DIR_RE.test(dir)
    && !dir.includes('//')
    && !dir.endsWith('/')
    && !dir.split('/').includes('..');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeProject(raw, seen) {
  if (!isPlainObject(raw)) throw new Error('project must be an object');
  if (typeof raw.name !== 'string' || !PROJECT_NAME_RE.test(raw.name)) throw new Error('bad project name');
  // The name passed the allowlist above, so it is safe to put in a message.
  if (!isWorkerDir(raw.dir)) throw new Error(`bad directory for project ${raw.name}`);
  if (seen.has(raw.name)) throw new Error(`duplicate project name: ${raw.name}`);
  seen.add(raw.name);
  return { name: raw.name, dir: raw.dir, trust: raw.trust === true };
}

export function normalizeWorkers(raw) {
  if (!isPlainObject(raw)) throw new Error('workers must be an object');
  let projects = [];
  if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects)) throw new Error('projects must be an array');
    if (raw.projects.length > MAX_PROJECTS) throw new Error('too many projects');
    const seen = new Set();
    projects = raw.projects.map((p) => normalizeProject(p, seen));
  }
  let max = WORKERS_MAX_DEFAULT;
  if (raw.max !== undefined) {
    if (!Number.isInteger(raw.max) || raw.max < 1 || raw.max > WORKERS_MAX_LIMIT) {
      throw new Error(`max must be 1 to ${WORKERS_MAX_LIMIT}`);
    }
    max = raw.max;
  }
  return { projects, mailStart: raw.mailStart === true, max };
}

// `worker-<project>-<n>`, n the lowest number from 1 that is not in `sessionNames`. A leftover
// session keeps its number, so a new worker never takes over its name. The project is checked
// again here so the result always passes SESSION_NAME_RE (7 + 24 + 1 + digits <= 64).
export function workerSessionName(project, sessionNames) {
  if (typeof project !== 'string' || !PROJECT_NAME_RE.test(project)) throw new Error('bad project name');
  const taken = new Set(sessionNames);
  let n = 1;
  while (taken.has(`${WORKER_PREFIX}${project}-${n}`)) n += 1;
  return `${WORKER_PREFIX}${project}-${n}`;
}

// Worker sessions whose active pane runs the agent. The pane command is part of the test
// because a worker's name can outlive its Claude (design 5.8): a leftover shell is not counted.
export function runningWorkers(sessions) {
  let n = 0;
  for (const s of sessions) {
    if (s && typeof s.name === 'string' && s.name.startsWith(WORKER_PREFIX)
      && agentKindOf(s.paneCmd) === WORKER_AGENTS.claude.kind) n += 1;
  }
  return n;
}
