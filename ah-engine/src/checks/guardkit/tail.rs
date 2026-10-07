//! One capped tail read of a transcript file, the way `hooks/lib/transcript-tail.js` `readTail` and the emit-dedupe
//! tail scan do it: the last `max` bytes, decoded lossily, split on newlines, the first (possibly partial) line dropped
//! when the file is larger than the window.
use std::io::{BufRead, Read, Seek, SeekFrom};

/// The lines of the last `max` bytes of `path`, one at a time, and the file's size; `None` when the file is missing,
/// unreadable or empty. Only one line is held at a time, so a scan that folds the lines into a small state never holds the
/// window. The lines are exactly those of splitting the lossily decoded window on `\n` (the possibly partial first line
/// dropped when the window is smaller than the file, the empty last element after a final newline kept). A read error ends
/// the stream early, as a short read ended the old whole-window read.
pub fn tail_lines(path: &str, max: u64) -> Option<(TailLines, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut t = TailLines { rd: std::io::BufReader::with_capacity(1 << 16, f.take(n)), buf: Vec::new(), ended_with_newline: true, done: false };
    if size > n {
        t.next();
    }
    Some((t, size))
}

/// The line stream of [`tail_lines`].
pub struct TailLines {
    rd: std::io::BufReader<std::io::Take<std::fs::File>>,
    buf: Vec<u8>,
    ended_with_newline: bool,
    done: bool,
}

impl Iterator for TailLines {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        self.buf.clear();
        match self.rd.read_until(b'\n', &mut self.buf) {
            Ok(0) | Err(_) => {
                self.done = true;
                // a window that ended on a newline has one more, empty, element
                std::mem::take(&mut self.ended_with_newline).then(String::new)
            }
            Ok(_) => {
                self.ended_with_newline = self.buf.last() == Some(&b'\n');
                if self.ended_with_newline {
                    self.buf.pop();
                }
                Some(match std::str::from_utf8(&self.buf) {
                    Ok(t) => t.to_string(),
                    Err(_) => String::from_utf8_lossy(&self.buf).into_owned(),
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
