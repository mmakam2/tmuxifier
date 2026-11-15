import { test, expect } from 'vitest';
import { buildAttachArgv, buildProbeArgv, buildSetupArgv, buildProvisionArgv, buildControlExitArgv, buildControlCheckArgv, buildControlPathArgv, buildControlForwardArgv, buildControlCancelArgv, sanitizeSession } from '../src/server/sshCommand.js';

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
    'tmux -u new-session -A -s web',
  ]);
});

// `-D` (detach every other client) was correct while Tmuxifier mirrored ONE
// `tmux attach` to every browser: there was only ever one client, and the flag
// stopped a stale one from holding the session. Now each viewer gets its own
// attach so tmux can size each client's screen independently, and `-D` would
// make every newly opened browser kick off the machine you just walked away
// from. Sizing across clients is tmux's own `window-size` option, whose default
// (`latest`, tmux 3.1+) is exactly "the most recently used client wins".
test('buildAttachArgv: no -D, so a second viewer does not detach the first', () => {
  const remote = buildAttachArgv({ host: 'prod' }, 'web').at(-1);
  expect(remote).toBe('tmux -u new-session -A -s web');
  expect(remote).not.toContain('-D');
});

test('buildAttachArgv: tmux is launched with -u so glyphs survive a C/POSIX box locale', () => {
  // Without -u, tmux down-converts non-ASCII (Claude Code spinner/checkboxes) to
  // `_` when writing to a client whose locale is not UTF-8 (SSH does not forward
  // locale). The flag must precede the tmux subcommand.
  const argv = buildAttachArgv({ host: 'prod' }, 'web');
  expect(argv[argv.length - 1]).toMatch(/^tmux -u new-session\b/);
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
  expect(argv[argv.length - 1]).toBe("tmux -u new-session -A -s web 'echo '\\''hi'\\'''");
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

test('buildSetupArgv is non-interactive: BatchMode on, no -tt, script last', () => {
  const argv = buildSetupArgv({ host: 'prod' }, 'echo hi');
  expect(argv).not.toContain('-tt');
  expect(argv).toContain('BatchMode=yes');
  expect(argv[argv.length - 1]).toBe('echo hi');
  expect(argv[argv.length - 2]).toBe('prod');
});

test('buildSetupArgv validates box fields (command-injection guard)', () => {
  expect(() => buildSetupArgv({ host: '-oProxyCommand=evil' }, 'x')).toThrow();
});

const FWD_BOX = { host: 'h', user: 'me', port: 2222 };
const FWD_REMOTE = '/home/me/.tmuxifier-mail/sock';
const FWD_LOCAL = '/srv/data/mail/abc.sock';

test('buildControlForwardArgv: -O forward with -R remote:local on the box master socket', () => {
  const argv = buildControlForwardArgv(FWD_BOX, FWD_REMOTE, FWD_LOCAL, { controlDir: '/run/cm' });
  expect(argv[argv.indexOf('-O') + 1]).toBe('forward');
  expect(argv[argv.indexOf('-R') + 1]).toBe('/home/me/.tmuxifier-mail/sock:/srv/data/mail/abc.sock');
  expect(argv).toContain('ControlPath=/run/cm/%C'); expect(argv).not.toContain('BatchMode=yes');
  expect(argv.at(-1)).toBe('me@h');
  expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
});

test('buildControlCancelArgv mirrors it with cancel', () => {
  const opts = { controlDir: '/run/cm', sshConfigFile: '/tmp/cfg' };
  const box = { ...FWD_BOX, proxyJump: 'gw' };
  const fwd = buildControlForwardArgv(box, FWD_REMOTE, FWD_LOCAL, opts);
  const cancel = buildControlCancelArgv(box, FWD_REMOTE, FWD_LOCAL, opts);
  expect(cancel).toEqual(fwd.map((a) => (a === 'forward' ? 'cancel' : a)));
  expect(cancel).toEqual([
    '-F', '/tmp/cfg',
    '-o', 'ControlPath=/run/cm/%C',
    '-J', 'gw',
    '-p', '2222',
    '-O', 'cancel',
    '-R', `${FWD_REMOTE}:${FWD_LOCAL}`,
    'me@h',
  ]);
});

test('both return null without a control dir and throw on an unsafe host', () => {
  expect(buildControlForwardArgv(FWD_BOX, FWD_REMOTE, FWD_LOCAL, {})).toBeNull();
  expect(buildControlCancelArgv(FWD_BOX, FWD_REMOTE, FWD_LOCAL)).toBeNull();
  for (const build of [buildControlForwardArgv, buildControlCancelArgv]) {
    expect(() => build({ host: '-oProxyCommand=x' }, FWD_REMOTE, FWD_LOCAL, { controlDir: '/run/cm' })).toThrow(/unsafe ssh host/);
    // The box is checked even when multiplexing is off.
    expect(() => build({ host: 'a b' }, FWD_REMOTE, FWD_LOCAL, {})).toThrow(/unsafe ssh host/);
  }
});

test('a remote path with a space, a colon, "..", or over 100 characters is refused; so is a relative or colon-bearing local path', () => {
  const opts = { controlDir: '/run/cm' };
  const longest = `/${'a'.repeat(100)}`;
  for (const build of [buildControlForwardArgv, buildControlCancelArgv]) {
    expect(build(FWD_BOX, longest, FWD_LOCAL, opts)).toContain(`${longest}:${FWD_LOCAL}`);
    for (const bad of [
      '/home/my user/.tmuxifier-mail/sock',
      '/home/me:x/.tmuxifier-mail/sock',
      '/home/me/../root/.tmuxifier-mail/sock',
      `/${'a'.repeat(101)}`,
      'home/me/.tmuxifier-mail/sock',
      '',
      '/home/me/$(id)/sock',
      undefined,
    ]) {
      expect(() => build(FWD_BOX, bad, FWD_LOCAL, opts)).toThrow('unsafe forward path');
    }
    for (const bad of ['data/mail/abc.sock', '/srv/da:ta/mail/abc.sock', '', null]) {
      expect(() => build(FWD_BOX, FWD_REMOTE, bad, opts)).toThrow('unsafe forward path');
    }
  }
});
