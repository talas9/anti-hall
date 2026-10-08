//! Tests of the MCP sweep on fake process tables: who may be signalled, who may not, and the order of effects. No real
//! process is ever signalled: the fake records the signals it is asked to send. The Node-vs-engine comparison on the real
//! hook is `tests/mcp_reaper_parity.rs`.
use super::select::*;
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashMap;

const ANCIENT: &str = "Mon Jan  5 03:04:05 2026";

/// A table of rows `(pid, ppid, command)` and the answers of the probes.
struct Fake {
    ps: RefCell<Vec<String>>,
    etimes: Option<String>,
    lstart: Option<String>,
    launchctl: Option<String>,
    platform: Platform,
    cgroups: HashMap<u64, String>,
    sent: RefCell<Vec<(i32, bool)>>,
    runs: RefCell<Vec<Vec<String>>>,
    local: Option<f64>,
    me: f64,
}

fn row(pid: u32, ppid: u32, cmd: &str) -> String {
    format!("{pid:>5} {ppid:>5} {cmd}")
}

fn fake(rows: &[String]) -> Fake {
    Fake {
        ps: RefCell::new(vec![rows.join("\n")]),
        etimes: None,
        lstart: None,
        launchctl: Some("PID\tStatus\tLabel\n-\t0\tcom.example.agent\n".into()),
        platform: Platform::Other,
        cgroups: HashMap::new(),
        sent: RefCell::new(Vec::new()),
        runs: RefCell::new(Vec::new()),
        local: Some(1_000_000_000_000.0),
        me: 4_000_000_001.0,
    }
}

impl Sys for Fake {
    fn run(&self, argv: &[String], _t: u64, _m: u64) -> Run {
        self.runs.borrow_mut().push(argv.to_vec());
        let name = argv.join(" ");
        let out = if name.contains("etimes") {
            self.etimes.clone()
        } else if name.contains("lstart") {
            self.lstart.clone()
        } else if name.starts_with("launchctl") {
            self.launchctl.clone()
        } else {
            let mut q = self.ps.borrow_mut();
            Some(if q.len() > 1 { q.remove(0) } else { q[0].clone() })
        };
        out.map_or(Run::Failed, Run::Ok)
    }
    fn read_cgroup(&self, pid: f64) -> Option<String> {
        self.cgroups.get(&(pid as u64)).cloned()
    }
    fn platform(&self) -> Platform {
        self.platform
    }
    fn now_ms(&self) -> f64 {
        1_000_000_000_000.0 + 10_000_000.0
    }
    fn local_epoch_ms(&self, _y: i64, _mo: u32, _d: u32, _h: u32, _mi: u32, _s: u32) -> Option<f64> {
        self.local
    }
    fn kill(&self, pid: i32, forced: bool) {
        self.sent.borrow_mut().push((pid, forced));
    }
    fn is_self_or_parent(&self, pid: f64) -> bool {
        pid == self.me
    }
    fn sleep_ms(&self, _ms: u64) {}
}

fn params<'a>(extra: Option<&'a regex::Regex>, exclude: Option<&'a regex::Regex>) -> Params<'a> {
    Params { extra, exclude, min_age_s: 60.0, max: 16.0 }
}

fn init_row() -> String {
    row(1, 0, "/sbin/launchd")
}

fn selected(rows: &[String], f: impl FnOnce(&mut Fake)) -> Vec<u32> {
    let mut sys = fake(rows);
    sys.etimes = Some(rows.iter().filter_map(|r| r.split_whitespace().next().map(|p| format!("{p} 3600"))).collect::<Vec<_>>().join("\n"));
    f(&mut sys);
    let procs = parse_ps(&sys.ps.borrow()[0]);
    sweep(&procs, &params(None, None), &sys).unwrap().candidates.iter().map(|p| p.pid as u32).collect()
}

#[test]
fn a_command_is_an_mcp_server_only_with_a_real_mcp_token() {
    for yes in [
        "node /x/node_modules/@modelcontextprotocol/server-fs/dist/index.js",
        "node /srv/mcp-server.js",
        "python3 -m mcp_server_time",
        "/usr/bin/mcp-server-everything --stdio",
        "npx -y server-sequential-thinking",
        "node mcp start",
        "mcp start",
        "node /a/node_modules/playwright-mcp/dist/cli.js",
        "npx @playwright/mcp --x",
        "/opt/bin/chrome-devtools-mcp --x",
        "uvx mcp-server-fetch",
    ] {
        assert!(matches_mcp(yes, None), "{yes}");
    }
    for no in [
        "",
        "vim mcp-server.js",
        "tail -f mcp-server.log",
        "grep mcp-server /tmp/x",
        "less ~/notes/mcp start.md",
        "node /srv/build-mcp-server.js",
        "node /srv/foo-mcpx.js",
        "python train.py --mcp --stdio",
        "node /x/mcp-reaper.js --modelcontextprotocol",
        "bash -c echo hello",
    ] {
        assert!(!matches_mcp(no, None), "{no}");
    }
}

#[test]
fn the_user_pattern_adds_a_match_and_never_reaches_the_reaper_itself() {
    let extra = user_pattern("my-tool\\.sh").unwrap();
    assert!(matches_mcp("bash /opt/MY-TOOL.sh run", extra.as_ref()), "case-insensitive");
    assert!(!matches_mcp("bash /opt/other.sh", extra.as_ref()));
    assert!(!matches_mcp("bash /opt/my-tool.sh /x/mcp-reaper.js", extra.as_ref()), "the reaper's own tooling is never a match");
}

#[test]
fn only_a_pattern_whose_meaning_is_certain_is_translated() {
    assert!(user_pattern("").unwrap().is_none());
    assert!(user_pattern("a|b(c)?[x-z]\\.\\d+\\s*\\/").unwrap().is_some());
    for risky in [
        "(?=x)",
        "(?<n>x)",
        "(?i)x",
        "x{2}",
        "\\1",
        "\\u0041",
        "\\p{L}",
        "caf\u{e9}",
        "[",
        "]",
        "[]",
        "[^]",
        "\\",
        "[\\b]",
        "[\\D]",
        "[\\W]",
        "(unclosed",
        "\\k<n>",
        "x\\x41",
        "\\cJ",
        "[[]",
    ] {
        assert!(matches!(user_pattern(risky), Err(Defer)), "{risky:?}");
    }
}

#[test]
fn only_an_orphan_of_pid_one_with_an_mcp_signature_is_a_candidate() {
    let rows = [
        init_row(),
        row(100, 1, "node /srv/mcp-server.js"),
        row(101, 5, "node /srv/mcp-server.js"),
        row(102, 1, "vim mcp-server.js"),
        row(103, 1, "node /x/vitest --run tests/mcp-server.test.ts"),
        row(104, 1, "node /srv/jest-worker/mcp-server.js"),
        row(105, 1, "npx tsx mcp-server.ts"),
        row(106, 1, "node next dev mcp-server"),
        row(107, 1, "node /x/webpack-dev-server mcp-server"),
        row(108, 1, "node /x/playwright mcp-server"),
        row(109, 1, "node /x/ts-node mcp-server.ts"),
        row(110, 1, "python3 -m mcp_server_time"),
    ];
    assert_eq!(selected(&rows, |_| {}), vec![100, 110]);
}

#[test]
fn nothing_is_swept_unless_pid_one_is_an_init_process() {
    let rows = [row(1, 0, "python /app/entrypoint.py"), row(100, 1, "node /srv/mcp-server.js")];
    assert!(selected(&rows, |_| {}).is_empty(), "a container entrypoint is no reaper");
    let rows = [row(100, 1, "node /srv/mcp-server.js")];
    assert!(selected(&rows, |_| {}).is_empty(), "no PID 1 row at all");
    for init in ["/sbin/launchd", "/usr/lib/systemd/systemd --system", "init", "/sbin/init splash"] {
        let rows = [row(1, 0, init), row(100, 1, "node /srv/mcp-server.js")];
        assert_eq!(selected(&rows, |_| {}), vec![100], "{init}");
    }
    for notinit in ["/sbin/launchdx", "/bin/initx", "systemd-logind", "/opt/init.d/run"] {
        let rows = [row(1, 0, notinit), row(100, 1, "node /srv/mcp-server.js")];
        assert!(selected(&rows, |_| {}).is_empty(), "{notinit}");
    }
}

#[test]
fn the_age_floor_and_an_unknown_age_decide_before_anything_is_signalled() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js"), row(102, 1, "node /c/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 59\n101 60\n".into()); // 102 has no age at all
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let got: Vec<u32> = sweep(&procs, &params(None, None), &sys).unwrap().candidates.iter().map(|p| p.pid as u32).collect();
    assert_eq!(got, vec![101], "59 s is too young, 60 s qualifies, an unknown age is never reaped");
}

#[test]
fn a_failed_elapsed_probe_falls_back_to_the_start_time_and_a_future_start_is_unknown() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = None; // `ps` without the column fails
    // the fake clock reads every wall time as 1e12 ms, now is 1e12 + 1e7 ms: the age is 10 000 s
    sys.lstart = Some(format!("100 {ANCIENT}\n101 {ANCIENT}\n"));
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let got: Vec<u32> = sweep(&procs, &params(None, None), &sys).unwrap().candidates.iter().map(|p| p.pid as u32).collect();
    assert_eq!(got, vec![100, 101]);
    sys.local = Some(1_000_000_000_000.0 + 20_000_000.0); // a start in the future: clock skew, unknown, not reaped
    assert!(sweep(&procs, &params(None, None), &sys).unwrap().candidates.is_empty());
}

#[test]
fn a_start_time_the_engine_cannot_read_exactly_is_left_to_node() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js")];
    let procs = parse_ps(&rows.join("\n"));
    for text in
        ["2026-01-05 03:04:05", "Mon Jan  5 03:04:05 CET 2026", "Mon Feb 30 03:04:05 2026", "Mon Jan  5 24:00:00 2026", "Mon Jan  0 03:04:05 2026", "garbage"]
    {
        let mut sys = fake(&rows);
        sys.lstart = Some(format!("100 {text}\n"));
        assert_eq!(sweep(&procs, &params(None, None), &sys), Err(Defer), "{text:?}");
    }
    let mut sys = fake(&rows);
    sys.lstart = Some(format!("100 {ANCIENT}\n"));
    sys.local = None; // an ambiguous or absent local time, or a zone the hook might read differently
    assert_eq!(sweep(&procs, &params(None, None), &sys), Err(Defer));
}

#[test]
fn the_cap_keeps_the_first_in_listing_order() {
    let mut rows = vec![init_row()];
    rows.extend((0..20).map(|i| row(200 + i, 1, "node /srv/mcp-server.js")));
    let got = selected(&rows, |_| {});
    assert_eq!(got.len(), 16);
    assert_eq!(got[0], 200);
    let mut sys = fake(&rows);
    sys.etimes = Some((0..20).map(|i| format!("{} 3600", 200 + i)).collect::<Vec<_>>().join("\n"));
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let p = Params { extra: None, exclude: None, min_age_s: 60.0, max: 0.0 };
    assert!(sweep(&procs, &p, &sys).unwrap().candidates.is_empty());
}

#[test]
fn the_user_exclusion_wins_over_every_match() {
    let rows = [init_row(), row(100, 1, "node /keep/mcp-server.js"), row(101, 1, "node /go/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 3600\n101 3600\n".into());
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let ex = user_pattern("/KEEP/").unwrap();
    let got = sweep(&procs, &params(None, ex.as_ref()), &sys).unwrap();
    assert_eq!(got.candidates.iter().map(|p| p.pid as u32).collect::<Vec<_>>(), vec![101]);
}

#[test]
fn the_macos_service_manager_keeps_its_own_and_an_unverifiable_listing_keeps_everything() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 3600\n101 3600\n".into());
    sys.platform = Platform::Launchd;
    sys.launchctl = Some("PID\tStatus\tLabel\n100\t0\tcom.example.mcp\n-\t0\tcom.example.other\n".into());
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let got = sweep(&procs, &params(None, None), &sys).unwrap();
    assert_eq!(got.candidates.iter().map(|p| p.pid as u32).collect::<Vec<_>>(), vec![101]);
    assert_eq!(got.skipped.iter().map(|s| (s.proc_.pid as u32, s.reason)).collect::<Vec<_>>(), vec![(100, "launchd-managed")]);
    sys.launchctl = None;
    let got = sweep(&procs, &params(None, None), &sys).unwrap();
    assert!(got.candidates.is_empty(), "a killer never guesses");
    assert_eq!(got.skipped.len(), 2);
    assert!(got.skipped.iter().all(|s| s.reason == "launchd-unverifiable"));
}

#[test]
fn a_linux_service_is_skipped_only_on_a_readable_service_cgroup() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js"), row(102, 1, "node /c/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 3600\n101 3600\n102 3600\n".into());
    sys.platform = Platform::Systemd;
    sys.cgroups.insert(100, "0::/user.slice/app.service\n".into());
    sys.cgroups.insert(101, "0::/user.slice/session-3.scope\n".into());
    let procs = parse_ps(&sys.ps.borrow()[0]);
    let got = sweep(&procs, &params(None, None), &sys).unwrap();
    assert_eq!(got.candidates.iter().map(|p| p.pid as u32).collect::<Vec<_>>(), vec![101, 102], "unreadable does not skip");
}

#[test]
fn a_ps_line_without_a_command_or_with_a_line_break_inside_is_not_a_process() {
    let procs = parse_ps("  12   1 node a\n bad line\n  13 1\n  14   1 x\ry\n  15   1 \n");
    assert_eq!(procs.iter().map(|p| p.pid as u32).collect::<Vec<_>>(), vec![12, 15]);
}

// ---- the order of effects --------------------------------------------------------------------------------------------

fn setup(env: &[(&str, &str)]) -> (Settings, String) {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("ah-reap-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join("plug/companion")).unwrap();
    std::fs::write(d.join("plug/companion/mcp-reaper.js"), "").unwrap();
    let home = d.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let mut e: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    e.insert("HOME".into(), home.to_string_lossy().into());
    (Settings { home: home.to_string_lossy().into(), env: e }, d.join("plug").to_string_lossy().into())
}

fn log_of(st: &Settings) -> Vec<serde_json::Value> {
    let p = std::path::Path::new(&st.home).join(".anti-hall/logs/session-end-reaper.log");
    std::fs::read_to_string(p).map(|t| t.lines().map(|l| serde_json::from_str(l).unwrap()).collect()).unwrap_or_default()
}

fn ended(reason: &str) -> Value {
    json!({"hook_event_name":"SessionEnd","reason":reason})
}

#[test]
fn a_sweep_terminates_waits_rechecks_and_kills_only_what_still_qualifies() {
    let (st, root) = setup(&[]);
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js"), row(102, 1, "node /c/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 3600\n101 3600\n102 3600\n".into());
    // the second listing: 100 stayed, 101 is gone, 102 was recycled into an unrelated process
    sys.ps = RefCell::new(vec![rows.join("\n"), [init_row(), row(100, 1, "node /a/mcp-server.js"), row(102, 1, "bash")].join("\n")]);
    assert_eq!(decide(&ended("prompt_input_exit"), &st, &root, &sys), Verdict::Allow);
    assert_eq!(*sys.sent.borrow(), vec![(100, false), (101, false), (102, false), (100, true)]);
    let log = log_of(&st);
    let actions: Vec<String> = log.iter().map(|l| l.get("action").or(l.get("event")).and_then(|v| v.as_str()).unwrap_or("").to_string()).collect();
    assert_eq!(actions, ["scan", "term", "term", "term", "kill"]);
    assert_eq!(log[0]["candidates"], 3);
    assert_eq!(log[0]["reason"], "prompt_input_exit");
    assert_eq!(log[1]["cmd"], "node /a/mcp-server.js");
    assert!(log[0]["ts"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn only_a_real_termination_runs_the_sweep() {
    for reason in ["clear", "resume", "logout", "", "OTHER"] {
        let (st, root) = setup(&[]);
        let sys = fake(&[init_row(), row(100, 1, "node /a/mcp-server.js")]);
        assert_eq!(decide(&ended(reason), &st, &root, &sys), Verdict::Allow);
        assert!(sys.runs.borrow().is_empty(), "{reason:?}: not even a listing");
        assert!(log_of(&st).is_empty());
    }
    let (st, root) = setup(&[]);
    for payload in [json!({}), json!([1]), json!("other"), json!(null), json!({"reason": 5})] {
        let sys = fake(&[init_row()]);
        assert_eq!(decide(&payload, &st, &root, &sys), Verdict::Allow);
        assert!(sys.runs.borrow().is_empty());
    }
    let sys = fake(&[init_row()]);
    assert_eq!(decide(&json!({"end_reason":"other"}), &st, &root, &sys), Verdict::Allow);
    assert_eq!(log_of(&st).len(), 1, "the documented field name is a fallback");
}

#[test]
fn the_switch_turns_the_sweep_off_with_either_variable_name() {
    for env in [("ANTIHALL_SESSION_END_REAPER", "0"), ("ANTI_HALL_SESSION_END_REAPER", "false"), ("ANTIHALL_SESSION_END_REAPER", "off")] {
        let (st, root) = setup(&[env]);
        let sys = fake(&[init_row()]);
        assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
        assert!(sys.runs.borrow().is_empty(), "{env:?}");
    }
}

#[test]
fn a_pid_one_that_is_not_init_logs_one_skip_and_signals_nothing() {
    let (st, root) = setup(&[]);
    let sys = fake(&[row(1, 0, "python /app.py"), row(100, 1, "node /a/mcp-server.js")]);
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
    assert!(sys.sent.borrow().is_empty());
    let log = log_of(&st);
    assert_eq!(log.len(), 1);
    assert_eq!(
        (log[0]["event"].as_str(), log[0]["reason"].as_str(), log[0]["pid1Cmd"].as_str()),
        (Some("skip"), Some("pid1-not-init"), Some("python /app.py"))
    );
}

#[test]
fn a_failed_listing_or_an_empty_table_does_nothing_at_all() {
    let (st, root) = setup(&[]);
    let mut sys = fake(&[]);
    sys.ps = RefCell::new(vec![String::new()]);
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
    assert!(log_of(&st).is_empty() && !std::path::Path::new(&st.home).join(".anti-hall/logs").exists());
}

#[test]
fn a_case_for_node_leaves_no_trace() {
    let (st, root) = setup(&[("ANTIHALL_REAPER_MATCH", "(?=lookahead)")]);
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js")];
    let mut sys = fake(&rows);
    sys.etimes = Some("100 3600\n".into());
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Defer);
    assert!(sys.sent.borrow().is_empty());
    assert!(!std::path::Path::new(&st.home).join(".anti-hall").exists(), "not even the log directory");
    let (st, _) = setup(&[]);
    assert_eq!(decide(&ended("other"), &st, "", &sys), Verdict::Defer, "no plugin root: the module cannot be checked");
    assert_eq!(decide(&ended("other"), &st, "/nonexistent-root", &sys), Verdict::Defer, "the module is absent");
    // the pid-one skip comes before the pattern is read, as in Node
    let (st, root) = setup(&[("ANTIHALL_REAPER_MATCH", "(?=lookahead)")]);
    let sys = fake(&[row(1, 0, "python /app.py")]);
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
}

#[test]
fn the_environment_sets_the_age_floor_and_the_cap_the_way_number_reads_it() {
    let rows = [init_row(), row(100, 1, "node /a/mcp-server.js"), row(101, 1, "node /b/mcp-server.js")];
    let run = |env: &[(&str, &str)]| {
        let (st, root) = setup(env);
        let mut sys = fake(&rows);
        sys.etimes = Some("100 30\n101 30\n".into());
        decide(&ended("other"), &st, &root, &sys);
        sys.sent.borrow().iter().filter(|(_, forced)| !forced).count()
    };
    assert_eq!(run(&[]), 0, "30 s is under the default floor of 60");
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "30")]), 2);
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "")]), 2, "an empty value reads as 0");
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "abc")]), 0, "not a number: the default");
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "-5")]), 0, "negative: the default");
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0x1e")]), 2, "Number reads hex");
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0"), ("ANTI_HALL_SESSION_END_REAPER_MAX", "1")]), 1);
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0"), ("ANTI_HALL_SESSION_END_REAPER_MAX", "1.9")]), 1);
    assert_eq!(run(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0"), ("ANTI_HALL_SESSION_END_REAPER_MAX", "0")]), 0);
}

#[test]
fn the_engine_never_signals_itself_its_parent_or_a_pid_below_two() {
    let (st, root) = setup(&[("ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S", "0")]);
    let rows = [
        init_row(),
        row(0, 1, "node /a/mcp-server.js"),
        row(4_000_000_001, 1, "node /b/mcp-server.js"),
        row(2_147_483_648, 1, "node /c/mcp-server.js"),
        row(300, 1, "node /d/mcp-server.js"),
    ];
    let mut sys = fake(&rows);
    sys.etimes = Some("0 1\n4000000001 1\n2147483648 1\n300 1\n".into());
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
    assert_eq!(sys.sent.borrow().iter().map(|s| s.0).collect::<Vec<_>>(), vec![300, 300], "term and kill of the one safe pid");
}

#[test]
fn the_audit_log_stops_growing_past_its_bound() {
    let (st, root) = setup(&[]);
    let dir = std::path::Path::new(&st.home).join(".anti-hall/logs");
    std::fs::create_dir_all(&dir).unwrap();
    let big = vec![b'x'; defaults::num("mcp_reaper.log_max_bytes") as usize + 1];
    std::fs::write(dir.join("session-end-reaper.log"), &big).unwrap();
    let sys = fake(&[init_row(), row(100, 5, "node a")]);
    assert_eq!(decide(&ended("other"), &st, &root, &sys), Verdict::Allow);
    assert_eq!(std::fs::metadata(dir.join("session-end-reaper.log")).unwrap().len(), big.len() as u64);
}

fn sh(script: &str, timeout_ms: u64) -> Run {
    let sys = super::sys::RealSys::new(&crate::reqenv::RequestEnv::from_pairs(Vec::<(String, String)>::new()));
    sys.run(&["/bin/sh".to_string(), "-c".to_string(), script.to_string()], timeout_ms, defaults::num("mcp_reaper.probe_max_bytes"))
}

/// A probe that has exited keeps its output while a helper of it still holds the pipe past `mcp_reaper.read_ms` (it is read
/// within what is left of the timeout, as Node's spawnSync reads until the pipe closes).
#[test]
fn a_finished_probe_keeps_output_that_arrives_after_read_ms() {
    let read = defaults::num("mcp_reaper.read_ms");
    assert_eq!(sh(&format!("printf out; sleep {} &", read as f64 * 2.0 / 1000.0), read * 20), Run::Ok("out".into()));
}

/// Output that has not arrived by the deadline fails the probe; it is never an empty answer. An empty service-manager listing
/// would mark no candidate as managed, so every one of them would be signalled.
#[test]
fn a_probe_whose_output_never_arrives_fails_instead_of_answering_empty() {
    let read = defaults::num("mcp_reaper.read_ms");
    assert_eq!(sh(&format!("sleep {} &", read as f64 * 3.0 / 1000.0), read), Run::Failed);
}
