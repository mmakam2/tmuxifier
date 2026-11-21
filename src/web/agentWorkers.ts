// Fetch layer for agent workers (design 5.1, 5.4), in the mold of agentMail.ts.
// Every call goes through http.ts so an expired session reaches the central 401
// seam. The routes are browser-session only.
//
// GET answers the box's record and whether agent messaging is on (the
// "Let agent messages start an agent here" tick is shown only then). PUT answers
// the record as stored; a record the server's rules refuse is a 400 `{ error }`.
// POST .../start answers the new session's name; its failures carry `{ error, code }`.
import { jsonFetch, jsonBody } from './http';

export interface WorkerProject { name: string; dir: string; trust: boolean }
export interface WorkerSettings { projects: WorkerProject[]; mailStart: boolean; max: number }

const path = (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/workers`;

export const workersApi = {
  get(boxId: string) { return jsonFetch<{ workers: WorkerSettings; mail: boolean }>(path(boxId)); },
  save(boxId: string, w: WorkerSettings) {
    return jsonFetch<{ workers: WorkerSettings }>(path(boxId), jsonBody('PUT', { projects: w.projects, mailStart: w.mailStart, max: w.max }));
  },
  start(boxId: string, project?: string) {
    return jsonFetch<{ ok: true; session: string }>(`${path(boxId)}/start`, jsonBody('POST', project === undefined ? {} : { project }));
  },
};
