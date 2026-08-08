# Themes Engine — Design

Date: 2026-08-08
Status: approved design, pre-implementation

## Goal

Let the operator switch the app between visual themes, starting with two: the current
v1.18.0 **Instrument** look (default) and **Original**, a reinterpretation of the
pre-v1.18.0 navy/cyan neon-terminal scheme. New themes are added in the codebase
(drop a file); the app only switches between them.

## Decisions (from brainstorming)

1. **Original = reinterpretation, not restoration.** The old stylesheet was a different
   design world (sans chrome, glow, 8 tokens) and has no rules for anything shipped since
   v1.19.0. The Original theme re-expresses its palette and mood as a skin over today's
   layout and components, so every current and future feature is themed automatically.
2. **Themes are authored in the codebase.** The in-app UI only switches. A theme is a
   checked-in CSS file plus one manifest line; no in-app editor, no runtime theme loading.
3. **Selection persists server-side** (single-user app, one setting across devices), and
   the clawd working-animation preference moves server-side with it, into one UI-settings
   store.

## Architecture

### Token contract (the enabling refactor)

`src/web/style.css`'s `:root` block becomes the complete themable surface. The ~254 color
literals outside it today collapse three ways:

- **Alpha washes become `color-mix()`.** Most literals are opacity variants of the accent
  (`rgba(255, 176, 0, 0.28)` → `color-mix(in srgb, var(--accent) 28%, transparent)`).
  Themes override one base token; every wash, focus ring, selection tint, and glow follows.
  Scrollbar colors likewise derive from the neutrals.
- **Accent/commit families get semantic names.** `--amber` → `--accent`, `--amber-deep` →
  `--accent-deep`, `--orange` → `--commit`, plus tokens for the commit key's gradient ramp
  stops. "Amber" is an Instrument fact, not an engine fact. Chassis neutrals (`--bg`,
  `--panel`, `--panel-2`, `--gunmetal`, `--border`, `--screen`, `--text`, `--muted`,
  `--dim`) and status LEDs (`--ok`/`--warn`/`--crit`/`--auth`) keep their names. LEDs are
  semantic and inherit across themes unless a theme deliberately overrides them.
- **Pure black/white material washes stay literal.** `rgba(0,0,0,x)` / `rgba(255,255,255,x)`
  highlights and shades are physics (light on a surface), not palette. Tokenizing them adds
  noise with no theming power while all shipped themes are dark. The convention test
  (below) allowlists exactly these two families.

Additional tokens:

- `--bench` — the body's full background list (noise SVG + worklight + `var(--bg)`), so a
  theme can swap the whole background treatment (Original: cyan radial glow + vertical
  gradient).
- `--face` — already exists; becomes per-theme so Original can return to system sans
  chrome. The **terminal** font is untouched — it stays `termFont.ts`'s bundled Meslo
  stack and the `TMUXIFIER_TERM_FONT` config path.
- Existing material-recipe tokens (`--key-face`, `--key-edge`, `--key-edge-down`,
  `--recess`, `--lift`, `--key-border`) remain tokens and are therefore already themable.

The Instrument theme is the `:root` defaults. After the refactor it must be visually
identical to today — verified on the live app before merge.

### Theme definition

- One CSS file per non-default theme: `src/web/themes/<id>.css`, containing
  `:root[data-theme="<id>"] { …token overrides… }` plus, only where tokens cannot express
  it, component rules scoped under `[data-theme="<id>"]` (e.g. glow shadows in place of
  keycap extrusion). Everything in a theme file must be `[data-theme]`-scoped so a theme
  can never leak into the default (pinned by the convention test).
- `src/web/themes.ts` — the manifest: `THEMES: { id, label, description }[]` (Instrument
  first) and `normalizeThemeId` (unknown/null → `'instrument'`, the clawd normalization
  pattern). Theme CSS files are imported at build time so Vite bundles them; adding a
  theme = one CSS file + one manifest line.
- Theme ids are slugs (`^[a-z0-9-]{1,32}$`).

**Original starting palette** (from the pre-v1.18.0 stylesheet at `247b906~1`; values are
a starting point, tuned during implementation with visual validation):

| Token | Value | Note |
| --- | --- | --- |
| `--bg` | `#070a0f` | deep navy field |
| `--panel` | `#0d121b` | |
| `--panel-2` | `#111824` | |
| `--border` | `#202938` | |
| `--screen` | near-black navy | tuned; old design had no screen-well concept |
| `--text` | `#d8e1ea` | |
| `--muted` | `#7f8b9a` | |
| `--accent` | `#24d3e8` | cyan, replacing amber |
| `--commit` | tuned | candidates: old green `#58e58c` or a cyan-family fill |
| `--face` | `ui-sans-serif, system-ui, sans-serif` | chrome only |
| `--bench` | old radial cyan glow + linear gradient | |

### Server: UI-settings store

- `src/server/uiSettingsStore.js` — factory over `jsonFile.js`, persisting
  `data/ui-settings.json` with shape `{ theme?: string, clawdAnim?: string }`. Mutations
  serialized (the store-module pattern); written `0o600` like every `data/` file. Nothing
  secret — created at runtime, no placeholder counterpart needed beyond a CLAUDE.md entry.
- **Catalog-agnostic validation:** the server validates slug charset/length only. It never
  knows which themes or clawd variants exist; the client normalizes unknown ids to
  defaults on read. Renaming a theme in code cannot brick the server or the client.
- Routes (both auth-gated, in `server.js`):
  - `GET /api/ui-settings` → `{ theme: string|null, clawdAnim: string|null }` — raw stored
    values, `null` when unset, so the client can distinguish "never set" (migration) from
    an explicit choice.
  - `PATCH /api/ui-settings` — merges only the provided keys; each value must be a valid
    slug or `null` (clears). 400 on anything else.
- Deliberately **not** folded into `GET /api/ui-config`: that route is read-only boot
  config derived from `.env`; this is mutable state.

### Client data flow

- `src/web/theme.ts` — pure half: re-exports manifest, `normalizeThemeId`. DOM half:
  `applyTheme(id)` sets `document.documentElement.dataset.theme` (removes it for
  `instrument`), refreshes the `tmuxifier.theme` localStorage mirror, and notifies
  subscribers; `onThemeChange(cb)` returns an unsubscribe; `resolveThemeColor(varName)`
  resolves a token through a probe element (`probe.style.color = 'var(--x)'` →
  `getComputedStyle(probe).color`) because reading a raw custom property returns
  unresolved `color-mix()` text.
- **Boot:** `main.ts` reads the mirror synchronously and applies it before first paint —
  the login screen renders themed on every revisit. A first-ever visit in a new browser
  shows Instrument until login; accepted (the settings API is auth-gated by design).
- **After auth:** `GET /api/ui-settings` → normalize → apply + refresh mirror. The clawd
  variant lands in a module-level cache in `clawd.ts` (`setClawdVariant`), so its many
  render sites keep synchronous reads; the existing localStorage value seeds the cache
  pre-fetch. **One-time migration:** if the server returns `clawdAnim: null` and the old
  `tmuxifier.clawdAnim` key exists locally, PATCH it up.
- **Picker:** Settings → Appearance gains a Theme section above the animation rows —
  radio rows from the manifest (label + description), instant apply + PATCH, no Save
  button (the tab's existing contract). A failed PATCH keeps the local apply and shows a
  "couldn't save" note. The clawd rows switch their load/save to the same API.
- **Terminal glass:** `terminal.ts` builds `SCREEN_THEME` per `openTerminal` from resolved
  tokens (`--screen`, `--text`, `--accent` cursor, accent-wash selection) and subscribes to
  theme changes, live-updating open terminals via `term.options.theme`; unsubscribes on
  close. ANSI content colors stay at xterm defaults — terminal content belongs to the
  programs running in it, in every theme.
- **Script editor:** `fleetEditor.ts`'s CodeMirror highlight colors become `var(--…)`
  references (HighlightStyle emits real CSS classes, so `var()` works) — the editor
  re-themes through CSS with zero JS.

### Error handling

- Corrupt `data/ui-settings.json` → `jsonFile.js` quarantines it and the store reads as
  defaults. Fail-open; this is cosmetic data.
- Settings fetch failure → mirror/defaults, non-fatal, no retry loop (next boot refetches).
- Unknown stored ids → normalized to defaults at read time, never an error surface.
- Token probe resolution failing (empty string) → `terminal.ts` falls back to today's
  Instrument literals, kept as constants.

## Testing

- **Unit (vitest, node env — no DOM, by repo convention):**
  - `uiSettingsStore`: defaults, patch-merge semantics (explicitly test that an omitted
    key keeps the stored value AND that `null` clears — the PATCH-merge trap), slug
    validation, corrupt-file quarantine.
  - Route tests (pattern: `serviceRoutes.test.js`): auth-gated, 400 on bad slugs, GET
    shape with nulls.
  - `theme.ts` pure half + manifest integrity: unique ids, `instrument` present and first,
    every id a valid slug.
  - **Convention test** over `style.css`: no raw color literals outside the `:root` token
    block except `rgba(0,0,0,x)`/`rgba(255,255,255,x)` washes; and every rule in
    `src/web/themes/*.css` is `[data-theme]`-scoped.
  - Migration logic (pure part): server-null + local-value → PATCH payload.
- **e2e (playwright):** switch to Original in Settings → `data-theme` lands on the root
  element and a computed color (body background) actually changes; reload → still Original
  (server-persisted); the login screen pre-auth already carries the mirror's theme.
- **Live validation (standing workflow):** candidate build on the live app; operator
  confirms Instrument is visually unchanged and Original reads right on desktop + phone,
  before merge/release.

## Documentation

- `DESIGN.md`: remains the visual authority **for the Instrument theme**; gains a short
  themes-engine section stating the token contract and that theme files own their world.
- `CLAUDE.md`/`AGENTS.md`: `uiSettingsStore.js`, `theme.ts`/`themes.ts`/`themes/`,
  `data/ui-settings.json` in the data list, clawd pref now server-side.
- User docs: Themes blurb in `docs/fleet-and-health.md` (the guide that documents the
  Appearance tab) + README feature line.

## Out of scope

- Light themes (material shadows assume dark; revisit if ever wanted).
- Theming terminal ANSI content colors.
- In-app theme editor / user-authored themes.
- Per-browser theme overrides (server setting is authoritative; the mirror is a paint
  hint, not a preference).
- Generated image assets (logos, previews) — picker rows are text; any future swatches
  should be CSS built from the real tokens so they cannot drift.
