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
  // The URL this repo's own config describes, computed whatever the precedence
  // below ends up choosing. It is not only a fallback: it is the yardstick for
  // "is the resolved URL this very server?", and therefore for whether the
  // certificate on disk is ours to trust. Deriving it inside the config branch
  // alone made the trust an accident of which source named the URL — and
  // enrollment records that URL every time, so the file branch then shadowed
  // the config branch and silently disarmed the certificate for the exact
  // deployment it exists for.
  let configUrl = null; let configSecure = false;
  if (serverConfig) {
    configSecure = Boolean(serverConfig.tlsCert && serverConfig.tlsKey);
    const bind = String(serverConfig.bindAddress ?? '');
    const host = WILDCARD_BINDS.has(bind) ? '127.0.0.1' : (bind.includes(':') ? `[${bind}]` : bind);
    configUrl = `${configSecure ? 'https' : 'http'}://${host}:${serverConfig.port ?? 7437}`;
  }
  let baseUrl; let urlSource;
  const fileUrl = tokenFile && typeof tokenFile.url === 'string' ? tokenFile.url.trim().replace(/\/+$/, '') : '';
  if (env.TMUXIFIER_MCP_URL) {
    baseUrl = String(env.TMUXIFIER_MCP_URL).replace(/\/+$/, ''); urlSource = 'env';
  } else if (fileUrl) {
    // Enrollment recorded the URL it actually paired against (`--url`); a token
    // is only valid for that server, so the pair travels together.
    baseUrl = fileUrl; urlSource = 'file';
  } else if (configUrl) {
    baseUrl = configUrl; urlSource = 'config';
  } else {
    baseUrl = 'http://127.0.0.1:7437'; urlSource = 'default';
  }
  // Trust the repo's certificate whenever the resolved URL IS the repo's own
  // TLS endpoint, whichever source named it — and never otherwise: a URL
  // pointing anywhere else may be a proxy in front of a different chain.
  const caFile = configSecure && baseUrl === configUrl ? serverConfig.tlsCert : undefined;
  let token; let tokenSource;
  if (env.TMUXIFIER_MCP_TOKEN) { token = String(env.TMUXIFIER_MCP_TOKEN); tokenSource = 'env'; }
  else if (tokenFile && typeof tokenFile.token === 'string' && tokenFile.token) { token = tokenFile.token; tokenSource = 'file'; }
  else throw new Error('no MCP token: set TMUXIFIER_MCP_TOKEN or run `npm run mcp-enroll`');
  const insecure = TRUTHY.has(String(env.TMUXIFIER_MCP_INSECURE ?? '').toLowerCase());
  return { baseUrl, token, insecure, ...(caFile ? { caFile } : {}), source: { url: urlSource, token: tokenSource } };
}
