const DEFAULT_MAX = 10;

export function addRecent(list: string[], cmd: string, max = DEFAULT_MAX): string[] {
  const c = cmd.trim();
  if (!c) return list.slice(0, max);
  return [c, ...list.filter((x) => x !== c)].slice(0, max);
}

export function parseRecent(raw: string | null, max = DEFAULT_MAX): string[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}
