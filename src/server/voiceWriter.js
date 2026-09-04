//
// The box-side end of a voice link (spec 2026-09-04): a small program that
// takes 16 kHz S16 mono audio on stdin and keeps the FIFO behind the box's
// ALSA `default` capture device (see claudeVoiceLink.js) supplied with it.
//
// The device the ALSA config names, `~/.tmuxifier-voice/mic`, is a SYMLINK,
// not the FIFO itself. It points at the real FIFO, `mic.fifo`, only while a
// writer holds it — a link writer, or the resident FEEDER a finished link
// leaves behind (below) — and at an ABSENT path, `mic.absent`, otherwise
// (before the first link, and after a clean shutdown). Both halves of that
// rule are load-bearing, and both were learned the hard way:
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
// So a writer NEVER leaves the device unfed: when its link ends it plays a
// 2.5 s silence tail, then forks a detached feeder that holds the FIFO
// O_RDWR and writes paced silence, BLOCKING (zero CPU) while nobody reads —
// an unlinked Space press then reads real-time silence and ends on Claude's
// own "No speech detected". A new link takes the feeder over through the
// pidfile; a clean shutdown (SIGTERM with no successor) parks the device on
// the absent path, where the open simply fails — an error, not a hang and
// not a crash. ensure.sh (installed beside the program by claudeVoiceLink.js
// and run by a Claude Code SessionStart hook) restarts the feeder after a
// reboot.
//
// Three rules for the feed itself, each learned against alsa-lib's file plugin:
//  - Open the FIFO O_RDWR, and before the predecessor is stopped: a plain
//    O_WRONLY open blocks until a reader exists, and a moment with no writer
//    hands a mid-recording reader a bare EOF, which the plugin turns into a
//    stale-buffer spin.
//  - Write in pieces of the reader's own read size (the plugin does one
//    read() per transfer and pads a short one), never larger than the pipe
//    the kernel actually granted (a piece that always fits is never partially
//    written), non-blocking after one piece-time of grace: audio is real-time,
//    so anything nobody read is worthless, and a pipe of two pieces is what
//    keeps Claude from hearing seconds of stale room noise when it opens the
//    device long after the link was armed.
//  - Keep the pipe sample-aligned across partial writes (a zero-byte prefix
//    restores it), so a drop cannot shift the alignment for everything after it.
// On stdin EOF it feeds the 2.5 s tail, forks the feeder (the parent exits 0
// so the ssh session ends), and the feeder runs until superseded or told to
// shut down. Exit 3 = the FIFO is missing (box never set up) or no python3,
// which voiceLinks.js maps to 4002. Run with stdin at /dev/null (ensure.sh)
// the same program is a feeder from the start.
//
// Single writer, enforced on the box by `~/.tmuxifier-voice/writer.pid`: a
// starting writer that finds writer.lock held names itself in writer.next,
// SIGTERMs the pid the file names and retries the lock for up to 3 s. A
// writer (or feeder) superseded that way exits AT ONCE — no silence tail,
// no symlink restore, no pidfile removal — because the successor owns all
// three by then. Without it, the predecessor's 2.5 s tail interleaved with
// the successor's live audio in the same FIFO. A process SIGKILLed without
// cleanup leaves the symlink on the FIFO until the next link or the next
// ensure.sh: both repair it (the writer re-points unconditionally), the
// kernel has already dropped its lock, and a dead pid in the file is stale.
// Exit 4 = the lock could not be taken (its holder is not the pidfile's
// pid), which voiceLinks.js reports as a writer failure.
//
// The program text rides inside a single-quoted shell string, so it must
// never contain a single quote (pinned by test/voiceWriter.test.js), and it
// interpolates nothing: the paths are derived on the box from $HOME.

export const VOICE_DEV_REL = '.tmuxifier-voice/mic';        // the symlink ALSA opens
export const VOICE_FIFO_REL = '.tmuxifier-voice/mic.fifo';  // the real FIFO
export const WRITER_EXIT_NOT_SET_UP = 3;

export const WRITER_PROGRAM = [
  'import array, fcntl, os, select, signal, stat, sys, time',
  'd = os.path.join(os.path.expanduser("~"), ".tmuxifier-voice")',
  'fifo = os.path.join(d, "mic.fifo")',
  'dev = os.path.join(d, "mic")',
  'absent = os.path.join(d, "mic.absent")',
  'pidfile = os.path.join(d, "writer.pid")',
  'nextfile = os.path.join(d, "writer.next")',
  'try:',
  '    if not stat.S_ISFIFO(os.stat(fifo).st_mode):',
  '        sys.exit(3)',
  'except OSError:',
  '    sys.exit(3)',
  // SIGTERM means one of two things, told apart AFTER the unwind by
  // writer.next: a live successor named there (leave the device to it, exit
  // at once), or a shutdown (park the device). The handler raises so a
  // blocking read, write or select — which PEP 475 would otherwise silently
  // resume — unwinds at once. BaseException, not Exception: readint()
  // catches Exception, and a takeover landing inside it must not be swallowed.
  'class Gone(BaseException):',
  '    pass',
  'def bye(signum, frame):',
  '    raise Gone()',
  'signal.signal(signal.SIGTERM, bye)',
  'def readint(path):',
  '    try:',
  '        return int(open(path).read().strip())',
  '    except Exception:',
  '        return 0',
  'def writeint(path, n):',
  '    try:',
  '        tp = path + ".tmp"',
  '        h = open(tp, "w")',
  '        h.write(str(n))',
  '        h.close()',
  '        os.replace(tp, path)',
  '    except OSError:',
  '        pass',
  'def alive(pid):',
  '    try:',
  '        os.kill(pid, 0)',
  '        return True',
  '    except OSError:',
  '        return False',
  // The FIFO is opened BEFORE the predecessor is told to go, so a reader
  // mid-recording never sees a writerless FIFO across the handover: on EOF
  // alsa-lib's file plugin stops blocking and hands the reader stale "audio"
  // at CPU speed (the v1.24.59 spin). O_RDWR: the open never blocks, and
  // this end never sees EOF either.
  'fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)',
  // Single-instance is an flock on writer.lock, held for the process's whole
  // life (and inherited by the forked feeder — same open file description,
  // so the parent's exit does not release it). The kernel drops it on ANY
  // exit, SIGKILL included, so there is no stale-lock case. A starter that
  // cannot take it names itself in writer.next and SIGTERMs the pidfile's
  // holder; the holder's handler reads writer.next to tell a successor
  // (leave everything to it, exit at once) from a shutdown (park the
  // device). Two starters racing — two Claude sessions starting together,
  // each running ensure.sh — therefore always end with exactly one instance.
  'lock = os.open(os.path.join(d, "writer.lock"), os.O_RDWR | os.O_CREAT, 0o600)',
  'got = False',
  'for _ in range(300):',
  '    try:',
  '        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  '        got = True',
  '        break',
  '    except OSError:',
  '        pass',
  '    old = readint(pidfile)',
  '    if old > 0 and old != os.getpid() and alive(old):',
  '        writeint(nextfile, os.getpid())',
  '        try:',
  '            os.kill(old, signal.SIGTERM)',
  '        except OSError:',
  '            pass',
  '    time.sleep(0.01)',
  'if not got:',
  '    sys.exit(4)',
  // A live pid in the file that did not hold the lock is an instance of the
  // pre-lock program (v1.24.60): stop it the old way and wait for it.
  'old = readint(pidfile)',
  'if old > 0 and old != os.getpid() and alive(old):',
  '    writeint(nextfile, os.getpid())',
  '    try:',
  '        os.kill(old, signal.SIGTERM)',
  '        for _ in range(30):',
  '            time.sleep(0.01)',
  '            os.kill(old, 0)',
  '    except OSError:',
  '        pass',
  'writeint(pidfile, os.getpid())',
  'try:',
  '    os.remove(nextfile)',
  'except OSError:',
  '    pass',
  // What the FIFO carries depends on the recipe the install chose, recorded
  // in ~/.tmuxifier-voice/format (see claudeVoiceLink.js):
  //   auto       — the DIRECT recipe: the reader negotiates with the null
  //                slave itself. Claude Code's native capture (cpal) opens
  //                48 kHz FLOAT_LE mono (alsa-lib's WAV tap reports 32-bit
  //                PCM — its header hardcodes tag 1 — but only float32
  //                samples transcribe; int32 read as silence) and reads 4800
  //                frames (19200 bytes, 100 ms) at a time; it takes that
  //                path exactly when /proc/asound/cards lists a card (an LXC
  //                mirrors its host's cards), else it runs `arecord -f
  //                S16_LE -r 16000 -c 1`, whose default period is 125 ms
  //                (4000 bytes). The writer mirrors Claude's own probe.
  //   s16le-rate — the RATE recipe of v1.24.59-60: a plug with a fixed
  //                16 kHz S16 slave, so cpal gets alsa-lib's rate plugin.
  //                Over the clock-less null slave that plugin silently loses
  //                most of any read larger than a frame (measured: 0.41x
  //                real time with 8000-byte pieces) yet copes with one
  //                640-byte frame per write (short reads, padded; ~3x
  //                stretched, transcribable). Chosen when the pipe cannot
  //                be trusted to hold a 19200-byte read (below).
  //   s16le / f32le48k pin one of the direct modes (tests).
  'def mode():',
  '    m = "auto"',
  '    try:',
  '        m = open(os.path.join(d, "format")).read().strip() or "auto"',
  '    except OSError:',
  '        pass',
  '    if m != "auto":',
  '        return m',
  '    try:',
  '        for line in open("/proc/asound/cards"):',
  '            s = line.strip()',
  '            if s and s[0].isdigit():',
  '                return "f32le48k"',
  '    except OSError:',
  '        pass',
  '    return "s16le"',
  'M = mode()',
  'if M == "f32le48k":',
  '    FRAME = 4',
  '    READ = 19200',
  '    BPS = 192000',
  'elif M == "s16le-rate":',
  '    FRAME = 2',
  '    READ = 640',
  '    BPS = 32000',
  'else:',
  '    FRAME = 2',
  '    READ = 4000',
  '    BPS = 32000',
  // Audio goes into the FIFO in read-sized pieces, never frame by frame:
  // alsa-lib's file plugin does ONE read() per transfer and pads a short one
  // with stale data, so a 640-byte frame answering a 19200-byte read reached
  // Claude as 20 ms of speech followed by 80 ms of filler — speech stretched
  // several times, "No speech detected". A piece of the reader's exact read
  // size makes every read full (re-measured: 0 short reads, a verbatim
  // transcript). That needs a pipe of at least one such piece, and the pipe
  // is NOT ours to size: pipe pages are accounted per uid across the whole
  // kernel, an unprivileged LXC's root is the same host uid on every
  // container of that host, and once that uid is over fs.pipe-user-pages-soft
  // (16384 pages) every new pipe is 8 KB and F_SETPIPE_SZ to grow one is
  // EPERM (measured on this host). So: ask for two pieces, then read back
  // what the pipe actually holds and write in pieces no larger than that —
  // a piece that always fits is never partially written, so nothing is
  // dropped. Under an 8 KB pipe a 19200-byte read gets 8192 and is padded:
  // stretched, but intact and in order, which the transcription survives;
  // raising the soft limit on the host restores the full-read path.
  'try:',
  '    fcntl.fcntl(fd, getattr(fcntl, "F_SETPIPE_SZ", 1031), ((2 * READ + 4095) // 4096) * 4096)',
  'except OSError:',
  '    pass',
  'try:',
  '    CAP = fcntl.fcntl(fd, getattr(fcntl, "F_GETPIPE_SZ", 1032))',
  'except OSError:',
  '    CAP = 4096',
  'PIECE = min(READ, CAP) // FRAME * FRAME',
  'STEP = PIECE / float(BPS)',
  'zeros = bytes(PIECE)',
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
  // Piece write. A full pipe is given one piece-time to drain — a reader
  // that exists empties it within microseconds of the previous write, and
  // stdin can hand over several pieces at once (ssh coalesces frames) — and
  // is otherwise dropped: a pipe still full after that has no reader, and
  // stale audio is worthless. A partial write can land a count that is not
  // a whole sample, so the pipe position mod the sample size is tracked and
  // the next write is prefixed with the zero bytes that restore alignment.
  'pos = [0]',
  'def put(data):',
  '    if pos[0]:',
  '        data = bytes(FRAME - pos[0]) + data',
  '    end = time.monotonic() + STEP',
  '    while True:',
  '        try:',
  '            n = os.write(fd, data)',
  '        except BlockingIOError:',
  '            w = end - time.monotonic()',
  '            if w <= 0:',
  '                return',
  '            select.select([], [fd], [], w)',
  '            continue',
  '        pos[0] = (pos[0] + n) % FRAME',
  '        return',
  // The link carries 16 kHz S16_LE; the native path wants 48 kHz FLOAT_LE.
  // Sample-and-hold x3 (Claude decimates back to 16 kHz for its API, so the
  // held samples come back out exactly) and a scale to [-1, 1).
  'def conv(raw):',
  '    if M != "f32le48k":',
  '        return raw',
  '    o = array.array("f")',
  '    for s in array.array("h", raw):',
  '        v = s / 32768.0',
  '        o.append(v)',
  '        o.append(v)',
  '        o.append(v)',
  '    return o.tobytes()',
  // Sleep until the next tick; returns the tick. Drift-free pacing.
  'def pace(t, step):',
  '    t += step',
  '    w = t - time.monotonic()',
  '    if w > 0:',
  '        time.sleep(w)',
  '    return t',
  // How many processes hold the FIFO open for READING (fdinfo access mode
  // 0): a reader mid-recording, which must never be handed EOF.
  'def readers():',
  '    n = 0',
  '    for p in os.listdir("/proc"):',
  '        if not p.isdigit():',
  '            continue',
  '        try:',
  '            for f in os.listdir("/proc/" + p + "/fd"):',
  '                try:',
  '                    if os.readlink("/proc/" + p + "/fd/" + f) != fifo:',
  '                        continue',
  '                    for line in open("/proc/" + p + "/fdinfo/" + f):',
  '                        if line.startswith("flags:") and int(line.split()[1], 8) & 3 == 0:',
  '                            n += 1',
  '                except OSError:',
  '                    pass',
  '        except OSError:',
  '            pass',
  '    return n',
  // Stream: whole pieces as soon as they fill; a partial piece that has
  // waited one piece-time (the link stalled, or ended) goes out padded with
  // silence, so the reader's read is still full.
  'pend = b""',
  'out = b""',
  'due = None',
  'try:',
  '    while True:',
  '        wait = None if due is None else max(0.0, due - time.monotonic())',
  '        r = select.select([0], [], [], wait)[0]',
  '        if not r:',
  '            if out:',
  '                put(out + bytes(PIECE - len(out)))',
  '                out = b""',
  '            due = None',
  '            continue',
  '        chunk = os.read(0, 65536)',
  '        if not chunk:',
  '            break',
  '        pend += chunk',
  '        even = len(pend) & ~1',
  '        out += conv(pend[:even])',
  '        pend = pend[even:]',
  '        while len(out) >= PIECE:',
  '            put(out[:PIECE])',
  '            out = out[PIECE:]',
  '        due = time.monotonic() + STEP if out else None',
  '    if out:',
  '        put(out + bytes(PIECE - len(out)))',
  // The link is over. 2.5 s of paced silence first — past Claude Code's
  // 2.0 s silence-detection window — so a recording in flight ends on
  // silence; non-blocking, so a pipe nobody reads costs nothing.
  '    t = time.monotonic()',
  '    for _ in range(int(2.5 / STEP)):',
  '        put(zeros)',
  '        t = pace(t, STEP)',
  // Then become the resident feeder. The parent records the child's pid and
  // leaves (closing the ssh session), so a successor never finds a dead pid
  // in between; the child detaches from the session entirely and keeps the
  // device fed with paced silence, BLOCKING — zero CPU — while nobody reads.
  // That blocked write is the one state alsa-lib's file plugin neither hangs
  // on (a writerless FIFO) nor spins on (a source that never blocks).
  '    child = os.fork()',
  '    if child > 0:',
  '        writeint(pidfile, child)',
  '        os._exit(0)',
  '    os.setsid()',
  '    null = os.open("/dev/null", os.O_RDWR)',
  '    os.dup2(null, 0)',
  '    os.dup2(null, 1)',
  '    os.dup2(null, 2)',
  '    fl = fcntl.fcntl(fd, fcntl.F_GETFL)',
  '    fcntl.fcntl(fd, fcntl.F_SETFL, fl & ~os.O_NONBLOCK)',
  '    t = time.monotonic()',
  '    while True:',
  '        os.write(fd, zeros)',
  '        now = time.monotonic()',
  '        if now - t > 1.0:',
  '            t = now',
  '        t = pace(t, STEP)',
  'except Gone:',
  '    pass',
  'except Exception:',
  '    pass',
  // Superseded: a live successor is named in writer.next — leave the device,
  // the FIFO and the pidfile to it (the lock goes with this exit). Otherwise
  // this is a shutdown (or a fault): park the device on the absent path so
  // no NEW open blocks or spins on a writerless FIFO — and keep pacing
  // silence for as long as any reader already holds it (capped at 10 min),
  // since closing on a mid-recording reader hands it EOF, the spin.
  'nxt = readint(nextfile)',
  'if nxt > 0 and nxt != os.getpid() and alive(nxt):',
  '    sys.exit(0)',
  'point(absent)',
  'try:',
  '    fl = fcntl.fcntl(fd, fcntl.F_GETFL)',
  '    fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)',
  '    t0 = time.monotonic()',
  '    t = t0',
  '    while time.monotonic() - t0 < 600 and readers():',
  '        put(zeros)',
  '        t = pace(t, STEP)',
  'except BaseException:',
  '    pass',
  'try:',
  '    if readint(pidfile) == os.getpid():',
  '        os.remove(pidfile)',
  'except OSError:',
  '    pass',
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
