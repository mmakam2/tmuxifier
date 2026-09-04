//
// The box-side end of a voice link (spec 2026-09-04): a small program that
// takes 16 kHz S16 mono audio on stdin and keeps the FIFO behind the box's
// ALSA `default` capture device (see claudeVoiceLink.js) supplied with it.
//
// The device the ALSA config names, `~/.tmuxifier-voice/mic`, is a SYMLINK,
// not the FIFO itself. Idle it points at /dev/zero; only while a writer is
// alive does it point at the real FIFO, `mic.fifo`. That indirection is the
// whole reason a Claude Code press works on a prepared box with nothing
// linked: alsa-lib's file plugin opens `infile` O_RDONLY, and opening a FIFO
// with no writer BLOCKS FOREVER — every Space press on an unlinked box hung
// in snd_pcm_open. /dev/zero answers instantly with silence and never EOFs,
// so Claude's own silence detection ends the recording with "No speech
// detected" instead of hanging.
//
// Three rules for the feed itself, each learned against alsa-lib's file plugin:
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
// rather than EOF, then restores the idle symlink and exits 0. Exit 3 = the
// FIFO is missing (box never set up), which voiceLinks.js maps to 4002.
//
// Single writer, enforced on the box by `~/.tmuxifier-voice/writer.pid`: a
// starting writer SIGTERMs whatever live pid the file names and waits ~300 ms
// for it to go. A writer that is superseded that way exits AT ONCE — no
// silence tail, no symlink restore, no pidfile removal — because the
// successor owns all three by then. Without it, the predecessor's 2.5 s tail
// interleaved with the successor's live audio in the same FIFO. A writer
// SIGKILLed without cleanup leaves the symlink on the FIFO until the next
// link: the next writer always repairs it (it re-points unconditionally) and
// treats a dead pid in the file as stale.
//
// The program text rides inside a single-quoted shell string, so it must
// never contain a single quote (pinned by test/voiceWriter.test.js), and it
// interpolates nothing: the paths are derived on the box from $HOME.

export const VOICE_DEV_REL = '.tmuxifier-voice/mic';        // the symlink ALSA opens
export const VOICE_FIFO_REL = '.tmuxifier-voice/mic.fifo';  // the real FIFO
export const WRITER_EXIT_NOT_SET_UP = 3;

export const WRITER_PROGRAM = [
  'import fcntl, os, signal, stat, sys, time',
  'd = os.path.join(os.path.expanduser("~"), ".tmuxifier-voice")',
  'fifo = os.path.join(d, "mic.fifo")',
  'dev = os.path.join(d, "mic")',
  'pidfile = os.path.join(d, "writer.pid")',
  'try:',
  '    if not stat.S_ISFIFO(os.stat(fifo).st_mode):',
  '        sys.exit(3)',
  'except OSError:',
  '    sys.exit(3)',
  // A superseding writer SIGTERMs us. The handler raises, so a blocking stdin
  // read — which PEP 475 would otherwise silently resume — unwinds at once.
  // BaseException, not Exception, deliberately: readpid() below catches
  // Exception, and a takeover request landing inside it must not be swallowed
  // into "no predecessor" — that would leave two writers feeding one FIFO.
  'class Gone(BaseException):',
  '    pass',
  'gone = []',
  'def bye(signum, frame):',
  '    gone.append(1)',
  '    raise Gone()',
  'signal.signal(signal.SIGTERM, bye)',
  'def readpid():',
  '    try:',
  '        return int(open(pidfile).read().strip())',
  '    except Exception:',
  '        return 0',
  'old = readpid()',
  'if old > 0 and old != os.getpid():',
  '    try:',
  '        os.kill(old, 0)',
  '        alive = True',
  '    except OSError:',
  '        alive = False',
  '    if alive:',
  '        try:',
  '            os.kill(old, signal.SIGTERM)',
  '            for _ in range(30):',
  '                time.sleep(0.01)',
  '                os.kill(old, 0)',
  '        except OSError:',
  '            pass',
  'try:',
  '    tp = pidfile + ".tmp"',
  '    h = open(tp, "w")',
  '    h.write(str(os.getpid()))',
  '    h.close()',
  '    os.replace(tp, pidfile)',
  'except OSError:',
  '    pass',
  'fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)',
  'try:',
  '    fcntl.fcntl(fd, getattr(fcntl, "F_SETPIPE_SZ", 1031), 4096)',
  'except OSError:',
  '    pass',
  // Atomic symlink swap: build it under a temp name, rename it over the
  // device. Never fatal — a failure costs the link, not the process.
  'def point(target):',
  '    tmp = os.path.join(d, "mic.tmp")',
  '    try:',
  '        os.remove(tmp)',
  '    except OSError:',
  '        pass',
  '    try:',
  '        os.symlink(target, tmp)',
  '        os.replace(tmp, dev)',
  '    except OSError:',
  '        pass',
  'point(fifo)',
  'src = sys.stdin.buffer',
  'carry = b""',
  'try:',
  '    while True:',
  '        chunk = src.read1(4096)',
  '        if not chunk:',
  '            break',
  '        buf = carry + chunk',
  '        even = len(buf) & ~1',
  '        carry = buf[even:]',
  '        out = buf[:even]',
  '        while out:',
  '            try:',
  '                n = os.write(fd, out[:4096])',
  '            except BlockingIOError:',
  '                break',
  '            out = out[n:]',
  '    zeros = bytes(640)',
  '    t = time.monotonic()',
  '    for _ in range(125):',
  '        if gone:',
  '            break',
  '        try:',
  '            os.write(fd, zeros)',
  '        except BlockingIOError:',
  '            pass',
  '        t += 0.02',
  '        w = t - time.monotonic()',
  '        if w > 0:',
  '            time.sleep(w)',
  'except Gone:',
  '    pass',
  'if not gone:',
  '    point("/dev/zero")',
  '    if readpid() == os.getpid():',
  '        try:',
  '            os.remove(pidfile)',
  '        except OSError:',
  '            pass',
  'os.close(fd)',
  'sys.exit(0)',
].join('\n');

// The remote command. python3 is on every Debian/Ubuntu template; the `cat`
// fallback (Alpine, minimal images) mirrors the minimum — point the device at
// the FIFO, feed it, point it back at /dev/zero — but has no pidfile (so two
// links interleave rather than the newer one taking over) and no silence
// tail, can carry up to the pipe's default 64 KB of stale audio, and blocks
// its channel while nobody reads. Documented as degraded. The FIFO check
// comes first on that path so a box that was never set up still exits 3
// rather than blocking in open().
export function buildVoiceWriterRemote() {
  return [
    'if command -v python3 >/dev/null 2>&1; then',
    `  exec python3 -c '${WRITER_PROGRAM}'`,
    'else',
    `  [ -p "$HOME/${VOICE_FIFO_REL}" ] || exit ${WRITER_EXIT_NOT_SET_UP}`,
    `  ln -sfn mic.fifo "$HOME/${VOICE_DEV_REL}"`,
    `  cat > "$HOME/${VOICE_FIFO_REL}"`,
    `  ln -sfn /dev/zero "$HOME/${VOICE_DEV_REL}"`,
    'fi',
  ].join('\n');
}
