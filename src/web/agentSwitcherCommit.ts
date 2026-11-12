// Pure commit planner for the agent switcher: what releasing the chord on a
// row does to the stage, as data. A later DOM task executes the plan.
//
// `resetTab` tells the executor that the chosen instance is a parked terminal
// attached to ANOTHER session, which ensureTab would otherwise reuse as is.
// The ordinal is chosen against the DOCKED panes only; a parked instance at
// that ordinal is reused.
import { boxOfInstance, instanceId, nextOrdinal, ordinalOfInstance } from './stageLayout';
import { LOCAL_BOX } from './agentSwitcherList';

export interface CommitInput {
  target: { boxId: string; session: string };
  panes: string[];
  focused: string | null;
  parked: string[];
  sessionOf(iid: string): string;
}
export type CommitPlan =
  | { kind: 'focus'; paneId: string }
  | { kind: 'switch'; paneId: string }
  | { kind: 'replace'; occupant: string; iid: string; resetTab: boolean }
  | { kind: 'open'; iid: string; resetTab: boolean };

export function planCommit(i: CommitInput): CommitPlan {
  const { boxId, session } = i.target;

  const shown = i.panes.find(
    (p) => boxOfInstance(p) === boxId && (boxId === LOCAL_BOX || i.sessionOf(p) === session),
  );
  if (shown !== undefined) return { kind: 'focus', paneId: shown };

  let iid: string;
  let resetTab: boolean;
  if (boxId === LOCAL_BOX) {
    iid = instanceId(LOCAL_BOX, 1);
    resetTab = false;
  } else {
    const onSession = i.parked
      .filter((p) => boxOfInstance(p) === boxId && i.sessionOf(p) === session)
      .sort((a, b) => ordinalOfInstance(a) - ordinalOfInstance(b))[0];
    if (onSession !== undefined) {
      iid = onSession;
      resetTab = false;
    } else {
      iid = instanceId(boxId, nextOrdinal(boxId, i.panes));
      resetTab = i.parked.includes(iid);
    }
  }

  if (i.panes.length === 0) return { kind: 'open', iid, resetTab };

  const occupant = i.focused !== null && i.panes.includes(i.focused) ? i.focused : i.panes[0];
  if (boxOfInstance(occupant) === boxId) return { kind: 'switch', paneId: occupant };
  return { kind: 'replace', occupant, iid, resetTab };
}
