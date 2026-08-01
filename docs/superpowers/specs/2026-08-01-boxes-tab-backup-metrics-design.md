# Boxes tab backup metrics — design

Date: 2026-08-01
Status: approved for planning

## Problem

Settings → Boxes is two buttons and one sentence. It doesn't tell the operator what the
export actually contains, how big it is, or — more importantly — what it does *not* cover.
The export is a snapshot of `boxes.json` only, yet nothing in the UI says so; it is easy to
mistake it for a full Tmuxifier backup. Import also silently drops fields (Proxmox links are
stripped, ids are re-minted) with no mention in the tab.

## Decisions (from brainstorming)

1. The tab communicates **both** what's inside the export (metrics) and what it does not
   cover (exclusions).
2. Metrics are a **stat row + field usage** summary — glanceable figures, not a per-box table.
3. The exclusions note is **static text** — a fixed list of the categories the export never
   covers, no extra fetches for concrete counts.
4. Stats derive from **fetching `GET /api/export`** client-side — the same payload the Export
   button downloads — so the numbers describe the literal backup file and its real byte size.
   No new server endpoint.

## Ground truth about export/import (unchanged by this work)

- `GET /api/export` (`server.js:816`) returns `store.exportBoxes()`:
  `{ type: 'tmuxifier-boxes', version: 1, exportedAt, boxes }`, pretty-printed with 2-space
  indent, served with `Content-Disposition: attachment; filename="tmuxifier-boxes-<YYYY-MM-DD>.json"`.
- `boxes` is the full `readAll()` output: id, label, host, user, port, proxyJump, sessionName,
  startupCommand, tags, source, proxmox link (hostId/node/vmid/kind), createdAt.
- `POST /api/import` re-adds each entry through validation, stripping `id`, `createdAt`,
  `source`, and the `proxmox` link; duplicates (same host or label, case-insensitive) and
  unsafe/invalid entries are skipped, not fatal.
- Nothing else under `data/` participates: Proxmox host profiles and presets, service tiles,
  fleet scripts and job history, NetBox settings, passkeys, and voice config are all outside
  the export's scope. The file contains no secrets (Tmuxifier stores none per box).

## Tab layout (top to bottom)

1. `h3` "Boxes" (unchanged).
2. **"What gets exported"** block:
   - Header line: the real filename (`tmuxifier-boxes-<date>.json`, date from the fetched
     payload's `exportedAt`) and the payload's actual byte size formatted with `fmtBytes`.
   - Stat grid: total boxes; manual · Proxmox-linked split (`source` field); tagged
     (`tags.length > 0`); via proxy jump (`proxyJump` present); with startup command
     (`startupCommand` present); with custom port (`port` present); with custom user
     (`user` present).
   - The existing **Export boxes** button beneath the grid.
3. **Import** block: the existing **Import boxes…** button plus a caveat line stating what
   import actually does: ids are re-minted, duplicates (same host or label) are skipped, and
   **Proxmox links are not restored** — re-link from the box's Edit dialog afterwards.
4. **"Not in this backup"** static note listing: Proxmox host profiles & presets, service
   tiles, fleet scripts & job history, NetBox settings, passkeys, voice configuration —
   these live only in `data/` on the Tmuxifier host.
5. The existing inline status line (import/export results) stays at the bottom.

## Data flow

- On tab render, a new `api.exportPreview()` in `api.ts` fetches `GET /api/export`, reads the
  response as text, and returns `{ payload, bytes }` where `bytes` is the UTF-8 byte length of
  the text (via `TextEncoder`) and `payload` is the parsed JSON.
- Stats are computed by a pure `exportStats(payload)` helper in `settingsBoxes.ts`.
- After a successful import, the stats re-fetch and repaint, so the figures visibly reflect
  the new state. (The existing `tmuxifier:boxes-changed` event dispatch stays as-is for the
  dashboard; the tab triggers its own refresh directly.)
- "Custom port/user" means the optional field is present on the box, regardless of value.

## Error handling

- If the preview fetch fails, the stats block renders a single quiet
  "Couldn't load export preview" line. The Export and Import buttons never depend on the
  stats fetch — backup and restore must keep working when the preview doesn't.
- Import error handling is unchanged (inline status line, `pve-err` styling).

## Pure helpers and tests

- `exportStats(payload)` — counts described above, returned as a plain object. Tolerates a
  malformed payload (missing/non-array `boxes`) by returning zeroed counts rather than
  throwing, since it runs on whatever the server returned.
- `exportSizeBytes(text)` — UTF-8 byte length of the response text.
- Both live in `settingsBoxes.ts` beside `importSummary` and are vitest-tested without DOM
  (repo convention: `environment: 'node'`, no jsdom — DOM layers are untested by design).
- `fmtBytes` is imported from `fmt.ts`, not reimplemented.
- Server untouched: no new endpoints, no change to export/import semantics, so no server
  test changes.

## Visuals

- The stat grid follows DESIGN.md's instrument idiom (same family as the dashboard stat
  readouts), with scoped classes in `style.css` (e.g. `boxes-stats`). Read DESIGN.md before
  styling; it outranks ad-hoc decisions.
- No new dependencies.

## Out of scope

- Concrete "not included" counts (fetching Proxmox/services/fleet stores for numbers) —
  considered and rejected in brainstorming in favour of static text.
- Any broader backup mechanism covering the rest of `data/`.
- Per-box detail table.
