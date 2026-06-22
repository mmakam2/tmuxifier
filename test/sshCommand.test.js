import { test, expect } from 'vitest';
import { buildAttachArgv, buildProbeArgv, buildProvisionArgv, buildControlExitArgv, buildControlCheckArgv, buildControlPathArgv, sanitizeSession } from '../src/server/sshCommand.js';

test('buildAttachArgv does not expose an unused size parameter', () => {
  expect(buildAttachArgv).toHaveLength(2);
});

test('sanitizeSession strips unsafe chars', () => {
  expect(sanitizeSession('we b;rm -rf/')).toBe('we-b-rm--rf-');
  expect(sanitizeSession('')).toBe('web');
});

test('buildAttachArgv: alias-only box', () => {
  const argv = buildAttachArgv({ host: 'prod' }, 'web');
  expect(argv).toEqual([
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    'prod',
    'tmux new-session -A -D -s web',
  ]);
});

test('buildAttachArgv: includes a ConnectTimeout so opening a down box fails fast (not a ~2min hang)', () => {
  const argv = buildAttachArgv({ host: 'prod' }, 'web');
  expect(argv).toContain('ConnectTimeout=10');
});

test('buildAttachArgv: user/port/proxyJump and policy override', () => {
  const argv = buildAttachArgv(
    { host: 'h', user: 'me', port: 2222, proxyJump: 'bastion' },
    'web',
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
  const argv = buildAttachArgv({ host: 'h', startupCommand: "echo 'hi'" }, 'web');
  expect(argv[argv.length - 1]).toBe("tmux new-session -A -D -s web 'echo '\\''hi'\\'''");
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
  expect(() => buildAttachArgv({ host: '-oProxyCommand=touch /tmp/pwn' }, 'web'))
    .toThrow(/unsafe ssh host/);
});
test('buildAttachArgv rejects unsafe user', () => {
  expect(() => buildAttachArgv({ host: 'h', user: '-x' }, 'web'))
    .toThrow(/unsafe ssh user/);
});
test('buildAttachArgv rejects unsafe proxyJump', () => {
  expect(() => buildAttachArgv({ host: 'h', proxyJump: '-x' }, 'web'))
    .toThrow(/unsafe ssh proxyJump/);
});
test('buildAttachArgv rejects out-of-range port', () => {
  expect(() => buildAttachArgv({ host: 'h', port: 99999 }, 'web'))
    .toThrow(/unsafe ssh port/);
});
test('buildProbeArgv rejects flag-smuggling host', () => {
  expect(() => buildProbeArgv({ host: '-oProxyCommand=x' }, 'tmux ls'))
    .toThrow(/unsafe ssh host/);
});
test('buildAttachArgv: sshConfigFile prepends -F', () => {
  const argv = buildAttachArgv({ host: 'h' }, 'web', { sshConfigFile: '/tmp/cfg' });
  expect(argv.slice(0, 2)).toEqual(['-F', '/tmp/cfg']);
  expect(argv).toContain('-tt');
});
test('buildProbeArgv: sshConfigFile prepends -F', () => {
  const argv = buildProbeArgv({ host: 'h' }, 'tmux ls', { sshConfigFile: '/tmp/cfg' });
  expect(argv.slice(0, 2)).toEqual(['-F', '/tmp/cfg']);
});

test('buildProbeArgv: controlDir enables connection multiplexing', () => {
  const argv = buildProbeArgv({ host: 'h' }, 'tmux ls', { controlDir: '/run/cm' });
  expect(argv).toContain('ControlMaster=auto');
  expect(argv).toContain('ControlPath=/run/cm/%C');
  expect(argv.some((a) => a.startsWith('ControlPersist='))).toBe(true);
});

test('buildAttachArgv: controlDir multiplexing shares the probe ControlPath', () => {
  const probe = buildProbeArgv({ host: 'h', user: 'me', port: 22 }, 'tmux ls', { controlDir: '/run/cm' });
  const attach = buildAttachArgv({ host: 'h', user: 'me', port: 22 }, 'web', { controlDir: '/run/cm' });
  // %C is a hash of the connection params, so an identical token in both means
  // the probe reuses the master connection the live terminal already opened.
  expect(attach).toContain('ControlPath=/run/cm/%C');
  expect(probe).toContain('ControlPath=/run/cm/%C');
  expect(attach).toContain('ControlMaster=auto');
});

test('no control options without controlDir (backward compatible)', () => {
  expect(buildProbeArgv({ host: 'h' }, 'tmux ls').join(' ')).not.toContain('ControlMaster');
  expect(buildAttachArgv({ host: 'h' }, 'web').join(' ')).not.toContain('ControlMaster');
});

test('buildProvisionArgv constructs ssh -tt with the script', () => {
  const argv = buildProvisionArgv(
    { host: 'h1', user: 'deploy', port: 2222, proxyJump: 'gw' },
    'echo hi',
    { hostKeyPolicy: 'accept-new', sshConfigFile: '/tmp/cfg', controlDir: '/tmp/cm' },
  );
  expect(argv).toContain('-tt');
  expect(argv).toContain('-o');
  expect(argv).toContain('StrictHostKeyChecking=accept-new');
  expect(argv).toContain('-o');
  expect(argv).toContain('ConnectTimeout=6');
  expect(argv).toContain('-J');
  expect(argv).toContain('gw');
  expect(argv).toContain('-p');
  expect(argv).toContain('2222');
  expect(argv).toContain('deploy@h1');
  expect(argv[argv.length - 1]).toBe('echo hi');
  expect(argv[0]).toBe('-F'); // sshConfigFile goes first
  expect(argv[1]).toBe('/tmp/cfg');
});

test('buildProvisionArgv minimal box', () => {
  const argv = buildProvisionArgv({ host: 'h1' }, 'id');
  expect(argv).toContain('-tt');
  expect(argv).not.toContain('-J');
  expect(argv).not.toContain('-p');
  expect(argv[argv.length - 2]).toBe('h1');
  expect(argv[argv.length - 1]).toBe('id');
});

test('buildControlExitArgv: targets the box master socket with -O exit', () => {
  const argv = buildControlExitArgv({ host: 'h', user: 'me', port: 2222 }, { controlDir: '/run/cm' });
  // Same ControlPath token the attach/probe use, so %C hashes to the same socket.
  expect(argv).toContain('ControlPath=/run/cm/%C');
  expect(argv).toContain('-O');
  expect(argv[argv.indexOf('-O') + 1]).toBe('exit');
  expect(argv).toContain('me@h');
  expect(argv).toContain('-p');
  expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
  // It must not authenticate (it only talks to the local control socket).
  expect(argv).not.toContain('BatchMode=yes');
  expect(argv).not.toContain('-tt');
});

test('buildControlExitArgv: returns null when multiplexing is off', () => {
  expect(buildControlExitArgv({ host: 'h' }, {})).toBeNull();
});

test('buildControlExitArgv: sshConfigFile prepends -F', () => {
  const argv = buildControlExitArgv({ host: 'h' }, { controlDir: '/run/cm', sshConfigFile: '/tmp/cfg' });
  expect(argv.slice(0, 2)).toEqual(['-F', '/tmp/cfg']);
});

test('buildControlExitArgv: rejects flag-smuggling host', () => {
  expect(() => buildControlExitArgv({ host: '-oProxyCommand=x' }, { controlDir: '/run/cm' }))
    .toThrow(/unsafe ssh host/);
});

test('buildControlCheckArgv: targets the box master socket with -O check', () => {
  const argv = buildControlCheckArgv({ host: 'h', user: 'me', port: 2222 }, { controlDir: '/run/cm' });
  expect(argv).toContain('ControlPath=/run/cm/%C');
  expect(argv).toContain('-O');
  expect(argv[argv.indexOf('-O') + 1]).toBe('check');
  expect(argv).toContain('me@h');
  expect(argv).toContain('-p');
  expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
  // It must not authenticate (it only talks to the local control socket).
  expect(argv).not.toContain('BatchMode=yes');
  expect(argv).not.toContain('-tt');
});

test('buildControlCheckArgv: returns null when multiplexing is off', () => {
  expect(buildControlCheckArgv({ host: 'h' }, {})).toBeNull();
});

test('buildControlCheckArgv: rejects flag-smuggling host', () => {
  expect(() => buildControlCheckArgv({ host: '-oProxyCommand=x' }, { controlDir: '/run/cm' }))
    .toThrow(/unsafe ssh host/);
});

test('buildControlPathArgv: runs ssh -G to resolve the concrete %C socket path', () => {
  const argv = buildControlPathArgv({ host: 'h', user: 'me', port: 2222, proxyJump: 'gw' }, { controlDir: '/run/cm' });
  expect(argv).toContain('-G');
  // The same ControlPath token attach/probe use, so -G resolves %C to the same socket.
  expect(argv).toContain('ControlPath=/run/cm/%C');
  expect(argv).toContain('me@h');
  // proxyJump and port must be present so %C (which hashes %j and %p) matches.
  expect(argv).toContain('-J');
  expect(argv[argv.indexOf('-J') + 1]).toBe('gw');
  expect(argv).toContain('-p');
  expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
});

test('buildControlPathArgv: returns null when multiplexing is off', () => {
  expect(buildControlPathArgv({ host: 'h' }, {})).toBeNull();
});

test('buildControlPathArgv: sshConfigFile prepends -F', () => {
  const argv = buildControlPathArgv({ host: 'h' }, { controlDir: '/run/cm', sshConfigFile: '/tmp/cfg' });
  expect(argv.slice(0, 2)).toEqual(['-F', '/tmp/cfg']);
});

test('buildControlPathArgv: rejects flag-smuggling host', () => {
  expect(() => buildControlPathArgv({ host: '-oProxyCommand=x' }, { controlDir: '/run/cm' }))
    .toThrow(/unsafe ssh host/);
});

test('buildProbeArgv: includes ServerAlive keepalive so a probe-established master cannot wedge forever', () => {
  const argv = buildProbeArgv({ host: 'h' }, 'tmux ls');
  expect(argv).toContain('ServerAliveInterval=15');
  expect(argv).toContain('ServerAliveCountMax=3');
});
