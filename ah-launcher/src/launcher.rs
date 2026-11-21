//! The launcher proper: arguments, settings, the budgets of a call, the cold-start guard wait, the engine run and the outcome
//! table of the retired `hooks/ah-hook.sh` (now in `plugins/anti-hall-node/legacy-sh/`).
//!
//! Failure policy: anything internal that goes wrong lets the hook through (exit 0, empty stdout, one stderr line at most).
//! The only blocks are the engine's own exit 2 and the guard events' fail-closed rows (bad budget knob, unrunnable fallback
//! runner), exactly as the shell wrapper has them.

use crate::blog::Log;
use crate::cfg::Settings;
use crate::gate::{self, Right, Sock};
use crate::limits::{self, Ctr};
use crate::proc::{self, Feed, Opts, Retry, Run};
use crate::util::{
    env_nonempty, fill, is_exec, json_str_field, json_true_field, now_ms, positive, say, uid,
};
use crate::{builtin, cli, nodeback, selftest, shellwords};
use std::ffi::CString;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub static RUN_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static INTERNAL_TEXT: OnceLock<String> = OnceLock::new();
pub static LOG: OnceLock<Log> = OnceLock::new();

/// One stderr line and a log line for a failure of the launcher itself (a panic, a limit): the hook is let through.
pub fn internal(what: &str) {
    let tpl = INTERNAL_TEXT
        .get()
        .cloned()
        .or_else(|| builtin::text("msg.launcher_internal").map(str::to_string))
        .unwrap_or_default();
    say(&fill(&tpl, &[("what", what)]));
    if let Some(l) = LOG.get() {
        l.append(&format!("internal {what} {}", limits::render_counters()));
    }
}

fn write_out(out: &[u8], err: &[u8]) {
    let mut o = std::io::stdout();
    let _ = o.write_all(out);
    let _ = o.flush();
    let _ = std::io::stderr().write_all(err);
}

struct L {
    s: Settings,
    event: String,
    host: String,
    hooks_dir: PathBuf,
    plugin_root: Option<PathBuf>,
    guard: bool,
    test: bool,
    state_dir: PathBuf,
    home: Option<PathBuf>,
    payload: Arc<Vec<u8>>,
    more: bool,
    list: PathBuf,
    timeout_s: u64,
    timeout_ms: u64,
    grace: Duration,
    ev_s: Option<u64>,
    t0: Instant,
    ignored_knobs: Vec<String>,
}

impl L {
    fn key(&self, k: &str) -> String {
        self.s.text(k)
    }

    /// A test-only knob: honoured only when the test flag is set.
    fn knob(&self, key: &str) -> Option<String> {
        if self.test {
            env_nonempty(&self.s.text(key))
        } else {
            None
        }
    }

    fn log_line(&self, line: &str) {
        if let Some(l) = LOG.get() {
            l.append(line);
        }
    }

    fn diag(&self, line: &str) {
        if !self.test {
            return;
        }
        if let Some(p) = env_nonempty(&self.key("launcher.diag_env")).filter(|p| p.starts_with('/'))
            && let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    fn stop_hook_active(&self) -> bool {
        (self.event == "Stop" || self.event == "SubagentStop")
            && json_true_field(&self.payload, "stop_hook_active")
    }

    fn fail_closed(&self, why: &str) -> i32 {
        let subs = [("event", self.event.as_str()), ("why", why)];
        if self.stop_hook_active() {
            say(&self.s.msg("msg.launcher_fail_open_stop", &subs));
            return 0;
        }
        say(&self.s.msg("msg.launcher_fail_closed", &subs));
        2
    }

    /// A guard event fails closed on an unrunnable fallback; any other event lets the hook through.
    fn closed_if_guard(&self, why_key: &str) -> i32 {
        if self.guard {
            self.fail_closed(&self.s.text(why_key))
        } else {
            0
        }
    }

    fn event_timeout_s(&self) -> Option<u64> {
        self.ev_s
    }

    fn read_event_timeout(&self) -> Option<u64> {
        let text = std::fs::read_to_string(&self.list).ok()?;
        let want = format!("@{}\t", self.event);
        let line = text.lines().find(|l| l.starts_with(&want))?;
        let t = positive(line.get(want.len()..)?.split('\t').next()?)?;
        Some(t.min(self.timeout_s))
    }

    fn integrity(&self, verb: &str) {
        if self.knob("launcher.knob_engine_bin").is_some() {
            return; // never for a test double
        }
        self.self_spawn(&[verb], "launcher.cli_integrity_verb");
    }

    /// This very binary, in the background, running the maintenance verb named by `verb_key` with `rest`.
    fn self_spawn(&self, rest: &[&str], verb_key: &str) {
        // this very binary, in the background: `fail` and `check` may wait for the install lock, and the hook must not
        let Ok(me) = std::env::current_exe() else {
            return;
        };
        let mut cmd = Command::new(me);
        if let Some(r) = &self.plugin_root {
            cmd.arg("--plugin-root").arg(r);
        }
        let _ = cmd
            .arg(self.key(verb_key))
            .args(rest)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
    }

    fn fresh_marker(&self, files_key: &str) -> bool {
        let name = self.key(&format!("files.{files_key}"));
        if name.is_empty() || self.state_dir.as_os_str().is_empty() {
            return false;
        }
        let Ok(t) = std::fs::read_to_string(self.state_dir.join(name)) else {
            return false;
        };
        let digits: String = t.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u64>().is_ok_and(|until| until > now_ms())
    }

    fn halted(&self) -> bool {
        self.fresh_marker("daemon_down_marker")
            || self.fresh_marker("breaker_until")
            || self.fresh_marker("crashloop_until")
    }

    /// A private run directory for the done and wait markers: `<home>/<base>/<run_base_dir>` (ours, mode 700), else the temp dir.
    fn run_dir(&self) -> Option<PathBuf> {
        let mut bases = Vec::new();
        if let Some(h) = &self.home {
            bases.push(
                h.join(self.key("paths.base_dir"))
                    .join(self.key("launcher.run_base_dir")),
            );
        }
        // Linux need not export TMPDIR. Keep the private fallback even when HOME is unusable and that variable is absent.
        let tmp = env_nonempty(&self.key("env.tmpdir"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        bases.push(tmp.join(format!("{}{}", self.key("launcher.tmp_dir_prefix"), uid())));
        for b in bases {
            let _ = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&b);
            let Ok(m) = std::fs::symlink_metadata(&b) else {
                continue;
            };
            if !m.is_dir() || m.uid() != uid() || m.mode() & 0o777 != 0o700 {
                continue;
            }
            let d = b.join(format!(
                "{}{}",
                self.key("launcher.run_dir_prefix"),
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&d); // a dead launcher with our pid left it behind
            if std::fs::DirBuilder::new().mode(0o700).create(&d).is_ok() {
                return Some(d);
            }
        }
        None
    }

    fn cold_notice(&self) {
        self.session_notice(
            "msg.cold_guard_notice",
            "files.cold_guard_notice",
            &[("event", self.event.as_str())],
        );
    }

    /// #368: the installed engine (the installer's marker) is older than the release the plugin pins (`ah-engine.lock`): one notice per
    /// session names the fix and the hook still runs. Unreadable or unparsable files, a missing marker (a local build) and an engine at
    /// or above the pin say nothing. Off with launcher.stale_notice_on.
    fn stale_engine_notice(&self) {
        if self.s.num("launcher.stale_notice_on") == 0 || self.state_dir.as_os_str().is_empty() {
            return;
        }
        let Some(root) = self.plugin_root.as_ref() else {
            return;
        };
        // hooks/install.sh already said it for this session start and set this knob for the client it handed over to
        if crate::util::env_nonempty(&self.key("launcher.knob_stale_noticed")).is_some() {
            return;
        }
        let pinned = std::fs::read_to_string(root.join(self.key("launcher.engine_lock_file")))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| {
                v.get("version")
                    .and_then(|x| x.as_str().map(str::to_string))
            })
            .unwrap_or_default();
        let have = std::fs::read_to_string(self.state_dir.join(self.key("install.file_marker")))
            .ok()
            .and_then(|t| t.split_whitespace().next().map(str::to_string))
            .unwrap_or_default();
        if pinned.is_empty() || have.is_empty() {
            return;
        }
        let floor = self.key("launcher.legacy_scheme_floor");
        if crate::compat::component_cmp(&floor, &have, &pinned) == Some(std::cmp::Ordering::Less) {
            self.session_notice(
                "msg.launcher_stale_engine",
                "files.launcher_stale_notice",
                &[("have", &have), ("want", &pinned)],
            );
        }
    }

    /// The engine is unreachable (not installed, crashed, timed out, marked down, handed the call back): the call passes
    /// through unchecked and the session hears it once (msg.engine_unreachable_notice).
    fn unreachable_notice_for(&self, why_key: &str) {
        let why = self.key(why_key);
        self.unreachable_notice(&why);
    }

    fn unreachable_notice(&self, why: &str) {
        self.session_notice(
            "msg.engine_unreachable_notice",
            "files.unreachable_notice",
            &[("event", self.event.as_str()), ("why", why)],
        );
    }

    /// One stderr notice per session: the marker file named by `file_key` holds the most recent session ids (one per
    /// line, at most `launcher.notice_sessions_max`) that already got the notice, so interleaved sessions no longer
    /// overwrite each other's record (#231). The oldest id is dropped once the cap is passed.
    fn session_notice(&self, text_key: &str, file_key: &str, subs: &[(&str, &str)]) {
        let text = self.key(text_key);
        if text.is_empty() {
            return;
        }
        let sid = json_str_field(&self.payload, "session_id").unwrap_or_else(|| "none".into());
        let name = self.key(file_key);
        if !name.is_empty() && !self.state_dir.as_os_str().is_empty() {
            let p = self.state_dir.join(name);
            let cap = (self.s.num("launcher.notice_sessions_max") as usize).max(1);
            let mut seen: Vec<String> = std::fs::read_to_string(&p)
                .map(|t| {
                    t.lines()
                        .map(str::trim_end)
                        .filter(|l| !l.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            let counting = self.s.num("launcher.notice_counters") != 0;
            if seen.contains(&sid) {
                if counting {
                    limits::bump(limits::Ctr::NoticeSuppressed);
                }
                return;
            }
            seen.push(sid);
            let drop = seen.len().saturating_sub(cap);
            seen.drain(..drop);
            if counting {
                for _ in 0..drop {
                    limits::bump(limits::Ctr::NoticeEvicted);
                }
                limits::bump(limits::Ctr::NoticeShown);
            }
            let _ = std::fs::create_dir_all(&self.state_dir);
            let _ = std::fs::write(&p, seen.join("\n") + "\n");
        }
        say(&fill(&text, subs));
    }

    fn retry(&self) -> Retry {
        Retry {
            max: self.s.num("launcher.spawn_retry_max"),
            base_ms: self.s.num("launcher.spawn_backoff_base_ms"),
            cap_ms: self.s.num("launcher.spawn_backoff_cap_ms"),
            jitter_pct: self.s.num("launcher.spawn_jitter_pct"),
        }
    }

    fn feed_stream(&self, spool: Option<PathBuf>) -> Feed {
        Feed {
            spool: spool.filter(|_| self.more),
            spool_max: self.s.num("launcher.spool_max_bytes"),
            file: None,
            prefix: self.payload.clone(),
            more: self.more,
            idle: Duration::from_millis(self.s.num("launcher.stdin_idle_ms")),
            write_stall: Duration::from_millis(self.s.num("launcher.write_timeout_ms")),
            chunk: self.s.num("launcher.io_chunk_bytes") as usize,
            soft: self.s.num("launcher.stdin_soft_bytes"),
            hard: self.s.num("launcher.stdin_hard_bytes"),
        }
    }

    fn feed_memory(&self, bytes: &[u8]) -> Feed {
        Feed::memory(
            bytes,
            Duration::from_millis(self.s.num("launcher.write_timeout_ms")),
            self.s.num("launcher.io_chunk_bytes") as usize,
        )
    }

    fn reaper_on(&self) -> bool {
        self.s.num("launcher.reaper") == 1
    }

    fn removals(&self) -> Vec<String> {
        self.ignored_knobs.clone()
    }

    /// Cold start for a guard event: ask for the daemon start (one launcher at a time), wait for its socket. `Some(code)` ends the call.
    fn cold_guard_wait(&self, engine: &str, eng_ms: u64) -> Option<i32> {
        let cap = self.s.num("client.cold_guard_wait_ms");
        let poll = self.s.num("client.cold_guard_poll_ms");
        let sock_max = self.s.num("paths.socket_max_len");
        let margin = self.s.num("client.wrapper_extra_ms");
        let kick = self.key("client.cold_guard_kick_event");
        let sock_name = self.key("paths.socket_file");
        if cap == 0
            || poll == 0
            || sock_max == 0
            || margin == 0
            || kick.is_empty()
            || sock_name.is_empty()
        {
            return None;
        }
        let nospawn = self.key("env.nospawn");
        if !nospawn.is_empty() && std::env::var_os(nospawn).is_some() {
            return None;
        }
        if self.state_dir.as_os_str().is_empty() {
            return None;
        }
        // a state directory whose plain socket path is too long for sun_path has its socket at the engine's private hashed path
        // (the same one the engine uses): the cold wait must watch THAT path, not skip the wait (a long HOME let the first
        // cold guard call through unchecked at the launcher's 560 ms budget)
        let sock = crate::util::engine_socket(&self.s, &self.state_dir);
        let hashed = sock != self.state_dir.join(sock_name);
        if sock.as_os_str().len() as u64 > sock_max {
            return None;
        }
        let probed = gate::probe(
            &sock,
            Duration::from_millis(self.s.num("launcher.connect_timeout_ms")),
        );
        if probed == Sock::Live {
            return None;
        }
        if hashed {
            limits::bump(Ctr::ColdWaitHashed); // the wait runs for a state dir whose socket is at the hashed private path (it was skipped)
        }
        // a socket file nobody listens on that is NEWER than a start request is a daemon that request started and that then died: the
        // request is no reason to keep waiting (a daemon still starting has not bound its socket yet, so the file is older than its request)
        let sock_ms = (probed == Sock::Stale)
            .then(|| {
                std::fs::metadata(&sock)
                    .ok()?
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_millis() as u64)
            })
            .flatten();
        let total_ms = self
            .event_timeout_s()
            .unwrap_or(self.timeout_s)
            .saturating_mul(1000);
        let room = total_ms
            .checked_sub(eng_ms.saturating_add(margin))
            .filter(|r| *r > 0)?;
        let cap = cap.min(room);
        let start = Instant::now();
        if self.halted() {
            return None;
        }
        let right = gate::acquire(
            &self.state_dir,
            &self.key("files.launcher_spawn_lock"),
            &self.key("files.launcher_spawn_log"),
            cap,
            sock_ms,
            self.s.num("launcher.crashloop_window_s"),
            self.s.num("launcher.crashloop_max"),
        );
        let _held = match right {
            Right::Kick(f) => Some(f),
            Right::WaitOnly => None,
            Right::Tripped => {
                limits::bump(Ctr::KickSkipped);
                self.log_line(&format!("cold_kick_tripped event={}", self.event));
                return None;
            }
            Right::Unavailable => return None,
        };
        if _held.is_some() {
            let grace_ms = self.grace.as_millis() as u64;
            let (kick_ms, grace) = if cap > grace_ms {
                (cap - grace_ms, self.grace)
            } else {
                (cap, Duration::ZERO)
            };
            let argv = [
                engine.to_string(),
                "hook".into(),
                "--event".into(),
                kick.clone(),
                "--host".into(),
                self.host.clone(),
            ];
            let body = format!("{{\"hook_event_name\":\"{kick}\"}}");
            let removals = self.removals();
            let r = proc::run_child(&Opts {
                argv: &argv,
                envs: &[],
                env_remove: &removals,
                feed: self.feed_memory(body.as_bytes()),
                budget: Duration::from_millis(kick_ms),
                wait_file: None,
                done_file: None,
                slow_max: Duration::ZERO,
                grace,
                drain: Duration::from_millis(self.s.num("launcher.io_drain_ms")),
                strict_group: true,
                out_cap: self.s.num("launcher.err_cap_bytes") as usize,
                err_cap: self.s.num("launcher.err_cap_bytes") as usize,
                retry: self.retry(),
                reaper: self.reaper_on().then(Vec::new),
            });
            match r {
                Run::TimedOut => {
                    self.diag(&format!(
                        "cold_guard_gave_up event={} cap_ms={cap} kick_cut=1",
                        self.event
                    ));
                    if self.capacity_held() {
                        return Some(2);
                    }
                    self.cold_notice();
                    return Some(0);
                }
                Run::Exited { code: 0, .. } => {}
                _ => return None, // the kick failed: no daemon is coming, the real attempt fails open the usual way
            }
        }
        let probe_to = Duration::from_millis(self.s.num("launcher.connect_timeout_ms"));
        loop {
            if gate::probe(&sock, probe_to) == Sock::Live || self.halted() {
                return None;
            }
            if start.elapsed() >= Duration::from_millis(cap) {
                break;
            }
            std::thread::sleep(Duration::from_millis(poll));
        }
        self.diag(&format!(
            "cold_guard_gave_up event={} cap_ms={cap}",
            self.event
        ));
        if hashed {
            limits::bump(Ctr::ColdWaitHashedExpired);
        }
        if self.capacity_held() {
            return Some(2);
        }
        self.cold_notice();
        Some(0)
    }

    /// #882: no engine answer for lack of capacity (a cold start not up in time, the wall-clock backstop of a late engine): a guard
    /// call in a hold class of `dispatch.capacity_hold` (a push, a merge, a recursive delete, a deploy) is held with the engine's own
    /// reason and retry hint (`dispatch.msg_capacity_hold`), as the engine's client holds it (`dispatch::capacity_held`), never let
    /// through unchecked. Anything else, an unreadable payload or config, or `dispatch.failure_mode` `capacity` not open passes.
    fn capacity_held(&self) -> bool {
        let open = self
            .s
            .shipped("dispatch.failure_mode")
            .and_then(|v| v.get("capacity"))
            .and_then(|v| v.as_str())
            == Some("open");
        if !self.guard || !open {
            return false;
        }
        let Some(cfg) = self.s.shipped("dispatch.capacity_hold") else {
            return false;
        };
        let Ok(p) = serde_json::from_slice::<serde_json::Value>(&self.payload) else {
            return false;
        };
        let Some(tool) = p.get("tool_name").and_then(|v| v.as_str()) else {
            return false;
        };
        let listed = cfg
            .get("tools")
            .and_then(|v| v.as_array())
            .is_some_and(|a| a.iter().any(|t| t.as_str() == Some(tool)));
        let field = cfg
            .get("field")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let (Some(command), Some(rules)) = (
            p.get("tool_input")
                .and_then(|i| i.get(field))
                .and_then(|v| v.as_str()),
            cfg.get("rules").and_then(|v| v.as_table()),
        ) else {
            return false;
        };
        // #907: the command read the way the shell reads it (in-word quotes and backslashes gone, only an unquoted separator splits,
        // the free text of a gh pr/issue/release command blanked), as dispatch::capacity_decide; a command it can not balance is held
        // under `unreadable` (#918 review: the quote-blind raw text alone would let any such tail switch the reading off)
        let ncfg = Self::capacity_norm_cfg(cfg);
        // #928: the cleanup of a path the command made itself (`t=$(mktemp -d); ..; rm -rf "$t"`) is no risky delete
        let (blanked, own) = ncfg
            .as_ref()
            .map_or((command.to_string(), 0), |c| shellwords::blank_own_temp(command, c));
        for _ in 0..own {
            limits::bump(Ctr::CapacityOwnTemp);
        }
        let command = blanked.as_str();
        let norm = ncfg
            .as_ref()
            .and_then(|c| shellwords::normalise(command, c));
        if let Some(n) = norm.as_ref().filter(|n| n.opt_skips > 0) {
            for _ in 0..n.opt_skips {
                limits::bump(Ctr::CapacityWrapperOpt);
            }
        }
        // #901/#904: a plain read that only names the words passes (read_only, minus read_only_unless), as
        // dispatch::capacity_read_only; a broken or empty exemption exempts nothing
        if listed
            && self.capacity_read_only(cfg, norm.as_ref().map_or(command, |n| n.text.as_str()))
        {
            return false;
        }
        // a blanked gh text value leaves only the normalised text to match: the raw text still holds the words that were data
        let mut texts: Vec<&str> = match &norm {
            Some(n) if n.stripped => vec![n.text.as_str()],
            Some(n) => vec![command, n.text.as_str()],
            None => vec![command],
        };
        texts.extend(norm.iter().flat_map(|n| n.extra.iter().map(String::as_str)));
        let (mut raw_only_hit, mut via_norm) = (false, false);
        let mut rule = None;
        let mut via: Option<Ctr> = None; // #920: the class the hold falls in beyond its rule (counted)
        if listed {
            for (name, pat) in rules {
                let Some(pat) = pat.as_str() else { continue };
                // ASCII classes (\b, \s, case folding) on bytes: the launcher's regex is built without the Unicode tables
                match regex::bytes::RegexBuilder::new(pat)
                    .unicode(false)
                    .case_insensitive(true)
                    .build()
                {
                    Ok(re) => {
                        if let Some(at) = texts.iter().position(|t| re.is_match(t.as_bytes())) {
                            via_norm = at > 0 && !re.is_match(command.as_bytes());
                            rule = Some(name.clone());
                            if cfg
                                .get("inline_rules")
                                .and_then(|v| v.as_array())
                                .is_some_and(|a| {
                                    a.iter().any(|r| r.as_str() == Some(name.as_str()))
                                })
                            {
                                via = Some(Ctr::CapacityInlineCode);
                            }
                            break;
                        }
                        raw_only_hit |= norm.as_ref().is_some_and(|n| n.stripped)
                            && re.is_match(command.as_bytes());
                    }
                    Err(e) => {
                        self.log_line(&format!("capacity_hold_rule rule={name} error={e}"));
                    }
                }
            }
            // a git subcommand that is no known one (an alias, an external command) is held under its own rule
            if rule.is_none()
                && let Some(n) = &norm
                && n.git_unknown.is_some()
                && let Some(r) = cfg
                    .get("git")
                    .and_then(|g| g.get("rule"))
                    .and_then(|v| v.as_str())
                    .filter(|r| !r.is_empty())
            {
                via_norm = true;
                rule = Some(r.to_string());
            }
            // #920: a gh subcommand no list knows (a gh alias), a script run by path, a command name no list knows that is no binary
            // on PATH (a shell alias or function defined earlier in the session), as the engine's dispatch::capacity_decide
            if rule.is_none()
                && let (Some(n), Some(nc)) = (&norm, &ncfg)
            {
                if n.gh_unknown.is_some() && !nc.gh_rule.is_empty() {
                    rule = Some(nc.gh_rule.clone());
                    via = Some(Ctr::CapacityGhUnknown);
                } else if let Some((r, c)) = self.capacity_script(cfg, &p, n, nc, rules) {
                    rule = Some(r);
                    via = Some(c);
                } else if let Some(u) = cfg.get("unknown")
                    && let Some(r) = u
                        .get("rule")
                        .and_then(|v| v.as_str())
                        .filter(|r| !r.is_empty())
                {
                    let lookup = u.get("path_lookup").and_then(|v| v.as_integer()) != Some(0);
                    let path = std::env::var_os(
                        u.get("path_env")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default(),
                    );
                    // #928: a tool only in a project-local tool directory (.venv/bin, node_modules/.bin, target/debug) inside the repo
                    let dirs = shellwords::dirs(
                        p.get(
                            cfg.get("script")
                                .and_then(|s| s.get("cwd_field"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default(),
                        )
                        .and_then(|v| v.as_str()),
                        &n.cds,
                        None,
                    );
                    if n.unknown_cmds.iter().any(|c| {
                        if lookup && shellwords::on_path(c, path.as_deref()) {
                            return false;
                        }
                        if lookup
                            && shellwords::local_tool(c, &dirs, &nc.local_dirs, &nc.repo_marker)
                        {
                            limits::bump(Ctr::CapacityLocalTool);
                            return false;
                        }
                        true
                    }) {
                        rule = Some(r.to_string());
                        via = Some(Ctr::CapacityUnknownCommand);
                        via_norm = true;
                    }
                }
                via_norm |= via.is_some();
            }
        }
        if listed
            && rule.is_none()
            && ncfg.is_some()
            && norm.is_none()
            && let Some(r) = cfg
                .get("unreadable")
                .and_then(|v| v.as_str())
                .filter(|r| !r.is_empty())
        {
            via_norm = true;
            rule = Some(r.to_string());
        }
        if rule.is_none() && raw_only_hit {
            limits::bump(Ctr::CapacityTextExempt);
        }
        let Some(rule) = rule else {
            return false;
        };
        if via_norm {
            limits::bump(Ctr::CapacityHoldNormalised);
        }
        if let Some(c) = via {
            limits::bump(c);
        }
        limits::bump(Ctr::CapacityHold);
        self.log_line(&format!("capacity_hold event={} rule={rule}", self.event));
        let msg = self.s.msg(
            "dispatch.msg_capacity_hold",
            &[("tool", tool), ("rule", &rule)],
        );
        write_out(b"", format!("{msg}\n").as_bytes());
        true
    }

    /// #920: the scripts a command runs by path (at most `script.max_refs` read in all), read when at most `script.max_bytes` and
    /// matched by the same rules (read the way the shell does, comments gone), and the scripts each runs in turn (`script.depth`
    /// levels), from the payload's cwd and each directory the command `cd`s to: the rule (`script.rule_prefix` + the rule) and its
    /// counter. A text script within `script.scan_bytes` is matched as written by `script.scan_rules`; a bigger, binary or unreadable
    /// one is held under `script.rule_unread` only when the command matches `script.risky`. As the engine's
    /// dispatch::capacity_script.
    fn capacity_script(
        &self,
        cfg: &toml::Value,
        payload: &serde_json::Value,
        n: &shellwords::Normalised,
        ncfg: &shellwords::Cfg,
        rules: &toml::value::Table,
    ) -> Option<(String, Ctr)> {
        let sc = cfg.get("script")?;
        let int = |k: &str| {
            sc.get(k)
                .and_then(|v| v.as_integer())
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or_default()
        };
        let text = |k: &str| sc.get(k).and_then(|v| v.as_str()).unwrap_or_default();
        let skip: Vec<&str> = sc
            .get("body_skip")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let raw_rules: Vec<&str> = sc
            .get("raw_rules")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let scan_rules: Vec<&str> = sc
            .get("scan_rules")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let home = Some(text("home_env"))
            .filter(|k| !k.is_empty())
            .and_then(std::env::var_os);
        let dirs = shellwords::dirs(
            payload.get(text("cwd_field")).and_then(|v| v.as_str()),
            &n.cds,
            home.as_deref(),
        );
        let compile = |pat: &str| {
            regex::bytes::RegexBuilder::new(pat)
                .unicode(false)
                .case_insensitive(true)
                .build()
                .ok()
        };
        let held = |name: &str| {
            Some((
                format!("{}{name}", text("rule_prefix")),
                Ctr::CapacityScriptRead,
            ))
        };
        // #928: the cleanup of a path a script made itself is no risky delete (counted once per script, held or not)
        let own_temp = |body: &str| {
            let (b, n) = shellwords::blank_own_temp(body, ncfg);
            for _ in 0..n {
                limits::bump(Ctr::CapacityOwnTemp);
            }
            b
        };
        let mut unread = false;
        let mut seen: Vec<String> = Vec::new();
        let mut queue: std::collections::VecDeque<(String, usize)> =
            n.scripts.iter().map(|p| (p.clone(), 0)).collect();
        while let Some((path, depth)) = queue.pop_front() {
            if seen.contains(&path) {
                continue;
            }
            if seen.len() >= int("max_refs") {
                break;
            }
            seen.push(path.clone());
            match shellwords::read_script(
                &path,
                &dirs,
                home.as_deref(),
                int("max_bytes"),
                int("scan_bytes"),
            ) {
                shellwords::Script::Text(body) => {
                    let body = own_temp(&body);
                    let norm = shellwords::normalise(&body, ncfg);
                    let texts: Vec<&str> = match &norm {
                        Some(nb) => std::iter::once(nb.text.as_str())
                            .chain(nb.extra.iter().map(String::as_str))
                            .collect(),
                        None => vec![body.as_str()],
                    };
                    // a rule for what no reading can tell (`$cmd`) holds nearly every real script
                    for (name, pat) in rules
                        .iter()
                        .filter(|(name, _)| !skip.contains(&name.as_str()))
                    {
                        if pat
                            .as_str()
                            .and_then(compile)
                            .is_some_and(|re| texts.iter().any(|t| re.is_match(t.as_bytes())))
                        {
                            return held(name);
                        }
                    }
                    // #928: a rule that reads quotes is matched on the script as written too
                    for (name, pat) in rules
                        .iter()
                        .filter(|(name, _)| raw_rules.contains(&name.as_str()))
                    {
                        if pat
                            .as_str()
                            .and_then(compile)
                            .is_some_and(|re| re.is_match(body.as_bytes()))
                        {
                            return held(name);
                        }
                    }
                    // the scripts this one runs (`source ./lib.sh`, `sh other.sh`)
                    if depth < int("depth") {
                        queue.extend(
                            norm.iter().flat_map(|nb| {
                                nb.scripts.iter().map(move |p| (p.clone(), depth + 1))
                            }),
                        );
                    }
                }
                shellwords::Script::Large(body) => {
                    let body = own_temp(&body);
                    for (name, pat) in rules
                        .iter()
                        .filter(|(name, _)| scan_rules.contains(&name.as_str()))
                    {
                        if pat
                            .as_str()
                            .and_then(compile)
                            .is_some_and(|re| re.is_match(body.as_bytes()))
                        {
                            return held(name);
                        }
                    }
                }
                shellwords::Script::Unread => unread = true,
                shellwords::Script::Skip => {}
            }
        }
        let rule = text("rule_unread");
        let risky = compile(text("risky")).filter(|_| !text("risky").is_empty());
        (unread && !rule.is_empty() && risky.is_some_and(|re| re.is_match(n.text.as_bytes())))
            .then(|| (rule.to_string(), Ctr::CapacityScriptUnread))
    }

    /// #907: the word lists of the shell-word normaliser from `dispatch.capacity_hold` (`normalise` 0 switches it off: the raw text
    /// alone is matched), as the engine's dispatch::capacity_norm_cfg.
    fn capacity_norm_cfg(cfg: &toml::Value) -> Option<shellwords::Cfg> {
        if cfg.get("normalise").and_then(|v| v.as_integer()) == Some(0) {
            return None;
        }
        let strs = |v: Option<&toml::Value>| -> Vec<String> {
            v.and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let one =
            |v: Option<&toml::Value>| v.and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let count = |k: &str| {
            cfg.get(k)
                .and_then(|v| v.as_integer())
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or_default()
        };
        let (text, git) = (cfg.get("text"), cfg.get("git"));
        Some(shellwords::Cfg {
            text_verb: one(text.and_then(|t| t.get("verb"))),
            text_subs: strs(text.and_then(|t| t.get("subs"))),
            text_opts: strs(text.and_then(|t| t.get("opts"))),
            git_rule: one(git.and_then(|g| g.get("rule"))),
            git_known: strs(git.and_then(|g| g.get("known"))),
            git_opts_with_arg: strs(git.and_then(|g| g.get("opts_with_arg"))),
            git_wrappers: strs(git.and_then(|g| g.get("wrappers"))),
            passes: count("passes"),
            brace_cap: count("brace_cap"),
            body_depth: count("body_depth"),
            gh_rule: one(cfg.get("gh").and_then(|g| g.get("rule"))),
            gh_known: strs(cfg.get("gh").and_then(|g| g.get("known"))),
            gh_opts_with_arg: strs(cfg.get("gh").and_then(|g| g.get("opts_with_arg"))),
            unknown_known: if one(cfg.get("unknown").and_then(|u| u.get("rule"))).is_empty() {
                Vec::new()
            } else {
                strs(cfg.get("unknown").and_then(|u| u.get("known")))
            },
            script_interps: strs(cfg.get("script").and_then(|s| s.get("interpreters"))),
            script_inline_flags: strs(cfg.get("script").and_then(|s| s.get("inline_flags"))),
            cmd_wrappers: strs(cfg.get("script").and_then(|s| s.get("wrappers"))),
            cmd_markers: strs(cfg.get("script").and_then(|s| s.get("markers"))),
            cd_cmds: strs(cfg.get("script").and_then(|s| s.get("cd_commands"))),
            own_cleanup: strs(cfg.get("own_temp").and_then(|o| o.get("cleanup"))),
            own_creators: strs(cfg.get("own_temp").and_then(|o| o.get("creators"))),
            own_bases: strs(cfg.get("own_temp").and_then(|o| o.get("bases"))),
            own_markers: strs(cfg.get("own_temp").and_then(|o| o.get("markers"))),
            own_prefixes: strs(cfg.get("own_temp").and_then(|o| o.get("prefixes"))),
            own_readers: strs(cfg.get("own_temp").and_then(|o| o.get("readers"))),
            local_dirs: strs(cfg.get("unknown").and_then(|u| u.get("local_dirs"))),
            repo_marker: one(cfg.get("unknown").and_then(|u| u.get("repo_marker"))),
            wrapper_opts: cfg
                .get("script")
                .and_then(|s| s.get("wrapper_opts"))
                .and_then(|t| t.as_table())
                .map(|t| {
                    t.iter()
                        .map(|(k, v)| (k.to_string(), strs(Some(v))))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    /// #901/#904: whether `command` is a plain read that passes dispatch.capacity_hold whatever words it names: the whole command
    /// matches `read_only` and does not match `read_only_unless` (as the engine's dispatch::capacity_read_only). Fails closed: an
    /// empty or uncompilable `read_only`, or an uncompilable `read_only_unless`, exempts nothing, so the rules decide.
    fn capacity_read_only(&self, cfg: &toml::Value, command: &str) -> bool {
        let compile = |key: &str| -> Option<Result<regex::bytes::Regex, ()>> {
            let pat = cfg
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())?;
            Some(
                regex::bytes::RegexBuilder::new(pat)
                    .unicode(false)
                    .case_insensitive(true)
                    .build()
                    .map_err(|e| {
                        self.log_line(&format!("capacity_hold_rule rule={key} error={e}"))
                    }),
            )
        };
        let Some(Ok(read_only)) = compile("read_only") else {
            return false;
        };
        if !read_only.is_match(command.as_bytes()) {
            return false;
        }
        match compile("read_only_unless") {
            None => true,
            Some(Ok(unless)) => !unless.is_match(command.as_bytes()),
            Some(Err(())) => false,
        }
    }

    /// dispatch.defer_exit: the engine handed the call back. No hook command exists to run, so the call passes through
    /// unchecked with one notice per session, like every other unreachable-engine outcome.
    fn handed_back(&self) -> i32 {
        self.log_line(&format!("engine_handed_back event={}", self.event));
        self.integrity("fail");
        self.unreachable_notice_for("msg.launcher_unreachable_why_handed_back");
        0
    }

    fn stats_value(&self) -> String {
        format!(
            "v=1;startup_us={};prefix={};host={}{}{}",
            self.t0.elapsed().as_micros(),
            self.payload.len(),
            self.host,
            if limits::render_counters().is_empty() {
                ""
            } else {
                ";"
            },
            limits::render_counters()
        )
    }

    fn run_engine(&self, engine: &str, run_dir: Option<&Path>, eng_ms: u64) -> i32 {
        let mut envs = Vec::new();
        let done = run_dir.map(|d| d.join(self.key("launcher.run_done_file")));
        let wait = run_dir.map(|d| d.join(self.key("launcher.run_wait_file")));
        let spool = run_dir.map(|d| d.join(self.key("launcher.run_spool_file")));
        let fail_open = run_dir.map(|d| d.join(self.key("launcher.run_fail_open_file")));
        if let (Some(name), Some(p)) = (
            Some(self.key("env.fail_open_file")).filter(|n| !n.is_empty()),
            &fail_open,
        ) {
            envs.push((name, p.display().to_string()));
        }
        if let (Some(name), Some(p)) = (
            Some(self.key("env.done_file")).filter(|n| !n.is_empty()),
            &done,
        ) {
            envs.push((name, p.display().to_string()));
        }
        let mut slow_max = self.s.num_event(
            "client.slow_fallback_max_ms",
            "client.slow_fallback_event_ms",
            &self.event,
        );
        slow_max = slow_max.min(
            self.event_timeout_s()
                .unwrap_or(self.timeout_s)
                .saturating_mul(1000),
        );
        let mut wait_file = None;
        match (
            Some(self.key("env.wait_file")).filter(|n| !n.is_empty()),
            &wait,
        ) {
            (Some(name), Some(p)) if slow_max > eng_ms => {
                envs.push((name, p.display().to_string()));
                wait_file = Some(p.as_path());
            }
            _ => slow_max = 0,
        }
        if let Some(root) = &self.plugin_root {
            envs.push((self.key("env.plugin_root"), root.display().to_string()));
        }
        envs.push((self.key("launcher.stats_env"), self.stats_value()));
        if let Some(name) = Some(self.key("env.hook_version")).filter(|n| !n.is_empty()) {
            envs.push((name, env!("AH_BUILD_VERSION").to_string()));
        }
        if let Some(name) = Some(self.key("env.hook_engine_min")).filter(|n| !n.is_empty()) {
            envs.push((name, crate::compat::ENGINE_MIN.to_string()));
        }
        let argv = [
            engine.to_string(),
            "hook".into(),
            "--event".into(),
            self.event.clone(),
            "--host".into(),
            self.host.clone(),
        ];
        let cleanup = run_dir.and_then(|d| {
            let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).ok();
            Some(vec![
                c(done.as_deref()?)?,
                c(wait.as_deref()?)?,
                c(spool.as_deref()?)?,
                c(fail_open.as_deref()?)?,
                c(d)?,
            ])
        });
        let removals = self.removals();
        let r = proc::run_child(&Opts {
            argv: &argv,
            envs: &envs,
            env_remove: &removals,
            feed: self.feed_stream(spool.clone()),
            budget: Duration::from_millis(eng_ms),
            wait_file,
            done_file: done.as_deref(),
            slow_max: Duration::from_millis(slow_max),
            grace: self.grace,
            drain: Duration::from_millis(self.s.num("launcher.io_drain_ms")),
            strict_group: true,
            out_cap: self.s.num("launcher.out_cap_bytes") as usize,
            err_cap: self.s.num("launcher.err_cap_bytes") as usize,
            retry: self.retry(),
            reaper: self.reaper_on().then(|| cleanup.unwrap_or_default()),
        });
        if let Some(p) = &fail_open {
            self.count_reported_fail_opens(p);
        }
        let done_marked = done.as_deref().is_some_and(Path::exists);
        let defer = self.s.num("dispatch.defer_exit") as i32;
        match r {
            Run::Exited {
                code: c @ (0 | 2),
                out,
                err,
                overflow,
                ..
            } => {
                if overflow {
                    limits::bump(Ctr::OutOverflow);
                    self.log_line(&format!(
                        "engine_output_overflow event={} rc={c}",
                        self.event
                    ));
                    if c == 2 {
                        write_out(b"", &err); // a block keeps blocking; its (truncated) reason is all that is kept
                        return 2;
                    }
                    return 0;
                }
                write_out(&out, &err);
                c
            }
            Run::Exited { code, .. } if code == defer => self.handed_back(),
            Run::Exited {
                code,
                out,
                err,
                overflow: false,
                ..
            } if done_marked => {
                write_out(&out, &err);
                code
            }
            Run::Exited { code, .. } => {
                self.diag(&format!(
                    "engine_silent_exit event={} timeout_ms={eng_ms} rc={code} done=0",
                    self.event
                ));
                self.log_line(&format!(
                    "engine_silent_exit event={} rc={code}",
                    self.event
                ));
                self.integrity("fail");
                self.unreachable_notice_for("msg.launcher_unreachable_why_silent");
                0
            }
            Run::TimedOut => {
                self.diag(&format!(
                    "engine_timed event={} timeout_ms={eng_ms} done={}",
                    self.event,
                    u8::from(done_marked)
                ));
                self.log_line(&format!(
                    "engine_timed event={} timeout_ms={eng_ms} wall_ms={} done={}",
                    self.event,
                    self.t0.elapsed().as_millis(),
                    u8::from(done_marked)
                ));
                self.integrity("fail");
                if self.capacity_held() {
                    return 2;
                }
                self.unreachable_notice_for("msg.launcher_unreachable_why_timed_out");
                0
            }
            Run::GroupAlive => {
                self.diag(&format!(
                    "engine_group_alive event={} timeout_ms={eng_ms}",
                    self.event
                ));
                self.log_line(&format!("engine_group_alive event={}", self.event));
                self.integrity("fail");
                // the engine did not finish in time either: no answer for lack of capacity, so a risky guard call is held (#901)
                if self.capacity_held() {
                    return 2;
                }
                self.unreachable_notice_for("msg.launcher_unreachable_why_unfinished");
                0
            }
            Run::SpawnFailed { errno } => {
                self.log_line(&format!(
                    "engine_spawn_failed event={} errno={}",
                    self.event,
                    errno.unwrap_or(0)
                ));
                if errno != Some(libc::ENOENT) {
                    self.integrity("fail"); // present but cannot start (corrupt, wrong format): the rollback counts it
                }
                self.unreachable_notice_for("msg.launcher_unreachable_why_not_started");
                0
            }
        }
    }

    /// The engine told its client (in the reply) that it failed open for these calls: count each one and keep the reason in the
    /// local log, which is only ever written on a failure path. Bounded by `launcher.err_cap_bytes`; a missing file is no fail-open.
    fn count_reported_fail_opens(&self, path: &Path) {
        use std::io::Read;
        let cap = self.s.num("launcher.err_cap_bytes");
        let mut text = String::new();
        if let Ok(f) = std::fs::File::open(path) {
            let _ = f.take(cap).read_to_string(&mut text); // best effort: an unreadable marker is no fail-open
        }
        for line in text.lines().filter(|l| !l.is_empty()) {
            limits::bump(Ctr::FailOpen);
            self.log_line(&format!("engine_fail_open event={} {line}", self.event));
        }
    }

    /// Test-only fault injection (honoured only with the test flag): exercises the never-panic and the hard-limit paths.
    fn fault(&self) {
        let Some(kind) = self.knob("launcher.knob_fault") else {
            return;
        };
        match kind.as_str() {
            "panic" => panic!("injected"),
            "hang" => loop {
                std::thread::park();
            },
            "spin" => {
                let mut x = 0u64;
                loop {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            }
            "alloc" => {
                let mut keep: Vec<Vec<u8>> = Vec::new();
                loop {
                    keep.push(vec![1u8; self.s.num("launcher.io_chunk_bytes") as usize]);
                    std::hint::black_box(&keep);
                }
            }
            _ => {}
        }
    }

    /// The soft limits and the call's summary: warn + count, never change the outcome.
    fn finish_soft(&self, planned_soft_ms: u64) {
        let mut hits = Vec::new();
        if limits::mem_peak() as u64 > self.s.num("launcher.mem_soft_bytes") {
            limits::bump(Ctr::MemSoft);
            hits.push("mem");
        }
        if limits::cpu_ms() > self.s.num("launcher.cpu_soft_ms") {
            limits::bump(Ctr::CpuSoft);
            hits.push("cpu");
        }
        if self.t0.elapsed().as_millis() as u64 > planned_soft_ms {
            limits::bump(Ctr::WallSoft);
            hits.push("wall");
        }
        if !hits.is_empty() {
            self.log_line(&format!(
                "soft_limit event={} {} wall_ms={} {}",
                self.event,
                hits.join(","),
                self.t0.elapsed().as_millis(),
                limits::render_counters()
            ));
        }
        self.diag(&format!(
            "launcher_stats event={} mem_peak={} cpu_ms={} wall_ms={} prefix={} {}",
            self.event,
            limits::mem_peak(),
            limits::cpu_ms(),
            self.t0.elapsed().as_millis(),
            self.payload.len(),
            limits::render_counters()
        ));
    }
}

pub fn find_engine(
    home: Option<&PathBuf>,
    s: &Settings,
    knob_bin: Option<String>,
) -> Option<String> {
    if let Some(b) = knob_bin {
        return is_exec(Path::new(&b)).then_some(b);
    }
    let installed = home.map(|h| {
        h.join(s.text("paths.base_dir"))
            .join(s.text("paths.state_dir"))
            .join(s.text("launcher.engine_bin_rel"))
    });
    if let Some(p) = installed.filter(|p| is_exec(p)) {
        return Some(p.display().to_string());
    }
    let name = s.text("launcher.engine_bin_name");
    std::env::var_os("PATH")
        .and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join(&name))
                .find(|p| is_exec(p))
        })
        .map(|p| p.display().to_string())
}

/// One spelling per plugin directory (symlinks and `..` resolved; unchanged when it cannot be resolved): the hook client's
/// defaults cache holds a single root, so two spellings of the same plugin would make every other call re-parse the files.
fn canonical(p: PathBuf) -> PathBuf {
    std::fs::canonicalize(&p).unwrap_or(p)
}

/// The plugin this launcher serves: `--plugin-root`, else the host's plugin-root variable, else the directory above the binary.
fn plugin_root(args: &[String], env_names: &[String]) -> Option<PathBuf> {
    let flag = args
        .iter()
        .position(|a| a == "--plugin-root")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let mut candidates = vec![flag];
    candidates.extend(env_names.iter().map(|n| env_nonempty(n).map(PathBuf::from)));
    candidates.push(
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent()?.parent().map(Path::to_path_buf)),
    );
    candidates
        .into_iter()
        .flatten()
        .find(|r| r.join(builtin::HOOKS_DIR).is_dir())
        .map(canonical)
}

fn has_defaults_index(root: &Path) -> bool {
    root.join(builtin::CFG_REL_DIR)
        .join(builtin::CFG_MARKER_FILE)
        .is_file()
}

/// The plugin root the install record names, for a hook run with no plugin root of its own (no flag, no host variable, and the
/// binary not inside a plugin): the same fallback the engine uses, so the shipped settings are read instead of the built-in copy.
fn installed_plugin_root() -> Option<PathBuf> {
    let home = env_nonempty(builtin::text("env.home")?)?;
    let dir = match env_nonempty(builtin::text("env.dir")?) {
        Some(d) => PathBuf::from(d),
        None => Path::new(&home)
            .join(builtin::text("paths.base_dir")?)
            .join(builtin::text("paths.state_dir")?),
    };
    let text = std::fs::read_to_string(dir.join(builtin::INSTALL_RECORD_FILE)).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = PathBuf::from(record.get(builtin::INSTALL_RECORD_ROOT_FIELD)?.as_str()?);
    has_defaults_index(&root).then(|| canonical(root))
}

/// The plugin root exactly as the caller wrote it (the `--plugin-root` pair, else the environment): the doctor shows paths the way
/// the engine's doctor does, without resolving symbolic links.
fn raw_plugin_root(args: &[String], env_name: &str) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == "--plugin-root")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| env_nonempty(env_name).map(PathBuf::from))
}

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

pub fn run() -> i32 {
    let t0 = Instant::now();
    let mut args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    // a build fact: answered before any settings are read, so it works with no plugin root
    if args.first().is_some_and(|a| a == "--version") {
        println!("{}", env!("AH_BUILD_VERSION"));
        return 0;
    }
    // a shim may name the plugin root first (`ah-hook --plugin-root <dir> <event|verb> ...`): the same as naming it last
    if args.first().is_some_and(|a| a == "--plugin-root") && args.len() >= 2 {
        args.rotate_left(2);
    }
    // before any settings: the host's plugin-root variable names come from the built-in copy
    let root_envs: Vec<String> = builtin::list("launcher.plugin_root_envs")
        .map(|l| l.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();
    let root = plugin_root(&args, &root_envs);
    let hooks_dir = root
        .as_ref()
        .map(|r| r.join(builtin::HOOKS_DIR))
        .unwrap_or_default();
    // the engine reads its settings from THIS plugin unless an operator override names another one
    let boot_plugin_env = builtin::text("env.plugin_root").unwrap_or_default();
    let cfg_root = match env_nonempty(boot_plugin_env) {
        Some(r) => Some(canonical(PathBuf::from(r))),
        None => root
            .clone()
            .filter(|r| has_defaults_index(r))
            .or_else(installed_plugin_root),
    };
    let cfg_dir = cfg_root
        .as_ref()
        .map(|r| r.join(builtin::CFG_REL_DIR))
        .unwrap_or_default();
    let s = Settings::load(&cfg_dir);

    // the launcher's own limits and its failure log, from the settings (or the built-in copy)
    limits::set_mem_hard(s.num("launcher.mem_hard_bytes"));
    limits::set_messages(
        &s.text("msg.launcher_mem_hard"),
        &s.text("msg.launcher_cpu_hard"),
        &s.text("msg.launcher_wall_hard"),
    );
    let _ = INTERNAL_TEXT.set(s.text("msg.launcher_internal"));
    if !limits::set_cpu_hard(s.num("launcher.cpu_hard_s")) {
        limits::bump(Ctr::ConfigFallback);
    }

    let home = env_nonempty(&s.text("env.home"))
        .filter(|h| h.starts_with('/'))
        .map(PathBuf::from);
    let state_dir = env_nonempty(&s.text("env.dir"))
        .map(PathBuf::from)
        .or_else(|| {
            home.as_ref().map(|h| {
                h.join(s.text("paths.base_dir"))
                    .join(s.text("paths.state_dir"))
            })
        })
        .unwrap_or_default();
    let log = Log {
        path: if state_dir.as_os_str().is_empty() {
            PathBuf::new()
        } else {
            state_dir.join(s.text("files.launcher_log"))
        },
        drops: state_dir.join(s.text("files.launcher_drops")),
        soft: s.num("launcher.log_soft_bytes"),
        hard: s.num("launcher.log_hard_bytes"),
        line_max: s.num("launcher.log_line_max") as usize,
        rotate_min_s: s.num("launcher.log_rotate_min_s"),
    };
    let _ = LOG.set(log);
    if !s.bad_files.is_empty() {
        limits::bump(Ctr::ConfigFallback);
        if let Some(l) = LOG.get() {
            l.append(&s.msg(
                "msg.launcher_config_invalid",
                &[("file", &s.bad_why.join("; "))],
            ));
        }
    }

    // #160: `--help` / `-h` on one of the launcher's own verbs prints its usage and stops before anything runs (an engine verb gets
    // the engine's own answer; an event name is never a help request)
    if let Some(first) = args.first()
        && args
            .iter()
            .skip(1)
            .take_while(|a| *a != "--")
            .any(|a| s.list("cli.help_flags").contains(a))
    {
        let key = if *first == s.text("launcher.cli_install_verb") {
            Some("launcher.help_install")
        } else if *first == s.text("launcher.cli_integrity_verb") {
            Some("launcher.help_integrity")
        } else if *first == s.text("launcher.cli_doctor_verb") || first == "--doctor" {
            Some("launcher.help_doctor")
        } else if first == "--selftest" {
            Some("launcher.help_selftest")
        } else {
            None
        };
        if let Some(k) = key {
            let _ = writeln!(std::io::stdout(), "{}", s.text(k));
            return 0;
        }
    }
    match args.first().map(String::as_str) {
        Some("--selftest") => {
            let s = s.with_nodeback(&cfg_dir);
            return selftest::run(
                &s,
                root.as_deref(),
                &state_dir,
                arg_after(&args, "--engine"),
            );
        }
        Some("--doctor") => {
            // the old wrapper form: the built-in diagnosis, whatever the engine says
            let mut rest = vec![s.text("launcher.arg_builtin")];
            rest.extend(cli::forwarded(&args)[1..].iter().cloned());
            let shown = raw_plugin_root(&args, boot_plugin_env)
                .or_else(|| cfg_root.clone().or(root.clone()));
            return crate::doctor::run(s, &cfg_dir, &state_dir, shown.as_deref(), &rest);
        }
        Some(first) if first == s.text("launcher.cli_doctor_verb") => {
            let shown = raw_plugin_root(&args, boot_plugin_env)
                .or_else(|| cfg_root.clone().or(root.clone()));
            return crate::doctor::run(
                s,
                &cfg_dir,
                &state_dir,
                shown.as_deref(),
                &cli::forwarded(&args)[1..],
            );
        }
        Some(first) if first == s.text("launcher.cli_integrity_verb") => {
            return crate::integrity::run(&s, &state_dir, &cli::forwarded(&args)[1..]);
        }
        Some(first) if first == s.text("launcher.cli_install_verb") => {
            let base = home
                .as_ref()
                .map(|h| h.join(s.text("paths.base_dir")))
                .unwrap_or_default();
            return crate::install::run(
                &s,
                &state_dir,
                &base,
                cfg_root.as_deref().or(root.as_deref()),
                &cli::forwarded(&args)[1..],
            );
        }
        Some(first) if first == s.text("launcher.cli_update_verb") => {
            let base = home
                .as_ref()
                .map(|h| h.join(s.text("paths.base_dir")))
                .unwrap_or_default();
            return crate::update::run(
                &s,
                &state_dir,
                &base,
                cfg_root.as_deref().or(root.as_deref()),
                &cli::forwarded(&args)[1..],
            );
        }
        Some(first) if cli::is_verb(&s, first) => {
            return cli::exec_engine(
                &s,
                &args,
                home.as_ref(),
                cfg_root.as_deref().or(root.as_deref()),
            );
        }
        _ => {}
    }
    let event = args.first().cloned().unwrap_or_default();
    if event.is_empty() || event.starts_with("--") {
        if let Some(l) = LOG.get() {
            l.append("no_event");
        }
        return 0;
    }

    let test = env_nonempty(&s.text("launcher.test_flag_env")).is_some_and(|v| v == "1");
    let knob_keys = [
        "launcher.knob_engine_bin",
        "launcher.knob_fallback_list",
        "launcher.knob_timeout_s",
        "launcher.knob_timeout_ms",
        "launcher.knob_kill_grace_s",
        "launcher.knob_sweep_age_s",
    ];
    let mut ignored_knobs = Vec::new();
    if !test {
        for k in knob_keys {
            let name = s.text(k);
            if env_nonempty(&name).is_some() {
                ignored_knobs.push(name);
            }
        }
        if !ignored_knobs.is_empty() {
            say(&s.msg(
                "msg.launcher_ignored_knobs",
                &[("vars", &ignored_knobs.join(" "))],
            ));
        }
    }

    let hosts = s.list("launcher.hosts");
    let mut host = hosts.first().cloned().unwrap_or_default();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--host" {
            match args.get(i + 1) {
                Some(h) if hosts.contains(h) => {
                    host.clone_from(h);
                    i += 1;
                }
                _ => say(&s.text("msg.launcher_bad_host")),
            }
        } else if args[i] == "--plugin-root" {
            i += 1;
        }
        i += 1;
    }

    // the Node fallback switch is on (`ah-engine fallback node`): the launcher runs the original Node hooks itself, no engine. While the
    // Node backup directory is missing the switch does nothing: one notice line, and the engine decides as it would with the switch off.
    let switch_on = !state_dir.as_os_str().is_empty()
        && state_dir.join(s.text("files.fallback_switch")).exists();
    let s = if switch_on {
        s.with_nodeback(&cfg_dir)
    } else {
        s
    };
    if switch_on {
        let node_dir = cfg_root
            .as_deref()
            .or(root.as_deref())
            .map(|r| r.join(s.text("nodeback.node_dir")));
        if let Some(d) = node_dir.as_ref().filter(|d| !d.is_dir()) {
            say(&s.msg(
                "nodeback.msg_no_node_dir",
                &[("dir", &d.display().to_string())],
            ));
        } else {
            let guard = s.list("dispatch.guard_events").contains(&event);
            let tool_flag = s.text("launcher.arg_tool_from_payload");
            let (payload, _) = proc::read_prefix(
                0,
                s.num("launcher.payload_prefix_bytes") as usize,
                Duration::from_millis(s.num("launcher.stdin_idle_ms")),
                s.num("launcher.io_chunk_bytes") as usize,
            );
            let list_override = if test {
                env_nonempty(&s.text("launcher.knob_fallback_list")).map(PathBuf::from)
            } else {
                None
            };
            return nodeback::Call {
                s: &s,
                event: &event,
                host: &host,
                tool_from_payload: args.contains(&tool_flag),
                guard,
                plugin_root: cfg_root.as_deref().or(root.as_deref()),
                state_dir: &state_dir,
                list_override,
                payload: &payload,
                grace: Duration::from_millis(s.num("client.wrapper_kill_grace_ms")),
            }
            .run();
        }
    }

    // the part of the payload the launcher keeps and inspects; the rest is streamed through later
    let (prefix, more) = proc::read_prefix(
        0,
        s.num("launcher.payload_prefix_bytes") as usize,
        Duration::from_millis(s.num("launcher.stdin_idle_ms")),
        s.num("launcher.io_chunk_bytes") as usize,
    );
    if prefix.len() as u64 > s.num("launcher.stdin_soft_bytes") {
        limits::bump(Ctr::StdinSoft);
    }

    let host_key = |what: &str| format!("launcher.{what}_{host}");
    let mut l = L {
        list: PathBuf::new(),
        s,
        event,
        host: host.clone(),
        hooks_dir,
        plugin_root: cfg_root.or(root),
        guard: false,
        test,
        state_dir,
        home,
        payload: Arc::new(prefix),
        more,
        timeout_s: 0,
        timeout_ms: 0,
        grace: Duration::ZERO,
        ev_s: None,
        t0,
        ignored_knobs,
    };
    l.guard = l.s.list("dispatch.guard_events").contains(&l.event);
    l.list = l
        .knob("launcher.knob_fallback_list")
        .map(PathBuf::from)
        .unwrap_or_else(|| l.hooks_dir.join(l.key(&host_key("fallback_list"))));

    l.stale_engine_notice();

    // budgets: the test knobs, else the shipped client deadline + slack + wrapper margin
    let knob_s = l.knob("launcher.knob_timeout_s");
    let knob_ms = l.knob("launcher.knob_timeout_ms");
    l.timeout_s = match &knob_s {
        Some(v) => match positive(v) {
            Some(n) => n,
            None => return l.closed_if_guard("msg.launcher_why_timeout_s"),
        },
        None => l.s.num("client.wrapper_default_timeout_s").max(1),
    };
    l.timeout_ms = match &knob_ms {
        Some(v) => match positive(v) {
            Some(n) => n,
            None => return l.closed_if_guard("msg.launcher_why_timeout_ms"),
        },
        None if knob_s.is_some() => l.timeout_s.saturating_mul(1000),
        None => {
            l.s.num("client.deadline_ms")
                .saturating_add(l.s.num("client.deadline_slack_ms"))
                .saturating_add(l.s.num("client.wrapper_extra_ms"))
        }
    };
    l.grace = match l
        .knob("launcher.knob_kill_grace_s")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v <= 5)
    {
        Some(sec) => Duration::from_secs(sec),
        None => Duration::from_millis(l.s.num("client.wrapper_kill_grace_ms")),
    };
    l.ev_s = l.read_event_timeout();

    if l.event == "SessionStart" {
        l.integrity("check");
        if l.knob("launcher.knob_engine_bin").is_none()
            && l.plugin_root
                .as_ref()
                .is_some_and(|r| r.join(l.key("launcher.engine_lock_file")).is_file())
        {
            l.self_spawn(&[&l.key("launcher.arg_auto")], "launcher.cli_install_verb");
        }
    }
    let Some(engine) = find_engine(l.home.as_ref(), &l.s, l.knob("launcher.knob_engine_bin"))
    else {
        l.log_line(&format!("engine_missing event={}", l.event));
        l.unreachable_notice_for("msg.launcher_unreachable_why_missing");
        return 0;
    };
    if env_nonempty(&l.key("launcher.in_process_env")).is_none_or(|v| v != "1")
        && l.fresh_marker("daemon_down_marker")
    {
        l.unreachable_notice_for("msg.launcher_unreachable_why_down");
        return 0;
    }
    // #901: the slow-streak marker (a loaded daemon, not a down one): the engine is skipped as for the down marker, but a guard call
    // in a hold class of dispatch.capacity_hold is held with its reason and retry hint; anything else passes with the notice
    if env_nonempty(&l.key("launcher.in_process_env")).is_none_or(|v| v != "1")
        && l.fresh_marker("daemon_slow_marker")
    {
        if l.capacity_held() {
            return 2;
        }
        limits::bump(Ctr::SlowMarkerPass);
        l.log_line(&format!("slow_marker_pass event={}", l.event));
        l.unreachable_notice_for("msg.launcher_unreachable_why_slow");
        return 0;
    }
    let eng_ms = match l.event_timeout_s() {
        Some(t) => t.saturating_mul(1000).min(l.timeout_ms),
        None => l.timeout_ms,
    };

    // the wall-clock backstop: the longest planned path plus a margin, never past the event's own hook timeout
    let ev_ms = l
        .event_timeout_s()
        .unwrap_or(l.timeout_s)
        .saturating_mul(1000);
    let cold_ms = if l.guard {
        l.s.num("client.cold_guard_wait_ms")
    } else {
        0
    };
    let slow_ms =
        l.s.num_event(
            "client.slow_fallback_max_ms",
            "client.slow_fallback_event_ms",
            &l.event,
        )
        .min(ev_ms);
    let grace_ms = l.grace.as_millis() as u64;
    // the soft wall is a per-event setting; 0 (or no entry) keeps the fail-fast formula
    let soft_ms =
        l.s.num_for("launcher.wall_soft_ms", &l.event)
            .filter(|n| *n > 0)
            .unwrap_or_else(|| cold_ms.saturating_add(eng_ms));
    let planned = cold_ms
        .saturating_add(eng_ms.max(slow_ms))
        .saturating_add(grace_ms.saturating_mul(2));
    let wall_ms = planned
        .saturating_add(l.s.num("launcher.wall_hard_margin_ms"))
        .min(ev_ms.max(planned));
    if !limits::arm_wall(
        wall_ms
            .saturating_sub(l.t0.elapsed().as_millis() as u64)
            .max(1),
    ) {
        limits::bump(Ctr::ConfigFallback);
    }

    let run_dir = l.run_dir();
    if let Ok(mut g) = RUN_DIR.lock() {
        g.clone_from(&run_dir);
    }
    l.fault();
    let code = (|| {
        if l.guard
            && run_dir.is_some()
            && let Some(c) = l.cold_guard_wait(&engine, eng_ms)
        {
            return c;
        }
        l.run_engine(&engine, run_dir.as_deref(), eng_ms)
    })();
    if let Some(d) = run_dir {
        let _ = std::fs::remove_dir_all(d);
    }
    l.finish_soft(soft_ms);
    code
}

fn hook_signals() -> libc::sigset_t {
    // SAFETY: sigset manipulation on a local set.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for sig in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
            libc::sigaddset(&mut set, sig);
        }
        set
    }
}

/// Before an exec: the new program gets HUP/INT/TERM delivered again (a blocked mask survives exec).
pub fn unblock_signals() {
    let set = hook_signals();
    // SAFETY: pthread_sigmask on the calling thread with a valid set.
    unsafe {
        libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
    }
}

/// HUP/INT/TERM to the launcher (the host gave up on the hook): take the child's whole group down, remove the run dir, and
/// exit 128+signal as the shell wrapper's traps do. The signals are blocked in every thread and taken by one `sigwait` thread;
/// std's spawn resets the mask in the child, so the engine still gets them.
pub fn install_signal_thread() {
    let set = hook_signals();
    // SAFETY: pthread_sigmask on the calling (main) thread before the thread below exists.
    unsafe {
        if libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return;
        }
        let _ = std::thread::Builder::new().spawn(move || {
            let mut sig: libc::c_int = 0;
            if libc::sigwait(&set, &mut sig) != 0 {
                return;
            }
            let pgid = limits::CHILD_PGID.load(Ordering::SeqCst);
            if pgid > 0 {
                libc::kill(-pgid, libc::SIGTERM);
                libc::kill(-pgid, libc::SIGKILL);
            }
            if let Ok(g) = RUN_DIR.lock()
                && let Some(d) = g.as_ref()
            {
                let _ = std::fs::remove_dir_all(d);
            }
            libc::_exit(128 + sig);
        });
    }
}
