//! Crate-creep gate: the normal dependency graph stays within the budget in `deps-budget.toml`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::collections::BTreeSet;
use std::process::Command;

/// Distinct `name version` entries of the normal graph, the engine's own path crate excluded.
fn crates_in_graph() -> BTreeSet<String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let out = Command::new(cargo)
        .args(["tree", "--prefix", "none", "--edges", "normal", "--locked", "--offline"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree runs");
    assert!(out.status.success(), "cargo tree failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim_end_matches(" (*)").trim().to_string())
        .filter(|l| !l.is_empty() && !l.contains(" (/"))
        .collect()
}

fn budget() -> toml::Table {
    let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("deps-budget.toml")).expect("deps-budget.toml exists");
    let mut t: toml::Table = text.parse().expect("deps-budget.toml parses");
    match t.remove("budget") {
        Some(toml::Value::Table(b)) => b,
        _ => panic!("deps-budget.toml needs a [budget] table"),
    }
}

fn num(b: &toml::Table, k: &str) -> usize {
    b.get(k).and_then(toml::Value::as_integer).unwrap_or_else(|| panic!("deps-budget.toml: {k} must be an integer")) as usize
}

#[test]
fn the_dependency_graph_stays_within_the_budget() {
    let b = budget();
    let max = num(&b, "max_crates");
    assert_eq!(max, num(&b, "base_crates") + num(&b, "approved_headroom"), "max_crates must be base_crates + approved_headroom");
    let graph = crates_in_graph();
    assert!(
        graph.len() <= max,
        "{} crates in the normal graph, budget {max}: a new dependency needs a reviewed bump of deps-budget.toml (what it is, why, measured delta).\n{}",
        graph.len(),
        graph.iter().cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn the_budget_is_not_stale_by_more_than_its_headroom() {
    // A budget far above the real count stops catching creep: it must track the graph within the approved headroom.
    let b = budget();
    let (graph, base) = (crates_in_graph().len(), num(&b, "base_crates"));
    assert!(graph + 1 >= base, "the graph shrank to {graph} crates: lower base_crates ({base}) and max_crates in deps-budget.toml");
}
