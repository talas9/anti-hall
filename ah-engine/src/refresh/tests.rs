#![allow(clippy::unwrap_used, clippy::expect_used)] // a test module: a panic is the failure report

use super::*;

#[test]
fn refresh_highest_tag_matches_parse_highest_tag() {
    // peeled refs and non-release tags never count; a trailing CR is stripped; the numerically highest wins, the first of equals
    let out = "aaa\trefs/tags/v0.9.0\nbbb\trefs/tags/v0.10.0^{}\nccc\trefs/tags/v0.10.0\r\nddd\trefs/tags/1.2.3-rc1\neee\trefs/tags/v0.9.10\n";
    assert_eq!(highest_tag(out).as_deref(), Some("v0.10.0"));
    assert_eq!(highest_tag("x\trefs/tags/v2.0.0\ny\trefs/tags/2.0.0\n").as_deref(), Some("v2.0.0"));
    assert_eq!(highest_tag("x\trefs/tags/v10.0.0\ny\trefs/tags/v9.99.99\n").as_deref(), Some("v10.0.0"));
    assert_eq!(highest_tag("x\trefs/heads/main\n"), None);
    assert_eq!(highest_tag(""), None);
}

#[test]
fn refresh_extract_version_matches_the_node_extractor() {
    // one distinct full token
    assert_eq!(extract_version("2.5.1\n").as_deref(), Some("2.5.1"));
    assert_eq!(extract_version("claude v2.1.238 (Claude Code)").as_deref(), Some("2.1.238"));
    // the same token twice (with and without v) is still one
    assert_eq!(extract_version("v1.2.3 / 1.2.3").as_deref(), Some("1.2.3"));
    // two distinct full tokens: ambiguous, never guessed
    assert_eq!(extract_version("1.2.3 built with 4.5.6"), None);
    // no full token: one distinct partial token, else nothing
    assert_eq!(extract_version("version 3.4").as_deref(), Some("3.4"));
    assert_eq!(extract_version("3.4 and 5.6"), None);
    assert_eq!(extract_version("no version here"), None);
    assert_eq!(extract_version(""), None);
    // a full token takes precedence over partial ones
    assert_eq!(extract_version("1.2 then 3.4.5").as_deref(), Some("3.4.5"));
    // JavaScript word boundaries are ASCII: a non-ASCII letter before the digits still leaves a boundary
    assert_eq!(extract_version("\u{e9}1.2.3").as_deref(), Some("1.2.3"));
    // an ASCII letter leaves no boundary before `1`, so the only token is the partial one after it
    assert_eq!(extract_version("x1.2.3").as_deref(), Some("2.3")); // JavaScript: no full token, then `2.3` after the dot
    // `1.2.3.4`: the first three parts, as the JavaScript pattern matches
    assert_eq!(extract_version("1.2.3.4").as_deref(), Some("1.2.3"));
}

#[test]
fn refresh_request_path_is_under_the_request_dir() {
    let p = request_path(Path::new("/h"), "version");
    assert_eq!(p, Path::new("/h").join(defaults::text("refresh.request_dir")).join(format!("version{}", defaults::text("refresh.request_ext"))));
    for probe in defaults::list("refresh.probes") {
        assert!(["version", "claude_cli", "devswarm", "repair"].contains(&probe), "a probe this module handles: {probe}");
    }
}

#[test]
fn refresh_without_requests_writes_no_cache() {
    let home = std::env::temp_dir().join(format!("ah-refresh-unit-{}-{}", std::process::id(), crate::health::now_ms()));
    std::fs::create_dir_all(&home).unwrap();
    let out = run(&home, false).expect("the run lock is free");
    assert_eq!(out.len(), defaults::list("refresh.probes").len());
    assert!(out.iter().all(|d| d.outcome == defaults::text("refresh.outcome_skipped")), "{out:?}");
    assert!(!home.join(defaults::text("session.version_check_file")).exists());
    assert!(!home.join(defaults::text("session.claude_cli_cache")).exists());
    // the run lock was released
    assert!(!home.join(defaults::text("refresh.request_dir")).join(defaults::text("refresh.lock_file")).exists());
    std::fs::remove_dir_all(&home).unwrap();
}
