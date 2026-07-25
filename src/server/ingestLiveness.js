import { readJson } from './jsonFile.js';

// A dead receiver and a quiet network look identical from the dashboard, and
// that ambiguity is the single most dangerous failure in this system. The
// daemon stamps a file; absence or staleness of that stamp is what the UI turns
// into a banner. Missing reads as dead, never as fine — and so does corrupt or
// non-numeric, since "I cannot tell" carries exactly as little information as
// "nothing is there".
export function createIngestLiveness({ heartbeatFile, now = () => Date.now(), staleMs = 300000 }) {
  return {
    async status() {
      const data = await readJson(heartbeatFile, { fallback: null }).catch(() => null);
      const at = data && typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : null;
      if (at === null) return { alive: false, lastSeenAt: null, staleFor: null };
      const age = now() - at;
      return age > staleMs
        ? { alive: false, lastSeenAt: at, staleFor: age }
        : { alive: true, lastSeenAt: at, staleFor: null };
    },
  };
}
