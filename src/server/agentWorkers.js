// Agent workers: the remote script that starts an interactive agent on a box in its own
// detached tmux session, and the parser for its one result line (design section 5.2).
//
// The script runs over ssh under the box's LOGIN shell (sh, bash or zsh, bare PATH) and ends
// every run with one `WORKER: <code>` line and exit 0, in this order:
//
//   tmux resolved (command -v, then the fallback sweep)   else  WORKER: no-tmux
//   [ -d '<dir>' ]                                        else  WORKER: no-dir
//   the agent is installed (on PATH or ~/.local/bin)      else  WORKER: no-agent-binary
//   only with `trust: true`, the folder-trust write       then  WORKER-TRUST: <code>
//   no session named exactly '=<session>'                 else  WORKER: exists
//   new-session ... (the launch line below)               then  WORKER: started
//
// `set -eu`: a tmux failure on the launch exits non-zero with no `WORKER:` line, so the caller
// never reads a failed launch as `started`.
//
// The launch line (spike of 2026-11-19, design section 4; Claude Code 2.1.328, tmux 3.6):
//
//   | How the session is created                                         | Result                |
//   |--------------------------------------------------------------------|-----------------------|
//   | new-session -d -s <name> -c <dir> 'claude'                         | Fails                 |
//   | new-session -d -s <name> -c <dir>, then send-keys `claude`         | Works, leaves a shell |
//   | new-session -d -s <name> -c <dir> "exec <shell> -ic 'exec claude'" | Works, zsh and bash   |
//   | the same with -lic                                                 | Works                 |
//
// The plain command fails because tmux runs it with `default-shell -c`, a non-interactive
// shell that reads no rc file: the rc lines setup wrote are what put ~/.local/bin on PATH and
// export the Claude token, so `claude` is not found (and would have no token), and the session
// ends at once with no trace. `exec "$SHELL" -ic 'exec claude'` makes the pane an interactive
// shell that reads its rc files and then becomes the agent, so `pane_current_command` is the
// agent and `/exit` ends the session instead of leaving a shell behind. `"$SHELL"` is single-
// quoted in this script, so it is expanded inside tmux, where tmux sets SHELL to its own
// default-shell for the command it runs: the pane's shell is the one an operator's own panes
// get, whatever the login shell running this script is
// (test/agentWorkerScript.integration.test.js pins every pairing of sh/bash/zsh script shell
// and bash/zsh default-shell).
//
// The folder-trust write (design section 5.5; key measured in section 4): Claude Code stops a
// new session in a directory it has not seen at its trust dialog, default "No, exit", with no
// hook and no marker. `projects["<dir>"].hasTrustDialogAccepted = true` in ~/.claude.json
// skips it. That key is not a documented contract; when it stops working the worker stops at
// the dialog and the stuck report covers it, so nothing here fails the start. It prints one of
// WORKER_TRUST_CODES and the script goes on to launch whatever it printed:
//   - no-json-tool: none of jq, node, python3 (that order) is on PATH; nothing is read.
//   - already: the key is already literally `true`. Nothing is written: running Claude Code
//     sessions rewrite ~/.claude.json, so a rewrite we do not need could only lose theirs.
//   - written: the key set, every other key and value kept, in a temp file beside the file
//     and moved in only when the tool exited 0 and the temp reads back with the key true. The
//     temp is a `cp -p` copy, so the file's mode survives. A file that did not exist is created
//     0600 holding only the key, put in place with `ln` so a file Claude Code created in the
//     meantime is never replaced.
//   - failed: anything else, the file untouched. Unparseable JSON (or two values), a top level,
//     `projects` or `projects["<dir>"]` that is present and not an object, a ~/.claude.json that
//     is a symlink (a rename would replace the link with a file) or not a regular file, a tool
//     or file error.
// The directory reaches each tool as one single-quoted argument, never inside program text;
// the programs are constants. Large integer literals may lose precision under jq < 1.7 or node
// (~/.claude.json holds timestamps in ms, well inside 2^53).
//
// Everything interpolated is checked here, immediately before it is single-quoted: the session
// against SESSION_NAME_RE (validated, never rewritten: no sanitizeSession), the directory
// against isWorkerDir (a stored record is a file, not proof), and the launch word comes from
// the closed WORKER_AGENTS table by an own-key lookup. Nothing a lead sent is in the script.

import { SESSION_NAME_RE, shSingleQuote } from './sshCommand.js';
import { WORKER_AGENTS, isWorkerDir } from './agentWorkerRules.js';

export const WORKER_CODES = Object.freeze(['started', 'exists', 'no-tmux', 'no-dir', 'no-agent-binary']);
export const WORKER_TRUST_CODES = Object.freeze(['written', 'already', 'failed', 'no-json-tool']);

// The launch word is a table constant, re-checked anyway: it reaches the script unquoted
// inside `command -v`, the ~/.local/bin test and the launch line.
const LAUNCH_WORD_RE = /^[a-z][a-z0-9-]{0,31}$/;

const RESULT_LINE_RE = /^WORKER: ([a-z-]+)$/;
const TRUST_LINE_RE = /^WORKER-TRUST: ([a-z-]+)$/;

// The trust programs. Each takes a mode (`check` or `set`), the directory and a file path as
// arguments. `check` exits 0 only when the file is one JSON object whose
// projects[dir].hasTrustDialogAccepted is literally true. `set` prints the file with that key
// set, or exits non-zero on a shape it must not touch.
// jq: --slurp so empty input or two concatenated values fail instead of passing through; -e
// so `check`'s false exits 1.
const JQ_TRUST = [
  'if length != 1 or (.[0] | type) != "object" then error("top") else .[0] end',
  '| if $m == "check" then',
  '    (.projects | type) == "object" and (.projects[$d] | type) == "object"',
  '    and .projects[$d].hasTrustDialogAccepted == true',
  '  else',
  '    if has("projects") and (.projects | type) != "object" then error("projects") else . end',
  '    | if ((.projects // {}) | has($d)) and (.projects[$d] | type) != "object" then error("project") else . end',
  '    | .projects[$d].hasTrustDialogAccepted = true',
  '  end',
].join(' ');

const NODE_TRUST = [
  'const fs=require("fs");const m=process.argv[1],k=process.argv[2];',
  'const isObj=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v);',
  'const has=(o,x)=>Object.prototype.hasOwnProperty.call(o,x);',
  'const d=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));',
  'if(!isObj(d))process.exit(2);',
  'if(m==="check"){const p=has(d,"projects")?d.projects:null;',
  'process.exit(isObj(p)&&has(p,k)&&isObj(p[k])&&p[k].hasTrustDialogAccepted===true?0:1);}',
  'if(has(d,"projects")&&!isObj(d.projects))process.exit(2);',
  'if(!has(d,"projects"))d.projects={};',
  'if(has(d.projects,k)&&!isObj(d.projects[k]))process.exit(2);',
  'if(!has(d.projects,k))d.projects[k]={};',
  'd.projects[k].hasTrustDialogAccepted=true;',
  'process.stdout.write(JSON.stringify(d,null,2)+"\\n");',
].join('');

// Read and written as UTF-8 bytes, so a C-locale box neither fails on nor escapes non-ASCII.
const PY_TRUST = [
  'import json,sys',
  'm,k=sys.argv[1],sys.argv[2]',
  'd=json.loads(open(sys.argv[3],"rb").read().decode("utf-8"))',
  'if not isinstance(d,dict): sys.exit(2)',
  'p=d.get("projects")',
  'if m=="check": sys.exit(0 if isinstance(p,dict) and isinstance(p.get(k),dict) and p[k].get("hasTrustDialogAccepted") is True else 1)',
  'if "projects" in d and not isinstance(p,dict): sys.exit(2)',
  'p=d.setdefault("projects",{})',
  'if k in p and not isinstance(p[k],dict): sys.exit(2)',
  'p.setdefault(k,{})["hasTrustDialogAccepted"]=True',
  'sys.stdout.buffer.write((json.dumps(d,indent=2,ensure_ascii=False)+"\\n").encode("utf-8"))',
].join('\n');

// The trust block (see the header). `qdir` is the already single-quoted directory. Every
// command that can fail sits in a condition or a non-final `&&` element, so `set -e` never
// ends the script here.
function trustBlock(qdir) {
  const sq = shSingleQuote;
  return [
    'if command -v jq >/dev/null 2>&1; then TRUST_TOOL=jq',
    'elif command -v node >/dev/null 2>&1; then TRUST_TOOL=node',
    'elif command -v python3 >/dev/null 2>&1; then TRUST_TOOL=python3',
    'else TRUST_TOOL=; fi',
    'trust_json() {',
    '  case $TRUST_TOOL in',
    `    jq) jq -s -e --arg m "$1" --arg d ${qdir} ${sq(JQ_TRUST)} "$2" ;;`,
    `    node) node -e ${sq(NODE_TRUST)} "$1" ${qdir} "$2" ;;`,
    `    python3) python3 -c ${sq(PY_TRUST)} "$1" ${qdir} "$2" ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    'TRUST_F="$HOME/.claude.json"',
    'TRUST_T="$HOME/.claude.json.tmuxifier-trust.$$"',
    'TRUST=failed',
    'if [ -z "$TRUST_TOOL" ]; then TRUST=no-json-tool',
    // A link is never replaced by a file; neither is anything else that is not a regular file.
    'elif [ -L "$TRUST_F" ]; then :',
    'elif [ -f "$TRUST_F" ]; then',
    '  if trust_json check "$TRUST_F" >/dev/null 2>&1; then TRUST=already',
    '  elif rm -f "$TRUST_T" && cp -p "$TRUST_F" "$TRUST_T" 2>/dev/null \\',
    '      && trust_json set "$TRUST_F" > "$TRUST_T" 2>/dev/null \\',
    '      && trust_json check "$TRUST_T" >/dev/null 2>&1 \\',
    '      && mv -f "$TRUST_T" "$TRUST_F" 2>/dev/null; then TRUST=written',
    '  fi',
    'elif [ ! -e "$TRUST_F" ]; then',
    `  if ( umask 077 && rm -f "$TRUST_T" "$TRUST_T.src" && printf '{}' > "$TRUST_T.src" \\`,
    '      && trust_json set "$TRUST_T.src" > "$TRUST_T" ) 2>/dev/null \\',
    '      && trust_json check "$TRUST_T" >/dev/null 2>&1 \\',
    '      && ln "$TRUST_T" "$TRUST_F" 2>/dev/null; then TRUST=written',
    '  fi',
    'fi',
    'rm -f "$TRUST_T" "$TRUST_T.src"',
    'echo "WORKER-TRUST: $TRUST"',
  ];
}

export function buildWorkerStartRemote({ session, dir, agent = 'claude', trust = false } = {}) {
  if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) throw new Error('bad worker session name');
  if (!isWorkerDir(dir)) throw new Error('bad worker directory');
  if (typeof agent !== 'string' || !Object.hasOwn(WORKER_AGENTS, agent)) throw new Error('unknown worker agent');
  const word = WORKER_AGENTS[agent].launch;
  if (typeof word !== 'string' || !LAUNCH_WORD_RE.test(word)) throw new Error('bad worker launch word');

  const sess = shSingleQuote(session);
  const exact = shSingleQuote(`=${session}`);
  const qdir = shSingleQuote(dir);
  const launch = shSingleQuote(`exec "$SHELL" -ic 'exec ${word}'`);
  return [
    'set -eu',
    // Same resolution as buildEnsureSessionRemote: the login shell's PATH is not an
    // interactive shell's.
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    "if [ -z \"$TMUX_BIN\" ]; then echo 'WORKER: no-tmux'; exit 0; fi",
    `if [ ! -d ${qdir} ]; then echo 'WORKER: no-dir'; exit 0; fi`,
    // The same presence test as the hook installer.
    `if ! command -v ${word} >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/${word}" ]; then echo 'WORKER: no-agent-binary'; exit 0; fi`,
    ...(trust === true ? trustBlock(qdir) : []),
    // Exact target: a bare name prefix-matches (`worker-api-1` would hit `worker-api-10`).
    `if "$TMUX_BIN" has-session -t ${exact} 2>/dev/null; then echo 'WORKER: exists'; exit 0; fi`,
    `"$TMUX_BIN" new-session -d -s ${sess} -c ${qdir} ${launch}`,
    "echo 'WORKER: started'",
  ].join('\n');
}

function lastCode(stdout, re, codes) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m && codes.includes(m[1])) return m[1];
  }
  return null;
}

// The code of the last line that is exactly `WORKER: <code>` with a known code; else null.
// The script's output is box output: nothing is trimmed into a match.
export function parseWorkerResult(stdout) {
  return lastCode(stdout, RESULT_LINE_RE, WORKER_CODES);
}

// The same rule for the trust line: `written`, `already`, `failed`, `no-json-tool`, or null
// (trust was off, or the script ended before the block).
export function parseWorkerTrust(stdout) {
  return lastCode(stdout, TRUST_LINE_RE, WORKER_TRUST_CODES);
}
