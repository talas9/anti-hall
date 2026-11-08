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

/// The rule, from `tests/logic_lint.toml` `[charwise_concat]` (`atom` and `forms`): `<lhs> += <form>` ending a statement (`;`, `}` or the
/// end of the line), and `<lhs> = <lhs> + <form>`. The regex crate has no back-references, so the second shape is checked by hand.
struct Rule {
    append: regex::Regex,
    rebuild: regex::Regex,
}

impl Rule {
    fn new(sec: &toml::Table) -> Rule {
        let atom = sec["atom"].as_str().unwrap();
        let forms: Vec<String> = sec["forms"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().replace("{ATOM}", atom)).collect();
        let forms = forms.join("|");
        Rule {
            append: regex::Regex::new(&format!(r"[A-Za-z_$][A-Za-z_$0-9.\[\]]* *\+= *(?:{forms}) *(?:[;}}]|$)")).unwrap(),
            rebuild: regex::Regex::new(&format!(r"([A-Za-z_$][A-Za-z_$0-9.\[\]]*) *= *([A-Za-z_$][A-Za-z_$0-9.\[\]]*) *\+ *(?:{forms}) *(?:[;}}]|$)")).unwrap(),
        }
    }

    fn is_match(&self, line: &str) -> bool {
        self.append.is_match(line) || self.rebuild.captures_iter(line).any(|c| c[1] == c[2])
    }
}

/// A statement split over lines (`cur +=` / `cur = cur +` ending a line) is read as one line.
fn logical_lines(text: &str) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = Vec::new();
    let mut open = false;
    for (i, line) in text.lines().enumerate() {
        match out.last_mut() {
            Some(prev) if open => prev.1.push_str(line.trim_start()),
            _ => out.push((i + 1, line.to_string())),
        }
        let t = out.last().map_or("", |l| l.1.trim_end());
        open = !t.starts_with("//") && (t.ends_with("+=") || t.ends_with('+') || t.ends_with(" ="));
    }
    out
}

fn config() -> toml::Table {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(root.join("tests/logic_lint.toml")).unwrap().parse::<toml::Table>().unwrap()["charwise_concat"].as_table().unwrap().clone()
}

#[test]
fn the_rule_flags_the_shapes_it_names_and_leaves_ordinary_appends_alone() {
    let sec = config();
    let re = Rule::new(&sec);
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
    let re = Rule::new(&sec);

    let mut files = Vec::new();
    js_files(&root.parent().unwrap().join("plugins/anti-hall/engine/logic"), &mut files);
    assert!(files.len() > 50, "found only {} logic files: wrong directory?", files.len());
    let mut hits = Vec::new();
    for f in &files {
        let name = f.strip_prefix(root.parent().unwrap().join("plugins/anti-hall/engine/logic")).unwrap().to_string_lossy().into_owned();
        for (i, line) in logical_lines(&std::fs::read_to_string(f).unwrap()) {
            let code = line.trim_start();
            if code.starts_with("//") || !re.is_match(&line) {
                continue;
            }
            if allow.iter().any(|a| a.split_once(':').is_some_and(|(file, sub)| file == name && line.contains(sub))) {
                continue;
            }
            hits.push(format!("{name}:{i}: {}", line.trim()));
        }
    }
    assert!(
        hits.is_empty(),
        "per-character string building (`s += c`) reallocates the whole string each time under QuickJS; push to an array and join('') instead:\n{}",
        hits.join("\n")
    );
}

#[test]
fn a_statement_split_over_lines_is_read_as_one() {
    let re = Rule::new(&config());
    let flagged = |text: &str| logical_lines(text).iter().any(|(_, l)| re.is_match(l));
    assert!(flagged("cur +=\n  c;"));
    assert!(flagged("s = s +\n  ch\n"));
    assert!(!flagged("total +=\n  weights[field];"));
    assert!(!flagged("// cur +=\n// c;"));
}
