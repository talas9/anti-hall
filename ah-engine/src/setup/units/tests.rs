//! The unit writer and the Node-unit retirement on both platforms, through a recording service manager: what is written, which
//! commands run in which order, what is moved aside (never deleted), and the safety paths (dry run, test guard, still loaded,
//! a retired unit that comes back).
use super::*;
use std::cell::RefCell;

struct Fake {
    os: &'static str,
    guarded: bool,
    calls: RefCell<Vec<String>>,
    /// The exit code for a command line (joined with spaces); 0 when not listed.
    codes: Vec<(String, i32)>,
}

impl Fake {
    fn new(os: &'static str) -> Fake {
        Fake { os, guarded: false, calls: RefCell::new(Vec::new()), codes: Vec::new() }
    }
    fn code(mut self, line: &str, c: i32) -> Fake {
        self.codes.push((line.to_string(), c));
        self
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}

impl Sys for Fake {
    fn os(&self) -> String {
        self.os.to_string()
    }
    fn run(&self, argv: &[String]) -> Option<i32> {
        let line = argv.join(" ");
        self.calls.borrow_mut().push(line.clone());
        Some(self.codes.iter().find(|(l, _)| *l == line).map_or(0, |(_, c)| *c))
    }
    fn guarded(&self) -> bool {
        self.guarded
    }
}

fn scratch(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-units").join(format!("{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join("home")).unwrap();
    d
}

/// An executable engine binary under `d` (a path with a space, an ampersand and a dollar sign, to exercise the escapes).
fn exe(d: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let dir = d.join("bin & $x");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("ah-engine");
    std::fs::write(&p, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.display().to_string()
}

fn run(sub: Sub, d: &Path, sys: &Fake, duty: &dyn Fn(&str) -> bool, dry: bool) -> Report {
    let ctx = Ctx { home: d.join("home"), state: d.join("state"), exe: exe(d), dry, sys, duty, now_ms: 1_700_000_000_000 };
    execute(sub, &ctx)
}

fn none(_: &str) -> bool {
    false
}

fn all(_: &str) -> bool {
    true
}

fn plist(d: &Path, label: &str) -> PathBuf {
    d.join("home/Library/LaunchAgents").join(format!("{label}.plist"))
}

fn retired(d: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(d.join("state/units/retired"))
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn fill_replaces_each_placeholder_once_and_leaves_unknown_ones() {
    assert_eq!(fill("{a} {b} {c}", &[("a", "{b}"), ("b", "2")]), "{b} 2 {c}");
    assert_eq!(fill("x{", &[]), "x{");
}

#[test]
fn launchd_install_writes_an_escaped_agent_loads_it_and_a_rerun_changes_nothing() {
    let d = scratch("ld-install");
    let sys = Fake::new("macos");
    let r = run(Sub::Install, &d, &sys, &none, false);
    assert!(!r.failed, "{:?}", r.to_json());
    let text = std::fs::read_to_string(plist(&d, "com.anti-hall.engine")).unwrap();
    assert!(text.contains("<string>com.anti-hall.engine</string>"), "{text}");
    assert!(text.contains("bin &amp; $x/ah-engine</string>"), "the path is XML-escaped: {text}");
    assert!(text.contains("<string>serve</string>") && text.contains("<integer>300</integer>") && text.contains("<key>RunAtLoad</key>"), "{text}");
    let p = plist(&d, "com.anti-hall.engine").display().to_string();
    assert_eq!(sys.calls(), vec![format!("launchctl unload {p}"), format!("launchctl load {p}")]);
    // the same bytes and a loaded label: nothing is written and nothing is loaded again
    let sys2 = Fake::new("macos");
    let r = run(Sub::Install, &d, &sys2, &none, false);
    assert_eq!(r.rows[0].action, "unchanged");
    assert_eq!(sys2.calls(), vec!["launchctl list com.anti-hall.engine".to_string()]);
    // not loaded (exit 113): loaded again without rewriting the file
    let sys3 = Fake::new("macos").code("launchctl list com.anti-hall.engine", 113);
    run(Sub::Install, &d, &sys3, &none, false);
    assert_eq!(sys3.calls().len(), 3, "{:?}", sys3.calls());
}

#[test]
fn systemd_install_writes_a_service_and_a_timer_with_quoted_exec_and_enables_the_timer() {
    let d = scratch("sd-install");
    let sys = Fake::new("linux");
    let r = run(Sub::Install, &d, &sys, &none, false);
    assert!(!r.failed, "{:?}", r.to_json());
    let dir = d.join("home/.config/systemd/user");
    let service = std::fs::read_to_string(dir.join("anti-hall-engine.service")).unwrap();
    let e = exe(&d).replace('$', "$$");
    assert!(service.contains(&format!("ExecStart=\"{e}\" \"serve\"")), "{service}");
    let timer = std::fs::read_to_string(dir.join("anti-hall-engine.timer")).unwrap();
    assert!(timer.contains("OnUnitInactiveSec=300") && timer.contains("WantedBy=timers.target"), "{timer}");
    assert_eq!(sys.calls(), vec!["systemctl --user --version", "systemctl --user daemon-reload", "systemctl --user enable --now anti-hall-engine.timer"]);
}

#[test]
fn without_systemds_user_manager_nothing_is_written_and_the_cron_line_is_offered() {
    let d = scratch("sd-none");
    let sys = Fake::new("linux").code("systemctl --user --version", 1);
    let r = run(Sub::Install, &d, &sys, &none, false);
    assert!(!d.join("home/.config").exists());
    assert!(r.notes.iter().any(|n| n.contains("crontab -e") && n.contains("serve >/dev/null")), "{:?}", r.notes);
}

#[test]
fn a_dry_run_writes_nothing_and_runs_nothing() {
    let d = scratch("dry");
    let sys = Fake::new("macos");
    std::fs::create_dir_all(d.join("home/Library/LaunchAgents")).unwrap();
    std::fs::write(plist(&d, "com.anti-hall.mcp-reaper"), "x").unwrap();
    let r = run(Sub::Heal, &d, &sys, &all, true);
    assert!(sys.calls().is_empty());
    assert!(!plist(&d, "com.anti-hall.engine").exists() && plist(&d, "com.anti-hall.mcp-reaper").exists());
    assert!(!d.join("state").exists() && !d.join("home/.anti-hall").exists(), "no ledger, no marker");
    assert!(r.rows.iter().all(|x| x.outcome == "dry-run" || x.outcome == "ok"), "{:?}", r.to_json());
}

#[test]
fn heal_retires_only_the_node_units_whose_duty_the_engine_runs_and_carries_the_reaper_opt_in() {
    let d = scratch("heal-ld");
    let la = d.join("home/Library/LaunchAgents");
    std::fs::create_dir_all(&la).unwrap();
    for n in [
        "com.anti-hall.mcp-reaper.plist",
        "com.anti-hall.devswarm-supervisor.plist",
        "com.anti-hall.devswarm-ingest.proj-a1.plist",
        "com.anti-hall.devswarm-ingest.proj-b2.plist",
        "com.anti-hall.devswarm-ingest.proj-a1.plist.bak-pathfix-1",
        "com.other.plist",
    ] {
        std::fs::write(la.join(n), n).unwrap();
    }
    let sys = Fake::new("macos")
        .code("launchctl list com.anti-hall.engine", 113)
        .code("launchctl list com.anti-hall.mcp-reaper", 113)
        .code("launchctl list com.anti-hall.devswarm-ingest.proj-a1", 113)
        .code("launchctl list com.anti-hall.devswarm-ingest.proj-b2", 113);
    let duty = |w: &str| w != "devswarm_sup";
    let r = run(Sub::Heal, &d, &sys, &duty, false);
    assert!(!r.failed, "{:?}", r.to_json());
    // the reaper and both ingest units are gone from LaunchAgents and kept in the retired directory; the supervisor stays
    let left: Vec<String> = names_in(&la);
    assert_eq!(
        left,
        vec![
            "com.anti-hall.devswarm-ingest.proj-a1.plist.bak-pathfix-1",
            "com.anti-hall.devswarm-supervisor.plist",
            "com.anti-hall.engine.plist",
            "com.other.plist"
        ]
    );
    assert_eq!(
        retired(&d),
        vec![
            "com.anti-hall.devswarm-ingest.proj-a1.plist.1700000000000",
            "com.anti-hall.devswarm-ingest.proj-b2.plist.1700000000000",
            "com.anti-hall.mcp-reaper.plist.1700000000000"
        ]
    );
    assert!(d.join("home/.anti-hall/ah-engine/units/mcp-reaper.optin").is_file(), "the opt-in is carried over");
    let kept = r.rows.iter().find(|x| x.target.ends_with("devswarm-supervisor.plist")).unwrap();
    assert_eq!((kept.action.as_str(), kept.reason.as_str()), ("keep", "duty not in the engine yet"));
    // each retirement unloads, then checks the label is gone
    let calls = sys.calls();
    let reaper = la.join("com.anti-hall.mcp-reaper.plist").display().to_string();
    let at = calls.iter().position(|c| *c == format!("launchctl unload {reaper}")).unwrap();
    assert_eq!(calls[at + 1], "launchctl list com.anti-hall.mcp-reaper");
    // every acting line is in the ledger with an action id
    let ledger = std::fs::read_to_string(d.join("state/units/ledger.jsonl")).unwrap();
    assert!(ledger.lines().count() >= 6 && ledger.contains("\"action\":\"retire\"") && ledger.contains("\"action_id\""), "{ledger}");
}

#[test]
fn a_node_unit_still_loaded_after_the_unload_keeps_its_file() {
    let d = scratch("still");
    let la = d.join("home/Library/LaunchAgents");
    std::fs::create_dir_all(&la).unwrap();
    std::fs::write(la.join("com.anti-hall.mcp-reaper.plist"), "x").unwrap();
    let sys = Fake::new("macos");
    let r = run(Sub::Heal, &d, &sys, &all, false);
    assert!(la.join("com.anti-hall.mcp-reaper.plist").exists());
    assert!(r.failed && r.rows.iter().any(|x| x.action == "retire" && x.outcome == "failed"), "{:?}", r.to_json());
}

#[test]
fn a_retired_unit_that_comes_back_is_a_mistake_signal_and_is_left_alone() {
    let d = scratch("back");
    let la = d.join("home/Library/LaunchAgents");
    std::fs::create_dir_all(&la).unwrap();
    let p = la.join("com.anti-hall.mcp-reaper.plist");
    std::fs::write(&p, "x").unwrap();
    let sys = Fake::new("macos").code("launchctl list com.anti-hall.mcp-reaper", 113);
    run(Sub::Heal, &d, &sys, &all, false);
    assert!(!p.exists());
    std::fs::write(&p, "reinstalled").unwrap();
    let sys2 = Fake::new("macos").code("launchctl list com.anti-hall.mcp-reaper", 113);
    let r = run(Sub::Heal, &d, &sys2, &all, false);
    assert!(p.exists(), "left alone");
    let m = r.rows.iter().find(|x| x.action == "mistake").expect("a mistake line");
    assert!(m.reason.contains("installed again"), "{}", m.reason);
    assert!(!sys2.calls().iter().any(|c| c.contains("unload") && c.contains("mcp-reaper")), "{:?}", sys2.calls());
    let ledger = std::fs::read_to_string(d.join("state/units/ledger.jsonl")).unwrap();
    assert!(ledger.contains("\"action\":\"mistake\""), "the mistake is in the ledger");
}

#[test]
fn under_the_test_guard_no_command_runs_and_no_node_unit_is_moved() {
    let d = scratch("guard");
    let la = d.join("home/Library/LaunchAgents");
    std::fs::create_dir_all(&la).unwrap();
    std::fs::write(la.join("com.anti-hall.mcp-reaper.plist"), "x").unwrap();
    let mut sys = Fake::new("macos");
    sys.guarded = true;
    let r = run(Sub::Heal, &d, &sys, &all, false);
    assert!(sys.calls().is_empty());
    assert!(la.join("com.anti-hall.mcp-reaper.plist").exists() && plist(&d, "com.anti-hall.engine").exists());
    assert!(r.rows.iter().any(|x| x.outcome == "refused"), "{:?}", r.to_json());
}

#[test]
fn systemd_heal_disables_the_node_timer_moves_both_files_and_reloads() {
    let d = scratch("heal-sd");
    let dir = d.join("home/.config/systemd/user");
    std::fs::create_dir_all(&dir).unwrap();
    for n in ["anti-hall-mcp-reaper.service", "anti-hall-mcp-reaper.timer", "anti-hall-devswarm-ingest-proj.service"] {
        std::fs::write(dir.join(n), n).unwrap();
    }
    let sys = Fake::new("linux")
        .code("systemctl --user is-enabled --quiet anti-hall-mcp-reaper.timer", 1)
        .code("systemctl --user is-enabled --quiet anti-hall-devswarm-ingest-proj.service", 1);
    let duty = |w: &str| w == "mcp_reaper";
    let r = run(Sub::Heal, &d, &sys, &duty, false);
    assert!(!r.failed, "{:?}", r.to_json());
    assert_eq!(retired(&d), vec!["anti-hall-mcp-reaper.service.1700000000000", "anti-hall-mcp-reaper.timer.1700000000000"]);
    assert!(dir.join("anti-hall-devswarm-ingest-proj.service").exists(), "ingest duty not in the engine: kept");
    let calls = sys.calls();
    assert!(calls.contains(&"systemctl --user disable --now anti-hall-mcp-reaper.timer".to_string()), "{calls:?}");
    assert_eq!(calls.last().map(String::as_str), Some("systemctl --user daemon-reload"));
}

#[test]
fn uninstall_unloads_and_moves_the_engine_unit_aside() {
    let d = scratch("uninstall");
    run(Sub::Install, &d, &Fake::new("macos"), &none, false);
    let sys = Fake::new("macos");
    let r = run(Sub::Uninstall, &d, &sys, &none, false);
    assert!(!r.failed);
    assert!(!plist(&d, "com.anti-hall.engine").exists());
    assert_eq!(retired(&d), vec!["com.anti-hall.engine.plist.1700000000000"], "moved, never deleted");
    assert!(sys.calls()[0].starts_with("launchctl unload "));
}

#[test]
fn an_os_without_a_service_manager_gets_a_note_and_nothing_else() {
    let d = scratch("other");
    let sys = Fake::new("freebsd");
    let r = run(Sub::Heal, &d, &sys, &all, false);
    assert!(sys.calls().is_empty() && r.rows.is_empty() && r.notes.len() == 1);
}

#[test]
fn a_missing_engine_binary_writes_nothing() {
    let d = scratch("nobin");
    let sys = Fake::new("macos");
    let ctx = Ctx { home: d.join("home"), state: d.join("state"), exe: d.join("none").display().to_string(), dry: false, sys: &sys, duty: &none, now_ms: 1 };
    let r = execute(Sub::Install, &ctx);
    assert!(r.failed && !plist(&d, "com.anti-hall.engine").exists() && sys.calls().is_empty());
}
