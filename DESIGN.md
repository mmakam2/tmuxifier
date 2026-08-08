---
name: tmuxifier
description: A single-operator fleet dashboard as a creator-hardware desk instrument — machined chassis, keycap controls, amber live readouts
colors:
  chassis-black: "#101216"
  chassis-panel: "#16181d"
  chassis-raised: "#1c1f25"
  gunmetal: "#3e4146"
  bezel-line: "#282c33"
  screen-well: "#0a0b0d"
  bone: "#e6e2da"
  putty: "#b9b4a6"
  legend-dim: "#8a8577"
  amber: "#ffb000"
  amber-deep: "#e09600"
  safety-orange: "#ff6a1a"
  led-green: "#3ecf6e"
  led-red: "#ff5c47"
  led-violet: "#a98bff"
  ink-on-orange: "#1a0e05"
  phosphor-moss: "#a8c987"
  phosphor-peach: "#ff9d5c"
typography:
  display:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "42px"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "0.04em"
  nameplate:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "26px"
    fontWeight: 700
    letterSpacing: "0.22em"
  title:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 700
    letterSpacing: "0.1em"
  body:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  field:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
  glyph:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
  legend:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.14em"
  readout:
    fontFamily: "'MesloLGMDZ Nerd Font', 'MesloLGSDZ Nerd Font', 'JuliaMono', ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  key: "6px"
  chip: "4px"
  screen: "8px"
  chassis: "14px"
  cursor: "2px"
  lamp: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  key-commit:
    backgroundColor: "{colors.safety-orange}"
    textColor: "#1a0e05"
    rounded: "{rounded.key}"
    padding: "10px 12px"
    typography: "{typography.legend}"
  key-function:
    backgroundColor: "{colors.chassis-raised}"
    textColor: "{colors.putty}"
    rounded: "{rounded.key}"
    padding: "10px 12px"
    typography: "{typography.legend}"
  key-icon:
    textColor: "{colors.legend-dim}"
    rounded: "{rounded.chip}"
    padding: "2px 5px"
  input-field:
    backgroundColor: "{colors.screen-well}"
    textColor: "{colors.bone}"
    rounded: "{rounded.key}"
    padding: "9px 10px"
  chip-mode:
    backgroundColor: "{colors.chassis-raised}"
    textColor: "{colors.putty}"
    rounded: "{rounded.chip}"
    padding: "2px 7px"
    typography: "{typography.legend}"
  screen-readout:
    backgroundColor: "{colors.screen-well}"
    textColor: "{colors.amber}"
    rounded: "{rounded.screen}"
    padding: "10px"
  modal-card:
    backgroundColor: "{colors.chassis-panel}"
    textColor: "{colors.bone}"
    rounded: "{rounded.chassis}"
    padding: "18px"
  tab:
    textColor: "{colors.legend-dim}"
    padding: "7px 12px"
    typography: "{typography.legend}"
---

# Design System: tmuxifier

## Overview

**Creative North Star: "The Bench Instrument"**

Tmuxifier is a desk instrument for operating a fleet: a machined charcoal chassis holding a
control cluster on the left and a screen bay on the right. Every control is a physical part
— box rows are keys with status lamps, buttons have key travel, section labels are engraved
legends, and live values glow amber like an OLED readout. The terminal is the device's
display: the brightest, most alive thing on the bench, recessed into the chassis rather
than floating above it. The personality is **tactile, deliberate, warm-lit**: matte
surfaces, small honest shadows, one saturated action color, and glow that only ever means
"powered and live."

Anti-references bound the world on both sides. This is not **2010 skeuomorphism** — no
gloss gradients, no leather, no oversized bevels; depth comes from 1–2px extrusions and
recesses a machinist would recognize. And it is not the **neon terminal dashboard** the
category always ships (the previous cyan-phosphor world is retired evidence, not a
precedent) — nothing floods the surface with accent color, and the chassis stays quiet so
the display can lead.

**Key Characteristics:**
- One legend face: the bundled Meslo mono is the entire product's voice — engraved chassis
  legends, key labels, readouts, and the terminal itself share it
- Chassis neutrals (charcoal, gunmetal, bone, putty) with two functional accents: amber =
  live, safety orange = operator action needed
- Depth by machining: keys extrude 1–2px and travel down when pressed; screens recess with
  an inset lip; nothing floats except true overlays
- Status is hardware vocabulary: LED lamps (green/red/amber/violet) and lit-vs-dark chips
- Density serves supervision: dense keycap rows for the fleet, one glowing display at a time

## Colors

Matte chassis neutrals under warm functional light.

### Chassis (neutral)
- **Chassis Black** (#101216): the bench field — powder-coated near-black, warm not blue.
- **Chassis Panel** (#16181d): standard panel surface — sidebar, modals, drawer chrome.
- **Chassis Raised** (#1c1f25): extruded parts — keys, inputs at rest, hover fills, chips.
- **Gunmetal** (#3e4146): pressed/engaged key fill and strong bezel edges.
- **Bezel Line** (#282c33): the 1px machined seam that separates parts.
- **Screen Well** (#0a0b0d): recessed display glass — terminals, logs, code editors, and
  text inputs. Content and typing happen *in the glass*, one step darker than the chassis.
- **Bone** (#e6e2da): primary legends and text — warm off-white, never #fff.
- **Putty** (#b9b4a6): secondary legends, resting key labels.
- **Legend Dim** (#8a8577): tertiary/disabled legends, hints, engraved section labels.

### Functional light
- **Amber** (#ffb000): live state — the screen's phosphor. Readout values, the active tab's
  lit legend, a working agent, a running job, focus glow on inputs. Amber Deep (#e09600)
  for borders/edges of lit elements.
- **Safety Orange** (#ff6a1a): operator action needed — the one committing key on any
  surface (Unlock, Run on N boxes, Create), the agent-waiting chip, needs-interactive
  states. Text on solid orange is near-black (#1a0e05).

### Status LEDs (semantic only)
- **LED Green** (#3ecf6e): reachable, healthy, success.
- **LED Red** (#ff5c47): down, error, destructive affordances.
- **LED Violet** (#a98bff): reachable but needs a login — actionable, not dead.
- Warn/degraded uses **Amber** in lamp form (a dot or chip), distinct from amber-as-glow by
  shape, matching annunciator practice.

### Display phosphors (content only)
- **Phosphor Moss** (#a8c987) and **Phosphor Peach** (#ff9d5c): syntax-highlight phosphors
  for code shown on screen glass (the Fleet script editor) — display *content*, never
  chrome, and deliberately softer than the LED hues so machine-state color keeps its
  monopoly on meaning. Ink-on-Orange (#1a0e05) is the engraved text on the commit key.

### Named Rules
**The Orange Means You Rule.** Safety orange appears only where the operator's press is the
point: primary commits and states waiting on the operator. Never decoration, never headers,
never more than one solid-orange key per view.
**The Amber Means Alive Rule.** Amber glow marks something currently powered/working —
readouts, live values, engaged modes, focus. A resting surface never glows.
**The LED Rule.** Green/red/violet appear only as machine-state semantics (lamps, chips,
status text). Never decorate with them.

## Typography

**The One Legend Face Rule.** MesloLGMDZ Nerd Font (bundled, with MesloLGSDZ and JuliaMono
fallbacks) is the only face in the product. The chrome is machined from the same metal as
the screen: key legends, engraved labels, readouts, body copy, and the terminal all speak
it. No sans-serif anywhere.

**Character:** authority comes from case and tracking, not size. Engraved legends are
small, bold, uppercase, and tracked wide (0.12–0.16em); prose is regular-case at 12.5px;
readout values glow amber. The two display moments differ in kind: the standby dashboard
speaks the terminal's own vocabulary — a 20px `~ $` masthead, growing to 42px/400 on a
fresh install (a prompt, not a headline) — while the login
nameplate is engraved — 26px/700, lowercase (brand commitment), tracked 0.22em, with a
lit standby lamp beside it.

### Hierarchy
- **Display** (400, 42px): the standby dashboard's fresh-install prompt only (the masthead
  prompt runs ~20px).
- **Nameplate** (700, 26px, lowercase, 0.22em): the login engraving.
- **Title** (700, 12.5px, upper, 0.1em): modal and hub headings.
- **Legend** (700, 10px, upper, 0.12–0.14em): key labels, section engravings, tab labels.
  The chassis voice.
- **Body** (400, 12.5px, 1.5): rows, prose, hints. Regular case.
- **Field** (400, 14px): text inputs and selects — typing in the glass.
- **Readout** (400, 11px, tabular-nums): meta figures, timestamps, event times.
- **Glyph** (14–16px): icon keys (✎ ↻ ✕ ⚷, closes); geometry, not copy.
  The size is the *drawn* mark, not the font-size. Unicode geometry ink varies
  wildly at one font-size (the power mark ⏻ inks 0.96em, the reboot arrow ↺ only
  0.50em), so a key whose glyph is drawn small carries a compensating font-size
  outside this step (e.g. `.pane-life-reboot` at 21px) to land on the same drawn
  height. Those keys must be fixed-size boxes, so the compensation moves the
  glyph and never the layout. Pick glyphs the bundled face actually has — a
  missing one falls through to a system face and lands at the wrong size.

## Layout

The topology is unchanged from the product's working shape — fixed rail beside a fluid
stage (`320px 1fr`, collapsing to 56px), right-side drawers (`min(560px, 92vw)`), centered
modals in role widths (340px for a confirm, 560–760px for a form or a hub, 1040px for the
fleet script editor — a workbench, not a dialog) — but the world reframes it: the rail is the **control
cluster** (keys, lamps, the commit bar), the stage is the **screen bay** (a recessed
display mounted in the chassis), and drawers/modals are **service panels** that open with
mechanical directness (fast transforms, no bounce). Panel gutters are 12–16px; key rows
run dense at 8px padding on a 4px rhythm. The chassis shows between parts: panels and the
screen bay sit inside a visible margin of Chassis Black, like components mounted on a
faceplate, not edge-to-edge web regions.

## Elevation & Depth

Depth is machined, not lit. Three honest moves:
- **Extrusion** (keys, buttons, chips): `box-shadow: 0 1px 0 <darker edge>` plus a 1px top
  highlight inside (`inset 0 1px 0 rgba(255,255,255,0.04)`); pressing translates the part
  down 1px and drops the edge shadow — key travel.
- **Recess** (screen well, inputs, log wells): `inset 0 2px 6px rgba(0,0,0,0.5)` under a
  1px bezel line — the glass sits below the faceplate.
- **Overlay lift** (modals, toasts, drawers — parts genuinely above the bench):
  `0 16px 48px rgba(0,0,0,0.55)` with a bezel border.

**The Glow Is Power Rule.** Amber emission (`0 0 12–20px rgba(255,176,0,0.15–0.35)`)
appears only on live/engaged elements — the empty-stage standby cursor, focused inputs,
an engaged Fleet Command key, working-agent chips. Glow never signals altitude; shadow
never decorates.

## Shapes

Keys are soft rectangles at 6px; chips and small controls 4px; recessed screens 8px; the
chassis and modals 12–14px. Status lamps are true circles (8–9px) with an off-state ring
(`1px solid` bezel) so a dark lamp still reads as a lamp. Every part is edged by the 1px
Bezel Line; interactive warmth comes from putty→bone legend brightening and amber glow,
never from painted borders alone.

**The Lamp-and-Beacon Rule.** Selection/attachment is a lamp turned on plus a 2px amber
inset bar on the part's left edge (`inset 2px 0 0 var(--amber)`); the row itself lifts one
chassis step. Focus (keyboard) is the shared amber ring (`outline: 2px solid
rgba(255,176,0,0.6)` offset 2px).

## Components

- **Commit key** (one per view): solid Safety Orange, near-black legend, extruded with key
  travel; hover deepens to #ff7d38, active presses down. Disabled = unpainted (chassis
  raised, dim legend).
- **Function keys** (fleet cluster, + Add box, secondary actions): Chassis Raised extrusion,
  putty uppercase legends; hover brightens legend to bone; engaged mode = Gunmetal fill,
  amber legend, amber lamp dot, faint amber glow.
- **Icon keys** (row actions ✎ ↻ ✕ ⚷): flat legend-dim glyphs on 4px hit pads; hover
  raises one chassis step and brightens; destructive hover turns LED Red.
- **Box rows** (the fleet cluster): 9px lamp, bone name, readout meta line with LED-colored
  figures, amber sparkline; hover = Chassis Raised; attached = Lamp-and-Beacon.
- **Inputs**: recessed Screen Well glass, bone text, bezel border; focus lights the bezel
  amber with a soft outer glow — the input powers on. Placeholders legend-dim.
- **Chips/badges**: 4px mode chips in legend type — lit (amber/orange/LED color at 12–16%
  fill + colored text) or dark (chassis + putty).
- **Screens** (terminal, logs, provision output, script editor): Screen Well glass recessed
  behind a bezel; content glows slightly (no text-shadow on body sizes — glow reserved for
  display-scale readouts).
- **Tabs**: legend type; active tab's legend lits amber with a 2px amber underline seam.
- **Standby dashboard (signature)**: the display in standby — the recessed glass showing
  the instrument's home readout: a shrunken `~ $` masthead with the breathing amber block
  cursor, a fleet strip (lamps, agent chips, amber sparklines), grouped service tiles
  (Nerd Font glyph, LED lamp, amber latency readout), and an infrastructure readout row
  (Proxmox counts, NetBox prefix utilization). Everything on the glass is flat display
  content — legends engrave, lamps light, hover brightens and edges glow amber; nothing
  extrudes. On a fresh install (no boxes, no services) it collapses to the original
  standby prompt: the 42px `~ $`, the `NO TERMINAL ATTACHED` legend, and a keycap-drawn
  `+ Add box` hint. Reduced motion holds the cursor solid.
- **Login (signature)**: the instrument's faceplate powered down to one module — machined
  logo badge, engraved lowercase nameplate with a breathing amber standby lamp, recessed
  password glass, and the orange UNLOCK commit key.
- **Toast**: a small readout module lifted above the bench, amber-edged for info, LED-red
  for errors.

## Do's and Don'ts

### Do:
- **Do** pull every color from the frontmatter tokens; the `:root` custom properties in
  style.css are the same system in code.
- **Do** give every part its material: extrude interactive parts, recess content glass,
  keep the chassis visible between mounted panels.
- **Do** keep one solid-orange commit per view and let everything else stay neutral.
- **Do** give every animation a `prefers-reduced-motion` alternative that holds a
  meaningful resting state (cursor solid, glow steady, key un-pressed).
- **Do** write legends uppercase, bold, tracked (0.12–0.16em) at 10–11px.

### Don't:
- **Don't** reintroduce the retired cyan/blue-glass world or any foreign accent hue; the
  GitHub blues are gone, not resting.
- **Don't** gloss: no glass highlights taller than 1px, no gradients steeper than 6% L
  across a surface, no drop shadows on resting inline parts.
- **Don't** let amber and orange trade jobs: amber never commits, orange never merely
  glows.
- **Don't** use LED colors decoratively or repurpose violet away from needs-auth.
- **Don't** put a sans-serif anywhere; if a glyph is missing, it comes from the bundled
  fallback monos, not a system sans.
