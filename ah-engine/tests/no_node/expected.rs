//! The expected-failure list (expected_failures.toml): the live backlog of Node paths. A test fails on a Node path that is
//! not listed (a new dependency on Node) AND on a listed path its surface no longer reaches (the lane that removed it must
//! delete the entry), so the list can only shrink. v1.0 needs it empty.

use crate::harness::{self, Seen};

use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct Entry {
    pub surface: String,
    pub script: String,
    /// Reached only on some runs (a scheduled duty, a timing-dependent fallback): never reported as stale.
    pub optional: bool,
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub case: String,
}

pub struct List {
    pub node: Vec<Entry>,
    pub decision: Vec<Decision>,
}

pub fn load() -> List {
    let text = std::fs::read_to_string(harness::here().join("expected_failures.toml")).unwrap();
    let t: toml::Table = text.parse().unwrap();
    let arr = |k: &str| t.get(k).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let s = |v: &toml::Value, k: &str| {
        v.get(k).and_then(|x| x.as_str()).unwrap_or_else(|| panic!("expected_failures.toml: an entry without `{k}`: {v:?}")).to_string()
    };
    let node: Vec<Entry> = arr("node")
        .iter()
        .map(|v| {
            // every entry names the lane that owns its removal and why it is still Node, so the backlog is actionable
            s(v, "lane");
            s(v, "reason");
            Entry { surface: s(v, "surface"), script: s(v, "script"), optional: v.get("optional").and_then(|x| x.as_bool()).unwrap_or(false) }
        })
        .collect();
    let decision: Vec<Decision> = arr("decision")
        .iter()
        .map(|v| {
            s(v, "lane");
            s(v, "reason");
            Decision { case: s(v, "case") }
        })
        .collect();
    let mut keys = BTreeSet::new();
    for e in &node {
        assert!(keys.insert((e.surface.clone(), e.script.clone())), "expected_failures.toml lists {} / {} twice", e.surface, e.script);
    }
    List { node, decision }
}

/// Compare what the surfaces under `prefix` reached with the list; the problems, one line each.
pub fn compare(list: &List, prefix: &str, seen: &Seen) -> Vec<String> {
    let mut problems = Vec::new();
    for ((surface, script), cases) in seen {
        if !surface.starts_with(prefix) {
            continue;
        }
        if !list.node.iter().any(|e| &e.surface == surface && &e.script == script) {
            problems.push(format!("NEW Node path (not on the expected-failure list): surface `{surface}`, script `{script}`, cases {cases:?}"));
        }
    }
    for e in &list.node {
        if !e.surface.starts_with(prefix) || e.optional {
            continue;
        }
        if !seen.contains_key(&(e.surface.clone(), e.script.clone())) {
            problems.push(format!("STALE expected failure (no longer reached, delete the entry): surface `{}`, script `{}`", e.surface, e.script));
        }
    }
    problems
}

/// Decision check of the cases under `prefix`: a mismatch must be listed, a listed case must still mismatch.
pub fn compare_decisions(list: &List, prefix: &str, mismatched: &[(String, String)], checked: &[String]) -> Vec<String> {
    let mut problems = Vec::new();
    for (case, why) in mismatched {
        if !list.decision.iter().any(|d| &d.case == case) {
            problems.push(format!("DECISION differs from the expected one (not listed): case `{case}`: {why}"));
        }
    }
    for d in &list.decision {
        if !d.case.starts_with(prefix) || !checked.contains(&d.case) {
            continue;
        }
        if !mismatched.iter().any(|(c, _)| c == &d.case) {
            problems.push(format!("STALE expected decision failure (the decision is right now, delete the entry): case `{}`", d.case));
        }
    }
    problems
}

/// Write the report of one test and fail with every problem at once.
pub fn finish(name: &str, report: serde_json::Value, problems: &[String]) {
    let path = harness::World::report_path(name);
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    eprintln!("no_node report: {}", path.display());
    assert!(problems.is_empty(), "{name}: {} problem(s):\n{}\n(report: {})", problems.len(), problems.join("\n"), path.display());
}

/// The observations as report JSON.
pub fn seen_json(seen: &Seen) -> serde_json::Value {
    serde_json::Value::Array(seen.iter().map(|((surface, script), cases)| serde_json::json!({"surface": surface, "script": script, "cases": cases})).collect())
}
