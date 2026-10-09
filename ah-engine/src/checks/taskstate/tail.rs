//! Bounded tail reads of a transcript, as the Node hooks do them (`readTranscriptTail` in task-guard.js and
//! tasklist-guard.js; the two differ only in the window).
use std::io::{Read, Seek, SeekFrom};

/// The last `window` bytes of the file as text, and whether the file was cut. Everything is read when the file fits.
/// `None` on any read error (Node's `catch` returns null).
pub fn read_tail(path: &str, window: u64) -> Option<(String, bool)> {
    let size = std::fs::metadata(path).ok()?.len();
    crate::load::note_scan(size.min(window));
    if size <= window {
        let bytes = std::fs::read(path).ok()?;
        return Some((crate::checks::guardkit::text::lossy_owned(bytes), false));
    }
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(size - window)).ok()?;
    let mut buf = vec![0u8; window as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => return None,
        }
    }
    buf.truncate(got);
    Some((crate::checks::guardkit::text::lossy_owned(buf), true))
}

/// The lines of a tail the way `data.split(/\r?\n/)` gives them, the possibly partial first line dropped when the file was cut.
pub fn lines_of(data: &str, truncated: bool) -> Vec<&str> {
    let mut lines: Vec<&str> = data.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if truncated && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// `Date.parse(s)` for the timestamps Claude Code writes (`YYYY-MM-DDTHH:MM:SS.mmmZ`, the fraction optional): milliseconds
/// since the epoch. `Ok(None)` is `NaN` (a string no date parser reads); a format only JavaScript's parser could judge is
/// `Err`.
pub fn parse_iso_ms(s: &str) -> crate::checks::taskkit::jsval::R<Option<f64>> {
    use crate::checks::taskkit::jsval::Unsure;
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = b.get(from..from + n)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    let shape = b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && *b.last().unwrap_or(&0) == b'Z'
        && (b.len() == 20 || (b.len() == 24 && b[19] == b'.'));
    if !shape {
        // Without any digit no date parser can read it; anything else might be a legacy format.
        return if s.bytes().any(|c| c.is_ascii_digit()) { Err(Unsure) } else { Ok(None) };
    }
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) = (digits(0, 4), digits(5, 2), digits(8, 2), digits(11, 2), digits(14, 2), digits(17, 2))
    else {
        return Err(Unsure);
    };
    let ms = if b.len() == 24 { digits(20, 3).ok_or(Unsure)? } else { 0 };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return Err(Unsure);
    }
    // days from civil (Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2.rem_euclid(400);
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // a day past the end of its month is not valid ISO; JavaScript would say NaN
    let dim = [31, if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(mo - 1) as usize];
    if d > dim {
        return Err(Unsure);
    }
    Ok(Some(((days * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms) as f64))
}
