// Push the Tmuxifier agent-state hook to a box. Structural twin of
// claudeStatusline.js: a pure remote-installer builder + a small DI pusher,
// run as a post-setup step. The apply-or-skip decision is made ON THE BOX by
// a command -v claude presence check — always-on, no option flag (the
// framework-clamps precedent: run every setup, gate on evidence).
//
// The installer script text goes into ssh argv and interpolates NO input;
// the hook script bytes arrive on stdin.
//
// settings.json's `hooks` entries are ARRAYS of matcher objects (unlike the
// single .statusLine key), so the merge is remove-then-append per event:
// drop any entry whose serialized form mentions tmuxifier-agent-hook, then
// append ours — idempotent across reruns, never touches the operator's own
// hooks.
//
// SubagentStart/SubagentStop and the `Bash` PreToolUse entry feed the hook's
// background-work gate. `Stop` fires when the main agent finishes responding,
// which INCLUDES a turn that ended solely to await a background subagent or
// shell — work the harness resumes on its own. Reading that as "waiting on the
// operator" is what sent people back to a screen where nothing wanted them.
// SubagentStart/SubagentStop bracket a subagent exactly (both carry agent_id);
// PreToolUse `Bash` covers a backgrounded shell.
//
// PermissionRequest, the AskUserQuestion PreToolUse entry and the PostToolUse*
// entries carry the lifecycle states: a permission dialog or a question blocks
// the agent, and PostToolUse / PostToolUseFailure say it was answered. Several
// events therefore carry MORE than one entry. A `matcher` is a regex against the
// tool name (SessionStart: the `source`) and is carried only where the hook
// would otherwise fork on every tool call. The unmatched PostToolUse entry is
// deliberate: it short-circuits cheaply in the script for every other tool and
// is what clears a block when the tool ran without a dialog. `matcher` stays
// omitted on UserPromptSubmit and Stop (unsupported — Claude Code ignores one
// silently, so a dead field would only mislead a reader) and where unnecessary.
//
// HOOK_EVENTS is the single source for both the installer JSON and hookArgsFor.
export const HOOK_EVENTS = [
  ['SessionStart', 'start', 'startup|resume|clear|fork'],
  ['UserPromptSubmit', 'prompt'],
  ['Stop', 'stop'],
  ['PermissionRequest', 'permission'],
  ['Notification', 'notify'],
  ['SessionEnd', 'end'],
  ['SubagentStart', 'subagent-start'],
  ['SubagentStop', 'subagent-stop'],
  ['PreToolUse', 'pretool', 'Bash'],
  ['PreToolUse', 'ask', 'AskUserQuestion'],
  ['PostToolUse', 'unblock', 'AskUserQuestion'],
  ['PostToolUse', 'unblock'],
  ['PostToolUseFailure', 'unblock'],
];

// The command value, written LITERALLY — its ${...} is expanded later by the
// shell Claude Code spawns for the hook, not at install time.
const hookEntry = (arg, matcher) => {
  const entry = { hooks: [{ type: 'command', command: 'sh "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh" ' + arg }] };
  return matcher ? { matcher, ...entry } : entry;
};

const grouped = new Map();
for (const [ev, arg, matcher] of HOOK_EVENTS) {
  if (!grouped.has(ev)) grouped.set(ev, []);
  grouped.get(ev).push(hookEntry(arg, matcher));
}
const HOOKS_JSON = JSON.stringify(Object.fromEntries(grouped));

// The hook args Claude Code would invoke for one recorded payload, in
// HOOK_EVENTS order. Pure; a missing tool_name/source simply fails a matcher.
const MATCH_FIELD = { PreToolUse: 'tool_name', PostToolUse: 'tool_name', PostToolUseFailure: 'tool_name', SessionStart: 'source' };
export function hookArgsFor(payload) {
  const ev = payload && payload.hook_event_name;
  const field = MATCH_FIELD[ev];
  const out = [];
  for (const [e, arg, matcher] of HOOK_EVENTS) {
    if (e !== ev) continue;
    if (matcher) {
      const v = field ? payload[field] : undefined;
      if (typeof v !== 'string' || !new RegExp(`^(?:${matcher})$`).test(v)) continue;
    }
    out.push(arg);
  }
  return out;
}

export function buildAgentHooksInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'HOOK="$DIR/tmuxifier-agent-hook.sh"',
    'SETTINGS="$DIR/settings.json"',
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'AGENTHOOKS: skipped-no-claude'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the hook script from stdin.',
    'mkdir -p "$DIR"',
    'cat > "$HOOK"',
    'chmod 755 "$HOOK"',
    '',
    '# 3. The entries to merge. Quoted heredoc: ${...} stays literal.',
    "NEW=$(cat <<'TMUXIFIER_HOOKS_EOF'",
    HOOKS_JSON,
    'TMUXIFIER_HOOKS_EOF',
    ')',
    '',
    '# 4. Merge into settings.json: remove-then-append per event, atomically.',
    'if [ ! -f "$SETTINGS" ]; then',
    '  printf \'{"hooks":%s}\\n\' "$NEW" > "$SETTINGS"',
    '  chmod 600 "$SETTINGS"',
    "  echo 'AGENTHOOKS: applied'",
    '  exit 0',
    'fi',
    'TMP="$SETTINGS.tmuxifier.tmp"',
    'if command -v jq >/dev/null 2>&1; then',
    '  jq --argjson new "$NEW" \'.hooks = (.hooks // {}) | reduce ($new | keys_unsorted[]) as $ev (.; .hooks[$ev] = ([(.hooks[$ev] // [])[] | select((tojson | contains("tmuxifier-agent-hook")) | not)] + $new[$ev]))\' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"',
    'elif command -v node >/dev/null 2>&1; then',
    '  node -e \'const fs=require("fs");const p=process.argv[1];const add=JSON.parse(process.argv[2]);const d=JSON.parse(fs.readFileSync(p,"utf8"));d.hooks=(d.hooks&&typeof d.hooks==="object"&&!Array.isArray(d.hooks))?d.hooks:{};for(const ev of Object.keys(add)){const cur=Array.isArray(d.hooks[ev])?d.hooks[ev]:[];d.hooks[ev]=cur.filter((e)=>!JSON.stringify(e).includes("tmuxifier-agent-hook")).concat(add[ev]);}const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p)\' "$SETTINGS" "$NEW"',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 -c \'import json,sys,os',
    'p=sys.argv[1];add=json.loads(sys.argv[2]);d=json.load(open(p))',
    'h=d.get("hooks") if isinstance(d.get("hooks"),dict) else {}',
    'd["hooks"]=h',
    'for ev,entries in add.items():',
    '    cur=h.get(ev) if isinstance(h.get(ev),list) else []',
    '    h[ev]=[e for e in cur if "tmuxifier-agent-hook" not in json.dumps(e)]+entries',
    't=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p)\' "$SETTINGS" "$NEW"',
    'else',
    "  echo 'AGENTHOOKS: error-no-json-tool'",
    '  exit 4',
    'fi',
    "echo 'AGENTHOOKS: applied'",
  ].join('\n');
}

export function createAgentHooksPusher({ runStdin, readAsset }) {
  return {
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'agent-hooks', ok: false, error: 'agent hook asset unavailable' }; }
      const res = await runStdin(box, buildAgentHooksInstallScript(), bytes);
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/AGENTHOOKS:\s*skipped-no-claude/.test(out)) return { target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' };
        if (/AGENTHOOKS:\s*applied/.test(out)) return { target: 'agent-hooks', ok: true };
      }
      return { target: 'agent-hooks', ok: false, error: 'agent hooks push failed' };
    },
  };
}
