//! One printer for `String(number)`: every number-to-text path that must match Node goes through
//! `checks::jsport::num::to_js_string`. This compares it with Node on 16,000 numbers (including the
//! halfway ties where two shortest candidates are equally close), and fails when a new ad-hoc f64 formatter appears.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// 16,000 doubles: ms timestamps with k/4096 fractions (halfway ties), small dyadic fractions, random bit patterns, negatives.
fn corpus() -> Vec<f64> {
    let mut vals: Vec<f64> = Vec::new();
    let mut x = 88172645463325252u64;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for j in 0..4000u64 {
        vals.push(1_791_521_392_533.0 + (next() % 4096) as f64 / 4096.0 + j as f64);
        vals.push((next() % 100_000) as f64 / 32.0);
        vals.push(f64::from_bits(next() & 0x7fef_ffff_ffff_ffff));
        vals.push(-((next() % 1_000_000) as f64) / 64.0);
    }
    vals
}

fn node_text(vals: &[f64]) -> Vec<String> {
    let input: String = vals.iter().map(|v| format!("{}\n", v.to_bits())).collect();
    let script = "const l=require('fs').readFileSync(0,'utf8').split('\\n').filter(Boolean);const b=new DataView(new ArrayBuffer(8));\
        process.stdout.write(l.map(s=>{b.setBigUint64(0,BigInt(s));return String(b.getFloat64(0))}).join('\\n')+'\\n')";
    let mut child = Command::new("node").args(["-e", script]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect()
}

fn differ(name: &str, f: &dyn Fn(f64) -> String) -> usize {
    let vals = corpus();
    let theirs = node_text(&vals);
    assert_eq!(vals.len(), theirs.len());
    let bad: Vec<_> = vals.iter().zip(&theirs).filter(|(v, t)| v.is_finite() && f(**v) != **t).collect();
    eprintln!("PRINTER {name}: {} of {} differ, first {:?}", bad.len(), vals.len(), &bad[..bad.len().min(2)]);
    bad.len()
}

#[test]
fn the_one_printer_matches_javascript_on_16000_numbers() {
    if !have_node() {
        return;
    }
    assert_eq!(differ("num::to_js_string", &ah_engine::checks::jsport::num::to_js_string), 0);
}

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
