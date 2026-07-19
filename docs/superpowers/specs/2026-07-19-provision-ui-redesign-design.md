# Provision form redesign + AI-auth seed guidance — design

Date: 2026-07-19
Status: approved (brainstorming session)

## Problem

The provision form (Proxmox hub → Provision tab, and the setup-options block in the Add/Edit
Box modal) is a flat, unlabeled vertical list: preset, hostname, tag, Oh My Tmux, shell radios,
nine tool checkboxes, and the "Seed AI CLI auth" checkbox all run together with no grouping.

Worse for new users: the seed checkbox is inert until the Tmuxifier host itself has been set
up (`claude setup-token` → `TMUXIFIER_CLAUDE_OAUTH_TOKEN` in `.env`; `codex login` →
`~/.codex/auth.json`). Nothing in the UI says so. A new user checks the box, provisions, and
only a small phase-text suffix afterward reveals `claude skipped (TMUXIFIER_CLAUDE_OAUTH_TOKEN
not configured)`. There is no API that reports host seeding readiness up front.

## Decisions (from brainstorming Q&A)

1. **Scope:** full provision-form redesign; seed guidance is one section among many.
2. **Seed guidance depth:** detect + instruct. A new endpoint reports per-CLI host readiness;
   the UI shows status rows and the exact host commands to run. Host setup itself stays in the
   terminal (no GUI token entry in this round).
3. **Surfaces:** both the hub Provision tab and the Add/Edit Box modal, via one shared
   component.
4. **Layout:** grouped titled sections in a single scroll (no wizard, no two-column split).

## Design

### 1. Shared setup-options component — `src/web/setupOptions.ts`

A DOM-building module in the same style as `toolsCheckboxGroup` (`provisionTools.ts`): logic
kept out so node-env tests never need a document. It renders three titled sections:

- **Terminal** — "Install Oh My Tmux" checkbox + shell-framework radios (None / Oh My Zsh /
  Oh My Bash). The radio `name` is generated per instance so a hub tab and a box modal open at
  the same time can't cross-select.
- **Tools** — the `PROVISION_TOOLS` checkboxes in a two-column grid
  (`grid-template-columns: 1fr 1fr` on the existing fieldset styling).
- **AI auth seeding** — the seed checkbox plus one readiness row per CLI (see §3).

API:

```ts
createSetupOptionsForm(opts?: { initial?: Partial<SetupOptions> }): {
  element: HTMLElement;
  values(): SetupOptions;              // { ohMyTmux, ohMyZsh, ohMyBash, tools, seedAiAuth }
  applySeedStatus(s: AiAuthStatus | null): void; // null = status fetch failed
}
```

Both `proxmoxUi.ts` (`renderProvision`) and `main.ts` (`openBoxDialog`) replace their
hand-rolled blocks with this component. Sections render as fieldset "cards" (new `style.css`
rules); existing `check-field` / `radio-group` classes are reused inside.

### 2. Container section + preset summary (hub tab only)

The hub Provision tab groups preset/hostname/IP/tag under a **Container** section. Under the
preset select, a live summary line describes the selected preset:

```
debian-12 · 2c / 2 GiB · disk 8 GiB · vlan 3 · IP auto (NetBox)
```

Built by a pure `presetSummary(preset: PvePreset): string` (template basename, cores,
memoryMiB→GiB, diskGiB, vlan when set, and an ipMode phrase: `IP auto (NetBox)` /
`static IP` / `DHCP`). It replaces the current detached "IP: auto-allocated from NetBox"
note; the static-IP override field keeps its existing show/hide behavior. The summary updates
on select change (folds into the existing `syncStatic` listener).

### 3. AI-auth readiness endpoint + seed section behavior

**Server.** `createAiAuthSeeder` gains a `status()` method next to `seed()`:

```js
{ claude: { ready: boolean, reason?: string }, codex: { ready: boolean, reason?: string } }
```

- claude ready = a token is configured and passes the existing character check; otherwise
  `reason` mirrors the current skip strings ("TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured",
  "unsupported token characters").
- codex ready = `readLocal()` yields non-empty bytes; otherwise `reason` = "no codex auth on
  the Tmuxifier host".

No secret material (token, auth.json contents) ever appears in the result.

**Route.** `GET /api/ai-auth/status`, auth-gated like every `/api/*` route; 503 when the
seeder is absent (mirrors the existing seed route guard).

**Client.** The seed section fetches status when the form renders and passes it to
`applySeedStatus`:

- ready → `claude ● ready`
- not ready → `claude ○ not set up — run `claude setup-token` on the Tmuxifier host, put the
  token in .env as TMUXIFIER_CLAUDE_OAUTH_TOKEN, restart Tmuxifier`; for codex →
  `codex ○ not set up — run `codex login` on the Tmuxifier host`
- both not ready → the seed checkbox is disabled, with a title explaining that the host has
  no credentials to seed yet
- fetch/endpoint error → rows read "status unknown" and the checkbox stays enabled (the
  post-provision per-target result reporting is unchanged and still catches the truth)

The existing tooltip ("seed only boxes you trust…") stays on the checkbox label.

### 4. Error handling and testing (TDD)

- Extend `test/aiAuthSeed.test.js`: `status()` truth table — token present/absent/bad chars ×
  codex bytes present/absent/read-throws; assert no secret bytes in the result.
- New route test (pattern of existing setup/seed route tests): 401 unauthenticated, 503
  without a seeder, happy-path shape.
- Pure-helper tests: `presetSummary` (full preset, null vlan, each ipMode) and the seed
  status-row text formatter.
- DOM assembly stays untested, matching the existing convention (`toolsCheckboxGroup`,
  `sparkline.ts`).
- Gate: `npm test` (typecheck + vitest). E2E untouched.

## Out of scope

- GUI-side host token entry (writing `TMUXIFIER_CLAUDE_OAUTH_TOKEN` from the browser).
- Decoupling the browser-triggered seed call after provision (known debt, tracked in memory).
- Wizard/stepper flow; two-column layout.
