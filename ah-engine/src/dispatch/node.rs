//! Running an event's Node hooks the way the host runs them: each `hooks.json` command under the shell, all at once,
//! with the payload on stdin, stdout and stderr captured, and the entry's own timeout. A hook that runs longer is
//! killed with its whole process group and counts as having said nothing, as the host discards a timed-out hook.
//!
//! Every hook ends with a [`Fate`], so the dispatcher can tell "the hook ran and said nothing" (an allow) from "the hook
//! could not be run" (no decision: on a guard event that must never read as an allow, D74).
use super::combine::{self, HookResult};
use super::table::Entry;
use crate::defaults;
use crate::telemetry::event::Outcome;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::fs::FileExt;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How a hook ended, apart from what it printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// It ran to its end and its output is whole (or it exited 2 / printed a JSON block, whose partial output is kept).
    Ran,
    /// It was still running at its timeout and was killed with its group; the host discards such a hook.
    Timeout,
    /// The command could not be started at all (no shell, EAGAIN, a command the OS refuses).
    Spawn,
    /// It was killed by a signal (an OOM kill, a crash) or could not be waited for.
    Died,
    /// It finished but a process it left behind still held its output open, so the output is incomplete.
    Incomplete,
}

impl Fate {
    /// The short name recorded in the hook's telemetry event.
    pub fn name(self) -> &'static str {
        match self {
            Fate::Ran => "ran",
            Fate::Timeout => "timeout",
            Fate::Spawn => "spawn",
            Fate::Died => "died",
            Fate::Incomplete => "incomplete",
        }
    }
}

/// A hook's result and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// What the hook produced (no exit code when it did not finish normally).
    pub result: HookResult,
    /// How it ended.
    pub fate: Fate,
}

/// What a reader thread has collected so far, shared so a pipe still held open by a leftover process does not hide the
/// bytes that did arrive (a hook that exited 2 has blocked, whatever else holds its pipes).
struct Capture {
    buf: Arc<Mutex<Vec<u8>>>,
    done: Arc<AtomicBool>,
    /// The read failed before the end of the pipe: what is in `buf` is not the whole output.
    failed: Arc<AtomicBool>,
}

impl Capture {
    /// The bytes so far, as text, and whether the pipe was read to its end (a read error is not an end). Waits up to
    /// `dispatch.read_ms` for the end.
    fn collect(&self) -> (String, bool) {
        let deadline = Instant::now() + defaults::millis("dispatch.read_ms");
        while !self.done.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(defaults::millis("dispatch.poll_ms"));
        }
        let complete = self.done.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire);
        // decoded straight from the guarded buffer: no intermediate copy of a possibly large capture
        let text = self.buf.lock().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        (text, complete)
    }
}

/// A Node hook that has been started.
pub struct Running {
    id: String,
    /// The hook event it runs for (telemetry label only).
    event: String,
    child: Option<Child>,
    /// Why the command could not be started (`None` once it is running).
    spawn_err: Option<std::io::Error>,
    out: Option<Capture>,
    err: Option<Capture>,
    timeout: Duration,
    started: Instant,
}

impl Running {
    /// Name the hook event this hook runs for, so its telemetry event carries it.
    pub fn for_event(mut self, event: &str) -> Running {
        self.event = event.to_string();
        self
    }
}

fn reader<R: Read + Send + 'static>(r: Option<R>) -> Option<Capture> {
    let mut r = r?;
    let cap = Capture { buf: Arc::new(Mutex::new(Vec::new())), done: Arc::new(AtomicBool::new(false)), failed: Arc::new(AtomicBool::new(false)) };
    let (buf, done, failed) = (cap.buf.clone(), cap.done.clone(), cap.failed.clone());
    std::thread::spawn(move || {
        let mut chunk = vec![0u8; defaults::num("io.small_chunk_bytes") as usize];
        loop {
            match r.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut b) = buf.lock() {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        }
        done.store(true, Ordering::Release);
    });
    Some(cap)
}

enum Input {
    Bytes(Vec<u8>),
    File(File),
}

impl Running {
    /// Whether the command was actually started (a spawn failure never was, so it did nothing a rerun would repeat).
    pub fn started(&self) -> bool {
        self.child.is_some()
    }
}

/// Start `entry`'s command with in-memory `payload` on stdin. A command that cannot start is a hook with no child (its
/// fate is [`Fate::Spawn`]; the host's "could not run" is no decision either).
pub fn start(entry: &Entry, payload: &[u8]) -> Running {
    start_with_input(entry, Ok(Input::Bytes(payload.to_vec())))
}

/// Start `entry`'s command with stdin copied from `payload`. Each child gets an independent descriptor and the feeder
/// uses positional reads, so concurrent hooks never share or race a file offset.
pub fn start_file(entry: &Entry, payload: &File) -> Running {
    start_with_input(entry, payload.try_clone().map(Input::File))
}

fn start_with_input(entry: &Entry, input: std::io::Result<Input>) -> Running {
    let shell = defaults::list("dispatch.shell");
    let mut spawn_err = None;
    let spawned = match input {
        // the payload descriptor could not be duplicated (EMFILE): the same as a command the OS would not start
        Err(e) => {
            spawn_err = Some(e);
            None
        }
        Ok(input) => match Command::new(shell.first().copied().unwrap_or_default())
            .args(&shell[1.min(shell.len())..])
            .arg(&entry.command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
        {
            Ok(child) => Some((child, input)),
            Err(e) => {
                spawn_err = Some(e);
                None
            }
        },
    };
    let (mut child, mut out, mut err) = (None, None, None);
    if let Some((mut c, input)) = spawned {
        if let Some(mut stdin) = c.stdin.take() {
            std::thread::spawn(move || match input {
                Input::Bytes(ref data) => {
                    crate::discard::harmless(write_stdin(&mut stdin, data)); // keep: best effort, fail-open
                }
                Input::File(ref file) => {
                    crate::discard::harmless(feed_file(file, &mut stdin)); // keep: best effort, fail-open
                }
            });
        }
        out = reader(c.stdout.take());
        err = reader(c.stderr.take());
        child = Some(c);
    }
    Running {
        id: entry.id.clone(),
        event: String::new(),
        child,
        spawn_err,
        out,
        err,
        timeout: Duration::from_secs(
            if entry.timeout_s == 0 { defaults::num("dispatch.default_timeout_s") } else { entry.timeout_s }.min(defaults::num("dispatch.max_timeout_s")),
        ),
        started: Instant::now(),
    }
}

fn write_stdin(stdin: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    match stdin.write_all(data) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(e) => Err(e),
    }
}

fn feed_file(file: &File, stdin: &mut impl Write) -> std::io::Result<()> {
    let len = file.metadata()?.len();
    let mut off = 0;
    let mut buf = vec![0u8; defaults::num("io.chunk_bytes") as usize];
    while off < len {
        let want = ((len - off) as usize).min(buf.len());
        let n = match file.read_at(&mut buf[..want], off) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        match stdin.write_all(&buf[..n]) {
            Ok(()) => off += n as u64,
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// How the wait for one hook ended.
#[derive(Clone, Copy)]
enum Waited {
    Code(i32),
    Signal,
    TimedOut,
    NotStarted,
}

/// Wait for every started hook (each up to its own timeout) and return what each produced, in the same order.
pub fn finish(mut running: Vec<Running>) -> Vec<Finished> {
    let poll = defaults::millis("dispatch.poll_ms");
    let mut waited: Vec<Option<Waited>> = running.iter().map(|r| if r.child.is_none() { Some(Waited::NotStarted) } else { None }).collect();
    while waited.iter().any(Option::is_none) {
        for (i, r) in running.iter_mut().enumerate() {
            if waited[i].is_some() {
                continue;
            }
            let Some(c) = r.child.as_mut() else { continue };
            let end = |c: &mut Child, how: Waited| {
                // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader
                unsafe {
                    libc::killpg(c.id() as libc::pid_t, libc::SIGKILL);
                }
                crate::discard::harmless(c.kill()); // keep: best effort, fail-open
                crate::discard::harmless(c.wait()); // keep: best effort, fail-open
                how
            };
            waited[i] = match c.try_wait() {
                Ok(Some(st)) => Some(st.code().map_or(Waited::Signal, Waited::Code)),
                Ok(None) if r.started.elapsed() < r.timeout => None,
                // over its timeout: kill the whole group, the host would have discarded it
                Ok(None) => Some(end(c, Waited::TimedOut)),
                // unwaitable: its state is unknown, so it is no answer
                Err(_) => Some(end(c, Waited::Signal)),
            };
        }
        if waited.iter().any(Option::is_none) {
            std::thread::sleep(poll);
        }
    }
    running.into_iter().zip(waited).map(|(r, w)| conclude(r, w.unwrap_or(Waited::NotStarted))).collect()
}

/// True when Node itself says the script/module could not be resolved. On a guard event this is the same as an
/// unrunnable hook: no guard decision exists.
pub fn module_resolution_error(r: &HookResult) -> bool {
    r.code == Some(1) && (r.err.starts_with("MODULE_NOT_FOUND") || r.err.starts_with("ERR_MODULE_NOT_FOUND"))
}

fn nothing(id: String) -> HookResult {
    HookResult { id, code: None, out: String::new(), err: String::new() }
}

/// How a finished hook counts in telemetry: a timeout is a timeout, a hook that could not run or died is an error, one that
/// blocked (exit 2 or a JSON block) is a block, another non-zero exit is an error, output is an advisory, silence an allow.
fn telemetry_outcome(f: &Finished) -> Outcome {
    match f.fate {
        Fate::Timeout => Outcome::Timeout,
        Fate::Spawn | Fate::Died | Fate::Incomplete => Outcome::Error,
        Fate::Ran => match f.result.code {
            Some(2) => Outcome::Block,
            Some(c) if c != 0 => Outcome::Error,
            _ if f.result.out.is_empty() => Outcome::Allow,
            _ if combine::json_blocks(&f.result.out) => Outcome::Block,
            _ => Outcome::Advise,
        },
    }
}

/// Wait result of one hook, recorded: the hook's id, event, outcome, wall time and output size (no output text).
fn conclude(r: Running, w: Waited) -> Finished {
    let (event, started) = (r.event.clone(), r.started);
    let f = conclude_output(r, w);
    crate::telemetry::emit::queue(crate::telemetry::emit::node_run(&crate::telemetry::emit::NodeRun {
        id: &f.result.id,
        event: &event,
        outcome: telemetry_outcome(&f),
        micros: started.elapsed().as_micros() as u64,
        out_bytes: f.result.out.len() as u64,
        err_bytes: f.result.err.len() as u64,
        exit: f.result.code,
        fate: f.fate.name(),
    }));
    f
}

/// The result of one waited hook: its output when whole, and the right [`Fate`] when it is not.
fn conclude_output(r: Running, w: Waited) -> Finished {
    let log = |kind: &str, key: &str| crate::health::log_event(kind, &r.id, defaults::text(key));
    let code = match w {
        Waited::Code(c) => c,
        Waited::TimedOut => {
            log("dispatch_hook_timeout", "dispatch.msg_hook_timeout");
            return Finished { result: nothing(r.id), fate: Fate::Timeout };
        }
        Waited::Signal => {
            log("dispatch_hook_died", "dispatch.msg_hook_died");
            return Finished { result: nothing(r.id), fate: Fate::Died };
        }
        Waited::NotStarted => {
            let (errno, err) = r.spawn_err.as_ref().map_or((0, String::new()), |e| (e.raw_os_error().unwrap_or(0), e.to_string()));
            let detail = defaults::render("dispatch.msg_hook_spawn", &[("errno", &format!("os{errno}")), ("err", &err)]);
            crate::health::log_event("dispatch_hook_spawn", &r.id, &detail);
            return Finished { result: nothing(r.id), fate: Fate::Spawn };
        }
    };
    let (out, out_whole) = r.out.as_ref().map_or((String::new(), true), Capture::collect);
    let (err, err_whole) = r.err.as_ref().map_or((String::new(), true), Capture::collect);
    if out_whole && err_whole {
        return Finished { result: HookResult { id: r.id, code: Some(code), out, err }, fate: Fate::Ran };
    }
    log("fallback_read_timeout", "msg.log_fallback_read_timeout");
    // A hook that exited 2 has blocked, and one whose partial output is a JSON block has decided: a leftover process
    // holding the pipes must not turn either into "no decision". Anything else incomplete is an explicit error, never an
    // empty answer that reads as an allow.
    if code == 2 || combine::json_blocks(&out) {
        return Finished { result: HookResult { id: r.id, code: Some(code), out, err }, fate: Fate::Ran };
    }
    let err = format!("{}\n", defaults::text("msg.fallback_read_timeout"));
    Finished { result: HookResult { id: r.id, code: Some(1), out: String::new(), err }, fate: Fate::Incomplete }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, command: &str, timeout_s: u64) -> Entry {
        Entry { id: id.into(), matcher: String::new(), command: command.into(), timeout_s, check: None, when: None }
    }

    #[test]
    fn hooks_run_at_once_with_the_payload_and_report_in_order() {
        let dir = std::env::temp_dir().join(format!("ah-engine-node-overlap-{}-{}", std::process::id(), crate::health::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let starts: Vec<String> = ["a", "b", "c"].iter().map(|id| dir.join(format!("start-{id}")).display().to_string()).collect();
        let checked: Vec<String> = ["a", "b", "c"].iter().map(|id| dir.join(format!("checked-{id}")).display().to_string()).collect();
        let finishes: Vec<String> = ["a", "b", "c"].iter().map(|id| dir.join(format!("finish-{id}")).display().to_string()).collect();
        let wait_all = |paths: &[String]| {
            let test = paths.iter().map(|p| format!("[ -e '{p}' ]")).collect::<Vec<_>>().join(" && ");
            format!("n=0; until {test}; do n=$((n+1)); [ $n -ge 400 ] && echo overlap-timeout >&2 && exit 9; sleep 0.05; done")
        };
        let hook = |i: usize, body: &str| {
            format!(": > '{}'; {}; : > '{}'; {}; {body}; : > '{}'", starts[i], wait_all(&starts), checked[i], wait_all(&checked), finishes[i])
        };
        let es = [
            entry("a", &format!("{}; cat; echo err >&2; exit 2", hook(0, ":")), 25),
            entry("b", &format!("{}; printf b", hook(1, ":")), 25),
            entry("c", &hook(2, ":"), 25),
        ];
        let rs: Vec<HookResult> = finish(es.iter().map(|e| start(e, b"{\"x\":1}")).collect()).into_iter().map(|f| f.result).collect();
        assert_eq!(rs[0], HookResult { id: "a".into(), code: Some(2), out: "{\"x\":1}".into(), err: "err\n".into() });
        assert_eq!(rs[1].out, "b");
        assert_eq!(rs[2], HookResult::quiet("c"));
        for path in starts.iter().chain(&checked).chain(&finishes) {
            assert!(std::path::Path::new(path).exists(), "missing overlap marker {path}");
        }
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn every_node_hook_leaves_a_telemetry_event_with_its_outcome_duration_and_output_size_and_no_output_text() {
        use crate::telemetry::emit;
        use crate::telemetry::event::Extras;
        emit::take_queued();
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}"#;
        let es = [
            ("quiet", "exit 0".to_string(), 5),
            ("advises", "printf 'secret advice text'".to_string(), 5),
            ("blocks", "echo nope >&2; exit 2".to_string(), 5),
            ("json-blocks", format!("echo '{deny}'"), 5),
            ("fails", "exit 3".to_string(), 5),
            ("slow", "sleep 30".to_string(), 1),
            ("died", "kill -9 $$".to_string(), 5),
        ];
        let rs = finish(es.iter().map(|(id, c, t)| start(&entry(id, c, *t), b"").for_event("PreToolUse")).collect());
        assert_eq!(rs.len(), 7);
        let evs = emit::take_queued();
        assert_eq!(evs.len(), 7);
        let by = |id: &str| evs.iter().find(|e| e.h.as_str() == id).unwrap_or_else(|| panic!("no event for {id}"));
        let o = |id: &str| by(id).o;
        assert_eq!(
            [o("quiet"), o("advises"), o("blocks"), o("json-blocks"), o("fails"), o("slow"), o("died")],
            [Outcome::Allow, Outcome::Advise, Outcome::Block, Outcome::Block, Outcome::Error, Outcome::Timeout, Outcome::Error]
        );
        assert!(evs.iter().all(|e| e.kind == crate::telemetry::event::Kind::Node && e.e.as_str() == "PreToolUse"));
        assert_eq!(by("advises").ib, "secret advice text".len() as u64, "stdout bytes");
        assert!(by("slow").ms >= 1000, "the timeout wait is the duration: {}", by("slow").ms);
        let Extras::Fields(f) = &by("blocks").extras else { panic!("fields") };
        assert_eq!((f.get_num("exit"), f.get_tok("fate"), f.get_num("err_bytes")), (Some(2), Some("ran"), Some(5)));
        let Extras::Fields(f) = &by("slow").extras else { panic!("fields") };
        assert_eq!((f.get_num("exit"), f.get_tok("fate")), (None, Some("timeout")));
        for e in &evs {
            assert!(!e.to_json().to_string().contains("secret"), "output text is never recorded");
            assert_eq!(&crate::telemetry::event::Event::from_json(&e.to_json()).unwrap(), e);
        }
    }

    #[test]
    fn a_hook_that_exits_with_its_output_still_open_is_an_error_not_an_empty_answer() {
        // the background `sleep` keeps the stdout pipe open past dispatch.read_ms; the shell itself exits at once
        let rs = finish(vec![start(&entry("leaky", "echo early; (exec sleep 4) & exit 0", 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Incomplete);
        assert_eq!(rs[0].result.code, Some(1));
        assert!(rs[0].result.out.is_empty() && rs[0].result.err.contains("not complete"), "{:?}", rs[0]);
    }

    #[test]
    fn an_entry_without_a_timeout_gets_the_hosts_default_not_zero() {
        let rs = finish(vec![start(&entry("none", "sleep 0.2; printf kept", 0), b"")]);
        assert_eq!(rs[0].result, HookResult { id: "none".into(), code: Some(0), out: "kept".into(), err: String::new() });
    }

    #[test]
    fn a_hook_over_its_timeout_is_killed_with_its_group_and_says_nothing() {
        let started = Instant::now();
        let rs = finish(vec![start(&entry("slow", "echo partial; sleep 30 & sleep 30", 1), b"")]);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(rs[0], Finished { result: HookResult { id: "slow".into(), code: None, out: String::new(), err: String::new() }, fate: Fate::Timeout });
    }

    #[test]
    fn a_hook_that_exits_two_keeps_its_block_while_a_leftover_process_holds_its_pipes() {
        let rs = finish(vec![start(&entry("blocker", "echo BLOCKED >&2; echo part; (exec sleep 4) & exit 2", 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Ran);
        assert_eq!(rs[0].result, HookResult { id: "blocker".into(), code: Some(2), out: "part\n".into(), err: "BLOCKED\n".into() });
    }

    #[test]
    fn a_json_block_survives_a_leftover_process_holding_the_pipes() {
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}"#;
        let rs = finish(vec![start(&entry("deny", &format!("echo '{deny}'; (exec sleep 4) & exit 0"), 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Ran);
        assert_eq!((rs[0].result.code, rs[0].result.out.trim()), (Some(0), deny));
    }

    #[test]
    fn a_hook_that_cannot_start_or_dies_by_a_signal_has_its_own_fate_and_no_exit_code() {
        // a NUL in the command makes the OS refuse to start it (the stand-in for EAGAIN)
        let rs = finish(vec![start(&entry("nospawn", "a\0b", 5), b""), start(&entry("killed", "kill -9 $$", 5), b"")]);
        assert_eq!((rs[0].fate, rs[0].result.code), (Fate::Spawn, None));
        assert_eq!((rs[1].fate, rs[1].result.code), (Fate::Died, None));
    }

    /// Some bytes, then a read error (not an end of file).
    struct Broken(bool);

    impl Read for Broken {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected read error"));
            }
            self.0 = true;
            buf[..4].copy_from_slice(b"part");
            Ok(4)
        }
    }

    #[test]
    fn a_read_error_on_a_pipe_is_incomplete_output_not_a_whole_answer() {
        let running = Running {
            id: "broken".into(),
            event: String::new(),
            child: None,
            spawn_err: None,
            out: reader(Some(Broken(false))),
            err: None,
            timeout: Duration::from_secs(5),
            started: Instant::now(),
        };
        let f = conclude(running, Waited::Code(0));
        assert_eq!(f.fate, Fate::Incomplete);
        assert_eq!(f.result.code, Some(1));
        assert!(f.result.out.is_empty(), "{f:?}");
    }

    struct BrokenPipeWriter;

    impl Write for BrokenPipeWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "reader closed"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn file_feeder_treats_a_closed_child_stdin_as_success() {
        let path = std::env::temp_dir().join(format!("ah-engine-feed-{}-{}.tmp", std::process::id(), crate::health::now_ms()));
        std::fs::write(&path, b"payload").unwrap();
        let file = File::open(&path).unwrap();
        let mut writer = BrokenPipeWriter;
        let result = feed_file(&file, &mut writer);
        crate::discard::harmless(std::fs::remove_file(&path)); // keep: cleanup that raced; an absent file is the goal state
        assert!(result.is_ok(), "{result:?}");
    }
}
