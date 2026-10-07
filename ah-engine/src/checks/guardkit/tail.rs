//! One capped tail read of a transcript file, the way `hooks/lib/transcript-tail.js` `readTail` and the emit-dedupe
//! tail scan do it: the last `max` bytes, decoded lossily, split on newlines, the first (possibly partial) line dropped
//! when the file is larger than the window.
use std::io::{Read, Seek, SeekFrom};

/// The lines of the last `max` bytes of `path` and the file's size; `None` when the file is missing, unreadable or empty.
pub fn read_tail(path: &str, max: u64) -> Option<(Vec<String>, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut buf = vec![0u8; n as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf[..got]);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some((lines, size))
}
