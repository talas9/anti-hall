//! Node-vs-engine parity of `jev-report` (the port of `scripts/jev-report.js`): every output mode and flag on seeded, empty and
//! corrupt scratch homes, text and `--json`, compared on stdout, stderr, the exit code and the home tree. The real Node script and
//! the engine command each get their own copy of the seeded home (`HOME` pointed at it, an otherwise empty environment); clock
//! values (ISO times, latencies the run measures) are masked because the two runs cannot share a clock. The credit balance runs
//! against a loopback server (the Jev test endpoint), never the real gateway.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use regex::Regex;
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

type R<T = ()> = Result<T, Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
static COUNTER: AtomicUsize = AtomicUsize::new(0);
const MIN: i64 = 60_000;

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> R<Scratch> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ah-jevrep-parity-{}-{n}-{tag}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir.canonicalize()?))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            eprintln!("could not remove {}: {e}", self.0.display());
        }
    }
}

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn run(mut cmd: Command, home: &Path, extra: &[(&str, &str)]) -> R<Out> {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("TMPDIR", home.join("tmp"))
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let out = cmd.spawn()?.wait_with_output()?;
    Ok(Out {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}

fn mask(s: &str, home: &Path) -> String {
    let mut s = s.replace(&home.to_string_lossy().into_owned(), "HOME");
    for (re, with) in [
        (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", "TS"),
        (r#""ms": \d+"#, r#""ms": N"#),
        (r#""ms":\d+"#, r#""ms":N"#),
        (r#""fetchedAt":\d+"#, r#""fetchedAt":N"#),
    ] {
        s = Regex::new(re).unwrap().replace_all(&s, with).into_owned();
    }
    s
}

fn snapshot(root: &Path) -> R<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> R {
        for e in fs::read_dir(dir)? {
            let p = e?.path();
            let rel = p.strip_prefix(root)?.to_string_lossy().into_owned();
            if rel == "tmp" || rel.starts_with(".anti-hall/ah-engine") || rel.ends_with(".lock") {
                continue;
            }
            let meta = fs::symlink_metadata(&p)?;
            let mode = meta.permissions().mode() & 0o777;
            if meta.is_dir() {
                out.insert(format!("{rel}/"), format!("{mode:o}"));
                walk(root, &p, out)?;
            } else {
                out.insert(rel, format!("{mode:o}\n{}", mask(&String::from_utf8_lossy(&fs::read(&p)?), root)));
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn copy_dir(from: &Path, to: &Path) -> R {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

fn write(root: &Path, rel: &str, content: &str) -> R {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().ok_or("no parent")?)?;
    fs::write(p, content)?;
    Ok(())
}

fn assert_text(name: &str, what: &str, node: &str, engine: &str) {
    if node == engine {
        return;
    }
    let at = node.chars().zip(engine.chars()).position(|(a, b)| a != b).unwrap_or_else(|| node.chars().count().min(engine.chars().count()));
    let around = |s: &str| s.chars().skip(at.saturating_sub(60)).take(200).collect::<String>();
    panic!("{name}: {what} differs at char {at}\n  node:   {:?}\n  engine: {:?}", around(node), around(engine));
}

/// Run Node's `scripts/jev-report.js` and the engine's `jev-report` on copies of `seed` and compare everything.
fn same(seed: Option<&Path>, env: &[(&str, &str)], args: &[&str]) -> R<Out> {
    let name = format!("jev-report {}", args.join(" "));
    let (nh, eh) = (Scratch::new("n")?, Scratch::new("e")?);
    for h in [nh.path(), eh.path()] {
        fs::create_dir_all(h.join("tmp"))?;
        if let Some(s) = seed {
            copy_dir(s, h)?;
        }
    }
    let mut n = Command::new("node");
    n.arg(plugin_src().join("scripts/jev-report.js")).args(args);
    let mut e = Command::new(BIN);
    e.arg("jev-report").args(args);
    let (no, eo) = (run(n, nh.path(), env)?, run(e, eh.path(), env)?);
    let m = |o: &Out, h: &Path| Out { stdout: mask(&o.stdout, h), stderr: mask(&o.stderr, h), code: o.code };
    let (nm, em) = (m(&no, nh.path()), m(&eo, eh.path()));
    assert_text(&name, "stdout", &nm.stdout, &em.stdout);
    assert_text(&name, "stderr", &nm.stderr, &em.stderr);
    assert_eq!(nm.code, em.code, "{name}: exit code");
    assert_eq!(snapshot(nh.path())?, snapshot(eh.path())?, "{name}: home tree");
    assert_ne!(em.code, 75, "{name}: the engine deferred to Node instead of answering");
    Ok(Out { stdout: em.stdout, stderr: em.stderr, code: em.code })
}

// ---- seeds -------------------------------------------------------------------------------------------------------------------

fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Minutes ago, moved off the 24 h / 7 d window edges so the two runs (a few seconds apart) agree on every row.
fn ago(i: i64, span: i64) -> i64 {
    let mut m = (i * 53 + 7) % span;
    for edge in [1440, 10_080, 4320] {
        if (m - edge).abs() < 90 {
            m += 200;
        }
    }
    m
}

fn pick<'a>(g: &mut Gen, xs: &[&'a str]) -> &'a str {
    xs[g.next(xs.len() as u64) as usize]
}

fn pickv(g: &mut Gen, xs: &[&str]) -> serde_json::Value {
    let v = pick(g, xs);
    if v.is_empty() { serde_json::Value::Null } else { v.into() }
}

struct Gen(u64);
impl Gen {
    fn next(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % n
    }
}

fn decision_rows(now: i64) -> Vec<String> {
    let mut g = Gen(7);
    let mut rows = Vec::new();
    let projects = ["alpha", "beta", ""];
    let sessions = ["s1", "s2", ""];
    let mut push = |v: serde_json::Value| rows.push(v.to_string());
    // a boolean integration with comparison, trust-rule moves and outcomes
    for i in 0..260_i64 {
        let h = format!("sp{}", i % 90);
        let cached = i % 90 != i && i >= 90;
        let jev = g.next(3) != 0;
        let changed = if cached || g.next(5) != 0 { serde_json::Value::Null } else { pick(&mut g, &["added", "relaxed", "changed"]).into() };
        let mut r = serde_json::json!({"ts": iso(now - ago(i, 14_000) * MIN), "id": "speculation", "h": h, "base": false, "jev": jev,
            "conf": 0.9, "ms": 50 + g.next(1500), "backend": if cached { "cache" } else if g.next(9) == 0 { "baseline-only" } else { "jev" },
            "mode": "on", "changed": changed, "compare": g.next(2) == 0, "project": projects[g.next(3) as usize], "sessionId": sessions[g.next(3) as usize]});
        if g.next(6) == 0 {
            r["reason"] = pick(&mut g, &["timeout", "http-500", "network-error", "off"]).into();
        }
        if g.next(4) == 0 {
            r["costUsd"] = serde_json::json!(0.0001 * (1 + g.next(40)) as f64);
        }
        if g.next(3) == 0 {
            r["transport"] = pick(&mut g, &["vercel", "typesafe"]).into();
        }
        if g.next(10) == 0 {
            r["fellBack"] = true.into();
        }
        push(r);
    }
    for i in 0..60_i64 {
        push(serde_json::json!({"ts": iso(now - ago(i * 3, 14_000) * MIN), "type": "outcome", "id": "speculation", "h": format!("sp{}", i % 90),
            "outcome": pick(&mut g, &["evidence-added", "repeat-speculation", "user-override", "answered"]), "source": pick(&mut g, &["jev", "regex"])}));
    }
    // shadow-mode rows: wouldChange instead of changed
    for i in 0..120_i64 {
        push(
            serde_json::json!({"ts": iso(now - ago(i * 5, 9000) * MIN), "id": "modelRouting", "h": format!("mr{i}"), "jev": g.next(2) == 0, "compare": g.next(2) == 0,
            "ms": 80 + g.next(300), "backend": "jev", "mode": "shadow", "changed": null, "wouldChange": pickv(&mut g, &["", "added", "relaxed"]),
            "project": projects[g.next(3) as usize]}),
        );
        if i % 4 == 0 {
            push(
                serde_json::json!({"ts": iso(now - ago(i * 5, 9000) * MIN), "type": "outcome", "id": "modelRouting", "h": format!("mr{i}"), "outcome": "evidence-added", "source": "jev"}),
            );
        }
    }
    // a label-only (choice) integration
    for i in 0..70_i64 {
        push(
            serde_json::json!({"ts": iso(now - ago(i * 7, 12_000) * MIN), "id": "newRequest", "h": format!("nr{}", i % 50), "jev": pick(&mut g, &["new-request", "follow-up", "correction", "question"]),
            "ms": 100 + g.next(700), "backend": if i % 50 != i { "cache" } else { "jev" }, "mode": if i % 3 == 0 { "on" } else { "shadow" },
            "changed": serde_json::Value::Null, "wouldChange": if g.next(3) == 0 { "changed".into() } else { serde_json::Value::Null }}),
        );
    }
    // failures and a tiny integration
    for i in 0..220_i64 {
        push(serde_json::json!({"ts": iso(now - ago(i, 6000) * MIN), "id": "claimLedger", "h": format!("cl{i}"), "jev": true, "ms": 400 + g.next(900),
            "backend": if i % 3 == 0 { "baseline-only" } else { "jev" }, "reason": if i % 3 == 0 { "http-503".into() } else { serde_json::Value::Null }, "mode": "on", "changed": serde_json::Value::Null}));
    }
    for i in 0..5_i64 {
        push(
            serde_json::json!({"ts": iso(now - ago(i, 800) * MIN), "id": "dispatchTier", "h": format!("dt{i}"), "jev": true, "ms": 30, "backend": "jev", "mode": "on", "changed": "added", "costUsd": 0.002}),
        );
    }
    rows
}

fn triage_rows(now: i64) -> Vec<String> {
    let mut g = Gen(11);
    let mut rows = Vec::new();
    for i in 0..40_i64 {
        rows.push(serde_json::json!({"ts": iso(now - ago(i, 5000) * MIN), "hash": format!("tr{i}"), "backend": pick(&mut g, &["jev", "cache", "jev+haiku", "baseline"]), "ms": 20 + g.next(500),
            "kind": pick(&mut g, &["question", "task", ""]), "transport": pick(&mut g, &["vercel", "typesafe", "x"])}).to_string());
    }
    for i in 0..25_i64 {
        rows.push(serde_json::json!({"ts": iso(now - ago(i, 5000) * MIN), "type": "answered", "urgency": pick(&mut g, &["urgent", "normal", "low"]), "latencyMs": 1000 + g.next(90_000)}).to_string());
    }
    rows
}

/// The seeded home: three generations of the decision log, triage, judge and supervision events, labels, rollups, jev.json and settings.
fn full_seed(root: &Path, settings: &str) -> R {
    let now = now_ms();
    let rows = decision_rows(now);
    let (a, rest) = rows.split_at(rows.len() / 3);
    let (b, c) = rest.split_at(rest.len() / 2);
    write(root, ".anti-hall/logs/jev-assist.ndjson.2", &(a.join("\n") + "\n"))?;
    write(root, ".anti-hall/logs/jev-assist.ndjson.1", &(b.join("\n") + "\nnot json\n\n{\"ts\":\n"))?;
    write(root, ".anti-hall/logs/jev-assist.ndjson", &(c.join("\n") + "\nnull\n[]\n"))?;
    write(root, ".anti-hall/logs/jev-triage.ndjson", &(triage_rows(now).join("\n") + "\n"))?;
    write(
        root,
        ".anti-hall/logs/jev-judge.ndjson",
        &format!(
            "{}\n{}\n{}\n",
            serde_json::json!({"ts": iso(now - 300 * MIN), "event": "trigger", "id": "speculationFramed", "outcome": "seen"}),
            serde_json::json!({"ts": iso(now - 400 * MIN), "event": "trigger", "id": "speculationFramed", "outcome": "skipped", "reason": "cap"}),
            serde_json::json!({"ts": iso(now - 900 * MIN), "event": "other", "id": "x"})
        ),
    )?;
    write(
        root,
        ".anti-hall/logs/devswarm-supervision.ndjson",
        &format!(
            "{}\n{}\n",
            serde_json::json!({"ts": iso(now - 100 * MIN), "type": "jev-trigger", "integration": "devswarmOnBrief", "outcome": "skipped", "reason": "off"}),
            serde_json::json!({"ts": iso(now - 120 * MIN), "type": "jev-trigger", "integration": "devswarmOnBrief", "outcome": "skipped", "reason": "off"})
        ),
    )?;
    write(
        root,
        ".anti-hall/logs/jev-labels.ndjson",
        &format!(
            "{}\n{}\n{}\nbroken\n",
            serde_json::json!({"ts": iso(now), "h": "sp1", "label": "tp", "source": "human"}),
            serde_json::json!({"ts": iso(now), "h": "sp2", "label": "fp", "source": "human"}),
            serde_json::json!({"ts": iso(now), "h": "sp1", "label": "fp", "source": "human"})
        ),
    )?;
    write(
        root,
        ".anti-hall/logs/jev-audit.ndjson",
        &format!(
            "{}\n{}\n",
            serde_json::json!({"ts": iso(now - 20 * 1440 * MIN), "h": "sp1", "snippet": "old"}),
            serde_json::json!({"ts": iso(now - 2 * 1440 * MIN), "h": "sp2", "snippet": "recent"})
        ),
    )?;
    write(
        root,
        ".anti-hall/logs/jev-audit.ndjson.1",
        &format!("{}\n", serde_json::json!({"ts": iso(now - 3 * 1440 * MIN), "h": "sp1", "snippet": "from the backup"})),
    )?;
    for d in 0..6_i64 {
        let day = &iso(now - (30 + d) * 1440 * MIN)[..10];
        write(
            root,
            &format!(".anti-hall/logs/jev-daily/{day}.json"),
            &serde_json::json!({"day": day, "groups": [{"id": "speculation", "n": 40 + d, "fresh": 30, "changed": 3, "timeouts": 1, "failures": 2, "costUsd": 0.01 * d as f64, "p50Ms": 100 + d, "p95Ms": 900 - d},
                {"id": "modelRouting", "n": 10, "fresh": 10, "changed": 0, "p50Ms": 50}]}).to_string(),
        )?;
    }
    write(root, ".anti-hall/logs/jev-daily/2026-01-01.json", "{broken")?;
    write(root, ".anti-hall/logs/jev-daily/notes.txt", "x")?;
    write(root, ".anti-hall/jev.json", r#"{"costPerCall":0.002,"enabled":false,"integrations":{"speculation":"on","modelRouting":"shadow"}}"#)?;
    write(root, ".anti-hall/settings.json", settings)?;
    Ok(())
}

const BUDGET_SETTINGS: &str = r#"{"jev":{"budget":{"mode":"watch","usdPerDay":0.001,"usdPerWeek":5,"minCreditUsd":100}}}"#;

const REPORT_CASES: &[&str] = &[
    "",
    "--json",
    "--days 3",
    "--days 3 --json",
    "--days abc",
    "--days",
    "--window 24h",
    "--window 7d --json",
    "--window 3",
    "--window 2d --json",
    "--window",
    "--by project",
    "--by session",
    "--by project --json",
    "--by session --json --days 5",
    "--by nothing",
    "--project alpha",
    "--project unknown --json",
    "--project nosuch",
    "--project alpha --by session",
    "--weekly",
    "--weekly --json",
    "--weekly --project beta",
    "--weekly --by project",
    "--since 2020-01-01T00:00:00Z",
    "--since nonsense",
    "--exclude-project alpha",
    "--exclude-project alpha --exclude-project beta --json",
    "--exclude-project",
    "--exclude-window 2020-01-01T00:00:00Z..2030-01-01T00:00:00Z",
    "--exclude-window 2030-01-01T00:00:00Z..2020-01-01T00:00:00Z --json",
    "--exclude-window broken",
    "--exclude-window a..b",
    "--home /nonexistent-jev-home",
    "--bogus flag",
    "label sp1",
    "label sp1 tp",
    "label sp1 fp",
    "label nothere",
    "label",
    "label sp1 maybe",
    "prune-audit --days 5",
    "prune-audit --days 1",
    "prune-audit --days 100",
    "prune-audit --days 0",
    "prune-audit",
    "prune-audit --days abc",
];

#[test]
fn every_flag_matches_node_on_a_full_home() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), "{}")?;
    for a in REPORT_CASES {
        same(Some(seed.path()), &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
    }
    Ok(())
}

#[test]
fn the_full_report_shows_every_section_and_verdict() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), BUDGET_SETTINGS)?;
    let text = same(Some(seed.path()), &[], &[])?.stdout;
    for needle in [
        "jev report - generated",
        "integration",
        "headlines:",
        "by transport (calls that reached a vendor):",
        "triggers (occurrences of a rare trigger, not calls):",
        "Older history from daily rollups",
        "real cost (gateway/price-table-reported",
        "budget (watch mode",
        "label-only integrations",
        "triage answer-time",
        "REVIEW (needs labels:",
        "REVIEW (not enough data:",
    ] {
        assert!(text.replace('\u{2014}', "-").contains(needle), "the report lacks {needle:?}:\n{text}");
    }
    let json: serde_json::Value = serde_json::from_str(&same(Some(seed.path()), &[], &["--json"])?.stdout)?;
    assert!(json["integrations"].as_array().is_some_and(|a| a.len() >= 5), "{json}");
    assert!(json["rollupHistory"]["days"].as_array().is_some_and(|a| !a.is_empty()));
    Ok(())
}

#[test]
fn a_budget_in_watch_mode_matches_node() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), BUDGET_SETTINGS)?;
    for a in ["", "--json", "--window 24h --json", "--by project", "--weekly"] {
        same(Some(seed.path()), &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
    }
    Ok(())
}

#[test]
fn weekly_modes_follow_the_settings_and_the_environment() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), r#"{"jev":{"enabled":true},"jevIntegrations":{"speculation":"shadow","claimLedger":"off"}}"#)?;
    for env in [&[][..], &[("ANTIHALL_JEV", "0")][..], &[("ANTIHALL_JEV_MODELROUTING", "0")][..], &[("ANTIHALL_JEV", "1")][..]] {
        for a in ["--weekly", "--weekly --json"] {
            same(Some(seed.path()), env, &a.split(' ').collect::<Vec<_>>())?;
        }
    }
    Ok(())
}

#[test]
fn an_empty_home_matches_node() -> R {
    for a in [
        "",
        "--json",
        "--weekly",
        "--weekly --json",
        "--by project",
        "--by session --json",
        "--window 24h",
        "label x",
        "label x tp",
        "prune-audit --days 2",
        "label",
    ] {
        same(None, &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
    }
    Ok(())
}

#[test]
fn damaged_files_match_node() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), "{not json")?;
    write(seed.path(), ".anti-hall/jev.json", "[1,2")?;
    write(seed.path(), ".anti-hall/logs/jev-triage.ndjson", "garbage\n{\"hash\":5}\n\n")?;
    write(seed.path(), ".anti-hall/logs/jev-labels.ndjson", "\u{feff}{\"h\":\"sp1\",\"label\":\"tp\",\"source\":\"human\"}\n")?;
    write(seed.path(), ".anti-hall/logs/jev-assist.ndjson.007", "{\"id\":\"x\",\"ts\":\"2020-01-01T00:00:00.000Z\"}\n")?;
    for a in ["", "--json", "--weekly", "--by project --json", "label sp1"] {
        same(Some(seed.path()), &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
    }
    let only_bad = Scratch::new("seed")?;
    write(only_bad.path(), ".anti-hall/logs/jev-assist.ndjson", "\u{0}\u{0}\n[[[\n")?;
    for a in ["", "--json"] {
        same(Some(only_bad.path()), &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
    }
    Ok(())
}

// ---- the credit balance ---------------------------------------------------------------------------------------------------

/// A one-shot HTTP server answering `connections` requests with `status` and `body`; returns its loopback URL.
fn serve(status: u16, body: &'static str, connections: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..connections {
            let Ok((mut s, _)) = listener.accept() else { return };
            let mut buf = [0u8; 2048];
            if s.read(&mut buf).is_err() {
                return;
            }
            let reply = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            if s.write_all(reply.as_bytes()).is_err() {
                return;
            }
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn credit_seed(settings: &str) -> R<Scratch> {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), settings)?;
    Ok(seed)
}

#[test]
fn the_credit_balance_matches_node_for_every_local_answer() -> R {
    let on = r#"{"jev":{"enabled":true,"budget":{"mode":"watch","minCreditUsd":100}}}"#;
    let typesafe = r#"{"jev":{"enabled":true,"transport":"typesafe"}}"#;
    let fallback = r#"{"jev":{"enabled":true,"transport":"typesafe","fallbackTransport":"vercel"}}"#;
    for (settings, env) in [("{}", vec![]), (on, vec![]), (typesafe, vec![]), (fallback, vec![]), (on, vec![("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "k")])]
    {
        let seed = credit_seed(settings)?;
        let url = serve(500, "no", 2);
        let mut e: Vec<(&str, &str)> = env;
        if e.iter().any(|(k, _)| k.contains("KEY")) {
            e.push(("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", &url));
        }
        for a in ["", "--json"] {
            same(Some(seed.path()), &e, &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
        }
    }
    Ok(())
}

#[test]
fn the_credit_balance_matches_node_against_a_loopback_gateway() -> R {
    let on = r#"{"jev":{"enabled":true,"budget":{"mode":"watch","minCreditUsd":100}}}"#;
    let bodies: &[(u16, &'static str)] = &[
        (200, r#"{"balance":"95.50","total_used":"4.50"}"#),
        (200, r#"{"balance":42,"total_used":"x"}"#),
        (200, r#"{"balance":250}"#),
        (200, "null"),
        (200, r#"{"nothing":1}"#),
        (200, "not json"),
        (404, "gone"),
        (503, r#"{"balance":1}"#),
    ];
    for (status, body) in bodies {
        let seed = credit_seed(on)?;
        let url = serve(*status, body, 2);
        for a in ["", "--json"] {
            same(
                Some(seed.path()),
                &[("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "k"), ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", &url)],
                &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>(),
            )?;
        }
    }
    // a closed port is a network error
    let seed = credit_seed(on)?;
    same(Some(seed.path()), &[("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "k"), ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", "http://127.0.0.1:1")], &["--json"])?;
    Ok(())
}

#[test]
fn a_cached_credit_balance_is_served_while_fresh() -> R {
    let on = r#"{"jev":{"enabled":true,"budget":{"mode":"watch","minCreditUsd":100}}}"#;
    let now = now_ms();
    for (age_min, cache) in [
        (1, r#"{"fetchedAt":{T},"vendor":"vercel","result":{"ok":true,"vendor":"vercel","balanceUsd":50,"totalUsedUsd":1.5,"ms":12}}"#.to_string()),
        (1, r#"{"fetchedAt":{T},"vendor":"vercel","result":{"ok":false,"reason":"timeout","ms":900}}"#.to_string()),
        (1, r#"{"fetchedAt":{T},"vendor":"typesafe","result":{"ok":true,"balanceUsd":5}}"#.to_string()),
        (30, r#"{"fetchedAt":{T},"vendor":"vercel","result":{"ok":true,"balanceUsd":5}}"#.to_string()),
        (1, "[1]".to_string()),
        (1, r#"{"fetchedAt":"x","vendor":"vercel","result":{"ok":true,"balanceUsd":5}}"#.to_string()),
    ] {
        let seed = credit_seed(on)?;
        write(seed.path(), ".anti-hall/cache/jev-credits.json", &cache.replace("{T}", &(now - age_min * MIN).to_string()))?;
        for a in ["", "--json"] {
            same(Some(seed.path()), &[], &a.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>())?;
        }
    }
    Ok(())
}

#[test]
fn the_low_credit_latch_fires_once_a_day() -> R {
    let on = r#"{"jev":{"enabled":true,"budget":{"mode":"watch","minCreditUsd":100}}}"#;
    let now = now_ms();
    for state in [
        None,
        Some(format!(r#"{{"creditWarnedDate":"{}"}}"#, &iso(now)[..10])),
        Some(r#"{"creditWarnedDate":"2020-01-01","other":1}"#.to_string()),
        Some("{broken".to_string()),
    ] {
        let seed = credit_seed(on)?;
        write(
            seed.path(),
            ".anti-hall/cache/jev-credits.json",
            &format!(r#"{{"fetchedAt":{},"vendor":"vercel","result":{{"ok":true,"vendor":"vercel","balanceUsd":50,"totalUsedUsd":1,"ms":3}}}}"#, now - MIN),
        )?;
        if let Some(s) = &state {
            write(seed.path(), ".anti-hall/state/jev-budget.json", s)?;
        }
        same(Some(seed.path()), &[], &[])?;
    }
    Ok(())
}

// ---- cases the engine used to leave to Node (lane L03: no exit 75 on jev-report) -------------------------------------------

/// `same` with a second, test-only home given by `--home`: each run gets its own copy of `other` (the `{OTHER}` argument).
fn same_with_other_home(seed: &Path, other: &Path, env: &[(&str, &str)], args: &[&str]) -> R<Out> {
    let name = format!("jev-report {} (--home other)", args.join(" "));
    let (nh, eh, no_, eo_) = (Scratch::new("n")?, Scratch::new("e")?, Scratch::new("no")?, Scratch::new("eo")?);
    for (h, o) in [(nh.path(), no_.path()), (eh.path(), eo_.path())] {
        fs::create_dir_all(h.join("tmp"))?;
        copy_dir(seed, h)?;
        copy_dir(other, o)?;
    }
    let argv = |o: &Path| args.iter().map(|a| if *a == "{OTHER}" { o.to_string_lossy().into_owned() } else { (*a).to_string() }).collect::<Vec<_>>();
    let mut n = Command::new("node");
    n.arg(plugin_src().join("scripts/jev-report.js")).args(argv(no_.path()));
    let mut e = Command::new(BIN);
    e.arg("jev-report").args(argv(eo_.path()));
    let (no, eo) = (run(n, nh.path(), env)?, run(e, eh.path(), env)?);
    let m = |o: &Out, h: &Path, x: &Path| Out { stdout: mask(&mask(&o.stdout, h), x), stderr: mask(&mask(&o.stderr, h), x), code: o.code };
    let (nm, em) = (m(&no, nh.path(), no_.path()), m(&eo, eh.path(), eo_.path()));
    assert_text(&name, "stdout", &nm.stdout, &em.stdout);
    assert_text(&name, "stderr", &nm.stderr, &em.stderr);
    assert_eq!(nm.code, em.code, "{name}: exit code");
    assert_eq!(snapshot(no_.path())?, snapshot(eo_.path())?, "{name}: --home tree");
    assert_ne!(em.code, 75, "{name}: the engine deferred to Node instead of answering");
    Ok(em)
}

#[test]
fn weekly_with_another_home_reads_modes_like_node() -> R {
    let other_files = [
        r#"{"enabled":true,"integrations":{"speculation":"off","customProbe":"on","modelRouting":"on"},"triage":false}"#,
        r#"{"enabled":false,"integrations":{"claimLedger":"shadow"}}"#,
        "not json",
    ];
    for real_settings in ["{}", r#"{"jev":{"enabled":true},"jevIntegrations":{"speculation":"shadow"}}"#] {
        let seed = Scratch::new("seed")?;
        full_seed(seed.path(), real_settings)?;
        for jev in other_files {
            let other = Scratch::new("other")?;
            full_seed(other.path(), "{}")?;
            write(other.path(), ".anti-hall/jev.json", jev)?;
            for env in [&[][..], &[("ANTIHALL_JEV", "1")][..]] {
                for a in [&["--weekly", "--home", "{OTHER}"][..], &["--weekly", "--json", "--home", "{OTHER}"][..]] {
                    same_with_other_home(seed.path(), other.path(), env, a)?;
                }
            }
        }
    }
    Ok(())
}

#[test]
fn every_credit_balance_shape_matches_node() -> R {
    let on = r#"{"jev":{"enabled":true,"budget":{"mode":"watch","minCreditUsd":100}}}"#;
    let bodies: &[&'static str] = &[
        r#"{"balance":"0x10","total_used":"0b11"}"#,
        r#"{"balance":"0o17","total_used":"0xZZ"}"#,
        r#"{"balance":"-0x10"}"#,
        r#"{"balance":[5],"total_used":[]}"#,
        r#"{"balance":[[7]],"total_used":[1,2]}"#,
        r#"{"balance":["1",2]}"#,
        r#"{"balance":[null],"total_used":[true]}"#,
        r#"{"balance":true,"total_used":false}"#,
        r#"{"balance":{}}"#,
        r#"{"balance":[{}]}"#,
        r#"{"balance":" 12.5 ","total_used":"Infinity"}"#,
        r#"{"balance":"1e3","total_used":"-Infinity"}"#,
        r#"{"balance":"inf"}"#,
        r#"{"balance":"+.5","total_used":"5."}"#,
        r#"{"balance":null,"total_used":null}"#,
        "0",
        "7",
        r#""text""#,
        "[3]",
        "true",
    ];
    for body in bodies {
        let seed = credit_seed(on)?;
        let url = serve(200, body, 2);
        same(Some(seed.path()), &[("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "k"), ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", &url)], &["--json"])?;
    }
    Ok(())
}

/// A label that cannot be written: both tools say so on stderr with the same words before the system's error text, print
/// nothing on stdout and exit 1.
#[test]
fn a_label_that_cannot_be_written_fails_like_node() -> R {
    let seed = Scratch::new("seed")?;
    full_seed(seed.path(), "{}")?;
    for (bin, script) in [("node", true), (BIN, false)] {
        let h = Scratch::new("h")?;
        copy_dir(seed.path(), h.path())?;
        fs::create_dir_all(h.path().join("tmp"))?;
        let _ = fs::remove_file(h.path().join(".anti-hall/logs/jev-labels.ndjson"));
        fs::create_dir_all(h.path().join(".anti-hall/logs/jev-labels.ndjson"))?;
        let mut c = Command::new(bin);
        if script {
            c.arg(plugin_src().join("scripts/jev-report.js"));
        } else {
            c.arg("jev-report");
        }
        c.args(["label", "sp1", "tp"]);
        let o = run(c, h.path(), &[])?;
        let head = format!("❌ anti-hall · jev-report: label: failed to write {}/.anti-hall/logs/jev-labels.ndjson: ", h.path().display());
        assert!(o.stderr.starts_with(&head), "{bin}: {o:?}");
        assert_eq!((o.stdout.as_str(), o.code), ("", 1), "{bin}");
    }
    Ok(())
}
