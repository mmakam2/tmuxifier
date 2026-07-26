---
name: tmuxifier
description: A single-operator fleet dashboard — persistent SSH/tmux terminals under quiet phosphor instrumentation
colors:
  phosphor-cyan: "#24d3e8"
  phosphor-green: "#58e58c"
  backlit-cyan: "#c2eaf1"
  dead-screen-black: "#070a0f"
  rail-black: "#090d13"
  glass-panel: "#0d121b"
  glass-panel-raised: "#111824"
  terminal-well: "#0b0e14"
  hairline: "#202938"
  instrument-white: "#d8e1ea"
  dimmed-readout: "#7f8b9a"
  alert-red: "#f85149"
  warn-amber: "#d29922"
  ok-green: "#2ea043"
  needs-auth-purple: "#a371f7"
typography:
  display:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "42px"
    fontWeight: 400
    lineHeight: 1
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "1px"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "1px"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.09em"
  mono:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    padding: "10px"
  button-hud:
    backgroundColor: "{colors.glass-panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    padding: "10px"
    typography: "{typography.label}"
  button-secondary:
    backgroundColor: "{colors.glass-panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    padding: "7px 12px"
  input-field:
    backgroundColor: "{colors.glass-panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  chip-session:
    backgroundColor: "{colors.glass-panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  badge-status:
    rounded: "{rounded.pill}"
    padding: "0 6px"
  modal-card:
    backgroundColor: "{colors.glass-panel}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.lg}"
    padding: "18px"
  tab:
    textColor: "{colors.dimmed-readout}"
    padding: "7px 12px"
---

# Design System: tmuxifier

## Overview

**Creative North Star: "The Fleet Bridge"**

Tmuxifier looks like the bridge of a ship on night watch: a near-black blue field, a
handful of phosphor-lit instruments, and one operator with calm authority over many
vessels. Everything on screen is an instrument — box rows are berth listings, the fleet
buttons are a command console, the terminal is the main viewport — and instruments are
quiet at rest, lit when touched, unmistakable when active. The personality is **calm,
precise, quietly lit**: glow is rationed, severity colors carry meaning, and density
serves scanning a fleet at a glance.

Two confirmed anti-references bound the world on both sides. This is not **neon cyberpunk
overload** — the cyan never floods a surface, animations breathe rather than strobe, and
restraint is the brand. And it is not a **generic SaaS dashboard** — no card grids under
heavy drop shadows, no foreign accent colors, no chrome that outdresses the terminal the
product exists to show.

**Key Characteristics:**
- One accent hue (Phosphor Cyan) doing all identity, focus, and selection work
- Near-black blue depths layered tonally: hull, rail, panel, raised panel, terminal well
- Tracked-out uppercase micro-labels as the HUD voice; terminal monospace as the display voice
- Severity colors (red/amber/green/purple) reserved strictly for status semantics
- Flat surfaces with 1px hairlines; glow signals state, shadow signals altitude
- Dense, scannable rows built for dozens of boxes, not marketing whitespace

## Colors

A single phosphor accent over layered blue-black glass, with a strict status vocabulary on top.

### Primary
- **Phosphor Cyan** (#24d3e8): the product's one voice — brand nameplate glow, active/selected
  states, focus rings, sparkline strokes, interactive hovers, the empty-stage cursor. Applied
  at full strength only in small doses (text, 3px bars, 9px dots); larger fields always use
  alpha washes of it: `rgba(36, 211, 232, α)` at 0.05 (resting tint) → 0.12 (hover/selection)
  → 0.22 (engaged) → 0.45 (borders) → 0.65 (focus ring).
- **Phosphor Green** (#58e58c): cyan's warm partner, used almost solely inside the
  primary-action gradient (cyan→green, `linear-gradient(135deg, rgba(36,211,232,0.22),
  rgba(88,229,140,0.16))`) and the empty-stage `~` glyph. Not a status color — that is
  ok-green below.
- **Backlit Cyan** (#c2eaf1): near-white with cyan memory; text that sits "lit from behind"
  (the brand nameplate, the Fleet Command label at rest).

### Neutral
- **Dead-Screen Black** (#070a0f): the page field — a powered-off CRT, not pure black.
- **Rail Black** (#090d13): the sidebar hull, one step up from the field.
- **Glass Panel** (#0d121b): standard surface — drawer headers, modals.
- **Glass Panel Raised** (#111824): interactive surfaces — buttons, inputs, hover fills, chips.
- **Terminal Well** (#0b0e14): the darkest working surface, reserved for terminal and log
  content (xterm background, provision logs). Content wells sit *below* the chrome.
- **Hairline** (#202938): the 1px border that draws every instrument's edge.
- **Instrument White** (#d8e1ea): primary text — cool white, never #fff (pure white is
  reserved for text on the rare solid-blue submit, which is itself being retired).
- **Dimmed Readout** (#7f8b9a): secondary text — meta lines, hints, resting labels. This is
  the *only* approved muted gray; it passes AA on every approved surface.

### Status (semantic only)
- **Alert Red** (#f85149): down, error, destructive affordances.
- **Warn Amber** (#d29922): degraded, running-with-warnings, unseen-events badge.
- **OK Green** (#2ea043): reachable, healthy, success results.
- **Needs-Auth Purple** (#a371f7): reachable but needs a login — deliberately distinct from
  red because it means "actionable", not "dead". Purple appears nowhere else in the system.

### Named Rules
**The One Voice Rule.** Phosphor Cyan is the only accent. No foreign blues — the GitHub-blue
literals (#1f6feb, #2f6feb) still present on some modal submits and tab underlines are legacy
drift scheduled for retirement, never a precedent.
**The Signal Rule.** Red, amber, green, and purple appear only as status semantics tied to a
real machine state. Never decorate with them.
**The Wash Ladder Rule.** Interactive cyan comes as alpha washes on the documented ladder
(0.05 / 0.12 / 0.22 / 0.45 / 0.65); don't invent intermediate opacities per surface.

## Typography

**Display Font:** MesloLGMDZ Nerd Font (bundled; MesloLGSDZ, JuliaMono symbol subset as fallbacks)
**Body Font:** ui-sans-serif / system-ui (native stack)
**Label/Mono Font:** MesloLGMDZ Nerd Font for machine text; the body sans, tracked and uppercased, for labels

**Character:** The terminal's own monospace is the display voice — the biggest type on any
screen is a 42px prompt, not a marketing headline. Chrome speaks a quiet native sans at 13px,
and authority comes from letterspacing, not size: the wider the tracking, the more official
the label.

### Hierarchy
- **Display** (400, 42px, 1.0, mono): the empty-stage prompt glyphs only. The product's own
  vocabulary at hero scale.
- **Headline** (700, 28px, 1px tracking): the login `h1` — the one large sans moment.
- **Title** (700, 16px, 1px tracking): modal and hub headings (`h2`).
- **Body** (400, 13px): controls, rows, copy. Meta lines drop to 11px in Dimmed Readout.
- **Label** (600, 10.5px, 0.09em tracking, UPPERCASE): eyebrows and HUD buttons — the fleet
  console voice (fleet buttons run 1.2px tracking at their size).
- **Mono** (400, 12px): terminal cells, logs, commands, fingerprints, session names.

### Named Rules
**The Mono Means Machine Rule.** Monospace appears only where content is machine text —
commands, logs, paths, fingerprints, prompt glyphs. UI chrome never wears it for style.
**The Tracked Caps Rule.** Uppercase + tracking is the HUD register, reserved for micro-labels
(≤13px). Never track body copy or headlines beyond 1px.

## Layout

A fixed instrument rail beside a fluid viewport: `grid-template-columns: 320px 1fr` at
`100vh`, collapsing to a 56px icon rail (animated on the grid columns, 0.25s). The stage
hosts exactly one thing at a time — a terminal, a setting-up panel, or the empty-stage
prompt. Transient chrome slides in from the right as fixed drawers (`min(560px, 92vw)`,
transform-based, 0.25s ease): Fleet Jobs, Events, the provision panel. Modals center over a
55% black backdrop in role-based widths: 340px (confirm), 560px (box/settings), 620px
(script editor), 760px (Proxmox hub), all capped at 92vw.

Density is fleet-scale: 13px base type, 6–10px gaps inside rows, 8px row padding, 12–18px
panel padding, on a 4px-based rhythm (4/8/12/16/24 with 6 and 10 in dense rows). Modal
internals reflow to one column below 620px; the Proxmox hub reflows below 720px. The main
rail/stage grid currently has no narrow-viewport mode — a known gap slated for design (the
product's phone check-in scene), not a rule to preserve.

## Elevation & Depth

Depth is tonal and edged, not shadowed: five blue-black levels (field → rail → panel →
raised panel, with the terminal well sitting *below* chrome) separated by 1px hairlines.
Luminosity and shadow then split duties cleanly. Cyan glow is a signal — identity (the logo
and nameplate's 14px aura), attention (hover's faint 10–12px bloom), or state (the engaged
Fleet Command pulse) — and never a depth cue. True drop shadows exist only where something
genuinely floats above the page: the login card (`0 24px 80px rgba(0,0,0,0.38)`) and toasts
(`0 8px 28px rgba(0,0,0,0.45)`).

### Shadow Vocabulary
- **Floating chrome** (`box-shadow: 0 24px 80px rgba(0,0,0,0.38)`): the login card; the only
  large ambient shadow in the system.
- **Toast lift** (`box-shadow: 0 8px 28px rgba(0,0,0,0.45)`): transient notices.
- **Identity glow** (`box-shadow: 0 0 14px rgba(36,211,232,0.28)`): brand logo and nameplate.
- **Hover bloom** (`box-shadow: 0 0 10px rgba(36,211,232,0.12), inset 0 0 8px rgba(36,211,232,0.05)`):
  HUD buttons on hover.
- **Engaged aura** (`box-shadow: 0 0 14px rgba(36,211,232,0.26), inset 0 0 10px rgba(36,211,232,0.12)`,
  pulsing 2.4s): Fleet Command while active — the strongest glow in the app, and the ceiling.

### Named Rules
**The Glow Is State Rule.** Cyan light means identity, attention, or engagement — never
altitude. Black shadow means altitude — never decoration. A surface at rest is flat with a
hairline.

## Shapes

Soft rectangles with an 8px default radius on every instrument (buttons, inputs, rows,
drawer items); 4–6px on compact controls and chips' small cousins; 12px on modals, 16px on
the login card — radius scales with how much a thing floats. Status metadata is always a
999px pill (badges, job-status chips, session chips), and status presence is a 9px circular
dot. Edges are drawn, not implied: 1px Hairline borders everywhere, with cyan-tinted borders
(`rgba(36,211,232,0.3–0.7)`) marking interactive warmth.

**The Inset Beacon Rule.** Selection is a 3px cyan bar inset on the left edge of the selected
row (`inset 3px 0 0`) plus a 0.12-alpha cyan wash — boxes, groups, the Host Shell all signal
"attached here" the same way. Never a filled row, never an outline.

## Components

### Buttons
- **Shape:** soft rectangle (8px radius), 1px border.
- **Primary** ("Unlock", "Run on N boxes"): the cyan→green phosphor gradient
  (`linear-gradient(135deg, rgba(36,211,232,0.22), rgba(88,229,140,0.16))`) with a
  0.38-alpha cyan border, Instrument White text at weight 700, 10px padding. Reserved for
  the one action a screen exists for.
- **HUD** (Fleet Command, Fleet Jobs, Proxmox, Events): raised glass, uppercase 10.5px
  tracked labels, hover lights the border and text cyan with a faint bloom; the hero
  (Fleet Command) carries a diagonal sheen sweep on hover and the pulsing aura when engaged.
- **Secondary** (`.pve-btn`, modal cancels): raised glass, Hairline border, body-size text;
  hover warms the border.
- **Icon buttons** (row actions ✎ ↻ ✕ ⚷, panel closes): borderless, Dimmed Readout glyphs
  that brighten on hover; destructive ones turn Alert Red. All carry `aria-label`s.
- **Focus (all):** the shared ring — `outline: 2px solid rgba(36,211,232,0.65)` at 2px
  offset via `:focus-visible`; controls with their own painted ring (search, fleet input)
  opt out.

### Chips
- **Session chips:** 999px pills on raised glass, 12px text; selected = cyan border + cyan text.
- **Status badges:** 999px pills, 10px text; info = cyan tint, warn = amber tint, each with
  a 0.4-alpha matching border.

### Cards / Containers
- **Corner Style:** 12px (modals), 16px (login card), 8px (inline result cards, log wells).
- **Background:** Glass Panel for floating cards; Terminal Well for content wells (logs,
  terminals) — content sits darker than chrome.
- **Shadow Strategy:** flat with Hairline edges; see Elevation (shadow = altitude only).
- **Internal Padding:** 18px (modals), 8–12px (inline cards and wells).

### Inputs / Fields
- **Style:** raised glass fill, Hairline 1px border, 8px radius, 13–14px text; labels are
  12px Dimmed Readout stacked above (the `.field` pattern); placeholders are a quieter gray.
- **Focus:** border warms to `rgba(36,211,232,0.45)` plus a 2px cyan halo
  (`0 0 0 2px rgba(36,211,232,0.12)`) — the input glows awake rather than jumping.
- **Error:** message lines in Alert Red with `role=alert`; inputs themselves stay calm.

### Navigation (the box rail)
- Rows are the app's navigation: 9px status dot, 13px name (a real button), 11px Dimmed
  Readout meta line with severity-colored metrics, 64×16px cyan sparkline, icon actions.
  Hover fills raised glass; attachment uses the Inset Beacon. Collapsible group headers
  carry chevron + tracked name + tabular count. Tab strips (settings, hub) are quiet text
  tabs with a 2px underline on the active tab (currently the legacy blue — retire to cyan).

### The Empty Stage (signature)
The stage's resting state: a 42px monospace prompt — Phosphor Green `~`, Phosphor Cyan `$`,
and a blinking cyan block cursor (1.25s steps, holds solid under reduced motion) — over a
faint cyan radial field, with "No terminal attached" and a `+ Add box` keycap hint. The
product's own vocabulary doing the empty state's work; the one place display-scale type exists.

### Toast
Bottom-center pill card on raised glass, 13px, slides up 16px while fading in (0.2s),
`role=status`; error variant carries a red-tinted border and warm red text (#ffb4ad).

## Do's and Don'ts

### Do:
- **Do** pull every color from the frontmatter tokens; the `:root` custom properties
  (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--cyan`, `--green`)
  are the same system in code.
- **Do** use the cyan wash ladder (0.05 / 0.12 / 0.22 / 0.45 / 0.65) for interactive states,
  and the Inset Beacon (3px inset bar + 0.12 wash) for selection.
- **Do** give every animation a `prefers-reduced-motion` alternative that *holds* the element
  in a meaningful resting state (the cursor stays solid, the pulse stays lit) — never delete
  the element.
- **Do** keep machine text in the bundled Meslo mono and put logs/terminals in the Terminal
  Well, one tonal step below the chrome around them.
- **Do** write micro-labels in the HUD register: 10.5–12px, 600, uppercase, ~0.09em tracking.

### Don't:
- **Don't** introduce foreign accent hues. The GitHub blues (#1f6feb, #2f6feb) on modal
  submits and tab underlines are known drift being retired — match new work to Phosphor
  Cyan, and prefer replacing a blue you touch.
- **Don't** reach for the legacy near-duplicate grays (#c9d1d9, #8b949e, #6e7681, #232a36,
  #131722, #0f131c, #3fb950) — use Instrument White, Dimmed Readout, Hairline, Glass Panel,
  and OK Green. The duplicates fragment contrast (some fail AA where the token passes).
- **Don't** use severity colors decoratively, and never repurpose Needs-Auth Purple.
- **Don't** exceed the Engaged Aura glow ceiling or add large ambient shadows to resting
  surfaces — no SaaS card-grid look, no neon flood.
- **Don't** let chrome outdress the terminal: no display-size sans headlines inside the app,
  no ornament on the stage beyond the empty-state prompt.
