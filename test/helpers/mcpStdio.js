// Shared fixture for driving src/mcp/index.js as a real child process over
// pipes — the exact view an MCP client has of the server: newline-delimited
// JSON-RPC on stdin/stdout, diagnostics on stderr.
import { spawn } from 'node:child_process';
import path from 'node:path';

export function spawnMcp({ env = {}, cwd = process.cwd() } = {}) {
  const child = spawn(process.execPath, [path.resolve('src/mcp/index.js')], {
    cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(String(c)));
  let nextId = 1;
  function rpc(method, params, id = nextId++) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (c) => {
        buf += c;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.id === id) { child.stdout.off('data', onData); resolve(msg); }
        }
      };
      child.stdout.on('data', onData);
      child.once('exit', () => reject(new Error(`mcp exited: ${stderr.join('')}`)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }
  async function call(name, args = {}) {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) throw new Error(JSON.stringify(res.error));
    return res.result;
  }
  async function close() {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    return child.exitCode;
  }
  return { child, rpc, notify, call, close, stderr: () => stderr.join('') };
}
