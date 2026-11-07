//! The engine process census: how many engine processes of each kind run on this machine, and which of them are more than the design
//! allows. The design is ONE long-lived `ah-engine serve` (the daemon, the single source of truth); everything else is a short-lived
//! job or hook client, or a legacy per-session wake watcher that is counted and warned about, never stopped.
//!
//! The classes, their command patterns, the ages and the texts are all configuration (`doctor.census.*` in `doctor.toml`); this module
//! only counts. It never signals a process: more than one `serve` is a P0 *report* (an alert with a stable kind), and the scheduled
//! sweep ([`super::run_job`]) and `doctor` both read the same classification, so every surface shows the same line.
//!
//! A process is *stale* when the executable image it runs is not the file now at the current engine binary path (a deploy replaced it
//! and the process kept running the old image): [`crate::procid::exe_ident`] reads the running image, so the check holds after the path
//! was replaced.
use super::host::{Host, ProcRow, env_get};
use crate::defaults;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One census class: a name and the command pattern that puts a process in it (first match wins).
struct Class {
    name: String,
    cmd: Regex,
    stale_check: bool,
}

/// The configuration of a census, read from `doctor.toml`.
pub struct Cfg {
    classes: Vec<Class>,
    session_re: Regex,
    /// A hook client older than this many seconds is slow (`client.deadline_ms` x `doctor.census_client_age_mult`).
    client_age_s: u64,
    /// A job older than this many seconds is leaked.
    job_age_s: u64,
    current_bin: PathBuf,
}

impl Cfg {
    /// Read the configuration; `None` when a pattern does not compile (reported once).
    pub fn load() -> Option<Cfg> {
        let mut classes = Vec::new();
        for c in defaults::raw("doctor.census_classes").as_array().unwrap_or(&[]) {
            let cmd = compile(c.str_field("cmd_re"), c.str_field("name"))?;
            classes.push(Class { name: c.str_field("name").to_string(), cmd, stale_check: c.get("stale_check").and_then(|v| v.as_bool()).unwrap_or(false) });
        }
        let session_re = compile(defaults::text("procwatch.session_cmd_re"), "session_cmd_re")?;
        let client_ms = defaults::num("client.deadline_ms").saturating_mul(defaults::num("doctor.census_client_age_mult"));
        Some(Cfg {
            classes,
            session_re,
            client_age_s: client_ms.div_ceil(1000).max(1),
            job_age_s: defaults::num("doctor.census_job_max_age_s"),
            current_bin: crate::paths::dir().join(defaults::text("doctor.census_current_bin_rel")),
        })
    }
}

fn compile(src: &str, what: &str) -> Option<Regex> {
    match Regex::new(src) {
        Ok(r) => Some(r),
        Err(e) => {
            crate::discard::note("census_bad_pattern", &format!("{what}: {e}"));
            None
        }
    }
}

/// What the census found: the pids of each class (sorted), the live sessions, and the processes past their age.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Census {
    /// When the census was taken, seconds since the epoch.
    pub ts_s: u64,
    /// `ah-engine serve` processes of the live state directory (the design allows exactly one).
    pub serve: Vec<u32>,
    /// `ah-engine serve` processes of another state directory (a test run, a second setup).
    pub serve_nonlive: Vec<u32>,
    /// Scheduled jobs the daemon started.
    pub jobs: Vec<u32>,
    /// Other `ah-engine` processes (hook calls, CLI calls), short-lived.
    pub clients: Vec<u32>,
    /// Per-session wake watchers of the old design (`agents` / `devswarm wake-watch`).
    pub legacy: Vec<u32>,
    /// Thin per-session stubs (no stub verb ships, so this stays 0).
    pub stubs: Vec<u32>,
    /// Engine processes running a replaced binary image.
    pub stale: Vec<u32>,
    /// Jobs and clients older than their limit.
    pub slow: Vec<u32>,
    /// Live Claude sessions.
    pub sessions: usize,
}

impl Census {
    /// More than one long-lived `serve`: the P0 condition.
    pub fn multi_instance(&self) -> bool {
        self.serve.len() > 1
    }

    /// The one census line every surface prints.
    pub fn line(&self) -> String {
        defaults::render(
            "doctor.census_line",
            &[
                ("serve", &self.serve.len()),
                ("jobs", &self.jobs.len()),
                ("clients", &self.clients.len()),
                ("stubs", &self.stubs.len()),
                ("sessions", &self.sessions),
                ("legacy", &self.legacy.len()),
                ("stale", &self.stale.len()),
            ],
        )
    }

    /// The census as JSON for `CTL status` and the report file: the line, every count, and the pids of each class (bounded).
    pub fn to_json(&self) -> Value {
        let max = defaults::num("doctor.census_max_listed") as usize;
        let pids = |v: &[u32]| v.iter().take(max).copied().collect::<Vec<u32>>();
        json!({
            "ts_s": self.ts_s,
            "line": self.line(),
            "counts": {
                "serve": self.serve.len(), "serve_nonlive": self.serve_nonlive.len(), "job": self.jobs.len(), "hook_client": self.clients.len(),
                "legacy_watcher": self.legacy.len(), "stub": self.stubs.len(), "stale_binary": self.stale.len(), "slow": self.slow.len(), "sessions": self.sessions,
            },
            "pids": {
                "serve": pids(&self.serve), "serve_nonlive": pids(&self.serve_nonlive), "job": pids(&self.jobs), "hook_client": pids(&self.clients),
                "legacy_watcher": pids(&self.legacy), "stub": pids(&self.stubs), "stale_binary": pids(&self.stale), "slow": pids(&self.slow),
            },
            "multi_instance": self.multi_instance(),
        })
    }

    /// The census read back from its JSON (the file the sweep writes): `None` when it is not a census.
    pub fn from_json(v: &Value) -> Option<Census> {
        let pids =
            |k: &str| -> Vec<u32> { v["pids"][k].as_array().map(|a| a.iter().filter_map(|p| p.as_u64().map(|p| p as u32)).collect()).unwrap_or_default() };
        let count = |k: &str| v["counts"][k].as_u64().unwrap_or(0) as usize;
        // the pid lists are bounded, the counts are exact: pad a bounded list so its length is the count
        let pad = |k: &str| {
            let mut p = pids(k);
            p.resize(count(k).max(p.len()), 0);
            p
        };
        v["line"].as_str()?;
        Some(Census {
            ts_s: v["ts_s"].as_u64()?,
            serve: pad("serve"),
            serve_nonlive: pad("serve_nonlive"),
            jobs: pad("job"),
            clients: pad("hook_client"),
            legacy: pad("legacy_watcher"),
            stubs: pad("stub"),
            stale: pad("stale_binary"),
            slow: pad("slow"),
            sessions: count("sessions"),
        })
    }
}

/// Count the engine processes in `rows`. `is_live_state` says whether a state directory is the installed live one; `own` are the pids
/// never counted (this process and its ancestors: the caller that asks is not a finding).
pub fn classify(host: &mut dyn Host, rows: &[ProcRow], cfg: &Cfg, own: &HashSet<u32>, is_live_state: &dyn Fn(&Path) -> bool) -> Census {
    let now = host.now_s();
    let mut c = Census { ts_s: now, ..Census::default() };
    let current = crate::procid::file_ident(&cfg.current_bin);
    let class_of = |cmd: &str| cfg.classes.iter().find(|k| k.cmd.is_match(cmd));
    let is = |k: &Class, key: &str| k.name == defaults::text(key);
    // pass 1: the daemons, so a job can be told from a client by its parent
    let mut daemons: HashSet<u32> = HashSet::new();
    for r in rows.iter().filter(|r| !own.contains(&r.pid)) {
        if class_of(&r.cmd).is_some_and(|k| is(k, "doctor.census_class_serve")) {
            daemons.insert(r.pid);
            let live = host
                .environ(r.pid)
                .and_then(|e| {
                    env_get(&e, defaults::env_name("dir")).filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| crate::doctor::runtime::state_from_env(&e))
                })
                .is_none_or(|state| is_live_state(&state));
            if live {
                c.serve.push(r.pid);
            } else {
                c.serve_nonlive.push(r.pid);
            }
        }
    }
    for r in rows.iter().filter(|r| !own.contains(&r.pid)) {
        if cfg.session_re.is_match(&r.cmd) {
            c.sessions += 1;
        }
        let Some(k) = class_of(&r.cmd) else { continue };
        let age = now.saturating_sub(r.start_s);
        if is(k, "doctor.census_class_serve") {
            // counted in pass 1
        } else if is(k, "doctor.census_class_legacy") {
            c.legacy.push(r.pid);
        } else if is(k, "doctor.census_class_stub") {
            c.stubs.push(r.pid);
        } else if is(k, "doctor.census_class_job") && daemons.contains(&r.ppid) {
            c.jobs.push(r.pid);
            if age > cfg.job_age_s {
                c.slow.push(r.pid);
            }
        } else {
            c.clients.push(r.pid);
            if age > cfg.client_age_s {
                c.slow.push(r.pid);
            }
        }
        if k.stale_check
            && let (Some(now_id), Some(run_id)) = (current, host.exe_ident(r.pid))
            && now_id != run_id
        {
            c.stale.push(r.pid);
        }
    }
    for v in [&mut c.serve, &mut c.serve_nonlive, &mut c.jobs, &mut c.clients, &mut c.legacy, &mut c.stubs, &mut c.stale, &mut c.slow] {
        v.sort_unstable();
        v.dedup();
    }
    c
}

/// Take the census of this machine now.
pub fn take(host: &mut dyn Host, cfg: &Cfg) -> Census {
    let rows = host.procs();
    let own = super::own_pids(&rows);
    classify(host, &rows, cfg, &own, &|state| crate::doctor::runtime::live_state_dir(state))
}

static LATEST: Mutex<Option<Census>> = Mutex::new(None);

/// Remember the census the sweep just took (the daemon's `CTL status` and metrics read it).
pub fn remember(c: &Census) {
    *LATEST.lock().unwrap_or_else(|e| e.into_inner()) = Some(c.clone());
}

/// The census the sweep took last, if any.
pub fn latest() -> Option<Census> {
    LATEST.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The P0 alert document for a multi-instance condition: ONE document with a stable kind (no pid, uid or session in it), the pids in
/// `details` and a bounded occurrences array, so a repeat of the condition aggregates into the same document instead of adding one.
/// `prev` is the document the last scan left (or null); `c` the census just taken; the result is what to store.
pub fn alert_doc(prev: &Value, c: &Census) -> Value {
    let kind = defaults::text("doctor.census_p0_kind");
    let max_listed = (defaults::num("doctor.census_max_listed") as usize).max(1);
    let max_occ = (defaults::num("procwatch.census_max_occurrences") as usize).max(1);
    let same = prev["kind"] == json!(kind);
    let first = if same { prev["first_ts_s"].as_u64().unwrap_or(c.ts_s) } else { c.ts_s };
    let mut occ: Vec<Value> = if same { prev["occurrences"].as_array().cloned().unwrap_or_default() } else { Vec::new() };
    let mut count = if same { prev["count"].as_u64().unwrap_or(0) } else { 0 };
    let active = c.multi_instance();
    if active {
        count += 1;
        occ.push(json!({"ts_s": c.ts_s, "serve": c.serve.len()}));
        if occ.len() > max_occ {
            occ.drain(..occ.len() - max_occ);
        }
    }
    json!({
        "kind": kind, "severity": defaults::text("doctor.census_p0_severity"), "active": active,
        "count": count, "first_ts_s": first, "last_ts_s": if active { c.ts_s } else { prev["last_ts_s"].as_u64().unwrap_or(0) },
        "details": {"serve": c.serve.len(), "pids": c.serve.iter().take(max_listed).copied().collect::<Vec<u32>>()},
        "occurrences": occ,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::procwatch::host::{MemInfo, Pressure, Space};

    struct Fake {
        rows: Vec<ProcRow>,
        idents: Vec<(u32, (u64, u64))>,
        env: Vec<(String, String)>,
        signals: usize,
    }

    impl Host for Fake {
        fn now_s(&self) -> u64 {
            NOW
        }
        fn procs(&mut self) -> Vec<ProcRow> {
            self.rows.clone()
        }
        fn proc_row(&mut self, _: u32) -> Option<ProcRow> {
            None
        }
        fn environ(&mut self, _: u32) -> Option<Vec<(String, String)>> {
            Some(self.env.clone())
        }
        fn cwd(&mut self, _: u32) -> Option<PathBuf> {
            None
        }
        fn mem(&mut self) -> MemInfo {
            MemInfo { swap_used: 0, pressure: Pressure::Unknown, ram_total: 0, ram_free: 0 }
        }
        fn space(&self, _: &Path) -> Option<Space> {
            None
        }
        fn signal(&mut self, _: u32, _: bool) -> bool {
            self.signals += 1;
            false
        }
        fn renice(&mut self, _: u32, _: i32) -> bool {
            false
        }
        fn sleep_ms(&mut self, _: u64) {}
        fn exe_ident(&mut self, pid: u32) -> Option<(u64, u64)> {
            self.idents.iter().find(|(p, _)| *p == pid).map(|(_, i)| *i)
        }
    }

    fn row(pid: u32, ppid: u32, age: u64, cmd: &str) -> ProcRow {
        ProcRow { pid, ppid, start_s: NOW - age, cpu_pct: 0.0, mem_bytes: 0, cmd: cmd.to_string() }
    }

    const NOW: u64 = 1_000_000;
    const BIN: &str = "/h/.anti-hall/ah-engine/bin/ah-engine";

    /// A census configuration whose "current binary" is a real temp file, so the stale check has an inode to compare.
    fn cfg_with_bin(bin: &Path) -> Cfg {
        let mut cfg = Cfg::load().expect("shipped census config");
        cfg.current_bin = bin.to_path_buf();
        cfg
    }

    fn temp_bin(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("census-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("ah-engine");
        std::fs::write(&bin, b"x").unwrap();
        bin
    }

    fn fake(rows: Vec<ProcRow>) -> Fake {
        Fake { rows, idents: Vec::new(), env: vec![(defaults::env_name("dir").to_string(), "/live".to_string())], signals: 0 }
    }

    fn run(f: &mut Fake, cfg: &Cfg) -> Census {
        let rows = f.rows.clone();
        classify(f, &rows, cfg, &HashSet::new(), &|s| s == Path::new("/live"))
    }

    #[test]
    fn one_serve_is_the_design_and_prints_serve_1_with_no_alert() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("one"));
        let mut f = fake(vec![row(100, 1, 5000, &format!("{BIN} serve --start-reason hook-client")), row(200, 100, 3, &format!("{BIN} agent_tick --json"))]);
        let c = run(&mut f, &cfg);
        assert_eq!((c.serve.clone(), c.jobs.clone(), c.legacy.len(), c.stale.len()), (vec![100], vec![200], 0, 0));
        assert_eq!(c.line(), "engine: serve=1 jobs=1 clients=0 stubs=0/0 legacy=0 stale=0");
        assert!(!c.multi_instance());
        assert_eq!(alert_doc(&Value::Null, &c)["active"], json!(false));
        assert_eq!(f.signals, 0, "the census never signals");
    }

    #[test]
    fn two_serve_is_p0_and_the_alert_has_a_stable_kind_with_the_pids_in_details() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("two"));
        let mut f = fake(vec![row(100, 1, 5000, &format!("{BIN} serve")), row(101, 1, 40, &format!("{BIN} serve --start-reason hook-client"))]);
        let c = run(&mut f, &cfg);
        assert!(c.multi_instance());
        assert!(c.line().starts_with("engine: serve=2 "));
        let doc = alert_doc(&Value::Null, &c);
        assert_eq!(doc["kind"], "engine_multi_instance");
        assert!(!doc["kind"].as_str().unwrap().contains(|ch: char| ch.is_ascii_digit()), "no pid or id in the kind");
        assert_eq!(doc["details"]["pids"], json!([100, 101]));
        assert_eq!((doc["count"].clone(), doc["active"].clone()), (json!(1), json!(true)));
        // the same condition again aggregates into the same document
        let again = alert_doc(&doc, &Census { ts_s: c.ts_s + 300, ..c.clone() });
        assert_eq!(
            (again["kind"].clone(), again["count"].clone(), again["first_ts_s"].clone()),
            (json!("engine_multi_instance"), json!(2), doc["first_ts_s"].clone())
        );
        assert_eq!(again["occurrences"].as_array().unwrap().len(), 2);
        // the condition clears: the document stays (history), inactive
        let cleared = alert_doc(&again, &Census { serve: vec![100], ..c.clone() });
        assert_eq!((cleared["active"].clone(), cleared["count"].clone()), (json!(false), json!(2)));
        assert_eq!(f.signals, 0);
    }

    #[test]
    fn the_occurrences_array_is_bounded() {
        crate::defaults::init().unwrap();
        let cap = defaults::num("procwatch.census_max_occurrences") as usize;
        let mut doc = Value::Null;
        for i in 0..cap + 7 {
            doc = alert_doc(&doc, &Census { ts_s: i as u64, serve: vec![1, 2], ..Census::default() });
        }
        assert_eq!(doc["occurrences"].as_array().unwrap().len(), cap);
        assert_eq!(doc["count"], json!(cap + 7));
    }

    #[test]
    fn a_serve_of_another_state_directory_is_not_a_second_live_instance() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("nonlive"));
        let mut f = fake(vec![row(100, 1, 5000, &format!("{BIN} serve")), row(101, 1, 40, "/scratch/h/.anti-hall/ah-engine/bin/ah-engine serve")]);
        let c = run(&mut f, &cfg);
        assert_eq!(c.serve.len(), 2, "both read the same fake environment, both live");
        f.env = vec![(defaults::env_name("dir").to_string(), "/elsewhere".to_string())];
        let c = run(&mut f, &cfg);
        assert_eq!((c.serve.len(), c.serve_nonlive.len()), (0, 2));
        assert!(!c.multi_instance());
    }

    #[test]
    fn a_legacy_watcher_is_counted_and_never_signalled() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("legacy"));
        let mut f = fake(vec![
            row(100, 1, 5000, &format!("{BIN} serve")),
            row(300, 77, 90_000, &format!("{BIN} agents wake-watch --auto")),
            row(301, 77, 90_000, &format!("{BIN} devswarm wake-watch --auto")),
        ]);
        let c = run(&mut f, &cfg);
        assert_eq!(c.legacy, vec![300, 301]);
        assert_eq!(c.serve, vec![100]);
        assert!(!c.multi_instance(), "legacy watchers are warned about, not the P0");
        assert_eq!(f.signals, 0);
    }

    #[test]
    fn a_process_running_a_replaced_image_is_stale_and_a_current_one_is_not() {
        crate::defaults::init().unwrap();
        let bin = temp_bin("stale");
        let cfg = cfg_with_bin(&bin);
        let now = crate::procid::file_ident(&bin).unwrap();
        let mut f = fake(vec![
            row(100, 1, 5000, &format!("{BIN} serve")),
            row(300, 77, 90_000, &format!("{BIN} agents wake-watch --auto")),
            row(301, 77, 90_000, &format!("{BIN} agents wake-watch --auto")),
            row(302, 77, 90_000, &format!("{BIN} agents wake-watch --auto")),
        ]);
        f.idents = vec![(100, now), (300, (now.0, now.1 + 1)), (301, now)];
        let c = run(&mut f, &cfg);
        assert_eq!(c.stale, vec![300], "301 runs the current image; 302's image is unknown, which is never stale");
    }

    #[test]
    fn jobs_and_clients_are_told_apart_by_the_parent_and_old_ones_are_slow() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("age"));
        let mut f = fake(vec![
            row(100, 1, 5000, &format!("{BIN} serve")),
            row(200, 100, 5, &format!("{BIN} maintain --json")),
            row(201, 100, defaults::num("doctor.census_job_max_age_s") + 5, &format!("{BIN} backup --json")),
            row(202, 55, 2, &format!("{BIN} maintain --json")),
            row(203, 55, 100_000, &format!("{BIN} ctl status")),
        ]);
        let c = run(&mut f, &cfg);
        assert_eq!((c.jobs.clone(), c.clients.clone(), c.slow.clone()), (vec![200, 201], vec![202, 203], vec![201, 203]));
    }

    #[test]
    fn the_stub_class_stays_at_zero_and_sessions_are_counted_for_the_line() {
        crate::defaults::init().unwrap();
        let cfg = cfg_with_bin(&temp_bin("stub"));
        let mut f = fake(vec![row(100, 1, 5000, &format!("{BIN} serve")), row(400, 1, 9000, "claude"), row(401, 1, 9000, "claude --resume")]);
        let c = run(&mut f, &cfg);
        assert_eq!((c.stubs.len(), c.sessions), (0, 2));
        assert!(c.line().contains("stubs=0/2"));
    }

    #[test]
    fn the_census_round_trips_through_its_json() {
        crate::defaults::init().unwrap();
        let c = Census { ts_s: 5, serve: vec![1], legacy: vec![2, 3], stale: vec![2], sessions: 4, ..Census::default() };
        let back = Census::from_json(&c.to_json()).unwrap();
        assert_eq!((back.serve.clone(), back.legacy.len(), back.stale.clone(), back.sessions, back.line()), (vec![1], 2, vec![2], 4, c.line()));
    }
}
