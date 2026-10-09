//! The on-demand kill-and-resume of ONE workspace's session, native: `companion/lib/target-session.js` (`findTarget`,
//! `verifyTarget`) and `companion/lib/recovery.js` (`recover`) with Node's confirmations, sequence, recovery log lines and liveness
//! verdicts. It is the ONLY code in DevSwarm that signals a process, and it only runs for `ah-engine devswarm recover` (the
//! engine's gate in [`super::recover`] has refused automated callers, bad ids, repeated requests and exhausted workspaces first).
//!
//! SAFETY, each point proven by a test:
//! * exactly one confirmed target or it ABSTAINS (no match, several, an interactive session by default is left alone unless the
//!   owner's explicit recover allows it): a candidate must carry the descriptor's session id in its argv, run in the descriptor's
//!   working directory, have a transcript for that session, and not be the engine's own process or one of its descendants;
//! * the identity is re-derived from FRESH data immediately before SIGTERM and again before SIGKILL, so a pid recycled during the
//!   grace period is never killed;
//! * the signal goes to that one pid and its process group, never by pattern;
//! * one recovery of an id at a time (the per-id lock), at most `maxRecoveries` per workspace, escalation instead of a restart loop;
//! * the resumed session is detached, never killed for being slow, and an unconfirmed resume is recorded `recovering`, never `alive`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a probe that fails or times out yields no data and the gate abstains (Node: "a failed OR timed-out enumeration returns '' / null")
// - an unreadable descriptor field or verdict is absent (Node's try/catch)
use super::verdict;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner};
use crate::meshw::ident::resolve_abs;
use regex::Regex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// One line of the process table.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    /// Process id.
    pub pid: i64,
    /// Parent process id.
    pub ppid: i64,
    /// The command line.
    pub cmd: String,
}

/// A `claude` invocation carrying a session id.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// Process id.
    pub pid: i64,
    /// Parent process id.
    pub ppid: i64,
    /// The command line.
    pub cmd: String,
    /// The session id in its argv.
    pub uuid: String,
    /// `-p` / `--print` is in its argv.
    pub headless: bool,
}

/// What the confirm-gate decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// Exactly one confirmed process.
    One {
        /// Process id.
        pid: i64,
        /// Its session id.
        uuid: String,
    },
    /// Abstain: zero, several, interactive-only, or no way to tell.
    Ambiguous {
        /// Why (`no-worktree-path`, `no-session-id`, `multiple-candidates`, `interactive-candidate`, `no-candidate`).
        reason: String,
        /// The survivors, when several.
        candidates: Vec<Candidate>,
    },
}

impl Target {
    /// Node's JSON shape of the target.
    pub fn to_json(&self, worktree: &str) -> Value {
        match self {
            Target::One { pid, uuid } => json!({"pid": pid, "uuid": uuid, "worktreePath": worktree}),
            Target::Ambiguous { reason, candidates } => json!({
                "ambiguous": true, "reason": reason,
                "candidates": candidates.iter().map(|c| json!({"pid": c.pid, "ppid": c.ppid, "cmd": c.cmd, "uuid": c.uuid, "headless": c.headless})).collect::<Vec<_>>()
            }),
        }
    }
}

/// Everything the recovery needs from the machine, behind one trait so tests touch no real process.
pub trait Sys {
    /// The process table (`ps` output), empty when it cannot be read.
    fn ps(&self) -> String;
    /// The working directory of a process.
    fn cwd_of(&self, pid: i64) -> Option<String>;
    /// Whether the session's transcript exists.
    fn transcript_exists(&self, dir: &Path, uuid: &str) -> bool;
    /// Signal one pid (signal 0 probes); true when it was delivered.
    fn kill(&self, pid: i64, sig: i32) -> bool;
    /// Signal the process group led by `pid`.
    fn kill_group(&self, pid: i64, sig: i32) -> bool;
    /// Wait.
    fn sleep(&self, ms: u64);
    /// Start the resumed headless session, detached; returns what it printed during the readiness window.
    fn spawn_resume(&self, uuid: &str, cwd: &str, prompt: &str) -> String;
    /// The engine's own pid.
    fn self_pid(&self) -> i64 {
        i64::from(std::process::id())
    }
}

/// A shipped pattern. An invalid one is `None` and matches nothing, so the gate abstains (never a wrong kill).
fn re(key: &str) -> Option<Regex> {
    Regex::new(defaults::text(key)).ok()
}

fn is_match(r: &Option<Regex>, s: &str) -> bool {
    r.as_ref().is_some_and(|r| r.is_match(s))
}

/// `encodeWorktreePath`: every `/`, `\`, `:` and `.` becomes `-`. Lossy and forward-only.
pub fn encode_worktree_path(p: &str) -> String {
    p.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect()
}

/// `projectDirFor(worktreePath, home)`: the session transcripts' directory.
pub fn project_dir(worktree: &str, home: &Path) -> PathBuf {
    home.join(defaults::text("devswarm_sup.kill_claude_dir")).join(defaults::text("devswarm_sup.kill_projects_dir")).join(encode_worktree_path(worktree))
}

/// `parsePs`.
pub fn parse_ps(out: &str) -> Vec<Proc> {
    let line = re("devswarm_sup.kill_ps_line_re");
    out.lines()
        .filter_map(|l| {
            let c = line.as_ref()?.captures(l)?;
            Some(Proc { pid: c[1].parse().ok()?, ppid: c[2].parse().ok()?, cmd: c[3].to_string() })
        })
        .collect()
}

/// `candidatesFromPs`: every `claude` invocation carrying a session id (inclusive on purpose: shell wrappers match too; the
/// confirm-gate is what is strict).
pub fn candidates(procs: &[Proc]) -> Vec<Candidate> {
    let (claude, session, headless) = (re("devswarm_sup.kill_claude_re"), re("devswarm_sup.kill_session_re"), re("devswarm_sup.kill_headless_re"));
    procs
        .iter()
        .filter(|p| is_match(&claude, &p.cmd))
        .filter_map(|p| {
            let uuid = session.as_ref()?.captures(&p.cmd)?.get(1)?.as_str().to_string();
            Some(Candidate { pid: p.pid, ppid: p.ppid, cmd: p.cmd.clone(), uuid, headless: is_match(&headless, &p.cmd) })
        })
        .collect()
}

/// `descendantsOf`: every process transitively parented by `root` (not `root` itself).
pub fn descendants(procs: &[Proc], root: i64) -> std::collections::HashSet<i64> {
    let mut kids: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for p in procs {
        kids.entry(p.ppid).or_default().push(p.pid);
    }
    let mut out = std::collections::HashSet::new();
    let mut stack: Vec<i64> = kids.get(&root).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if out.insert(pid) {
            stack.extend(kids.get(&pid).cloned().unwrap_or_default());
        }
    }
    out
}

/// The target of `worktree` + `session`: `findTarget`.
pub fn find_target(sys: &dyn Sys, home: &Path, worktree: &str, session: &str, allow_interactive: bool) -> Target {
    let abstain = |reason: &str, candidates: Vec<Candidate>| Target::Ambiguous { reason: reason.to_string(), candidates };
    if worktree.is_empty() {
        return abstain("no-worktree-path", vec![]);
    }
    if session.is_empty() {
        return abstain("no-session-id", vec![]);
    }
    let dir = project_dir(worktree, home);
    let procs = parse_ps(&sys.ps());
    let self_pid = sys.self_pid();
    let mut excluded = descendants(&procs, self_pid);
    excluded.insert(self_pid);
    let (mut survivors, mut interactive_matched) = (Vec::new(), false);
    for c in candidates(&procs) {
        if excluded.contains(&c.pid) || c.uuid != session {
            continue; // self / self-tree; identity binding
        }
        let Some(cwd) = sys.cwd_of(c.pid) else { continue };
        if resolve_abs(&cwd) != resolve_abs(worktree) || !sys.transcript_exists(&dir, &c.uuid) {
            continue; // cwd confirm-gate; transcript cross-check
        }
        if !c.headless && !allow_interactive {
            interactive_matched = true; // a human takeover is never killed by default
            continue;
        }
        survivors.push(c);
    }
    match survivors.len() {
        1 => Target::One { pid: survivors[0].pid, uuid: survivors[0].uuid.clone() },
        n if n > 1 => abstain("multiple-candidates", survivors),
        _ if interactive_matched => abstain("interactive-candidate", vec![]),
        _ => abstain("no-candidate", vec![]),
    }
}

/// `verifyTarget`: the same pid and session are still the sole confirmed target on FRESH data.
pub fn verify_target(sys: &dyn Sys, home: &Path, worktree: &str, session: &str, pid: i64, uuid: &str, allow_interactive: bool) -> bool {
    matches!(find_target(sys, home, worktree, session, allow_interactive), Target::One { pid: p, uuid: u } if p == pid && u == uuid)
}

/// `unreadBacklog(inbox, cursor)`: the inbox lines after the cursor; empty when either file is unusable.
pub fn unread_backlog(inbox: Option<&str>, cursor: Option<&str>) -> Vec<String> {
    let Some(inbox) = inbox else { return vec![] };
    let Ok(text) = std::fs::read(inbox).map(|b| String::from_utf8_lossy(&b).into_owned()) else { return vec![] };
    let all: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    let Some(cursor) = cursor else { return vec![] };
    let Ok(raw) = std::fs::read(cursor).map(|b| String::from_utf8_lossy(&b).trim().to_string()) else { return vec![] };
    let n = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<f64>().ok()
    } else {
        serde_json::from_str::<Value>(&raw).ok().and_then(|v| v.get("line").and_then(Value::as_f64))
    };
    match n {
        Some(n) if n.is_finite() && n >= 0.0 => all.iter().skip(n as usize).map(|l| (*l).to_string()).collect(),
        _ => vec![],
    }
}

/// What a recovery needs besides the machine.
pub struct Job<'a> {
    /// The home directory.
    pub home: &'a Path,
    /// The workspace id.
    pub id: &'a str,
    /// Its descriptor (worktreePath, sessionId, inboxPath, cursorPath).
    pub descriptor: &'a Value,
    /// The clock, epoch ms.
    pub now: i64,
    /// Most recoveries of one workspace.
    pub max_recoveries: u64,
    /// The wait between SIGTERM and the check for survival.
    pub grace_ms: u64,
    /// The owner's explicit recover may target a lone interactive session too.
    pub allow_interactive: bool,
}

fn log(job: &Job, fields: &[(&str, Value)]) {
    verdict::append_log(job.home, job.now, fields);
}

fn recoveries_of(job: &Job) -> u64 {
    verdict::path(job.home, job.id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("recoveries").and_then(Value::as_u64))
        .unwrap_or(0)
}

/// `recover(opts)`: `{action, ...}` as Node returns it. Never signals on an ambiguous target.
pub fn recover(sys: &dyn Sys, job: &Job, target: &Target) -> Value {
    let id = job.id;
    let wt = job.descriptor.get("worktreePath").and_then(Value::as_str).unwrap_or_default();
    let session = job.descriptor.get("sessionId").and_then(Value::as_str).unwrap_or_default();
    let persist = |status: &str, extra: &[(&str, Value)]| verdict::persist(job.home, id, status, extra);
    let Target::One { pid, uuid } = target else {
        let reason = match target {
            Target::Ambiguous { reason, .. } => reason.clone(),
            Target::One { .. } => defaults::text("devswarm_sup.kill_no_target").to_string(),
        };
        log(job, &[("id", id.into()), ("action", "abstain".into()), ("reason", reason.clone().into())]);
        persist(defaults::text("devswarm_sup.kill_status_ambiguous"), &[]);
        return json!({"action": "abstain", "reason": reason});
    };
    let (pid, uuid) = (*pid, uuid.as_str());
    let done = recoveries_of(job);
    if done >= job.max_recoveries {
        log(job, &[("id", id.into()), ("action", "escalate".into()), ("reason", "max-recoveries".into()), ("recoveries", done.into())]);
        persist(defaults::text("devswarm_sup.status_escalated"), &[]);
        return json!({"action": "escalate", "reason": "max-recoveries", "recoveries": done});
    }
    let Some(lock) = crate::meshw::idlock::acquire(job.home, id) else {
        log(job, &[("id", id.into()), ("action", "skip".into()), ("reason", "locked".into())]);
        return json!({"action": "skip", "reason": "locked"});
    };
    let out = (|| {
        persist(defaults::text("devswarm_sup.kill_status_recovering"), &[]);
        let still = || verify_target(sys, job.home, wt, session, pid, uuid, job.allow_interactive);
        // TOCTOU re-confirm #1: immediately before SIGTERM, on fresh data
        if !still() {
            log(job, &[("id", id.into()), ("action", "abstain".into()), ("reason", "identity-changed-pre-term".into()), ("pid", pid.into())]);
            persist(defaults::text("devswarm_sup.kill_status_ambiguous"), &[]);
            return json!({"action": "abstain", "reason": "identity-changed"});
        }
        sys.kill(pid, libc::SIGTERM);
        sys.kill_group(pid, libc::SIGTERM);
        log(job, &[("id", id.into()), ("action", "sigterm".into()), ("pid", pid.into()), ("uuid", uuid.into())]);
        sys.sleep(job.grace_ms);
        if sys.kill(pid, 0) {
            // TOCTOU re-confirm #2: a pid recycled during the grace window must NOT be SIGKILLed
            if !still() {
                log(job, &[("id", id.into()), ("action", "abstain".into()), ("reason", "identity-changed-pre-kill".into()), ("pid", pid.into())]);
                persist(defaults::text("devswarm_sup.kill_status_ambiguous"), &[]);
                return json!({"action": "abstain", "reason": "identity-changed"});
            }
            sys.kill(pid, libc::SIGKILL);
            sys.kill_group(pid, libc::SIGKILL);
            log(job, &[("id", id.into()), ("action", "sigkill".into()), ("pid", pid.into())]);
        }
        let backlog = unread_backlog(job.descriptor.get("inboxPath").and_then(Value::as_str), job.descriptor.get("cursorPath").and_then(Value::as_str));
        let prompt = format!("{}\n\n{}", defaults::text("devswarm_sup.kill_resume_guardrail"), backlog.join("\n"));
        let printed = sys.spawn_resume(uuid, wt, &prompt);
        if printed.to_lowercase().contains(&defaults::text("devswarm_sup.kill_no_conversation").to_lowercase()) {
            log(job, &[("id", id.into()), ("action", "escalate".into()), ("reason", "no-conversation-found".into()), ("uuid", uuid.into())]);
            persist(defaults::text("devswarm_sup.status_escalated"), &[]);
            return json!({"action": "escalate", "reason": "no-conversation-found"});
        }
        // the resume runs independently: record 'recovering' and count it; never a false 'alive'
        persist(defaults::text("devswarm_sup.kill_status_recovering"), &[("recoveries", (done + 1).into()), ("recoveredAt", job.now.into())]);
        log(job, &[("id", id.into()), ("action", "resumed".into()), ("pid", pid.into()), ("uuid", uuid.into()), ("recoveries", (done + 1).into())]);
        json!({"action": "resumed", "recoveries": done + 1, "uuid": uuid, "pid": pid})
    })();
    lock.release();
    out
}

/// The real machine: `ps`/`lsof` (or `/proc`) behind the bounded runner, real signals, a real detached resume.
pub struct Real<'a> {
    /// Runs the bounded probes.
    pub runner: &'a dyn Runner,
    /// The claude executable (a name searched on PATH and the configured directories, or a path).
    pub claude: PathBuf,
    /// Where the resumed session's output goes during the readiness window.
    pub readiness_ms: u64,
}

impl Real<'_> {
    fn probe(&self, bin: &str, args: Vec<String>) -> Option<String> {
        let r = self.runner.run(&RunSpec {
            bin: Some(bin.to_string()),
            args,
            timeout_ms: defaults::num("devswarm_sup.kill_probe_timeout_ms"),
            cap_bytes: defaults::num("devswarm_sup.kill_ps_cap_bytes"),
            ..RunSpec::default()
        });
        (r.ok && !r.truncated).then_some(r.stdout)
    }
}

impl Sys for Real<'_> {
    fn ps(&self) -> String {
        self.probe(defaults::text("devswarm_sup.kill_ps_bin"), defaults::list("devswarm_sup.kill_ps_args").iter().map(|s| (*s).to_string()).collect())
            .unwrap_or_default()
    }

    fn cwd_of(&self, pid: i64) -> Option<String> {
        if cfg!(target_os = "linux") {
            return proc_cwd(defaults::text("devswarm_sup.kill_proc_cwd"), pid);
        }
        let args = defaults::list("devswarm_sup.kill_lsof_args").iter().map(|s| defaults::fill(s, &[("pid", &pid)])).collect();
        lsof_cwd(&self.probe(defaults::text("devswarm_sup.kill_lsof_bin"), args)?)
    }

    fn transcript_exists(&self, dir: &Path, uuid: &str) -> bool {
        dir.join(format!("{uuid}{}", defaults::text("devswarm_sup.kill_transcript_suffix"))).exists()
    }

    fn kill(&self, pid: i64, sig: i32) -> bool {
        if pid <= 0 || pid > i64::from(i32::MAX) {
            return false;
        }
        // SAFETY: a signal to one pid we have just confirmed; signal 0 only probes.
        let rc = unsafe { libc::kill(pid as i32, sig) };
        rc == 0 || (sig == 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }

    fn kill_group(&self, pid: i64, sig: i32) -> bool {
        if pid <= 0 || pid > i64::from(i32::MAX) {
            return false;
        }
        // SAFETY: the process group of the one pid we confirmed (negative pid); a missing group just has no recipients.
        unsafe { libc::kill(-(pid as i32), sig) == 0 }
    }

    fn sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    fn spawn_resume(&self, uuid: &str, cwd: &str, prompt: &str) -> String {
        use std::io::Write;
        use std::os::unix::process::CommandExt;
        let out_file = std::env::temp_dir().join(format!("{}{}-{}.log", defaults::text("devswarm_sup.kill_resume_log_prefix"), std::process::id(), uuid));
        let sink = std::fs::OpenOptions::new().create(true).append(true).open(&out_file);
        let (so, se) = match sink.as_ref().ok().and_then(|f| f.try_clone().ok().map(|c| (f.try_clone(), c))) {
            Some((Ok(a), b)) => (std::process::Stdio::from(a), std::process::Stdio::from(b)),
            _ => (std::process::Stdio::null(), std::process::Stdio::null()),
        };
        let mut cmd = std::process::Command::new(&self.claude);
        cmd.args(defaults::list("devswarm_sup.kill_resume_args").iter().map(|a| defaults::fill(a, &[("uuid", &uuid)])))
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(so)
            .stderr(se)
            .process_group(0);
        let Ok(mut child) = cmd.spawn() else { return String::new() };
        if let Some(mut stdin) = child.stdin.take() {
            crate::discard::harmless(stdin.write_all(prompt.as_bytes())); // keep: a session that exited at once reports it through its output
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(self.readiness_ms);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                exited = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(defaults::num("devswarm_sup.kill_poll_ms")));
        }
        let printed = std::fs::read_to_string(&out_file).unwrap_or_default();
        if exited {
            crate::discard::harmless(std::fs::remove_file(&out_file)); // keep: the engine's own scratch output of a session that already ended
        } else {
            // still running: that is success in progress, never a reason to kill it; a thread reaps it when it ends
            std::thread::spawn(move || {
                crate::discard::harmless(child.wait()); // keep: only reaping
            });
        }
        printed
    }
}

/// The working directory of `pid` through the procfs link `template` (Linux; `{pid}` is replaced).
pub fn proc_cwd(template: &str, pid: i64) -> Option<String> {
    std::fs::read_link(defaults::fill(template, &[("pid", &pid)])).ok().map(|p| p.to_string_lossy().into_owned())
}

/// The directory in `lsof -Fn` output (macOS): the first `n` line.
pub fn lsof_cwd(out: &str) -> Option<String> {
    let prefix = defaults::text("devswarm_sup.kill_lsof_name_prefix");
    out.lines().find_map(|l| l.strip_prefix(prefix).map(str::to_string))
}

/// The claude executable: the configured name searched on PATH, then the configured directories (`~/` is the home directory).
pub fn find_claude(path_var: Option<&str>, home: &Path) -> PathBuf {
    let name = defaults::text("devswarm_sup.kill_claude_bin");
    let mut dirs: Vec<PathBuf> = path_var.unwrap_or_default().split(':').filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    dirs.extend(defaults::list("devswarm_sup.kill_claude_dirs").iter().map(|d| d.strip_prefix("~/").map_or_else(|| PathBuf::from(d), |rest| home.join(rest))));
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_output_is_read_as_the_first_name_line() {
        crate::defaults::init().unwrap();
        assert_eq!(lsof_cwd("p123\nfcwd\nn/Users/x/wt\n"), Some("/Users/x/wt".to_string()));
        assert_eq!(lsof_cwd("p123\nfcwd\n"), None);
        assert_eq!(lsof_cwd(""), None);
        assert_eq!(lsof_cwd("n/a b/c\nn/second\n"), Some("/a b/c".to_string()), "paths with spaces, first line wins");
    }

    #[test]
    fn the_linux_proc_link_is_read_through_its_template() {
        crate::defaults::init().unwrap();
        let d = std::env::temp_dir().join(format!("ah-proccwd-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: our own scratch
        std::fs::create_dir_all(d.join("4242")).unwrap();
        std::os::unix::fs::symlink("/work/ws-1", d.join("4242/cwd")).unwrap();
        let template = format!("{}/{{pid}}/cwd", d.display());
        assert_eq!(proc_cwd(&template, 4242), Some("/work/ws-1".to_string()));
        assert_eq!(proc_cwd(&template, 1), None, "a vanished process has no link");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: our own scratch
    }

    #[test]
    fn the_shipped_patterns_all_compile_so_the_gate_never_degrades_to_abstaining_by_accident() {
        crate::defaults::init().unwrap();
        for k in ["kill_claude_re", "kill_session_re", "kill_headless_re", "kill_ps_line_re"] {
            assert!(re(&format!("devswarm_sup.{k}")).is_some(), "{k}");
        }
    }

    #[test]
    fn find_claude_prefers_path_then_the_configured_directories() {
        crate::defaults::init().unwrap();
        let d = std::env::temp_dir().join(format!("ah-findclaude-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: our own scratch
        std::fs::create_dir_all(d.join("bin")).unwrap();
        std::fs::create_dir_all(d.join("home/.local/bin")).unwrap();
        std::fs::write(d.join("bin/claude"), "x").unwrap();
        std::fs::write(d.join("home/.local/bin/claude"), "y").unwrap();
        let path = format!("/nonexistent:{}", d.join("bin").display());
        assert_eq!(find_claude(Some(&path), &d.join("home")), d.join("bin/claude"), "PATH first");
        assert_eq!(find_claude(Some("/nonexistent"), &d.join("home")), d.join("home/.local/bin/claude"), "then ~/.local/bin of the home");
        assert_eq!(find_claude(None, &d.join("empty-home")), PathBuf::from("claude"), "else the bare name");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: our own scratch
    }
}
