// One-time enrollment of the MCP server as a Tmuxifier device: posts to
// POST /api/devices/enroll with a pairing code (any auth mode) or the password
// (password mode only) and writes the returned token to data/mcp-token.json,
// owner-only. The token is shown once by the server and never again — losing
// the file means re-enrolling. Revoke in Settings → Devices.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { httpRequest, trustBundle } from '../src/mcp/apiClient.js';
import { resolveMcpConfig, TOKEN_FILE } from '../src/mcp/config.js';
import { loadConfig } from '../src/server/config.js';
import { readEnvFile } from '../src/server/envFile.js';

export async function enroll({ baseUrl, code, password, name = 'MCP orchestrator', insecure = false, ca, request = httpRequest }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const body = code ? { code, name } : { password: password ?? '', name };
  let res;
  try { res = await request({ url: `${base}/api/devices/enroll`, method: 'POST', body, headers: { Accept: 'application/json' }, insecure, ca, timeoutMs: 15000 }); }
  catch (e) { throw new Error(`cannot reach Tmuxifier at ${base}: ${e?.code || e?.message || e}`); }
  if (res.status === 200 && res.json?.token) return { id: res.json.id, name: res.json.name, token: res.json.token };
  const msg = res.json?.error || `HTTP ${res.status}`;
  if (res.status === 401) throw new Error(`enrollment refused: ${msg} (a pairing code is single-use and expires after 2 minutes)`);
  if (res.status === 403) throw new Error('password enrollment is disabled while "require a passkey" is armed — mint a pairing code in Settings → Devices and pass --code');
  if (res.status === 501) throw new Error('this server is in OAuth mode — mint a pairing code in Settings → Devices and pass --code');
  if (res.status === 429) throw new Error('too many attempts — wait a minute');
  throw new Error(`enrollment failed: ${msg}`);
}

export function writeTokenFile(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Unique per-call name (jsonFile.js's tmpName idea), and the write/chmod/rename
  // sequence is wrapped so a mid-write failure (e.g. rename onto a directory)
  // cannot leave the plaintext token sitting in an orphaned tmp file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...record, enrolledAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function parseArgs(argv) {
  const out = { insecure: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v.startsWith('--')) throw new Error(`${key} needs a value`);
      return v;
    };
    if (key === '--code') out.code = val();
    else if (key === '--name') out.name = val();
    else if (key === '--url') out.url = val();
    else if (key === '--insecure') out.insecure = true;
    else if (key === '-h' || key === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `usage: npm run mcp-enroll -- [--code XXXX-XXXX] [--name "MCP orchestrator"] [--url https://host:port] [--insecure]

  --code      pairing code from Settings → Devices → Pair new device (works in every auth mode)
  --name      device name shown in Settings → Devices (default: MCP orchestrator)
  --url       Tmuxifier base URL (default: TMUXIFIER_MCP_URL, else derived from this repo's .env)
  --insecure  accept a self-signed TLS certificate
Without --code you are prompted for the password (password mode only).`;

// Same hidden prompt as scripts/hash-password.js (copied, not imported — that
// script runs main() on import). Control characters are written as \u escapes.
async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const value = await rl.question(question);
    rl.close();
    return value;
  }
  return new Promise((resolve) => {
    process.stderr.write(question);
    const { stdin } = process;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        process.stderr.write('\n'); resolve(buf);
      } else if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', onData);
  });
}

// The repo's own files, found from the module rather than from process.cwd() —
// `npm run mcp-enroll` sets cwd to the repo, but a direct `node
// /path/to/tmuxifier/scripts/mcp-enroll.js` does not, and it would then read a
// stranger's .env and write the token beside it. Same rule as src/mcp/index.js.
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function main({ cwd = REPO_ROOT, argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);
  if (args.help) { process.stderr.write(`${USAGE}\n`); return 0; }
  const env = { ...readEnvFile(path.join(cwd, '.env')), ...process.env };
  let serverConfig = null;
  try { serverConfig = loadConfig({}, { env, cwd }); } catch {}
  const resolved = resolveMcpConfig({
    env: { ...env, ...(args.url ? { TMUXIFIER_MCP_URL: args.url } : {}), ...(args.insecure ? { TMUXIFIER_MCP_INSECURE: '1' } : {}) },
    serverConfig, tokenFile: { token: '-' },
  });
  // Same rule as the MCP server: a config-derived https URL is this repo's own
  // server, so trust exactly the certificate it serves.
  let ca;
  if (resolved.caFile) {
    try { ca = trustBundle(fs.readFileSync(path.resolve(cwd, resolved.caFile), 'utf8')); }
    catch { /* system trust store, or --insecure */ }
  }
  const password = args.code ? undefined : await promptHidden(`Tmuxifier password for ${resolved.baseUrl}: `);
  const r = await enroll({ baseUrl: resolved.baseUrl, code: args.code, password, name: args.name, insecure: resolved.insecure, ca });
  writeTokenFile(path.join(cwd, TOKEN_FILE), { id: r.id, name: r.name, token: r.token, url: resolved.baseUrl });
  process.stderr.write(`enrolled device "${r.name}" (${r.id}) — token written to ${TOKEN_FILE} (0600). Revoke it any time in Settings → Devices.\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.message || e}\n`); process.exitCode = 1; });
}
