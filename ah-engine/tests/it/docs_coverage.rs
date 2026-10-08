//! D54: the hand-written `docs/AH-ENGINE.md` covers everything the engine registers, and never claims what is not
//! built. The generated reference (see `reference.rs`) lists every key; this page must at least name every command,
//! check, metric, impact kind and defaults file, mark everything unbuilt as "planned (D-n)", mention only environment
//! variables that exist, and link files that exist.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::collections::BTreeSet;
use std::path::PathBuf;

fn doc() -> (PathBuf, String) {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("docs").join("AH-ENGINE.md");
    let t = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("docs/AH-ENGINE.md is required (D54): {e}"));
    (p, t)
}

#[test]
fn every_implemented_command_check_metric_impact_kind_and_defaults_file_is_documented() {
    let (_, d) = doc();
    for c in ah_engine::cli::commands() {
        if c.status == "implemented" {
            assert!(d.contains(&format!("`ah-engine {}", c.name)), "command {} is not documented in docs/AH-ENGINE.md", c.name);
        } else {
            assert!(d.contains(&c.name), "planned command {} is not mentioned", c.name);
        }
    }
    for c in ah_engine::checks::registry() {
        assert!(d.contains(&format!("`{}`", c.name())), "check {} is not documented", c.name());
    }
    for e in ah_engine::defaults::all().iter().filter(|e| e.key.starts_with("metric.")) {
        let name = &e.key["metric.".len()..];
        assert!(d.contains(&format!("`{name}`")), "metric {name} is not documented");
    }
    for k in ah_engine::impact::kinds() {
        assert!(d.contains(&format!("`{k}`")), "impact kind {k} is not documented");
    }
    let files: BTreeSet<&str> = ah_engine::defaults::all().iter().map(|e| e.file).collect();
    for f in files {
        assert!(d.contains(&format!("`{f}`")), "defaults file {f} is not documented");
    }
}

#[test]
fn everything_unbuilt_is_marked_planned_with_its_decision() {
    let (_, d) = doc();
    // every line that says "planned" names a decision, like "planned (D33)" or a table cell with D-numbers
    for (i, l) in d.lines().enumerate() {
        if l.to_lowercase().contains("planned") {
            assert!(l.contains('D') && l.chars().any(|c| c.is_ascii_digit()), "docs/AH-ENGINE.md:{}: 'planned' without a decision number: {l}", i + 1);
        }
    }
    for c in ah_engine::cli::commands().into_iter().filter(|c| c.status != "implemented") {
        let dn = c.status.trim_start_matches("planned (").trim_end_matches(')');
        assert!(d.contains(dn), "planned command {} cites {dn}, which the page does not mention", c.name);
    }
}

#[test]
fn only_real_environment_variables_are_mentioned() {
    let (_, d) = doc();
    let known: BTreeSet<&str> = ah_engine::defaults::all()
        .iter()
        .filter_map(|e| e.env)
        .chain(ah_engine::defaults::all().iter().filter(|e| e.key.starts_with("env.")).filter_map(|e| e.value.as_str()))
        .collect();
    let re = regex::Regex::new(r"AH_ENGINE_[A-Z_]+").unwrap();
    for m in re.find_iter(&d) {
        assert!(known.contains(m.as_str()), "docs/AH-ENGINE.md mentions {} which is not a shipped environment variable", m.as_str());
    }
}

#[test]
fn relative_links_resolve() {
    let (p, d) = doc();
    let re = regex::Regex::new(r"\]\((\.\./[^)#]+|[^):#]+\.md)(?:#[^)]*)?\)").unwrap();
    for c in re.captures_iter(&d) {
        let target = p.parent().unwrap().join(&c[1]);
        assert!(target.exists(), "docs/AH-ENGINE.md links {} which does not exist", &c[1]);
    }
}
