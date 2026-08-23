import { test, expect } from 'vitest';
import { resolveMcpConfig, TOKEN_FILE } from '../src/mcp/config.js';

test('env vars win over everything', () => {
  const c = resolveMcpConfig({ env: { TMUXIFIER_MCP_URL: 'https://tmux.example.com/', TMUXIFIER_MCP_TOKEN: 'envtok', TMUXIFIER_MCP_INSECURE: 'yes' },
    serverConfig: { bindAddress: '127.0.0.1', port: 7437 }, tokenFile: { token: 'filetok' } });
  expect(c).toEqual({ baseUrl: 'https://tmux.example.com', token: 'envtok', insecure: true, source: { url: 'env', token: 'env' } });
});

test('the URL derives from the server config when run from the repo folder', () => {
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 7437 }, tokenFile: { token: 't' } }))
    .toMatchObject({ baseUrl: 'http://127.0.0.1:7437', source: { url: 'config', token: 'file' } });
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '0.0.0.0', port: 8443, tlsCert: 'tls/cert.pem', tlsKey: 'tls/key.pem' }, tokenFile: { token: 't' } }).baseUrl)
    .toBe('https://127.0.0.1:8443');
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '::', port: 7437 }, tokenFile: { token: 't' } }).baseUrl).toBe('http://127.0.0.1:7437');
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '192.168.1.10', port: 7437 }, tokenFile: { token: 't' } }).baseUrl).toBe('http://192.168.1.10:7437');
});

test('with no server config the default bind is assumed', () => {
  expect(resolveMcpConfig({ tokenFile: { token: 't' } })).toMatchObject({ baseUrl: 'http://127.0.0.1:7437', source: { url: 'default' } });
});

test('a missing token is a descriptive error naming both remedies', () => {
  expect(() => resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 7437 } })).toThrow(/TMUXIFIER_MCP_TOKEN.*npm run mcp-enroll/);
  expect(() => resolveMcpConfig({ tokenFile: { token: '' } })).toThrow(/no MCP token/);
});

test('insecure parses common truthy spellings only', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) expect(resolveMcpConfig({ env: { TMUXIFIER_MCP_INSECURE: v }, tokenFile: { token: 't' } }).insecure).toBe(true);
  for (const v of ['0', 'false', '', 'maybe']) expect(resolveMcpConfig({ env: { TMUXIFIER_MCP_INSECURE: v }, tokenFile: { token: 't' } }).insecure).toBe(false);
});

test('the token file path is the documented one', () => {
  expect(TOKEN_FILE).toBe('data/mcp-token.json');
});

test('a config-derived https URL also names the server\'s own certificate to trust', () => {
  const https = resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 8443, tlsCert: 'tls/cert.pem', tlsKey: 'tls/key.pem' }, tokenFile: { token: 't' } });
  expect(https).toMatchObject({ baseUrl: 'https://127.0.0.1:8443', caFile: 'tls/cert.pem', source: { url: 'config' } });
  // Plain http, an env URL and an enrollment URL are none of Tmuxifier's certificate:
  // the far end may be a reverse proxy serving a chain this file has nothing to do with.
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 7437 }, tokenFile: { token: 't' } }).caFile).toBeUndefined();
  expect(resolveMcpConfig({ env: { TMUXIFIER_MCP_URL: 'https://tmux.example.com' }, serverConfig: { bindAddress: '127.0.0.1', port: 8443, tlsCert: 'tls/cert.pem', tlsKey: 'tls/key.pem' }, tokenFile: { token: 't' } }).caFile).toBeUndefined();
  expect(resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 8443, tlsCert: 'tls/cert.pem', tlsKey: 'tls/key.pem' }, tokenFile: { token: 't', url: 'https://tmux.example.com' } }).caFile).toBeUndefined();
});

test('the URL recorded at enrollment is honoured, under the env and over the server config', () => {
  const fromFile = resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 7437 }, tokenFile: { token: 't', url: 'https://tmux.example.com/' } });
  expect(fromFile).toMatchObject({ baseUrl: 'https://tmux.example.com', source: { url: 'file', token: 'file' } });
  expect(resolveMcpConfig({ env: { TMUXIFIER_MCP_URL: 'http://192.168.1.10:7437' }, tokenFile: { token: 't', url: 'https://tmux.example.com' } }))
    .toMatchObject({ baseUrl: 'http://192.168.1.10:7437', source: { url: 'env' } });
  // A blank or non-string url is no url at all — fall through to the server config.
  for (const url of ['', '   ', '/', null, 42]) {
    expect(resolveMcpConfig({ serverConfig: { bindAddress: '127.0.0.1', port: 7437 }, tokenFile: { token: 't', url } }).source.url).toBe('config');
  }
});
