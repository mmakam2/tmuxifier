import { test, expect } from 'vitest';
import {
  classifyPane,
  buildCapturePaneRemote,
  buildSendKeysRemote,
  buildDisplayMessageRemote,
  injectionText,
  injectVia,
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
});

test('script builders sanitize the session and quote arguments', () => {
  expect(buildCapturePaneRemote('web')).toBe("tmux capture-pane -p -t 'web' 2>/dev/null | tail -25");
  // session goes through sanitizeSession: unsafe chars become '-'
  expect(buildCapturePaneRemote('a;b')).toContain("'a-b'");
  expect(buildSendKeysRemote('web', "'/root/.tmuxifier-uploads/1-aa-x.png' "))
    .toBe("tmux send-keys -t 'web' -l -- ''\\''/root/.tmuxifier-uploads/1-aa-x.png'\\'' '");
  expect(buildDisplayMessageRemote('web', '[tmuxifier] image pasted: x.png'))
    .toBe("tmux display-message -t 'web' '[tmuxifier] image pasted: x.png'");
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
    if (script.startsWith('tmux capture-pane')) {
      return failCapture ? { code: 1, stdout: '', stderr: 'no session' } : { code: 0, stdout: captureOut, stderr: '' };
    }
    if (script.startsWith('tmux send-keys')) return { code: sendCode, stdout: '', stderr: sendCode ? 'boom' : '' };
    return { code: 0, stdout: '', stderr: '' }; // display-message
  };
  return { run, calls };
}

test('injectVia types the quoted path into a shell pane and reports mode', async () => {
  const { run, calls } = fakeRunner('user@box:~$ ');
  const res = await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  expect(res).toEqual({ injected: true, mode: 'shell' });
  const send = calls.find((c) => c.startsWith('tmux send-keys'));
  expect(send).toContain('/root/.tmuxifier-uploads/1-aa-shot.png');
  const msg = calls.find((c) => c.startsWith('tmux display-message'));
  expect(msg).toContain('image pasted: 1-aa-shot.png');
});

test('injectVia detects claude mode', async () => {
  const { run } = fakeRunner('│ > \n? for shortcuts');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: true, mode: 'claude' });
});

test('injectVia never types into a busy pane — message only', async () => {
  const { run, calls } = fakeRunner('~\n~\n-- INSERT --');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(calls.some((c) => c.startsWith('tmux send-keys'))).toBe(false);
  const msg = calls.find((c) => c.startsWith('tmux display-message'));
  expect(msg).toContain('pane busy');
  expect(msg).toContain('/x/y.png');
});

test('injectVia treats a failed capture as busy', async () => {
  const { run } = fakeRunner('', { failCapture: true });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
});

test('injectVia reports error (and never throws) when send-keys fails', async () => {
  const { run, calls } = fakeRunner('user@box:~$ ', { sendCode: 1 });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
  // degradation: it still tried to surface the path via display-message
  expect(calls.filter((c) => c.startsWith('tmux display-message')).length).toBe(1);
});

test('injectVia survives a throwing runner', async () => {
  const res = await injectVia(async () => { throw new Error('ssh died'); }, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
});

test('injectLocalUploadPath runs the same flow through the injected runner', async () => {
  const { run, calls } = fakeRunner('~/code ❯ ');
  const res = await injectLocalUploadPath('local', '/home/u/.tmuxifier-uploads/1-aa-x.png', { run });
  expect(res).toEqual({ injected: true, mode: 'shell' });
  expect(calls[0]).toContain("-t 'local'");
});
