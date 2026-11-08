//! One capped tail read of a transcript file, the way `hooks/lib/transcript-tail.js` `readTail` and the emit-dedupe
//! tail scan do it: the last `max` bytes, decoded lossily, split on newlines, the first (possibly partial) line dropped
//! when the file is larger than the window.
use std::io::{Read, Seek, SeekFrom};

/// The lines of the last `max` bytes of `path`, one at a time, and the file's size; `None` when the file is missing,
/// unreadable or empty. Only one line is held at a time, so a scan that folds the lines into a small state never holds the
/// window. The lines are exactly those of splitting the lossily decoded window on `\n` (the possibly partial first line
/// dropped when the window is smaller than the file, the empty last element after a final newline kept). A read error ends
/// the stream early, as a short read ended the old whole-window read.
pub fn tail_lines(path: &str, max: u64) -> Option<(TailLines, u64)> {
    tail_lines_bounded(path, max, 0)
}

/// [`tail_lines`] with a bound on the line held: a line over `line_max` bytes (0 = no bound) is read past without being held and
/// yielded as an empty line, so the line count and the offsets of the others stay what they were; [`TailLines::skipped`] says how
/// many there were, and a caller whose answer a skipped line could change answers unsure.
pub fn tail_lines_bounded(path: &str, max: u64, line_max: u64) -> Option<(TailLines, u64)> {
    // the turn is held until the line stream drops, so one window is being read at a time in the daemon
    let turn = crate::transcript::scan::permit();
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    crate::load::note_scan(n);
    let mut t = TailLines {
        rd: std::io::BufReader::with_capacity(crate::defaults::num("guardkit.tail_reader_buf_bytes") as usize, f.take(n)),
        buf: Vec::new(),
        line_max,
        skipped: 0,
        ended_with_newline: true,
        done: false,
        _turn: turn,
    };
    if size > n {
        t.next();
    }
    Some((t, size))
}

/// The line stream of [`tail_lines`].
pub struct TailLines {
    rd: std::io::BufReader<std::io::Take<std::fs::File>>,
    buf: Vec<u8>,
    line_max: u64,
    skipped: u64,
    ended_with_newline: bool,
    done: bool,
    _turn: crate::transcript::scan::Permit,
}

impl TailLines {
    /// Lines over the bound that were read past unheld so far.
    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}

impl Iterator for TailLines {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        match crate::checks::agent_scan::read_line_bounded(&mut self.rd, &mut self.buf, self.line_max) {
            Ok(None) | Err(_) => {
                self.done = true;
                // a window that ended on a newline has one more, empty, element
                std::mem::take(&mut self.ended_with_newline).then(String::new)
            }
            Ok(Some(l)) => {
                self.ended_with_newline = l.newline;
                if l.oversize {
                    self.skipped += 1;
                    return Some(String::new());
                }
                // the line's own bytes become the string: no second copy of a long line
                Some(match String::from_utf8(std::mem::take(&mut self.buf)) {
                    Ok(t) => t,
                    Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
                })
            }
        }
    }
}

/// The lines of the last `max` bytes of `path` and the file's size, all held at once (see [`tail_lines`] to stream them).
pub fn read_tail(path: &str, max: u64) -> Option<(Vec<String>, u64)> {
    let (lines, size) = tail_lines(path, max)?;
    Some((lines.collect(), size))
}
