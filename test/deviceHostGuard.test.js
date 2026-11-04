import { test, expect } from 'vitest';
import { createDeviceHostGuard } from '../src/server/deviceHostGuard.js';

const NO_IFACES = () => ({});
const IFACES = () => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: '192.168.1.77', family: 'IPv4', internal: false },
    { address: 'fe80::1234', family: 'IPv6', internal: false, scopeid: 2 },
  ],
});
const resolvesTo = (...addresses) => async () => addresses.map((address) => ({
  address, family: address.includes(':') ? 6 : 4,
}));

// The real resolver on purpose: ssh hands these spellings to getaddrinfo, so a
// string comparison against "127.0.0.1" would wave every one of them through.
test.each(['127.0.0.1', '127.1', '127.8.9.10', '2130706433', '0x7f.1', '0', '0.0.0.0', 'localhost'])(
  'refuses %s, which reaches this machine through the real resolver',
  async (host) => {
    const guard = createDeviceHostGuard({ interfaces: NO_IFACES });
    expect(await guard.refusal({ host })).toMatch(/this machine/);
  },
);

test('allows an address that is not this machine', async () => {
  const guard = createDeviceHostGuard({ interfaces: IFACES });
  expect(await guard.refusal({ host: '192.168.1.50' })).toBeNull();
});

test('refuses one of this machine\'s own interface addresses', async () => {
  const guard = createDeviceHostGuard({ interfaces: IFACES });
  expect(await guard.refusal({ host: '192.168.1.77' })).toMatch(/this machine/);
});

test('refuses a name resolving to an interface address, including a scoped IPv6 one', async () => {
  const v4 = createDeviceHostGuard({ interfaces: IFACES, lookup: resolvesTo('192.168.1.77') });
  expect(await v4.refusal({ host: 'me.example.com' })).toMatch(/this machine/);
  const v6 = createDeviceHostGuard({ interfaces: IFACES, lookup: resolvesTo('fe80::1234%eth0') });
  expect(await v6.refusal({ host: 'me.example.com' })).toMatch(/this machine/);
});

test('refuses an IPv4-mapped loopback answer', async () => {
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES, lookup: resolvesTo('::ffff:127.0.0.1') });
  expect(await guard.refusal({ host: 'mapped.example.com' })).toMatch(/this machine/);
});

test('refuses when ANY answer is local, because ssh tries each address in turn', async () => {
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES, lookup: resolvesTo('192.168.1.50', '127.0.0.1') });
  expect(await guard.refusal({ host: 'mixed.example.com' })).toMatch(/this machine/);
});

test('fails closed when the name does not resolve', async () => {
  const lookup = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES, lookup });
  expect(await guard.refusal({ host: 'alias-only-in-ssh-config' })).toMatch(/could not be verified/);
});

test('fails closed on an empty answer', async () => {
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES, lookup: resolvesTo() });
  expect(await guard.refusal({ host: 'empty.example.com' })).toMatch(/could not be verified/);
});

test('fails closed when the resolver hangs', async () => {
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES, lookup: () => new Promise(() => {}), timeoutMs: 10 });
  expect(await guard.refusal({ host: 'slow.example.com' })).toMatch(/could not be verified/);
});

test('fails closed when the interface list cannot be read', async () => {
  const guard = createDeviceHostGuard({ interfaces: () => { throw new Error('uv_interface_addresses'); } });
  expect(await guard.refusal({ host: '192.168.1.50' })).toMatch(/could not be verified/);
});

test.each([
  ['root@127.0.0.1', 'bare user@host'],
  ['root@127.0.0.1:2222', 'user@host:port'],
  ['localhost:22', 'host:port'],
  ['192.168.1.50,root@localhost', 'second hop'],
  ['::1', 'IPv6 literal'],
])('refuses a jump hop on this machine: %s (%s)', async (proxyJump) => {
  const guard = createDeviceHostGuard({ interfaces: NO_IFACES });
  expect(await guard.refusal({ host: '192.168.1.50', proxyJump })).toMatch(/this machine/);
});

test('allows a jump chain that stays off this machine', async () => {
  const guard = createDeviceHostGuard({ interfaces: IFACES });
  expect(await guard.refusal({ host: '192.168.1.50', proxyJump: 'ops@192.168.1.51:2222,192.168.1.52' })).toBeNull();
});
