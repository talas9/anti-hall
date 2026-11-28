//! The one transcript line reader: a fixed buffer, bounded lines, each byte read once.
//!
//! No reader of the store ever holds a window. [`LineReader`] reads a byte range of a file through one buffer of
//! `transcript.read_buf_bytes` and hands out one line at a time. A line is held whole up to `transcript.max_line_bytes`;
//! a longer one is skipped (only its first `transcript.oversize_head_bytes` are kept, so the caller can classify it) and
//! reported as `oversize`. The most memory the reader ever holds is the buffer plus the longest line it kept
//! ([`LineReader::peak_bytes`]), which is the figure the gate bounds (`transcript_read_buf_max_bytes`).
use std::fs::File;
use std::os::unix::fs::FileExt;

/// The sizes a reader works with (read from `defaults/transcript.toml`).
#[derive(Debug, Clone, Copy)]
pub struct ReadCfg {
    /// Size of the one read buffer.
    pub buf: usize,
    /// Longest line held whole.
    pub max_line: usize,
    /// Bytes of a skipped line that are kept.
    pub head: usize,
}

impl ReadCfg {
    /// The shipped sizes.
    pub fn from_defaults() -> ReadCfg {
        use crate::defaults::num;
        ReadCfg {
            buf: num("transcript.read_buf_bytes") as usize,
            max_line: num("transcript.max_line_bytes") as usize,
            head: num("transcript.oversize_head_bytes") as usize,
        }
    }
}

/// One line found by [`LineReader::next_line`]; its bytes are in [`LineReader::bytes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    /// Offset of the line's first byte in the file.
    pub off: u64,
    /// Bytes the line occupies in the file, its newline included.
    pub len: u64,
    /// The line ended with a newline inside the range (an unterminated last line is not consumed by a store).
    pub terminated: bool,
    /// The line was longer than `max_line`: `bytes` holds only its first `head` bytes.
    pub oversize: bool,
}

/// Reads lines of `[from, to)` of one file through a fixed buffer.
pub struct LineReader<'f> {
    file: &'f File,
    cfg: ReadCfg,
    buf: Box<[u8]>,
    filled: usize,
    pos: usize,
    /// File offset of `buf[filled]`: where the next read starts.
    next_read: u64,
    to: u64,
    line_off: u64,
    line: Vec<u8>,
    peak: usize,
}

impl<'f> LineReader<'f> {
    /// A reader of `[from, to)`. `from` must be a line start (the caller resyncs a mid-line start itself).
    pub fn new(file: &'f File, cfg: ReadCfg, from: u64, to: u64) -> LineReader<'f> {
        let size = cfg.buf.max(1);
        LineReader { file, cfg, buf: vec![0u8; size].into_boxed_slice(), filled: 0, pos: 0, next_read: from, to, line_off: from, line: Vec::new(), peak: size }
    }

    /// The bytes of the line [`LineReader::next_line`] returned last (no newline; the first `head` bytes of an oversize line).
    pub fn bytes(&self) -> &[u8] {
        &self.line
    }

    /// The most memory this reader held at once: its buffer plus the line buffer's capacity.
    pub fn peak_bytes(&self) -> usize {
        self.peak
    }

    fn fill(&mut self) -> std::io::Result<bool> {
        if self.next_read >= self.to {
            return Ok(false);
        }
        let want = ((self.to - self.next_read) as usize).min(self.buf.len());
        let n = loop {
            match self.file.read_at(&mut self.buf[..want], self.next_read) {
                Ok(n) => break n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        };
        if n == 0 {
            return Ok(false);
        }
        self.filled = n;
        self.pos = 0;
        self.next_read += n as u64;
        Ok(true)
    }

    fn keep(&mut self, chunk_from: usize, chunk_to: usize, oversize: &mut bool) {
        if *oversize {
            let room = self.cfg.head.saturating_sub(self.line.len());
            let take = room.min(chunk_to - chunk_from);
            self.line.extend_from_slice(&self.buf[chunk_from..chunk_from + take]);
            return;
        }
        let need = self.line.len() + (chunk_to - chunk_from);
        if need > self.cfg.max_line {
            *oversize = true;
            self.line.truncate(self.cfg.head);
            self.line.shrink_to(self.cfg.head);
            let room = self.cfg.head.saturating_sub(self.line.len());
            let take = room.min(chunk_to - chunk_from);
            self.line.extend_from_slice(&self.buf[chunk_from..chunk_from + take]);
            return;
        }
        // grow by doubling, but never past the bound: the default doubling would take up to twice `max_line`
        let want = need.max(self.line.capacity().saturating_mul(2)).min(self.cfg.max_line);
        self.line.reserve_exact(want - self.line.len());
        self.line.extend_from_slice(&self.buf[chunk_from..chunk_to]);
        self.peak = self.peak.max(self.buf.len() + self.line.capacity());
    }

    /// The next line of the range, `None` at its end. An unterminated last line is returned with `terminated` false.
    pub fn next_line(&mut self) -> std::io::Result<Option<Line>> {
        self.line.clear();
        let mut oversize = false;
        let mut len = 0u64;
        let off = self.line_off;
        loop {
            if self.pos >= self.filled && !self.fill()? {
                break;
            }
            let chunk = &self.buf[self.pos..self.filled];
            let (body, used, nl) = match memchr::memchr(b'\n', chunk) {
                Some(i) => (i, i + 1, true),
                None => (chunk.len(), chunk.len(), false),
            };
            let from = self.pos;
            self.keep(from, from + body, &mut oversize);
            self.pos += used;
            len += used as u64;
            if nl {
                self.line_off = off + len;
                return Ok(Some(Line { off, len, terminated: true, oversize }));
            }
        }
        self.line_off = off + len;
        Ok((len > 0).then_some(Line { off, len, terminated: false, oversize }))
    }
}
