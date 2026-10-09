//! The "lab" the sandbox-per-scenario lanes (handover and Codex checks, the task hooks) build their fixtures with, and the
//! comparison of what the two sides leave behind: exit code, stdout, stderr and every file under the sandbox, with paths and
//! near-now timestamps normalized. Both sides run on the SAME absolute path (one after the other), so paths in outputs and
//! encoded directory names agree.

use super::jsjson;
use super::support::*;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(crate) const GITENV: [(&str, &str); 9] = [
    ("GIT_AUTHOR_NAME", "t"),
    ("GIT_AUTHOR_EMAIL", "t@t"),
    ("GIT_COMMITTER_NAME", "t"),
    ("GIT_COMMITTER_EMAIL", "t@t"),
    ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z"),
    ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z"),
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_SYSTEM", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
];

/// Fixture helpers; `base` is the one clock reading of a scenario, so the two runs see the same modification times.
#[derive(Clone, Copy)]
pub(crate) struct Lab {
    pub base: i64,
}

impl Lab {
    /// Write `content` under `root`; with `age` the modification time is `base - age` seconds.
    pub(crate) fn write(&self, root: &Path, rel: &str, content: impl AsRef<[u8]>, age: Option<i64>) -> PathBuf {
        let f = root.join(rel);
        write_file(&f, content.as_ref());
        if let Some(a) = age {
            set_mtime(&f, (self.base - a) as f64);
        }
        f
    }
    pub(crate) fn git(&self, cwd: &Path, args: &[&str]) -> Out {
        let mut c = Command::new("git");
        c.args(args).current_dir(cwd).stdin(Stdio::null());
        for (k, v) in GITENV {
            c.env(k, v);
        }
        let out = c.output().expect("git must be runnable");
        Out {
            code: out.status.code().map_or("sig".into(), |x| x.to_string()),
            out: String::from_utf8_lossy(&out.stdout).to_string(),
            err: String::from_utf8_lossy(&out.stderr).to_string(),
        }
    }
    /// A repository with no files at all: the corpus passed an empty set of files, and an empty commit fails, so it has no commits.
    pub(crate) fn repo_no_files(&self, root: &Path, rel: &str) -> PathBuf {
        let d = root.join(rel);
        std::fs::create_dir_all(&d).expect("repo dir");
        self.git(&d, &["init", "-q", "-b", "main"]);
        self.git(&d, &["add", "-A"]);
        self.git(&d, &["commit", "-q", "-m", "init"]);
        d
    }
    /// A repository `root/rel` with one commit of `files` (default: `a.txt`).
    pub(crate) fn repo(&self, root: &Path, rel: &str, files: &[(&str, &str)]) -> PathBuf {
        let d = root.join(rel);
        std::fs::create_dir_all(&d).expect("repo dir");
        self.git(&d, &["init", "-q", "-b", "main"]);
        let default = [("a.txt", "a\n")];
        for (n, c) in if files.is_empty() { &default[..] } else { files } {
            self.write(&d, n, c, None);
        }
        self.git(&d, &["add", "-A"]);
        self.git(&d, &["commit", "-q", "-m", "init"]);
        d
    }
}

// ---- normalization and comparison ------------------------------------------------------------------------------

/// `Date.parse` of an ISO instant with a `Z` zone (milliseconds since the epoch), `None` where JavaScript gives NaN.
pub(crate) fn iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |a: usize, n: usize| s.get(a..a + n)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut frac_ms = 0;
    if b.get(19) == Some(&b'.') {
        let digits: String = s[20..].chars().take_while(char::is_ascii_digit).collect();
        frac_ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse::<i64>().ok()?;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || se > 59 {
        return None;
    }
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + frac_ms)
}

/// Replace every ISO instant within ten minutes of now by `<NOW>`; any other (a file's fixed mtime, a date in a message) is kept.
pub(crate) fn norm_text(s: &str, root: &str) -> String {
    let re = regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z").unwrap();
    let t = s.replace(root, "$R");
    re.replace_all(&t, |c: &regex::Captures| match iso_ms(&c[0]) {
        Some(ms) if (ms - now_ms() as i64).abs() < 600_000 => "<NOW>".to_string(),
        _ => c[0].to_string(),
    })
    .to_string()
}

const VOLATILE: [&str; 4] = ["checkedAt", "recordedAt", "ts", "lastSweep"];

/// A JSON file: volatile keys are compared as "both recent"; everything else exactly, key order included.
pub(crate) fn norm_json(txt: &str, root: &str, now: f64) -> String {
    let Some(v) = jsjson::parse(txt) else { return norm_text(txt, root) };
    fn walk(x: jsjson::J, now: f64) -> jsjson::J {
        use jsjson::J;
        match x {
            J::Arr(a) => J::Arr(a.into_iter().map(|e| walk(e, now)).collect()),
            J::Obj(o) => J::Obj(
                o.into_iter()
                    .map(|(k, v)| {
                        let nv = match &v {
                            J::Num(n) if VOLATILE.contains(&k.as_str()) => {
                                if (n - now).abs() < 600_000.0 {
                                    J::Str("<NOW>".into())
                                } else {
                                    v.clone()
                                }
                            }
                            J::Num(n) if k == "until" && (n - now - 21_600_000.0).abs() < 600_000.0 => J::Str("<NOW+6H>".into()),
                            _ => walk(v, now),
                        };
                        (k, nv)
                    })
                    .collect(),
            ),
            other => other,
        }
    }
    norm_text(&jsjson::stringify(&walk(v, now)), root)
}

/// Every file under `root` (relative path to normalized text); `.git` directories are only noted.
pub(crate) fn snapshot(root: &Path, now: f64) -> BTreeMap<String, String> {
    let root_s = root.to_string_lossy().to_string();
    let mut out = BTreeMap::new();
    fn walk(d: &Path, rel: &str, root: &str, now: f64, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut ents: Vec<_> = rd.flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let name = e.file_name().to_string_lossy().to_string();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if name == ".git" {
                out.insert(format!("{r}/"), "<git>".into());
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&e.path(), &r, root, now, out);
            } else if ft.is_symlink() {
                let t = std::fs::read_link(e.path()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                out.insert(r, format!("-> {}", norm_text(&t, root)));
            } else {
                let txt = std::fs::read(e.path()).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_else(|_| "<unreadable>".into());
                let v = if name.ends_with(".json") { norm_json(&txt, root, now) } else { norm_text(&txt, root) };
                out.insert(r, v);
            }
        }
    }
    walk(root, "", &root_s, now, &mut out);
    out
}
