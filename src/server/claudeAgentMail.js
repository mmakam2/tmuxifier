// Push agent mail to a box (design 6.7, 6.9, 6.10): the `tmx` command, the Claude Code skill
// that teaches an agent to use it, three hook entries and one permission rule in Claude's
// settings.json. Structural twin of claudeAgentHooks.js: a pure remote-installer builder + a
// small DI pusher, run as the `agent-mail` setup phase under the one `claude` tools selection.
//
// The installer script text goes into ssh argv and interpolates only this module's constants;
// the bytes of both files arrive on stdin as `tmx + "\n" + SKILL_SEPARATOR + "\n" + skill`, and
// the split is byte-exact (the "\n" before the separator line belongs to the framing). Both
// files are written to a temp name and renamed into place, so a waiter running the old `tmx`
// is never handed a half-written file.
//
// The skips change nothing on the box: no claude (the agent-hooks installer's test), no curl
// (tmx is curl over a unix socket), or a `~/.local/bin/tmx` that is not exactly our symlink
// (a regular file, a symlink anywhere else, a dangling one, even a relative one to ours; a
// box without `readlink` reads every existing link as foreign).
//
// settings.json is a file the operator owns. One rewrite carries both merges, built in a temp
// file (jq, then node, then python3) and moved into place only when the tool exited 0 and its
// output reads back as exactly one JSON object:
//   - hooks: per event in MAIL_HOOKS, drop every entry whose JSON mentions `tmuxifier-mail`,
//     append ours (the agent-hooks method; its key `tmuxifier-agent-hook` never matches ours,
//     nor ours its, so the two installers leave each other's entries alone in either order);
//   - permissions.allow: exact-string set-add of MAIL_PERMISSION_RULE. `deny`, `ask` and every
//     other key are never read or written.
// A key that is missing is created; one that exists with the wrong type (`allow` a string,
// `hooks` an array, `Stop` an object, `permissions` null, a top level that is not an object) is
// a failed merge that leaves the file untouched. The temp file is a `cp -p` copy, so the
// file's mode survives; a settings.json that did not exist is created 0600. A settings.json
// that is a symlink (a dotfiles checkout) is written through, so the link stays a link.
//
// Large integer literals in settings.json may lose precision under jq < 1.7 or node, as with
// the agent-hooks merge; settings.json holds none in practice.

const waiter = { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-mail/tmx" hook-wait', asyncRewake: true, timeout: 2592000 }] };
const ack = { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-mail/tmx" hook-ack' }] };
export const MAIL_HOOKS = Object.freeze({ SessionStart: [waiter], Stop: [waiter], UserPromptSubmit: [ack] });

// `tmx` with any arguments, and nothing else. Source: Claude Code "Configure permissions",
// https://code.claude.com/docs/en/permissions, read 2026-11-15:
//   - "A `*` at the end, with a space before it, also matches the bare command." and "The
//     space before a trailing `*` is part of the rule. `Bash(ls *)` requires a space after
//     `ls`, so `lsof` doesn't match." So `tmx-anything` and `tmxfoo` are not covered.
//   - "A `*` in a Bash rule matches any text, including spaces", so a quoted message
//     argument is covered.
//   - "a rule like `Bash(safe-cmd *)` won't give it permission to run the command
//     `safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`, `;`, `|`,
//     `|&`, `&`, and newlines. Every subcommand must be allowed".
//   - Redirect targets "with no file behind them aren't checked: ... here-docs and
//     here-strings." Whether a multi-line heredoc body is matched as one command is not
//     stated; the skill therefore teaches the quoted-argument form. Task 13 checks the rule
//     against the real program.
// The space form, not the legacy `:*` suffix: "The permission dialog writes the
// space-separated form".
export const MAIL_PERMISSION_RULE = 'Bash(tmx *)';

export const SKILL_SEPARATOR = '#__TMUXIFIER_MAIL_SKILL__';

// The constants are interpolated into single-quoted sh words and a quoted heredoc; pin that
// they can never break out of either.
for (const c of [MAIL_PERMISSION_RULE, SKILL_SEPARATOR]) {
  if (!/^[A-Za-z0-9_#()* ]+$/.test(c)) throw new Error('agent mail constant outside its alphabet');
}
const HOOKS_JSON = JSON.stringify(MAIL_HOOKS);
if (HOOKS_JSON.includes('\n') || HOOKS_JSON.includes("'")) throw new Error('agent mail hooks JSON not heredoc-safe');

// jq: --slurp so empty input or two concatenated values fail instead of passing through.
const JQ_MERGE = [
  'if length != 1 or (.[0] | type) != "object" then error("settings") else .[0] end',
  '| if has("hooks") and (.hooks | type) != "object" then error("hooks") else . end',
  '| if has("permissions") and (.permissions | type) != "object" then error("permissions") else . end',
  '| if has("permissions") and (.permissions | has("allow")) and (.permissions.allow | type) != "array" then error("allow") else . end',
  '| .hooks = (if has("hooks") then .hooks else {} end)',
  '| reduce ($new | keys_unsorted[]) as $ev (.;',
  '    if (.hooks | has($ev)) and (.hooks[$ev] | type) != "array" then error("event") else . end',
  '    | .hooks[$ev] = ([(.hooks[$ev] // [])[] | select((tojson | contains("tmuxifier-mail")) | not)] + $new[$ev]))',
  '| .permissions = (if has("permissions") then .permissions else {} end)',
  '| .permissions.allow = (if (.permissions | has("allow")) then .permissions.allow else [] end)',
  '| if any(.permissions.allow[]; . == $rule) then . else .permissions.allow += [$rule] end',
].join(' ');
const JQ_CHECK = 'if length == 1 and (.[0] | type) == "object" then . else error("output") end';

const NODE_MERGE = [
  'const fs=require("fs");',
  'const isObj=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v);',
  'const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);',
  'const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const add=JSON.parse(process.argv[2]);const rule=process.argv[3];',
  'if(!isObj(d))throw new Error("settings");',
  'if(has(d,"hooks")&&!isObj(d.hooks))throw new Error("hooks");',
  'if(has(d,"permissions")&&!isObj(d.permissions))throw new Error("permissions");',
  'if(has(d,"permissions")&&has(d.permissions,"allow")&&!Array.isArray(d.permissions.allow))throw new Error("allow");',
  'if(!has(d,"hooks"))d.hooks={};',
  'for(const ev of Object.keys(add)){if(has(d.hooks,ev)&&!Array.isArray(d.hooks[ev]))throw new Error("event");',
  'const cur=has(d.hooks,ev)?d.hooks[ev]:[];d.hooks[ev]=cur.filter((e)=>!JSON.stringify(e).includes("tmuxifier-mail")).concat(add[ev]);}',
  'if(!has(d,"permissions"))d.permissions={};',
  'if(!has(d.permissions,"allow"))d.permissions.allow=[];',
  'if(!d.permissions.allow.includes(rule))d.permissions.allow.push(rule);',
  'process.stdout.write(JSON.stringify(d,null,2)+"\\n");',
].join('');
const NODE_CHECK = 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(d===null||typeof d!=="object"||Array.isArray(d))process.exit(1)';

// Read and written as UTF-8 bytes, so a C-locale box neither fails on nor escapes non-ASCII.
const PY_MERGE = [
  'import json,sys',
  'd=json.loads(open(sys.argv[1],"rb").read().decode("utf-8"));add=json.loads(sys.argv[2]);rule=sys.argv[3]',
  'if not isinstance(d,dict): sys.exit("settings")',
  'if "hooks" in d and not isinstance(d["hooks"],dict): sys.exit("hooks")',
  'if "permissions" in d and not isinstance(d["permissions"],dict): sys.exit("permissions")',
  'if "permissions" in d and "allow" in d["permissions"] and not isinstance(d["permissions"]["allow"],list): sys.exit("allow")',
  'h=d.setdefault("hooks",{})',
  'for ev,entries in add.items():',
  '    if ev in h and not isinstance(h[ev],list): sys.exit("event")',
  '    h[ev]=[e for e in h.get(ev,[]) if "tmuxifier-mail" not in json.dumps(e)]+entries',
  'allow=d.setdefault("permissions",{}).setdefault("allow",[])',
  'if rule not in allow: allow.append(rule)',
  'sys.stdout.buffer.write((json.dumps(d,indent=2,ensure_ascii=False)+"\\n").encode("utf-8"))',
].join('\n');
const PY_CHECK = 'import json,sys\nd=json.loads(open(sys.argv[1],"rb").read().decode("utf-8"))\nsys.exit(0 if isinstance(d,dict) else 1)';

const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export function buildAgentMailInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'MAIL="$HOME/.tmuxifier-mail"',
    'LINK="$HOME/.local/bin/tmx"',
    'SKILLDIR="$DIR/skills/tmuxifier-mail"',
    'SETTINGS="$DIR/settings.json"',
    `SEP=${sq(SKILL_SEPARATOR)}`,
    `RULE=${sq(MAIL_PERMISSION_RULE)}`,
    '',
    '# 1. Skips. Each drains stdin and changes nothing on the box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'AGENTMAIL: skipped-no-claude'",
    '  exit 0',
    'fi',
    'if ! command -v curl >/dev/null 2>&1; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'AGENTMAIL: skipped-no-curl'",
    '  exit 0',
    'fi',
    'if [ -e "$LINK" ] || [ -L "$LINK" ]; then',
    '  if [ ! -L "$LINK" ] || [ "$(readlink "$LINK" 2>/dev/null)" != "$MAIL/tmx" ]; then',
    '    cat >/dev/null 2>&1 || true',
    "    echo 'AGENTMAIL: skipped-foreign-tmx'",
    '    exit 0',
    '  fi',
    'fi',
    '',
    '# 2. Split stdin into tmx and the skill, byte-exact; each lands by rename.',
    'mkdir -p "$MAIL"',
    'chmod 700 "$MAIL"',
    'IN="$MAIL/install.$$.tmp"',
    'TMP="$SETTINGS.tmuxifier-mail.$$.tmp"',
    'trap \'rm -f "$IN" "$IN.a" "$MAIL/tmx.$$.tmp" "$SKILLDIR/SKILL.md.$$.tmp" "$TMP"\' EXIT',
    'cat > "$IN"',
    'if ! grep -qx "$SEP" "$IN"; then',
    "  echo 'AGENTMAIL: error-bad-input'",
    '  exit 5',
    'fi',
    '# Lines before the separator; the last newline is the framing\'s, not the file\'s.',
    'sed -n "/^$SEP\\$/q;p" "$IN" > "$IN.a"',
    'N=$(wc -c < "$IN.a")',
    'head -c $((N - 1)) "$IN.a" > "$MAIL/tmx.$$.tmp"',
    'chmod 755 "$MAIL/tmx.$$.tmp"',
    'mv -f "$MAIL/tmx.$$.tmp" "$MAIL/tmx"',
    'mkdir -p "$SKILLDIR"',
    'sed "1,/^$SEP\\$/d" "$IN" > "$SKILLDIR/SKILL.md.$$.tmp"',
    'chmod 644 "$SKILLDIR/SKILL.md.$$.tmp"',
    'mv -f "$SKILLDIR/SKILL.md.$$.tmp" "$SKILLDIR/SKILL.md"',
    'mkdir -p "$HOME/.local/bin"',
    '[ -L "$LINK" ] || ln -s "$MAIL/tmx" "$LINK"',
    '',
    '# 3. The hook entries to merge. Quoted heredoc: $HOME stays literal.',
    "NEW=$(cat <<'TMUXIFIER_MAIL_HOOKS_EOF'",
    HOOKS_JSON,
    'TMUXIFIER_MAIL_HOOKS_EOF',
    ')',
    '',
    '# 4. One settings.json rewrite: built in a copy (mode kept), moved in only when good.',
    'if command -v jq >/dev/null 2>&1; then TOOL=jq',
    'elif command -v node >/dev/null 2>&1; then TOOL=node',
    'elif command -v python3 >/dev/null 2>&1; then TOOL=python3',
    'else',
    "  echo 'AGENTMAIL: error-no-json-tool'",
    '  exit 4',
    'fi',
    'mkdir -p "$DIR"',
    'rm -f "$TMP"',
    'if [ -e "$SETTINGS" ] || [ -L "$SETTINGS" ]; then',
    '  SRC="$SETTINGS"',
    '  if [ ! -f "$SETTINGS" ] || ! cp -p "$SETTINGS" "$TMP"; then',
    "    echo 'AGENTMAIL: error-settings-merge'",
    '    exit 5',
    '  fi',
    'else',
    '  SRC="$IN.a"',
    "  printf '{}' > \"$SRC\"",
    '  (umask 077 && : > "$TMP")',
    'fi',
    'OK=',
    'case $TOOL in',
    `  jq) jq -s --argjson new "$NEW" --arg rule "$RULE" ${sq(JQ_MERGE)} "$SRC" > "$TMP" 2>/dev/null && jq -s -e ${sq(JQ_CHECK)} "$TMP" >/dev/null 2>&1 && OK=1 ;;`,
    `  node) node -e ${sq(NODE_MERGE)} "$SRC" "$NEW" "$RULE" > "$TMP" 2>/dev/null && node -e ${sq(NODE_CHECK)} "$TMP" >/dev/null 2>&1 && OK=1 ;;`,
    `  python3) python3 -c ${sq(PY_MERGE)} "$SRC" "$NEW" "$RULE" > "$TMP" 2>/dev/null && python3 -c ${sq(PY_CHECK)} "$TMP" >/dev/null 2>&1 && OK=1 ;;`,
    'esac',
    'if [ -z "$OK" ]; then',
    "  echo 'AGENTMAIL: error-settings-merge'",
    '  exit 5',
    'fi',
    'if [ -L "$SETTINGS" ]; then',
    '  cat "$TMP" > "$SETTINGS"',
    'else',
    '  mv -f "$TMP" "$SETTINGS"',
    'fi',
    "echo 'AGENTMAIL: applied'",
  ].join('\n');
}

const SKIPS = [
  [/AGENTMAIL:\s*skipped-no-claude/, 'no Claude on the box'],
  [/AGENTMAIL:\s*skipped-no-curl/, 'no curl on the box'],
  [/AGENTMAIL:\s*skipped-foreign-tmx/, 'another tmx is in ~/.local/bin'],
];
const ERRORS = [
  [/AGENTMAIL:\s*error-no-json-tool/, 'no jq, node or python3 on the box'],
  [/AGENTMAIL:\s*error-settings-merge/, 'settings.json could not be merged'],
];

export function createAgentMailPusher({ runStdin, readAssets }) {
  const failed = { target: 'agent-mail', ok: false, error: 'agent mail push failed' };
  return {
    // Never throws: every outcome is a result the setup job records.
    async push(box) {
      let input;
      try {
        const { script, skill } = await readAssets();
        if (!Buffer.isBuffer(script) || !Buffer.isBuffer(skill)) throw new Error('asset missing');
        input = Buffer.concat([script, Buffer.from(`\n${SKILL_SEPARATOR}\n`), skill]);
      } catch { return { target: 'agent-mail', ok: false, error: 'agent mail asset unavailable' }; }
      let res;
      try { res = await runStdin(box, buildAgentMailInstallScript(), input); } catch { return { ...failed }; }
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        for (const [re, skipped] of SKIPS) if (re.test(out)) return { target: 'agent-mail', ok: false, skipped };
        if (/AGENTMAIL:\s*applied/.test(out)) return { target: 'agent-mail', ok: true };
      } else if (res) {
        for (const [re, error] of ERRORS) if (re.test(out)) return { target: 'agent-mail', ok: false, error };
      }
      return { ...failed };
    },
  };
}
