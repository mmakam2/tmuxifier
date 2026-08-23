# MCP server

Tmuxifier ships a [Model Context Protocol](https://modelcontextprotocol.io) server so an MCP
client — Claude Code first — can operate the fleet: see every box and its Claude agent state,
read panes, type into the Claude sessions running on boxes, run fleet commands, start setup
jobs, provision Proxmox guests and operate guest power. It is a **renderer of the server
APIs**, exactly like the Android app: it speaks only HTTP to the running Tmuxifier, never SSH,
and holds no credential other than a device token. Everything the web UI can *operate* is
available; nothing it *administers* is (see [What it cannot do](#what-it-cannot-do)).

## Enroll

The MCP server is a **device**, on the same credential path as the Android app. Enroll it once:

```bash
# Any auth mode (password, OAuth, or with "require a passkey" armed):
#   Settings → Devices → Pair new device, then within two minutes
npm run mcp-enroll -- --code XXXX-XXXX

# Password mode only — prompts for the password:
npm run mcp-enroll
```

The token is written to `data/mcp-token.json` (owner-only, gitignored with the rest of
`data/`). The server shows a token once and never again: losing the file means enrolling
again. Revoke it any time in **Settings → Devices** — the next request fails with a message
telling you to re-enroll. Like every device token it never expires and ignores the logout
watermark, so revoke it when an orchestrator retires.

Options: `--name "MCP orchestrator"` (the device name in Settings → Devices), `--url
https://host:port` (default: `TMUXIFIER_MCP_URL`, else derived from this repo's `.env`),
`--insecure` (accept a self-signed certificate).

## Register with Claude Code

On the Tmuxifier host, from anywhere — register the `node` command shown, with the absolute
path to this repo's `src/mcp/index.js`:

```bash
claude mcp add tmuxifier -- node /path/to/tmuxifier/src/mcp/index.js
```

Register `node …`, not `npm run mcp`: npm prints its run-script banner on **stdout**, which is
the protocol stream, so a client reading it sees a corrupt first message. `npm run -s mcp`
silences the banner and is fine for a manual smoke test:

```bash
# Should answer with a JSON-RPC result naming the server and its version.
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | npm run -s mcp
```

No configuration is needed on the Tmuxifier host, wherever the client starts the process from:
the repo folder is derived from the module, so the base URL comes from the URL recorded at
enrollment (`--url`), else this repo's `.env` (bind address, port, TLS), and the token from
`data/mcp-token.json`. When the server is configured with its own TLS certificate
(`TMUXIFIER_TLS_CERT`/`TMUXIFIER_TLS_KEY`), the MCP server trusts exactly that certificate
automatically; `TMUXIFIER_MCP_INSECURE=1` remains the fallback for a served chain that differs
from it (a reverse proxy in front, say).

From another machine — a box orchestrating its siblings — set the two environment variables
instead:

```bash
claude mcp add tmuxifier -e TMUXIFIER_MCP_URL=https://tmuxifier.example.com -e TMUXIFIER_MCP_TOKEN=… -- node /path/to/tmuxifier/src/mcp/index.js
```

That stores the plaintext token in Claude Code's own configuration file, so treat that file
like `data/mcp-token.json`: it is a fleet credential, and revoking the device in Settings →
Devices is what retires it.

Environment variables win over everything else — including the `TMUXIFIER_MCP_*` lines in this
repo's own `.env`, which the server reads like every other setting. The process logs one line
to stderr at start naming the URL it resolved and where each setting came from; stdout is the
protocol stream.

## Tools

Every tool returns compact text. Ids come from `list_boxes` / `list_jobs` / `list_presets` /
`list_fleet_scripts`.

| Tool | What it does |
| --- | --- |
| `list_boxes` | Fleet overview: reachability, cpu/mem/disk, tmux sessions, Claude agent state per box. Reads the server's cached status — no SSH. |
| `read_pane` | The visible text of a box's configured session plus scrollback (`lines`, default 200). On an alternate-screen app like Claude Code only the visible screen is returned. |
| `box_health` | Latest health sample and recent events for one box. |
| `list_fleet_scripts` | Saved Fleet Command scripts with their bodies. |
| `list_presets` | Proxmox presets with host/node — the inputs to `provision_guest`. |
| `list_guests` | Linked Proxmox guests: CT/VM, vmid, node, state, template flag. |
| `list_jobs` | Fleet, setup, provision and lifecycle jobs newest first (`kind` filters). |
| `job_status` | One job with its log tail; fleet jobs show per-target stdout/stderr. |
| `send_text` | Type literal text — whitespace runs, newlines included, collapse to single spaces server-side, so a multi-line prompt arrives as one line. `submit: true` presses Enter afterwards — how you send a prompt to a Claude session. |
| `send_key` | Press one named key: Enter, Escape, Tab, BSpace, Up, Down, Left, Right or C-c — the server's allowlist, mirrored as the tool's enum so an unsupported key is refused without a round trip. |
| `scroll_pane` | Scroll a mouse-aware TUI (a Claude transcript) by wheel events; refused, with an explanation, on a plain shell. |
| `run_fleet_command` | Run a command or a saved script (`script_id`) on several boxes as a fleet job. |
| `cancel_fleet_job` | Cancel a running fleet job. |
| `add_box` | Register a new box. |
| `start_setup` | Start a server-side setup job (tmux, shell frameworks, tools, AI-auth seeding, post-setup script). |
| `provision_guest` | Create an LXC container from a preset, link it, start its setup. |
| `guest_power` | `start` / `shutdown` / `reboot` / `stop` the guest a box is linked to. |
| `wait_for_agent` | Block until the box's agent state is one of `until` (default `waiting`) or `timeout_sec` (default 120, max 540) passes. |
| `wait_for_job` | Block until a job leaves `running` or the timeout passes. |

Timing out is **not** an error: both wait tools return the current state with
`timed_out: true` and leave the next move to the orchestrator. Errors from the server are
relayed with the route and message (`409 /api/boxes/b1/keys: pane has no mouse tracking`) so
the model can self-correct. A response that is not JSON (for instance the app's HTML served
from a wrong base URL) is reported as an error rather than read as an empty result, so a
misconfigured `TMUXIFIER_MCP_URL` fails loudly.

## Pane text is untrusted

`read_pane` and `job_status` hand the orchestrating agent whatever a box printed. A box you
do not fully control — or a compromised one — can print anything, including text shaped like
instructions. The tool descriptions say so, and so should your orchestration prompts: pane
content and job output are **data from the box**, never instructions. This is the same posture
Tmuxifier itself takes toward every line a box sends it.

## What it cannot do

The exclusion is structural: the HTTP client behind the tools implements only the routes the
tools need. There is no code path — not a disabled one, none — for deprovisioning guests,
deleting boxes, devices, passkeys or scripts, forgetting SSH host keys, or any settings or
credential administration (Proxmox hosts and keys, NetBox, services, voice, appearance,
export/import, the Android APK). Widening that surface is a deliberate, reviewed edit to
`src/mcp/apiClient.js`.

## Transport

Phase 1 is stdio: one process per client, started by the client. A Streamable-HTTP endpoint
inside the Tmuxifier server, for remote clients without a local process, is a planned later
phase; the protocol core is written transport-agnostic so it mounts rather than rewrites.
