// Throwaway OpenCode V2 recorder behind test/fixtures/opencode-2.3-event-trace.jsonl (see its
// README). Not shipped, not loaded by any test: kept so the recording can be redone.
//
// Install: copy into <config dir>/plugins/ of an ISOLATED OpenCode (its own XDG_CONFIG_HOME,
// XDG_DATA_HOME, XDG_STATE_HOME and tmux server), with TMUXIFIER_RECORD_FILE (the JSONL output)
// and TMUXIFIER_RECORD_DIR (probe directory) in the environment of the TUI that starts the server.
//
// Every plugin setup (OpenCode runs one per project directory in the same process) records:
// every event it receives, the hooks below (logged, never modified), and its own setup. Probes,
// triggered by creating a file in $TMUXIFIER_RECORD_DIR/probe/ (handled by the setup whose
// directory basename is <tag>, then deleted):
//   synthetic@<tag>@<sessionID>@<queue|steer>   ctx.session.synthetic, text = file content
//   skill@<tag>                                 ctx.skill.transform(editor.add(...)), content = file
// Each probe logs { kind: 'probe.<name>', tag, input, result | error }.
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.TMUXIFIER_RECORD_FILE;
const DIR = process.env.TMUXIFIER_RECORD_DIR;

function log(entry) {
  if (!OUT) return;
  try {
    fs.appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);
  } catch { /* never throw into OpenCode */ }
}

const plain = (v) => {
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
};

async function hook(domain, name, tag, reg) {
  try {
    if (typeof domain?.hook !== 'function') { log({ kind: 'plugin.nohook', tag, name }); return; }
    reg.push(await domain.hook(name, (input) => { log({ kind: `hook.${name}`, tag, input: plain(input) }); }));
  } catch (e) {
    log({ kind: 'plugin.hookerror', tag, name, error: String(e?.stack || e) });
  }
}

async function probe(ctx, tag, file) {
  const full = path.join(DIR, 'probe', file);
  let body = '';
  try { body = fs.readFileSync(full, 'utf8'); fs.unlinkSync(full); } catch { return; }
  const [name, , sessionID, delivery] = file.split('@');
  try {
    if (name === 'synthetic') {
      const input = { sessionID, text: body, delivery: delivery || 'queue', resume: true, metadata: { tmuxifierMail: 'm-aaaaaaaa' } };
      log({ kind: 'probe.synthetic.call', tag, input });
      const result = await ctx.session.synthetic(input);
      log({ kind: 'probe.synthetic', tag, input, result: plain(result) });
    } else if (name === 'skill') {
      const skillPath = path.join(DIR, 'skill', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, body);
      const info = { id: 'tmuxifier-mail', name: 'tmuxifier-mail', description: 'Use when asked to message the agent on another box.', autoinvoke: true, path: skillPath, content: body };
      const result = await ctx.skill.transform((editor) => { editor.add(info); log({ kind: 'probe.skill.list', tag, list: plain(editor.list().map((s) => s.id)) }); });
      log({ kind: 'probe.skill', tag, result: plain(result) });
    }
  } catch (e) {
    log({ kind: `probe.${name}`, tag, error: String(e?.stack || e) });
  }
}

export default {
  id: 'tmuxifier-recorder',
  async setup(ctx) {
    const dir = ctx?.location?.directory ?? null;
    const tag = dir ? path.basename(dir) : 'none';
    const reg = [];
    let stop = false;
    log({ kind: 'plugin.setup', tag, location: plain(ctx?.location), app: plain(ctx?.app), keys: Object.keys(ctx ?? {}), sessionKeys: Object.keys(ctx?.session ?? {}) });
    await hook(ctx.tool, 'execute.before', tag, reg);
    await hook(ctx.tool, 'execute.after', tag, reg);
    await hook(ctx.shell, 'create.before', tag, reg);
    await hook(ctx.permission, 'evaluate', tag, reg);
    await hook(ctx.session, 'prompt', tag, reg);
    await hook(ctx.session, 'experimental.idle', tag, reg);
    (async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          if (stop) break;
          log({ kind: 'event', tag, event: plain(event) });
        }
      } catch (e) {
        log({ kind: 'plugin.subscribe-error', tag, error: String(e) });
      }
    })();
    const timer = setInterval(() => {
      if (!DIR) return;
      let files = [];
      try { files = fs.readdirSync(path.join(DIR, 'probe')); } catch { return; }
      for (const f of files) if (f.split('@')[1] === tag) probe(ctx, tag, f);
    }, 500);
    return async () => {
      stop = true;
      clearInterval(timer);
      log({ kind: 'plugin.cleanup', tag });
      for (const r of reg) { try { await r.dispose(); } catch { /* ignore */ } }
    };
  },
};
