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
