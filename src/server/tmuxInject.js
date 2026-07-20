import { execFile } from 'node:child_process';
import { sanitizeSession, shSingleQuote } from './sshCommand.js';

// Pane-aware injection of an uploaded file's path into a tmux session
// (spec: docs/superpowers/specs/2026-07-13-claude-aware-tmux-injection-design.md).
// The classifier decides whether typing into the pane is safe; the builders
// produce the sh commands that run on the box (or locally for __local__).
// Classification runs here in Node — not remote grep — so it's a pure,
// fixture-testable function.

// Strong Claude Code TUI markers. Any one suffices; checked before the shell
// rule because Claude's own input row would also match a trailing '>'.
const CLAUDE_MARKERS = [
  /^[^\S\n]*│[^\S\n]*[>›](?:\s|$)/m, // the bordered prompt-box input row (confined to one line)
  /esc to interrupt/i,     // working/spinner footer
  /\? for shortcuts/i,     // idle footer hint
  /accept edits/i,         // permission-mode footer
  /bypass permissions/i,
  /plan mode/i,
];

// A pane whose last non-empty line (trailing padding trimmed — tmux capture
// output may pad lines to the pane width) ends in a prompt character is a
// shell. '%' (zsh) counts only when preceded by a non-digit, so progress
// lines ("Downloading 45%") stay busy. Bare '>' is NOT a prompt marker:
// Python's '>>>', dialog button rows ('< Cancel >'), and Claude's own input
// row all end in '>' — a missed prompt fails safe (status message), a
// mis-typed busy pane does not. Anything unrecognized is 'busy'.
export function classifyPane(text) {
  const t = String(text || '');
  if (!t.trim()) return 'busy';
  if (CLAUDE_MARKERS.some((re) => re.test(t))) return 'claude';
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = (lines[lines.length - 1] || '').trimEnd();
  if (/[$#❯]$/.test(last)) return 'shell';
  if (/[^\d\s]%$/.test(last)) return 'shell';
  return 'busy';
}

// Shells whose idle foreground process means "pane is at a prompt". A shell
// running a command shows that command instead, so this is precise — and it
// is immune to prompt themes (zsh RPROMPT right-pads text after the prompt
// char, defeating the screen regex; the command name doesn't lie). Note: a
// running `#!/bin/bash` script also reports `bash` here — a long-running
// script's stdin can then receive the typed path, bounded by the no-Enter
// design (the path lands, nothing executes it).
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ash', 'ksh', 'tcsh', 'csh']);

// Split buildPaneStateRemote's output back into { command, screen }.
export function parsePaneState(raw) {
  const s = String(raw || '');
  const nl = s.indexOf('\n');
  const command = (nl === -1 ? s : s.slice(0, nl)).trim();
  const screen = nl === -1 ? '' : s.slice(nl + 1);
  return { command, screen };
}

// Commands that may host a Claude Code TUI: its process name is normally
// 'claude', but wrappers and dev installs run under a JS runtime.
const JS_RUNTIMES = new Set(['node', 'bun', 'deno']);

// Command-first classification. The screen heuristics (classifyPane) apply
// only when the command doesn't already identify the pane: any OTHER named
// command (vim, less, make, …) is never typed into on the strength of
// screen contents alone — a vim buffer displaying Claude-marker text must
// classify busy, not claude.
export function classifyPaneState({ command, screen } = {}) {
  const cmd = String(command || '').trim().toLowerCase();
  if (cmd === 'claude' || cmd.startsWith('claude-')) return 'claude';
  if (SHELL_COMMANDS.has(cmd)) return 'shell';
  if (cmd === '' || JS_RUNTIMES.has(cmd)) return classifyPane(screen);
  return 'busy';
}

// '=' forces exact session-name match — without it tmux -t prefix-matches,
// so a vanished session could silently retarget a prefix-sibling. The
// trailing ':' is required: tmux's exact-match rule applies per target
// component, and a bare '=name' (no ':') is parsed as a pane/window token,
// not a session, and never matches (verified on tmux 3.5a: `-t '=web'` fails
// with "can't find pane: =web" even when session 'web' exists; `-t '=web:'`
// finds it). The empty window/pane after ':' still resolves to the
// session's current window/pane, same as an unqualified target.
function sess(session) {
  return shSingleQuote('=' + sanitizeSession(session) + ':');
}

// One round-trip pane state: line 1 is the pane's foreground command
// (#{pane_current_command} — 'zsh' at a prompt, 'vim'/'make'/… while busy,
// 'claude' inside Claude Code), the rest is the full visible screen. No
// `tail`: capture keeps the whole pane, so a fresh pane's top-aligned prompt
// isn't discarded with the blank bottom rows. Missing session: display's
// `|| echo` keeps line 1 present and capture-pane's failure makes the script
// exit non-zero, which the caller maps to 'busy'.
export function buildPaneStateRemote(session) {
  const q = sess(session);
  return [
    `tmux display-message -p -t ${q} '#{pane_current_command}' 2>/dev/null || echo`,
    `tmux capture-pane -p -t ${q} 2>/dev/null`,
  ].join('\n');
}

// -l = literal (no key-name lookup); -- guards a text starting with '-'.
export function buildSendKeysRemote(session, text) {
  return `tmux send-keys -t ${sess(session)} -l -- ${shSingleQuote(text)}`;
}

export function buildDisplayMessageRemote(session, msg) {
  return `tmux display-message -t ${sess(session)} ${shSingleQuote(msg)}`;
}

// What gets typed: the absolute path, always single-quoted (embedded quotes
// sh-escaped) plus a trailing space — the drag-drop convention CLIs parse.
export function injectionText(path) {
  return shSingleQuote(String(path)) + ' ';
}

// Orchestration: capture → classify → type or message. runScript executes one
// sh command on the target (over ssh for a box, /bin/sh for __local__) and
// resolves {code, stdout, stderr}. Never throws — the caller's work (an upload,
// a transcription) already succeeded, so injection failures degrade to a status
// message and a mode the client can surface.
//
// `text` is typed literally via send-keys -l and is never followed by Enter:
// the operator reviews before submitting. `label` names the thing in the
// default tmux status messages ('image', 'dictation'); okMsg/busyMsg override
// those entirely, which is how the upload wrapper below keeps its original
// wording without a second copy of this body.
export async function injectTextVia(runScript, session, text, { label = 'text', okMsg, busyMsg } = {}) {
  const body = String(text ?? '');
  // Nothing to type is not a failure — and must not produce a bare send-keys.
  if (!body.trim()) return { injected: false, mode: 'empty' };
  const onOk = okMsg || (() => `[tmuxifier] ${label} inserted`);
  const onBusy = busyMsg || (() => `[tmuxifier] ${label} ready (pane busy — not typed)`);
  const say = async (msg) => { try { await runScript(buildDisplayMessageRemote(session, msg)); } catch {} };
  let mode = 'busy';
  try {
    const cap = await runScript(buildPaneStateRemote(session));
    mode = cap && cap.code === 0 ? classifyPaneState(parsePaneState(cap.stdout)) : 'busy';
    if (mode === 'claude' || mode === 'shell') {
      const sent = await runScript(buildSendKeysRemote(session, body));
      if (!sent || sent.code !== 0) throw new Error('send-keys failed');
      await say(onOk());
      return { injected: true, mode };
    }
    await say(onBusy());
    return { injected: false, mode: 'busy' };
  } catch {
    await say(onBusy());
    return { injected: false, mode: 'error' };
  }
}

// Upload-specific wrapper. It quotes the path and supplies the original tmux
// status wording, so the upload flow's observable behaviour is unchanged —
// while the capture/classify/send-keys body exists exactly once, above.
export function injectVia(runScript, session, remotePath) {
  const name = String(remotePath).split('/').pop() || String(remotePath);
  return injectTextVia(runScript, session, injectionText(remotePath), {
    okMsg: () => `[tmuxifier] image pasted: ${name}`,
    busyMsg: () => `[tmuxifier] image uploaded: ${remotePath} (pane busy — not typed)`,
  });
}

function runLocalScript(script, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

// The __local__ terminal runs inside a real local tmux session (sessions.openLocal),
// so the same flow works with a /bin/sh runner on the Tmuxifier host.
export function injectLocalUploadPath(session, path, { run = runLocalScript } = {}) {
  return injectVia(run, session, path);
}
