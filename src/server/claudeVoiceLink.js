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
//  2. ~/.tmuxifier-voice/mic, the FIFO. Absolute path, resolved on the box
//     from $HOME, because alsa-lib does not expand ~ in `infile`.
//  3. voice.enabled=true in Claude's settings.json — only when no `voice` key
//     exists, so a deliberate /voice off stays off. Same jq → node → python3
//     chain the statusline push uses; a box with none reports it, and still
//     gets the device and the FIFO.

const RC_BODY = [
  'pcm.tmuxifier_mic {',
  '  type file',
  '  slave.pcm "null"',
  '  file "/dev/null"',
  // infile is the one line with a box-side value; it is emitted separately.
  '  format "raw"',
  '}',
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
    'FIFO="$VDIR/mic"',
    "MARK='# tmuxifier-voice-link'",
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'VOICELINK: skipped-no-claude'",
    '  exit 0',
    'fi',
    'cat >/dev/null 2>&1 || true',
    '',
    "# 2. Never touch an operator's own ALSA config.",
    'if [ -f "$RC" ] && ! grep -qF "$MARK" "$RC" 2>/dev/null; then',
    "  echo 'VOICELINK: skipped-asoundrc-exists'",
    '  exit 0',
    'fi',
    '',
    "# 3. The FIFO Claude Code's default capture device reads.",
    'mkdir -p "$VDIR"',
    'chmod 700 "$VDIR"',
    'if [ ! -p "$FIFO" ]; then rm -f "$FIFO"; mkfifo -m 600 "$FIFO"; fi',
    '',
    '# 4. ALSA: default = plug -> file(infile=FIFO) -> null. Atomic write.',
    'TMP="$RC.tmuxifier.tmp"',
    '{',
    '  echo "$MARK"',
    ...RC_BODY.slice(0, 5).map((l) => `  echo '${l}'`),
    '  echo "  infile \\"$FIFO\\""',
    ...RC_BODY.slice(5).map((l) => `  echo '${l}'`),
    '} > "$TMP"',
    'chmod 600 "$TMP"',
    'mv "$TMP" "$RC"',
    '',
    "# 5. Turn Claude Code's voice mode on, once, only where no choice exists yet.",
    'RESULT=kept',
    'if [ ! -f "$SETTINGS" ]; then',
    '  mkdir -p "$DIR"',
    '  printf \'{"voice":{"enabled":true}}\\n\' > "$SETTINGS"',
    '  chmod 600 "$SETTINGS"',
    '  RESULT=applied',
    'elif command -v jq >/dev/null 2>&1; then',
    '  if [ "$(jq -r \'has("voice")\' "$SETTINGS")" = "false" ]; then',
    '    jq \'.voice = {"enabled": true}\' "$SETTINGS" > "$SETTINGS.tmuxifier.tmp" && mv "$SETTINGS.tmuxifier.tmp" "$SETTINGS"',
    '    RESULT=applied',
    '  fi',
    'elif command -v node >/dev/null 2>&1; then',
    '  RESULT=$(node -e \'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));if(Object.prototype.hasOwnProperty.call(d,"voice")){process.stdout.write("kept");process.exit(0)}d.voice={enabled:true};const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p);process.stdout.write("applied")\' "$SETTINGS") || RESULT=error-settings-parse',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  RESULT=$(python3 -c \'import json,sys,os',
    'p=sys.argv[1];d=json.load(open(p))',
    'if "voice" in d:',
    '    print("kept",end="");sys.exit(0)',
    'd["voice"]={"enabled":True}',
    't=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p);print("applied",end="")\' "$SETTINGS") || RESULT=error-settings-parse',
    'else',
    '  RESULT=error-no-json-tool',
    'fi',
    'echo "VOICELINK: applied settings=$RESULT"',
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
        const m = /VOICELINK:\s*applied settings=(\S+)/.exec(out);
        if (m) return { target: 'voice-link', ok: true, settings: m[1] };
      }
      return { target: 'voice-link', ok: false, error: 'voice link push failed' };
    },
  };
}
