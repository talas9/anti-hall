//! The launcher's failure log: a bounded append, written only on a failure or limit path (never per call).
//!
//! At the soft size the file is rotated (one previous file is kept, so the total stays under twice the soft size); at the hard
//! size lines are dropped and the drops counted in a small side file. A failed write (disk full, unwritable home) is ignored:
//! logging must never change what the hook does.

use crate::util::now_ms;
use std::io::Write;
use std::path::PathBuf;

pub struct Log {
    pub path: PathBuf,
    pub drops: PathBuf,
    pub soft: u64,
    pub hard: u64,
    pub line_max: usize,
    pub rotate_min_s: u64,
}

impl Log {
    /// Appends one line (cut to `line_max`). Returns whether it reached the file.
    pub fn append(&self, line: &str) -> bool {
        if self.path.as_os_str().is_empty() {
            return false;
        }
        let size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size >= self.hard {
            self.count_drop();
            return false;
        }
        if size >= self.soft {
            let mut old = self.path.clone().into_os_string();
            old.push(".1");
            let old = PathBuf::from(old);
            let age_s = std::fs::metadata(&old)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map_or(u64::MAX, |d| d.as_secs());
            if age_s >= self.rotate_min_s {
                let _ = std::fs::rename(&self.path, old);
            }
        }
        let mut text = format!("{} {}", now_ms(), line);
        if text.len() > self.line_max {
            let mut cut = self.line_max;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        text.push('\n');
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .is_ok()
    }

    fn count_drop(&self) {
        let n = std::fs::read_to_string(&self.drops)
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let _ = std::fs::write(&self.drops, format!("{}\n", n.saturating_add(1)));
    }

    #[cfg(test)]
    pub fn dropped(&self) -> u64 {
        std::fs::read_to_string(&self.drops)
            .ok()
            .and_then(|t| t.trim().parse().ok())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(tag: &str, soft: u64, hard: u64, rotate_min_s: u64) -> Log {
        let d =
            std::env::temp_dir().join(format!("ah-blog-{tag}-{}-{}", std::process::id(), now_ms()));
        Log {
            path: d.join("l.log"),
            drops: d.join("l.drops"),
            soft,
            hard,
            line_max: 64,
            rotate_min_s,
        }
    }

    #[test]
    fn rotates_at_soft_then_drops_at_hard_and_counts() {
        let l = log("rot", 200, 400, 3600);
        for i in 0..40 {
            l.append(&format!("line {i} xxxxxxxxxxxxxxxxxxxx"));
        }
        let size = std::fs::metadata(&l.path).unwrap().len();
        assert!(size <= 400 + 64, "size {size}");
        assert!(
            l.dropped() > 0,
            "a flood inside the rotation interval is dropped and counted"
        );
        // fill to the hard size, then every further line is dropped and counted
        while std::fs::metadata(&l.path).map(|m| m.len()).unwrap_or(0) < 400 {
            l.append("fill fill fill fill fill fill fill");
        }
        let before = l.dropped();
        assert!(!l.append("dropped"));
        assert!(!l.append("dropped"));
        assert_eq!(l.dropped(), before + 2);
        assert!(
            !std::fs::read_to_string(&l.path)
                .unwrap()
                .contains("dropped")
        );
    }

    #[test]
    fn rotates_at_soft_when_the_interval_allows() {
        let l = log("rot2", 200, 100_000, 0);
        for i in 0..40 {
            l.append(&format!("line {i} xxxxxxxxxxxxxxxxxxxx"));
        }
        let mut old = l.path.clone().into_os_string();
        old.push(".1");
        assert!(PathBuf::from(old).exists(), "rotated file kept");
        assert!(std::fs::metadata(&l.path).unwrap().len() < 400);
    }

    #[test]
    fn long_lines_are_cut_and_unwritable_dir_is_silent() {
        let l = log("cut", 1 << 20, 1 << 21, 0);
        assert!(l.append(&"y".repeat(1000)));
        assert!(
            std::fs::read_to_string(&l.path)
                .unwrap()
                .lines()
                .all(|x| x.len() <= 64)
        );
        let bad = Log {
            path: PathBuf::from("/proc/none/x/l.log"),
            drops: PathBuf::from("/proc/none/x/d"),
            soft: 10,
            hard: 20,
            line_max: 64,
            rotate_min_s: 0,
        };
        assert!(!bad.append("x"));
    }
}
