export function parseSshConfig(text) {
  const hosts = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toLowerCase();
    const rest = parts.slice(1);
    if (key === 'host') {
      const name = rest.find((p) => !p.includes('*') && !p.includes('?'));
      if (name) {
        current = { host: name, label: name, source: 'ssh-config' };
        hosts.push(current);
      } else {
        current = null; // wildcard-only block
      }
    } else if (current) {
      const value = rest.join(' ');
      if (key === 'hostname') current.hostName = value;
      else if (key === 'user') current.user = value;
      else if (key === 'port') current.port = Number(value);
      else if (key === 'proxyjump') current.proxyJump = value;
    }
  }
  return hosts;
}
