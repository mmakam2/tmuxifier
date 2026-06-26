export function toggleBox(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function setBoxes(selected: Set<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export type GroupState = 'none' | 'some' | 'all';

export function groupState(selected: Set<string>, ids: string[]): GroupState {
  if (ids.length === 0) return 'none';
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  if (n === 0) return 'none';
  return n === ids.length ? 'all' : 'some';
}
