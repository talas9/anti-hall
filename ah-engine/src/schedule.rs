//! The scheduler and ticker (D33): the engine runs its own jobs; nothing outside it has to trigger them.
//!
//! Jobs come from a [`ScheduleSource`]. Today that is [`FileSource`]: the shipped `defaults/schedules.toml` plus the
//! user's `schedules.json` in the state directory (the config lane's layered, versioned config replaces it later, D18).
//! A job is either an **engine** job (`maintain`, `backup`, `metrics_snapshot`, `spool_drain`, `noop`) that runs
//! inside the engine, or an **agent** job delivered to a session's mailbox through [`AgentDelivery`] (planned, D45:
//! until the mailbox lane lands, such a run is recorded as `planned` and is not a failure).
//!
//! The ticker sleeps until the next job is due (at most `schedule.tick_ms`), then starts every due job on its own
//! thread; a job never overlaps itself. Before a run starts, the job's next time is computed (interval plus jitter) and,
//! for a persisted job, committed to hot.db, so a daemon restart never runs it twice. A missed window (the machine
//! slept, the engine was down) is caught up **once** (or skipped, per job), never once per missed window. A run is
//! bounded by its timeout: a subprocess job is killed with its whole process group; an in-process job is recorded as
//! timed out and the job waits for it before its next run. Failures retry with exponential backoff, then the job cools
//! down. Every run of a persisted job (and every failed run of the others) is kept in hot.db's run history.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - serializing a string cannot fail
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::db::{Db, Op, SchedOp};
use crate::defaults;
use crate::discard::Logged;
use crate::sql;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// One job as configured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec {
    /// Job name.
    pub name: String,
    /// `engine` or `agent`.
    pub kind: String,
    /// What it does.
    pub action: String,
    /// Interval (as resolved when the job was read; the scheduler re-reads `every_key` through the live config).
    pub every_ms: u64,
    /// The setting that holds the interval, or empty when the job gives `every_ms` itself.
    pub every_key: String,
    /// Up to this much random delay is added to each next run.
    pub jitter_ms: u64,
    /// A run longer than this is stopped and counted as failed.
    pub timeout_ms: u64,
    /// Failed runs retried before the job cools down.
    pub retries: u32,
    /// First retry delay (doubles per retry).
    pub backoff_ms: u64,
    /// Longest retry delay.
    pub backoff_max_ms: u64,
    /// Pause after the retries run out.
    pub cooldown_ms: u64,
    /// After a missed window: run once (`true`) or wait for the next window (`false`).
    pub catch_up_once: bool,
    /// Keep the schedule and every run in hot.db (`false`: schedule in memory, failed runs only).
    pub persist: bool,
}

/// Where the jobs come from.
pub trait ScheduleSource: Send + Sync {
    /// The enabled jobs (a job whose interval is 0 is disabled and not listed).
    fn jobs(&self) -> Vec<JobSpec>;
}

/// Shipped jobs (`job.*` in the defaults) overlaid by the user's `schedules.json`.
pub struct FileSource {
    /// The override file.
    pub override_path: PathBuf,
    /// Accept the test-only `test_sleep` action.
    pub test_hooks: bool,
}

fn int(v: Option<i64>) -> u64 {
    v.unwrap_or(0).max(0) as u64
}

impl FileSource {
    /// The source the daemon uses: `schedules.json` in the state directory.
    pub fn standard(test_hooks: bool) -> FileSource {
        FileSource { override_path: crate::paths::dir().join(defaults::text("files.schedules_override")), test_hooks }
    }

    fn shipped() -> Vec<(String, Value)> {
        defaults::all().iter().filter(|e| e.key.starts_with("job.")).map(|e| (e.key["job.".len()..].to_string(), e.value.to_json())).collect()
    }

    /// A job from its JSON form (shipped values with any override fields merged over them).
    fn spec(name: &str, v: &Value, test_hooks: bool) -> Option<JobSpec> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let n = |k: &str| int(v.get(k).and_then(Value::as_i64));
        let (every_ms, every_key) = match v.get("every_ms").and_then(Value::as_i64) {
            Some(ms) => (int(Some(ms)), String::new()),
            None => match v.get("every_key").and_then(Value::as_str) {
                Some(k) if defaults::has(k) => (defaults::num(k), k.to_string()),
                _ => (0, String::new()),
            },
        };
        let action = s("action");
        let known = defaults::list("schedule.actions").contains(&action.as_str()) || (test_hooks && action == "test_sleep");
        if !known || (every_ms == 0 && every_key.is_empty()) {
            if !known {
                crate::health::log_event(
                    "schedule",
                    "unknown_action",
                    &defaults::render("msg.schedule_unknown_action", &[("job", &name), ("action", &action)]),
                );
            }
            return None;
        }
        Some(JobSpec {
            name: name.to_string(),
            kind: s("kind"),
            action,
            every_ms,
            every_key,
            jitter_ms: n("jitter_ms"),
            timeout_ms: n("timeout_ms").max(1),
            retries: n("retries") as u32,
            backoff_ms: n("backoff_ms").max(1),
            backoff_max_ms: n("backoff_max_ms").max(1),
            cooldown_ms: n("cooldown_ms"),
            catch_up_once: s("catch_up") != "skip",
            persist: v.get("persist").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

impl ScheduleSource for FileSource {
    fn jobs(&self) -> Vec<JobSpec> {
        let mut all: Vec<(String, Value)> = FileSource::shipped();
        let user: Value = std::fs::read_to_string(&self.override_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if let Some(jobs) = user.get("jobs").and_then(Value::as_object) {
            for (name, o) in jobs {
                match all.iter_mut().find(|(n, _)| n == name) {
                    Some((_, base)) => {
                        if let (Some(b), Some(o)) = (base.as_object_mut(), o.as_object()) {
                            b.extend(o.clone());
                        }
                    }
                    None => all.push((name.clone(), o.clone())),
                }
            }
        }
        all.iter().filter_map(|(n, v)| FileSource::spec(n, v, self.test_hooks)).collect()
    }
}

/// Delivers an agent-targeted job to a session's mailbox (D33). The mailbox and its Monitor push are a later lane
/// (D45); until then [`PlannedDelivery`] answers that delivery is planned.
pub trait AgentDelivery: Send + Sync {
    /// Deliver `job`; `Ok` with a detail, or `Err` with why not.
    fn deliver(&self, job: &JobSpec) -> Result<String, String>;
    /// True when delivery really exists (false: runs are recorded as planned, never as failures).
    fn available(&self) -> bool;
}

/// The stand-in until the mailbox lane lands (D45).
pub struct PlannedDelivery;

impl AgentDelivery for PlannedDelivery {
    fn deliver(&self, _: &JobSpec) -> Result<String, String> {
        Err(defaults::text("msg.schedule_agent_planned").to_string())
    }
    fn available(&self) -> bool {
        false
    }
}

/// A job's schedule.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobState {
    /// When it runs next (ms since the epoch).
    pub next_ms: u64,
    /// Failed runs since the last success.
    pub failures: u32,
    /// No run before this (ms since the epoch; 0: none).
    pub cooldown_until_ms: u64,
    /// A run is in progress.
    pub running: bool,
}

/// What the ticker should do with a job now.
#[derive(Debug, PartialEq, Eq)]
pub enum Due {
    /// Not yet (or it is running, or cooling down).
    No,
    /// Run it; it was due at `due_ms` (a catch-up when that is a whole interval or more ago).
    Run {
        /// When it was due.
        due_ms: u64,
        /// At least one whole window was missed.
        catch_up: bool,
    },
    /// A window was missed and the job does not catch up: move on to the next window.
    Skip,
}

/// Whether `spec` should run at `now`.
pub fn decide(spec: &JobSpec, st: &JobState, now: u64) -> Due {
    if st.running || now < st.next_ms || now < st.cooldown_until_ms {
        return Due::No;
    }
    let missed = now >= st.next_ms.saturating_add(spec.every_ms);
    if missed && !spec.catch_up_once {
        return Due::Skip;
    }
    Due::Run { due_ms: st.next_ms, catch_up: missed }
}

/// A random value below `n` (0 when `n` is 0); jitter only, so the clock's nanoseconds are random enough.
fn jitter(n: u64) -> u64 {
    if n == 0 {
        return 0;
    }
    let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    (ns ^ (ns >> 7)).wrapping_mul(0x9E37_79B9_7F4A_7C15) % n
}

/// The next run after one that starts at `now`: one interval later plus jitter. Computed from `now`, not from the
/// missed due time, which is what makes a catch-up run once rather than once per missed window.
pub fn next_after(spec: &JobSpec, now: u64) -> u64 {
    now.saturating_add(spec.every_ms).saturating_add(jitter(spec.jitter_ms))
}

/// The schedule after a failed run at `now` whose normal next time is already `st.next_ms`: retry sooner with
/// exponential backoff while retries remain, else cool down (and start counting afresh).
pub fn after_failure(spec: &JobSpec, st: &JobState, now: u64) -> JobState {
    let failures = st.failures + 1;
    if failures <= spec.retries {
        let delay = spec.backoff_ms.saturating_mul(1u64 << (failures - 1).min(30)).min(spec.backoff_max_ms);
        JobState { next_ms: st.next_ms.min(now + delay), failures, cooldown_until_ms: 0, running: st.running }
    } else {
        let until = now.saturating_add(spec.cooldown_ms);
        JobState { next_ms: st.next_ms.max(until), failures: 0, cooldown_until_ms: until, running: st.running }
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// It did its work.
    Ok(String),
    /// It failed.
    Failed(String),
    /// It ran past its timeout.
    Timeout,
    /// The job's delivery does not exist yet (agent jobs, D45); not a failure.
    Planned(String),
}

impl Outcome {
    fn status(&self) -> &'static str {
        match self {
            Outcome::Ok(_) => "ok",
            Outcome::Failed(_) => "failed",
            Outcome::Timeout => "timeout",
            Outcome::Planned(_) => "planned",
        }
    }
    fn detail(&self) -> String {
        let d = match self {
            Outcome::Ok(d) | Outcome::Failed(d) | Outcome::Planned(d) => d.clone(),
            Outcome::Timeout => defaults::text("msg.schedule_timeout").to_string(),
        };
        d.chars().take(defaults::num("schedule.detail_max") as usize).collect()
    }
    fn failed(&self) -> bool {
        matches!(self, Outcome::Failed(_) | Outcome::Timeout)
    }
}

/// Runs an in-process action (`metrics_snapshot`, `spool_drain`, `noop`) inside the daemon.
pub type InProc = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;
/// Told about every finished run: (job, status, it was a catch-up).
pub type Observer = Box<dyn Fn(&str, &str, bool) + Send + Sync>;
/// Reads a numeric setting through the live (layered, hot-swapped) config, for intervals named by `every_key` (D18).
pub type Setting = Box<dyn Fn(&str) -> u64 + Send + Sync>;

#[derive(Default)]
struct Last {
    finished: u64,
    result: Value,
}

/// The scheduler: the jobs, their schedules, and the ticker's wake-up.
pub struct Scheduler {
    jobs: Vec<JobSpec>,
    state: Mutex<HashMap<String, JobState>>,
    last: Mutex<HashMap<String, Last>>,
    wake: (Mutex<bool>, Condvar),
    db: Option<Arc<Db>>,
    inproc: InProc,
    agents: Box<dyn AgentDelivery>,
    observe: Observer,
    setting: Setting,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

impl Scheduler {
    /// A scheduler for `source`'s jobs, with schedules loaded from `db` where kept (and runs a killed daemon left
    /// open marked interrupted). A job without a kept schedule first runs one interval from now.
    pub fn new(
        source: &dyn ScheduleSource,
        db: Option<Arc<Db>>,
        inproc: InProc,
        agents: Box<dyn AgentDelivery>,
        observe: Observer,
        setting: Setting,
    ) -> Scheduler {
        let jobs = source.jobs();
        let now = now_ms();
        let mut saved: HashMap<String, JobState> = HashMap::new();
        if let Some(db) = &db {
            crate::discard::logged(
                "sched_write",
                db.write(Op::Sched(SchedOp::Interrupted { now_ms: now, status: "interrupted".into(), running: "running".into() })),
            );
            if let Ok(rows) = db.read(|c| {
                let mut st = c.prepare_cached(sql::SCHED_LOAD)?;
                let it = st.query_map([], |r| {
                    let n = |i: usize| r.get::<_, i64>(i).map(|v| v.max(0) as u64);
                    Ok((r.get::<_, String>(0)?, JobState { next_ms: n(1)?, failures: n(2)? as u32, cooldown_until_ms: n(3)?, running: false }))
                })?;
                it.collect::<rusqlite::Result<Vec<_>>>()
            }) {
                saved.extend(rows);
            }
        }
        let mut state = HashMap::new();
        let mut fresh_ones = vec![];
        for j in &jobs {
            let fresh = JobState { next_ms: next_after(j, now), ..Default::default() };
            let st = match saved.remove(&j.name) {
                // a schedule further out than one interval plus jitter and cooldown means the clock went back: reset
                Some(s) if j.persist && s.next_ms <= now + j.every_ms + j.jitter_ms + j.cooldown_ms => s,
                _ => {
                    fresh_ones.push(j.clone());
                    fresh
                }
            };
            state.insert(j.name.clone(), st);
        }
        let s = Scheduler {
            jobs,
            state: Mutex::new(state),
            last: Mutex::new(HashMap::new()),
            wake: (Mutex::new(false), Condvar::new()),
            db,
            inproc,
            agents,
            observe,
            setting,
        };
        for j in &fresh_ones {
            let st = lk(&s.state).get(&j.name).cloned().unwrap_or_default();
            s.save(j, &st); // a new schedule is kept at once, so a window missed before its first run is still known
        }
        s
    }

    /// The configured jobs.
    pub fn jobs(&self) -> &[JobSpec] {
        &self.jobs
    }

    /// `spec` with its interval read now from the live config (a changed `schedule.maintain_ms` applies to the next
    /// planning without a restart; 0 pauses the job).
    fn effective(&self, spec: &JobSpec) -> JobSpec {
        let mut s = spec.clone();
        if !s.every_key.is_empty() {
            s.every_ms = (self.setting)(&s.every_key);
        }
        s
    }

    fn save(&self, spec: &JobSpec, st: &JobState) {
        if let (true, Some(db)) = (spec.persist, &self.db) {
            crate::discard::harmless(db.write(Op::Sched(SchedOp::Save {
                job: spec.name.clone(),
                next_ms: st.next_ms,
                failures: st.failures,
                cooldown_until_ms: st.cooldown_until_ms,
            }))); // keep: formatting into a String cannot fail
        }
    }

    fn poke(&self) {
        *lk(&self.wake.0) = true;
        self.wake.1.notify_all();
    }

    /// The ticker: until `stop` says so, start every due job, then sleep until the next one is due (at most
    /// `schedule.tick_ms`, and less when `run` asks).
    pub fn run_ticker(self: &Arc<Self>, stop: &dyn Fn() -> bool) {
        while !stop() {
            let now = now_ms();
            let mut soonest = now + defaults::num("schedule.tick_ms");
            for spec in &self.jobs {
                let spec = &self.effective(spec);
                if spec.every_ms == 0 {
                    continue; // paused through the config
                }
                let mut state = lk(&self.state);
                let Some(st) = state.get_mut(&spec.name) else { continue };
                match decide(spec, st, now) {
                    Due::No => {}
                    Due::Skip => {
                        st.next_ms = next_after(spec, now);
                        soonest = soonest.min(st.next_ms); // else a job shorter than the tick sleeps through its next window and skips it again
                        let snapshot = st.clone();
                        drop(state);
                        self.save(spec, &snapshot);
                        (self.observe)(&spec.name, "skipped", true);
                        continue;
                    }
                    Due::Run { due_ms, catch_up } => {
                        st.next_ms = next_after(spec, now);
                        st.running = true;
                        let (snapshot, attempt) = (st.clone(), st.failures + 1);
                        drop(state);
                        self.save(spec, &snapshot); // committed before the run: a restart cannot run it again
                        let (me, spec) = (self.clone(), spec.clone());
                        std::thread::spawn(move || me.execute(&spec, due_ms, attempt, catch_up));
                        continue;
                    }
                }
                let wait_until = st.next_ms.max(st.cooldown_until_ms);
                if !st.running {
                    soonest = soonest.min(wait_until);
                }
            }
            let wait = Duration::from_millis(soonest.saturating_sub(now_ms()).max(1));
            let mut woke = lk(&self.wake.0);
            if !*woke {
                woke = self.wake.1.wait_timeout(woke, wait).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            *woke = false;
        }
    }

    /// One run of `spec`, on its own thread: record it, run it within its timeout, then reschedule.
    fn execute(&self, spec: &JobSpec, due_ms: u64, attempt: u32, catch_up: bool) {
        let started = now_ms();
        let id = match (&self.db, spec.persist) {
            (Some(db), true) => db
                .write(Op::Sched(SchedOp::Start { job: spec.name.clone(), due_ms, started_ms: started, attempt }))
                .ok_logged("sched_write")
                .and_then(|s| s.parse::<i64>().ok()),
            _ => None,
        };
        let outcome = self.perform(spec);
        let ended = now_ms();
        let st = {
            let mut state = lk(&self.state);
            let st = state.entry(spec.name.clone()).or_default();
            if outcome.failed() {
                *st = after_failure(spec, st, ended);
            } else {
                st.failures = 0;
                st.cooldown_until_ms = 0;
            }
            st.running = false;
            st.clone()
        };
        self.save(spec, &st);
        let (status, detail) = (outcome.status(), outcome.detail());
        if let Some(db) = &self.db {
            let op = match id {
                Some(id) => Some(SchedOp::End { id, ended_ms: ended, status: status.into(), detail: detail.clone() }),
                None if outcome.failed() => Some(SchedOp::Record {
                    job: spec.name.clone(),
                    due_ms,
                    started_ms: started,
                    ended_ms: ended,
                    status: status.into(),
                    attempt,
                    detail: detail.clone(),
                }),
                None => None,
            };
            if let Some(op) = op {
                crate::discard::logged("sched_write", db.write(Op::Sched(op)));
            }
        }
        if outcome.failed() {
            crate::health::log_event("schedule", status, &defaults::render("msg.schedule_failed", &[("job", &spec.name), ("detail", &detail)]));
        }
        (self.observe)(&spec.name, status, catch_up);
        let mut last = lk(&self.last);
        let l = last.entry(spec.name.clone()).or_default();
        l.finished += 1;
        l.result = json!({"job": spec.name, "status": status, "detail": detail, "due_ms": due_ms, "started_ms": started, "ended_ms": ended, "attempt": attempt, "catch_up": catch_up});
        drop(last);
        self.poke(); // the ticker re-plans with the new schedule
    }

    /// Do the job's work within its timeout.
    fn perform(&self, spec: &JobSpec) -> Outcome {
        let timeout = Duration::from_millis(spec.timeout_ms);
        if spec.kind == "agent" {
            return match self.agents.deliver(spec) {
                Ok(d) => Outcome::Ok(d),
                Err(e) if !self.agents.available() => Outcome::Planned(e),
                Err(e) => Outcome::Failed(e),
            };
        }
        if spec.action == "test_sleep" {
            let argv: Vec<String> = defaults::list("schedule.test_sleep_argv").iter().map(|s| s.to_string()).collect();
            return subprocess(&argv, timeout);
        }
        if defaults::list("schedule.subprocess_actions").contains(&spec.action.as_str()) {
            let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).or_default_logged("current_exe");
            return subprocess(&[exe, spec.action.clone(), "--json".into()], timeout);
        }
        // in-process: a helper thread does the work; if it overruns, the run is a timeout, and this thread still waits
        // for the helper so the job never overlaps itself
        let (tx, rx) = std::sync::mpsc::channel();
        let action = spec.action.clone();
        let work: &InProc = &self.inproc;
        std::thread::scope(|s| {
            s.spawn(move || {
                crate::discard::harmless(tx.send(work(&action))); // keep: the receiver is gone; nobody is waiting for the result
            });
            match rx.recv_timeout(timeout) {
                Ok(Ok(d)) => Outcome::Ok(d),
                Ok(Err(e)) => Outcome::Failed(e),
                Err(_) => Outcome::Timeout,
            }
        })
    }

    /// Run `job` now (outside its schedule) and wait up to `schedule.run_wait_ms` for the result.
    pub fn run_now(&self, job: &str) -> Value {
        let Some(spec) = self.jobs.iter().find(|j| j.name == job) else {
            return json!({"error": defaults::render("msg.schedule_unknown_job", &[("job", &job)])});
        };
        {
            let mut state = lk(&self.state);
            let st = state.entry(spec.name.clone()).or_default();
            if st.running {
                return json!({"job": job, "already_running": true});
            }
            st.next_ms = now_ms();
            st.cooldown_until_ms = 0;
        }
        let before = lk(&self.last).get(job).map(|l| l.finished).unwrap_or(0);
        self.poke();
        let t = Instant::now();
        while t.elapsed() < defaults::millis("schedule.run_wait_ms") {
            if let Some(l) = lk(&self.last).get(job).filter(|l| l.finished > before) {
                return l.result.clone();
            }
            std::thread::sleep(Duration::from_millis(defaults::num("daemon.lock_poll_ms")));
        }
        json!({"job": job, "started": true, "finished": false})
    }

    /// Every job with its configuration, schedule and last result.
    pub fn list(&self) -> Value {
        let state = lk(&self.state);
        let last = lk(&self.last);
        let jobs: Vec<Value> = self
            .jobs
            .iter()
            .map(|j| {
                let st = state.get(&j.name).cloned().unwrap_or_default();
                let j = &self.effective(j);
                json!({
                    "name": j.name, "kind": j.kind, "action": j.action, "every_ms": j.every_ms, "jitter_ms": j.jitter_ms,
                    "timeout_ms": j.timeout_ms, "retries": j.retries, "catch_up": if j.catch_up_once { "once" } else { "skip" }, "persist": j.persist,
                    "next_ms": st.next_ms, "failures": st.failures, "cooldown_until_ms": st.cooldown_until_ms, "running": st.running,
                    "last": last.get(&j.name).map(|l| l.result.clone()),
                })
            })
            .collect();
        json!({"running": true, "jobs": jobs})
    }
}

/// Run `argv` in its own process group; past `timeout` the whole group is killed.
fn subprocess(argv: &[String], timeout: Duration) -> Outcome {
    let Some((prog, args)) = argv.split_first() else { return Outcome::Failed(String::new()) };
    let mut child = match Command::new(prog).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let t = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                let pipe = if status.success() {
                    child.stdout.take().map(|o| Box::new(o) as Box<dyn Read>)
                } else {
                    child.stderr.take().map(|e| Box::new(e) as Box<dyn Read>)
                };
                if let Some(mut p) = pipe {
                    crate::discard::harmless(p.read_to_string(&mut out)); // keep: reaping or draining a child or thread that already ended
                }
                return if status.success() { Outcome::Ok(out.trim().to_string()) } else { Outcome::Failed(out.trim().to_string()) };
            }
            Ok(None) if t.elapsed() < timeout => std::thread::sleep(Duration::from_millis(defaults::num("client.fallback_poll_ms"))),
            _ => {
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                crate::discard::harmless(child.wait()); // keep: reaping or draining a child or thread that already ended
                return Outcome::Timeout;
            }
        }
    }
}

/// The run history from hot.db, newest first, optionally for one job.
pub fn history(db: &rusqlite::Connection, job: &str, limit: usize) -> rusqlite::Result<Vec<Value>> {
    let mut st = db.prepare_cached(sql::RUN_HISTORY)?;
    let rows = st.query_map(rusqlite::params![job, limit as i64], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?, "job": r.get::<_, String>(1)?, "due_ms": r.get::<_, i64>(2)?, "started_ms": r.get::<_, i64>(3)?,
            "ended_ms": r.get::<_, Option<i64>>(4)?, "status": r.get::<_, String>(5)?, "attempt": r.get::<_, i64>(6)?, "detail": r.get::<_, String>(7)?,
        }))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(every: u64, catch_up_once: bool) -> JobSpec {
        JobSpec {
            name: "j".into(),
            kind: "engine".into(),
            action: "noop".into(),
            every_ms: every,
            every_key: String::new(),
            jitter_ms: 0,
            timeout_ms: 1000,
            retries: 2,
            backoff_ms: 100,
            backoff_max_ms: 150,
            cooldown_ms: 5000,
            catch_up_once,
            persist: true,
        }
    }

    #[test]
    fn a_job_is_due_at_its_time_and_not_before() {
        let s = spec(1000, true);
        let st = JobState { next_ms: 10_000, ..Default::default() };
        assert_eq!(decide(&s, &st, 9_999), Due::No);
        assert_eq!(decide(&s, &st, 10_000), Due::Run { due_ms: 10_000, catch_up: false });
        assert_eq!(decide(&s, &JobState { running: true, ..st.clone() }, 10_000), Due::No, "never overlaps itself");
        assert_eq!(decide(&s, &JobState { cooldown_until_ms: 20_000, ..st }, 15_000), Due::No, "cooling down");
    }

    #[test]
    fn many_missed_windows_catch_up_once_or_are_skipped() {
        let st = JobState { next_ms: 1_000, ..Default::default() };
        let once = spec(1000, true);
        let now = 1_000 + 50 * 1000; // fifty windows missed (the machine slept)
        assert_eq!(decide(&once, &st, now), Due::Run { due_ms: 1_000, catch_up: true });
        let next = next_after(&once, now);
        assert_eq!(next, now + 1000, "the next run is one interval after the catch-up, not after the missed time");
        assert_eq!(decide(&once, &JobState { next_ms: next, ..Default::default() }, now + 1), Due::No, "so it runs once, not fifty times");
        assert_eq!(decide(&spec(1000, false), &st, now), Due::Skip);
    }

    #[test]
    fn failures_back_off_then_cool_down() {
        let s = spec(10_000, true);
        let st = JobState { next_ms: 20_000, ..Default::default() };
        let a = after_failure(&s, &st, 10_000);
        assert_eq!((a.next_ms, a.failures), (10_100, 1), "first retry after backoff_ms");
        let b = after_failure(&s, &a, 10_100);
        assert_eq!((b.next_ms, b.failures), (10_100, 2), "keeps the earlier time when it is sooner");
        let b = after_failure(&s, &JobState { next_ms: 20_000, ..b }, 11_000);
        assert_eq!(b.failures, 0, "retries exhausted: counting starts afresh after the cooldown");
        assert_eq!((b.cooldown_until_ms, b.next_ms), (16_000, 20_000), "the cooldown never brings the next run forward");
    }

    #[test]
    fn jitter_stays_within_its_bound() {
        let mut s = spec(1000, true);
        s.jitter_ms = 50;
        for _ in 0..200 {
            let n = next_after(&s, 0);
            assert!((1000..1050).contains(&n), "{n}");
        }
    }

    #[test]
    fn shipped_jobs_parse_and_overrides_apply() {
        let d = crate::db::TempDir::new("sched-src");
        let p = d.0.join("schedules.json");
        std::fs::write(&p, r#"{"jobs": {"maintain": {"every_ms": 5000}, "probe": {"kind": "engine", "action": "noop", "every_ms": 100, "persist": true}, "evil": {"kind": "engine", "action": "rm -rf /", "every_ms": 1}, "backup": {"every_ms": 0}}}"#).unwrap();
        let jobs = FileSource { override_path: p, test_hooks: false }.jobs();
        let get = |n: &str| jobs.iter().find(|j| j.name == n).cloned();
        assert_eq!(get("maintain").unwrap().every_ms, 5000, "an override changes a shipped job");
        assert!(get("maintain").unwrap().persist && get("maintain").unwrap().catch_up_once, "and keeps its other fields");
        assert!(get("probe").is_some(), "a new job with a known action is added");
        assert!(get("evil").is_none(), "an unknown action is refused");
        assert!(get("backup").is_none(), "an explicit every_ms of 0 disables a job");
        assert!(get("spool_drain").is_some() && get("metrics_snapshot").is_some());
        let none = FileSource { override_path: d.0.join("missing.json"), test_hooks: false }.jobs();
        let backup = none.iter().find(|j| j.name == "backup").expect("listed, so the config can turn it on");
        assert_eq!(backup.every_ms, 0, "backups are off by default (schedule.backup_ms = 0)");
    }

    #[test]
    fn a_hung_subprocess_is_killed_at_its_timeout() {
        let t = Instant::now();
        let o = subprocess(&["sleep".to_string(), "30".to_string()], Duration::from_millis(150));
        assert_eq!(o, Outcome::Timeout);
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(subprocess(&["true".to_string()], Duration::from_secs(5)), Outcome::Ok(String::new()));
        assert!(matches!(subprocess(&["false".to_string()], Duration::from_secs(5)), Outcome::Failed(_)));
    }

    #[test]
    fn agent_jobs_are_planned_not_failed() {
        let d = crate::db::TempDir::new("sched-agent");
        let p = d.0.join("schedules.json");
        std::fs::write(&p, r#"{"jobs": {"remind": {"kind": "agent", "action": "noop", "every_ms": 1000}}}"#).unwrap();
        let src = FileSource { override_path: p, test_hooks: false };
        let s = Scheduler::new(&src, None, Box::new(|_| Ok(String::new())), Box::new(PlannedDelivery), Box::new(|_, _, _| {}), Box::new(defaults::num));
        let spec = s.jobs().iter().find(|j| j.name == "remind").unwrap().clone();
        assert!(matches!(s.perform(&spec), Outcome::Planned(_)));
    }

    #[test]
    fn a_skipped_window_does_not_make_a_short_job_sleep_through_the_next() {
        let d = crate::db::TempDir::new("sched-skip");
        let p = d.0.join("schedules.json");
        std::fs::write(&p, r#"{"jobs": {"spool_drain": {"every_ms": 0}, "metrics_snapshot": {"every_ms": 0}, "probe": {"kind": "engine", "action": "noop", "every_ms": 200, "catch_up": "skip", "persist": false}}}"#).unwrap();
        let src = FileSource { override_path: p, test_hooks: false };
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let r = runs.clone();
        let inproc: InProc = Box::new(move |action| {
            if action == "noop" {
                r.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(String::new())
        });
        let s = Arc::new(Scheduler::new(&src, None, inproc, Box::new(PlannedDelivery), Box::new(|_, _, _| {}), Box::new(defaults::num)));
        // the ticker was held up for longer than a whole interval: that window is missed and, with catch_up = skip, skipped
        lk(&s.state).get_mut("probe").unwrap().next_ms = now_ms().saturating_sub(2000);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, stop2) = (s.clone(), stop.clone());
        let h = std::thread::spawn(move || s2.run_ticker(&|| stop2.load(std::sync::atomic::Ordering::SeqCst)));
        let t = Instant::now();
        while runs.load(std::sync::atomic::Ordering::SeqCst) == 0 && t.elapsed() < Duration::from_millis(3000) {
            std::thread::sleep(Duration::from_millis(10));
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        s.poke();
        h.join().unwrap();
        assert!(runs.load(std::sync::atomic::Ordering::SeqCst) > 0, "the job ran again after the skipped window, well inside the tick");
    }
}
