//! Node-vs-engine parity of the two Codex-only helper scripts as verbs (v1.0 lane L16): `codex-limit-status` against
//! `codex/scripts/limit-conserve-status.js`, and `codex-activate` against `codex/scripts/write-activation-sentinel.js`.
//! Each case seeds two scratch homes identically (never the real home, never the real ~/.codex), runs the real Node script
//! on one and the verb on the other, and compares stdout, the exit code and the state files the script keeps.
use crate::common::TempDir;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

/// An ISO time `hours` from now (negative: in the past), millisecond precision.
fn iso(hours: i64) -> String {
    let ms = now_ms() as i64 + hours * 3_600_000;
    let secs = ms / 1000;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil date from days since 1970-01-01 (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let (y, doy) = (yoe + era * 400, doe - (365 * yoe + yoe / 4 - yoe / 100));
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

struct Home(TempDir);

impl Home {
    fn new() -> Home {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Home(TempDir::at(std::env::temp_dir().join(format!("ah-codex-scripts-{}-{n}", std::process::id()))))
    }
    fn path(&self) -> &Path {
        self.0.path()
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
}

struct Run {
    out: String,
    code: i32,
    account: String,
}

fn exec(cmd: &mut Command, home: &Home, env: &[(&str, &str)]) -> Run {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home.path())
        .env("ANTI_HALL_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_DIR", home.path().join("state"))
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(home.path());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let o = cmd.output().unwrap();
    let account = fs::read_to_string(home.path().join(".anti-hall/limit-conserve-account.json")).unwrap_or_default();
    // the cache mtime is a clock value that differs between the two homes
    let account = regex::Regex::new(r"\d{10,}(\.\d+)?").unwrap().replace_all(&account, "N").into_owned();
    Run { out: String::from_utf8_lossy(&o.stdout).into_owned(), code: o.status.code().unwrap_or(-1), account }
}

fn pair(seed: &dyn Fn(&Home), env: &[(&str, &str)]) -> (Run, Run) {
    let (a, b) = (Home::new(), Home::new());
    seed(&a);
    seed(&b);
    let node = exec(Command::new("node").arg(plugin().join("codex/scripts/limit-conserve-status.js")), &a, env);
    let engine = exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-limit-status"), &b, env);
    (node, engine)
}

const CACHE: &str = ".claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json";

fn cache(home: &Home, ts_hours_ago: i64, five: &str, week: &str, sonnet: &str) {
    let ts = now_ms() as i64 - ts_hours_ago * 3_600_000;
    home.put(CACHE, &format!(r#"{{"timestamp":{ts},"data":{{{five}{week}{sonnet}"x":1}}}}"#));
}

fn same(name: &str, seed: &dyn Fn(&Home), env: &[(&str, &str)]) {
    let (n, e) = pair(seed, env);
    assert_eq!(n.code, 0, "{name}: node exit");
    assert_eq!(e.out, n.out, "{name}: stdout");
    assert_eq!(e.code, n.code, "{name}: exit code");
    assert_eq!(e.account, n.account, "{name}: account state file");
}

#[test]
fn limit_status_modes_and_absent_cache() {
    same("auto, no cache", &|_| {}, &[]);
    same("mode on by env", &|_| {}, &[("ANTIHALL_LIMIT_CONSERVE", "on")]);
    same("mode off by env", &|_| {}, &[("ANTIHALL_LIMIT_CONSERVE", "off")]);
    same("mode on by settings.json", &|h| h.put(".anti-hall/settings.json", r#"{"limitConserve":{"mode":"on"}}"#), &[]);
    same("mode off by settings.json", &|h| h.put(".anti-hall/settings.json", r#"{"limitConserve":{"mode":"off"}}"#), &[]);
    same("invalid env mode falls to auto", &|_| {}, &[("ANTIHALL_LIMIT_CONSERVE", "bogus")]);
    same("malformed cache", &|h| h.put(CACHE, "{not json"), &[]);
    same("cache without data", &|h| h.put(CACHE, r#"{"timestamp":1}"#), &[]);
}

#[test]
fn limit_status_buckets_threshold_and_resets() {
    let (f1, f2, f3) = (iso(2), iso(30), iso(100));
    let r = |k: &str, v: &str| format!(r#""{k}":{v},"#);
    same(
        "all three tripped, earliest reset",
        &|h| {
            cache(
                h,
                0,
                &(r("fiveHourPercent", "90") + &r("fiveHourResetsAt", &format!("\"{f1}\""))),
                &(r("weeklyPercent", "88") + &r("weeklyResetsAt", &format!("\"{f2}\""))),
                &(r("sonnetWeeklyPercent", "99") + &r("sonnetWeeklyResetsAt", &format!("\"{f3}\""))),
            )
        },
        &[],
    );
    same("below threshold", &|h| cache(h, 0, &r("fiveHourPercent", "10"), &r("weeklyPercent", "20"), ""), &[]);
    same("threshold by env", &|h| cache(h, 0, &r("fiveHourPercent", "50"), "", ""), &[("ANTIHALL_LIMIT_THRESHOLD", "40")]);
    same("threshold out of range is ignored", &|h| cache(h, 0, &r("fiveHourPercent", "90"), "", ""), &[("ANTIHALL_LIMIT_THRESHOLD", "0")]);
    let past = iso(-3);
    same(
        "a reset in the past clears the bucket",
        &|h| cache(h, 0, &(r("fiveHourPercent", "95") + &r("fiveHourResetsAt", &format!("\"{past}\""))), "", ""),
        &[],
    );
    same("stale snapshot, no reset time, still evaluated", &|h| cache(h, 1, &r("weeklyPercent", "95"), "", ""), &[]);
    same("snapshot older than the age bound, no reset time", &|h| cache(h, 7, &r("weeklyPercent", "95"), "", ""), &[]);
    same("unparseable reset time", &|h| cache(h, 0, &(r("fiveHourPercent", "95") + &r("fiveHourResetsAt", "\"not a date\"")), "", ""), &[]);
    same("non-numeric percent", &|h| cache(h, 0, &r("fiveHourPercent", "\"95\""), "", ""), &[]);
}

#[test]
fn limit_status_account_switch_guard() {
    let tripped = |h: &Home| cache(h, 0, r#""fiveHourPercent":95,"#, "", "");
    same(
        "first sight of the account records it",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u1"}"#);
        },
        &[],
    );
    same(
        "switch with an unrefreshed cache is inactive",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u2"}"#);
            h.put(".anti-hall/limit-conserve-account.json", r#"{"userID":"u1","usageCacheMtime":99999999999999}"#);
        },
        &[],
    );
    same(
        "switch with a refreshed cache is trusted and recorded",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u2"}"#);
            h.put(".anti-hall/limit-conserve-account.json", r#"{"userID":"u1","usageCacheMtime":1}"#);
        },
        &[],
    );
    same(
        "same account keeps the mtime current",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u1"}"#);
            h.put(".anti-hall/limit-conserve-account.json", r#"{"userID":"u1","usageCacheMtime":1}"#);
        },
        &[],
    );
    same(
        "guard switched off",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u2"}"#);
            h.put(".anti-hall/limit-conserve-account.json", r#"{"userID":"u1","usageCacheMtime":99999999999999}"#);
        },
        &[("ANTIHALL_LIMIT_ACCOUNT_CHECK", "off")],
    );
    same(
        "unreadable account state",
        &|h| {
            tripped(h);
            h.put(".claude.json", r#"{"userID":"u2"}"#);
            h.put(".anti-hall/limit-conserve-account.json", "{oops");
        },
        &[],
    );
}

#[test]
fn activate_writes_the_same_marker() {
    let marker = |run: &dyn Fn(&Home) -> Run| {
        let h = Home::new();
        let r = run(&h);
        assert_eq!(r.code, 0);
        let text = fs::read_to_string(h.path().join(".anti-hall/codex-activated.json")).unwrap();
        regex::Regex::new(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z")
            .unwrap()
            .replace_all(&text, "TS")
            .replace(&*h.path().canonicalize().unwrap().to_string_lossy(), "CWD")
            .replace(&*h.path().to_string_lossy(), "CWD")
    };
    let node = marker(&|h| exec(Command::new("node").arg(plugin().join("codex/scripts/write-activation-sentinel.js")), h, &[]));
    let engine = marker(&|h| exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-activate"), h, &[]));
    assert_eq!(engine, node);
    assert!(engine.contains("\"scope\": \"CWD\"") && engine.ends_with("}\n"), "{engine}");
}

#[test]
fn activate_overwrites_an_older_marker_and_creates_the_directory() {
    let h = Home::new();
    h.put(".anti-hall/codex-activated.json", "old");
    assert_eq!(exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-activate"), &h, &[]).code, 0);
    assert!(fs::read_to_string(h.path().join(".anti-hall/codex-activated.json")).unwrap().contains("activatedAt"));
    let fresh = Home::new();
    assert_eq!(exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-activate"), &fresh, &[]).code, 0);
    assert!(fresh.path().join(".anti-hall/codex-activated.json").is_file());
}
