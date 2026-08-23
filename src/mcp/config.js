// Pure config resolution for the MCP server (env map, server config and token
// file contents injected — never read here, the loadConfig discipline).
// URL precedence: env vars, then the URL recorded at enrollment (the token
// file's `url`, i.e. what `--url` was pointed at), then the repo's own
// loadConfig(), then the default bind. The token comes from the env or that
// same file.
export const TOKEN_FILE = 'data/mcp-token.json';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '']);

export function resolveMcpConfig({ env = {}, serverConfig = null, tokenFile = null } = {}) {
  let baseUrl; let urlSource; let caFile;
  const fileUrl = tokenFile && typeof tokenFile.url === 'string' ? tokenFile.url.trim().replace(/\/+$/, '') : '';
  if (env.TMUXIFIER_MCP_URL) {
    baseUrl = String(env.TMUXIFIER_MCP_URL).replace(/\/+$/, ''); urlSource = 'env';
  } else if (fileUrl) {
    // Enrollment recorded the URL it actually paired against (`--url`); a token
    // is only valid for that server, so the pair travels together.
    baseUrl = fileUrl; urlSource = 'file';
  } else if (serverConfig) {
    const secure = Boolean(serverConfig.tlsCert && serverConfig.tlsKey);
    const scheme = secure ? 'https' : 'http';
    const bind = String(serverConfig.bindAddress ?? '');
    const host = WILDCARD_BINDS.has(bind) ? '127.0.0.1' : (bind.includes(':') ? `[${bind}]` : bind);
    baseUrl = `${scheme}://${host}:${serverConfig.port ?? 7437}`; urlSource = 'config';
    // The URL is this repo's own server, so its certificate is this repo's own
    // file: trust exactly that one. Never for an env or enrollment URL — those
    // may name a proxy in front of a different chain entirely.
    if (secure) caFile = serverConfig.tlsCert;
  } else {
    baseUrl = 'http://127.0.0.1:7437'; urlSource = 'default';
  }
  let token; let tokenSource;
  if (env.TMUXIFIER_MCP_TOKEN) { token = String(env.TMUXIFIER_MCP_TOKEN); tokenSource = 'env'; }
  else if (tokenFile && typeof tokenFile.token === 'string' && tokenFile.token) { token = tokenFile.token; tokenSource = 'file'; }
  else throw new Error('no MCP token: set TMUXIFIER_MCP_TOKEN or run `npm run mcp-enroll`');
  const insecure = TRUTHY.has(String(env.TMUXIFIER_MCP_INSECURE ?? '').toLowerCase());
  return { baseUrl, token, insecure, ...(caFile ? { caFile } : {}), source: { url: urlSource, token: tokenSource } };
}
