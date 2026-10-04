//! Unit tests of the ship-it-guard check. The full Node-vs-engine comparison is `parity/run-ship-it-guard.js`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

const PLAN: &str = "# Plan\n\n## Phases\n\n### Phase 1: db\n- goal: x\n- files: src/db/a.js, `lib/b.ts`, ./docs/c.md\n- verify: tests\n\n### Phase 2: api\n- files:\n  - src/api/routes.js\n\n## Progress\n- files: late/x.js\n";

fn proj(tag: &str, plan: Option<&str>) -> String {
    let d = std::env::temp_dir().join(format!("ah-ship-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    if let Some(p) = plan {
        std::fs::write(d.join("PLAN.md"), p).unwrap();
    }
    d.to_string_lossy().to_string()
}

fn settings(home: &str, on: bool) -> Settings {
    let mut env = HashMap::new();
    if on {
        env.insert("ANTIHALL_SHIPIT_GATE".to_string(), "1".to_string());
    }
    Settings { home: home.to_string(), env }
}

fn edit(file: &str, cwd: &str) -> Value {
    json!({"tool_name": "Edit", "cwd": cwd, "tool_input": {"file_path": file}})
}

#[test]
fn gate_is_off_by_default_so_nothing_is_decided() {
    let d = proj("off", None);
    assert!(decide(&edit("src/auth/login.js", &d), &settings(&d, false)).is_none());
}

#[test]
fn hard_risk_file_with_no_plan_blocks_with_the_node_text() {
    let d = proj("block", None);
    let Some(Verdict::Block(m)) = decide(&edit("db/migrations/001.sql", &d), &settings(&d, true)) else { panic!("expected a block") };
    assert!(m.starts_with("\u{26d4} anti-hall \u{b7} ship-it-guard: L-risk file db/migrations/001.sql edited with no PLAN.md.\nWhy: "), "{m}");
    assert!(m.contains("\nDo instead: create PLAN.md (repo root) first.\nOverride (only if the user explicitly asked): "), "{m}");
}

#[test]
fn docs_tests_and_the_plan_itself_are_never_gated() {
    let d = proj("noncode", None);
    for f in ["README.md", "src/auth/login.test.js", "tests/auth/x.js", "PLAN.md", "docs/migrations/notes.txt"] {
        assert!(decide(&edit(f, &d), &settings(&d, true)).is_none(), "{f}");
    }
}

#[test]
fn a_real_plan_advises_on_undeclared_targets_and_not_on_declared_ones() {
    let d = proj("conf", Some(PLAN));
    let st = settings(&d, true);
    assert!(decide(&edit("src/db/a.js", &d), &st).is_none());
    assert!(decide(&edit("lib/b.ts", &d), &st).is_none());
    assert!(decide(&edit(&format!("{d}/src/api/routes.js"), &d), &st).is_none(), "an absolute target is compared relative to the cwd");
    let Some(Verdict::Advisory(j)) = decide(&edit("src/other.js", &d), &st) else { panic!("expected an advisory") };
    assert!(j.contains("src/other.js does not appear in any phase's declared \\\"files:\\\" list in"), "{j}");
    // the Progress section is outside the Phases block
    assert!(matches!(decide(&edit("late/x.js", &d), &st), Some(Verdict::Advisory(_))));
}

#[test]
fn a_stub_plan_has_no_scope_to_compare_against() {
    let d = proj("stub", Some("# Plan\n"));
    assert!(decide(&edit("src/other.js", &d), &settings(&d, true)).is_none());
    assert!(decide(&edit("auth/x.js", &d), &settings(&d, true)).is_none(), "a plan exists, so the existence gate is satisfied");
}

#[test]
fn shell_writes_patches_and_cwd_less_payloads_defer() {
    let d = proj("defer", None);
    let st = settings(&d, true);
    assert_eq!(decide(&json!({"tool_name": "Bash", "cwd": d, "tool_input": {"command": "echo x > a.js"}}), &st), Some(Verdict::Defer));
    assert_eq!(decide(&json!({"tool_name": "apply_patch", "cwd": d, "tool_input": {"command": "*** Begin Patch"}}), &st), Some(Verdict::Defer));
    assert_eq!(decide(&json!({"tool_name": "Edit", "tool_input": {"file_path": "src/a.js"}}), &st), Some(Verdict::Defer));
    assert_eq!(decide(&json!({"tool_name": "Edit", "cwd": "rel", "tool_input": {"file_path": "src/a.js"}}), &st), Some(Verdict::Defer));
    // nothing to judge needs no cwd
    assert!(decide(&json!({"tool_name": "Edit", "tool_input": {"file_path": "README.md"}}), &st).is_none());
}

#[test]
fn path_tokens_follow_the_node_rules() {
    assert_eq!(extract_path_tokens("src/a.js, `lib/b.ts`, ./docs/c.md and prose, x.rs;"), ["src/a.js", "lib/b.ts", "docs/c.md", "x.rs"]);
    assert_eq!(extract_path_tokens("- a/b\n  - c.d\n"), ["a/b", "c.d"]);
    assert!(extract_path_tokens("file.abcdefghijk").is_empty(), "an extension over ten characters is prose");
    assert_eq!(extract_path_tokens("src\\win\\a.js"), ["src/win/a.js"]);
}

#[test]
fn plan_parsing_needs_phases_with_files() {
    assert!(parse_plan_declared_files("## Phases\n### a\n- goal: x\n").is_none());
    assert!(parse_plan_declared_files("# Plan\nfiles: src/a.js\n").is_none());
    assert!(parse_plan_declared_files("## Phases\n- files: src/a.js\n").is_none(), "no phase heading");
    let set = parse_plan_declared_files("## phases\n### p\n- FILES: src/a.js\n").unwrap();
    assert!(set.contains("src/a.js"));
}

#[test]
fn run_without_the_payload_defers() {
    let ti = json!({"file_path": "a.js"});
    let s = Subject { event: "PreToolUse", tool: Some("Edit"), cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(ShipItGuard.run(&s, &Value::Null), Some(Verdict::Defer));
}
