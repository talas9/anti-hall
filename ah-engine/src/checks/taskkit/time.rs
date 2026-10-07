//! The UTC clock text `new Date().toISOString()` gives, without a date library.
use std::time::{SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar (Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `toISOString()` of the instant `ms` milliseconds after the epoch: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// The current time as milliseconds since the epoch.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values computed with Node: `new Date(ms).toISOString()`.
    #[test]
    fn iso_matches_node_to_iso_string() {
        let cases = [
            (0, "1970-01-01T00:00:00.000Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_791_374_096_789, "2026-10-07T11:54:56.789Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (4_102_444_799_999, "2099-12-31T23:59:59.999Z"),
        ];
        for (ms, want) in cases {
            assert_eq!(iso(ms), want, "{ms}");
        }
    }
}
