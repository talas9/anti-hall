//! Regression guard: no scripted check builds a string one character at a time with `+=` (see `tests/logic_lint.toml`,
//! `[charwise_concat]` for why). Pure file scan of `plugins/anti-hall/engine/logic/**/*.js`; no engine, no HOME.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use std::path::{Path, PathBuf};

fn js_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            js_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "js") {
            out.push(p);
        }
    }
}

#[test]
fn no_check_appends_one_character_at_a_time_to_a_growing_string() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let cfg: toml::Table = std::fs::read_to_string(root.join("tests/logic_lint.toml")).unwrap().parse().unwrap();
    let sec = cfg["charwise_concat"].as_table().unwrap();
    let rhs: Vec<&str> = sec["rhs"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let allow: Vec<&str> = sec["allow"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let re = regex::Regex::new(&format!(r"[A-Za-z_$][A-Za-z_$0-9]* \+= (?:{}) *[;}}]", rhs.join("|"))).unwrap();

    let mut files = Vec::new();
    js_files(&root.parent().unwrap().join("plugins/anti-hall/engine/logic"), &mut files);
    assert!(files.len() > 50, "found only {} logic files: wrong directory?", files.len());
    let mut hits = Vec::new();
    for f in &files {
        let name = f.strip_prefix(root.parent().unwrap().join("plugins/anti-hall/engine/logic")).unwrap().to_string_lossy().into_owned();
        for (i, line) in std::fs::read_to_string(f).unwrap().lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") || !re.is_match(line) {
                continue;
            }
            if allow.iter().any(|a| a.split_once(':').is_some_and(|(file, sub)| file == name && line.contains(sub))) {
                continue;
            }
            hits.push(format!("{name}:{}: {}", i + 1, line.trim()));
        }
    }
    assert!(
        hits.is_empty(),
        "per-character string building (`s += c`) reallocates the whole string each time under QuickJS; push to an array and join('') instead:\n{}",
        hits.join("\n")
    );
}
