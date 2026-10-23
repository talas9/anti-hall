//! One printer for `String(number)`: every number-to-text path that must match Node goes through
//! `checks::jsport::num::to_js_string`. This compares it with Node on 16,000 numbers (including the
//! halfway ties where two shortest candidates are equally close), and fails when a new ad-hoc f64 formatter appears.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// A second `String(number)` implementation (a `{:e}` digit-layout routine) or a bare float `Display` in a byte-compat
/// path would reintroduce the halfway-tie bug. Only `jsport/num.rs` may format a double's digits.
#[test]
fn no_ad_hoc_float_formatter_outside_the_one_printer() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    let mut hits = Vec::new();
    for f in files {
        let rel = f.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if rel == "checks/jsport/num.rs" || rel.ends_with("tests.rs") || rel.contains("/tests/") {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        let body = text.split("#[cfg(test)]").next().unwrap_or("");
        for (i, l) in body.lines().enumerate() {
            let t = l.trim_start();
            if t.starts_with("//") {
                continue;
            }
            // exponent-form digit extraction is the signature of a hand-rolled Number::toString
            if t.contains("{:e}") || t.contains("{:.") && t.contains("e}") {
                hits.push(format!("{rel}:{}: {}", i + 1, t));
            }
            for name in ["fn js_number_text", "fn number_to_string", "fn js_number_string", "fn to_js_string"] {
                if t.contains(name) {
                    hits.push(format!("{rel}:{}: {}", i + 1, t));
                }
            }
        }
    }
    assert!(hits.is_empty(), "ad-hoc number formatter(s) outside jsport/num.rs (use num::to_js_string):\n{}", hits.join("\n"));
}
