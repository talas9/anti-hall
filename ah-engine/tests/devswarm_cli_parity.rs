#![allow(
    dead_code,
    clippy::type_complexity,
    clippy::collapsible_if,
    clippy::needless_range_loop,
    clippy::useless_vec,
    clippy::regex_creation_in_loops,
    clippy::let_underscore_must_use
)]
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
    /// The working directory, relative to the test root (`cwd`: no checkout; `wt-child`: a linked worktree).
    cwd: &'static str,
}

fn case(name: &str, argv: &[&str], label: &'static str) -> Case {
    Case { name: name.into(), argv: argv.iter().map(|s| (*s).into()).collect(), setup: nothing, env: vec![], native: true, label, writes: vec![], cwd: "cwd" }
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

fn settings_with(h: &Path, devswarm: &str) {
    put(h, ".anti-hall/settings.json", &format!("{{\"mesh\":{{\"engine_writes\":\"on\"}},\"devswarm\":{devswarm}}}\n"));
}
fn wake_cron_setting(h: &Path) {
    settings_with(h, "{\"wakeCron\":\"*/5  1,2 * * 1-5\"}");
}
fn wake_cron_bad(h: &Path) {
    settings_with(h, "{\"wakeCron\":\"* * * *\"}");
}
fn wake_cron_letters(h: &Path) {
    settings_with(h, "{\"wakeCron\":\"a b c d e\"}");
}
fn rearm_inline(h: &Path) {
    settings_with(h, "{\"rearmOnTickOnly\":false}");
}
fn launchers_installed(h: &Path) {
    put(h, ".anti-hall/bin/devswarm.js", "// stable launcher\n");
    put(h, ".anti-hall/bin/wake-watch.js", "// stable watcher\n");
}
fn cli_launcher_only(h: &Path) {
    put(h, ".anti-hall/bin/devswarm.js", "// stable launcher\n");
}
fn launcher_is_a_directory(h: &Path) {
    fs::create_dir_all(h.join(".anti-hall/bin/devswarm.js")).unwrap();
}

fn log_line(ts: &str, component: &str, level: &str, repo: &str, msg: &str) -> String {
    format!("{{\"ts\":\"{ts}\",\"component\":\"{component}\",\"level\":\"{level}\",\"repoKey\":\"{repo}\",\"msg\":\"{msg}\"}}")
}
fn central_log(h: &Path) {
    let rows = [
        log_line("2026-11-18T10:06:40.000Z", "a-comp", "debug", "repo-1", "old debug"),
        log_line("2026-11-18T10:36:40.000Z", "b-comp", "info", "repo-2", "half hour ago"),
        "{broken line".to_string(),
        "   ".to_string(),
        log_line("2026-11-18T11:00:40.500Z", "a-comp", "warn", "repo-1", "six minutes"),
        "{\"ts\":\"2026-11-18T11:03:00.000Z\",\"component\":\"c-comp\",\"level\":\"error\",\"extra\":{\"n\":[1,2]},\"2\":\"int key\"}".to_string(),
        log_line("2026-11-18T11:06:30.000Z", "a-comp", "error", "repo-1", "ten seconds"),
        "{\"ts\":\"2026-11-18T11:06:35.000Z\",\"component\":7,\"level\":true}".to_string(),
        "{\"component\":\"no-ts\",\"level\":\"info\"}".to_string(),
    ];
    put(h, ".anti-hall/logs/devswarm.jsonl", &(rows.join("\n") + "\n"));
}
fn central_log_and_rotated(h: &Path) {
    put(h, ".anti-hall/logs/devswarm.jsonl", &(log_line("2026-11-18T11:00:00.000Z", "now", "info", "repo-1", "current") + "\n"));
    put(
        h,
        ".anti-hall/logs/devswarm.jsonl.1",
        &(log_line("2026-11-18T08:00:00.000Z", "older", "warn", "repo-1", "rotated away")
            + "\n"
            + &log_line("2026-11-18T10:59:00.000Z", "older", "error", "repo-2", "just before")
            + "\n"),
    );
}
fn central_log_odd_entry(h: &Path) {
    put(h, ".anti-hall/logs/devswarm.jsonl", "{\"ts\":\"2026-11-18T11:00:00.000Z\",\"component\":\"x\",\"level\":\"info\"}\n42\n");
}
fn central_log_odd_ts(h: &Path) {
    put(h, ".anti-hall/logs/devswarm.jsonl", "{\"ts\":\"yesterday\",\"component\":\"x\",\"level\":\"info\"}\n");
}
fn central_log_object_component(h: &Path) {
    put(h, ".anti-hall/logs/devswarm.jsonl", "{\"ts\":\"2026-11-18T11:00:00.000Z\",\"component\":{\"a\":1},\"level\":\"info\"}\n");
}
fn central_log_surrogate(h: &Path) {
    put(h, ".anti-hall/logs/devswarm.jsonl", "{\"ts\":\"2026-11-18T11:00:00.000Z\",\"msg\":\"\\ud800\"\n");
}
fn custom_log_dir(h: &Path) {
    put(h, "elsewhere/devswarm.jsonl", &(log_line("2026-11-18T11:00:00.000Z", "moved", "info", "repo-1", "in the override dir") + "\n"));
}

fn long_reason() -> String {
    "x".repeat(2300)
}

/// The child worktree the plan cases register (the test root's `wt-child`, a real path).
fn wt(h: &Path) -> String {
    h.parent().unwrap().join("wt-child").to_string_lossy().into_owned()
}

fn descriptor(h: &Path) {
    put(h, ".anti-hall/devswarm/workspaces/ws-1.json", &format!("{{\"id\":\"ws-1\",\"worktreePath\":{}}}", serde_json::to_string(&wt(h)).unwrap()));
}

fn descriptor_odd_worktree(h: &Path) {
    put(h, ".anti-hall/devswarm/workspaces/ws-1.json", "{\"id\":\"ws-1\",\"worktreePath\":7}");
}

fn plan_key(h: &Path) -> String {
    // the worktree's mesh id, as the plan file is named
    let o = Command::new("node")
        .args(["-e", "console.log(require(process.argv[1]).resolveContext(process.argv[2]).meshId)"])
        .arg(plugin_root().join("companion/lib/identity.js"))
        .arg(wt(h))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn put_plan(h: &Path, text: &str) {
    put(h, &format!(".anti-hall/devswarm/plans/{}.json", plan_key(h)), text);
}

fn plan_in_progress(h: &Path) {
    descriptor(h);
    put_plan(
        h,
        &format!(
            "{{\"v\":1,\"key\":\"k\",\"id\":\"ws-1\",\"worktreePath\":{},\"source\":\"spawn\",\"created_at\":1,\"base\":null,\"steps\":[{{\"n\":1,\"text\":\"alpha\",\"status\":\"done\",\"ts\":2,\"started_at\":2}},{{\"n\":2,\"text\":\"beta\",\"status\":\"doing\",\"ts\":3,\"started_at\":3}},{{\"n\":3,\"text\":\"gamma\",\"status\":\"todo\",\"ts\":null,\"started_at\":null}}],\"scope_globs\":[\"src/**\"],\"extras\":[{{\"glob\":\"docs/**\",\"note\":\"asked\",\"ts\":4}}],\"step_ts\":3,\"current\":2,\"warned_at\":null,\"warned_step\":null,\"summaries\":[],\"supervisor\":{{\"x\":1}},\"done_reported_at\":9}}",
            serde_json::to_string(&wt(h)).unwrap()
        ),
    );
}

fn plan_with_odd_extras(h: &Path) {
    descriptor(h);
    put_plan(h, "{\"steps\":[{\"n\":1,\"text\":\"a\",\"status\":\"todo\"}],\"extras\":[null]}");
}

fn plan_with_string_extras(h: &Path) {
    descriptor(h);
    put_plan(h, "{\"steps\":[{\"n\":1,\"text\":\"a\",\"status\":\"todo\"}],\"extras\":\"nope\",\"scope_globs\":0}");
}

fn plan_without_steps_array(h: &Path) {
    descriptor(h);
    put_plan(h, "{\"steps\":\"none\",\"keep\":1}");
}

fn plan_with_bad_steps(h: &Path) {
    descriptor(h);
    put_plan(h, "{\"steps\":[1,2]}");
}

fn plan_by_id(h: &Path) {
    put(
        h,
        ".anti-hall/devswarm/plans/loose-id.json",
        "{\"steps\":[{\"n\":1,\"text\":\"a\",\"status\":\"doing\",\"ts\":5,\"started_at\":5},{\"n\":2,\"text\":\"b\",\"status\":\"todo\"}],\"created_at\":1}",
    );
}

fn plan_with_many_extras(h: &Path) {
    descriptor(h);
    let extras: Vec<String> = (0..50).map(|i| format!("{{\"glob\":\"g{i}\",\"note\":\"n\",\"ts\":1}}")).collect();
    put_plan(h, &format!("{{\"steps\":[{{\"n\":1,\"text\":\"a\",\"status\":\"todo\"}}],\"extras\":[{}]}}", extras.join(",")));
}

fn steps_file(h: &Path) {
    put(h, "../cwd/steps.md", "Plan:\n1. first thing\n2. second thing\n3. third thing\n");
}

fn huge_log(h: &Path) {
    let p = h.join(".anti-hall/logs/devswarm-supervision.ndjson");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, vec![b'x'; 1024 * 1024 + 1]).unwrap();
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
    v.push(case("help-word-not-first", &["send", "help"], "Send")); // send answers its argument refusals natively since l8d
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
    // ---- wake-directive ----
    let child = |agent: &str| -> Vec<(&'static str, String)> {
        let mut e = vec![("DEVSWARM_SOURCE_BRANCH", "feature".to_string())];
        if !agent.is_empty() {
            e.push(("DEVSWARM_AI_AGENT", agent.to_string()));
        }
        e
    };
    let mut wd = |n: &str, a: &[&str], setup: fn(&Path), env: Vec<(&'static str, String)>, native: bool| {
        let mut c = case(n, a, "WakeDirective");
        c.setup = setup;
        c.env = env;
        c.native = native;
        v.push(c);
    };
    wd("wake-claude", &["wake-directive", "ws-1"], nothing, child("claude"), true);
    wd("wake-claude-json-flag-is-ignored", &["wake-directive", "ws-1", "--json"], nothing, child("claude"), true);
    wd("wake-codex", &["wake-directive", "ws-1"], nothing, child("codex"), true);
    wd("wake-agent-unset", &["wake-directive", "ws-1"], nothing, child(""), true);
    wd("wake-agent-uppercase-and-padded", &["wake-directive", "ws-1"], nothing, child(" Claude\t"), true);
    wd("wake-agent-non-ascii", &["wake-directive", "ws-1"], nothing, child("clàude"), false);
    wd("wake-cron-setting", &["wake-directive", "ws-1"], wake_cron_setting, child("claude"), true);
    wd("wake-cron-with-too-few-fields", &["wake-directive", "ws-1"], wake_cron_bad, child("claude"), true);
    wd("wake-cron-with-letters", &["wake-directive", "ws-1"], wake_cron_letters, child("claude"), true);
    wd("wake-rearm-inline", &["wake-directive", "ws-1"], rearm_inline, child("claude"), true);
    wd("wake-stable-launchers", &["wake-directive", "ws-1"], launchers_installed, child("claude"), true);
    wd("wake-stable-cli-launcher-only", &["wake-directive", "ws-1"], cli_launcher_only, child("claude"), true);
    wd("wake-stable-launcher-is-a-directory", &["wake-directive", "ws-1"], launcher_is_a_directory, child("claude"), true);
    wd(
        "wake-the-argv-id-wins-over-the-env-id",
        &["wake-directive", "ws-1"],
        nothing,
        {
            let mut e = child("claude");
            e.push(("DEVSWARM_BUILDER_ID", "other-id".into()));
            e
        },
        true,
    );
    wd("wake-primary-is-node", &["wake-directive", "ws-1"], nothing, vec![("DEVSWARM_AI_AGENT", "claude".into())], false);
    wd("wake-blank-source-branch-is-a-primary", &["wake-directive", "ws-1"], nothing, vec![("DEVSWARM_SOURCE_BRANCH", "  ".into())], false);
    wd("wake-no-id", &["wake-directive"], nothing, child("claude"), true);
    wd("wake-unsafe-id", &["wake-directive", "a/b"], nothing, child("claude"), true);
    // ---- logs ----
    let none = || -> Vec<(&'static str, String)> { vec![] };
    let mut lg = |n: &str, a: &[&str], setup: fn(&Path), env: Vec<(&'static str, String)>, native: bool| {
        let mut c = case(n, a, "Logs");
        c.setup = setup;
        c.env = env;
        c.native = native;
        v.push(c);
    };
    lg("logs-no-file", &["logs"], nothing, none(), true);
    lg("logs-all", &["logs"], central_log, none(), true);
    lg("logs-repo", &["logs", "--repo", "repo-1"], central_log, none(), true);
    lg("logs-component", &["logs", "--component", "a-comp"], central_log, none(), true);
    lg("logs-min-level-warn", &["logs", "--min-level", "warn"], central_log, none(), true);
    lg("logs-min-level-debug", &["logs", "--min-level=debug"], central_log, none(), true);
    lg("logs-min-level-unknown", &["logs", "--min-level", "loud"], central_log, none(), false);
    lg("logs-since-hour", &["logs", "--since", "1h"], central_log, none(), true);
    lg("logs-since-minutes", &["logs", "--since", "10m"], central_log, none(), true);
    lg("logs-since-fraction-days", &["logs", "--since", "0.01d"], central_log, none(), true);
    lg("logs-since-milliseconds", &["logs", "--since", "30000"], central_log, none(), true);
    lg("logs-since-uppercase-unit-with-space", &["logs", "--since", "2 H"], central_log, none(), true);
    lg("logs-since-garbage-is-no-filter", &["logs", "--since", "soon"], central_log, none(), true);
    lg("logs-since-seconds", &["logs", "--since", "20s"], central_log, none(), true);
    lg("logs-limit", &["logs", "--limit", "2"], central_log, none(), true);
    lg("logs-limit-zero", &["logs", "--limit", "0"], central_log, none(), true);
    lg("logs-limit-fraction", &["logs", "--limit", "2.9"], central_log, none(), true);
    lg("logs-limit-negative-is-ignored", &["logs", "--limit", "-4"], central_log, none(), true);
    lg("logs-limit-word-is-ignored", &["logs", "--limit", "many"], central_log, none(), true);
    lg("logs-combined", &["logs", "--repo", "repo-1", "--min-level", "info", "--since", "1h", "--limit", "2"], central_log, none(), true);
    lg("logs-rotated-file-is-read-when-the-window-reaches-back", &["logs", "--since", "3h"], central_log_and_rotated, none(), true);
    lg("logs-rotated-file-is-read-when-the-limit-needs-it", &["logs", "--limit", "5"], central_log_and_rotated, none(), true);
    lg("logs-rotated-file-is-left-alone-when-the-current-one-suffices", &["logs", "--limit", "1"], central_log_and_rotated, none(), true);
    lg("logs-a-line-that-is-not-an-object", &["logs"], central_log_odd_entry, none(), false);
    lg("logs-a-ts-that-is-not-iso-with-since", &["logs", "--since", "1h"], central_log_odd_ts, none(), false);
    lg("logs-a-ts-that-is-not-iso-without-since", &["logs"], central_log_odd_ts, none(), true);
    lg("logs-an-object-component", &["logs"], central_log_object_component, none(), false);
    lg("logs-an-object-component-filtered-out", &["logs", "--component", "other"], central_log_object_component, none(), true);
    lg("logs-a-lone-surrogate-escape", &["logs"], central_log_surrogate, none(), false);
    lg("logs-log-dir-override", &["logs"], custom_log_dir, vec![("ANTI_HALL_LOG_DIR", "{HOME}/elsewhere".into())], true);
    lg("logs-test-context-refuses-the-real-home", &["logs"], central_log, vec![("NODE_TEST_CONTEXT", "child".into())], false);
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
    // ---- plan / scope ----
    let two = "1. first step\n2. second step";
    let mut pl = |n: &str, a: &[&str], label: &'static str, setup: fn(&Path), native: bool, cwd: &'static str, env: Vec<(&'static str, String)>| {
        let mut c = case(n, a, label);
        c.setup = setup;
        c.native = native;
        c.cwd = cwd;
        c.env = env;
        v.push(c);
    };
    let none = || vec![];
    pl("plan-show-without-a-plan", &["plan", "show", "ws-1"], "Plan", descriptor, true, "cwd", none());
    pl("plan-show", &["plan", "show", "ws-1"], "Plan", plan_in_progress, true, "cwd", none());
    pl("plan-show-by-id-only", &["plan", "show", "loose-id"], "Plan", plan_by_id, true, "cwd", none());
    pl("plan-show-bad-steps-shape", &["plan", "show", "ws-1"], "Plan", plan_with_bad_steps, false, "cwd", none());
    pl("plan-show-descriptor-with-a-number-for-a-path", &["plan", "show", "ws-1"], "Plan", descriptor_odd_worktree, false, "cwd", none());
    pl(
        "plan-show-the-callers-own-id-names-the-checkout",
        &["plan", "show", "ws-9"],
        "Plan",
        nothing,
        true,
        "wt-child",
        vec![("DEVSWARM_BUILDER_ID", "ws-9".into())],
    );
    pl("plan-no-id", &["plan", "set"], "Plan", nothing, true, "cwd", none());
    pl("plan-unsafe-id", &["plan", "show", "../x"], "Plan", nothing, true, "cwd", none());
    pl("plan-no-sub", &["plan"], "Plan", nothing, true, "cwd", none());
    pl("plan-bogus-sub", &["plan", "bogus", "ws-1"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-creates", &["plan", "set", "ws-1", "--steps", two], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-creates-without-a-descriptor", &["plan", "set", "ws-1", "--steps", two], "Plan", nothing, true, "cwd", none());
    pl(
        "plan-set-callers-own-checkout",
        &["plan", "set", "ws-9", "--steps", two],
        "Plan",
        nothing,
        true,
        "wt-child",
        vec![("DEVSWARM_BUILDER_ID", "ws-9".into())],
    );
    pl(
        "plan-set-with-scope",
        &["plan", "set", "ws-1", "--steps", two, "--scope", "src/**, `lib/*.js`,docs/**  src/**"],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-with-a-bare-scope", &["plan", "set", "ws-1", "--steps", two, "--scope"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-with-repeated-scope", &["plan", "set", "ws-1", "--steps", two, "--scope", "a", "--scope", "b,c"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-identical-is-a-no-op", &["plan", "set", "ws-1", "--steps", "1. alpha\n2. beta\n3. gamma"], "Plan", plan_in_progress, true, "cwd", none());
    pl(
        "plan-set-identical-new-scope",
        &["plan", "set", "ws-1", "--steps", "1. alpha\n2. beta\n3. gamma", "--scope", "x/**"],
        "Plan",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl(
        "plan-set-changed-keeps-unchanged-steps-and-notes-the-drop",
        &["plan", "set", "ws-1", "--steps", "1. alpha\n2. different\n3. gamma\n4. delta"],
        "Plan",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl(
        "plan-set-replaced-first-step-drops-the-done-count",
        &["plan", "set", "ws-1", "--steps", "1. other\n2. beta"],
        "Plan",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-over-a-plan-with-a-string-extras", &["plan", "set", "ws-1", "--steps", two], "Plan", plan_with_string_extras, true, "cwd", none());
    pl(
        "plan-set-over-a-plan-without-a-steps-array-starts-over",
        &["plan", "set", "ws-1", "--steps", two],
        "Plan",
        plan_without_steps_array,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-over-a-plan-with-bad-steps", &["plan", "set", "ws-1", "--steps", two], "Plan", plan_with_bad_steps, false, "cwd", none());
    pl("plan-set-by-id-plan-file", &["plan", "set", "loose-id", "--steps", "1. a\n2. b\n3. c"], "Plan", plan_by_id, true, "cwd", none());
    pl("plan-set-descriptor-with-a-number-for-a-path", &["plan", "set", "ws-1", "--steps", two], "Plan", descriptor_odd_worktree, false, "cwd", none());
    pl("plan-set-supervision-log-due-for-rotation", &["plan", "set", "ws-1", "--steps", two], "Plan", huge_log, false, "cwd", none());
    pl("plan-set-no-steps", &["plan", "set", "ws-1"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-bare-steps", &["plan", "set", "ws-1", "--steps"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-one-step-is-no-plan", &["plan", "set", "ws-1", "--steps", "1. only"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-prose-is-no-plan", &["plan", "set", "ws-1", "--steps", "do this then that"], "Plan", descriptor, true, "cwd", none());
    pl(
        "plan-set-forms",
        &["plan", "set", "ws-1", "--steps", "intro\n  - 1) a\n* 2: b\nSTEP 3. c\n  step   4:\td\n5.e\n5. e2\n- Step 6 - f"],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-crlf", &["plan", "set", "ws-1", "--steps", "1. a\r\n2. b\r\n3. c\r"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-lone-cr-in-a-line", &["plan", "set", "ws-1", "--steps", "1. a\n2. b\rmore\n3. c\n4. d"], "Plan", descriptor, true, "cwd", none());
    pl(
        "plan-set-second-list-restarting-ends-the-first",
        &["plan", "set", "ws-1", "--steps", "1. a\n2. b\n1. c\n2. d\n3. e"],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl(
        "plan-set-restart-before-two-items-replaces-the-first",
        &["plan", "set", "ws-1", "--steps", "1. a\n1. b\n2. c"],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-gap-in-the-numbers", &["plan", "set", "ws-1", "--steps", "1. a\n2. b\n4. d\n3. c"], "Plan", descriptor, true, "cwd", none());
    pl("plan-set-four-digit-number", &["plan", "set", "ws-1", "--steps", "1. a\n2. b\n1000. c"], "Plan", descriptor, true, "cwd", none());
    pl(
        "plan-set-unicode-spaces-and-text",
        &["plan", "set", "ws-1", "--steps", "\u{a0}1.\u{3000}ünï \u{1F600} cödé  \n2.\u{2003}second\u{feff}"],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-line-separator-inside-a-line", &["plan", "set", "ws-1", "--steps", "1. a\u{2028}b\n2. c\n3. d"], "Plan", descriptor, true, "cwd", none());
    pl(
        "plan-set-fifty-one-steps",
        &["plan", "set", "ws-1", "--steps", &(1..=60).map(|i| format!("{i}. step {i}")).collect::<Vec<_>>().join("\n")],
        "Plan",
        descriptor,
        true,
        "cwd",
        none(),
    );
    pl("plan-set-a-long-step-is-cut", &["plan", "set", "ws-1", "--steps", &format!("1. {}\n2. b", "x".repeat(260))], "Plan", descriptor, true, "cwd", none());
    pl(
        "plan-set-a-cut-through-a-surrogate-pair",
        &["plan", "set", "ws-1", "--steps", &format!("1. {}\u{1F600}tail\n2. b", "x".repeat(199))],
        "Plan",
        descriptor,
        false,
        "cwd",
        none(),
    );
    pl("plan-set-steps-file", &["plan", "set", "ws-1", "--steps-file", "steps.md"], "Plan", steps_file, true, "cwd", none());
    pl("plan-set-steps-wins-over-steps-file", &["plan", "set", "ws-1", "--steps", two, "--steps-file", "steps.md"], "Plan", steps_file, true, "cwd", none());
    pl("plan-set-missing-steps-file", &["plan", "set", "ws-1", "--steps-file", "nope.md"], "Plan", descriptor, false, "cwd", none());
    pl("scope-add", &["scope", "add", "ws-1", "--glob", "src/**", "--note", "the user asked for it"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-add-creates-a-plan", &["scope", "add", "ws-1", "--glob", "src/**", "--note", "n"], "Scope", descriptor, true, "cwd", none());
    pl("scope-add-without-descriptor-or-plan", &["scope", "add", "ws-1", "--glob", "a", "--note", "n"], "Scope", nothing, true, "cwd", none());
    pl(
        "scope-add-same-glob-same-note-is-a-no-op",
        &["scope", "add", "ws-1", "--glob", "docs/**", "--note", "asked"],
        "Scope",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl(
        "scope-add-same-glob-new-note",
        &["scope", "add", "ws-1", "--glob", "docs/**", "--note", "changed my mind"],
        "Scope",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl(
        "scope-add-several-globs",
        &["scope", "add", "ws-1", "--glob", "a/**", "--glob", "b/**,c/**", "--glob", "a/**", "--note", "n"],
        "Scope",
        plan_in_progress,
        true,
        "cwd",
        none(),
    );
    pl("scope-add-long-note-is-cut", &["scope", "add", "ws-1", "--glob", "a", "--note", &"y".repeat(400)], "Scope", plan_in_progress, true, "cwd", none());
    pl(
        "scope-add-note-cut-through-a-surrogate-pair",
        &["scope", "add", "ws-1", "--glob", "a", "--note", &format!("{}\u{1F600}z", "y".repeat(299))],
        "Scope",
        plan_in_progress,
        false,
        "cwd",
        none(),
    );
    pl("scope-add-extras-full", &["scope", "add", "ws-1", "--glob", "new", "--note", "n"], "Scope", plan_with_many_extras, true, "cwd", none());
    pl("scope-add-extras-is-not-an-array", &["scope", "add", "ws-1", "--glob", "new", "--note", "n"], "Scope", plan_with_string_extras, true, "cwd", none());
    pl("scope-add-extras-holds-a-null", &["scope", "add", "ws-1", "--glob", "new", "--note", "n"], "Scope", plan_with_odd_extras, false, "cwd", none());
    pl("scope-add-no-glob", &["scope", "add", "ws-1", "--note", "n"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-add-blank-globs", &["scope", "add", "ws-1", "--glob", " , ", "--note", "n"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-add-no-note", &["scope", "add", "ws-1", "--glob", "a"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-add-blank-note", &["scope", "add", "ws-1", "--glob", "a", "--note", "  \n"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-bogus-sub", &["scope", "remove", "ws-1", "--glob", "a", "--note", "n"], "Scope", plan_in_progress, true, "cwd", none());
    pl("scope-no-id", &["scope", "add"], "Scope", nothing, true, "cwd", none());
    pl("scope-unsafe-id", &["scope", "add", "a/b", "--glob", "a", "--note", "n"], "Scope", nothing, true, "cwd", none());
    pl("scope-supervision-log-due-for-rotation", &["scope", "add", "ws-1", "--glob", "a", "--note", "n"], "Scope", huge_log, false, "cwd", none());
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

fn refs<'a>(e: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
    e.iter().map(|(k, v)| (*k, v.as_str())).collect()
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
    // a checkout with a linked worktree: the plan cases register the worktree (`wt-child`) as a workspace
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&["init", "-q"], &repo);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &repo);
    git(&["worktree", "add", "-q", "-b", "child", root.join("wt-child").to_str().unwrap()], &repo);
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
        // a developer's shortcut: run only the cases whose name contains this text
        if std::env::var("AH_CLI_PARITY_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
            continue;
        }
        let now = NOW + i as i64 * 7_919;
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| root.join(format!("h{i}-{k}"))).collect();
        for h in &homes {
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            (c.setup)(h);
        }
        // `{HOME}` in a value is each side's own home
        let env_of = |h: &Path| -> Vec<(&str, String)> { c.env.iter().map(|(k, v)| (*k, v.replace("{HOME}", &h.to_string_lossy()))).collect() };
        let (env_n, env_e, env_d) = (env_of(&homes[0]), env_of(&homes[1]), env_of(&homes[2]));
        let cwd = root.join(c.cwd);
        let n = node_cli(&homes[0], &cwd, &c.argv, now, &with_path(refs(&env_n), tools.as_str()));
        let e = engine_cli(&homes[1], &cwd, &c.argv, now, &with_path(refs(&env_e), tools.as_str()));
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
            // a logged refusal (send's, since l8d) carries the run's own time and pid: those two fields are masked
            let unstamp = |v: Option<&String>| {
                v.map(|t| {
                    let t = regex::Regex::new(r#""ts":"[^"]*""#).unwrap().replace_all(t, r##""ts":"#""##).into_owned();
                    regex::Regex::new(r#""pid":\d+"#).unwrap().replace_all(&t, r##""pid":#"##).into_owned()
                })
            };
            for k in te.keys().chain(tn.keys()) {
                assert!(
                    unstamp(te.get(k)) == unstamp(tn.get(k)),
                    "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}",
                    c.name,
                    te.get(k),
                    tn.get(k)
                );
            }
            for w in &c.writes {
                assert!(homes[1].join(w).is_file(), "{}: expected the verb to have written {w}", c.name);
            }
            // send's native refusals (l8d) have no store-free witness; devswarm_l8d_parity::send_refusals_match_node covers them
            if c.label != "Send" {
                pending.push((c.name.clone(), homes[1].join("state")));
            }
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            // Node's own run (the fallback) uses the real clock: the digits of a timestamp are masked
            let mask = |t: &str, h: &Path| {
                t.replace(h.to_string_lossy().as_ref(), "<HOME>").chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect::<String>()
            };
            assert_eq!(mask(&e.stdout, &homes[1]), mask(&n.stdout, &homes[0]), "{}: the fallback prints what Node prints", c.name);
            let pre = tree(&homes[2]);
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &with_path(refs(&env_d), nonode.as_str()));
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
    if std::env::var("AH_CLI_PARITY_FILTER").is_err() {
        assert!(native >= 200 && deferred >= 20, "{native} native, {deferred} deferred");
    }
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

// ---- the verbs that read or write the project's store (gate, workspaces list) -------------------------------------------

struct StoreCase {
    name: &'static str,
    argv: Vec<&'static str>,
    /// `child` (the registered child worktree), `main` (the Primary checkout), `other` (another project), `nongit`.
    cwd: &'static str,
    setup: fn(&Path),
    native: bool,
    label: &'static str,
}

fn sc(name: &'static str, argv: &[&'static str], cwd: &'static str, native: bool, label: &'static str) -> StoreCase {
    StoreCase { name, argv: argv.to_vec(), cwd, setup: nothing, native, label }
}

/// A descriptor of `child-1` naming its worktree (the seed registers the row but writes no descriptor file).
fn child_descriptor(h: &Path) {
    let wt = h.parent().unwrap().join("wt-child");
    put(
        h,
        ".anti-hall/devswarm/workspaces/child-1.json",
        &format!("{{\"id\":\"child-1\",\"worktreePath\":{}}}", serde_json::to_string(&wt.to_string_lossy()).unwrap()),
    );
}

/// A descriptor stranded in the legacy hash bucket of its id.
fn stranded_descriptor(h: &Path) {
    let o = Command::new("node")
        .args(["-e", "console.log(require(process.argv[1]).hashFromWorkspaceId('stray-1'))"])
        .arg(plugin_root().join("companion/lib/devswarm-store.js"))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    let hash = String::from_utf8_lossy(&o.stdout).trim().to_string();
    put(h, ".anti-hall/devswarm/workspaces/stray-1.json", &format!("{{\"id\":\"stray-1\",\"worktreePath\":\"/nowhere/stray\",\"ownerKey\":\"{hash}\"}}"));
}

fn odd_descriptor_id(h: &Path) {
    put(h, ".anti-hall/devswarm/workspaces/odd-1.json", "{\"id\":5,\"worktreePath\":\"/nowhere/odd\"}");
}

fn foreign_registration(h: &Path) {
    put(h, ".anti-hall/devswarm/workspaces/child-1.json", "{\"id\":\"child-1\",\"worktreePath\":\"/nowhere/foreign\",\"repoKey\":\"repo-someone-else\"}");
}

fn store_cases() -> Vec<StoreCase> {
    let mut v = vec![
        sc("gate-set", &["gate", "child-1", "--set", "tests_passed"], "child", true, "Gate"),
        sc("gate-set-several-and-clear", &["gate", "child-1", "--set", "tests_passed,merged_verified", "--clear", "done"], "child", true, "Gate"),
        sc("gate-set-repeated-and-duplicated", &["gate", "child-1", "--set", "a", "--set", "b,a, c ", "--clear", "d"], "child", true, "Gate"),
        sc("gate-clear-with-a-setter", &["gate", "child-1", "--clear", "tests_passed", "--by", "someone"], "child", true, "Gate"),
        sc("gate-all-required-gates-make-archive-ready", &["gate", "child-1", "--set", "merged,tests_passed,done"], "child", false, "Gate"),
        sc("gate-from-the-primary-checkout", &["gate", "child-1", "--set", "tests_passed"], "main", true, "Gate"),
        sc("gate-an-untracked-id", &["gate", "nobody", "--set", "tests_passed"], "child", true, "Gate"),
        sc("gate-no-flags", &["gate", "child-1"], "child", true, "Gate"),
        sc("gate-blank-flags", &["gate", "child-1", "--set", " , "], "child", true, "Gate"),
        sc("gate-bare-flags", &["gate", "child-1", "--set"], "child", true, "Gate"),
        sc("gate-unsafe-id", &["gate", "../x", "--set", "a"], "child", true, "Gate"),
        sc("gate-no-id", &["gate", "--set", "a"], "child", true, "Gate"),
        sc("gate-merged-is-node", &["gate", "child-1", "--set", "merged"], "child", false, "Gate"),
        sc("gate-outside-any-project", &["gate", "nobody", "--set", "a"], "nongit", false, "Gate"),
        StoreCase { setup: child_descriptor, ..sc("gate-registered-here-from-another-project", &["gate", "child-1", "--set", "a"], "other", true, "Gate") },
        StoreCase { setup: child_descriptor, ..sc("gate-registered-here-from-no-project", &["gate", "child-1", "--set", "a"], "nongit", true, "Gate") },
        StoreCase { setup: child_descriptor, ..sc("gate-registered-here-from-here", &["gate", "child-1", "--set", "a"], "child", true, "Gate") },
        StoreCase {
            setup: foreign_registration,
            ..sc("gate-registered-under-a-persisted-foreign-key", &["gate", "child-1", "--set", "a"], "child", true, "Gate")
        },
        sc("workspaces-list", &["workspaces", "list"], "child", true, "Workspaces"),
        sc("workspaces-default-sub", &["workspaces"], "child", true, "Workspaces"),
        sc("workspaces-from-the-primary-checkout", &["workspaces", "list"], "main", true, "Workspaces"),
        sc("workspaces-explicit-workspace", &["workspaces", "list", "--workspace", "child-1"], "child", true, "Workspaces"),
        sc("workspaces-empty-workspace", &["workspaces", "list", "--workspace="], "child", true, "Workspaces"),
        sc("workspaces-bogus-sub", &["workspaces", "bogus"], "child", true, "Workspaces"),
        sc("workspaces-outside-any-project", &["workspaces", "list"], "nongit", false, "Workspaces"),
        StoreCase { setup: stranded_descriptor, ..sc("workspaces-a-stranded-descriptor-is-nodes", &["workspaces", "list"], "child", false, "Workspaces") },
        StoreCase {
            setup: odd_descriptor_id,
            ..sc("workspaces-a-descriptor-with-a-numeric-id-is-nodes", &["workspaces", "list"], "child", false, "Workspaces")
        },
        StoreCase { setup: child_descriptor, ..sc("workspaces-with-a-descriptor", &["workspaces", "list"], "child", true, "Workspaces") },
    ];
    v.push(sc("workspaces-bare-worktree-flag", &["workspaces", "list", "--worktree"], "child", true, "Workspaces"));
    v
}

#[test]
fn gate_and_workspaces_list_match_node_on_a_seeded_store() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("clistore");
    let other = fx.root.join("repo-other");
    fs::create_dir_all(&other).unwrap();
    git(&["init", "-q"], &other);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &other);
    let other = real(&other);
    let nongit = fx.root.join("not-a-repo");
    fs::create_dir_all(&nongit).unwrap();
    let nongit = real(&nongit);
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    let key_dir = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let (mut native, mut deferred) = (0, 0);
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for (i, c) in store_cases().iter().enumerate() {
        let now = NOW + i as i64 * 7_919;
        let cwd = match c.cwd {
            "child" => fx.child.clone(),
            "main" => fx.main.clone(),
            "other" => other.clone(),
            _ => nongit.clone(),
        };
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("s{i}-{k}"))).collect();
        for h in &homes {
            copy_tree(&fx.seed_home, h);
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            (c.setup)(h);
        }
        let argv: Vec<String> = c.argv.iter().map(|s| (*s).to_string()).collect();
        let n = node_cli(&homes[0], &cwd, &argv, now, &[("PATH", tools.as_str())]);
        let e = engine_cli(&homes[1], &cwd, &argv, now, &[("PATH", tools.as_str())]);
        let log = last_log(&homes[1].join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!(log["verb"], c.label, "{}: telemetry names the verb", c.name);
            let (es, ns) = (e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>"), n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>"));
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {es:?}\n node:   {ns:?}", c.name);
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            let (de, dn) = (raw_dump(&key_dir(&homes[1])), raw_dump(&key_dir(&homes[0])));
            assert!(de == dn, "{}: the store differs: {}", c.name, first_diff(&dn, &de));
            pending.push((c.name.to_string(), homes[1].join("state")));
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let pre = (tree(&homes[2]), raw_dump(&key_dir(&homes[2])));
            let d = engine_cli(&homes[2], &cwd, &argv, now, &[("PATH", nonode.as_str())]);
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            assert!(pre == (tree(&homes[2]), raw_dump(&key_dir(&homes[2]))), "{}: a deferral wrote", c.name);
        }
    }
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
    eprintln!(
        "store cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written",
        store_cases().len()
    );
    assert!(native >= 15 && deferred >= 4, "{native} native, {deferred} deferred");
}
