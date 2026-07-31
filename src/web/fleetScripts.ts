// Fetch layer + pure helpers for Fleet Command's saved scripts, in the mold of
// netbox.ts/voice.ts. Everything goes through http.ts so an expired session
// reaches the central 401 seam instead of failing silently.
import { jsonFetch, jsonBody } from './http';

export interface FleetScript {
  id: string;
  name: string;
  description?: string;
  script: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetScriptInput {
  name: string;
  description?: string;
  script: string;
}

// Mirrors the server's caps (fleetScriptsStore.js). Duplicated rather than
// imported because the server is the validation authority and this side only
// needs to spare the operator a round trip.
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 200;

export const fleetScripts = {
  list() { return jsonFetch<FleetScript[]>(`/api/fleet/scripts?t=${Date.now()}`); },
  create(spec: FleetScriptInput) { return jsonFetch<FleetScript>('/api/fleet/scripts', jsonBody('POST', spec)); },
  update(id: string, patch: Partial<FleetScriptInput>) { return jsonFetch<FleetScript>(`/api/fleet/scripts/${id}`, jsonBody('PATCH', patch)); },
  remove(id: string) { return jsonFetch<{ ok: boolean }>(`/api/fleet/scripts/${id}`, { method: 'DELETE' }); },
};

/** Newest-updated first, id as tie-break. Pure: returns a new array. */
export function sortScripts(list: FleetScript[]): FleetScript[] {
  return [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.id).localeCompare(String(b.id)));
}

/**
 * Whether the editor holds unsaved work. For the unnamed draft that is simply
 * "the buffer has text"; for a selected script it is a comparison against every
 * field the Save button would write, so renaming alone still counts as dirty.
 */
export function isDirty(selected: FleetScript | null, script: string, name: string, description: string): boolean {
  if (!selected) return script.trim().length > 0;
  return script !== selected.script
    || name.trim() !== selected.name
    || description.trim() !== (selected.description || '');
}

/** An error message for an unusable name, or null when it is fine. */
export function validateName(name: string, existing: FleetScript[], exceptId: string | null = null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A name is required to save this script';
  if (trimmed.length > MAX_NAME) return `The name must be at most ${MAX_NAME} characters`;
  const key = trimmed.toLowerCase();
  if (existing.some((s) => s.id !== exceptId && s.name.toLowerCase() === key)) {
    return `A script named "${trimmed}" already exists`;
  }
  return null;
}
