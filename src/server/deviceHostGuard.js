// Refuses a device-token-added box whose SSH destination is this machine. The
// host's own key is often in its own authorized_keys, so such a box plus a Fleet
// Command would turn a stolen device token into a shell on the Tmuxifier host:
// the .env, the cookie secret, and through it every sealed credential.
//
// Addresses are compared after resolving, because ssh resolves too: `127.1`,
// `2130706433`, `0x7f.1`, `0` and the host's own LAN name all pass SAFE_HOST and
// all land here. Anything that cannot be checked is refused, including a name
// only ~/.ssh/config knows; a browser session can still add it.
//
// This is a speed bump for one route, not a boundary. It checks once, at add
// time, and only what THIS host resolves, so a name re-pointed afterwards, or a
// machine forwarding TCP to this host's sshd, still gets through. Only removing
// the host's key from its own authorized_keys closes those (docs/mcp.md).
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

const LOCAL = 'host resolves to this machine; adding it requires a browser session';
const UNVERIFIED = 'host could not be verified as off this machine; adding it requires a browser session';

function localAddresses(interfaces) {
  const list = new net.BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addAddress('::', 'ipv6');
  for (const rows of Object.values(interfaces())) {
    for (const { address } of rows || []) {
      const bare = address.split('%')[0];
      list.addAddress(bare, net.isIPv6(bare) ? 'ipv6' : 'ipv4');
    }
  }
  return list;
}

// `user@host:port` -> `host`. SAFE_JUMP has no brackets, so a value with several
// colons can only be a bare IPv6 literal, and it carries no port to strip.
function hopHost(hop) {
  const rest = hop.slice(hop.lastIndexOf('@') + 1);
  return rest.split(':').length === 2 ? rest.slice(0, rest.indexOf(':')) : rest;
}

export function createDeviceHostGuard({
  lookup = (name) => dns.lookup(name, { all: true, verbatim: true }),
  interfaces = os.networkInterfaces,
  timeoutMs = 5000,
} = {}) {
  function resolve(name) {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('lookup timed out')), timeoutMs);
    });
    return Promise.race([lookup(name), expired]).finally(() => clearTimeout(timer));
  }

  async function verdict(name, local) {
    try {
      const answers = await resolve(name);
      if (!answers.length) return UNVERIFIED;
      // Any local answer refuses: ssh tries each address in turn.
      for (const { address } of answers) {
        const bare = address.split('%')[0];
        if (local.check(bare, net.isIPv6(bare) ? 'ipv6' : 'ipv4')) return LOCAL;
      }
      return null;
    } catch {
      return UNVERIFIED;
    }
  }

  return {
    // The reason this destination is refused, or null when it is off this machine.
    async refusal({ host, proxyJump }) {
      let local;
      try { local = localAddresses(interfaces); } catch { return UNVERIFIED; }
      const names = [host, ...(proxyJump ? proxyJump.split(',').map(hopHost) : [])];
      const results = await Promise.all(names.map((name) => verdict(name, local)));
      if (results.includes(LOCAL)) return LOCAL;
      return results.includes(UNVERIFIED) ? UNVERIFIED : null;
    },
  };
}
