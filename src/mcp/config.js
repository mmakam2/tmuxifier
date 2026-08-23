// Pure config resolution for the MCP server (env map, server config and token
// file contents injected — never read here, the loadConfig discipline).
// Precedence: env vars, then the repo's own loadConfig() + data/mcp-token.json.
export const TOKEN_FILE = 'data/mcp-token.json';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '']);

export function resolveMcpConfig({ env = {}, serverConfig = null, tokenFile = null } = {}) {
  let baseUrl; let urlSource;
  if (env.TMUXIFIER_MCP_URL) {
    baseUrl = String(env.TMUXIFIER_MCP_URL).replace(/\/+$/, ''); urlSource = 'env';
  } else if (serverConfig) {
    const scheme = serverConfig.tlsCert && serverConfig.tlsKey ? 'https' : 'http';
    const bind = String(serverConfig.bindAddress ?? '');
    const host = WILDCARD_BINDS.has(bind) ? '127.0.0.1' : (bind.includes(':') ? `[${bind}]` : bind);
    baseUrl = `${scheme}://${host}:${serverConfig.port ?? 7437}`; urlSource = 'config';
  } else {
    baseUrl = 'http://127.0.0.1:7437'; urlSource = 'default';
  }
  let token; let tokenSource;
  if (env.TMUXIFIER_MCP_TOKEN) { token = String(env.TMUXIFIER_MCP_TOKEN); tokenSource = 'env'; }
  else if (tokenFile && typeof tokenFile.token === 'string' && tokenFile.token) { token = tokenFile.token; tokenSource = 'file'; }
  else throw new Error('no MCP token: set TMUXIFIER_MCP_TOKEN or run `npm run mcp-enroll`');
  const insecure = TRUTHY.has(String(env.TMUXIFIER_MCP_INSECURE ?? '').toLowerCase());
  return { baseUrl, token, insecure, source: { url: urlSource, token: tokenSource } };
}
