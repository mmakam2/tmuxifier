import { test, expect } from 'vitest';
import {
  classifyPane,
  classifyPaneState,
  parsePaneState,
  buildPaneStateRemote,
  buildSendKeysRemote,
  buildDisplayMessageRemote,
  injectionText,
  injectVia,
  injectTextVia,
  injectLocalUploadPath,
  buildPaneSnapshotRemote,
  buildSendWheelRemote,
  parsePaneSnapshot,
  NAMED_KEYS,
  buildSendNamedKeyRemote,
  sanitizeSendText,
} from '../src/server/tmuxInject.js';

const CLAUDE_IDLE = [
  '⏺ Done. The tests pass.',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ >                                            │',
  '╰──────────────────────────────────────────────╯',
  '  ? for shortcuts                               ',
].join('\n');

const CLAUDE_WORKING = [
  '⏺ Reading files…',
  '',
  '✻ Cerebrating… (esc to interrupt)',
].join('\n');

// Captured from a real Codex CLI TUI (v0.144/0.147), values replaced with
// placeholders. The load-bearing shape is the persistent status footer —
// '<model> · <cwd>' as the last non-empty line — which is present in every
// state that accepts typed input and absent from the startup trust modal.
const CODEX_IDLE = [
  '╭───────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.147.0)            │',
  '│                                       │',
  '│ model:     gpt-5.6-sol max            │',
  '│ directory: /home/u/project            │',
  '╰───────────────────────────────────────╯',
  '',
  '  Tip: Use /compact when the conversation gets long.',
  '',
  '› Write tests for @filename',
  '',
  '  gpt-5.6-sol max · /home/u/project',
].join('\n');

const CODEX_WORKING = [
  '• Running it now.',
  '',
  '• Working (14s • esc to interrupt) · 1 background terminal running · /ps to view',
  '',
  '› Write tests for @filename',
  '',
  '  gpt-5.6-sol max · /home/u/project',
].join('\n');

// A narrow pane truncates the footer's path with an ellipsis but keeps its shape.
const CODEX_NARROW = [
  '› Summarize recent commits',
  '',
  '  gpt-5.6-sol max · /home/u/very-long-pa…',
].join('\n');

// First run in a directory: a modal awaiting a menu choice, NOT a composer.
// Its selected row also starts with '›', which is exactly why the composer row
// is not the marker — typing a path here would feed keystrokes to the menu.
const CODEX_TRUST = [
  '> You are in /home/u/project',
  '',
  '  Do you trust the contents of this directory?',
  '',
  '› 1. Yes, continue',
  '  2. No, quit',
  '',
  '  Press enter to continue',
].join('\n');

test('classifyPane detects Codex CLI screens', () => {
  expect(classifyPane(CODEX_IDLE)).toBe('codex');
  expect(classifyPane(CODEX_NARROW)).toBe('codex');
});

test('classifyPane detects a working Codex pane as codex, not claude', () => {
  // Codex's working footer says 'esc to interrupt' too, so the shared Claude
  // marker would otherwise claim it. Behaviour is the same (both are typed
  // into) but the reported mode must name the right CLI.
  expect(classifyPane(CODEX_WORKING)).toBe('codex');
});

test("classifyPane leaves Codex's trust modal busy", () => {
  expect(classifyPane(CODEX_TRUST)).toBe('busy');
});

test('classifyPaneState detects Codex behind the npm node shim', () => {
  // The npm install of @openai/codex is a Node script that spawns the native
  // binary as a child, so tmux's #{pane_current_command} reports the process
  // group leader: 'node'. This is the reported bug — an idle Codex pane read
  // as busy and refused the pasted image path.
  expect(classifyPaneState({ command: 'node', screen: CODEX_IDLE })).toBe('codex');
  // A native install (homebrew/cargo, or the platform binary run directly)
  // reports its own name instead.
  expect(classifyPaneState({ command: 'codex', screen: '' })).toBe('codex');
  expect(classifyPaneState({ command: 'codex-x86_64-unknown-linux-musl', screen: '' })).toBe('codex');
  // The command gate still holds: a pager showing a captured Codex screen is
  // never typed into on screen contents alone.
  expect(classifyPaneState({ command: 'less', screen: CODEX_IDLE })).toBe('busy');
});

test('injectVia types the path into a Codex pane', async () => {
  const { run, calls } = fakeRunner(`node\n${CODEX_IDLE}`);
  const res = await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  expect(res).toEqual({ injected: true, mode: 'codex' });
  expect(calls.find((c) => c.startsWith('tmux send-keys')))
    .toContain('/root/.tmuxifier-uploads/1-aa-shot.png');
});

test('classifyPane detects Claude Code screens', () => {
  expect(classifyPane(CLAUDE_IDLE)).toBe('claude');
  expect(classifyPane(CLAUDE_WORKING)).toBe('claude');
  expect(classifyPane('│ › Try "fix the bug"')).toBe('claude');
  expect(classifyPane('⏵⏵ accept edits on (shift+tab to cycle)')).toBe('claude');
  expect(classifyPane('│  >  ')).toBe('claude');
});

test('classifyPane detects shell prompts', () => {
  expect(classifyPane('user@box:~$ ')).toBe('shell');
  expect(classifyPane('build ok\nuser@box:~$')).toBe('shell');
  expect(classifyPane('~/code ❯ ')).toBe('shell');
  expect(classifyPane('root@lxc:/# ')).toBe('shell');
  expect(classifyPane('tycho% ')).toBe('shell');
  // tmux capture output can pad lines to the pane width
  expect(classifyPane('user@box:~$' + ' '.repeat(60))).toBe('shell');
});

test('classifyPane is claude-first when both could match', () => {
  // Claude's input row ends the capture with a border, but a footer hint
  // above must still win over any shell-ish trailing char.
  expect(classifyPane('esc to interrupt\n$ ')).toBe('claude');
});

test('classifyPane returns busy for everything else', () => {
  expect(classifyPane('')).toBe('busy');
  expect(classifyPane('   \n  ')).toBe('busy');
  expect(classifyPane('~\n~\n-- INSERT --')).toBe('busy');          // vim
  expect(classifyPane('Compiling tmuxifier v1.6.0')).toBe('busy'); // running build
  expect(classifyPane('Downloading 45%')).toBe('busy');
  expect(classifyPane('100%')).toBe('busy');
  expect(classifyPane('>>> ')).toBe('busy');                        // Python REPL
  expect(classifyPane('        < Ok >   < Cancel >')).toBe('busy'); // dialog buttons
  expect(classifyPane('│\n> x')).toBe('busy'); // marker must not match across lines
});

test('classifyPaneState is command-first with screen fallback', () => {
  expect(classifyPaneState({ command: 'claude', screen: '' })).toBe('claude');
  // zsh RPROMPT pads text after the prompt char — the screen regex misses it,
  // the command name does not (real case: oh-my-zsh "blinks" theme, RPROMPT='!%!')
  expect(classifyPaneState({ command: 'zsh', screen: 'user@host ~ %          !42!' })).toBe('shell');
  expect(classifyPaneState({ command: 'bash', screen: '' })).toBe('shell'); // fresh pane, prompt not drawn yet
  expect(classifyPaneState({ command: 'node', screen: '│ > \n? for shortcuts' })).toBe('claude');
  expect(classifyPaneState({ command: 'vim', screen: '~\n~\n-- INSERT --' })).toBe('busy');
  expect(classifyPaneState({ command: 'cat', screen: '' })).toBe('busy');
  expect(classifyPaneState({})).toBe('busy');
  // command-gated: a named non-shell command is never typed into on screen
  // contents alone (vim showing Claude-marker text, a pager ending in '$')
  expect(classifyPaneState({ command: 'vim', screen: 'esc to interrupt\n-- INSERT --' })).toBe('busy');
  expect(classifyPaneState({ command: 'less', screen: 'some output $' })).toBe('busy');
});

test('parsePaneState splits command line from screen', () => {
  expect(parsePaneState('zsh\nline1\nline2')).toEqual({ command: 'zsh', screen: 'line1\nline2' });
  expect(parsePaneState('zsh')).toEqual({ command: 'zsh', screen: '' });
  expect(parsePaneState('')).toEqual({ command: '', screen: '' });
});

test('script builders sanitize the session and quote arguments', () => {
  expect(buildPaneStateRemote('web')).toBe(
    "tmux display-message -p -t '=web:' '#{pane_current_command}' 2>/dev/null || echo\n" +
    "tmux capture-pane -p -t '=web:' 2>/dev/null",
  );
  // session goes through sanitizeSession: unsafe chars become '-'
  expect(buildPaneStateRemote('a;b')).toContain("'=a-b:'");
  expect(buildSendKeysRemote('web', "'/root/.tmuxifier-uploads/1-aa-x.png' "))
    .toBe("tmux send-keys -t '=web:' -l -- ''\\''/root/.tmuxifier-uploads/1-aa-x.png'\\'' '");
  expect(buildDisplayMessageRemote('web', '[tmuxifier] image pasted: x.png'))
    .toBe("tmux display-message -t '=web:' '[tmuxifier] image pasted: x.png'");
});

test('injectionText single-quotes with sh escaping and trailing space', () => {
  expect(injectionText('/home/u/.tmuxifier-uploads/1-aa-shot.png'))
    .toBe("'/home/u/.tmuxifier-uploads/1-aa-shot.png' ");
  expect(injectionText("/a/it's.png")).toBe("'/a/it'\\''s.png' ");
});

function fakeRunner(captureOut, { sendCode = 0, failCapture = false } = {}) {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    // The pane-state script is the only one carrying the format string;
    // plain display-message status calls must not match this branch.
    if (script.includes('#{pane_current_command}')) {
      return failCapture ? { code: 1, stdout: '', stderr: 'no session' } : { code: 0, stdout: captureOut, stderr: '' };
    }
    if (script.startsWith('tmux send-keys')) return { code: sendCode, stdout: '', stderr: sendCode ? 'boom' : '' };
    return { code: 0, stdout: '', stderr: '' }; // display-message
  };
  return { run, calls };
}

test('injectVia types the quoted path into a shell pane and reports mode', async () => {
  const { run, calls } = fakeRunner('zsh\nuser@box:~$ ');
  const res = await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  expect(res).toEqual({ injected: true, mode: 'shell' });
  const send = calls.find((c) => c.startsWith('tmux send-keys'));
  expect(send).toContain('/root/.tmuxifier-uploads/1-aa-shot.png');
  const msg = calls.find((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}'));
  expect(msg).toContain('image pasted: 1-aa-shot.png');
});

test('injectVia detects claude mode', async () => {
  const { run } = fakeRunner('node\n│ > \n? for shortcuts');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: true, mode: 'claude' });
});

test('injectVia never types into a busy pane — message only', async () => {
  const { run, calls } = fakeRunner('vim\n~\n~\n-- INSERT --');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(calls.some((c) => c.startsWith('tmux send-keys'))).toBe(false);
  const msg = calls.find((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}'));
  expect(msg).toContain('pane busy');
  expect(msg).toContain('/x/y.png');
});

test('injectVia treats a failed capture as busy', async () => {
  const { run } = fakeRunner('', { failCapture: true });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
});

test('injectVia reports error (and never throws) when send-keys fails', async () => {
  const { run, calls } = fakeRunner('zsh\nuser@box:~$ ', { sendCode: 1 });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
  // degradation: it still tried to surface the path via display-message
  expect(calls.filter((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}')).length).toBe(1);
});

test('injectVia survives a throwing runner', async () => {
  const res = await injectVia(async () => { throw new Error('ssh died'); }, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
});

test('injectLocalUploadPath runs the same flow through the injected runner', async () => {
  const { run, calls } = fakeRunner('zsh\n~/code ❯ ');
  const res = await injectLocalUploadPath('local', '/home/u/.tmuxifier-uploads/1-aa-x.png', { run });
  expect(res).toEqual({ injected: true, mode: 'shell' });
  expect(calls[0]).toContain("-t '=local:'");
});

test('injectTextVia types arbitrary text into a shell pane', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\nuser@host:~$ ' };
    return { code: 0, stdout: '' };
  };
  const res = await injectTextVia(run, 'web', 'refactor the auth middleware', { label: 'dictation' });
  expect(res).toEqual({ injected: true, mode: 'shell' });
  const sendKeys = calls.find((c) => c.includes('send-keys'));
  expect(sendKeys).toContain("'refactor the auth middleware'");
  // No trailing space and no Enter: the upload convention applies to voice too.
  expect(sendKeys).not.toContain('Enter');
});

test('injectTextVia uses the label in its status messages', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'make\n' };
    return { code: 0, stdout: '' };
  };
  const res = await injectTextVia(run, 'web', 'hello', { label: 'dictation' });
  expect(res).toEqual({ injected: false, mode: 'busy' });
  // Excludes the pane-state script: its first line is itself a
  // `tmux display-message -p ...` call (to read #{pane_current_command}),
  // so a plain substring match would pick that up instead of the actual
  // status message — same trap the pre-existing tests above already guard.
  expect(calls.find((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}'))).toContain('dictation');
});

test('injectTextVia never types empty text', async () => {
  const calls = [];
  const run = async (script) => { calls.push(script); return { code: 0, stdout: 'bash\n$ ' }; };
  const res = await injectTextVia(run, 'web', '   ', { label: 'dictation' });
  expect(res).toEqual({ injected: false, mode: 'empty' });
  expect(calls.some((c) => c.includes('send-keys'))).toBe(false);
});

test('injectVia keeps its original upload wording after delegation', async () => {
  // Locks the refactor: injectVia now delegates to injectTextVia, so the
  // upload-specific message text must be asserted explicitly rather than
  // assumed to have survived.
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\n$ ' };
    return { code: 0, stdout: '' };
  };
  await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  // Excludes the pane-state script for the same reason as above: it also
  // contains the substring 'display-message' (the #{pane_current_command}
  // probe), so a bare substring match would find that call instead of the
  // real status message.
  expect(calls.find((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}')))
    .toContain('image pasted: 1-aa-shot.png');

  const busy = [];
  const runBusy = async (script) => {
    busy.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'make\n' };
    return { code: 0, stdout: '' };
  };
  await injectVia(runBusy, 'web', '/x/y.png');
  expect(busy.find((c) => c.startsWith('tmux display-message') && !c.includes('#{pane_current_command}')))
    .toContain('image uploaded: /x/y.png (pane busy — not typed)');
});

test('injectTextVia sh-quotes text containing quotes and semicolons', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\n$ ' };
    return { code: 0, stdout: '' };
  };
  await injectTextVia(run, 'web', "it's fine; rm -rf /", { label: 'dictation' });
  const sendKeys = calls.find((c) => c.includes('send-keys'));
  // shSingleQuote renders an embedded apostrophe as '\'' — the shell never
  // sees an unquoted ; or an unbalanced quote.
  expect(sendKeys).toContain(`'it'\\''s fine; rm -rf /'`);
});

test('buildPaneSnapshotRemote: geometry line with alt/mouse flags, then bounded capture, atomic on failure', () => {
  const s = buildPaneSnapshotRemote('main', { lines: 200 });
  expect(s).toContain("display-message -p -t '=main:' '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{mouse_any_flag} #{mouse_sgr_flag}'");
  expect(s).toContain("capture-pane -e -p -t '=main:' -S -200");
  expect(s).toContain(' && '); // one failure fails the whole script (non-zero exit)
});

test('buildPaneSnapshotRemote clamps lines and quotes the session', () => {
  expect(buildPaneSnapshotRemote('a b', { lines: 999999 })).toContain('-S -2000');
  expect(buildPaneSnapshotRemote('a b', { lines: -5 })).toContain('-S -0');
  expect(buildPaneSnapshotRemote("a'b", {})).toContain("'=a-b:'");
});

test('parsePaneSnapshot splits geometry from content', () => {
  expect(parsePaneSnapshot('80 24 5 23 0 0 0\nline1\nline2\n')).toEqual({
    width: 80, height: 24, cursorX: 5, cursorY: 23, alt: false, mouse: false, content: 'line1\nline2',
  });
  expect(parsePaneSnapshot('80 24 5 23 0 0 0')).toEqual({
    width: 80, height: 24, cursorX: 5, cursorY: 23, alt: false, mouse: false, content: '',
  });
  // A box tmux too old for the mouse/alt format variables expands them to
  // nothing — the pane view must degrade to the old behaviour, not 502.
  expect(parsePaneSnapshot('80 24 5 23\nline1\n')).toEqual({
    width: 80, height: 24, cursorX: 5, cursorY: 23, alt: false, mouse: false, content: 'line1',
  });
  expect(parsePaneSnapshot('garbage\nstuff')).toBe(null);
  expect(parsePaneSnapshot('')).toBe(null);
  expect(parsePaneSnapshot(null)).toBe(null);
});

test('parsePaneSnapshot: alt screen ships only the visible screen — capture history above it is the primary screen (stale shell), not the app', () => {
  // height 2, alt on: 4 content lines = 2 history + 2 screen; keep the last 2.
  expect(parsePaneSnapshot('80 2 0 1 1 1 1\nold-shell-1\nold-shell-2\nscreen-1\nscreen-2\n')).toEqual({
    width: 80, height: 2, cursorX: 0, cursorY: 1, alt: true, mouse: true, content: 'screen-1\nscreen-2',
  });
  // alt off keeps the full scrollback untouched.
  expect(parsePaneSnapshot('80 2 0 1 0 1 1\na\nb\nc\n').content).toBe('a\nb\nc');
  // mouse requires BOTH tracking and SGR encoding — wheel injection is SGR-only.
  expect(parsePaneSnapshot('80 24 0 0 1 1 0\nx\n').mouse).toBe(false);
  expect(parsePaneSnapshot('80 24 0 0 1 0 1\nx\n').mouse).toBe(false);
});

test('buildSendWheelRemote: SGR wheel reports gated on pane mouse mode, session quoted, steps clamped', () => {
  const up = buildSendWheelRemote('main', 'up', 5);
  // Refuses (exit 93) unless the pane has mouse tracking AND SGR encoding on —
  // wheel bytes written to a non-mouse pane would arrive as garbage input.
  expect(up).toContain("'#{mouse_any_flag} #{mouse_sgr_flag} #{pane_width} #{pane_height}'");
  expect(up).toContain('exit 93');
  expect(up).toContain('[<64;'); // SGR wheel-up button code
  expect(up).toContain('-lt 5');
  expect(up).toContain("send-keys -t '=main:' -l --");
  expect(buildSendWheelRemote('main', 'down', 3)).toContain('[<65;'); // wheel-down
  expect(buildSendWheelRemote("a'b", 'up', 3)).toContain("'=a-b:'");
  expect(buildSendWheelRemote('main', 'up', 999)).toContain('-lt 25');
  expect(buildSendWheelRemote('main', 'up', 0)).toContain('-lt 3');
  expect(() => buildSendWheelRemote('main', 'left', 1)).toThrow(/wheel direction/);
  expect(() => buildSendWheelRemote('main', 'up; rm -rf /', 1)).toThrow(/wheel direction/);
});

test('named keys are a closed allowlist', () => {
  expect([...NAMED_KEYS].sort()).toEqual(['BSpace', 'C-c', 'Down', 'Enter', 'Escape', 'Left', 'Right', 'Tab', 'Up']);
  expect(buildSendNamedKeyRemote('main', 'Enter')).toBe("tmux send-keys -t '=main:' Enter");
  expect(() => buildSendNamedKeyRemote('main', 'C-d')).toThrow(/unknown key/);
  expect(() => buildSendNamedKeyRemote('main', 'Enter; rm -rf /')).toThrow(/unknown key/);
});

test('sanitizeSendText: newlines collapse (a newline IS Enter), controls stripped', () => {
  expect(sanitizeSendText('  hello\n  world\t!  ')).toBe('hello world !');
  expect(sanitizeSendText('a\u0007b\u001b[31mc')).toBe('ab[31mc');
  expect(sanitizeSendText('\r\n\r\n')).toBe('');
});
