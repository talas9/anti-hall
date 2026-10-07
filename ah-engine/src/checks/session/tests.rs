//! Unit tests of the session-maintenance checks. The full comparison with the Node hooks is `parity/run-session.js` (about
//! 2,400 scenarios, exit code, stdout and state files); these tests pin the pieces and the ordering rules that matter most.
//! Every test runs against its own temporary home directory, never the real one.
use super::drift::{self, Drift};
use super::jval::{J, Parsed, js_num, parse};
use super::progress_prune::{blockquote_for_test, cwd_key_for_test};
use super::time::{days_of_iso_date, iso_date, iso_string};
use super::version_alert::semver_greater;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// A temporary directory this process made (unique name), removed again when the test ends.
struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Tmp {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let p = std::env::temp_dir().join(format!("ah-session-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(std::fs::canonicalize(p).unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn s(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
    fn write(&self, rel: &str, text: &str) {
        let f = self.0.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.0));
    }
}

fn now() -> f64 {
    super::now_ms()
}

/// Run `check` on a SessionStart payload with `home` as HOME.
fn run(check: &dyn Check, home: &Tmp, extra_env: &[(&str, &str)], payload: Value, root: Option<&str>) -> Verdict {
    let mut pairs: Vec<(String, String)> = vec![("HOME".into(), home.s())];
    pairs.extend(extra_env.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())));
    let env = RequestEnv::from_pairs(pairs);
    let s = Subject { event: "SessionStart", tool: None, cwd: None, tool_input: &Value::Null, prompt: None };
    let opts = json!({ "plugin_root": root });
    check.run_env(&s, &payload, &opts, &env).expect("a session check always answers")
}

fn advisory_text(v: &Verdict) -> String {
    match v {
        Verdict::Advisory(j) => serde_json::from_str::<Value>(j).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string(),
        other => panic!("expected an advisory, got {other:?}"),
    }
}

// ---- JavaScript number and date behaviour, with expected values computed in Node ------------------------------------------

#[test]
fn numbers_print_like_javascript() {
    // computed with Node: String(n)
    let cases: [(f64, &str); 18] = [
        (0.0, "0"),
        (-0.0, "0"),
        (1.5, "1.5"),
        (0.1, "0.1"),
        (100.0, "100"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (123456789012345680000.0, "123456789012345680000"),
        (12345678901234567890.0, "12345678901234567000"),
        (f64::MAX, "1.7976931348623157e+308"),
        (5e-324, "5e-324"),
        (0.30000000000000004, "0.30000000000000004"),
        (1e300, "1e+300"),
        (123e-20, "1.23e-18"),
        (9007199254740992.0, "9007199254740992"),
        (99999999999999990000.0, "99999999999999980000"),
        (1234.5678e10, "12345678000000"),
    ];
    for (n, want) in cases {
        assert_eq!(js_num(n), want, "{n:e}");
    }
}

#[test]
fn json_keeps_key_order_and_the_last_duplicate_value() {
    let Parsed::Ok(v) = parse(r#"{"b":1,"a":{"z":[1,2.50,"x"],"y":null},"b":2,"c":1e2}"#) else { panic!("parse") };
    assert_eq!(v.stringify(), r#"{"b":2,"a":{"z":[1,2.5,"x"],"y":null},"c":100}"#);
    let mut v = v;
    v.set("a", J::Num(7.0));
    v.set("d", J::Bool(true));
    assert_eq!(v.stringify(), r#"{"b":2,"a":7,"c":100,"d":true}"#);
}

#[test]
fn json_text_that_javascript_reads_differently_is_unsure() {
    for t in [r#"{"x":"\ud800"}"#, r#"{"x":1e999}"#, &format!("{}{}", "[".repeat(200), "]".repeat(200))] {
        assert_eq!(parse(t), Parsed::Unsure, "{t:.40}");
    }
    for t in ["", "{", "{\"a\":1,}", "[1,]", "\u{feff}{}", "01", "{'a':1}", "nul"] {
        assert_eq!(parse(t), Parsed::Bad, "{t:?}");
    }
}

#[test]
fn version_comparison_matches_the_node_functions() {
    // computed with Node: semverGreater of version-alert.js
    let greater: [(&str, &str, bool); 24] = [
        ("1.2.4", "1.2.3", true),
        ("1.2.3", "1.2.3", false),
        ("1.3.0", "1.2.9", true),
        ("v1.2.4", "1.2.3", true),
        ("1.2.4", "v1.2.3", true),
        ("1.2", "1.1.1", false),
        ("1.2.4.5", "1.2.3", true),
        ("1.2.4-beta", "1.2.3", true),
        ("1.2.3-beta", "1.2.3", false),
        (" 1.2.4", "1.2.3", true),
        ("1.2.x", "1.2.3", false),
        ("", "1.2.3", false),
        ("01.02.04", "1.2.3", true),
        ("1.2.9999999999999999999", "1.2.3", true),
        ("-1.2.4", "1.2.3", false),
        ("1.2.-1", "1.2.3", false),
        ("1.2.+4", "1.2.3", true),
        ("1e2.0.0", "1.2.3", false),
        ("0x10.0.0", "1.2.3", false),
        ("vv1.2.4", "1.2.3", false),
        ("V1.2.4", "1.2.3", false),
        ("10.0.0", "9.9.9", true),
        ("1.10.0", "1.9.0", true),
        ("1.2.4abc", "1.2.3", true),
    ];
    for (a, b, want) in greater {
        assert_eq!(semver_greater(a, b), want, "{a:?} > {b:?}");
    }
    // computed with Node: parseSemver and classifyVersionDrift(v, '2.1.238') of drift-baseline.js
    let drift: [(&str, Option<[f64; 3]>, Drift); 20] = [
        ("2.1.238", Some([2.0, 1.0, 238.0]), Drift::Match),
        ("v2.1.240", Some([2.0, 1.0, 240.0]), Drift::Patch),
        ("2.2.0", Some([2.0, 2.0, 0.0]), Drift::Newer),
        ("2.0.9", Some([2.0, 0.0, 9.0]), Drift::Older),
        ("1.9", Some([1.0, 9.0, 0.0]), Drift::Older),
        ("2.1", Some([2.0, 1.0, 0.0]), Drift::Patch),
        ("2.1.x", None, Drift::Unparseable),
        ("2.1.238-beta", None, Drift::Unparseable),
        ("  2.2.0  ", Some([2.0, 2.0, 0.0]), Drift::Newer),
        ("2.2.0\n", Some([2.0, 2.0, 0.0]), Drift::Newer),
        ("٢.٢.٠", None, Drift::Unparseable),
        ("99999999999999999999.1.0", Some([1e20, 1.0, 0.0]), Drift::Newer),
        ("2.2.0.1", None, Drift::Unparseable),
        ("2.2.", None, Drift::Unparseable),
        ("", None, Drift::Unparseable),
        ("vv2.2.0", None, Drift::Unparseable),
        ("V2.2.0", None, Drift::Unparseable),
        ("02.01.0238", Some([2.0, 1.0, 238.0]), Drift::Patch),
        ("\u{a0}2.2.0", Some([2.0, 2.0, 0.0]), Drift::Newer),
        ("2.1.239", Some([2.0, 1.0, 239.0]), Drift::Patch),
    ];
    for (v, parsed, class) in drift {
        assert_eq!(drift::parse_semver(v), parsed, "parse {v:?}");
        assert_eq!(drift::classify(v, "2.1.238"), class, "classify {v:?}");
    }
}

#[test]
fn dates_and_throttle_keys_match_node() {
    // computed with Node: new Date(ms).toISOString()
    for (ms, iso) in [
        (0.0, "1970-01-01T00:00:00.000Z"),
        (1_791_356_360_866.0, "2026-10-07T06:59:20.866Z"),
        (86_399_999.0, "1970-01-01T23:59:59.999Z"),
        (-1.0, "1969-12-31T23:59:59.999Z"),
        (951_782_400_000.0, "2000-02-29T00:00:00.000Z"),
        (253_402_300_799_999.0, "9999-12-31T23:59:59.999Z"),
    ] {
        assert_eq!(iso_string(ms), iso);
        assert_eq!(iso_date(ms), &iso[..10]);
    }
    // computed with Node: Date.parse(s + 'T00:00:00Z') / 86400000 (null = NaN)
    for (s, days) in [
        ("2026-09-03", Some(20699)),
        ("2026-02-29", None),
        ("2028-02-29", Some(21243)),
        ("2026-13-01", None),
        ("2026-00-10", None),
        ("2026-04-31", None),
        ("1999-12-31", Some(10956)),
        ("abcd-ef-gh", None),
        ("2026-9-3", None),
    ] {
        assert_eq!(days_of_iso_date(s), days, "{s}");
    }
    // computed with Node: cwdKey of progress-prune.js
    for (cwd, key) in [
        ("/a", "cwd_176"),
        ("/tmp/x/proj", "cwd_9356nv"),
        ("/Users/someone/Projects/anti-hall", "cwd_7vldaa"),
        ("é日本😀", "cwd_guxzw3"),
        ("/", "cwd_1b"),
        ("/private/tmp/claude-501/-Users-talas9-Projects-anti-hall/44895798", "cwd_b5iztk"),
        (&"x".repeat(300), "cwd_t2j4zk"),
    ] {
        assert_eq!(cwd_key_for_test(cwd), key);
    }
    // computed with Node: lines.map(l => '> ' + l).join('\n') + '\n' over text.split(/\r?\n/)
    for (c, want) in [
        ("", "> \n"),
        ("a", "> a\n"),
        ("a\n", "> a\n> \n"),
        ("a\r\nb", "> a\n> b\n"),
        ("a\rb\r", "> a\rb\r\n"),
        ("\n\n", "> \n> \n> \n"),
        ("a\r\r\nb\r\r", "> a\r\n> b\r\r\n"),
        ("a\r\n", "> a\n> \n"),
    ] {
        assert_eq!(blockquote_for_test(c), want, "{c:?}");
    }
}

// ---- the constants that mirror a Node library file, and the limits that must stay below the client's -----------------------

fn node_const(file: &str, name: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").join("hooks").join("lib").join(file);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let re = regex::Regex::new(&format!(r"const {name} = '?([^';\n]+)'?;")).unwrap();
    re.captures(&text).unwrap_or_else(|| panic!("{name} not found in {file}"))[1].to_string()
}

#[test]
fn the_baselines_equal_the_node_library_values() {
    assert_eq!(defaults::text("session.devswarm_baseline"), node_const("devswarm-baseline.js", "DEVSWARM_BASELINE"));
    assert_eq!(defaults::text("session.claude_cli_baseline"), node_const("claude-cli-baseline.js", "CLAUDE_CLI_BASELINE"));
    assert_eq!(defaults::text("session.model_kb_audit_date"), node_const("repo-audit-baseline.js", "MODEL_KB_AUDIT_DATE"));
    assert_eq!(defaults::num("session.staleness_threshold_days").to_string(), node_const("repo-audit-baseline.js", "STALENESS_THRESHOLD_DAYS"));
}

#[test]
fn the_gitignore_probe_ends_before_the_client_gives_up() {
    // an engine answer that comes after the client's deadline is thrown away, and the probe would have written its marker
    assert!(defaults::num("session.gitignore_probe_ms") + defaults::num("client.deadline_slack_ms") < defaults::num("client.deadline_ms"));
}

#[test]
fn the_registered_checks_are_the_six_hook_names() {
    for name in ["version-alert", "devswarm-version", "claude-cli-version", "repo-self-drift", "defect-nudge", "progress-prune"] {
        assert!(crate::checks::get(name).is_some(), "{name}");
    }
}

// ---- the drift probes -------------------------------------------------------------------------------------------------------

fn claude_cache(newer: &str, extra: &str, checked_ago_ms: f64) -> String {
    format!("{{\"source\":\"probe\",\"installed\":\"{newer}\",{extra}\"checkedAt\":{}}}", (now() - checked_ago_ms) as i64)
}

#[test]
fn a_fresh_cache_with_drift_advises_once_and_keeps_the_other_fields_in_place() {
    let h = Tmp::new("cli-advise");
    h.write(".anti-hall/claude-cli-version.json", &claude_cache("2.2.0", "\"zz\":{\"b\":1,\"a\":[1,2]},", 3_600_000.0));
    let c = crate::checks::get("claude-cli-version").unwrap();
    let v = run(c, &h, &[], json!({"session_id": "s"}), None);
    assert_eq!(
        advisory_text(&v),
        "⚠️ anti-hall · claude-cli-version: Claude Code CLI 2.2.0 is installed; anti-hall's harness KB is audited against 2.1.238.\nWhy: Behavior may have drifted.\nDo instead: see docs/KB-claude-code-harness-features.md."
    );
    let after = h.read(".anti-hall/claude-cli-version.json").unwrap();
    assert!(after.starts_with("{\"source\":\"probe\",\"installed\":\"2.2.0\",\"zz\":{\"b\":1,\"a\":[1,2]},\"checkedAt\":"), "{after}");
    assert!(after.ends_with(",\"lastAdvised\":{\"installed\":\"2.2.0\",\"baseline\":\"2.1.238\"}}"), "{after}");
    // the same pair is not said twice
    assert_eq!(run(c, &h, &[], json!({"session_id": "s"}), None), Verdict::Allow);
}

#[test]
fn a_stale_or_missing_cache_is_left_to_node_which_starts_the_probe_and_nothing_is_written() {
    let h = Tmp::new("cli-stale");
    let c = crate::checks::get("claude-cli-version").unwrap();
    assert_eq!(run(c, &h, &[], json!({}), None), Verdict::Defer, "absent");
    let stale = claude_cache("2.2.0", "", 2.0 * 86_400_000.0);
    h.write(".anti-hall/claude-cli-version.json", &stale);
    assert_eq!(run(c, &h, &[], json!({}), None), Verdict::Defer, "stale");
    assert_eq!(h.read(".anti-hall/claude-cli-version.json").unwrap(), stale, "a deferral changes nothing");
}

#[test]
fn devswarm_dedupe_only_needs_the_pair_but_claude_cli_needs_exactly_the_pair() {
    let h = Tmp::new("dedupe-shape");
    let la = "\"lastAdvised\":{\"installed\":\"2.6.0\",\"baseline\":\"2.5.1\",\"extra\":1},";
    h.write(".anti-hall/devswarm-version.json", &format!("{{\"installed\":\"2.6.0\",{la}\"checkedAt\":{}}}", (now() - 1000.0 * 60.0) as i64));
    assert_eq!(
        run(crate::checks::get("devswarm-version").unwrap(), &h, &[], json!({}), None),
        Verdict::Allow,
        "devswarm: an extra key still counts as advised"
    );
    h.write(
        ".anti-hall/claude-cli-version.json",
        &format!(
            "{{\"installed\":\"2.2.0\",\"lastAdvised\":{{\"installed\":\"2.2.0\",\"baseline\":\"2.1.238\",\"extra\":1}},\"checkedAt\":{}}}",
            (now() - 60_000.0) as i64
        ),
    );
    assert!(
        matches!(run(crate::checks::get("claude-cli-version").unwrap(), &h, &[], json!({}), None), Verdict::Advisory(_)),
        "claude-cli: an extra key does not"
    );
}

#[test]
fn the_judge_child_and_the_switches_silence_a_hook_without_touching_state() {
    let h = Tmp::new("silence");
    let file = ".anti-hall/claude-cli-version.json";
    let text = claude_cache("2.2.0", "", 60_000.0);
    h.write(file, &text);
    let c = crate::checks::get("claude-cli-version").unwrap();
    assert_eq!(run(c, &h, &[("ANTIHALL_JUDGE_CHILD", "1")], json!({}), None), Verdict::Allow);
    assert_eq!(run(c, &h, &[("ANTIHALL_CLAUDE_CLI_VERSION_ALERT", "off")], json!({}), None), Verdict::Allow);
    h.write(".anti-hall/skip.json", &format!("{{\"claude-cli-version\":{}}}", (now() + 60_000.0) as i64));
    assert_eq!(run(c, &h, &[], json!({}), None), Verdict::Allow);
    assert_eq!(h.read(file).unwrap(), text);
}

#[test]
fn a_hook_without_a_usable_home_defers() {
    let h = Tmp::new("nohome");
    let env = RequestEnv::from_pairs([("PATH", "/usr/bin")]);
    let s = Subject { event: "SessionStart", tool: None, cwd: None, tool_input: &Value::Null, prompt: None };
    for name in ["claude-cli-version", "devswarm-version", "defect-nudge", "progress-prune"] {
        let v = crate::checks::get(name).unwrap().run_env(&s, &json!({"cwd": h.s()}), &Value::Null, &env);
        assert_eq!(v, Some(Verdict::Defer), "{name}");
    }
    let rel = RequestEnv::from_pairs([("HOME", "relative/home")]);
    assert_eq!(crate::checks::get("claude-cli-version").unwrap().run_env(&s, &json!({}), &Value::Null, &rel), Some(Verdict::Defer));
}

#[test]
fn another_event_is_left_to_node() {
    let h = Tmp::new("event");
    let env = RequestEnv::from_pairs([("HOME", h.s())]);
    let s = Subject { event: "PreToolUse", tool: None, cwd: None, tool_input: &Value::Null, prompt: None };
    for name in ["version-alert", "devswarm-version", "claude-cli-version", "repo-self-drift", "defect-nudge", "progress-prune"] {
        assert_eq!(crate::checks::get(name).unwrap().run_env(&s, &json!({}), &Value::Null, &env), Some(Verdict::Defer), "{name}");
    }
}

// ---- version-alert --------------------------------------------------------------------------------------------------------------

fn plugin(h: &Tmp, version: &str) -> String {
    let root = h.path().join("plugin");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::write(root.join(".claude-plugin/plugin.json"), format!("{{\"version\":\"{version}\"}}")).unwrap();
    root.to_string_lossy().to_string()
}

#[test]
fn version_alert_says_update_once_per_session_and_defers_on_a_stale_cache() {
    let h = Tmp::new("va-update");
    let root = plugin(&h, "1.2.3");
    let c = crate::checks::get("version-alert").unwrap();
    assert_eq!(run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)), Verdict::Defer, "no cache: Node starts the refresh");
    let cache = |ago: f64| format!("{{\"latest\":\"1.2.4\",\"checkedAt\":{}}}", (now() - ago) as i64);
    h.write(".anti-hall/version-check.json", &cache(86_400_000.0));
    assert_eq!(run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)), Verdict::Defer, "stale cache");
    h.write(".anti-hall/version-check.json", &cache(60_000.0));
    let t = advisory_text(&run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)));
    assert!(
        t.starts_with("⬆️ anti-hall · version-alert: v1.2.4 is available (you are running v1.2.3).\nDo instead: tell the user now: run /anti-hall:update"),
        "{t}"
    );
    assert!(
        h.read(".anti-hall/version-check.json")
            .unwrap()
            .ends_with(",\"lastAdvised\":{\"case\":\"update\",\"sessionId\":\"s1\",\"latest\":\"1.2.4\",\"running\":\"1.2.3\"}}")
    );
    assert_eq!(run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)), Verdict::Allow, "the same session is told once");
    assert!(matches!(run(c, &h, &[], json!({"session_id": "s2"}), Some(&root)), Verdict::Advisory(_)), "another session is told again");
}

#[test]
fn version_alert_case_two_names_the_mirrored_release_and_its_changelog_headline() {
    let h = Tmp::new("va-reload");
    let root = plugin(&h, "1.2.3");
    h.write(".claude/plugins/cache/anti-hall/anti-hall/v1.2.4/CHANGELOG.md", "# C\n\n## 1.2.4 - x\n\n- Fixed the thing\n- second\n\n## 1.2.3\n- old\n");
    h.write(".claude/plugins/installed_plugins.json", r#"{"version":2,"plugins":{"anti-hall@anti-hall":[{"scope":"user","version":"1.2.3"}]}}"#);
    let c = crate::checks::get("version-alert").unwrap();
    let t = advisory_text(&run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)));
    assert!(
        t.contains("v1.2.4 is downloaded locally (you are running v1.2.3) but the Claude Code harness has not registered it yet.")
            && t.ends_with("\nHighlight: Fixed the thing"),
        "{t}"
    );
    let marker = h.read(".anti-hall/version-alert-reload.json").unwrap();
    assert!(
        marker.starts_with("{\"checkedAt\":")
            && marker.ends_with(",\"lastAdvised\":{\"case\":\"reload\",\"sessionId\":\"s1\",\"mirrored\":\"v1.2.4\",\"running\":\"1.2.3\"}}"),
        "{marker}"
    );
    assert_eq!(run(c, &h, &[], json!({"session_id": "s1"}), Some(&root)), Verdict::Allow);
}

#[test]
fn a_changelog_cut_through_an_emoji_goes_back_to_node() {
    let h = Tmp::new("va-emoji");
    let root = plugin(&h, "1.2.3");
    h.write(".claude/plugins/cache/anti-hall/anti-hall/v1.2.4/CHANGELOG.md", &format!("## 1.2.4\n\n- {}😀 tail\n", "x".repeat(159)));
    assert_eq!(run(crate::checks::get("version-alert").unwrap(), &h, &[], json!({"session_id": "s1"}), Some(&root)), Verdict::Defer);
    assert!(h.read(".anti-hall/version-alert-reload.json").is_none(), "nothing written before the deferral");
}

// ---- repo-self-drift ---------------------------------------------------------------------------------------------------------------

#[test]
fn repo_self_drift_scans_when_stale_writes_the_cache_in_node_order_and_says_the_mismatch_once() {
    let h = Tmp::new("rsd");
    let root = h.path().join("plugin");
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::create_dir_all(root.join("skills/a")).unwrap();
    std::fs::create_dir_all(root.join("skills/b")).unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    for f in ["x.js", "y.js", "z.json"] {
        std::fs::write(root.join("hooks").join(f), "").unwrap();
    }
    std::fs::write(root.join("docs/KB.md"), "- Hooks: **5** `.js` files\n- Claude\n> skills: **2**\n").unwrap();
    let root = root.to_string_lossy().to_string();
    let c = crate::checks::get("repo-self-drift").unwrap();
    let t = advisory_text(&run(c, &h, &[], json!({}), Some(&root)));
    assert_eq!(t, "anti-hall repo self-drift — hooks: KB.md claims 5, actual 2 (docs/KB.md)");
    let cache = h.read(".anti-hall/repo-self-drift.json").unwrap();
    assert!(
        cache.contains("\"claimedHooks\":5,\"actualHooks\":2,\"claimedSkills\":2,\"actualSkills\":2,\"modelKbAuditDate\":\"2026-09-03\",\"modelKbAgeDays\":"),
        "{cache}"
    );
    assert!(cache.ends_with("\"lastAdvised\":{\"counts\":{\"claimedHooks\":5,\"actualHooks\":2,\"claimedSkills\":2,\"actualSkills\":2}}}"), "{cache}");
    assert_eq!(run(c, &h, &[], json!({}), Some(&root)), Verdict::Allow, "said once");
}

#[test]
fn a_claimed_count_too_long_for_exact_comparison_defers_before_anything_is_written() {
    let h = Tmp::new("rsd-long");
    let root = h.path().join("plugin");
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/KB.md"), format!("- Hooks: **{}** `.js` files\n", "9".repeat(20))).unwrap();
    let v = run(crate::checks::get("repo-self-drift").unwrap(), &h, &[], json!({}), Some(&root.to_string_lossy()));
    assert_eq!(v, Verdict::Defer);
    assert!(h.read(".anti-hall/repo-self-drift.json").is_none());
}

// ---- defect-nudge ------------------------------------------------------------------------------------------------------------------

fn report(proj: &str, at: &str) -> String {
    json!({"t": "report", "proj": proj, "v": "1.0.0", "at": at}).to_string()
}

#[test]
fn defect_nudge_counts_unfinished_reports_for_the_maintainer_and_arms_the_daily_stamp() {
    let h = Tmp::new("dn-maint");
    let proj = h.path().join("repo");
    std::fs::create_dir_all(proj.join("plugins/anti-hall/.claude-plugin")).unwrap();
    std::fs::write(proj.join("plugins/anti-hall/.claude-plugin/plugin.json"), "{}").unwrap();
    let ago = |days: f64| iso_string(now() - days * 86_400_000.0);
    h.write(".anti-hall/defects/aaaaaaaaaaaa.jsonl", &format!("{}\n", report("p", &ago(5.5))));
    h.write(
        ".anti-hall/defects/bbbbbbbbbbbb.jsonl",
        &format!("{}\n{}\n", report("p", &ago(9.5)), json!({"t": "ruling", "status": "fixed", "fixedIn": "1.0.0"})),
    );
    h.write(
        ".anti-hall/defects/cccccccccccc.jsonl",
        &format!(
            "{}\n{}\n{}\n",
            report("p", &ago(20.5)),
            json!({"t": "ruling", "status": "fixed", "fixedIn": "1.0.0"}),
            json!({"t":"report","proj":"p","v":"1.0.1","at":ago(1.5)})
        ),
    );
    let c = crate::checks::get("defect-nudge").unwrap();
    let t = advisory_text(&run(c, &h, &[], json!({"cwd": proj.to_string_lossy()}), None));
    assert_eq!(t, "💡 anti-hall · defect-nudge: 2 unfinished defect reports (1 regressed), oldest 20d.\nDo instead: run /anti-hall:defects.");
    assert!(h.read(".anti-hall/.defects-nudge-stamp.json").unwrap().starts_with("{\"lastSweep\":"));
    assert_eq!(run(c, &h, &[], json!({"cwd": proj.to_string_lossy()}), None), Verdict::Allow, "throttled by the stamp");
}

#[test]
fn a_sweep_this_port_cannot_judge_exactly_defers_without_arming_the_stamp() {
    let h = Tmp::new("dn-defer");
    let proj = h.path().join("repo");
    std::fs::create_dir_all(proj.join("plugins/anti-hall/.claude-plugin")).unwrap();
    std::fs::write(proj.join("plugins/anti-hall/.claude-plugin/plugin.json"), "{}").unwrap();
    // a date that depends on the time zone, and no working directory in the payload
    h.write(".anti-hall/defects/aaaaaaaaaaaa.jsonl", &format!("{}\n", report("p", "2026-09-01 10:00:00")));
    let c = crate::checks::get("defect-nudge").unwrap();
    assert_eq!(run(c, &h, &[], json!({"cwd": proj.to_string_lossy()}), None), Verdict::Defer);
    assert_eq!(run(c, &h, &[], json!({}), None), Verdict::Defer);
    assert!(h.read(".anti-hall/.defects-nudge-stamp.json").is_none(), "Node must still see an unarmed stamp");
}

#[test]
fn defect_nudge_tells_a_reporter_about_rulings_after_its_own_report_only() {
    let h = Tmp::new("dn-rptr");
    let proj = h.path().join("myproj");
    std::fs::create_dir_all(&proj).unwrap();
    let ruling = json!({"t": "ruling", "status": "ack"}).to_string();
    h.write(".anti-hall/defects/aaaaaaaaaaaa.jsonl", &format!("{}\n{ruling}\n", report("myproj", "2026-09-01T00:00:00.000Z")));
    h.write(".anti-hall/defects/bbbbbbbbbbbb.jsonl", &format!("{ruling}\n{}\n", report("myproj", "2026-09-01T00:00:00.000Z")));
    h.write(".anti-hall/defects/cccccccccccc.jsonl", &format!("{}\n{ruling}\n", report("other", "2026-09-01T00:00:00.000Z")));
    let t = advisory_text(&run(crate::checks::get("defect-nudge").unwrap(), &h, &[], json!({"cwd": proj.to_string_lossy()}), None));
    assert_eq!(t, "💡 anti-hall · defect-nudge: rulings on 1 defects you reported.\nDo instead: run /anti-hall:defects mine.");
}

// ---- progress-prune ------------------------------------------------------------------------------------------------------------------

fn old_progress(proj: &Path, date: &str, sid: &str, text: &str, hours_old: u64) -> PathBuf {
    let f = proj.join(".anti-hall/progress").join(date).join(format!("{sid}.md"));
    std::fs::create_dir_all(f.parent().unwrap()).unwrap();
    std::fs::write(&f, text).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(hours_old * 3600);
    std::fs::File::options().write(true).open(&f).unwrap().set_modified(t).unwrap();
    f
}

fn quiet_env() -> [(&'static str, &'static str); 1] {
    [("ANTIHALL_GITIGNORE_HINT", "off")]
}

#[test]
fn progress_prune_archives_a_stale_progress_file_before_removing_it() {
    let h = Tmp::new("pp-archive");
    let proj = h.path().join("proj");
    let stale = old_progress(&proj, "2026-09-01", "s1", "line1\r\nline2\n", 30);
    let recent = old_progress(&proj, "2026-09-01", "s2", "recent\n", 2);
    let today = old_progress(&proj, &iso_date(now()), "s3", "today\n", 30);
    let c = crate::checks::get("progress-prune").unwrap();
    let before = now();
    assert_eq!(run(c, &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None), Verdict::Allow);
    assert!(!stale.exists() && recent.exists() && today.exists());
    let ledger = std::fs::read_to_string(proj.join(".anti-hall/history/2026-09-01/s1.md")).unwrap();
    assert!(ledger.starts_with("\n## Archived progress (pruned 20") && ledger.ends_with(")\n\n> line1\n> line2\n> \n\n"), "{ledger:?}");
    let state = h.read(".anti-hall/progress-prune-state.json").unwrap();
    let key = cwd_key_for_test(&proj.to_string_lossy());
    assert!(state.starts_with(&format!("{{\"{key}\":{{\"lastPrunedAt\":")), "{state}");
    let Parsed::Ok(parsed) = parse(&state) else { panic!("state is not JSON: {state}") };
    let marked = parsed.get(&key).and_then(|e| e.get("lastPrunedAt")).and_then(J::finite).unwrap();
    assert!((before..=now()).contains(&marked), "the throttle mark is the time of the pass: {marked} not in {before}..");
    // the next call within the day does nothing, even for a new stale file
    let later = old_progress(&proj, "2026-09-02", "s4", "later\n", 40);
    assert_eq!(run(c, &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None), Verdict::Allow);
    assert!(later.exists());
}

#[test]
fn a_progress_file_is_never_removed_when_its_ledger_cannot_be_written() {
    let h = Tmp::new("pp-keep");
    let proj = h.path().join("proj");
    let stale = old_progress(&proj, "2026-09-01", "s1", "keep me\n", 30);
    std::fs::write(proj.join(".anti-hall/history"), "a file where the ledger directory should be").unwrap();
    run(crate::checks::get("progress-prune").unwrap(), &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None);
    assert_eq!(std::fs::read_to_string(&stale).unwrap(), "keep me\n");
}

#[test]
fn no_progress_directory_means_no_throttle_mark() {
    let h = Tmp::new("pp-nodir");
    let proj = h.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    run(crate::checks::get("progress-prune").unwrap(), &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None);
    assert!(h.read(".anti-hall/progress-prune-state.json").is_none(), "Node throws on the missing directory before it records the pass");
}

#[test]
fn the_prune_switch_off_still_runs_the_gitignore_hint_path_but_prunes_nothing() {
    let h = Tmp::new("pp-off");
    let proj = h.path().join("proj");
    let stale = old_progress(&proj, "2026-09-01", "s1", "x\n", 30);
    h.write(".anti-hall/settings.json", r#"{"maintenance":{"progressPrune":false}}"#);
    run(crate::checks::get("progress-prune").unwrap(), &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None);
    assert!(stale.exists() && h.read(".anti-hall/progress-prune-state.json").is_none());
}

#[test]
fn a_git_file_in_an_unread_shape_defers_before_anything_is_pruned() {
    let h = Tmp::new("pp-gitfile");
    let proj = h.path().join("proj");
    let stale = old_progress(&proj, "2026-09-01", "s1", "x\n", 30);
    std::fs::write(proj.join(".git"), "gitdir:  /somewhere/with/two/spaces\n").unwrap();
    let v = run(crate::checks::get("progress-prune").unwrap(), &h, &quiet_env(), json!({"cwd": proj.to_string_lossy()}), None);
    assert_eq!(v, Verdict::Defer);
    assert!(stale.exists() && h.read(".anti-hall/progress-prune-state.json").is_none());
}

#[test]
fn a_relative_working_directory_defers() {
    let h = Tmp::new("pp-rel");
    assert_eq!(run(crate::checks::get("progress-prune").unwrap(), &h, &quiet_env(), json!({"cwd": "proj"}), None), Verdict::Defer);
}
