//
// The box-side end of a voice link (spec 2026-09-04): a small program that
// takes 16 kHz S16 mono audio on stdin and keeps the FIFO behind the box's
// ALSA `default` capture device (see claudeVoiceLink.js) supplied with it.
//
// Three rules, each learned against alsa-lib's file plugin:
//  - Open the FIFO O_RDWR: a plain O_WRONLY open blocks until a reader exists,
//    and closing the last writer hands a mid-recording reader a bare EOF,
//    which the plugin turns into a stale-buffer spin.
//  - Shrink the pipe to 4 KB (~128 ms) and write non-blocking, dropping when
//    full: audio is real-time, so anything nobody read is worthless, and this
//    is what keeps Claude from hearing seconds of stale room noise when it
//    opens the device long after the link was armed.
//  - Only ever write or drop even-length runs, so a drop cannot shift the
//    S16 sample alignment for everything after it. Writes are ≤ PIPE_BUF and
//    therefore atomic.
// On stdin EOF it feeds 2.5 s of paced silence — past Claude Code's 2.0 s
// silence-detection window — so a recording in flight ends on silence
// rather than EOF, then exits 0. Exit 3 = the FIFO is missing (box never set
// up), which voiceLinks.js maps to close code 4002.
//
// The program text rides inside a single-quoted shell string, so it must
// never contain a single quote (pinned by test/voiceWriter.test.js), and it
// interpolates nothing: the FIFO path is derived on the box from $HOME.

export const VOICE_FIFO_REL = '.tmuxifier-voice/mic';
export const WRITER_EXIT_NOT_SET_UP = 3;

export const WRITER_PROGRAM = [
  'import fcntl, os, stat, sys, time',
  'p = os.path.join(os.path.expanduser("~"), ".tmuxifier-voice", "mic")',
  'try:',
  '    if not stat.S_ISFIFO(os.stat(p).st_mode):',
  '        sys.exit(3)',
  'except OSError:',
  '    sys.exit(3)',
  'fd = os.open(p, os.O_RDWR | os.O_NONBLOCK)',
  'try:',
  '    fcntl.fcntl(fd, getattr(fcntl, "F_SETPIPE_SZ", 1031), 4096)',
  'except OSError:',
  '    pass',
  'src = sys.stdin.buffer',
  'carry = b""',
  'while True:',
  '    chunk = src.read1(4096)',
  '    if not chunk:',
  '        break',
  '    buf = carry + chunk',
  '    even = len(buf) & ~1',
  '    carry = buf[even:]',
  '    out = buf[:even]',
  '    while out:',
  '        try:',
  '            n = os.write(fd, out[:4096])',
  '        except BlockingIOError:',
  '            break',
  '        out = out[n:]',
  'zeros = bytes(640)',
  't = time.monotonic()',
  'for _ in range(125):',
  '    try:',
  '        os.write(fd, zeros)',
  '    except BlockingIOError:',
  '        pass',
  '    t += 0.02',
  '    d = t - time.monotonic()',
  '    if d > 0:',
  '        time.sleep(d)',
  'os.close(fd)',
  'sys.exit(0)',
].join('\n');

// The remote command. python3 is on every Debian/Ubuntu template; the `cat`
// fallback (Alpine, minimal images) works but can carry up to the pipe's
// default 64 KB of stale audio and blocks its channel while nobody reads —
// documented as degraded. The FIFO check comes first on that path so a box
// that was never set up still exits 3 rather than blocking in open().
export function buildVoiceWriterRemote() {
  return [
    'if command -v python3 >/dev/null 2>&1; then',
    `  exec python3 -c '${WRITER_PROGRAM}'`,
    'else',
    `  [ -p "$HOME/${VOICE_FIFO_REL}" ] || exit ${WRITER_EXIT_NOT_SET_UP}`,
    `  exec cat > "$HOME/${VOICE_FIFO_REL}"`,
    'fi',
  ].join('\n');
}
