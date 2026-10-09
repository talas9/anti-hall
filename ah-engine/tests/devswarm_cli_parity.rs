//! Parity of the store-free DevSwarm CLI verbs: `ah-engine mesh <argv>` (mesh.engine_writes = on) against the real
//! `node scripts/devswarm.js <argv>` (lane l8: `help`, the unknown-command answer, `skip`, `archive-ignore`,
//! `archive-unignore`, `gate-intent`, `notice --list`).
//!
//! Every case runs the real Node CLI and the engine on identical scratch homes with the same pinned clock and compares the
//! exact stdout, the exit code and every file under the home. A case the engine must hand to Node is run a third time with no
//! Node on the PATH: it must exit 75 (the engine could not run Node itself), print nothing and write nothing. The background
//! Node witness of each answered call is checked at the end: it must have logged a match.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const NOW: i64 = 1_795_000_000_000;

/// The Node program the engine's witness uses (pins the clock, loads devswarm.js as the main module).
const SNIPPET: &str = "const c=process.argv[1],n=Number(process.argv[2]);Date.now=()=>n;process.argv=[process.argv[0],c].concat(process.argv.slice(3));require('module')._load(c,null,true);";

struct Case {
    name: String,
    argv: Vec<String>,
    /// Runs on the home before the verb.
    setup: fn(&Path),
    env: Vec<(&'static str, String)>,
    /// Whether the engine answers (otherwise it must defer).
    native: bool,
    /// The telemetry label of the verb.
    label: &'static str,
    /// Files under the home that must exist after the verb (proof the case wrote what it should).
    writes: Vec<&'static str>,
}

fn case(name: &str, argv: &[&str], label: &'static str) -> Case {
    Case { name: name.into(), argv: argv.iter().map(|s| (*s).into()).collect(), setup: nothing, env: vec![], native: true, label, writes: vec![] }
}

fn nothing(_: &Path) {}

fn put(h: &Path, rel: &str, text: &str) {
    let p = h.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn skip_existing(h: &Path) {
    put(h, ".anti-hall/skip.json", "{\"edit-guard\": 1800000000000, \"7\": 5, \"b\": [1,2]}");
}
fn skip_array(h: &Path) {
    put(h, ".anti-hall/skip.json", "[1,2,3]");
}
fn skip_scalar(h: &Path) {
    put(h, ".anti-hall/skip.json", "42");
}
fn skip_garbage(h: &Path) {
    put(h, ".anti-hall/skip.json", "{not json");
}
fn skip_blank(h: &Path) {
    put(h, ".anti-hall/skip.json", "  \n ");
}
fn skip_surrogate(h: &Path) {
    put(h, ".anti-hall/skip.json", "{\"x\":\"\\ud800\"}");
}
fn skip_unwritable_target(h: &Path) {
    fs::create_dir_all(h.join(".anti-hall/skip.json")).unwrap();
}
fn mark_exists(h: &Path) {
    put(h, ".anti-hall/devswarm/archive-ignore/ws-1.json", "{\"id\":\"ws-1\",\"ignoredAt\":1}");
}
fn mark_is_a_directory(h: &Path) {
    fs::create_dir_all(h.join(".anti-hall/devswarm/archive-ignore/ws-1.json")).unwrap();
}
fn gate_state(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"blocks\":2,\"sig\":\"abc123\",\"escalated\":false,\"qSig\":\"q\"}");
}
fn gate_state_with_intents(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"9\":1,\"sig\":\"s2\",\"intents\":{\"old\":{\"ts\":1,\"reason\":\"r\"}},\"intentAcks\":3}");
}
fn gate_state_no_sig(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"blocks\":2}");
}
fn gate_state_empty_sig(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"sig\":\"\"}");
}
fn gate_state_array(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "[{\"sig\":\"x\"}]");
}
fn gate_state_garbage(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{oops");
}
fn gate_state_proto_sig(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"sig\":\"__proto__\"}");
}
fn gate_state_proto_key(h: &Path) {
    put(h, ".anti-hall/devswarm/parent-gate/sess-1.json", "{\"sig\":\"k\",\"__proto__\":{\"a\":1}}");
}
fn gate_state_weird_session(h: &Path) {
    // `sess/😀ü😀x y`: every unit outside [A-Za-z0-9_.-] is an underscore, and an emoji is two UTF-16 units
    put(h, ".anti-hall/devswarm/parent-gate/sess______x_y.json", "{\"sig\":\"w\"}");
}
fn notices_mixed(h: &Path) {
    let now = NOW;
    let rows = [
        format!("{{\"id\":\"a\",\"ts\":{},\"expiresAt\":{},\"text\":\"first\"}}", now - 5000, now + 100_000),
        format!("{{\"id\":\"b\",\"ts\":{},\"expiresAt\":{},\"text\":\"expired\"}}", now - 4000, now - 1),
        format!("{{\"id\":\"c\",\"ts\":{},\"expiresAt\":{},\"text\":\"third\",\"extra\":1}}", now - 3000, now + 100_000),
        "  ".to_string(),
        format!("{{\"id\":\"d\",\"ts\":\"{}\",\"text\":\"string ts, no expiry\"}}", now - 6000),
        "[1,2]".to_string(),
        "{\"no\":\"id\"}".to_string(),
        "{\"id\":0,\"text\":\"falsy id\"}".to_string(),
        "{\"id\":\"e\",\"ts\":null,\"expiresAt\":\"soon\",\"text\":null}".to_string(),
        format!("{{\"id\":\"f\",\"ts\":{},\"expiresAt\":{}}}\r", now - 1000, now),
        format!("{{\"id\":\"g\",\"ts\":{},\"expiresAt\":{},\"text\":{{\"a\":[1,{{\"b\":2}}]}}}}", now - 2000, now + 1),
    ];
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", &(rows.join("\n") + "\n"));
}
fn notices_many(h: &Path) {
    let rows: Vec<String> = (0..9).map(|i| format!("{{\"id\":\"n{i}\",\"ts\":{},\"text\":\"t{i}\"}}", NOW - 1000 * (9 - i))).collect();
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", &(rows.join("\n") + "\n"));
}
fn notices_equal_ts(h: &Path) {
    let rows: Vec<String> = (0..4).map(|i| format!("{{\"id\":\"q{i}\",\"ts\":5,\"text\":\"t{i}\"}}")).collect();
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", &(rows.join("\n") + "\n"));
}
fn notices_corrupt_line(h: &Path) {
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", "{\"id\":\"ok\",\"ts\":1}\n{broken\n");
}
fn notices_ts_object(h: &Path) {
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", "{\"id\":\"o\",\"ts\":{\"a\":1}}\n{\"id\":\"p\",\"ts\":2}\n");
}
fn notices_ts_infinity(h: &Path) {
    put(h, ".anti-hall/devswarm/maintainer-notices.jsonl", "{\"id\":\"o\",\"ts\":\"Infinity\"}\n{\"id\":\"p\",\"ts\":2}\n");
}

fn long_reason() -> String {
    "x".repeat(2300)
}

fn cases(verbs: &[String]) -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    // ---- help and the unknown-command answer ----
    for (n, a) in [
        ("help", vec!["help"]),
        ("help-json", vec!["help", "--json"]),
        ("help-short", vec!["help", "--short"]),
        ("help-short-json", vec!["help", "--short", "--json"]),
        ("dash-h", vec!["-h"]),
        ("dash-dash-help", vec!["--help"]),
        ("dash-dash-h", vec!["--h"]),
        ("help-short-with-flag-form", vec!["--help", "--short"]),
        ("help-unknown-verb", vec!["help", "nonsense"]),
        ("help-unknown-verb-json", vec!["help", "nonsense", "--json"]),
        ("help-empty-verb", vec!["help", ""]),
        ("help-verb-then-short", vec!["help", "send", "--short"]),
        ("help-json-before-verb", vec!["help", "--json", "send"]),
        ("verb-then-dash-h", vec!["inbox", "x", "-h"]),
        ("unknown-then-help", vec!["bogus", "--help"]),
        ("help-after-flag-value", vec!["send", "--message", "hi", "--help"]),
        ("help-equals-json", vec!["help", "--json=1"]),
        ("healthcheck-help-json", vec!["healthcheck", "--help", "--json"]),
        ("diagnose-help-json", vec!["diagnose", "-h", "--json"]),
        ("app-state-help", vec!["app-state", "-h"]),
        ("send-quiet-json-help", vec!["send", "--quiet", "--help", "--json"]),
    ] {
        v.push(case(n, &a, "Help"));
    }
    for (n, a) in [
        ("send-quiet-help", vec!["send", "--quiet", "--help"]),
        ("tick-quiet-help", vec!["inbox", "tick", "x", "--quiet", "--help"]),
        ("read-primary-text-help", vec!["inbox", "read-primary", "x", "--format", "text", "--help"]),
        ("read-primary-text-equals-help", vec!["inbox", "read-primary", "x", "--format=text", "--help"]),
    ] {
        v.push(Case { native: false, ..case(n, &a, "Help") });
    }
    v.push(case("read-primary-json-format-help", &["inbox", "read-primary", "x", "--format", "json", "--help"], "Help"));
    // `help` only counts as the first word: here it is `send`'s stray argument, and the send is Node's
    v.push(Case { native: false, ..case("help-word-not-first", &["send", "help"], "Send") });
    for verb in verbs {
        v.push(case(&format!("help-{verb}"), &["help", verb], "Help"));
        v.push(case(&format!("help-{verb}-json"), &["help", verb, "--json"], "Help"));
        // main() renders a help result with these verbs' own renderers: Node's
        let own = ["healthcheck", "diagnose", "supervision-report"].contains(&verb.as_str());
        v.push(Case { native: !own, ..case(&format!("{verb}-dash-dash-help"), &[verb, "--help"], "Help") });
    }
    for (n, a) in [
        ("unknown-verb", vec!["bogus"]),
        ("unknown-verb-with-args", vec!["bogus", "extra", "--x", "1"]),
        ("verb-with-capitals", vec!["Skip", "x"]),
        ("verb-with-a-quote", vec!["a\"b"]),
        ("verb-with-unicode", vec!["ü\u{1F600}\u{7f}x"]),
        ("empty-verb", vec![""]),
    ] {
        v.push(case(n, &a, "Unknown"));
    }
    // ---- skip ----
    let mut s = |n: &str, a: &[&str], setup: fn(&Path), native: bool| {
        let mut c = case(n, a, "Skip");
        c.setup = setup;
        c.native = native;
        v.push(c);
    };
    s("skip-default-ttl", &["skip", "edit-guard"], nothing, true);
    s("skip-ttl", &["skip", "edit-guard", "--ttl", "5"], nothing, true);
    s("skip-ttl-fraction", &["skip", "edit-guard", "--ttl", "0.5"], nothing, true);
    s("skip-ttl-tiny", &["skip", "edit-guard", "--ttl", "0.0000001"], nothing, true);
    s("skip-ttl-equals", &["skip", "edit-guard", "--ttl=7"], nothing, true);
    s("skip-ttl-hex", &["skip", "edit-guard", "--ttl", "0x10"], nothing, true);
    s("skip-ttl-exponent", &["skip", "edit-guard", "--ttl", "1e3"], nothing, true);
    s("skip-ttl-spaces", &["skip", "edit-guard", "--ttl", " 12 "], nothing, true);
    s("skip-ttl-years-ahead", &["skip", "edit-guard", "--ttl", "100000000"], nothing, true);
    s("skip-ttl-expanded-year", &["skip", "edit-guard", "--ttl", "10000000000"], nothing, true);
    s("skip-ttl-past-the-date-range", &["skip", "edit-guard", "--ttl", "1e12"], nothing, false);
    s("skip-ttl-overflows", &["skip", "edit-guard", "--ttl", "1e308"], nothing, true);
    s("skip-ttl-infinity", &["skip", "edit-guard", "--ttl", "Infinity"], nothing, true);
    s("skip-ttl-zero", &["skip", "edit-guard", "--ttl", "0"], nothing, true);
    s("skip-ttl-negative", &["skip", "edit-guard", "--ttl", "-3"], nothing, true);
    s("skip-ttl-word", &["skip", "edit-guard", "--ttl", "abc"], nothing, true);
    s("skip-ttl-empty", &["skip", "edit-guard", "--ttl="], nothing, true);
    s("skip-ttl-bare-at-end", &["skip", "edit-guard", "--ttl"], nothing, true);
    s("skip-ttl-bare-before-flag", &["skip", "edit-guard", "--ttl", "--x"], nothing, true);
    s("skip-ttl-repeated", &["skip", "edit-guard", "--ttl", "1", "--ttl", "9"], nothing, true);
    s("skip-no-guard", &["skip"], nothing, true);
    s("skip-empty-guard", &["skip", ""], nothing, true);
    s("skip-guard-all", &["skip", "all", "--ttl", "30"], nothing, true);
    s("skip-guard-integer-like", &["skip", "7"], skip_existing, true);
    s("skip-guard-integer-like-new", &["skip", "3"], skip_existing, true);
    s("skip-into-existing", &["skip", "new-guard"], skip_existing, true);
    s("skip-over-existing-key", &["skip", "edit-guard"], skip_existing, true);
    s("skip-guard-with-quotes", &["skip", "we\"ird\\guard\u{1F600}"], skip_existing, true);
    s("skip-existing-array-starts-over", &["skip", "g"], skip_array, true);
    s("skip-existing-scalar-starts-over", &["skip", "g"], skip_scalar, true);
    s("skip-existing-blank-starts-over", &["skip", "g"], skip_blank, true);
    s("skip-existing-garbage", &["skip", "g"], skip_garbage, false);
    s("skip-existing-lone-surrogate", &["skip", "g"], skip_surrogate, false);
    s("skip-target-is-a-directory", &["skip", "g"], skip_unwritable_target, false);
    s("skip-proto-key", &["skip", "__proto__"], nothing, false);
    // ---- archive-ignore / archive-unignore ----
    let mut i = |n: &str, a: &[&str], label: &'static str, setup: fn(&Path), native: bool, writes: Vec<&'static str>| {
        let mut c = case(n, a, label);
        c.setup = setup;
        c.native = native;
        c.writes = writes;
        v.push(c);
    };
    let mark = ".anti-hall/devswarm/archive-ignore/ws-1.json";
    i("ignore", &["archive-ignore", "ws-1"], "ArchiveIgnore", nothing, true, vec![mark]);
    i("ignore-again", &["archive-ignore", "ws-1"], "ArchiveIgnore", mark_exists, true, vec![mark]);
    i("ignore-no-id", &["archive-ignore"], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-unsafe-id", &["archive-ignore", "../x"], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-id-with-dots", &["archive-ignore", "a..b"], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-id-dot", &["archive-ignore", "."], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-id-with-slash", &["archive-ignore", "a/b"], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-id-unicode", &["archive-ignore", "wü"], "ArchiveIgnore", nothing, true, vec![]);
    i("ignore-id-safe-punctuation", &["archive-ignore", "A_b-1.2"], "ArchiveIgnore", nothing, true, vec![".anti-hall/devswarm/archive-ignore/A_b-1.2.json"]);
    i("ignore-target-is-a-directory", &["archive-ignore", "ws-1"], "ArchiveIgnore", mark_is_a_directory, false, vec![]);
    i("unignore-removes", &["archive-unignore", "ws-1"], "ArchiveUnignore", mark_exists, true, vec![]);
    i("unignore-nothing-to-remove", &["archive-unignore", "ws-1"], "ArchiveUnignore", nothing, true, vec![]);
    i("unignore-a-directory", &["archive-unignore", "ws-1"], "ArchiveUnignore", mark_is_a_directory, true, vec![]);
    i("unignore-no-id", &["archive-unignore"], "ArchiveUnignore", nothing, true, vec![]);
    i("unignore-unsafe-id", &["archive-unignore", "x/y"], "ArchiveUnignore", nothing, true, vec![]);
    // ---- gate-intent ----
    let gate = ".anti-hall/devswarm/parent-gate/sess-1.json";
    let mut g = |n: &str, a: &[&str], setup: fn(&Path), env: Vec<(&'static str, String)>, native: bool, writes: Vec<&'static str>| {
        let mut c = case(n, a, "GateIntent");
        c.setup = setup;
        c.env = env;
        c.native = native;
        c.writes = writes;
        v.push(c);
    };
    let s1 = || vec![("CLAUDE_CODE_SESSION_ID", "sess-1".to_string())];
    g("gate-intent", &["gate-intent", "--reason", "waiting on CI"], gate_state, s1(), true, vec![gate]);
    g("gate-intent-keeps-other-fields-and-replaces-intents", &["gate-intent", "--reason", "again"], gate_state_with_intents, s1(), true, vec![gate]);
    g("gate-intent-reason-is-trimmed", &["gate-intent", "--reason", "  padded \u{a0}\n"], gate_state, s1(), true, vec![gate]);
    g("gate-intent-long-reason-is-cut", &["gate-intent", "--reason", &long_reason()], gate_state, s1(), true, vec![gate]);
    g("gate-intent-session-flag", &["gate-intent", "--session", "sess-1", "--reason", "r"], gate_state, vec![], true, vec![gate]);
    g(
        "gate-intent-flag-beats-env",
        &["gate-intent", "--session", "sess-1", "--reason", "r"],
        gate_state,
        vec![("CLAUDE_CODE_SESSION_ID", "other".into())],
        true,
        vec![gate],
    );
    g("gate-intent-builder-id-fallback", &["gate-intent", "--reason", "r"], gate_state, vec![("DEVSWARM_BUILDER_ID", "sess-1".into())], true, vec![gate]);
    g(
        "gate-intent-empty-env-falls-through",
        &["gate-intent", "--reason", "r"],
        gate_state,
        vec![("CLAUDE_CODE_SESSION_ID", "".into()), ("DEVSWARM_BUILDER_ID", "sess-1".into())],
        true,
        vec![gate],
    );
    g("gate-intent-no-session", &["gate-intent", "--reason", "r"], gate_state, vec![], true, vec![]);
    g("gate-intent-bare-session-flag", &["gate-intent", "--reason", "r", "--session"], gate_state, vec![], true, vec![]);
    g("gate-intent-no-reason", &["gate-intent"], gate_state, s1(), true, vec![]);
    g("gate-intent-blank-reason", &["gate-intent", "--reason", "   "], gate_state, s1(), true, vec![]);
    g("gate-intent-bare-reason", &["gate-intent", "--reason"], gate_state, s1(), true, vec![]);
    g("gate-intent-no-state-file", &["gate-intent", "--reason", "r"], nothing, s1(), true, vec![]);
    g("gate-intent-state-without-sig", &["gate-intent", "--reason", "r"], gate_state_no_sig, s1(), true, vec![]);
    g("gate-intent-state-with-empty-sig", &["gate-intent", "--reason", "r"], gate_state_empty_sig, s1(), true, vec![]);
    g("gate-intent-state-is-an-array", &["gate-intent", "--reason", "r"], gate_state_array, s1(), true, vec![]);
    g("gate-intent-state-is-garbage", &["gate-intent", "--reason", "r"], gate_state_garbage, s1(), false, vec![]);
    g("gate-intent-sig-is-proto", &["gate-intent", "--reason", "r"], gate_state_proto_sig, s1(), false, vec![]);
    g("gate-intent-state-has-a-proto-key", &["gate-intent", "--reason", "r"], gate_state_proto_key, s1(), false, vec![]);
    g(
        "gate-intent-session-with-odd-characters",
        &["gate-intent", "--reason", "r"],
        gate_state_weird_session,
        vec![("CLAUDE_CODE_SESSION_ID", "sess/\u{1F600}\u{fc}\u{1F600}x y".into())],
        true,
        vec![],
    );
    // ---- notice ----
    let mut nn = |n: &str, a: &[&str], setup: fn(&Path), native: bool| {
        let mut c = case(n, a, "Notice");
        c.setup = setup;
        c.native = native;
        v.push(c);
    };
    nn("notice-list-no-file", &["notice", "--list"], nothing, true);
    nn("notice-list-mixed-rows", &["notice", "--list"], notices_mixed, true);
    nn("notice-list-shows-the-newest-five", &["notice", "--list"], notices_many, true);
    nn("notice-list-equal-timestamps-keep-file-order", &["notice", "--list"], notices_equal_ts, true);
    nn("notice-list-corrupt-line", &["notice", "--list"], notices_corrupt_line, false);
    nn("notice-list-object-ts", &["notice", "--list"], notices_ts_object, false);
    nn("notice-list-infinite-ts", &["notice", "--list"], notices_ts_infinity, false);
    nn("notice-usage", &["notice"], nothing, true);
    nn("notice-usage-with-other-flag", &["notice", "--ttl", "7d"], nothing, true);
    nn("notice-post-is-node", &["notice", "--post", "hello"], nothing, false);
    nn("notice-post-and-list-is-node", &["notice", "--list", "--post", "x"], nothing, false);
    v
}

fn tools_path(root: &Path, with_node: bool) -> String {
    let bin = root.join(if with_node { "tools-bin" } else { "nonode-bin" });
    fs::create_dir_all(&bin).unwrap();
    let list: &[&str] = if with_node { &["node", "git", "ps"] } else { &["git", "ps"] };
    for t in list {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.display().to_string()
}

fn node_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let cli = plugin_root().join("scripts").join("devswarm.js");
    let mut c = Command::new("node");
    c.arg("-e").arg(SNIPPET).arg(&cli).arg(now.to_string()).args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), env));
    let o = run(&mut c, None);
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

fn engine_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let a: Vec<&str> = argv.iter().map(String::as_str).collect();
    engine_verb(home, &home.join("state"), cwd, &a, now, None, env)
}

fn with_path<'a>(mut e: Vec<(&'a str, &'a str)>, p: &'a str) -> Vec<(&'a str, &'a str)> {
    e.push(("PATH", p));
    e
}

fn tree(home: &Path) -> BTreeMap<String, String> {
    home_files(home).into_iter().map(|(k, v)| (k, String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>"))).collect()
}

fn verify_lines(state: &Path) -> Vec<Value> {
    fs::read_to_string(state.join("mesh-verify.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[test]
fn the_store_free_cli_verbs_match_node_and_defer_what_they_cannot_reproduce() {
    let root = std::env::temp_dir().join(format!("ah-dscli-{}", std::process::id()));
    fs::remove_dir_all(&root).ok();
    fs::create_dir_all(&root).unwrap();
    let root = real(&root);
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }
    let _cleanup = Cleanup(root.clone());
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let tools = tools_path(&root, true);
    let nonode = tools_path(&root, false);
    // the verb list is Node's own (also checks the shipped list)
    let o = Command::new("node")
        .args(["-e", "console.log(JSON.stringify(require(process.argv[1]).run(['help']).result.verbs))"])
        .arg(plugin_root().join("scripts").join("devswarm.js"))
        .env_clear()
        .env("PATH", &tools)
        .env("HOME", &root)
        .output()
        .unwrap();
    let verbs: Vec<String> = serde_json::from_slice(&o.stdout).unwrap();
    assert!(verbs.len() >= 40, "{verbs:?}");
    let all = cases(&verbs);
    let (mut native, mut deferred) = (0, 0);
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for (i, c) in all.iter().enumerate() {
        let now = NOW + i as i64 * 7_919;
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| root.join(format!("h{i}-{k}"))).collect();
        for h in &homes {
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            (c.setup)(h);
        }
        let env: Vec<(&str, &str)> = c.env.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let n = node_cli(&homes[0], &cwd, &c.argv, now, &with_path(env.clone(), tools.as_str()));
        let e = engine_cli(&homes[1], &cwd, &c.argv, now, &with_path(env.clone(), tools.as_str()));
        let log = last_log(&homes[1].join("state"));
        let answered = log["result"] == "native";
        assert_eq!(answered, c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!(log["verb"], c.label, "{}: telemetry names the verb", c.name);
            // the verbs name the home in their output (`skip` prints the file it wrote): each side's own, made equal
            let (es, ns) = (e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>"), n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>"));
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {:?}\n node:   {:?}", c.name, es, ns);
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            for w in &c.writes {
                assert!(homes[1].join(w).is_file(), "{}: expected the verb to have written {w}", c.name);
            }
            pending.push((c.name.clone(), homes[1].join("state")));
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            // Node's own run (the fallback) uses the real clock: the digits of a timestamp are masked
            let mask = |t: &str, h: &Path| {
                t.replace(h.to_string_lossy().as_ref(), "<HOME>").chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect::<String>()
            };
            assert_eq!(mask(&e.stdout, &homes[1]), mask(&n.stdout, &homes[0]), "{}: the fallback prints what Node prints", c.name);
            let pre = tree(&homes[2]);
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &with_path(env.clone(), nonode.as_str()));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            assert!(pre == tree(&homes[2]), "{}: a deferral wrote", c.name);
        }
    }
    // the background Node witness of every answered call must have logged a match
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    for (name, state) in &pending {
        let line = loop {
            if let Some(l) = verify_lines(state).into_iter().last() {
                break l;
            }
            assert!(std::time::Instant::now() < deadline, "{name}: the Node witness never logged");
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(line["result"], "match", "{name}: the background Node witness disagrees: {line}");
    }
    eprintln!("devswarm cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", all.len());
    assert!(native >= 150 && deferred >= 10, "{native} native, {deferred} deferred");
}

/// `ah-engine devswarm <verb> <devswarm.js argv>`: the role matrix decides who may run it, then it is the same front as
/// `ah-engine mesh <argv>`.
#[test]
fn the_devswarm_command_runs_the_cli_verbs_under_the_role_matrix() {
    let root = real(&{
        let r = std::env::temp_dir().join(format!("ah-dscli-roles-{}", std::process::id()));
        fs::remove_dir_all(&r).ok();
        fs::create_dir_all(&r).unwrap();
        r
    });
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }
    let _cleanup = Cleanup(root.clone());
    let tools = tools_path(&root, true);
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let mk = |name: &str, on: bool| {
        let h = root.join(name);
        fs::create_dir_all(h.join(".anti-hall")).unwrap();
        if on {
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        }
        h
    };
    let engine = |h: &Path, argv: &[&str], env: &[(&str, &str)]| {
        let mut e: Vec<(&str, &str)> = env.to_vec();
        e.push(("PATH", tools.as_str()));
        let mut c = Command::new(BIN);
        c.arg("devswarm").args(argv).current_dir(&cwd).env_clear().envs(base_env(h, &h.join("state"), &e)).env("AH_ENGINE_MESH_NOW_MS", NOW.to_string());
        let o = run(&mut c, None);
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    };
    let node = |h: &Path, argv: &[&str]| {
        let a: Vec<String> = argv.iter().map(|s| (*s).to_string()).collect();
        node_cli(h, &cwd, &a, NOW, &[("PATH", tools.as_str())])
    };
    // main session, engine on: the engine answers; the output is Node's
    let (hm, hn) = (mk("main", true), mk("node", true));
    let (code, out, _) = engine(&hm, &["skip", "tg", "--ttl", "5"], &[]);
    let n = node(&hn, &["skip", "tg", "--ttl", "5"]);
    assert_eq!((code, out.replace(hm.to_string_lossy().as_ref(), "<H>")), (n.code, n.stdout.replace(hn.to_string_lossy().as_ref(), "<H>")));
    assert_eq!(last_log(&hm.join("state"))["verb"], "Skip");
    assert_eq!(fs::read(hm.join(".anti-hall/skip.json")).unwrap(), fs::read(hn.join(".anti-hall/skip.json")).unwrap());
    // `--json` is kept in place for the parser
    let (code, out, _) = engine(&hm, &["help", "skip", "--json"], &[]);
    let n = node(&hn, &["help", "skip", "--json"]);
    assert_eq!((code, out), (n.code, n.stdout));
    // a workspace child may read (help) but not act
    let hc = mk("child", true);
    let child = [("ANTIHALL_DEVSWARM_SOURCE_BRANCH", "feat")];
    let (code, out, _) = engine(&hc, &["help", "send"], &child);
    assert_eq!((code, out), (0, node(&hn, &["help", "send"]).stdout));
    for argv in
        [vec!["skip", "tg"], vec!["archive-ignore", "w1"], vec!["archive-unignore", "w1"], vec!["gate-intent", "--reason", "r"], vec!["notice", "--list"]]
    {
        let (code, out, err) = engine(&hc, &argv, &child);
        assert_eq!(code, 64, "{argv:?}: {out} {err}");
        assert!(out.is_empty() && err.contains("not allowed for the child role"), "{argv:?}: {out} {err}");
    }
    assert!(!hc.join(".anti-hall/skip.json").exists(), "a refused verb writes nothing");
    // a subagent (any automated caller) is refused the same way and may read
    let hs = mk("sub", true);
    let sub = [("ANTIHALL_CALLER", "subagent")];
    let (code, _, err) = engine(&hs, &["skip", "tg"], &sub);
    assert!(code == 64 && err.contains("subagent"), "{code} {err}");
    assert_eq!(engine(&hs, &["help", "skip"], &sub).0, 0);
    // engine off: the same verbs run in Node
    let ho = mk("off", false);
    let (code, out, _) = engine(&ho, &["help", "skip"], &[]);
    let n = node(&hn, &["help", "skip"]);
    assert_eq!((code, out), (n.code, n.stdout));
    assert!(!ho.join("state").join("mesh-shadow.jsonl").exists(), "off: the engine did not answer");
    // an unknown verb is still refused by the command, before anything runs
    let (code, _, err) = engine(&hm, &["no-such-verb"], &[]);
    assert!(code == 64 && err.contains("unknown devswarm verb"), "{code} {err}");
}
