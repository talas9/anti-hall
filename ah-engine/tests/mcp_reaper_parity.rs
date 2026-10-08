//! Node-vs-engine parity for the SessionEnd MCP sweep (`session-end-mcp-reaper`).
//!
//! The sweep is destructive, so this suite proves the engine selects exactly the processes the Node hook selects, and never
//! more. Each case runs the real Node hook and `ah-engine check session-end-mcp-reaper` on the same payload, each with its own
//! isolated home (never the real one) and its own directory of FAKE `ps` and `launchctl` programs placed first on `PATH`, and
//! compares the exit code, the output, the audit log and the whole state of the home, and also the exact commands each side ran
//! (the fakes record their arguments). The fake process tables name pids far above any real pid limit, so a signal sent to one
//! reaches nothing; the one test that does signal real processes (`the_engine_really_signals_what_it_selects`) signals only
//! children it spawned itself. A case marked `defer` is one the engine must hand to Node (`AHFALLBACK`), leaving the home as
//! seeded.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static SERIAL: Mutex<()> = Mutex::new(());
static ID: AtomicUsize = AtomicUsize::new(0);
const FALLBACK: &str = "AHFALLBACK\n";
/// Pids of the fake tables: above every real pid limit (Linux caps at 2^22), so a signal reaches nothing.
const BASE: u32 = 5_000_000;

#[derive(Clone)]
struct Case {
    name: String,
    payload: Value,
    /// The successive answers of the process listing; the last one repeats. `None` makes that call fail.
    ps: Vec<Option<String>>,
    etimes: Option<String>,
    lstart: Option<String>,
    launchctl: Option<String>,
    env: Vec<(String, String)>,
    files: Vec<(String, String)>,
    defer: bool,
}

fn row(pid: u32, ppid: u32, cmd: &str) -> String {
    format!("{:>7} {:>7} {cmd}", BASE + pid, if ppid == 1 { 1 } else { BASE + ppid })
}

fn init() -> String {
    "      1       0 /sbin/launchd".to_string()
}

fn table(rows: &[String]) -> Option<String> {
    Some(format!("{}\n", rows.join("\n")))
}

fn ages(pairs: &[(u32, u64)]) -> Option<String> {
    Some(pairs.iter().map(|(p, a)| format!("{:>7} {a}", BASE + p)).collect::<Vec<_>>().join("\n") + "\n")
}

/// The text `ps -o lstart=` prints for the instant `secs_ago` before now, in local time.
fn lstart_at(secs_ago: i64) -> String {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as libc::time_t - secs_ago as libc::time_t;
    // SAFETY: a zeroed `tm` is a valid C struct value; localtime_r fills it from a live time_t.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers refer to live locals.
    unsafe { libc::localtime_r(&t, &mut tm) };
    let wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][tm.tm_wday as usize];
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][tm.tm_mon as usize];
    format!("{wd} {mon} {:>2} {:02}:{:02}:{:02} {}", tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, tm.tm_year + 1900)
}

fn starts(pairs: &[(u32, i64)]) -> Option<String> {
    Some(pairs.iter().map(|(p, a)| format!("{:>7} {}", BASE + p, lstart_at(*a))).collect::<Vec<_>>().join("\n") + "\n")
}

fn case(name: &str, rows: Vec<String>) -> Case {
    Case {
        name: name.into(),
        payload: json!({"hook_event_name":"SessionEnd","reason":"prompt_input_exit","session_id":"s1"}),
        ps: vec![table(&rows)],
        etimes: None,
        lstart: None,
        launchctl: Some("PID\tStatus\tLabel\n-\t0\tcom.example.other\n".into()),
        env: Vec::new(),
        files: Vec::new(),
        defer: false,
    }
}

impl Case {
    fn old(mut self, pairs: &[(u32, u64)]) -> Case {
        self.etimes = ages(pairs);
        self
    }
    fn reason(mut self, r: Value) -> Case {
        self.payload = json!({"hook_event_name":"SessionEnd","reason":r});
        self
    }
    fn payload(mut self, p: Value) -> Case {
        self.payload = p;
        self
    }
    fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    fn file(mut self, rel: &str, body: &str) -> Case {
        self.files.push((rel.into(), body.into()));
        self
    }
    fn then(mut self, second: Option<String>) -> Case {
        self.ps.push(second);
        self
    }
    fn defer(mut self) -> Case {
        self.defer = true;
        self
    }
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap().join("plugins/anti-hall")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-reaper-{tag}-{}-{}", std::process::id(), ID.fetch_add(1, Ordering::Relaxed)));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover of an earlier run of this test
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

/// The fake `ps` and `launchctl`: they answer from files in `dir` and record every invocation's arguments in `dir/calls`.
fn install_fakes(dir: &Path, c: &Case) {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let d = dir.to_string_lossy();
    let script = |name: &str, body: String| {
        let p = bin.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    script(
        "ps",
        format!(
            "#!/bin/sh\necho \"ps $*\" >> '{d}/calls'\ncase \"$*\" in\n  *etimes*) [ -f '{d}/etimes' ] && cat '{d}/etimes' && exit 0; exit 1 ;;\n  *lstart*) [ -f '{d}/lstart' ] && cat '{d}/lstart' && exit 0; exit 1 ;;\nesac\nn=$(cat '{d}/n' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{d}/n'\nf='{d}/ps.'$n\n[ -f \"$f\" ] || f=$(ls '{d}'/ps.[0-9]* | sort -t. -k2 -n | tail -1)\n[ -f \"$f\" ] && [ ! -f \"$f.fail\" ] && cat \"$f\" && exit 0\nexit 1\n"
        ),
    );
    script("launchctl", format!("#!/bin/sh\necho \"launchctl $*\" >> '{d}/calls'\n[ -f '{d}/launchctl' ] && cat '{d}/launchctl' && exit 0\nexit 1\n"));
    for (i, ps) in c.ps.iter().enumerate() {
        match ps {
            Some(t) => std::fs::write(dir.join(format!("ps.{}", i + 1)), t).unwrap(),
            None => {
                std::fs::write(dir.join(format!("ps.{}", i + 1)), "").unwrap();
                std::fs::write(dir.join(format!("ps.{}.fail", i + 1)), "").unwrap();
            }
        }
    }
    for (name, body) in [("etimes", &c.etimes), ("lstart", &c.lstart), ("launchctl", &c.launchctl)] {
        if let Some(b) = body {
            std::fs::write(dir.join(name), b).unwrap();
        }
    }
}

fn seed_home(home: &Path, c: &Case) {
    for (rel, body) in &c.files {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
}

fn norm(s: &str, now: u128) -> String {
    let iso = regex::Regex::new(r#""ts":"\d{4}-\d\d-\d\dT[\d:.]+Z""#).unwrap();
    let s = iso.replace_all(s, "\"ts\":\"<TS>\"").to_string();
    let b = s.as_bytes();
    let (mut out, mut i) = (String::new(), 0);
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let j = (i..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
            let run = &s[i..j];
            out.push_str(&if run.len() == 13 && run.parse::<u128>().is_ok_and(|n| n.abs_diff(now) < 60_000) { "<NOW>".to_string() } else { run.to_string() });
            i = j;
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn snapshot(home: &Path, now: u128) -> BTreeMap<String, String> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>, now: u128) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
            if rel == "engine-state" {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                out.insert(format!("{rel}/"), String::new());
                walk(&p, root, out, now);
            } else {
                out.insert(rel, norm(&String::from_utf8_lossy(&std::fs::read(&p).unwrap()), now));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out, now);
    out
}

type Out = (i32, Vec<u8>, Vec<u8>);

fn run(mut cmd: Command, input: &[u8]) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let w = std::thread::spawn(move || ah_engine::discard::harmless(stdin.write_all(&data))); // keep: the child may exit before reading
    let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(so.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(se.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let deadline = Instant::now() + Duration::from_secs(40);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 40 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(3));
    };
    ah_engine::discard::harmless(w.join()); // keep: the writer only feeds stdin
    (status.code().unwrap_or(-1), ro.join().unwrap(), re.join().unwrap())
}

fn base_env(c: &mut Command, home: &Path, fakes: &Path, case: &Case) {
    let path = format!("{}:{}", fakes.join("bin").display(), std::env::var("PATH").unwrap_or_default());
    c.env_clear().env("PATH", path).env("HOME", home).env("USERPROFILE", home).env("ANTIHALL_TEST_ISOLATION", "1").env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in &case.env {
        c.env(k, v);
    }
}

fn run_node(home: &Path, fakes: &Path, case: &Case, input: &[u8]) -> Out {
    let mut c = Command::new("node");
    c.arg(plugin().join("hooks/session-end-mcp-reaper.js")).current_dir(std::env::temp_dir());
    base_env(&mut c, home, fakes, case);
    run(c, input)
}

fn run_engine(home: &Path, fakes: &Path, case: &Case, input: &[u8]) -> Out {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg("session-end-mcp-reaper").current_dir(std::env::temp_dir());
    base_env(&mut c, home, fakes, case);
    c.env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", plugin());
    run(c, input)
}

fn calls(fakes: &Path) -> String {
    std::fs::read_to_string(fakes.join("calls")).unwrap_or_default().replace(&fakes.to_string_lossy().to_string(), "<F>")
}

struct Tally {
    same: usize,
    deferred: usize,
    logged: usize,
    killed: usize,
}

fn drive(name: &str, cases: Vec<Case>) -> Tally {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut t = Tally { same: 0, deferred: 0, logged: 0, killed: 0 };
    let mut names = std::collections::BTreeSet::new();
    for case in &cases {
        assert!(names.insert(case.name.clone()), "{name}: duplicate case {}", case.name);
        let now = now_ms();
        let (hn, he) = (scratch(&format!("{name}-hn")), scratch(&format!("{name}-he")));
        let (fnode, feng) = (scratch(&format!("{name}-fn")), scratch(&format!("{name}-fe")));
        for (h, f) in [(&hn, &fnode), (&he, &feng)] {
            seed_home(h, case);
            install_fakes(f, case);
        }
        let seeded = snapshot(&he, now);
        let input = case.payload.to_string().into_bytes();
        let node = run_node(&hn, &fnode, case, &input);
        let eng = run_engine(&he, &feng, case, &input);
        let (after_n, after_e) = (snapshot(&hn, now), snapshot(&he, now));
        let ctx = |what: &str| {
            format!(
                "{name}/{}: {what}\n node: {:?}\n  eng: {:?}\n node calls: {:?}\n  eng calls: {:?}\n node home: {after_n:?}\n  eng home: {after_e:?}",
                case.name,
                (node.0, String::from_utf8_lossy(&node.1), String::from_utf8_lossy(&node.2)),
                (eng.0, String::from_utf8_lossy(&eng.1), String::from_utf8_lossy(&eng.2)),
                calls(&fnode),
                calls(&feng)
            )
        };
        if case.defer {
            assert_eq!(
                (eng.0, String::from_utf8_lossy(&eng.1).to_string(), eng.2.clone()),
                (0, FALLBACK.to_string(), Vec::new()),
                "{}",
                ctx("the engine must defer")
            );
            assert_eq!(after_e, seeded, "{}", ctx("a deferral must leave the home as seeded"));
            t.deferred += 1;
        } else {
            assert_ne!(String::from_utf8_lossy(&eng.1), FALLBACK, "{}", ctx("the engine deferred but this case expects an answer"));
            assert_eq!((eng.0, &eng.1, &eng.2), (node.0, &node.1, &node.2), "{}", ctx("exit code and output"));
            assert_eq!(after_e, after_n, "{}", ctx("the home (audit log included)"));
            assert_eq!(calls(&feng), calls(&fnode), "{}", ctx("the commands run"));
            t.same += 1;
            if after_n != seeded {
                t.logged += 1;
            }
            if after_n.values().any(|v| v.contains("\"action\":\"kill\"")) {
                t.killed += 1;
            }
        }
    }
    eprintln!("{name}: same={} deferred={} logged={} with-kill={}", t.same, t.deferred, t.logged, t.killed);
    t
}

const MCP: &str = "node /srv/mcp-server.js";

fn cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    let two = || vec![init(), row(1, 1, MCP), row(2, 1, "node /opt/other/mcp-server.js --stdio")];
    // nothing to reap
    v.push(case("no-orphans", vec![init(), row(1, 77, MCP), row(2, 1, "/usr/bin/zsh"), row(3, 1, "vim mcp-server.js")]));
    v.push(case("empty-listing", vec![]));
    v.push(case("blank-lines-only", vec![String::new(), "   ".into()]));
    // the full sweep: term, wait, re-check, kill
    v.push(case("two-orphans-etimes", two()).old(&[(1, 3600), (2, 7200)]));
    v.push(case("recycled-pid-spared", two()).old(&[(1, 3600), (2, 3600)]).then(table(&[init(), row(1, 1, MCP), row(2, 1, "bash")])));
    v.push(case("gone-after-term", two()).old(&[(1, 3600), (2, 3600)]).then(table(&[init()])));
    v.push(case("recheck-listing-fails", two()).old(&[(1, 3600), (2, 3600)]).then(None));
    v.push(case("recheck-loses-init-but-keeps-orphans", two()).old(&[(1, 3600), (2, 3600)]).then(table(&[row(1, 1, MCP), row(2, 1, MCP)])));
    v.push(case("recheck-reparented-away", two()).old(&[(1, 3600), (2, 3600)]).then(table(&[init(), row(1, 9, MCP), row(2, 1, MCP)])));
    v.push(case("first-listing-fails", two()).old(&[(1, 3600)]).then(None));
    // age
    v.push(case("age-below-floor", two()).old(&[(1, 59), (2, 59)]));
    v.push(case("age-at-floor", two()).old(&[(1, 60), (2, 59)]));
    v.push(case("age-unknown-skipped", two()).old(&[(1, 3600)]));
    v.push(case("age-probe-malformed", two()).payload(json!({"reason":"other"})).old(&[]));
    v.push(case("age-floor-env-low", two()).old(&[(1, 30), (2, 30)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "30"));
    v.push(case("age-floor-env-empty-is-zero", two()).old(&[(1, 5), (2, 5)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", ""));
    v.push(case("age-floor-env-garbage", two()).old(&[(1, 30), (2, 30)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "soon"));
    v.push(case("age-floor-env-negative", two()).old(&[(1, 30), (2, 30)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "-1"));
    v.push(case("age-floor-env-hex", two()).old(&[(1, 30), (2, 30)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0x10"));
    v.push(case("age-floor-env-fraction", two()).old(&[(1, 60), (2, 60)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "60.9"));
    v.push(case("age-floor-env-infinity", two()).old(&[(1, 600000), (2, 600000)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "Infinity"));
    v.push(case("age-floor-env-padded", two()).old(&[(1, 30), (2, 30)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", " 30 "));
    v.push(case("age-floor-env-exponent", two()).old(&[(1, 120), (2, 120)]).env("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "1e2"));
    // cap
    v.push(case("cap-one", two()).old(&[(1, 3600), (2, 3600)]).env("ANTI_HALL_SESSION_END_REAPER_MAX", "1"));
    v.push(case("cap-zero", two()).old(&[(1, 3600), (2, 3600)]).env("ANTI_HALL_SESSION_END_REAPER_MAX", "0"));
    v.push(case("cap-fraction", two()).old(&[(1, 3600), (2, 3600)]).env("ANTI_HALL_SESSION_END_REAPER_MAX", "1.9"));
    v.push(case("cap-garbage-default", two()).old(&[(1, 3600), (2, 3600)]).env("ANTI_HALL_SESSION_END_REAPER_MAX", "many"));
    v.push(case("cap-empty-is-zero", two()).old(&[(1, 3600), (2, 3600)]).env("ANTI_HALL_SESSION_END_REAPER_MAX", ""));
    let mut many = vec![init()];
    many.extend((1..=20).map(|i| row(i, 1, MCP)));
    let all20: Vec<(u32, u64)> = (1..=20).map(|i| (i, 3600)).collect();
    v.push(case("cap-default-sixteen", many.clone()).old(&all20));
    v.push(case("cap-env-three", many).old(&all20).env("ANTI_HALL_SESSION_END_REAPER_MAX", "3"));
    // PID 1
    v.push(case("pid1-container-entrypoint", vec![row_raw(1, 0, "python /app/serve.py"), row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-missing", vec![row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-systemd", vec![row_raw(1, 0, "/usr/lib/systemd/systemd --system --deserialize 30"), row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-init-path", vec![row_raw(1, 0, "/sbin/init splash"), row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-lookalike", vec![row_raw(1, 0, "/sbin/initd"), row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-empty-command", vec![row_raw(1, 0, ""), row(1, 1, MCP)]).old(&[(1, 3600)]));
    v.push(case("pid1-duplicate-first-wins", vec![row_raw(1, 0, "python x"), row_raw(1, 0, "/sbin/launchd"), row(1, 1, MCP)]).old(&[(1, 3600)]));
    // reasons
    for (n, r) in [
        ("clear", json!("clear")),
        ("resume", json!("resume")),
        ("logout", json!("logout")),
        ("other", json!("other")),
        ("empty", json!("")),
        ("number", json!(5)),
        ("null", Value::Null),
        ("upper", json!("OTHER")),
    ] {
        v.push(case(&format!("reason-{n}"), two()).old(&[(1, 3600), (2, 3600)]).reason(r));
    }
    v.push(case("reason-end-reason-fallback", two()).old(&[(1, 3600)]).payload(json!({"end_reason":"other"})));
    v.push(case("reason-reason-wins-over-end-reason", two()).old(&[(1, 3600)]).payload(json!({"reason":"clear","end_reason":"other"})));
    v.push(case("reason-non-string-falls-to-end-reason", two()).old(&[(1, 3600)]).payload(json!({"reason":5,"end_reason":"other"})));
    for (n, p) in [("array", json!([1])), ("string", json!("other")), ("number", json!(1)), ("null", Value::Null), ("empty-object", json!({}))] {
        v.push(case(&format!("payload-{n}"), two()).old(&[(1, 3600)]).payload(p));
    }
    // the switch
    v.push(case("switch-env-zero", two()).old(&[(1, 3600)]).env("ANTIHALL_SESSION_END_REAPER", "0"));
    v.push(case("switch-env-off", two()).old(&[(1, 3600)]).env("ANTIHALL_SESSION_END_REAPER", "off"));
    v.push(case("switch-env-alias-false", two()).old(&[(1, 3600)]).env("ANTI_HALL_SESSION_END_REAPER", "false"));
    v.push(case("switch-env-canonical-beats-alias", two()).old(&[(1, 3600)]).env("ANTIHALL_SESSION_END_REAPER", "1").env("ANTI_HALL_SESSION_END_REAPER", "0"));
    v.push(case("switch-env-junk-ignored", two()).old(&[(1, 3600)]).env("ANTIHALL_SESSION_END_REAPER", "banana"));
    v.push(case("switch-file-false", two()).old(&[(1, 3600)]).file(".anti-hall/settings.json", r#"{"maintenance":{"sessionEndReaper":false}}"#));
    v.push(
        case("switch-file-true-env-false", two())
            .old(&[(1, 3600)])
            .file(".anti-hall/settings.json", r#"{"maintenance":{"sessionEndReaper":true}}"#)
            .env("ANTIHALL_SESSION_END_REAPER", "0"),
    );
    v.push(case("switch-file-corrupt", two()).old(&[(1, 3600)]).file(".anti-hall/settings.json", "{oops"));
    v.push(case("switch-option-false", two()).old(&[(1, 3600)]).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_SESSION_END_REAPER", "false"));
    v.push(case("switch-option-default-masked", two()).old(&[(1, 3600)]).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_SESSION_END_REAPER", "true"));
    // user patterns
    v.push(
        case("user-match-adds", vec![init(), row(1, 1, "bash /opt/my-tool.sh"), row(2, 1, "bash /opt/other.sh")])
            .old(&[(1, 3600), (2, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "my-tool\\.sh"),
    );
    v.push(case("user-match-case-insensitive", vec![init(), row(1, 1, "bash /opt/MY-TOOL.sh")]).old(&[(1, 3600)]).env("ANTIHALL_REAPER_MATCH", "my-tool"));
    v.push(
        case("user-match-file", vec![init(), row(1, 1, "bash /opt/my-tool.sh")])
            .old(&[(1, 3600)])
            .file(".anti-hall/settings.json", r#"{"guards":{"reaperMatch":"my-tool"}}"#),
    );
    v.push(
        case("user-match-file-number", vec![init(), row(1, 1, "bash /opt/tool 4242")])
            .old(&[(1, 3600)])
            .file(".anti-hall/settings.json", r#"{"guards":{"reaperMatch":4242}}"#),
    );
    v.push(
        case("user-match-file-blank-falls-through", vec![init(), row(1, 1, "bash /opt/my-tool.sh")])
            .old(&[(1, 3600)])
            .file(".anti-hall/settings.json", r#"{"guards":{"reaperMatch":"   "}}"#),
    );
    v.push(
        case("user-match-env-beats-file", vec![init(), row(1, 1, "bash /opt/a.sh"), row(2, 1, "bash /opt/b.sh")])
            .old(&[(1, 3600), (2, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "a\\.sh")
            .file(".anti-hall/settings.json", r#"{"guards":{"reaperMatch":"b\\.sh"}}"#),
    );
    v.push(
        case("user-match-alternation-and-class", vec![init(), row(1, 1, "bash /opt/job-12.sh"), row(2, 1, "bash /opt/job-x.sh"), row(3, 1, "sh job_7")])
            .old(&[(1, 3600), (2, 3600), (3, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "job[-_]\\d+|nomatch"),
    );
    v.push(
        case("user-match-anchored", vec![init(), row(1, 1, "toolx run"), row(2, 1, "run toolx")])
            .old(&[(1, 3600), (2, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "^\\s*\\d+\\s+\\d+\\s+toolx"),
    );
    v.push(
        case("user-match-does-not-reach-reaper-tooling", vec![init(), row(1, 1, "node /x/mcp-reaper.js --tool")])
            .old(&[(1, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "tool"),
    );
    v.push(
        case("user-match-invalid-ignored-by-node-engine-defers", vec![init(), row(1, 1, MCP)])
            .old(&[(1, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "(unclosed")
            .defer(),
    );
    v.push(case("user-match-lookahead-defers", vec![init(), row(1, 1, "bash /opt/x")]).old(&[(1, 3600)]).env("ANTIHALL_REAPER_MATCH", "x(?=$)").defer());
    v.push(case("user-match-brace-quantifier-defers", vec![init(), row(1, 1, "bash /opt/xx")]).old(&[(1, 3600)]).env("ANTIHALL_REAPER_MATCH", "x{2}").defer());
    v.push(
        case("user-match-non-ascii-defers", vec![init(), row(1, 1, "bash /opt/caf\u{e9}")]).old(&[(1, 3600)]).env("ANTIHALL_REAPER_MATCH", "caf\u{e9}").defer(),
    );
    v.push(case("user-match-backref-defers", vec![init(), row(1, 1, "bash /opt/abab")]).old(&[(1, 3600)]).env("ANTIHALL_REAPER_MATCH", "(ab)\\1").defer());
    v.push(case("user-exclude", two()).old(&[(1, 3600), (2, 3600)]).env("ANTIHALL_REAPER_EXCLUDE", "OTHER"));
    v.push(case("user-exclude-file", two()).old(&[(1, 3600), (2, 3600)]).file(".anti-hall/settings.json", r#"{"guards":{"reaperExclude":"/srv/"}}"#));
    v.push(
        case("user-exclude-beats-user-match", vec![init(), row(1, 1, "bash /opt/my-tool.sh")])
            .old(&[(1, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "my-tool")
            .env("ANTIHALL_REAPER_EXCLUDE", "opt"),
    );
    v.push(case("user-exclude-lookahead-defers", two()).old(&[(1, 3600)]).env("ANTIHALL_REAPER_EXCLUDE", "(?!x)").defer());
    v.push(
        case("user-pattern-unsupported-but-pid1-gate-first", vec![row_raw(1, 0, "python x"), row(1, 1, MCP)])
            .old(&[(1, 3600)])
            .env("ANTIHALL_REAPER_MATCH", "(?=x)"),
    );
    // the age probe's fallback and the start-time forms
    v.push(case("lstart-fallback", two()).lstart_only(&[(1, 3600), (2, 7200)]));
    v.push(case("lstart-below-floor", two()).lstart_only(&[(1, 10), (2, 10)]));
    v.push(case("lstart-future-start-unknown", two()).lstart_only(&[(1, -3600), (2, 3600)]));
    v.push(case("lstart-partial-after-etimes", two()).old(&[(1, 3600)]).with_lstart(&[(2, 3600)]));
    v.push(case("lstart-probe-fails", two()));
    v.push(case("lstart-with-zone-name-defers", two()).raw_lstart("     1 Mon Jan  5 03:04:05 CET 2026\n").defer_pids());
    v.push(case("lstart-iso-form-defers", two()).raw_lstart("     1 2026-01-05 03:04:05\n").defer_pids());
    v.push(case("lstart-impossible-day-defers", two()).raw_lstart("     1 Mon Feb 30 03:04:05 2026\n").defer_pids());
    v.push(case("lstart-hour-24-defers", two()).raw_lstart("     1 Mon Jan  5 24:00:00 2026\n").defer_pids());
    v.push(case("lstart-garbage-line-is-ignored-by-both", two()).raw_lstart("not a pid line\n"));
    // the one-shot CLI is its own daemon, so a request zone equals the process zone and the engine answers in that zone
    v.push(case("lstart-explicit-zone-same-process", two()).lstart_only(&[(1, 3600), (2, 3600)]).env("TZ", "Asia/Dubai"));
    v.push(case("lstart-explicit-zone-far-from-local", two()).lstart_only(&[(1, 3600), (2, 3600)]).env("TZ", "Pacific/Kiritimati"));
    // the service manager (Node consults it on macOS only; the fake answers either way)
    v.push(
        case("managed-by-launchd", two()).old(&[(1, 3600), (2, 3600)]).launchctl(&format!("PID\tStatus\tLabel\n{}\t0\tcom.example.mcp\n-\t0\tx\n", BASE + 1)),
    );
    v.push(case("launchctl-fails-keeps-everything", two()).old(&[(1, 3600), (2, 3600)]).no_launchctl());
    v.push(case("launchctl-no-header", two()).old(&[(1, 3600), (2, 3600)]).launchctl(&format!("{}\t0\ta\n{}\t0\tb\n", BASE + 1, BASE + 2)));
    v.push(case("launchctl-zero-and-garbage-rows", two()).old(&[(1, 3600), (2, 3600)]).launchctl("PID Status Label\n0\t0\ta\nabc\t0\tb\n  \n-\t0\tc\n"));
    // log file handling
    v.push(case("log-appended-to-existing", two()).old(&[(1, 3600)]).file(".anti-hall/logs/session-end-reaper.log", "{\"old\":true}\n"));
    v.push(case("log-dir-is-a-file", two()).old(&[(1, 3600)]).file(".anti-hall/logs", "i am a file"));
    v.push(case("log-over-bound", vec![init()]).file(".anti-hall/logs/session-end-reaper.log", &"x".repeat(5 * 1024 * 1024 + 1)));
    v.push(case("log-exactly-at-bound", vec![init()]).file(".anti-hall/logs/session-end-reaper.log", &"x".repeat(5 * 1024 * 1024)));
    // lines the listing parser reads or ignores
    v.push(
        case(
            "ps-odd-lines",
            vec![
                init(),
                format!("{}\r", row(1, 1, MCP)),
                "garbage".into(),
                row(2, 1, MCP) + "   ",
                format!("{:>7} {:>7}", BASE + 3, 1),
                format!("  {} 1 node /s/mcp-server.js", BASE + 4),
                format!("\t{}\t1\tnode /t/mcp-server.js", BASE + 5),
                format!("{} 1 node\u{a0}/u/mcp-server.js", BASE + 6),
            ],
        )
        .old(&[(1, 3600), (2, 3600), (3, 3600), (4, 3600), (5, 3600), (6, 3600)]),
    );
    v.push(case("ps-leading-zero-pids", vec![init(), format!("{:0>9} 000001 {MCP}", BASE + 1)]).old(&[(1, 3600)]));
    v.push(case("ps-huge-pid-defers", vec![init(), format!("99999999999999999999 1 {MCP}")]).raw_etimes("99999999999999999999 3600\n").defer());
    v.push(case("ps-duplicate-pids", vec![init(), row(1, 1, MCP), row(1, 1, "node /dup/mcp-server.js")]).old(&[(1, 3600)]));
    v.push(
        case(
            "ps-unicode-and-tabs-in-commands",
            vec![init(), row(1, 1, "node /srv/mcp-server.js --name=\u{65e5}\u{672c}\t\"quoted\" \\ back"), row(2, 1, "node /srv/\u{1f600}/mcp-server.js")],
        )
        .old(&[(1, 3600), (2, 3600)]),
    );
    // the signature corpus: every row is an orphan of PID 1, old enough; the log lists exactly the ones both sides select
    let cmds = [
        "node /x/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js /tmp",
        "npx -y @modelcontextprotocol/server-memory",
        "node /srv/mcp-server.js",
        "node mcp-server",
        "nodejs /a/MCP-SERVER.js",
        "npm exec mcp-server-time",
        "pnpm dlx mcp-server-x",
        "yarn dlx server-sequential-thinking",
        "deno run -A npm:mcp-server-y",
        "bun x mcp_server_z",
        "python -m mcp_server_time",
        "python3 -m mcp_server_fetch --opt",
        "uvx mcp-server-fetch",
        "uv run mcp_server_git",
        "/usr/local/bin/mcp-server-everything --stdio",
        "mcp-server-sqlite --db x",
        "server-sequential-thinking",
        "/opt/server-sequential-thinking/bin/run",
        "node /a/mcp start",
        "node /a/mcp  start --x",
        "mcp start",
        "python /a/mcp start",
        "node /x/node_modules/playwright-mcp/dist/cli.js",
        "node /x/node_modules/chrome-devtools-mcp/build/index.js --headless",
        "npx @playwright/mcp@latest",
        "npx @scope/mcp",
        "npx @scope/mcp-extra",
        "/opt/bin/playwright-mcp --port 1",
        "playwright-mcp",
        "/usr/bin/mcp --serve",
        "node /x/foo-mcp",
        "node /x/foo-mcp/",
        "node /x/foo-mcp bar",
        "node /x/foo-mcpx",
        "node foo-mcp.js",
        "node build-mcp-server.js",
        "node xmcp-server.js",
        "vim mcp-server.js",
        "tail -f /var/log/mcp-server.log",
        "grep mcp-server /etc/hosts",
        "less ~/notes/mcp start.md",
        "python train.py --mcp --stdio",
        "bash -c 'node /x/mcp-server.js'",
        "sh -c exec node /x/mcp-server.js",
        "node /x/mcp-reaper.js",
        "node /x/modelcontextprotocol-mcp-reaper.js",
        "node /a/@modelcontextprotocol",
        "node /a/modelcontextprotocolx",
        "node /a/xmodelcontextprotocol/x.js",
        "node /w/vitest.mjs run mcp-server.test.ts",
        "node /w/node_modules/.bin/jest --runInBand mcp-server",
        "node /w/jest-worker/processChild.js mcp-server",
        "node /w/node_modules/playwright/cli.js test mcp-server",
        "ts-node /w/mcp-server.ts",
        "node /w/tsx/cli.mjs mcp-server.ts",
        "node /w/node_modules/.bin/next dev mcp-server",
        "node /w/next-server mcp-server",
        "node /w/next start mcp-server",
        "node /w/webpack serve mcp-server",
        "node /w/webpack-dev-server mcp-server",
        "node /w/webpack build mcp-server",
        "node C:\\w\\vitest\\mcp-server.js",
        "node /w/jestmcp-server.js",
        "/Applications/Tool.app/Contents/MacOS/tool --mcp-server",
        "  node   /pad/mcp-server.js  ",
        "NODE /upper/mcp-server.js",
        "node\t/tab/mcp-server.js",
        "node /x/mcp-server.js\u{2028}tail",
        "node /x/MCP_SERVER.js",
        "python3 -m mcp_server",
        "/usr/bin/env node /e/mcp-server.js",
        "/usr/bin/node /x/server-sequential-thinking.js",
        "/usr/local/bin/node --inspect /x/mcp-server.js",
        "node --max-old-space-size=4096 /x/node_modules/.bin/mcp-server-foo",
        "node /x/a-b.c_d-mcp",
        "node /x/-mcp",
        "node /x/9-mcp",
        "node @scope/mcp",
        "node a @s/mcp",
        "node /@s/mcp",
        "uvx --from git+https://example.com/x.git mcp-server-q",
        "npx -y tavily-mcp@0.1.4",
        "npx -y @upstash/context7-mcp",
        "docker run -i --rm mcp/everything",
        "docker run mcp-server",
    ];
    let mut rows = vec![init()];
    rows.extend(cmds.iter().enumerate().map(|(i, c)| row(i as u32 + 1, 1, c)));
    let ages_all: Vec<(u32, u64)> = (1..=cmds.len() as u32).map(|i| (i, 3600)).collect();
    v.push(case("signature-corpus", rows.clone()).old(&ages_all).env("ANTI_HALL_SESSION_END_REAPER_MAX", "1000"));
    v.push(
        case("signature-corpus-with-user-pattern", rows)
            .old(&ages_all)
            .env("ANTI_HALL_SESSION_END_REAPER_MAX", "1000")
            .env("ANTIHALL_REAPER_MATCH", "docker\\s+run")
            .env("ANTIHALL_REAPER_EXCLUDE", "playwright|\\bnpm\\b"),
    );
    v
}

fn row_raw(pid: u32, ppid: u32, cmd: &str) -> String {
    format!("{:>7} {:>7} {cmd}", pid, ppid)
}

impl Case {
    /// Only the start-time probe answers (the elapsed-seconds probe fails, as it does on macOS).
    fn lstart_only(mut self, pairs: &[(u32, i64)]) -> Case {
        self.etimes = None;
        self.lstart = starts(pairs);
        self
    }
    /// The start-time probe answers next to the elapsed-seconds one (which keeps its own answer).
    fn with_lstart(mut self, pairs: &[(u32, i64)]) -> Case {
        self.lstart = starts(pairs);
        self
    }
    fn raw_lstart(mut self, body: &str) -> Case {
        self.etimes = None;
        self.lstart = Some(body.into());
        self
    }
    fn raw_etimes(mut self, body: &str) -> Case {
        self.etimes = Some(body.into());
        self
    }
    fn defer_pids(mut self) -> Case {
        self.defer = true;
        self
    }
    fn launchctl(mut self, body: &str) -> Case {
        self.launchctl = Some(body.into());
        self
    }
    fn no_launchctl(mut self) -> Case {
        self.launchctl = None;
        self
    }
}

#[test]
fn the_sweep_selects_and_logs_exactly_what_node_does() {
    let mut cs = cases();
    // The start-time cases that mention a pid number the table does not hold are in the corpus on purpose; the two lstart
    // defer cases above use pid 1 of the fake table only through `raw_lstart`, whose text is not a valid fake pid, so make the
    // text name a real fake pid.
    for c in &mut cs {
        if let Some(l) = &c.lstart {
            c.lstart = Some(l.replace("     1 ", &format!("{:>7} ", BASE + 1)));
        }
    }
    assert!(cs.len() >= 100, "the corpus must stay broad: {}", cs.len());
    let t = drive("reaper", cs);
    assert!(t.same >= 85, "answered {}", t.same);
    assert!(t.deferred >= 8, "deferred {}", t.deferred);
    assert!(t.killed >= 15, "the corpus must exercise the forced signal: {}", t.killed);
}

/// The sweep on real processes: only children this test spawned, behind a fake process table. The first ends on the polite
/// signal, the second ignores it and needs the forced one, the third is not in the table and must be left alone.
#[test]
fn the_engine_really_signals_what_it_selects_and_nothing_else() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let spawn = |script: &str| Command::new("sh").arg("-c").arg(script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let mut polite = spawn("exec sleep 300");
    let mut stubborn = spawn("trap '' TERM; while :; do sleep 1; done");
    let mut bystander = spawn("exec sleep 300");
    std::thread::sleep(Duration::from_millis(300)); // let the stubborn shell install its trap
    let (p1, p2) = (polite.id(), stubborn.id());
    let c = {
        let mut c = case("real", vec![]);
        c.ps = vec![Some(format!("      1       0 /sbin/launchd\n{p1:>7}       1 {MCP}\n{p2:>7}       1 node /opt/x/mcp-server.js\n"))];
        c.etimes = Some(format!("{p1} 3600\n{p2} 3600\n"));
        c
    };
    let (home, fakes) = (scratch("real-h"), scratch("real-f"));
    install_fakes(&fakes, &c);
    let out = run_engine(&home, &fakes, &c, c.payload.to_string().as_bytes());
    assert_eq!(out.0, 0, "{}", String::from_utf8_lossy(&out.2));
    let status = |ch: &mut std::process::Child| {
        let t = Instant::now();
        loop {
            if let Some(s) = ch.try_wait().unwrap() {
                break Some(s);
            }
            if t.elapsed() > Duration::from_secs(5) {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status(&mut polite).and_then(|s| s.signal()), Some(libc::SIGTERM), "the polite signal ends the first");
    assert_eq!(status(&mut stubborn).and_then(|s| s.signal()), Some(libc::SIGKILL), "the second ignores it and gets the forced one");
    assert!(bystander.try_wait().unwrap().is_none(), "a process outside the table is never touched");
    ah_engine::discard::harmless(bystander.kill()); // keep: this test's own child, being cleaned up
    ah_engine::discard::harmless(bystander.wait()); // keep: reaping this test's own child
    let log = std::fs::read_to_string(home.join(".anti-hall/logs/session-end-reaper.log")).unwrap();
    assert_eq!(log.lines().count(), 1 + 2 + 2, "a scan line, two polite and two forced signals: {log}");
}

/// The Node module's own signature test, run on the corpus the engine's unit tests and the parity run use, answers the way the
/// shipped patterns do: the shipped TOML sources are the same expressions as the Node source (modulo the consumed bound).
#[test]
fn the_shipped_patterns_are_the_node_patterns() {
    // read this checkout's plugin files, not whatever a state-dir cache or an installed plugin holds
    ah_engine::defaults::reload(Some(&plugin())).unwrap();
    let src = std::fs::read_to_string(plugin().join("companion/mcp-reaper.js")).unwrap();
    let reaper = std::fs::read_to_string(plugin().join("hooks/session-end-mcp-reaper.js")).unwrap();
    let norm = |s: &str| s.replace("(?=[\\s/]|$)", "([\\s/]|$)").replace("\\/", "/");
    for (key, node_src) in [
        ("mcp_reaper.runtime_re", &src),
        ("mcp_reaper.modelctx_re", &src),
        ("mcp_reaper.token_re", &src),
        ("mcp_reaper.start_re", &src),
        ("mcp_reaper.suffix_re", &src),
        ("mcp_reaper.scoped_re", &src),
        ("mcp_reaper.token_argv0_re", &src),
        ("mcp_reaper.suffix_argv0_re", &src),
        ("mcp_reaper.mcp_self_re", &src),
    ] {
        let toml_src = ah_engine::defaults::text(key);
        assert!(norm(node_src).contains(&format!("/{toml_src}/")), "{key} is not a pattern of companion/mcp-reaper.js: {toml_src}");
    }
    for p in ah_engine::defaults::list("mcp_reaper.runner_exclude_res") {
        assert!(reaper.contains(&format!("/{p}/i")), "runner pattern {p} is not in session-end-mcp-reaper.js");
    }
    for (key, needle) in [
        ("mcp_reaper.min_age_default_s", "const DEFAULT_MIN_AGE_S = "),
        ("mcp_reaper.max_default", "const DEFAULT_MAX_CANDIDATES = "),
        ("mcp_reaper.log_max_bytes", "const MAX_LOG_BYTES = "),
    ] {
        let line = reaper.lines().find(|l| l.starts_with(needle)).unwrap();
        let v: String = line[needle.len()..].trim_end_matches(';').replace(" * ", "*").to_string();
        let n: u64 = v.split('*').map(|x| x.trim().parse::<u64>().unwrap()).product();
        assert_eq!(ah_engine::defaults::num(key), n, "{key}");
    }
    assert!(reaper.contains("new Set(['prompt_input_exit', 'other'])"));
    assert!(reaper.contains("base === 'launchd' || base === 'systemd' || base === 'init'"));
    assert!(reaper.contains("Math.max(0, ms | 0)") && reaper.contains("typeof o.graceMs === 'number' ? o.graceMs : 500"));
}
