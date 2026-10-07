//! Unit tests of the scan-throttle check. The full Node-vs-engine comparison is `parity/run-scan-throttle.js`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

/// A directory holding fake `taskpolicy` and `nice` files, so the tool probe succeeds on either OS.
fn tools_dir(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-scan-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join("home/.anti-hall")).unwrap();
    std::fs::create_dir_all(d.join("bin")).unwrap();
    for t in ["taskpolicy", "nice"] {
        std::fs::write(d.join("bin").join(t), "").unwrap();
    }
    d.to_string_lossy().to_string()
}

fn settings(d: &str, patterns: Option<&str>, extra: &[(&str, &str)]) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), format!("{d}/bin"));
    if let Some(p) = patterns {
        env.insert("ANTI_HALL_THROTTLE_PATTERNS".into(), p.into());
    }
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    Settings { home: format!("{d}/home"), env }
}

fn bash(cmd: &str) -> Value {
    json!({"tool_name": "Bash", "tool_input": {"command": cmd}})
}

fn advice(v: Option<Verdict>) -> String {
    match v {
        Some(Verdict::Advisory(j)) => serde_json::from_str::<Value>(&j).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string(),
        other => panic!("expected an advisory, got {other:?}"),
    }
}

fn prefix() -> &'static str {
    if cfg!(target_os = "macos") { "taskpolicy -c utility nice -n 19 " } else { "nice -n 19 " }
}

#[test]
fn no_patterns_means_nothing_matches() {
    let d = tools_dir("none");
    assert!(decide(&bash("reindex-repo --full"), &settings(&d, None, &[])).is_none());
    assert!(decide(&bash("reindex-repo --full"), &settings(&d, Some(" , "), &[])).is_none());
}

#[test]
fn first_simple_command_quotes_the_throttled_form_and_keeps_assignments_in_front() {
    if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
        return;
    }
    let d = tools_dir("first");
    let st = settings(&d, Some("reindex-repo"), &[]);
    let t = advice(decide(&bash("reindex-repo --full"), &st));
    assert!(t.starts_with("\u{1f4a1} anti-hall \u{b7} scan-throttle: this is a heavy repo-wide scan; the command was NOT modified.\nWhy: To keep the machine responsive.\nDo instead: re-run it background-throttled: `"), "{t}");
    assert!(t.contains(&format!("`{}reindex-repo --full`.", prefix())), "{t}");
    let t = advice(decide(&bash("SCANENV=1 reindex-repo --full"), &st));
    assert!(t.contains(&format!("`SCANENV=1 {}reindex-repo --full`.", prefix())), "{t}");
}

#[test]
fn a_scan_elsewhere_in_a_compound_or_grouped_command_gets_the_generic_note() {
    if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
        return;
    }
    let d = tools_dir("group");
    let st = settings(&d, Some("reindex-repo"), &[]);
    for c in ["cd x && reindex-repo --full", "( reindex-repo --full )", "FOO=1 cd app && reindex-repo --full"] {
        let t = advice(decide(&bash(c), &st));
        assert!(t.contains("detected in a compound or grouped command"), "{c}: {t}");
        assert!(t.contains(&format!("e.g. `{} <that command>`.", prefix().trim())), "{c}: {t}");
    }
}

#[test]
fn already_prefixed_and_heredoc_data_are_left_alone() {
    let d = tools_dir("skip");
    let st = settings(&d, Some("reindex-repo"), &[]);
    for c in ["nice -n 19 reindex-repo", "  taskpolicy -c utility nice -n 19 reindex-repo", "cat <<EOF\nreindex-repo --full\nEOF"] {
        assert!(decide(&bash(c), &st).is_none(), "{c}");
    }
}

#[test]
fn the_switch_and_a_missing_tool_silence_it() {
    let d = tools_dir("off");
    assert!(decide(&bash("reindex-repo"), &settings(&d, Some("reindex-repo"), &[("ANTI_HALL_SCAN_THROTTLE", "0")])).is_none());
    let mut st = settings(&d, Some("reindex-repo"), &[]);
    st.env.insert("PATH".into(), "/nonexistent".into());
    assert!(decide(&bash("reindex-repo"), &st).is_none());
}

#[test]
fn only_plain_patterns_are_matched_here_everything_else_defers() {
    for ok in ["reindex-repo", "a|b", "(?:x)+", "\\bscan\\b", "[a-z]+-repo", "^x$", "x*?", "\\.go", "a\\.b"] {
        assert!(pattern_is_plain(ok), "{ok}");
    }
    for bad in ["(?=x)", "a{2}", "(a)\\1", "\\p{L}", "\u{e9}", "a**", "^*", "\\b*", "[]", "[a&&b]", "[z-a]", "(", ")", "[", "x\\", "(?i)x", "[\\w-.]"] {
        assert!(!pattern_is_plain(bad), "{bad}");
    }
    let d = tools_dir("defer");
    assert_eq!(decide(&bash("reindex-repo"), &settings(&d, Some("(?=reindex)"), &[])), Some(Verdict::Defer));
}

#[test]
fn segments_split_like_the_node_guard() {
    assert_eq!(split_segments("a && b || c | d ; e & f\ng"), ["a ", " b ", " c ", " d ", " e ", " f", "g"]);
    assert_eq!(split_segments("echo 'a;b' \"c|d\" e"), ["echo 'a;b' \"c|d\" e"]);
    assert_eq!(split_segments("cat <<EOF && x\nbody; y\nEOF\nz"), ["cat <<EOF && x", "z"]);
    assert_eq!(split_segments("echo $(a) `b` (c) {d}"), ["echo ", "a", "b", "c", "d"]);
}

#[test]
fn leading_assignments_are_skipped_only_when_followed_by_white_space() {
    assert_eq!(strip_leading_assignments("  A=1 B=\"x y\" C='z' cmd"), "  A=1 B=\"x y\" C='z' ".len());
    assert_eq!(strip_leading_assignments("A=1"), 0);
    assert_eq!(strip_leading_assignments("A=1 "), 4);
    assert_eq!(strip_leading_assignments("cmd A=1 x"), 0);
}
