//
// The box-side end of a voice link (spec 2026-09-04): a small program that
// takes 16 kHz S16 mono audio on stdin and keeps the FIFO behind the box's
// ALSA `default` capture device (see claudeVoiceLink.js) supplied with it.
//
// The device the ALSA config names, `~/.tmuxifier-voice/mic`, is a SYMLINK,
// not the FIFO itself. Idle it points at an ABSENT path, `mic.absent`; only
// while a writer is alive does it point at the real FIFO, `mic.fifo`. Both
// halves of that rule are load-bearing, and both were learned the hard way:
//  - A FIFO with no writer BLOCKS FOREVER in snd_pcm_open (alsa-lib's file
//    plugin opens `infile` O_RDONLY), so every Space press on an unlinked
//    box hung.
//  - A source that never blocks is WORSE. alsa-lib's null slave has no clock:
//    the only pacing capture ever has is a live writer on the FIFO. Pointed
//    at /dev/zero (v1.24.59), capture returned 331 MILLION frames per second
//    on this host — 20,000× real time — and Claude Code buffered that
//    "silence" until the box, and then the Proxmox host, ran out of memory.
//    EOF does the same: the plugin returns stale buffer contents in a tight
//    loop once the last writer closes.
// So idle = absent (the open fails, Claude reports no device — an error, not
// a hang and not a crash), and a writer NEVER leaves a reader behind: after
// its 2.5 s silence tail it keeps pacing zeros for as long as any O_RDONLY
// holder of the FIFO remains (scanned via /proc, capped at 10 minutes), and
// only then parks the device and exits.
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
// rather than EOF, keeps pacing while a reader holds the FIFO (above), then
// parks the idle symlink and exits 0. Exit 3 = the FIFO is missing (box never
// set up) or no python3, which voiceLinks.js maps to 4002.
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
  'absent = os.path.join(d, "mic.absent")',
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
  // Is any process other than us holding the FIFO open for reading? The
  // alsa-lib reader opens it O_RDONLY; a successor writer holds it O_RDWR and
  // must not count, so the access mode from fdinfo decides. Same user, same
  // container, so /proc/<pid>/fd is readable; anything unreadable is skipped.
  'def readers():',
  '    try:',
  '        st = os.stat(fifo)',
  '        pids = os.listdir("/proc")',
  '    except OSError:',
  '        return False',
  '    me = str(os.getpid())',
  '    for p in pids:',
  '        if not p.isdigit() or p == me:',
  '            continue',
  '        fdd = "/proc/" + p + "/fd"',
  '        try:',
  '            names = os.listdir(fdd)',
  '        except OSError:',
  '            continue',
  '        for n in names:',
  '            try:',
  '                s2 = os.stat(fdd + "/" + n)',
  '            except OSError:',
  '                continue',
  '            if s2.st_ino != st.st_ino or s2.st_dev != st.st_dev:',
  '                continue',
  '            try:',
  '                info = open("/proc/" + p + "/fdinfo/" + n).read()',
  '            except OSError:',
  '                continue',
  '            for line in info.split("\\n"):',
  '                if line.startswith("flags:"):',
  '                    if int(line.split()[1], 8) & 3 == 0:',
  '                        return True',
  '    return False',
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
  // The tail is over, but a reader mid-recording must never see EOF (spin).
  // Keep pacing silence while anyone holds the FIFO for reading; rescan /proc
  // every ~240 ms; give up after 10 minutes so a wedged reader cannot pin us.
  '    t0 = time.monotonic()',
  '    while not gone and time.monotonic() - t0 < 600 and readers():',
  '        for _ in range(12):',
  '            if gone:',
  '                break',
  '            try:',
  '                os.write(fd, zeros)',
  '            except BlockingIOError:',
  '                pass',
  '            t += 0.02',
  '            w = t - time.monotonic()',
  '            if w > 0:',
  '                time.sleep(w)',
  'except Gone:',
  '    pass',
  'if not gone:',
  '    point(absent)',
  '    if readpid() == os.getpid():',
  '        try:',
  '            os.remove(pidfile)',
  '        except OSError:',
  '            pass',
  'os.close(fd)',
  'sys.exit(0)',
].join('\n');

// The remote command. python3 only: there is no `cat` fallback any more,
// because `cat` cannot honour the reader-hold rule above — it would close the
// FIFO the instant the link ended and hand a mid-recording Claude Code an
// EOF, which is the memory-exhausting spin this module exists to prevent. A
// box without python3 exits 3 (voiceLinks.js: 4002 not-set-up), and the
// setup phase (claudeVoiceLink.js) never installs the shadowing device on
// such a box in the first place.
export function buildVoiceWriterRemote() {
  return [
    'if command -v python3 >/dev/null 2>&1; then',
    `  exec python3 -c '${WRITER_PROGRAM}'`,
    'else',
    `  exit ${WRITER_EXIT_NOT_SET_UP}`,
    'fi',
  ].join('\n');
}
