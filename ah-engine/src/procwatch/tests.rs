//! Process-watch tests: classification, the safety rules, kill and race handling, report mode, the resource watch, the disk watch
//! and the advisory, on a fake host (fixtures shaped like both Linux and macOS data); plus a real run on this machine against
//! dummy processes in a scratch HOME. The live engine's own processes are never in the candidate set of a real run.

use super::disk::{self, Floors, Level};
use super::host::{self, Host, MemInfo, Pressure, ProcRow, RealHost, Space};
use super::orphan::{self, Cfg};
use super::resource::{self, Limits};
use super::{Sweep, run_with};
use crate::checks::Verdict;
use crate::checks::git::util::Settings;
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const DAY: u64 = 86_400;
const NOW: u64 = 1_800_000_000;

/// A scripted machine.
#[derive(Default)]
struct Fake {
    rows: Vec<ProcRow>,
    envs: HashMap<u32, Vec<(String, String)>>,
    signals: Vec<(u32, bool)>,
    /// A pid that disappears at its first signal (a race: it exits during the sweep).
    exits_on_signal: HashSet<u32>,
    /// A pid that is gone before the sweep reaches it.
    gone_before: HashSet<u32>,
    renices: Vec<(u32, i32)>,
    cwds: HashMap<u32, PathBuf>,
    mem: Option<MemInfo>,
    spaces: HashMap<PathBuf, Space>,
    any_space: Option<Space>,
    sleeps: Vec<u64>,
}

impl Host for Fake {
    fn now_s(&self) -> u64 {
        NOW
    }
    fn procs(&mut self) -> Vec<ProcRow> {
        self.rows.clone()
    }
    fn proc_row(&mut self, pid: u32) -> Option<ProcRow> {
        if self.gone_before.contains(&pid) {
            return None;
        }
        self.rows.iter().find(|r| r.pid == pid).cloned()
    }
    fn environ(&mut self, pid: u32) -> Option<Vec<(String, String)>> {
        self.envs.get(&pid).cloned()
    }
    fn cwd(&mut self, pid: u32) -> Option<PathBuf> {
        self.cwds.get(&pid).cloned()
    }
    fn mem(&mut self) -> MemInfo {
        self.mem.unwrap_or(MemInfo { swap_used: 0, pressure: Pressure::Unknown })
    }
    fn space(&self, path: &Path) -> Option<Space> {
        self.spaces.get(path).copied().or(self.any_space)
    }
    fn signal(&mut self, pid: u32, forced: bool) -> bool {
        self.signals.push((pid, forced));
        if self.exits_on_signal.contains(&pid) {
            self.rows.retain(|r| r.pid != pid);
            return !forced;
        }
        true
    }
    fn renice(&mut self, pid: u32, nice: i32) -> bool {
        self.renices.push((pid, nice));
        true
    }
    fn sleep_ms(&mut self, ms: u64) {
        self.sleeps.push(ms);
    }
}

fn row(pid: u32, ppid: u32, age: u64, cmd: &str) -> ProcRow {
    ProcRow { pid, ppid, start_s: NOW - age, cpu_pct: 0.0, mem_bytes: 50 << 20, cmd: cmd.to_string() }
}

fn marked(owner: u32) -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin".into()),
        ("CLAUDECODE".into(), "1".into()),
        ("CLAUDE_PID".into(), owner.to_string()),
        ("CLAUDE_CODE_SESSION_ID".into(), "sess-1".into()),
    ]
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-procwatch-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok(); // harmless: the scratch dir of this test process
    std::fs::create_dir_all(&d).expect("scratch dir");
    d
}

fn settings_for(home: &Path) -> Settings {
    Settings::from_env(&RequestEnv::from_pairs([("HOME", home.to_string_lossy().to_string())]))
}

fn cfg_default(home: &Path) -> Cfg {
    Cfg::load(&settings_for(home)).expect("the shipped configuration compiles")
}

fn write_settings(home: &Path, v: Value) {
    std::fs::create_dir_all(home.join(".anti-hall")).expect("settings dir");
    std::fs::write(home.join(".anti-hall/settings.json"), v.to_string()).expect("settings file");
}

/// A dev server left behind: marked, owner 4_000_000 (no such pid), reparented to init, old.
fn orphan_fixture() -> Fake {
    let mut f = Fake {
        rows: vec![
            row(1, 0, 10 * DAY, "/sbin/launchd"),
            row(500, 1, 5 * DAY, "/Users/u/.local/bin/claude --resume"),
            row(900, 1, 5 * DAY, "node /work/app/node_modules/.bin/vite --port 5173"),
            row(901, 900, 5 * DAY, "node /work/app/esbuild --service"),
        ],
        ..Fake::default()
    };
    f.envs.insert(900, marked(4_000_000));
    f
}

fn classify_with(f: &mut Fake, home: &Path) -> Vec<orphan::Finding> {
    let cfg = cfg_default(home);
    let rows = f.rows.clone();
    orphan::classify(f, &rows, &cfg, &HashSet::new())
}

// ---------------------------------------------------------------------------------------------------------------------
// classification and the safety rules
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_marked_reparented_process_with_a_dead_owner_is_a_candidate_with_its_children() {
    let h = scratch("classify");
    let mut f = orphan_fixture();
    let found = classify_with(&mut f, &h);
    assert_eq!(
        found.iter().map(|x| (x.pid, x.class.as_str(), x.reason.as_str())).collect::<Vec<_>>(),
        vec![(900, "dev_server", "owner_gone"), (901, "dev_server", "child_of:900")]
    );
    assert!(found.iter().all(|x| x.mode == orphan::Mode::Report), "every class ships in report mode");
    assert_eq!(found[0].session_id, "sess-1");
}

#[test]
fn a_process_of_a_live_session_is_never_a_candidate() {
    let h = scratch("live");
    // the owner named by the environment is a live Claude session that started before it
    let mut f = orphan_fixture();
    f.envs.insert(900, marked(500));
    assert!(classify_with(&mut f, &h).is_empty(), "live owner");
    // reparented to init but a Claude session is not an ancestor and the owner is gone: that IS an orphan; with a live ancestor it is not
    let mut g = orphan_fixture();
    g.rows[2].ppid = 500;
    g.rows[3].ppid = 900;
    assert!(classify_with(&mut g, &h).is_empty(), "child of a live session is not a root candidate");
}

#[test]
fn a_recycled_owner_pid_counts_as_gone_but_a_later_started_session_does_not_resurrect_it() {
    let h = scratch("recycled");
    let mut f = orphan_fixture();
    // the owner pid now belongs to an unrelated program
    f.rows.push(row(4242, 1, 100, "/usr/sbin/cupsd"));
    f.envs.insert(900, marked(4242));
    assert_eq!(classify_with(&mut f, &h).len(), 2, "pid reused by a non-session command: owner gone");
    // the owner pid is a session command but it started AFTER the candidate: also a reuse
    let mut g = orphan_fixture();
    g.rows.push(row(4243, 1, 10, "/Users/u/.local/bin/claude"));
    g.envs.insert(900, marked(4243));
    assert_eq!(classify_with(&mut g, &h).len(), 2);
}

#[test]
fn unmarked_young_unreadable_and_protected_processes_are_never_candidates() {
    let h = scratch("negatives");
    let mut f = orphan_fixture();
    f.envs.insert(900, vec![("PATH".into(), "/usr/bin".into())]); // no CLAUDECODE
    assert!(classify_with(&mut f, &h).is_empty(), "no marker");
    let mut f = orphan_fixture();
    f.envs.remove(&900); // a protected system binary: the system will not show its environment
    assert!(classify_with(&mut f, &h).is_empty(), "environment unreadable");
    let mut f = orphan_fixture();
    f.rows[2].start_s = NOW - 60; // younger than the class minimum
    assert!(classify_with(&mut f, &h).is_empty(), "too young");
    // the plugin's own engine daemon: marked, reparented, old, owner gone, matches the catch-all class
    let mut f = orphan_fixture();
    f.rows.push(row(950, 1, 5 * DAY, "/Users/u/.anti-hall/ah-engine/bin/ah-engine serve"));
    f.rows.push(row(952, 1, 5 * DAY, "/Users/u/.anti-hall/ah-engine-live/bundle/ah-engine serve"));
    f.envs.insert(952, marked(4_000_000));
    f.envs.insert(950, marked(4_000_000));
    f.rows.push(row(951, 1, 5 * DAY, "/Users/u/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/companion/ingest.js"));
    f.envs.insert(951, marked(4_000_000));
    let found = classify_with(&mut f, &h);
    assert!(found.iter().all(|x| x.pid != 950 && x.pid != 951 && x.pid != 952), "the live engine and the plugin's companions are protected");
    // the engine's own pid and its ancestors
    let cfg = cfg_default(&h);
    let rows = f.rows.clone();
    let own: HashSet<u32> = [900].into_iter().collect();
    assert!(orphan::classify(&mut f, &rows, &cfg, &own).iter().all(|x| x.pid != 900));
}

#[test]
fn a_system_process_without_the_marker_is_untouched_even_in_kill_mode() {
    let h = scratch("system");
    write_settings(&h, json!({"procwatch": {"otherMode": "kill", "devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    f.rows.push(row(300, 1, 20 * DAY, "/usr/libexec/airportd"));
    f.envs.insert(300, vec![("PATH".into(), "/usr/bin".into())]);
    let mut sw = Sweep::default();
    run_with(&mut f, &mut sw, &h.join("state"), &h.to_string_lossy(), &|_, _, _| {}).expect("sweep");
    assert!(f.signals.iter().all(|(p, _)| *p != 300 && *p != 1 && *p != 500));
}

// ---------------------------------------------------------------------------------------------------------------------
// the sweep: report mode, kill mode, races, report file, telemetry
// ---------------------------------------------------------------------------------------------------------------------

fn sweep_once(f: &mut Fake, home: &Path) -> (Value, Vec<(String, String, String)>) {
    let recs = std::cell::RefCell::new(Vec::new());
    let mut sw = Sweep::default();
    let state = home.join("state");
    run_with(f, &mut sw, &state, &home.to_string_lossy(), &|k, c, r| recs.borrow_mut().push((k.into(), c.into(), r.into()))).expect("sweep");
    let report: Value = serde_json::from_str(&std::fs::read_to_string(state.join("procwatch-report.json")).expect("report")).expect("json");
    (report, recs.into_inner())
}

#[test]
fn report_mode_kills_nothing_and_records_every_candidate() {
    let h = scratch("report");
    let mut f = orphan_fixture();
    let (report, recs) = sweep_once(&mut f, &h);
    assert!(f.signals.is_empty(), "nothing is signalled in report mode");
    assert_eq!(report["orphans"]["count"], 2);
    assert_eq!(report["orphans"]["listed"][0]["pid"], 900);
    assert_eq!(report["modes"]["dev_server"], "report");
    assert_eq!(recs.iter().filter(|r| r.0 == "orphan_candidate").count(), 2, "one telemetry record per candidate");
    assert!(recs.iter().all(|r| r.0 != "orphan_kill"));
}

#[test]
fn kill_mode_terminates_then_kills_one_pid_at_a_time_after_a_fresh_recheck() {
    let h = scratch("kill");
    write_settings(&h, json!({"procwatch": {"devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    let (report, recs) = sweep_once(&mut f, &h);
    // 900 then its child 901, each: polite, grace, forced (the dummy ignores the polite signal)
    assert_eq!(f.signals, vec![(900, false), (900, true), (901, false), (901, true)]);
    assert_eq!(f.sleeps, vec![2000, 2000], "the grace period comes from the configuration");
    assert_eq!(recs.iter().filter(|r| r.0 == "orphan_kill").count(), 2);
    assert_eq!(report["kills"][0]["outcome"], "kill");
}

#[test]
fn a_process_that_exits_during_the_sweep_is_not_force_killed_and_a_vanished_one_is_not_signalled() {
    let h = scratch("race");
    write_settings(&h, json!({"procwatch": {"devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    f.exits_on_signal.insert(900); // exits on the polite signal
    f.gone_before.insert(901); // gone before the sweep reaches it
    let (report, _) = sweep_once(&mut f, &h);
    assert_eq!(f.signals, vec![(900, false)], "no forced signal to a process that already ended, no signal to a vanished one");
    assert_eq!(report["kills"][0]["outcome"], "term");
    assert_eq!(report["kills"][1]["outcome"], "gone");
}

#[test]
fn a_recycled_pid_is_never_signalled() {
    let h = scratch("recycle-race");
    write_settings(&h, json!({"procwatch": {"devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    let cfg = cfg_default(&h);
    let rows = f.rows.clone();
    let found = orphan::classify(&mut f, &rows, &cfg, &HashSet::new());
    // between the scan and the stop, the pid now belongs to another program
    f.rows[2].cmd = "/usr/bin/vim notes.txt".into();
    assert_eq!(orphan::reap(&mut f, &found[0], 10), orphan::Outcome::Gone);
    assert!(f.signals.is_empty());
}

#[test]
fn the_kill_cap_bounds_one_sweep() {
    let h = scratch("cap");
    write_settings(&h, json!({"procwatch": {"otherMode": "kill"}}));
    let mut f = Fake::default();
    f.rows.push(row(1, 0, 10 * DAY, "/sbin/launchd"));
    for p in 0..20u32 {
        f.rows.push(row(2000 + p, 1, 5 * DAY, "/opt/thing --serve"));
        f.envs.insert(2000 + p, marked(4_000_000));
    }
    sweep_once(&mut f, &h);
    let polite = f.signals.iter().filter(|(_, forced)| !forced).count();
    assert_eq!(polite as u64, crate::defaults::num("procwatch.max_kills_per_run"));
}

#[test]
fn the_master_switch_turns_the_whole_sweep_off() {
    let h = scratch("off");
    write_settings(&h, json!({"procwatch": {"enabled": false, "devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    let mut sw = Sweep::default();
    assert_eq!(run_with(&mut f, &mut sw, &h.join("state"), &h.to_string_lossy(), &|_, _, _| {}).expect("sweep"), "off");
    assert!(f.signals.is_empty() && !h.join("state/procwatch-report.json").exists());
}

// ---------------------------------------------------------------------------------------------------------------------
// the resource watch
// ---------------------------------------------------------------------------------------------------------------------

fn session_tree(burner_cpu: f32, burner_mem_mb: u64) -> Vec<ProcRow> {
    let mut burner = row(701, 700, 600, "/usr/bin/python3 burn.py");
    burner.cpu_pct = burner_cpu;
    burner.mem_bytes = burner_mem_mb << 20;
    let mut idle = row(702, 700, 600, "/usr/bin/tail -f log");
    idle.cpu_pct = 0.1;
    vec![row(1, 0, DAY, "/sbin/launchd"), row(500, 1, DAY, "/Users/u/.local/bin/claude"), row(700, 500, 900, "/bin/zsh -c run"), burner, idle]
}

fn run_samples(rows_for: impl Fn(u64) -> Vec<ProcRow>, steps: u64, st: &Settings, mem: MemInfo) -> Vec<(u64, Vec<resource::Warn>)> {
    let cfg = Cfg::load(st).expect("cfg");
    let lim = Limits::load(st);
    let mut state = resource::State::default();
    (0..steps).map(|i| (i, state.sample(&rows_for(i), &mem, &cfg, &lim, NOW + i * 30))).collect()
}

fn quiet() -> MemInfo {
    MemInfo { swap_used: 0, pressure: Pressure::Unknown }
}

#[test]
fn a_cpu_burner_in_a_live_session_warns_once_after_the_window_and_an_idle_process_never() {
    let h = scratch("cpu");
    let st = settings_for(&h);
    let out = run_samples(|_| session_tree(100.0, 20), 12, &st, quiet());
    let firsts: Vec<(u64, &str, u32)> = out.iter().flat_map(|(i, w)| w.iter().map(move |x| (*i, x.kind, x.pid))).collect();
    // sample 0 is the unreadable first reading; 120 s at 30 s needs samples 1..=5 (span 120 >= 75% of the window)
    assert_eq!(firsts.len(), 1, "cooldown holds: one warning in 6 minutes, got {firsts:?}");
    assert_eq!(firsts[0].1, "cpu");
    assert_eq!(firsts[0].2, 701);
    assert!(firsts[0].0 >= 3 && firsts[0].0 <= 5, "not before the window is covered: {firsts:?}");
    assert!(out.iter().all(|(_, w)| w.iter().all(|x| x.pid != 702)), "an idle process never warns");
    let w = &out.iter().find(|(_, w)| !w.is_empty()).expect("a warning").1[0];
    assert_eq!(w.session_pid, 500);
    assert!(resource::line(w).contains("python3") && resource::line(w).contains("100%"));
}

#[test]
fn a_short_spike_is_not_sustained_and_the_first_reading_is_ignored() {
    let h = scratch("spike");
    let st = settings_for(&h);
    // only one hot sample in the middle
    let out = run_samples(|i| session_tree(if i == 3 { 100.0 } else { 1.0 }, 20), 10, &st, quiet());
    assert!(out.iter().all(|(_, w)| w.is_empty()));
    // hot only on the very first reading of the process: ignored (a rate needs two samples)
    let out = run_samples(|i| session_tree(if i == 0 { 400.0 } else { 1.0 }, 20), 6, &st, quiet());
    assert!(out.iter().all(|(_, w)| w.is_empty()));
}

#[test]
fn a_memory_hog_warns_at_once_and_the_cooldown_holds() {
    let h = scratch("mem");
    let st = settings_for(&h);
    let out = run_samples(|_| session_tree(1.0, 6000), 10, &st, quiet());
    let n: Vec<u64> = out.iter().filter(|(_, w)| !w.is_empty()).map(|(i, _)| *i).collect();
    assert_eq!(n, vec![0], "warned on the first sample, then held by the cooldown for 15 minutes");
    assert_eq!(out[0].1[0].kind, "memory");
    assert!(resource::line(&out[0].1[0]).contains("5859 MB") || resource::line(&out[0].1[0]).contains("MB memory"));
}

#[test]
fn processes_outside_a_live_session_are_not_measured() {
    let h = scratch("outside");
    let st = settings_for(&h);
    let mut rows = session_tree(100.0, 9000);
    for r in &mut rows {
        if r.pid == 700 {
            r.ppid = 1; // the shell is no longer under a Claude session
        }
    }
    let out = run_samples(|_| rows.clone(), 8, &st, quiet());
    assert!(out.iter().all(|(_, w)| w.is_empty()));
}

#[test]
fn swap_and_pressure_warn_for_both_platform_shapes() {
    let h = scratch("system-mem");
    let st = settings_for(&h);
    let mac = MemInfo { swap_used: 10 << 30, pressure: Pressure::MacLevel(4) };
    let linux = MemInfo { swap_used: 1 << 30, pressure: Pressure::Psi(55.0) };
    let m = run_samples(|_| session_tree(1.0, 20), 1, &st, mac);
    assert_eq!(m[0].1.iter().map(|w| w.kind).collect::<Vec<_>>(), vec!["swap", "pressure"]);
    let l = run_samples(|_| session_tree(1.0, 20), 1, &st, linux);
    assert_eq!(l[0].1.iter().map(|w| w.kind).collect::<Vec<_>>(), vec!["pressure"], "1 GB of swap is under the threshold");
    assert!(resource::line(&l[0].1[0]).contains("PSI 55%"));
    let calm = MemInfo { swap_used: 0, pressure: Pressure::MacLevel(1) };
    assert!(run_samples(|_| session_tree(1.0, 20), 1, &st, calm)[0].1.is_empty());
}

#[test]
fn the_sweep_warns_names_the_session_and_renice_is_opt_in() {
    let h = scratch("renice");
    let mut f = Fake { rows: session_tree(1.0, 7000), ..Fake::default() };
    f.envs.insert(500, vec![("CLAUDE_CODE_SESSION_ID".into(), "sess-9".into())]);
    let (report, recs) = sweep_once(&mut f, &h);
    assert_eq!(report["resource"][0]["session"], "sess-9");
    assert_eq!(report["resource"][0]["pid"], 701);
    assert!(recs.iter().any(|r| r.0 == "resource_warning" && r.2 == "memory"), "telemetry on every warning");
    assert!(f.renices.is_empty() && f.signals.is_empty(), "no kill and no renice by default");
    write_settings(&h, json!({"resourceWatch": {"renice": true}}));
    let mut g = Fake { rows: session_tree(1.0, 7000), ..Fake::default() };
    sweep_once(&mut g, &h);
    assert_eq!(g.renices, vec![(701, 10)]);
    assert!(g.signals.is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// the disk watch and the advisory
// ---------------------------------------------------------------------------------------------------------------------

const GB: u64 = 1 << 30;

fn space(free_gb: f64, total_gb: u64, dev: u64) -> Space {
    Space { free: (free_gb * GB as f64) as u64, total: total_gb * GB, dev }
}

#[test]
fn floors_grade_gigabytes_and_percent_and_volumes_are_told_apart_by_device() {
    let h = scratch("floors");
    let f = Floors::load(&settings_for(&h));
    assert_eq!(f.level(&space(100.0, 500, 1)), Level::Ok);
    assert_eq!(f.level(&space(15.0, 500, 1)), Level::Warn, "under 20 GB");
    assert_eq!(f.level(&space(60.0, 2000, 1)), Level::Warn, "3% free with 60 GB: under the 10% warn floor, not under the 3% critical one");
    assert_eq!(f.level(&space(2.5, 500, 1)), Level::Critical, "the 2.5 GB incident");
    let mut host = Fake::default();
    host.spaces.insert(PathBuf::from("/proj"), space(2.0, 500, 7));
    host.spaces.insert(PathBuf::from("/home/u"), space(2.0, 500, 7)); // same volume
    host.spaces.insert(PathBuf::from("/tmp"), space(300.0, 500, 8));
    let v = disk::volumes(&host, &[PathBuf::from("/proj"), PathBuf::from("/home/u"), PathBuf::from("/tmp")], &f);
    assert_eq!(v.len(), 2, "one reading per device");
    assert_eq!(v[0].level, Level::Critical);
}

/// A machine whose every watched volume has this much free space (500 GB volume).
fn disk_host(free_gb: f64) -> Fake {
    Fake { any_space: Some(space(free_gb, 500, 7)), ..Fake::default() }
}

/// Run the sweep against `host` so the report lands where the script reads it (HOME/.anti-hall/ah-engine).
fn publish(host: &mut Fake, home: &Path) {
    let mut sw = Sweep::default();
    run_with(host, &mut sw, &home.join(".anti-hall/ah-engine"), &home.to_string_lossy(), &|_, _, _| {}).expect("sweep");
}

fn script_env(home: &Path, claude_pid: Option<&str>) -> RequestEnv {
    let mut pairs = vec![("HOME".to_string(), home.to_string_lossy().to_string())];
    if let Some(p) = claude_pid {
        pairs.push(("CLAUDE_PID".to_string(), p.to_string()));
    }
    RequestEnv::from_pairs(pairs)
}

/// The script's answer for one hook call at the pinned clock.
fn advise(env: &RequestEnv, event: &str, payload: &Value) -> Verdict {
    let mut p = payload.clone();
    p["hook_event_name"] = json!(event);
    let v = crate::script::run_forced("procwatch-advisory", &p, &Value::Null, event, env).expect("the shipped script exists").expect("an answer");
    if v == Verdict::Defer {
        eprintln!("script deferred: {:?}", crate::discard::captured());
    }
    v
}

fn text_of(v: &Verdict) -> String {
    match v {
        Verdict::Advisory(t) | Verdict::Block(t) => t.clone(),
        other => panic!("expected an advisory or block, got {other:?}"),
    }
}

#[test]
fn low_disk_adds_an_advisory_with_a_cooldown_and_a_worse_level_breaks_through() {
    let h = scratch("disk-adv");
    let env = script_env(&h, None);
    let p = json!({"session_id": "s1"});
    publish(&mut disk_host(300.0), &h);
    assert_eq!(advise(&env, "UserPromptSubmit", &p), Verdict::Allow);
    publish(&mut disk_host(15.0), &h);
    let t = text_of(&advise(&env, "UserPromptSubmit", &p));
    assert!(t.contains("Low disk space") && t.contains("warn") && t.contains("nothing was deleted"), "{t}");
    assert_eq!(advise(&env, "UserPromptSubmit", &p), Verdict::Allow, "cooldown: the same level is not repeated");
    assert!(text_of(&advise(&env, "SessionStart", &json!({"session_id": "s2"}))).contains("Low disk space"), "another session is told once too");
    publish(&mut disk_host(2.5), &h);
    assert!(text_of(&advise(&env, "UserPromptSubmit", &p)).contains("critical"), "a worse level is never held back");
}

#[test]
fn at_critical_a_heavy_command_is_warned_about_and_blocking_is_an_opt_in() {
    let h = scratch("disk-heavy");
    let env = script_env(&h, None);
    let heavy = json!({"session_id": "s1", "tool_input": {"command": "cargo build --release"}});
    let light = json!({"session_id": "s1", "tool_input": {"command": "ls -la"}});
    publish(&mut disk_host(300.0), &h);
    assert_eq!(advise(&env, "PreToolUse", &heavy), Verdict::Allow);
    publish(&mut disk_host(2.5), &h);
    assert_eq!(advise(&env, "PreToolUse", &light), Verdict::Allow, "a light command is not warned about");
    assert!(text_of(&advise(&env, "PreToolUse", &heavy)).contains("writes a lot of data"));
    write_settings(&h, json!({"diskWatch": {"blockAtCritical": true}}));
    let b = advise(&env, "PreToolUse", &heavy);
    assert!(matches!(&b, Verdict::Block(t) if t.contains("Blocked")), "{b:?}");
    assert_eq!(advise(&env, "PreToolUse", &light), Verdict::Allow);
    write_settings(&h, json!({"diskWatch": {"enabled": false}}));
    assert_eq!(advise(&env, "PreToolUse", &heavy), Verdict::Allow);
}

#[test]
fn a_stale_report_and_the_master_switch_are_silence_and_a_broken_script_is_never_a_block() {
    let h = scratch("script-policy");
    let env = script_env(&h, None);
    let heavy = json!({"session_id": "s1", "tool_input": {"command": "cargo build"}});
    publish(&mut disk_host(2.5), &h);
    write_settings(&h, json!({"procwatch": {"enabled": false}}));
    assert_eq!(advise(&env, "PreToolUse", &heavy), Verdict::Allow);
    write_settings(&h, json!({}));
    // a report older than procwatch.report_max_age_s is not shown
    let path = h.join(".anti-hall/ah-engine/procwatch-report.json");
    let mut old: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("report")).expect("json");
    old["ts_s"] = json!(1_000_000_000u64);
    std::fs::write(&path, old.to_string()).expect("write old report");
    assert_eq!(advise(&env, "PreToolUse", &heavy), Verdict::Allow);
    publish(&mut disk_host(2.5), &h);
    // a script that throws defers to the no-op fallback hook: silence, not a block, even on a guard event
    std::fs::create_dir_all(h.join(".anti-hall/logic")).expect("logic dir");
    std::fs::write(h.join(".anti-hall/logic/procwatch-advisory.js"), "function decide(p){ throw new Error('bad'); }").expect("override");
    let broken = advise(&env, "PreToolUse", &heavy);
    assert!(matches!(broken, Verdict::Defer), "a broken script must defer, got {broken:?}");
}

#[test]
fn disk_telemetry_is_recorded_on_a_level_change_and_after_the_cooldown_not_on_every_sweep() {
    let h = scratch("disk-tel");
    let recs = std::cell::RefCell::new(Vec::new());
    let mut sw = Sweep::default();
    let state = h.join(".anti-hall/ah-engine");
    let mut go = |free: f64| {
        run_with(&mut disk_host(free), &mut sw, &state, &h.to_string_lossy(), &|k, c, r| recs.borrow_mut().push((k.to_string(), c.to_string(), r.to_string())))
            .expect("sweep")
    };
    go(300.0);
    go(15.0);
    go(15.0);
    go(2.5);
    go(2.5);
    let disk: Vec<String> = recs.borrow().iter().filter(|r| r.0 == "disk_warning").map(|r| r.2.clone()).collect();
    assert_eq!(disk, vec!["warn", "critical"], "one record per level change, none while the level and the cooldown hold");
}

#[test]
fn the_growth_scan_names_big_build_directories_and_deletes_nothing() {
    let h = scratch("growth");
    let t = h.join("proj/target/debug");
    std::fs::create_dir_all(&t).expect("dirs");
    std::fs::create_dir_all(h.join("proj/src")).expect("dirs");
    std::fs::write(t.join("big.bin"), vec![1u8; 4 << 20]).expect("file");
    std::fs::write(h.join("proj/src/main.rs"), "fn main(){}").expect("file");
    // the shipped minimum is 500 MB; a directory of 4 MB is not named
    assert!(disk::growth(&[h.join("proj")]).is_empty());
    assert_eq!(disk::human(4 << 20), "4 MB");
    assert_eq!(disk::human(3 << 30), "3.0 GB");
    assert!(t.join("big.bin").exists(), "nothing was deleted");
}

#[test]
fn growth_is_named_in_the_advisory_when_a_volume_is_low() {
    let h = scratch("growth-adv");
    // a fake growth entry in a hand-written report: the script only formats what the sweep found
    let dir = h.join(".anti-hall/ah-engine");
    std::fs::create_dir_all(&dir).expect("dir");
    let report = json!({"ts_s": NOW, "orphans": {"count": 0, "listed": []}, "kills": [], "resource": [],
        "disk": {"volumes": [{"path": "/proj", "dev": 7, "free": "2.5 GB", "pct": "1", "level": "critical"}], "growth": [{"path": "/proj/target", "size": "38.0 GB"}]}});
    std::fs::write(dir.join("procwatch-report.json"), report.to_string()).expect("report");
    let t = text_of(&advise(&script_env(&h, None), "UserPromptSubmit", &json!({"session_id": "s1"})));
    assert!(t.contains("/proj/target (38.0 GB)") && t.contains("suggestion only") && t.contains("critical"), "{t}");
}

#[test]
fn the_report_resource_warnings_reach_the_right_session_once() {
    let h = scratch("report-adv");
    let mut f = Fake { rows: session_tree(1.0, 7000), ..Fake::default() };
    f.envs.insert(500, vec![("CLAUDE_CODE_SESSION_ID".into(), "sess-9".into())]);
    publish(&mut f, &h);
    let env = script_env(&h, Some("500"));
    let p = json!({"session_id": "sess-9"});
    let t = text_of(&advise(&env, "UserPromptSubmit", &p));
    assert!(t.contains("Resource use is high") && t.contains("python3") && t.contains("Nothing was stopped"), "{t}");
    assert_eq!(advise(&env, "UserPromptSubmit", &p), Verdict::Allow, "shown once");
    // another session does not get a process warning that belongs to sess-9
    assert_eq!(advise(&script_env(&h, Some("777")), "UserPromptSubmit", &json!({"session_id": "other"})), Verdict::Allow);
}

#[test]
fn orphans_and_stops_are_summarised_once_per_cooldown() {
    let h = scratch("orphan-adv");
    write_settings(&h, json!({"procwatch": {"devServerMode": "kill"}}));
    let mut f = orphan_fixture();
    publish(&mut f, &h);
    let env = script_env(&h, None);
    let p = json!({"session_id": "s1"});
    let t = text_of(&advise(&env, "SessionStart", &p));
    assert!(t.contains("left behind by ended Claude sessions") && t.contains("vite") && t.contains("dev_server=kill") && t.contains("Stopped 2 orphan"), "{t}");
    assert_eq!(advise(&env, "UserPromptSubmit", &p), Verdict::Allow, "not repeated inside the cooldown");
    // report mode: listed, with the way to opt in, and no stop line
    let h2 = scratch("orphan-adv2");
    publish(&mut orphan_fixture(), &h2);
    let t = text_of(&advise(&script_env(&h2, None), "SessionStart", &p));
    assert!(t.contains("Nothing was stopped") && !t.contains("Stopped "), "{t}");
}

// ---------------------------------------------------------------------------------------------------------------------
// stuck agents (the silent-agent-nudge check at UserPromptSubmit)
// ---------------------------------------------------------------------------------------------------------------------

fn heartbeat(home: &Path, id: &str, session: &str, status: &str, age_min: f64) {
    let dir = home.join(".anti-hall/agents");
    std::fs::create_dir_all(&dir).expect("agents dir");
    let ts = (crate::checks::agent_scan::now_ms() - age_min * 60_000.0) as u64;
    std::fs::write(
        dir.join(format!("{id}.json")),
        json!({"id": id, "ts": ts, "status": status, "step": format!("working on {id}"), "session": session}).to_string(),
    )
    .expect("hb");
}

fn stuck(home: &Path, session: &str) -> Verdict {
    let payload = json!({"session_id": session, "hook_event_name": "UserPromptSubmit"});
    crate::script::run_forced("silent-agent-nudge", &payload, &Value::Null, "UserPromptSubmit", &script_env(home, None))
        .expect("a shipped script")
        .unwrap_or(Verdict::Allow)
}

#[test]
fn a_silent_agent_of_this_session_is_named_once_and_never_stopped() {
    let h = scratch("stuck");
    heartbeat(&h, "fresh-one", "s1", "running", 3.0);
    heartbeat(&h, "stuck-one", "s1", "running", 45.0);
    heartbeat(&h, "done-one", "s1", "done", 90.0);
    heartbeat(&h, "foreign-one", "s2", "running", 90.0);
    let Verdict::Advisory(j) = stuck(&h, "s1") else { panic!("an advisory naming the stuck agent") };
    assert!(j.contains("stuck-one") && j.contains("no output for 20+ minutes") && j.contains("Nothing was stopped"), "{j}");
    assert!(!j.contains("fresh-one") && !j.contains("done-one") && !j.contains("foreign-one"));
    assert_eq!(stuck(&h, "s1"), Verdict::Allow, "the per-agent cooldown holds");
    write_settings(&h, json!({"procwatch": {"enabled": false}}));
    heartbeat(&h, "another", "s1", "running", 60.0);
    assert_eq!(stuck(&h, "s1"), Verdict::Allow, "the master switch");
    write_settings(&h, json!({"procwatch": {"stuckMinutes": 120}}));
    assert_eq!(stuck(&h, "s1"), Verdict::Allow, "under the configured threshold");
}

// ---------------------------------------------------------------------------------------------------------------------
// platform fixtures: the text each OS family hands back
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn linux_proc_files_parse_from_fixtures() {
    let env = host::parse_environ_block(b"PATH=/usr/bin\0CLAUDECODE=1\0CLAUDE_PID=1234\0EMPTY=\0junk\0=novalue\0");
    assert_eq!(host::env_get(&env, "CLAUDE_PID"), Some("1234"));
    assert_eq!(host::env_get(&env, "EMPTY"), Some(""));
    assert_eq!(host::env_get(&env, "junk"), None);
    assert_eq!(env.len(), 4);
    let psi = "some avg10=12.34 avg60=3.00 avg300=1.00 total=123456\nfull avg10=1.50 avg60=0.00 avg300=0.00 total=99\n";
    assert_eq!(host::parse_psi(psi), Some(12.34));
    assert_eq!(host::parse_psi("full avg10=1.50\n"), None);
    assert_eq!(host::parse_psi("some avg10=oops\n"), None);
    assert_eq!(host::parse_psi(""), None);
}

#[test]
fn macos_style_data_is_handled_where_linux_would_differ() {
    // macOS: a protected binary's environment is unreadable (None) while an ordinary one is readable; the command is the full line
    let h = scratch("macos-shape");
    let mut f = orphan_fixture();
    f.rows.push(row(960, 1, 5 * DAY, "/usr/bin/sleep 3600")); // SIP binary: environment unreadable
    assert!(classify_with(&mut f, &h).iter().all(|x| x.pid != 960));
    // footprint, not resident size, is what a macOS row carries: a compressed process still counts
    let st = settings_for(&h);
    let out = run_samples(|_| session_tree(1.0, 5000), 1, &st, MemInfo { swap_used: 0, pressure: Pressure::MacLevel(1) });
    assert_eq!(out[0].1[0].kind, "memory");
}

// ---------------------------------------------------------------------------------------------------------------------
// a real run on this machine: dummy processes in a scratch HOME. The candidate set is restricted to the dummy.
// ---------------------------------------------------------------------------------------------------------------------

/// The real host, shown only the processes it is allowed to see, with a clock moved forward so a fresh dummy is "old".
struct Only {
    inner: RealHost,
    keep: HashSet<u32>,
    skew: u64,
}

impl Host for Only {
    fn now_s(&self) -> u64 {
        self.inner.now_s() + self.skew
    }
    fn procs(&mut self) -> Vec<ProcRow> {
        self.inner.procs().into_iter().filter(|r| self.keep.contains(&r.pid)).collect()
    }
    fn proc_row(&mut self, pid: u32) -> Option<ProcRow> {
        self.keep.contains(&pid).then(|| self.inner.proc_row(pid)).flatten()
    }
    fn environ(&mut self, pid: u32) -> Option<Vec<(String, String)>> {
        self.inner.environ(pid)
    }
    fn cwd(&mut self, pid: u32) -> Option<PathBuf> {
        self.inner.cwd(pid)
    }
    fn mem(&mut self) -> MemInfo {
        self.inner.mem()
    }
    fn space(&self, path: &Path) -> Option<Space> {
        self.inner.space(path)
    }
    fn signal(&mut self, pid: u32, forced: bool) -> bool {
        assert!(self.keep.contains(&pid), "the real run may only signal its own dummy");
        self.inner.signal(pid, forced)
    }
    fn renice(&mut self, pid: u32, nice: i32) -> bool {
        self.inner.renice(pid, nice)
    }
    fn sleep_ms(&mut self, ms: u64) {
        self.inner.sleep_ms(ms)
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// A dummy orphan, ended when the test ends whatever happens.
struct Dummy(u32);

impl Drop for Dummy {
    fn drop(&mut self) {
        // SAFETY: ending the dummy this test started; a pid that is already gone is fine.
        unsafe { libc::kill(self.0 as libc::pid_t, libc::SIGKILL) };
    }
}

/// The sleeper the dummy runs: this test binary, started again by `spawn_orphan_dummy` with the marker argument `ah-dummy-run`. Run normally it
/// does nothing.
#[test]
#[ignore = "started as a child process by the real-run test; does nothing without the marker argument"]
fn dummy_sleeper() {
    if std::env::args().any(|a| a == "ah-dummy-run") {
        std::thread::sleep(std::time::Duration::from_secs(120));
    }
}

/// Start a dummy that is reparented to init and carries the Claude marker with a dead owner. It is this test binary (linked or
/// copied under the scratch directory: a system binary hides its environment on macOS, and a path under the plugin's state
/// directory is protected on purpose).
fn spawn_orphan_dummy(dir: &Path) -> Dummy {
    let me = std::env::current_exe().expect("test exe");
    let exe = dir.join("ah-dummy-sleeper");
    if std::fs::hard_link(&me, &exe).is_err() {
        std::fs::copy(&me, &exe).expect("copy test exe");
    }
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{} --exact procwatch::tests::dummy_sleeper ah-dummy-run --ignored >/dev/null 2>&1 & echo $!", exe.display()))
        .env("CLAUDECODE", "1")
        .env("CLAUDE_PID", "4000000")
        .env("CLAUDE_CODE_SESSION_ID", "dummy-session")
        .output()
        .expect("spawn dummy");
    Dummy(String::from_utf8_lossy(&out.stdout).trim().parse().expect("dummy pid"))
}

fn real_host_for(pid: u32) -> Only {
    Only { inner: RealHost::new(), keep: [pid].into_iter().collect(), skew: 2 * 3600 }
}

#[test]
fn real_run_report_mode_leaves_the_dummy_alive_and_kill_mode_stops_it() {
    let h = scratch("real");
    let dummy = spawn_orphan_dummy(&h);
    let pid = dummy.0;
    let mut host = real_host_for(pid);
    // wait until the system lists the dummy as reparented (the shell that started it has exited)
    let mut seen = false;
    for _ in 0..50 {
        if host.procs().first().is_some_and(|r| r.ppid <= 1 && r.cmd.contains("ah-dummy-sleeper")) {
            seen = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(seen, "the dummy was reparented to init");
    let mut sw = Sweep::default();
    let state = h.join("state");
    let mut readable = false;
    for _ in 0..30 {
        if host.environ(pid).is_some() {
            readable = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // report mode (the default): listed, never signalled
    run_with(&mut host, &mut sw, &state, &h.to_string_lossy(), &|_, _, _| {}).expect("sweep");
    let report: Value = serde_json::from_str(&std::fs::read_to_string(state.join("procwatch-report.json")).expect("report")).expect("json");
    assert!(alive(pid), "report mode kills nothing");
    if !readable {
        assert_eq!(report["orphans"]["count"], 0, "an environment the system hides is never acted on");
        return;
    }
    assert_eq!(report["orphans"]["count"], 1);
    assert!(matches!(report["orphans"]["listed"][0]["class"].as_str(), Some("other" | "shell_task")), "{report}");
    // kill mode for that class: TERM ends it
    write_settings(&h, json!({"procwatch": {"otherMode": "kill", "shellTaskMode": "kill"}}));
    let mut sw = Sweep::default();
    run_with(&mut host, &mut sw, &state, &h.to_string_lossy(), &|_, _, _| {}).expect("sweep");
    let mut gone = false;
    for _ in 0..50 {
        if !alive(pid) {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(gone, "kill mode stopped the dummy");
}

#[test]
fn real_machine_smoke_the_host_reads_processes_memory_and_disk() {
    let mut host = RealHost::new();
    let rows = host.procs();
    let me = rows.iter().find(|r| r.pid == std::process::id()).expect("this process is listed");
    assert!(me.start_s > 1_700_000_000 && me.mem_bytes > 0 && !me.cmd.is_empty());
    assert!(rows.iter().any(|r| r.pid == 1), "init is listed");
    let again = host.procs();
    assert!(again.iter().any(|r| r.pid == me.pid));
    let sp = host.space(&std::env::temp_dir()).expect("statvfs of the temp dir");
    assert!(sp.total > sp.free && sp.free > 0);
    let m = host.mem();
    assert!(m.swap_used < 1 << 50);
    if cfg!(target_os = "macos") {
        assert!(matches!(m.pressure, Pressure::MacLevel(_) | Pressure::Unknown));
    }
    // our own environment is readable
    assert!(host.environ(std::process::id()).is_some_and(|e| host::env_get(&e, "PATH").is_some()));
    // a sweep with the real host never signals anything in report mode and costs little
    let h = scratch("smoke");
    let mut sw = Sweep::default();
    let t = std::time::Instant::now();
    run_with(&mut host, &mut sw, &h.join("state"), &h.to_string_lossy(), &|_, _, _| {}).expect("sweep");
    let cost = t.elapsed();
    eprintln!("procwatch smoke: {} processes, first sweep {:?}", rows.len(), cost);
    assert!(cost < std::time::Duration::from_secs(5));
}

// ---------------------------------------------------------------------------------------------------------------------
// shadow: the report-mode decisions against the Node originals that have an equivalent
// ---------------------------------------------------------------------------------------------------------------------

fn node_available() -> bool {
    std::process::Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

#[test]
fn shadow_stuck_agents_match_the_node_watchdog_on_heartbeats() {
    if !node_available() {
        eprintln!("node not installed: shadow comparison skipped");
        return;
    }
    let home = scratch("shadow-hb");
    let dir = home.join(".anti-hall/agents");
    std::fs::create_dir_all(&dir).expect("agents dir");
    let now_ms = crate::checks::agent_scan::now_ms();
    let min = 60_000.0;
    // (id, age in minutes, status): the Node watchdog lists everything past the threshold; the engine skips finished statuses
    let fixtures = [("a-fresh", 3.0, "running"), ("b-stuck", 45.0, "running"), ("c-very-stuck", 300.0, "running"), ("d-edge-under", 19.0, "working")];
    for (id, age, status) in fixtures {
        let ts = (now_ms - age * min) as u64;
        std::fs::write(dir.join(format!("{id}.json")), json!({"id": id, "ts": ts, "status": status, "step": "x", "session": "s1"}).to_string()).expect("hb");
    }
    let out = std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/hooks/agent-watchdog.js"))
        .arg((20.0 * min).to_string())
        .env("HOME", &home)
        .output()
        .expect("run watchdog");
    let node: std::collections::BTreeSet<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("STALE "))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect();
    // the stuck-agent advisory (the silent-agent-nudge script at UserPromptSubmit) names the agents of this session it finds silent
    let advisory = match stuck(&home, "s1") {
        Verdict::Advisory(j) => j,
        other => panic!("an advisory naming the stuck agents: {other:?}"),
    };
    let engine: std::collections::BTreeSet<String> =
        fixtures.iter().map(|(id, ..)| id.to_string()).filter(|id| advisory.contains(&format!("[{id}]"))).collect();
    assert_eq!(engine, node, "the engine's stuck set equals the Node watchdog's for running agents of the session");
    assert_eq!(engine, ["b-stuck", "c-very-stuck"].into_iter().map(str::to_string).collect());
}

/// Whether the Node session-end reaper (the shadow of the engine's `session-end-mcp-reaper` script) selects `cmd` as an orphaned
/// MCP server: parent PID 1, an MCP signature, not a test runner or dev server.
fn node_reaper_selects(cmd: &str) -> bool {
    let hooks = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/hooks");
    let js = "const r=require(process.argv[1]+'/session-end-mcp-reaper.js');const m=require(process.argv[1]+'/../companion/mcp-reaper.js');process.stdout.write(String(r.matchesInvariant({pid:10,ppid:1,cmd:process.argv[2]},m,null,null)));";
    let out = std::process::Command::new("node").args(["-e", js]).arg(&hooks).arg(cmd).output().expect("run node");
    String::from_utf8_lossy(&out.stdout) == "true"
}

#[test]
fn shadow_mcp_orphans_are_a_superset_of_what_the_mcp_reaper_selects() {
    let h = scratch("shadow-mcp");
    let cfg = cfg_default(&h);
    let class = "mcp_server";
    let cmds = [
        "node /home/u/.npm/_npx/abc/node_modules/.bin/mcp-server-fetch",
        "npx -y @modelcontextprotocol/server-filesystem /tmp",
        "uvx mcp-server-git --repository /work/repo",
        "node /opt/tools/chrome-devtools-mcp/index.js",
        "mcp start",
        "node server-sequential-thinking.js",
        "node /work/app/vitest.js", // never an MCP server
        "/usr/bin/vim notes.txt",
    ];
    for cmd in cmds {
        let reaper = node_reaper_selects(cmd);
        let mut f = Fake { rows: vec![row(1, 0, 9 * DAY, "/sbin/launchd"), row(10, 1, 9 * DAY, cmd)], ..Fake::default() };
        f.envs.insert(10, marked(4_000_000));
        let rows = f.rows.clone();
        let found = orphan::classify(&mut f, &rows, &cfg, &HashSet::new());
        let ours = found.iter().any(|x| x.class == class);
        if reaper {
            assert!(ours, "procwatch must report every process the MCP reaper would select, missed: {cmd}");
        }
        assert!(!found.iter().any(|x| x.class == class) || reaper || cmd.contains("mcp"), "{cmd}");
    }
}

#[test]
fn the_shipped_dev_example_classes_parse_and_separate_a_test_daemon_from_the_live_engine() {
    let h = scratch("example");
    let dir = h.join(".anti-hall/ah-engine");
    std::fs::create_dir_all(&dir).expect("state dir");
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/examples/procwatch-dev.toml"), dir.join("procwatch-classes.toml"))
        .expect("copy example");
    let mut f = Fake {
        rows: vec![
            row(1, 0, 10 * DAY, "/sbin/launchd"),
            row(10, 1, 5 * 3600, "/Users/u/.anti-hall/work/wt-a/ah-engine/target/debug/ah-engine serve"),
            row(11, 1, 5 * 3600, "/Users/u/.anti-hall/ah-engine/bin/ah-engine serve"),
            row(12, 1, 5 * 3600, "/Users/u/.anti-hall/ah-engine-live/bundle/ah-engine serve"),
            row(13, 1, 2 * 3600, "sleep 3600"),
            row(14, 1, 2 * 3600, "sleep 4"),
            row(15, 1, 2 * 3600, "cargo test --release"),
        ],
        ..Fake::default()
    };
    for p in [10, 11, 12, 13, 14, 15] {
        f.envs.insert(p, marked(4_000_000));
    }
    let found = classify_with(&mut f, &h);
    let got: Vec<(u32, &str)> = found.iter().map(|x| (x.pid, x.class.as_str())).collect();
    assert_eq!(
        got,
        vec![(10, "test_daemon"), (13, "test_sleeper"), (14, "other"), (15, "cargo_children")],
        "the live engine is left alone; a short sleeper is only the catch-all class once it is an hour old"
    );
    assert!(found.iter().all(|x| x.mode == orphan::Mode::Report));
}
