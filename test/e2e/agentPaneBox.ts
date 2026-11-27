import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Pane-level agent fixtures on the isolated e2e box (test/helpers/localBox.js),
// shared by agentStates.spec.ts and phone.spec.ts. `tmux` here always runs ON
// the fixture box over its private sshd, whose SetEnv TMUX_TMPDIR keeps it off
// the operator's tmux server.
//
// A pane reads as Claude Code without installing it: tmux's
// pane_current_command is argv[0]'s basename, so `exec -a claude sleep 600`
// reads as `claude`. Markers are the per-pane form every box-side writer
// writes: file `<session><%pane>` holding `<session>:<state>:<epoch>:<cause>:<%pane>`.

const cfg = () => process.env.E2E_SSH_CONFIG!;
const host = () => process.env.E2E_BOX_HOST!;
export const markerDir = () => path.join(process.env.E2E_BOX_HOME!, '.tmuxifier-agent');

export function onBox(cmd: string): string {
  return execFileSync('ssh', ['-F', cfg(), host(), cmd], { encoding: 'utf8' });
}

export const now = () => Math.floor(Date.now() / 1000);

// Replace `session` without ever killing the server's last session: tmux exits
// with its last session, and a new-session racing that exit fails with "server
// exited unexpectedly". A placeholder session holds the server up meanwhile.
function recreate(session: string, newSession: string) {
  const hold = `${session}-hold`;
  onBox(`tmux has-session -t '=${hold}' 2>/dev/null || tmux new-session -d -s '${hold}'; tmux kill-session -t '=${session}' 2>/dev/null; ${newSession}; tmux kill-session -t '=${hold}'`);
}

export function writePaneMarker(session: string, pane: string, state: string, epoch: number, cause: string) {
  fs.mkdirSync(markerDir(), { recursive: true, mode: 0o700 });
  const file = path.join(markerDir(), `${session}${pane}`);
  // Temp file + rename, as the writers do: a probe never reads half a marker.
  fs.writeFileSync(`${file}.tmp`, `${session}:${state}:${epoch}:${cause}:${pane}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export interface AgentPane { pane: string; windowId: string; windowIndex: number; paneIndex: number; name: string }
export interface AgentPaneLayout { session: string; one: AgentPane; twoA: AgentPane; twoB: AgentPane }

// `session` rebuilt from nothing: window `api` (one fake claude, in front) and
// window `front` (two fake claudes side by side, in the background). Each pane
// first prints a line naming itself, so a test can tell which window a terminal
// shows. Returns the ids tmux handed out and the row name each pane must get.
export function buildAgentPanes(session: string): AgentPaneLayout {
  const fake = (tag: string) => `bash -c 'echo ${tag}; exec -a claude sleep 600'`;
  recreate(session, `tmux new-session -d -s '${session}' -n api ${fake('AGENT_WINDOW_ONE')}`);
  const w2 = onBox(`tmux new-window -d -P -F '#{window_id}' -t '=${session}:' -n front ${fake('AGENT_WINDOW_TWO_A')}`).trim();
  onBox(`tmux split-window -d -h -t '=${session}:${w2}' ${fake('AGENT_WINDOW_TWO_B')}`);
  // A pane reads `bash` until its echo is done and the exec lands: look again
  // for a few seconds before calling the fixture broken.
  const list = () => onBox(`tmux list-panes -s -t '=${session}' -F '#{window_id} #{window_index} #{pane_index} #{pane_id} #{pane_current_command}'`)
    .trim().split('\n').map((l) => l.split(' '))
    .map(([windowId, wi, pi, pane, cmd]) => ({ windowId, windowIndex: Number(wi), paneIndex: Number(pi), pane, cmd }));
  let panes = list();
  for (let i = 0; i < 20 && (panes.length !== 3 || panes.some((p) => p.cmd !== 'claude')); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    panes = list();
  }
  if (panes.length !== 3 || panes.some((p) => p.cmd !== 'claude')) throw new Error(`fixture panes not ready: ${JSON.stringify(panes)}`);
  const one = panes.find((p) => p.windowId !== w2)!;
  const [a, b] = panes.filter((p) => p.windowId === w2).sort((x, y) => x.paneIndex - y.paneIndex);
  const strip = ({ cmd: _cmd, ...p }: typeof panes[number]) => p;
  return {
    session,
    one: { ...strip(one), name: `${one.windowIndex}:api` },
    twoA: { ...strip(a), name: `${a.windowIndex}:front.${a.paneIndex}` },
    twoB: { ...strip(b), name: `${b.windowIndex}:front.${b.paneIndex}` },
  };
}

// Back to one plain login shell, as a fresh session starts, and no markers.
export function resetAgentPanes(layout: AgentPaneLayout | null, session: string) {
  if (layout) {
    for (const p of [layout.one, layout.twoA, layout.twoB]) {
      try { fs.rmSync(path.join(markerDir(), `${session}${p.pane}`), { force: true }); } catch { /* gone */ }
    }
  }
  try { recreate(session, `tmux new-session -d -s '${session}'`); } catch { /* best effort */ }
}
