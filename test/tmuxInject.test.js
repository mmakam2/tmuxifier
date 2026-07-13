import { test, expect } from 'vitest';
import {
  classifyPane,
  buildCapturePaneRemote,
  buildSendKeysRemote,
  buildDisplayMessageRemote,
  injectionText,
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
});

test('classifyPane detects shell prompts', () => {
  expect(classifyPane('user@box:~$ ')).toBe('shell');
  expect(classifyPane('build ok\nuser@box:~$')).toBe('shell');
  expect(classifyPane('~/code ❯ ')).toBe('shell');
  expect(classifyPane('root@lxc:/# ')).toBe('shell');
  expect(classifyPane('zsh % ')).toBe('shell');
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
