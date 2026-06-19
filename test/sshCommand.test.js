import { test, expect } from 'vitest';
import { buildAttachArgv, buildProbeArgv, sanitizeSession } from '../src/server/sshCommand.js';

test('sanitizeSession strips unsafe chars', () => {
  expect(sanitizeSession('we b;rm -rf/')).toBe('we-b-rm--rf-');
  expect(sanitizeSession('')).toBe('web');
});

test('buildAttachArgv: alias-only box', () => {
  const argv = buildAttachArgv({ host: 'prod' }, 'web', { cols: 80, rows: 24 });
  expect(argv).toEqual([
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    'prod',
    'tmux new-session -A -s web',
  ]);
});

test('buildAttachArgv: user/port/proxyJump and policy override', () => {
  const argv = buildAttachArgv(
    { host: 'h', user: 'me', port: 2222, proxyJump: 'bastion' },
    'web',
    { cols: 80, rows: 24 },
    { hostKeyPolicy: 'yes' },
  );
  expect(argv).toContain('-J');
  expect(argv[argv.indexOf('-J') + 1]).toBe('bastion');
  expect(argv).toContain('-p');
  expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
  expect(argv).toContain('me@h');
  expect(argv).toContain('StrictHostKeyChecking=yes');
});

test('buildAttachArgv: startupCommand is single-quoted for the remote shell', () => {
  const argv = buildAttachArgv({ host: 'h', startupCommand: "echo 'hi'" }, 'web', { cols: 80, rows: 24 });
  expect(argv[argv.length - 1]).toBe("tmux new-session -A -s web 'echo '\\''hi'\\'''");
});

test('buildProbeArgv: batch mode, no PTY, carries remote cmd', () => {
  const argv = buildProbeArgv({ host: 'prod' }, 'tmux ls');
  expect(argv).toContain('-o');
  expect(argv).toContain('BatchMode=yes');
  expect(argv).not.toContain('-tt');
  expect(argv[argv.length - 1]).toBe('tmux ls');
  expect(argv[argv.length - 2]).toBe('prod');
});

test('buildAttachArgv rejects flag-smuggling host', () => {
  expect(() => buildAttachArgv({ host: '-oProxyCommand=touch /tmp/pwn' }, 'web', { cols: 80, rows: 24 }))
    .toThrow(/unsafe ssh host/);
});
test('buildAttachArgv rejects unsafe user', () => {
  expect(() => buildAttachArgv({ host: 'h', user: '-x' }, 'web', { cols: 80, rows: 24 }))
    .toThrow(/unsafe ssh user/);
});
test('buildAttachArgv rejects unsafe proxyJump', () => {
  expect(() => buildAttachArgv({ host: 'h', proxyJump: '-x' }, 'web', { cols: 80, rows: 24 }))
    .toThrow(/unsafe ssh proxyJump/);
});
test('buildAttachArgv rejects out-of-range port', () => {
  expect(() => buildAttachArgv({ host: 'h', port: 99999 }, 'web', { cols: 80, rows: 24 }))
    .toThrow(/unsafe ssh port/);
});
test('buildProbeArgv rejects flag-smuggling host', () => {
  expect(() => buildProbeArgv({ host: '-oProxyCommand=x' }, 'tmux ls'))
    .toThrow(/unsafe ssh host/);
});
