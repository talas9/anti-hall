//! Node-vs-engine parity for `ah-engine migrate` (D81): the persisted-state migrations and sweeps of the Node doctor's repair
//! pass (`doctor.js --repair --migrations-only`).
//!
//! Each scenario seeds two identical, isolated homes (and project directories) and runs the real Node doctor on one and
//! `ah-engine migrate --json` on the other, with no inherited environment (`HOME` and `USERPROFILE` at the fixture, never the
//! real home). It compares the exit code, the stdout bytes (Node's report line, row for row) and every file under the home and
//! the project afterwards, with the clock normalized (completion stamps, `.corrupt-<ms>` names). Scenarios cover the seeded-bad
//! states of every persisted shape a step reads: legacy, mixed, already migrated, corrupt, empty.
//!
//! The steps that need the DevSwarm stores are the one place the engine differs on purpose (it defers them to Node while
//! DevSwarm state exists); `deferred_*` scenarios pin that behaviour.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

static N: AtomicUsize = AtomicUsize::new(0);
const DAY: u64 = 86_400;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn plugin() -> PathBuf {
    repo().join("plugins/anti-hall")
}

struct Fx {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

impl Drop for Fx {
    fn drop(&mut self) {
        // a scenario may have made something unreadable on purpose: give the owner access back, then remove the fixture
        let restored = Command::new("chmod").args(["-R", "u+rwx"]).arg(&self.root).status().is_ok_and(|s| s.success());
        assert!(restored, "chmod restore of the fixture failed");
        if let Err(e) = fs::remove_dir_all(&self.root) {
            eprintln!("could not remove fixture {}: {e}", self.root.display());
        }
    }
}

/// The report with the fixture's own directory (which differs between the two runs) written as `{ROOT}`.
fn norm(text: &str, fx: &Fx) -> String {
    let canon = fs::canonicalize(&fx.root).unwrap();
    text.replace(canon.to_string_lossy().as_ref(), "{ROOT}").replace(fx.root.to_string_lossy().as_ref(), "{ROOT}")
}

fn chmod(base: &Path, rel: &str, mode: &str) {
    let ok = Command::new("chmod").arg(mode).arg(base.join(rel)).status().is_ok_and(|s| s.success());
    assert!(ok, "chmod {mode} {rel}");
}

fn fixture(seed: &dyn Fn(&Path, &Path)) -> Fx {
    let root = std::env::temp_dir().join(format!("ah-migrate-parity-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let (home, cwd) = (root.join("home"), root.join("cwd"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    assert!(home.starts_with(std::env::temp_dir()), "a fixture home is always under the temp dir, never the real home");
    seed(&home, &cwd);
    Fx { root, home, cwd }
}

fn put(base: &Path, rel: &str, content: impl AsRef<[u8]>) {
    let p = base.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

/// Set a file's modification time to `secs` seconds ago.
fn age(base: &Path, rel: &str, secs: u64) {
    let f = fs::OpenOptions::new().write(true).open(base.join(rel)).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
}

struct Out {
    stdout: String,
    code: i32,
}

fn clean_env(cmd: &mut Command, home: &Path, env: &[(&str, &str)]) {
    cmd.env_clear().env("PATH", std::env::var("PATH").unwrap_or_default()).env("HOME", home).env("USERPROFILE", home);
    for (k, v) in env {
        cmd.env(k, v);
    }
}

fn run_node(fx: &Fx, dry: bool, env: &[(&str, &str)]) -> Out {
    let mut cmd = Command::new("node");
    cmd.arg(plugin().join("hooks/doctor.js")).args(["--repair", "--migrations-only"]);
    if dry {
        cmd.arg("--dry-run");
    }
    cmd.current_dir(&fx.cwd).env("ANTIHALL_INGEST_DRY_RUN", "1");
    clean_env(&mut cmd, &fx.home, env);
    let o = cmd.output().expect("node");
    Out { stdout: String::from_utf8_lossy(&o.stdout).into_owned(), code: o.status.code().unwrap_or(-1) }
}

fn run_rust(fx: &Fx, dry: bool, env: &[(&str, &str)]) -> Out {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.args(["migrate", "--json", "--plugin-root"]).arg(plugin());
    if dry {
        cmd.arg("--dry-run");
    }
    cmd.current_dir(&fx.cwd);
    clean_env(&mut cmd, &fx.home, env);
    let o = cmd.output().expect("ah-engine");
    Out { stdout: String::from_utf8_lossy(&o.stdout).into_owned(), code: o.status.code().unwrap_or(-1) }
}

fn stamp_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r#""completedTs":\d+"#).unwrap())
}

fn at_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r#""at":(\d{13})"#).unwrap())
}

fn corrupt_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"\.corrupt-\d+").unwrap())
}

/// Every file under `root` (relative path to bytes), with the clock normalized.
fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if p.is_dir() {
                out.entry(format!("{rel}/")).or_default();
                walk(base, &p, out);
            } else {
                let Ok(mut bytes) = fs::read(&p) else {
                    out.insert(rel, b"<unreadable>".to_vec());
                    continue;
                };
                if rel.ends_with("update-sweep-state.json") {
                    let t = String::from_utf8_lossy(&bytes).into_owned();
                    let re = stamp_re();
                    bytes = re.replace_all(&t, r#""completedTs":0"#).into_owned().into_bytes();
                }
                if rel.ends_with("auto-archived.json") {
                    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as i64;
                    let t = String::from_utf8_lossy(&bytes).into_owned();
                    let re = at_re();
                    let masked = re.replace_all(&t, |c: &regex::Captures| {
                        let v: i64 = c[1].parse().unwrap_or(0);
                        if (now - v).abs() < 300_000 { r#""at":NOW"#.to_string() } else { c[0].to_string() }
                    });
                    bytes = masked.into_owned().into_bytes();
                }
                let key = corrupt_re().replace_all(&rel, ".corrupt-N").into_owned();
                out.insert(key, bytes);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn show(m: &BTreeMap<String, Vec<u8>>, k: &str) -> String {
    m.get(k).map_or("<absent>".into(), |b| String::from_utf8_lossy(b).into_owned())
}

/// Run `steps` (each a dry-run flag and extra environment) on a Node home and an engine home seeded alike; every step must give
/// the same exit code, the same report and the same files.
fn parity(name: &str, seed: &dyn Fn(&Path, &Path), steps: &[(bool, Vec<(&str, &str)>)]) -> Vec<String> {
    let (a, b) = (fixture(seed), fixture(seed));
    let mut reports = Vec::new();
    for (i, (dry, env)) in steps.iter().enumerate() {
        let (node, rust) = (run_node(&a, *dry, env), run_rust(&b, *dry, env));
        let (node, rust) = (Out { stdout: norm(&node.stdout, &a), code: node.code }, Out { stdout: norm(&rust.stdout, &b), code: rust.code });
        reports.push(node.stdout.clone());
        assert!(node.code == 0 || node.code == 1, "{name} step {i}: node did not run: {}", node.stdout);
        assert_eq!(node.code, rust.code, "{name} step {i}: exit code");
        if node.stdout != rust.stdout {
            let (nj, rj): (serde_json::Value, serde_json::Value) =
                (serde_json::from_str(&node.stdout).unwrap_or_default(), serde_json::from_str(&rust.stdout).unwrap_or_default());
            let empty = Vec::new();
            let (nr, rr) = (nj["repairs"].as_array().unwrap_or(&empty), rj["repairs"].as_array().unwrap_or(&empty));
            for (x, y) in nr.iter().zip(rr.iter()) {
                if x != y {
                    eprintln!("{name} step {i}: row differs\n  node : {x}\n  rust : {y}");
                }
            }
            panic!("{name} step {i}: report differs (rows node {} / rust {})\nnode: {}\nrust: {}", nr.len(), rr.len(), node.stdout, rust.stdout);
        }
        for (label, x, y) in [("home", &a.home, &b.home), ("cwd", &a.cwd, &b.cwd)] {
            let (tn, tr) = (tree(x), tree(y));
            if tn != tr {
                let mut keys: Vec<&String> = tn.keys().chain(tr.keys()).collect();
                keys.sort();
                keys.dedup();
                for k in keys {
                    if tn.get(k) != tr.get(k) {
                        eprintln!("{name} step {i}: {label}/{k} differs\n  node : {}\n  rust : {}", show(&tn, k), show(&tr, k));
                    }
                }
                panic!("{name} step {i}: the {label} trees differ");
            }
        }
    }
    reports
}

/// The status of step `id` in a report line (`None` when the report has no such row).
fn status(report: &str, id: &str) -> Option<String> {
    let j: serde_json::Value = serde_json::from_str(report).ok()?;
    j["repairs"].as_array()?.iter().find(|r| r["id"] == id).and_then(|r| r["status"].as_str().map(str::to_string))
}

/// A scenario is not vacuous: the named steps really did the work (`fixed`) in the report of the given step.
fn did(reports: &[String], step: usize, ids: &[&str]) {
    for id in ids {
        assert_eq!(status(&reports[step], id).as_deref(), Some("fixed"), "step {step}: {id} should have fixed something: {}", reports[step]);
    }
}

/// Like [`parity`], for a seed that creates DevSwarm store state: the store-backed steps are deferred by the engine (reported
/// `skipped`, not stamped) where Node reports "nothing to migrate", so those rows are compared by shape and the marker file is
/// left out of the comparison; every other row and every other file must match.
fn parity_deferring(name: &str, seed: &dyn Fn(&Path, &Path), steps: &[(bool, Vec<(&str, &str)>)]) {
    let (a, b) = (fixture(seed), fixture(seed));
    for (i, (dry, env)) in steps.iter().enumerate() {
        let node = run_node(&a, *dry, env);
        let rust = run_rust(&b, *dry, env);
        assert_eq!(node.code, rust.code, "{name} step {i}: exit code");
        let rows = |o: &Out| -> Vec<serde_json::Value> { serde_json::from_str::<serde_json::Value>(&o.stdout).unwrap()["repairs"].as_array().unwrap().clone() };
        let (nr, rr) = (rows(&node), rows(&rust));
        assert_eq!(nr.len(), rr.len(), "{name} step {i}: row count");
        for (n, r) in nr.iter().zip(rr.iter()) {
            if r["msg"].as_str().unwrap().starts_with("left to the Node doctor") {
                assert_eq!(n["id"], r["id"]);
                assert_eq!(r["status"], "skipped");
            } else {
                assert_eq!(n, r, "{name} step {i}");
            }
        }
        for (label, x, y) in [("home", &a.home, &b.home), ("cwd", &a.cwd, &b.cwd)] {
            let (mut tn, mut tr) = (tree(x), tree(y));
            for t in [&mut tn, &mut tr] {
                t.remove(".anti-hall/update-sweep-state.json");
                // the backend marker Node's store migration writes into a store directory
                t.retain(|k, _| !k.ends_with("/BACKEND"));
            }
            assert_eq!(tn.keys().collect::<Vec<_>>(), tr.keys().collect::<Vec<_>>(), "{name} step {i}: {label} file lists");
            for k in tn.keys() {
                assert_eq!(show(&tn, k), show(&tr, k), "{name} step {i}: {label}/{k}");
            }
        }
    }
}

fn once() -> Vec<(bool, Vec<(&'static str, &'static str)>)> {
    vec![(false, vec![])]
}

/// A real run, then a dry run (nothing left to do), then a real run again ("already applied" markers).
fn thrice() -> Vec<(bool, Vec<(&'static str, &'static str)>)> {
    vec![(false, vec![]), (true, vec![]), (false, vec![])]
}

fn dry_then_real() -> Vec<(bool, Vec<(&'static str, &'static str)>)> {
    vec![(true, vec![]), (false, vec![]), (false, vec![])]
}

#[test]
fn an_empty_home_reports_nothing_to_migrate_and_stamps() {
    parity("empty", &|_, _| {}, &thrice());
}

#[test]
fn legacy_progress_and_history_are_copied_and_the_originals_kept() {
    let seed = |_: &Path, cwd: &Path| {
        put(cwd, ".anti-hall-progress.md", "# progress\nline two\n");
        // not valid UTF-8: Node decodes with replacement characters and writes that text
        put(cwd, ".anti-hall-history.md", b"history \xff\xfe bytes\n".as_slice());
    };
    let r = parity("legacy", &seed, &dry_then_real());
    did(&r, 1, &["migrate-legacy"]);
    let seed2 = |_: &Path, cwd: &Path| {
        put(cwd, ".anti-hall-progress.md", "# progress\n");
        put(cwd, ".anti-hall/history/legacy/.anti-hall-progress.md", "# progress\n"); // already copied
        put(cwd, ".anti-hall-history.md", "newer\n");
        put(cwd, ".anti-hall/history/legacy/.anti-hall-history.md", "older copy\n"); // differs: refreshed
    };
    parity("legacy-refresh", &seed2, &once());
}

#[test]
fn reply_state_files_in_every_prior_shape_are_normalized() {
    let seed = |home: &Path, _: &Path| {
        let g = ".anti-hall/devswarm/parent-gate";
        // the only released shape: one merged object
        put(
            home,
            &format!("{g}/repo-a-replies.json"),
            r#"{"w1":{"lastReplyTs":100},"w2":{"lastReplyTs":250.5},"w3":{"lastReplyTs":"x"},"__proto__":{"lastReplyTs":7}}"#,
        );
        // a mix of the legacy line and appended records, with a repeated sender (the latest wins) and a junk line
        put(
            home,
            &format!("{g}/repo-b-replies.json"),
            "{\"w1\":{\"lastReplyTs\":10}}\n{\"m\":\"w1\",\"t\":30}\nnot json\n{\"m\":\"w1\",\"t\":20}\n[1,2]\n{\"m\":\"w9\",\"t\":1e21}\n",
        );
        // already append-only: left byte for byte
        put(home, &format!("{g}/repo-c-replies.json"), "{\"m\":\"w1\",\"t\":5}\n{\"m\":\"w2\",\"t\":6}\n");
        // empty file and a whitespace-only one are already normalized
        put(home, &format!("{g}/repo-d-replies.json"), "");
        put(home, &format!("{g}/repo-e-replies.json"), "  \n\n");
        // sender ids that sort differently by code point and by UTF-16 unit
        put(
            home,
            &format!("{g}/repo-f-replies.json"),
            "{\"\u{1F600}\":{\"lastReplyTs\":1},\"\u{FFFF}\":{\"lastReplyTs\":2},\"b\":{\"lastReplyTs\":3},\"B\":{\"lastReplyTs\":4}}",
        );
        // a directory named like a reply file, and a gate-state file in the same directory
        fs::create_dir_all(home.join(format!("{g}/dir-replies.json"))).unwrap();
        put(home, &format!("{g}/sess1.json"), r#"{"blocks":2}"#);
    };
    let r = parity("reply-state", &seed, &dry_then_real());
    did(&r, 1, &["migrate-reply-state"]);
}

#[test]
fn gate_loop_state_files_gain_intents_and_acks_and_nothing_else_changes() {
    let seed = |home: &Path, _: &Path| {
        let g = ".anti-hall/devswarm/parent-gate";
        put(home, &format!("{g}/s-none.json"), r#"{"blocks":3,"last":{"a":1}}"#);
        put(home, &format!("{g}/s-intents-only.json"), r#"{"intents":{"x":1},"n":1}"#);
        put(home, &format!("{g}/s-acks-only.json"), r#"{"intentAcks":4}"#);
        put(home, &format!("{g}/s-both.json"), r#"{"intents":{},"intentAcks":0,"z":1}"#);
        put(home, &format!("{g}/s-empty.json"), "  \n");
        put(home, &format!("{g}/s-array.json"), "[1,2]");
        put(home, &format!("{g}/s-corrupt.json"), "{not json");
        put(home, &format!("{g}/s-nested.json"), r#"{"b":1,"2":{"k":[1,2.50,"é"]},"1":true}"#);
        put(home, &format!("{g}/UPPER-REPLIES.JSON"), "{}");
        put(home, &format!("{g}/note.txt"), "x");
    };
    let r = parity("gate-intents", &seed, &dry_then_real());
    did(&r, 1, &["migrate-gate-intents"]);
}

#[test]
fn the_auto_archive_record_is_seeded_from_the_log() {
    let seed = |home: &Path, _: &Path| {
        let log = ".anti-hall/logs/devswarm-auto-archive.ndjson";
        put(
            home,
            log,
            concat!(
                "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w1\",\"doneHead\":\"abc\",\"at\":1700000000000}\n",
                "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w1\",\"doneHead\":\"abc\",\"at\":1700000000001}\n",
                "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w1\",\"doneHead\":\"def\",\"ts\":\"2023-11-14T22:13:20.000Z\"}\n",
                "{\"action\":\"auto-archive\",\"ok\":false,\"id\":\"w2\",\"doneHead\":\"x\"}\n",
                "{\"action\":\"other\",\"ok\":true,\"id\":\"w3\"}\n",
                "not json\n",
                "   \n",
                "{\"action\":\"auto-archive\",\"ok\":true,\"id\":7,\"doneHead\":null,\"at\":5}\n",
                "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w4\",\"at\":\"9\",\"ts\":\"2023-11-14T22:13:20.000Z\"}\n",
            ),
        );
        // an earlier record for w1 at head abc exists: it is not added twice
        put(home, ".anti-hall/devswarm/auto-archived.json", r#"{"w1":[{"doneHead":"abc","at":1}]}"#);
    };
    // a record with no `doneHead` (written before 0.108.3) never matches the entry the migration appends for it (`null` is not
    // `undefined`), so Node reports it pending forever; the engine reports exactly the same
    let r = parity("auto-archived", &seed, &dry_then_real());
    assert_eq!(status(&r[1], "migrate-auto-archived-state").as_deref(), Some("failed"));
    let clean = |home: &Path, cwd: &Path| {
        seed(home, cwd);
        put(
            home,
            ".anti-hall/logs/devswarm-auto-archive.ndjson",
            "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w1\",\"doneHead\":\"abc\",\"at\":1700000000000}\n{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w5\",\"doneHead\":\"h5\",\"ts\":\"2023-11-14T22:13:20.000Z\"}\n",
        );
    };
    let r = parity("auto-archived-clean", &clean, &dry_then_real());
    did(&r, 1, &["migrate-auto-archived-state"]);
    let corrupt = |home: &Path, _: &Path| {
        put(home, ".anti-hall/logs/devswarm-auto-archive.ndjson", "{\"action\":\"auto-archive\",\"ok\":true,\"id\":\"w1\",\"doneHead\":\"abc\",\"at\":1}\n");
        put(home, ".anti-hall/devswarm/auto-archived.json", "{corrupt");
    };
    parity("auto-archived-corrupt-state", &corrupt, &once());
}

#[test]
fn stale_lock_scratch_files_are_swept_and_fresh_ones_and_real_locks_are_not() {
    let seed = |home: &Path, _: &Path| {
        let old = 3 * 3600;
        for rel in [
            ".anti-hall/devswarm/locks/a.lock.tmp-123-abc",
            ".anti-hall/devswarm/locks/a.lock.reap-1-2",
            ".anti-hall/devswarm/locks/a.lock.hb.9-x",
            ".anti-hall/devswarm/locks/a.lock.reclaim",
            ".anti-hall/devswarm/locks/a.lock.reclaim.tmp.5",
            ".anti-hall/settings.json.lock.tmp-1",
            ".anti-hall/logs/rot.lock.hb.1-2",
            ".anti-hall/devswarm/store/ab12cd34/journal/j.lock.tmp-7-z",
        ] {
            put(home, rel, "x");
            age(home, rel, old);
        }
        // fresh scratch, a real lock, an unrelated old file, and a directory with a scratch-like name
        put(home, ".anti-hall/devswarm/locks/fresh.lock.tmp-1-2", "x");
        put(home, ".anti-hall/devswarm/locks/b.lock", "{}");
        age(home, ".anti-hall/devswarm/locks/b.lock", old);
        put(home, ".anti-hall/devswarm/locks/other.txt", "x");
        age(home, ".anti-hall/devswarm/locks/other.txt", old);
        fs::create_dir_all(home.join(".anti-hall/devswarm/locks/c.lock.tmp-1-1")).unwrap();
    };
    parity_deferring("lock-scratch", &seed, &dry_then_real());
    // the same files, with no store directory, so the whole report is compared
    let plain = |home: &Path, cwd: &Path| {
        seed(home, cwd);
        let _ = fs::remove_dir_all(home.join(".anti-hall/devswarm/store"));
    };
    let r = parity("lock-scratch-plain", &plain, &dry_then_real());
    did(&r, 1, &["sweep-lock-scratch"]);
}

#[test]
fn the_jev_triage_cache_loses_only_its_poisoned_entries() {
    let seed = |home: &Path, _: &Path| {
        put(
            home,
            ".anti-hall/cache/jev-triage.json",
            r#"{"a":{"urgency":"urgent","_seq":1},"b":{"_seq":2},"c":{"nl":true,"_seq":3},"d":{"kind":"question"},"e":null,"f":[1],"g":{"nl":false}}"#,
        );
    };
    let r = parity("triage", &seed, &dry_then_real());
    did(&r, 1, &["repair-jev-triage-cache"]);
    parity("triage-clean", &|h, _| put(h, ".anti-hall/cache/jev-triage.json", r#"{"a":{"urgency":"u"}}"#), &once());
    parity("triage-array", &|h, _| put(h, ".anti-hall/cache/jev-triage.json", "[1]"), &once());
    parity("triage-corrupt", &|h, _| put(h, ".anti-hall/cache/jev-triage.json", "{nope"), &once());
}

#[test]
fn legacy_jev_settings_move_into_settings_json_without_overwriting() {
    let seed = |home: &Path, _: &Path| {
        put(
            home,
            ".anti-hall/jev.json",
            r#"{"enabled":"true","transport":"typesafe","fallbackTransport":"VERCEL","timeoutMs":9999,"confidenceThreshold":0.5,"budget":{"mode":"watch","usdPerDay":2.5,"usdPerWeek":0},"triage":"off","weeklyNotice":0,"integrations":{"speculation":"shadow","triage":"bogus","findingDedup":"OFF"},"prices":{"m":{"inPerMTok":1}},"keyFile":"~/k","audit":{"snippets":true}}"#,
        );
        // already set in settings.json: kept; the old per-integration key moves to its new section
        put(
            home,
            ".anti-hall/settings.json",
            r#"{"jev":{"transport":"vercel","integrations.newRequest":"on","integrations.speculation":"off"},"guards":{"x":1}}"#,
        );
    };
    // an out-of-range legacy value (an unknown integration mode) is an error in both, and is not stamped
    let r = parity("settings-legacy", &seed, &thrice());
    assert_eq!(status(&r[0], "migrate-settings-from-legacy").as_deref(), Some("failed"));
    let clean = |home: &Path, _: &Path| {
        put(
            home,
            ".anti-hall/jev.json",
            r#"{"enabled":"true","transport":"typesafe","budget":{"mode":"watch","usdPerDay":2.5},"triage":"off","integrations":{"speculation":"shadow","findingDedup":"off"}}"#,
        );
        put(home, ".anti-hall/settings.json", r#"{"jev":{"integrations.newRequest":"on"},"guards":{"x":1}}"#);
    };
    let r = parity("settings-legacy-clean", &clean, &thrice());
    did(&r, 0, &["migrate-settings-from-legacy"]);
    parity(
        "settings-corrupt",
        &|h, _| {
            put(h, ".anti-hall/jev.json", r#"{"enabled":true}"#);
            put(h, ".anti-hall/settings.json", "{broken");
        },
        &once(),
    );
    parity("settings-legacy-corrupt-file", &|h, _| put(h, ".anti-hall/jev.json", "{broken"), &once());
}

#[test]
fn stored_plugin_options_are_copied_only_when_they_are_the_value_in_effect() {
    let seed = |home: &Path, _: &Path| {
        // flat form under the plugin id, nested form under the bare name; the plugin id outranks it
        put(
            home,
            ".claude/settings.json",
            r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_paused_probe_max":"12","codex_nudge_min":"7","statusline_no_email":"true","statusline_base":"echo hi"}},"anti-hall@anti-hall":{"codex_nudge_min":"9","defects_default_proj":"proj","jev_budget_mode":"watch"}}}"#,
        );
    };
    let r = parity("plugin-options", &seed, &thrice());
    did(&r, 0, &["migrate-settings-from-legacy"]);
    // an environment override makes the stored value not the effective one: it is not copied
    parity("plugin-options-env", &seed, &[(false, vec![("ANTIHALL_CODEX_NUDGE_MIN", "4"), ("CLAUDE_PLUGIN_OPTION_STATUSLINE_BASE", "other")])]);
}

#[test]
fn drain_markers_stale_ones_are_removed_and_fresh_ones_kept() {
    // one instant for both fixtures, so the two homes are seeded byte for byte alike
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis();
    let seed = |home: &Path, _: &Path| {
        let d = ".anti-hall/devswarm/drain";
        put(home, &format!("{d}/fresh.json"), format!(r#"{{"startedAt":{},"sessionId":"s","pid":1,"count":2}}"#, now - 1000));
        put(home, &format!("{d}/stale.json"), format!(r#"{{"startedAt":{},"sessionId":"s"}}"#, now - 3_600_000));
        put(home, &format!("{d}/future.json"), format!(r#"{{"startedAt":{}}}"#, now + 3_600_000));
        put(home, &format!("{d}/nostart.json"), r#"{"sessionId":"s"}"#);
        put(home, &format!("{d}/corrupt.json"), "{nope");
        put(home, &format!("{d}/bad..id.json"), "{}");
        put(home, &format!("{d}/note.txt"), "x");
    };
    let r = parity("drain", &seed, &dry_then_real());
    did(&r, 1, &["sweep-drain-markers"]);
    parity("drain-ttl-env", &seed, &[(false, vec![("ANTIHALL_DEVSWARM_DRAIN_TTL_MS", "100000000")])]);
}

#[test]
fn retention_sweeps_remove_only_files_past_their_window() {
    let seed = |home: &Path, _: &Path| {
        let a = ".anti-hall";
        let files: &[(&str, u64)] = &[
            (".anti-hall/devswarm/reaped/old.ndjson", 40 * DAY),
            (".anti-hall/devswarm/reaped/new.ndjson", DAY),
            (".anti-hall/devswarm/reaped/old.txt", 400 * DAY),
            (".anti-hall/devswarm/send-receipts/2026-01-01/r1.json", 10 * DAY),
            (".anti-hall/devswarm/send-receipts/2026-01-01/r2.json", DAY),
            (".anti-hall/devswarm/send-receipts/top.json", 20 * DAY),
            (".anti-hall/devswarm/send-receipts/2026-01-01/deeper/x.json", 100 * DAY),
            (".anti-hall/auto-handover/t1.json", 45 * DAY),
            (".anti-hall/auto-handover/t2.json", DAY),
            (".anti-hall/context-pct/t1.json", 45 * DAY),
            (".anti-hall/context-pct/t1.inferred-1m.json", 45 * DAY),
            (".anti-hall/context-pct/t2.json", 2 * DAY),
            (".anti-hall/devswarm/child-gate/s1.json", 20 * DAY),
            (".anti-hall/devswarm/child-gate/s2.json", 3 * DAY),
        ];
        let _ = a;
        for (rel, secs) in files {
            put(home, rel, "x");
            age(home, rel, *secs);
        }
    };
    let r = parity("retention", &seed, &dry_then_real());
    did(&r, 1, &["sweep-reaped-logs", "sweep-send-receipts", "sweep-auto-handover-state", "sweep-context-pct-state", "sweep-child-gate"]);
    // a window set through the environment, through settings.json, and an unusable value
    parity(
        "retention-env",
        &seed,
        &[(
            false,
            vec![
                ("ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS", "2"),
                ("ANTIHALL_AUTO_HANDOVER_STATE_RETENTION_DAYS", "100"),
                ("ANTIHALL_CONTEXT_PCT_STATE_RETENTION_DAYS", "junk"),
            ],
        )],
    );
    let with_settings = |home: &Path, cwd: &Path| {
        seed(home, cwd);
        put(home, ".anti-hall/settings.json", r#"{"devswarm":{"sendReceiptRetentionDays":"30","childGateRetentionDays":0,"reapedRetentionDays":" 5 "}}"#);
    };
    parity("retention-settings", &with_settings, &once());
}

#[test]
fn stuck_nd_cursors_are_raised_never_lowered_and_never_past_the_inbox() {
    let seed = |home: &Path, _: &Path| {
        let ds = ".anti-hall/devswarm";
        for (id, lines) in [("w1", 10), ("w2", 3), ("w3", 5)] {
            put(home, &format!("{ds}/inbox/{id}.ndjson"), "{\"a\":1}\n".repeat(lines) + "\n  \n");
        }
        // behind the descriptor cursor: raised
        put(home, &format!("{ds}/cursors/w1.json"), "8");
        put(home, &format!("{ds}/cursors/w1#nd-abc123.json"), "2");
        // descriptor ahead of the inbox: clamped to the inbox length
        put(home, &format!("{ds}/cursors/w2.json"), "{\"line\": 99}");
        put(home, &format!("{ds}/cursors/w2#nd-ff00.json"), "0");
        // instance ahead of the descriptor: never lowered
        put(home, &format!("{ds}/cursors/w3.json"), "1");
        put(home, &format!("{ds}/cursors/w3#nd-aa.json"), "4");
        // no descriptor cursor: untouched
        put(home, &format!("{ds}/cursors/w4#nd-aa.json"), "0");
        // junk cursor content reads as 0
        put(home, &format!("{ds}/cursors/w1#nd-dead.json"), "junk");
    };
    let r = parity("nd-cursors", &seed, &dry_then_real());
    did(&r, 1, &["reconcile-nd-cursors"]);
}

#[test]
fn stale_summaries_without_a_store_are_removed() {
    let seed = |home: &Path, _: &Path| {
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
        let s = ".anti-hall/devswarm/summaries";
        put(home, &format!("{s}/old-aaaaaa.json"), format!(r#"{{"generatedAt":{}}}"#, now - 90 * DAY * 1000));
        put(home, &format!("{s}/new-bbbbbb.json"), format!(r#"{{"generatedAt":{}}}"#, now - DAY * 1000));
        put(home, &format!("{s}/noage-cccccc.json"), "{}");
        put(home, &format!("{s}/corrupt-dddddd.json"), "{x");
        put(home, &format!("{s}/arr.json"), "[]");
        // a repository key that has a store directory: never collected (the store step is left to Node, so this run uses an
        // empty store directory the engine does not treat as DevSwarm state)
        put(home, &format!("{s}/live-eeeeee.json"), format!(r#"{{"generatedAt":{}}}"#, now - 90 * DAY * 1000));
        fs::create_dir_all(home.join(".anti-hall/devswarm/store/live-eeeeee")).unwrap();
    };
    // the store directory makes DevSwarm state present: the store-backed steps differ by design, so compare the sweep only
    let (a, b) = (fixture(&seed), fixture(&seed));
    let (node, rust) = (run_node(&a, false, &[]), run_rust(&b, false, &[]));
    let row = |o: &Out, id: &str| -> serde_json::Value {
        let j: serde_json::Value = serde_json::from_str(&o.stdout).unwrap();
        j["repairs"].as_array().unwrap().iter().find(|r| r["id"] == id).cloned().unwrap()
    };
    assert_eq!(row(&node, "gc-stale-summaries"), row(&rust, "gc-stale-summaries"));
    let sumdir = |f: &Fx| tree(&f.home.join(".anti-hall/devswarm/summaries")).keys().cloned().collect::<Vec<_>>();
    assert_eq!(sumdir(&a), sumdir(&b));
}

#[test]
fn steps_that_need_the_devswarm_stores_are_deferred_while_devswarm_state_exists() {
    let seed = |home: &Path, _: &Path| {
        put(home, ".anti-hall/devswarm/workspaces/x.json", "{}");
        put(home, ".anti-hall/devswarm/parent-gate/s.json", r#"{"a":1}"#);
    };
    let (a, b) = (fixture(&seed), fixture(&seed));
    let (node, rust) = (run_node(&a, false, &[]), run_rust(&b, false, &[]));
    let rows = |o: &Out| -> Vec<serde_json::Value> { serde_json::from_str::<serde_json::Value>(&o.stdout).unwrap()["repairs"].as_array().unwrap().clone() };
    let must_defer =
        ["migrate-devswarm-store", "fold-mesh-duplicates", "owner-key-migrate", "recover-archive-intent", "merge-split-backend-stores", "fold-all-stores"];
    for (n, r) in rows(&node).iter().zip(rows(&rust).iter()) {
        assert_eq!(n["id"], r["id"]);
        let deferred = r["msg"].as_str().unwrap().starts_with("left to the Node doctor");
        if must_defer.contains(&r["id"].as_str().unwrap()) {
            assert!(deferred, "{r}");
        }
        if deferred {
            assert_eq!(r["status"], "skipped", "{r}");
        } else {
            assert_eq!(n, r, "a step that works on plain files must match Node");
        }
    }
    // a deferred registry step is not stamped, so the Node doctor still does it; the plain-file steps are
    let marks = fs::read_to_string(b.home.join(".anti-hall/update-sweep-state.json")).unwrap();
    assert!(!marks.contains("mergeSplitBackendStores"), "{marks}");
    assert!(marks.contains("migrateSettingsFromLegacy"), "{marks}");
    // the gate-state file was migrated exactly as Node does
    assert_eq!(
        fs::read(a.home.join(".anti-hall/devswarm/parent-gate/s.json")).unwrap(),
        fs::read(b.home.join(".anti-hall/devswarm/parent-gate/s.json")).unwrap()
    );
}

#[test]
fn unreadable_state_is_reported_like_node_and_left_alone() {
    let seed = |home: &Path, _: &Path| {
        let ds = ".anti-hall/devswarm";
        put(home, &format!("{ds}/reaped/a.ndjson"), "x");
        put(home, &format!("{ds}/drain/d.json"), "{}");
        put(home, &format!("{ds}/cursors/w1.json"), "1");
        put(home, &format!("{ds}/summaries/s.json"), "{}");
        put(home, &format!("{ds}/parent-gate/g.json"), r#"{"a":1}"#);
        put(home, &format!("{ds}/parent-gate/r-replies.json"), r#"{"a":{"lastReplyTs":1}}"#);
        put(home, ".anti-hall/settings.json", "{}");
        for d in ["reaped", "drain", "cursors", "summaries"] {
            chmod(home, &format!("{ds}/{d}"), "000");
        }
        chmod(home, &format!("{ds}/parent-gate/g.json"), "000");
        chmod(home, &format!("{ds}/parent-gate/r-replies.json"), "000");
    };
    let r = parity("unreadable", &seed, &once());
    let j: serde_json::Value = serde_json::from_str(&r[0]).unwrap();
    assert_eq!(j["ok"], false, "a sweep that cannot list its directory is a failed row");
    let msg = |id: &str| j["repairs"].as_array().unwrap().iter().find(|x| x["id"] == id).unwrap()["msg"].as_str().unwrap().to_string();
    assert!(msg("sweep-reaped-logs").contains("EACCES: permission denied, scandir '{ROOT}/home/.anti-hall/devswarm/reaped'"), "{}", msg("sweep-reaped-logs"));
    assert!(msg("sweep-drain-markers").contains("could not list"), "{}", msg("sweep-drain-markers"));
}

#[test]
fn the_real_home_is_refused_in_a_test_run() {
    let o = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .args(["migrate", "--json", "--dry-run"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .output()
        .unwrap();
    // refused only when HOME is the passwd home; a CI runner with a different HOME is simply a fixture
    let real = std::env::var("HOME").unwrap_or_default();
    if ah_engine::checks::jsport::home::real_home().is_some_and(|h| h == real) {
        assert_eq!(o.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&o.stdout).contains("refused"));
    }
}

#[test]
fn the_committed_settings_schema_is_the_one_node_ships() {
    let out = Command::new("node").arg(repo().join("ah-engine/parity/gen-migrate-schema.js")).output().expect("node");
    assert!(out.status.success());
    let committed = fs::read_to_string(repo().join("plugins/anti-hall/engine/defaults/migrate_settings.toml")).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), committed, "run `node ah-engine/parity/gen-migrate-schema.js > plugins/anti-hall/engine/defaults/migrate_settings.toml`");
}
