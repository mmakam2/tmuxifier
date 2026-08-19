# Tmuxifier MCP Server — Design

Date: 2026-08-19
Status: approved design, pre-implementation

## Purpose

Give MCP clients (Claude Code first) an orchestration control plane over the Tmuxifier
fleet: observe boxes and agent states, read panes, drive the Claude sessions running on
boxes, run fleet commands, start setup jobs, provision Proxmox guests, and operate guest
power — everything the web UI can *operate*, none of what it *administers*.

The MCP server is a **renderer of the server APIs** in exactly the Android app's sense
(`docs/superpowers/specs/2026-08-09-android-agent-console-design.md`): it speaks only
HTTP to the running Tmuxifier server. It never speaks SSH, never runs tmux, and holds no
credential other than a device token. Every security property of the REST layer —
validation chokepoints, `sanitizeSendText`, `NAMED_KEYS`, rate limits — is inherited, not
reimplemented.

## Decisions (settled during brainstorming)

1. **Scope**: full operational parity — observe + drive worker agents + fleet ops +
   provisioning. Not settings/credential administration.
2. **Transport**: stdio wrapper first; a Streamable-HTTP endpoint in Fastify is an
   explicit later phase (see Out of scope). The protocol core is written
   transport-agnostic so phase 2 mounts it rather than rewrites it.
3. **Blast radius**: "operate, not administer" (detail below). The line is structural —
   excluded routes have no code path in the wrapper.
4. **Implementation**: hand-rolled, dependency-free, in the repo's mold (`truenasApi.js`
   already hand-rolls JSON-RPC 2.0; `googleAuth.js`/`webauthn.js` set the precedent).
   Zero new npm dependencies.
5. **Waiting**: blocking `wait_for_*` tools with timeouts, so one tool call replaces
   dozens of model-driven polls.
6. **Catalog shape**: curated task-oriented tools (~19), not a 1:1 REST mirror.

## Architecture

New directory `src/mcp/`, plain ESM `.js`, factory functions with dependencies injected
(the server-side convention). Modules:

- `src/mcp/jsonrpc.js` — pure newline-delimited JSON-RPC 2.0 framing: a line buffer →
  parsed messages, response/error serializers. No I/O; fed strings, returns objects.
- `src/mcp/mcpServer.js` — the MCP lifecycle over an injected `{ send, onMessage }`
  transport pair: `initialize` (protocol version negotiation — reply with the client's
  version when supported, else our latest known, `2025-06-18`; capabilities `{ tools: {} }`;
  `serverInfo { name: 'tmuxifier', version: <package.json> }`), `notifications/initialized`,
  `ping`, `tools/list`, `tools/call` dispatched into an injected tool registry. Handlers
  are async and may overlap (a `wait_for_*` call must not block a concurrent
  `read_pane`). Unknown methods get JSON-RPC `-32601`. **Transport-agnostic on purpose**:
  phase 2 (HTTP) reuses this module unchanged.
- `src/mcp/apiClient.js` — dependency-free JSON client over `node:http`/`node:https`
  (the `netboxApi.js` mold), sending `Authorization: Bearer <device token>`. Implements
  **only** the allowlisted routes (see Safety). Self-signed TLS: an explicit
  `insecure: true` config opt-in sets `rejectUnauthorized: false`; default is verified.
- `src/mcp/tools.js` — the catalog: `{ name, description, inputSchema }` defs (hand-written
  JSON Schema; no schema library) plus handlers calling the client. Wait-tool poll
  intervals are injectable for tests.
- `src/mcp/shape.js` — pure output formatters, no I/O: pane snapshot → readable text
  block, box list + status snapshot → per-box summary lines, job records → status
  summaries. Unit-testable in isolation.
- `src/mcp/config.js` — pure config resolution (env map and file contents injected, like
  `loadConfig`).
- `src/mcp/index.js` — entry point: resolve config, construct client + registry, wire
  stdin/stdout. **stdout is protocol-only**; all logging goes to stderr.
- `scripts/mcp-enroll.js` — one-time enrollment CLI.

npm scripts: `"mcp": "node src/mcp/index.js"`, `"mcp-enroll": "node scripts/mcp-enroll.js"`.

Registration from Claude Code on the Tmuxifier host:
`claude mcp add tmuxifier -- node /path/to/tmuxifier/src/mcp/index.js`.

## Auth and config

The MCP server **is a device**, on the Android app's credential path unchanged.

- **Enrollment**: `npm run mcp-enroll` posts to `POST /api/devices/enroll` with either a
  pairing code (`--code`, minted in Settings → Devices → Pair new device; works in every
  auth mode including armed passkey-only) or the password (prompted; password mode only).
  Device name defaults to `MCP orchestrator`. The returned token is written to
  `data/mcp-token.json` (`0o600`; `data/` is already gitignored — the self-contained
  principle holds). The token is shown once by the server and never again; losing the
  file means re-enrolling.
- **Revocation**: Settings → Devices, like any device — effective on the next request.
- **Config precedence** (env wins over file, matching the repo's model):
  `TMUXIFIER_MCP_URL` / `TMUXIFIER_MCP_TOKEN` env vars first; otherwise, when run from
  the repo folder, the base URL derives from `loadConfig()` (bind address, port, TLS)
  and the token from `data/mcp-token.json`. On the Tmuxifier host itself this is
  zero-config after enrollment; from a box, set the two env vars.
  `TMUXIFIER_MCP_INSECURE=1` opts into unverified TLS for self-signed deployments.

## Tool catalog

Names are `snake_case`; every tool returns MCP `content: [{ type: 'text', ... }]` with
compact, model-readable text from `shape.js` (raw JSON is not a UI). Mapping to REST:

### Observe

| Tool | REST | Notes |
| --- | --- | --- |
| `list_boxes` | `GET /api/boxes` + `GET /api/status` | One-call fleet overview: per box — label, host, reachability, metrics, tmux sessions, latest agent state. Reads the poller's cached snapshot; costs zero SSH. |
| `read_pane` | `GET /api/boxes/:id/pane?lines=N` | Pane text (+ agent state, `alt`/`mouse` flags). Deliberately **never** sends `cols`/`rows`: an MCP read must not summon the invisible sizing client and reflow the operator's session to another geometry. |
| `box_health` | `GET /api/health/series?box=` + `GET /api/health/events` | Recent events + series summary for one box. |
| `list_fleet_scripts` | `GET /api/fleet/scripts` | Names, notes, bodies. |
| `list_presets` | `GET /api/proxmox/presets` + `GET /api/proxmox/hosts` | Everything needed to parameterize `provision_guest`. |
| `list_guests` | `GET /api/proxmox/guests` | Linked guests: kind, state, `template` flag, mismatch state. |
| `list_jobs` | `GET /api/fleet/jobs`, `/api/setup`, `/api/proxmox/provisions`, `/api/proxmox/lifecycle-jobs` | Merged newest-first summary across all four kinds; optional `kind` filter. |
| `job_status` | `GET <kind>/:id` | One job with log tail (tail length parameterized, capped). |

### Operate

| Tool | REST | Notes |
| --- | --- | --- |
| `send_text` | `POST /api/boxes/:id/keys { text }` | Literal text; server-side `sanitizeSendText` stays the authority. Optional `submit: true` issues a second call `{ key: 'Enter' }` — the route accepts exactly one of text/key/wheel per call. |
| `send_key` | `POST /api/boxes/:id/keys { key }` | Named key; server-side `NAMED_KEYS` allowlist is the authority (unknown key → the server's 400 is relayed). |
| `scroll_pane` | `POST /api/boxes/:id/keys { wheel, steps }` | The 409 "no mouse tracking" answer is relayed as a readable explanation. |
| `run_fleet_command` | `POST /api/fleet/jobs { boxIds, command, scriptName? }` | Accepts `command` text or `script_id`. The route requires command text, so a `script_id` is resolved client-side via `GET /api/fleet/scripts` and its body sent as `command` with `scriptName` as the frozen label — the same contract the web UI honors (a dirty/renamed script can never be misattributed; we send the label only when sending that script's exact body). |
| `cancel_fleet_job` | `POST /api/fleet/jobs/:id/cancel` | |
| `add_box` | `POST /api/boxes` | Create only; no update/delete tools. |
| `start_setup` | `POST /api/boxes/:id/setup` | Full options passthrough: `ohMyTmux`/`ohMyZsh`/`ohMyBash`, `tools[]`, `seedAiAuth`, `claudeStatusline`, `scriptId`/`scriptName`. Server remains the validation authority. |
| `provision_guest` | `POST /api/proxmox/provisions` | Preset-based; the provision manager's own fail-fast checks (hostname collision, NetBox, host/node) do the validating. |
| `guest_power` | `POST /api/proxmox/lifecycle-jobs { boxId, action }` | `action` restricted **in the tool schema** to `start`/`shutdown`/`reboot`/`stop` — deprovision is not an accepted value even though the route could take it. |

### Wait

| Tool | Polls | Notes |
| --- | --- | --- |
| `wait_for_agent` | `GET /api/health/series?box=` | Blocks until the box's agent state enters a target set (`waiting`, `working`, `gone` — where `gone` means the latest sample carries no agent state, i.e. no hook marker) or timeout. Polls the **health series** (the status poller's cache), not the pane route — waiting must not amplify SSH traffic. |
| `wait_for_job` | the matching `GET <kind>/:id` | Blocks until the job leaves `running` (any settled status) or timeout. |

Wait semantics: `timeout_sec` defaults to 120, capped at 540 (inside common MCP client
tool timeouts); poll interval ~2s (injectable). Timeout is **not an error**: the tool
returns the current state with `timed_out: true` so the orchestrator decides what's next.

## Safety posture

- **Structural exclusion.** `apiClient.js` implements only the routes in the tables
  above. Deprovision, box/device/passkey/script deletion, `forget-hostkey`, root-password
  and every settings/credential CRUD route (Proxmox hosts/keys, NetBox, services, voice,
  UI settings, devices, export/import, APK) have **no code path** — not a flag, not a
  permission check; absent. Widening the surface is a deliberate future edit to the
  client, reviewed as such.
- **Token class.** A device token: enrollment is rate-limited through the login bucket,
  only the SHA-256 digest is stored server-side, revocation is immediate. Documented
  caveat (as for the Android app): device tokens never expire and ignore the logout
  watermark — revoke the MCP device in Settings → Devices when an orchestrator retires.
- **Untrusted pane text.** A rogue or compromised box can write anything into its tmux
  pane, and `read_pane` hands that text to the orchestrating agent. The tool description
  itself states that pane content (and fleet job output in `job_status`) is untrusted
  data from the box, not instructions. This is the same posture `status.js` takes toward
  `__META__`/`__AGENT__` lines — box output is input.
- **stdout discipline.** The stdio transport treats stdout as protocol-only; a stray
  `console.log` corrupts the stream, so logging is stderr-only and the entry point
  enforces it (redirect `console.log` to stderr at startup).

## Error handling

- REST non-2xx → MCP tool result with `isError: true` and the server's error message
  plus route context, so the model can self-correct (e.g. the keys route's
  `unknown key`, the 409 wheel refusal, setup-gated 502s).
- 401 specifically → a distinguishable "token invalid or revoked — re-run
  `npm run mcp-enroll`" message.
- Connection refused/timeout → "cannot reach Tmuxifier at `<url>`" with the resolved
  base URL, the diagnosis being usually a stopped service or wrong `TMUXIFIER_MCP_URL`.
- JSON-RPC layer: parse errors → `-32700`; unknown method → `-32601`; a tool handler
  throw is caught and returned as an `isError` tool result, never a transport crash.

## Testing

Repo conventions: real code, no mocks; TDD.

- **Pure units**: `jsonrpc.js` framing (split/joined/partial lines, batch-free),
  `shape.js` formatters, catalog validity (every tool has a name/description/schema;
  schema `required` fields exist in `properties`; `guest_power` enum excludes
  deprovision).
- **Protocol**: `mcpServer.js` driven over in-memory transports — initialize handshake,
  version negotiation, tools/list, tools/call success + handler-throw + unknown method,
  concurrent call interleaving (a slow handler does not block a fast one).
- **Integration**: boot the real `buildServer()` on an ephemeral port, enroll a real
  device token through the real pairing flow, spawn `src/mcp/index.js` as a child
  process over stdio pipes, and exercise `list_boxes` → `run_fleet_command` →
  `wait_for_job` end-to-end. One full-stack pane test rides the `localBox.js` sshd
  fixture: `read_pane` sees real tmux output, `send_text` round-trips.
- **Live validation before merge** (standing workflow): `claude mcp add` on the host
  against the live app; drive a real box — read a pane, send a prompt to a real Claude
  session, run a fleet command, wait on it.

## Out of scope (this spec)

- **Phase 2 — Streamable HTTP**: mount `mcpServer.js` behind Fastify (`/mcp`) with
  `requireAuth` bearer-token auth, for remote MCP clients without a local process. Gets
  its own dated spec; the transport-agnostic core in this design is its enabler.
- MCP `resources`/`prompts` capabilities; notifications/subscriptions.
- Saved-script CRUD, box edit/delete, any settings administration, deprovision.
- Orchestration policy (which agent does what) — that lives in the MCP client, not here.

## Docs and shipping

- New `docs/mcp.md` user guide (enrollment, registration, tool reference, the
  untrusted-pane-text caveat, revocation), linked from the README feature list;
  `CLAUDE.md`/`AGENTS.md` architecture entries for `src/mcp/`.
- `.env.example` gains the commented `TMUXIFIER_MCP_URL`/`TMUXIFIER_MCP_TOKEN`/
  `TMUXIFIER_MCP_INSECURE` knobs; `data/mcp-token.json` follows the placeholder rule
  (documented in `docs/mcp.md`, created only by the enroll CLI).
- Ships through the normal checklist; the MCP server reads `package.json` for its
  advertised version, so it needs no separate versioning.
