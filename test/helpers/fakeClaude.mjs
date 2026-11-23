// A stand-in for Claude Code in the agent hook's process tree, for
// test/agentHookNested.integration.test.js. It is a real process that starts the real hook
// script the way Claude Code was recorded to (test/fixtures/README-claude-nested-trace.md): a
// hook command goes through `<shell> -c` in a new session, with the event JSON on stdin. It can
// also start another stand-in under itself, as the Bash tool starts a `claude -p`, or leave
// one behind that is re-parented away, as a plugin's nohup does.
//
//   node fakeClaude.mjs <program.json>
//
// program: { hook, shell, marker, out, steps, spawner? }
//   hook     absolute path of tmuxifier-agent-hook.sh
//   shell    what runs a hook command: `dash` keeps a `sh -c` between this process and the hook,
//            `bash` execs the hook and leaves this process as its parent
//   marker   the marker file the hook writes for this pane
//   out      a directory for snapshots and flags
//   steps    [op, arg] pairs, run in order:
//     ['hook', 'start']        run the hook with that event argument and wait for it
//     ['snap', 'name']         copy the marker's text to out/name ('(none)' when absent)
//     ['nested', steps]        run a stand-in under this one, through a shell that stays, and wait
//     ['detached', steps]      leave a stand-in behind: it starts its steps once its parent is gone
//     ['terminal', steps]      leave one behind that has a terminal of its own (script(1))
//     ['await', 'name']        wait for out/name to exist
//     ['touch', 'name']        create out/name
//   spawner  (set by 'detached') the pid whose exit this stand-in waits for before it starts
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const prog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

function child(steps, extra = {}) {
  const file = path.join(prog.out, `prog-${process.pid}-${seq += 1}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...prog, spawner: undefined, ...extra, steps }));
  return file;
}

function hook(arg) {
  return new Promise((resolve) => {
    const c = spawn(prog.shell, ['-c', `sh "${prog.hook}" ${arg}`], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    c.stdin.on('error', () => {});
    c.stdin.end('{}');
    c.on('close', resolve);
  });
}

if (prog.spawner) {
  // Left behind: wait until the shell that started this is gone and it has a new parent.
  for (let i = 0; i < 400 && process.ppid === prog.spawner; i++) await sleep(10);
}
for (const [op, arg] of prog.steps) {
  if (op === 'hook') await hook(arg);
  else if (op === 'snap') fs.writeFileSync(path.join(prog.out, arg), fs.existsSync(prog.marker) ? fs.readFileSync(prog.marker, 'utf8').trim() : '(none)');
  else if (op === 'nested') spawnSync('/bin/bash', ['-c', `"${process.execPath}" "${SELF}" "${child(arg)}"; true`], { stdio: 'ignore' });
  else if (op === 'detached') {
    // The shell exits at once; the stand-in it leaves behind learns the shell's pid from the
    // program file, which the shell rewrites with its own $$ before it goes.
    const file = child(arg, { spawner: 0 });
    spawnSync('/bin/sh', ['-c', `sed -i "s/\\"spawner\\":0/\\"spawner\\":$$/" "${file}"; setsid nohup "${process.execPath}" "${SELF}" "${file}" >/dev/null 2>&1 </dev/null &`], { stdio: 'ignore' });
  } else if (op === 'terminal') {
    // Left behind too, but with a terminal of its own, as under screen or dtach: script(1)
    // gives it a pty. The subshell outlives the shell that started it, so script, and the
    // stand-in under it, start with init as their ancestor.
    spawnSync('/bin/sh', ['-c', `(sleep 0.2; exec setsid script -qc "'${process.execPath}' '${SELF}' '${child(arg)}'" /dev/null >/dev/null 2>&1 </dev/null) &`], { stdio: 'ignore' });
  } else if (op === 'await') { for (let i = 0; i < 1000 && !fs.existsSync(path.join(prog.out, arg)); i++) await sleep(10); } else if (op === 'touch') fs.writeFileSync(path.join(prog.out, arg), '');
}
