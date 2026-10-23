//! Small shared pieces of the maintenance verbs (`integrity`, `install`): UTC time stamps without a time crate, and the
//! `<UTC time> event=<id> key=value ...` record every one of them appends to its log.

use crate::util::now_ms;
use std::fs;
use std::io::Write;
use std::path::Path;

pub fn epoch_s() -> u64 {
    now_ms() / 1000
}

/// (year, month, day, hour, minute, second) of a unix time in UTC.
fn civil(t: u64) -> (u64, u64, u64, u64, u64, u64) {
    let days = t / 86400;
    let rem = t % 86400;
    // days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn stamp_log(t: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(t);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

pub fn stamp_name(t: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(t);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

/// `key=value key=value ...` of the leading pairs and then the rest.
pub fn pairs(head: &[(&str, &str)], rest: &[(&str, &str)]) -> String {
    let all: Vec<String> = head.iter().chain(rest).map(|(k, v)| format!("{k}={v}")).collect();
    all.join(" ")
}


/// Append one record to `path`; the file is cut back to its last `keep` lines first when it is larger than `max` bytes.
pub fn append(path: &Path, max: u64, keep: usize, event: &str, kv: &[(&str, &str)]) {
    if fs::metadata(path).is_ok_and(|m| m.len() > max)
        && let Ok(t) = fs::read_to_string(path)
    {
        let lines: Vec<&str> = t.lines().collect();
        let from = lines.len().saturating_sub(keep);
        let mut body = lines[from..].join("\n");
        body.push('\n');
        let _ = fs::write(path, body);
    }
    let line = format!("{} {}", stamp_log(epoch_s()), pairs(&[("event", event)], kv));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Append one free-text line (with a time stamp) to `path`, cut back like [`append`].
pub fn append_line(path: &Path, max: u64, keep: usize, line: &str) {
    if fs::metadata(path).is_ok_and(|m| m.len() > max)
        && let Ok(t) = fs::read_to_string(path)
    {
        let lines: Vec<&str> = t.lines().collect();
        let from = lines.len().saturating_sub(keep);
        let mut body = lines[from..].join("\n");
        body.push('\n');
        let _ = fs::write(path, body);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {line}", stamp_log(epoch_s()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_time_matches_known_dates() {
        assert_eq!(stamp_log(0), "1970-01-01T00:00:00Z");
        assert_eq!(stamp_log(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(stamp_name(1_796_000_000), "20261130T005320Z");
    }
}
