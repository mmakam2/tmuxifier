//
// The `voice-link` setup phase (spec 2026-09-04), structural twin of
// claudeAgentHooks.js: a pure script that interpolates nothing, pushed over
// the ControlMaster, with the apply-or-skip decision made ON the box by a
// `command -v claude` check. It makes the box's ALSA `default` capture device
// a FIFO Tmuxifier feeds (voiceWriter.js), so Claude Code's own voice mode —
// whose Linux capture opens ALSA `default` — hears the operator's browser
// mic. Three parts, each idempotent:
//  1. ~/.asoundrc: plug → file(infile=FIFO) → null. Written only when absent
//     or already ours (the marker line); an operator's own config is never
//     touched, and the phase then skips entirely — the link cannot work
//     without owning `default`.
//  2. ~/.tmuxifier-voice/mic, the capture device — a SYMLINK, not the FIFO.
//     Absolute path, resolved on the box from $HOME, because alsa-lib does
//     not expand ~ in `infile`. Idle it points at /dev/zero; the writer
//     (voiceWriter.js) swaps it onto the real FIFO, ~/.tmuxifier-voice/
//     mic.fifo, only while it is alive. A FIFO with no writer BLOCKS the
//     reader's open() forever, which hung every Claude Code Space press on a
//     prepared box with nothing linked; /dev/zero answers with silence at
//     once and Claude's own silence detection ends the recording.
//  3. Claude's settings.json: a SessionStart hook running ensure.sh (so the
//     resident silence feeder — see voiceWriter.js — is restarted after a
//     reboot), merged remove-then-append like the agent hooks; and
//     voice.enabled=true only when no `voice` key exists, so a deliberate
//     /voice off stays off. Same jq → node → python3 chain the statusline push
//     uses; a box with none reports it, and still gets the device and FIFO.
//  4. The writer program and ensure.sh under ~/.tmuxifier-voice/, and the
//     feeder started right away.

import { WRITER_PROGRAM } from './voiceWriter.js';

// ensure.sh, installed beside the writer program: (re)start the resident
// silence feeder unless a feeder or a live link writer already holds the
// pidfile. Run at the end of every install and by a Claude Code SessionStart
// hook, so a reboot never leaves Claude with a device nobody feeds. Quoted
// heredoc on the box: $HOME and $D expand when it RUNS, not when it is written.
const ENSURE_SH = [
  '#!/bin/sh',
  '# tmuxifier-voice-link: keep the idle capture device fed with paced silence.',
  'D="$HOME/.tmuxifier-voice"',
  '[ -p "$D/mic.fifo" ] || exit 0',
  '[ -f "$D/writer.py" ] || exit 0',
  'P=$(cat "$D/writer.pid" 2>/dev/null || echo)',
  'if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then exit 0; fi',
  'command -v python3 >/dev/null 2>&1 || exit 0',
  'if command -v setsid >/dev/null 2>&1; then',
  '  setsid python3 "$D/writer.py" </dev/null >/dev/null 2>&1 &',
  'else',
  '  python3 "$D/writer.py" </dev/null >/dev/null 2>&1 &',
  'fi',
  'exit 0',
];

// The SessionStart hook entry merged into Claude's settings.json: remove any
// entry mentioning tmuxifier-voice, append this one — idempotent, and blind
// to the operator's own hooks (the same rule claudeAgentHooks.js applies).
const HOOK_JSON = '[{"hooks":[{"type":"command","command":"sh \\"$HOME/.tmuxifier-voice/ensure.sh\\""}]}]';

const RC_HEAD = [
  'pcm.tmuxifier_mic {',
  '  type file',
  '  slave.pcm "null"',
  '  file "/dev/null"',
  // infile is the one line with a box-side value; it is emitted separately.
  '  format "raw"',
  '}',
];
// The DIRECT recipe: no fixed slave rate or format, so the reader negotiates
// with the null slave itself and no rate plugin sits in the chain — over a
// clock-less slave alsa-lib's rate plugin silently loses most of every read
// larger than a frame (measured 0.41x). Claude Code then opens 48 kHz float
// and reads 19200 bytes at a time, which needs a pipe that can hold that.
const RC_DEFAULT_DIRECT = [
  'pcm.!default {',
  '  type plug',
  '  slave.pcm "tmuxifier_mic"',
  '}',
];
// The RATE recipe (v1.24.59-60): the slave pinned to 16 kHz S16 mono, so a
// 48 kHz reader gets the rate plugin. The writer then hands it one 640-byte
// frame per write (voiceWriter.js `s16le-rate`), the one shape that plugin
// delivers intact — stretched about 3x but transcribable. Chosen when the
// pipe cannot be trusted to hold a 19200-byte read: pipe pages are
// accounted per uid across the whole kernel, an unprivileged LXC's root is
// the same host uid on every container of that host, and once that uid is
// over fs.pipe-user-pages-soft every new pipe is 8 KB and cannot grow. A
// pipe of two reads that can be grown now is trusted on a box whose uid
// map is the identity (a VM, bare metal) or whose host has disabled the
// soft limit; on any other container the momentary success is not.
const RC_DEFAULT_RATE = [
  'pcm.!default {',
  '  type plug',
  '  slave { pcm "tmuxifier_mic" format S16_LE rate 16000 channels 1 }',
  '}',
];

export function buildVoiceLinkInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'SETTINGS="$DIR/settings.json"',
    'RC="$HOME/.asoundrc"',
    'VDIR="$HOME/.tmuxifier-voice"',
    'DEV="$VDIR/mic"',
    'FIFO="$VDIR/mic.fifo"',
    'ABSENT="$VDIR/mic.absent"',
    "MARK='# tmuxifier-voice-link'",
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'VOICELINK: skipped-no-claude'",
    '  exit 0',
    'fi',
    'cat >/dev/null 2>&1 || true',
    '# ...and only where the python3 writer can run: a shadowing capture device',
    '# with no safe writer is a hazard (voiceWriter.js), not a feature.',
    'if ! command -v python3 >/dev/null 2>&1; then',
    "  echo 'VOICELINK: skipped-no-python3'",
    '  exit 0',
    'fi',
    '',
    "# 2. Never touch an operator's own ALSA config.",
    'if [ -f "$RC" ] && ! grep -qF "$MARK" "$RC" 2>/dev/null; then',
    "  echo 'VOICELINK: skipped-asoundrc-exists'",
    '  exit 0',
    'fi',
    '',
    "# 3. The FIFO Claude Code's default capture device reads — behind a",
    '#    symlink parked on an ABSENT path while idle, so an unlinked open',
    '#    fails. Not a writerless FIFO (open blocks forever) and NOT /dev/zero:',
    '#    alsa-lib paces capture only through a live writer, so a source that',
    '#    never blocks spins at CPU speed and the reader eats all memory.',
    'mkdir -p "$VDIR"',
    'chmod 700 "$VDIR"',
    '# Migrate the pre-symlink layout, where `mic` WAS the FIFO: move it into',
    '# place when nothing is there yet (keeping its mode), else drop it — a',
    '# second FIFO under the old name would have neither reader nor writer.',
    '# -p follows symlinks, so a live `mic -> mic.fifo` is left alone by -L.',
    'if [ -p "$DEV" ] && [ ! -L "$DEV" ]; then',
    '  if [ -e "$FIFO" ]; then rm -f "$DEV"; else mv "$DEV" "$FIFO"; fi',
    'fi',
    'if [ ! -p "$FIFO" ]; then rm -f "$FIFO"; mkfifo -m 600 "$FIFO"; fi',
    '# Only ever replace an absent path or a symlink (a dangling one included:',
    '# -e follows; so is the v1.24.59 /dev/zero link, which is re-pointed). A',
    '# regular file here belongs to the operator and is left alone — the link',
    '# then simply does not work, the same posture the foreign-.asoundrc guard',
    '# above takes.',
    'if [ ! -e "$DEV" ] || [ -L "$DEV" ]; then ln -sfn "$ABSENT" "$DEV"; fi',
    '# The writer program and ensure.sh, so the box can (re)start the resident',
    '# silence feeder on its own. Quoted heredocs: nothing expands.',
    "cat > \"$VDIR/writer.py\" <<'TMUXIFIER_WRITER_EOF'",
    ...WRITER_PROGRAM.split('\n'),
    'TMUXIFIER_WRITER_EOF',
    'chmod 600 "$VDIR/writer.py"',
    "cat > \"$VDIR/ensure.sh\" <<'TMUXIFIER_ENSURE_EOF'",
    ...ENSURE_SH,
    'TMUXIFIER_ENSURE_EOF',
    'chmod 700 "$VDIR/ensure.sh"',
    '',
    '# 4. ALSA: default = plug -> file(infile=DEV) -> null. Atomic write.',
    '#    DEV, not FIFO: alsa-lib opens infile once, so the indirection is what',
    '#    lets the same recipe fail cleanly when idle and read the FIFO when linked.',
    '#    Direct recipe when the pipe can be trusted to hold one 19200-byte read',
    '#    (see the notes on the two recipes), else the rate recipe.',
    "MODE=$(python3 -c '",
    'import os, fcntl, sys',
    'fd = os.open(sys.argv[1], os.O_RDWR | os.O_NONBLOCK)',
    'try:',
    '    fcntl.fcntl(fd, 1031, 40960)',
    'except OSError:',
    '    pass',
    'cap = fcntl.fcntl(fd, 1032)',
    'soft = -1',
    'try:',
    '    soft = int(open("/proc/sys/fs/pipe-user-pages-soft").read().strip())',
    'except Exception:',
    '    pass',
    'ident = True',
    'try:',
    '    ident = open("/proc/self/uid_map").read().split() == ["0", "0", "4294967295"]',
    'except Exception:',
    '    pass',
    'print("auto" if cap >= 40960 and (soft == 0 or ident) else "s16le-rate")',
    "' \"$FIFO\" 2>/dev/null || echo s16le-rate)",
    'printf \'%s\\n\' "$MODE" > "$VDIR/format.tmp" && mv "$VDIR/format.tmp" "$VDIR/format"',
    'TMP="$RC.tmuxifier.tmp"',
    '{',
    '  echo "$MARK"',
    ...RC_HEAD.slice(0, 5).map((l) => `  echo '${l}'`),
    '  echo "  infile \\"$DEV\\""',
    ...RC_HEAD.slice(5).map((l) => `  echo '${l}'`),
    '  if [ "$MODE" = auto ]; then',
    ...RC_DEFAULT_DIRECT.map((l) => `    echo '${l}'`),
    '  else',
    ...RC_DEFAULT_RATE.map((l) => `    echo '${l}'`),
    '  fi',
    '} > "$TMP"',
    'chmod 600 "$TMP"',
    'mv "$TMP" "$RC"',
    '',
    "# 5. Claude settings: the SessionStart hook that keeps the device fed",
    '#    (merged remove-then-append, like the agent hooks), and voice mode on,',
    '#    once, only where no choice exists yet.',
    "HOOK=$(cat <<'TMUXIFIER_VOICE_HOOK_EOF'",
    HOOK_JSON,
    'TMUXIFIER_VOICE_HOOK_EOF',
    ')',
    'RESULT=kept',
    'if [ ! -f "$SETTINGS" ]; then',
    '  mkdir -p "$DIR"',
    '  printf \'{"voice":{"enabled":true},"hooks":{"SessionStart":%s}}\\n\' "$HOOK" > "$SETTINGS"',
    '  chmod 600 "$SETTINGS"',
    '  RESULT=applied',
    'elif command -v jq >/dev/null 2>&1; then',
    '  if [ "$(jq -r \'has("voice")\' "$SETTINGS")" = "false" ]; then RESULT=applied; fi',
    '  jq --argjson new "$HOOK" \'.hooks = (.hooks // {}) | .hooks.SessionStart = ([(.hooks.SessionStart // [])[] | select((tojson | contains("tmuxifier-voice")) | not)] + $new) | if has("voice") then . else .voice = {"enabled": true} end\' "$SETTINGS" > "$SETTINGS.tmuxifier.tmp" && mv "$SETTINGS.tmuxifier.tmp" "$SETTINGS"',
    'elif command -v node >/dev/null 2>&1; then',
    '  RESULT=$(node -e \'const fs=require("fs");const p=process.argv[1];const add=JSON.parse(process.argv[2]);const d=JSON.parse(fs.readFileSync(p,"utf8"));d.hooks=(d.hooks&&typeof d.hooks==="object"&&!Array.isArray(d.hooks))?d.hooks:{};const cur=Array.isArray(d.hooks.SessionStart)?d.hooks.SessionStart:[];d.hooks.SessionStart=cur.filter((e)=>!JSON.stringify(e).includes("tmuxifier-voice")).concat(add);let r="kept";if(!Object.prototype.hasOwnProperty.call(d,"voice")){d.voice={enabled:true};r="applied"}const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p);process.stdout.write(r)\' "$SETTINGS" "$HOOK") || RESULT=error-settings-parse',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  RESULT=$(python3 -c \'import json,sys,os',
    'p=sys.argv[1];add=json.loads(sys.argv[2]);d=json.load(open(p))',
    'h=d.get("hooks") if isinstance(d.get("hooks"),dict) else {}',
    'd["hooks"]=h',
    'cur=h.get("SessionStart") if isinstance(h.get("SessionStart"),list) else []',
    'h["SessionStart"]=[e for e in cur if "tmuxifier-voice" not in json.dumps(e)]+add',
    'r="kept"',
    'if "voice" not in d:',
    '    d["voice"]={"enabled":True};r="applied"',
    't=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p);print(r,end="")\' "$SETTINGS" "$HOOK") || RESULT=error-settings-parse',
    'else',
    '  RESULT=error-no-json-tool',
    'fi',
    '',
    '# 6. Start the resident feeder now, so the box reads silence when nothing',
    '#    is linked from this moment on (a reboot re-runs this from the hook).',
    'sh "$VDIR/ensure.sh" >/dev/null 2>&1 || true',
    'if [ "$MODE" = auto ]; then PIPE=direct; else PIPE=rate; fi',
    'echo "VOICELINK: applied settings=$RESULT pipe=$PIPE"',
  ].join('\n');
}

export function createVoiceLinkPusher({ runStdin }) {
  return {
    async push(box) {
      const res = await runStdin(box, buildVoiceLinkInstallScript(), Buffer.alloc(0));
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/VOICELINK:\s*skipped-no-claude/.test(out)) return { target: 'voice-link', ok: false, skipped: 'no Claude on the box' };
        if (/VOICELINK:\s*skipped-asoundrc-exists/.test(out)) return { target: 'voice-link', ok: false, skipped: 'the box has its own ~/.asoundrc' };
        if (/VOICELINK:\s*skipped-no-python3/.test(out)) return { target: 'voice-link', ok: false, skipped: 'no python3 on the box' };
        const m = /VOICELINK:\s*applied settings=(\S+)(?:\s+pipe=(\S+))?/.exec(out);
        if (m) return { target: 'voice-link', ok: true, settings: m[1], ...(m[2] ? { pipe: m[2] } : {}) };
      }
      return { target: 'voice-link', ok: false, error: 'voice link push failed' };
    },
  };
}
