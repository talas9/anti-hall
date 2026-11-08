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

/// The rule as a regex, from `tests/logic_lint.toml` `[charwise_concat]` (`atom` and `forms`).
fn rule(sec: &toml::Table) -> regex::Regex {
    let atom = sec["atom"].as_str().unwrap();
    let forms: Vec<String> = sec["forms"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().replace("{ATOM}", atom)).collect();
    regex::Regex::new(&format!(r"[A-Za-z_$][A-Za-z_$0-9.\[\]]* *\+= *(?:{}) *[;}}]", forms.join("|"))).unwrap()
}

fn config() -> toml::Table {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(root.join("tests/logic_lint.toml")).unwrap().parse::<toml::Table>().unwrap()["charwise_concat"].as_table().unwrap().clone()
}

#[test]
fn the_rule_flags_the_shapes_it_names_and_leaves_ordinary_appends_alone() {
    let sec = config();
    let re = rule(&sec);
    let cells = sec["cell"].as_array().unwrap();
    assert!(cells.len() >= 10, "the rule needs its pinned cells");
    for c in cells {
        let (line, flag) = (c["line"].as_str().unwrap(), c["flag"].as_bool().unwrap());
        assert_eq!(re.is_match(line), flag, "line {line:?}: expected flagged = {flag}");
    }
}

#[test]
fn no_check_appends_one_character_at_a_time_to_a_growing_string() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sec = config();
    let allow: Vec<&str> = sec["allow"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let re = rule(&sec);

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
