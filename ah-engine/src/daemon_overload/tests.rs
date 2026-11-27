//! #969 (T-76) load test: the real accept loop and workers over real Unix sockets, with judging replaced by a sleep (`test_work`), so
//! the admission classes, the priority queue, the worker reservation, the adaptive limit and shed mode are what decide the latencies.
//! Each hook request's work is split into the part that always runs (blocking checks, recorders) and its advisory checks, which shed
//! mode skips. The same traffic is run with `overload.enabled = 0` (the plain FIFO the daemon had before) and `= 1`.
use super::*;
use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;

/// Requests the synthetic work ran in shed mode, by kind (guard, advisory), and in full; reset by each [`drive`].
static SHED_GUARD: AtomicU64 = AtomicU64::new(0);
static SHED_ADVISORY: AtomicU64 = AtomicU64::new(0);
static FULL_ADVISORY: AtomicU64 = AtomicU64::new(0);

/// Synthetic work: a guard request (PreToolUse) does 20 ms of blocking checks plus 60 ms of advice; an advisory request
/// (PostToolUse) does 10 ms of recording plus 300 ms of advice. Shed mode skips the advice.
fn work(req: &[u8], shed: bool) -> Duration {
    let text = String::from_utf8_lossy(req);
    if text.starts_with("CTL ") {
        return Duration::from_millis(60); // the warm-up probe: four in parallel finish in time only on four ready workers
    }
    let guard = text.contains("\"PreToolUse\"");
    let (always, advice) = if guard { (20, 60) } else { (10, 300) };
    match (guard, shed) {
        (true, true) => SHED_GUARD.fetch_add(1, SeqCst),
        (false, true) => SHED_ADVISORY.fetch_add(1, SeqCst),
        (false, false) => FULL_ADVISORY.fetch_add(1, SeqCst),
        (true, false) => 0,
    };
    Duration::from_millis(if shed { always } else { always + advice })
}

fn request(event: &str) -> Vec<u8> {
    format!("D 0.0.0\n{{\"host\":\"claude\",\"event\":\"{event}\"}}\n{{}}").into_bytes()
}

/// One legacy (no-ack) exchange: send, half-close, read the reply. `Some(true)` = OK, `Some(false)` = BUSY, `None` = no reply.
fn exchange(sock: &std::path::Path, req: &[u8]) -> Option<bool> {
    let mut c = UnixStream::connect(sock).ok()?;
    c.write_all(req).ok()?;
    c.shutdown(std::net::Shutdown::Write).ok()?;
    let mut got = Vec::new();
    c.read_to_end(&mut got).ok()?;
    match crate::frame::decode(&got).ok()?.0 {
        crate::frame::Kind::Ok => Some(true),
        crate::frame::Kind::Busy => Some(false),
        crate::frame::Kind::Err => None,
    }
}

struct Run {
    guard_ms: Vec<u64>,
    control_ms: Vec<u64>,
    /// (guard requests run in shed mode, advisory requests run in shed mode, advisory requests run in full)
    shed: (u64, u64, u64),
    guard_busy: usize,
    advisory_done: usize,
    advisory_busy: usize,
}

fn p(sorted: &[u64], pct: usize) -> u64 {
    sorted.get((sorted.len() * pct / 100).min(sorted.len().saturating_sub(1))).copied().unwrap_or(0)
}

/// Start a daemon (accept loop + 4 workers) on a fresh socket and drive it: 10 advisory flooders back to back, and one guard caller
/// that sends a PreToolUse every 40 ms, for `secs` seconds. The daemon's threads are left parked; the test process ends them.
fn drive(tag: &str, secs: u64) -> (Run, Arc<Shared>) {
    let dir = crate::testtmp::path(format!("ah-ovl-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("d.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut cfg = Config::from_env();
    cfg.workers = 4;
    cfg.queue = 64;
    let rs = RuleSet::parse(r#"{"version":1,"rules":[]}"#).unwrap();
    let sh = Arc::new(Shared::new(cfg, "0.1.0", rs, "/nonexistent/rules.json".into()));
    *lk(&sh.test_work) = Some(work);
    for i in 0..4 {
        let s = sh.clone();
        std::thread::spawn(move || worker(s, i));
    }
    for c in [&SHED_GUARD, &SHED_ADVISORY, &FULL_ADVISORY] {
        c.store(0, SeqCst);
    }
    let s = sh.clone();
    std::thread::spawn(move || accept_loop(&s, &listener));
    // the workers prewarm their script pools before serving (seconds on a loaded machine): measure only once four parallel
    // control calls are answered promptly
    let warm_by = Instant::now() + Duration::from_secs(60);
    while Instant::now() < warm_by {
        let t = Instant::now();
        let calls: Vec<_> = (0..4).map(|_| {
            let sock = sock.clone();
            std::thread::spawn(move || exchange(&sock, b"CTL ping"))
        }).collect();
        let got: Vec<_> = calls.into_iter().map(|c| c.join().ok().flatten()).collect();
        let ok = got.iter().all(|g| *g == Some(true));
        if ok && t.elapsed() < Duration::from_millis(110) {
            break;
        }
    }
    for c in [&SHED_GUARD, &SHED_ADVISORY, &FULL_ADVISORY] {
        c.store(0, SeqCst);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flooders: Vec<_> = (0..10)
        .map(|_| {
            let (stop, sock) = (stop.clone(), sock.clone());
            std::thread::spawn(move || {
                let (mut done, mut busy) = (0, 0);
                while !stop.load(SeqCst) {
                    match exchange(&sock, &request("PostToolUse")) {
                        Some(true) => done += 1,
                        Some(false) => busy += 1,
                        None => {}
                    }
                }
                (done, busy)
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300)); // the flood is established before the first guard call
    let (mut guard_ms, mut guard_busy) = (Vec::new(), 0);
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        let t = Instant::now();
        match exchange(&sock, &request("PreToolUse")) {
            Some(true) => guard_ms.push(t.elapsed().as_millis() as u64),
            _ => guard_busy += 1,
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    // R4: a control verb (status, ping) during the same flood
    let mut control_ms: Vec<u64> = (0..5)
        .filter_map(|_| {
            let t = Instant::now();
            (exchange(&sock, b"CTL ping") == Some(true)).then(|| t.elapsed().as_millis() as u64)
        })
        .collect();
    control_ms.sort_unstable();
    stop.store(true, SeqCst);
    let (mut advisory_done, mut advisory_busy) = (0, 0);
    for f in flooders {
        let (d, b) = f.join().unwrap();
        advisory_done += d;
        advisory_busy += b;
    }
    guard_ms.sort_unstable();
    let shed = (SHED_GUARD.load(SeqCst), SHED_ADVISORY.load(SeqCst), FULL_ADVISORY.load(SeqCst));
    crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup; an absent directory is the goal state
    (Run { guard_ms, control_ms, shed, guard_busy, advisory_done, advisory_busy }, sh)
}

/// The FIFO daemon makes a guard call wait behind the advisory flood (all four workers busy with 310 ms advisory requests); with
/// classes, reservation, the adaptive limit and shed mode, PreToolUse p99 stays inside the client's deadline, no guard call is
/// refused, and the advisory work is what gives way (served in shed mode, limited).
#[test]
fn under_an_advisory_flood_pre_tool_use_p99_stays_inside_the_deadline_and_advice_is_shed_first() {
    let deadline = defaults::num("client.deadline_ms");
    defaults::set_overlay(&[("overload.enabled", serde_json::json!(0))]);
    let (before, _) = drive("fifo", 3);
    defaults::set_overlay(&[]);
    let (after, sh) = drive("prio", 3);
    let line = |name: &str, r: &Run| {
        format!(
            "{name}: PreToolUse n={} p50={} ms p99={} ms max={} ms busy={}; PostToolUse served={} busy={}; shed mode guard={} advisory={} (advisory in full {}); CTL ping max={} ms of {}",
            r.guard_ms.len(),
            p(&r.guard_ms, 50),
            p(&r.guard_ms, 99),
            r.guard_ms.last().copied().unwrap_or(0),
            r.guard_busy,
            r.advisory_done,
            r.advisory_busy,
            r.shed.0,
            r.shed.1,
            r.shed.2,
            r.control_ms.last().copied().unwrap_or(0),
            r.control_ms.len()
        )
    };
    let report = format!("{}\n{}\nstatus overload: {}", line("before (FIFO)", &before), line("after (overload)", &after), sh.overload_json());
    eprintln!("{report}");
    assert!(after.guard_ms.len() >= 20, "enough guard calls were measured: {report}");
    assert_eq!(after.guard_busy, 0, "no guard call is refused while advisory requests are queued: {report}");
    assert!(p(&after.guard_ms, 99) <= deadline, "PreToolUse p99 inside client.deadline_ms ({deadline} ms): {report}");
    assert!(p(&before.guard_ms, 99) > deadline, "the FIFO baseline misses the deadline under the same flood (the test bites): {report}");
    assert_eq!(after.control_ms.len(), 5, "every control call is answered during the flood: {report}");
    assert!(after.control_ms.last().copied().unwrap_or(u64::MAX) <= deadline, "control calls answer inside the deadline: {report}");
    assert!(after.advisory_done > 0, "advisory work is still served (shed, not starved): {report}");
    assert!(after.shed.1 > 0, "advisory requests are shed (their advice skipped) under the flood: {report}");
    assert_eq!(before.shed, (0, 0, before.shed.2), "the FIFO baseline never sheds: {report}");
    let st = sh.overload_json();
    assert!(st["limit"].as_u64().unwrap_or(99) <= crate::overload::Aimd::max(4) as u64, "the limit stays under its bound: {st}");
}

/// One dispatch request for the entry `check` (its table id) alone on PreToolUse with tool `tool`, served on this thread with shed mode `shed`: the answer rows.
fn dispatch_one(sh: &Shared, check: &str, tool: &str, input: &str, shed: bool) -> Vec<serde_json::Value> {
    let payload = format!(
        r#"{{"session_id":"s-ovl-{}","cwd":"/","hook_event_name":"PreToolUse","tool_name":"{tool}","tool_input":{input}}}"#,
        std::process::id()
    );
    let meta = crate::dispatch::native::Meta {
        host: "claude".into(),
        event: "PreToolUse".into(),
        tool: Some(tool.into()),
        root: None,
        env: Default::default(),
        only: Some(vec![check.into()]),
        plan: vec![],
        cfg: String::new(),
        payload_sha1: None,
        deadline_ms: None,
        load_permille: None,
        notice: None,
    };
    let d = format!("D 0.1.0\n{}\n{payload}", serde_json::to_string(&meta).unwrap());
    crate::overload::set_request_shed(shed);
    let (reply, _) = handle_request(d.as_bytes(), sh);
    crate::overload::set_request_shed(false);
    crate::delivery::settle(&sh.telemetry, crate::deadline::in_time());
    match reply {
        Reply::Ok(s) => serde_json::from_str(&s).unwrap(),
        other => panic!("not OK: {other:?}"),
    }
}

/// Shed mode through the real dispatch path: an advisory (fail-open, not recorder) check of a guard event is skipped and counted lost
/// once as overload_shed, never counted decided (then undelivered); a fail-closed check in shed mode still runs.
#[test]
fn shed_mode_skips_an_open_guard_check_counted_once_and_a_closed_one_still_runs() {
    let rs = RuleSet::parse(r#"{"version":1,"rules":[]}"#).unwrap();
    let sh = Shared::new(Config::from_env(), "0.1.0", rs, "/nonexistent/rules.json".into());
    let reason = defaults::text("overload.drop_reason");
    let (open, closed) = ("swarm-guard", "command");
    assert_ne!(crate::script::failure_mode(open), defaults::text("script.failure_mode_closed"), "precondition: {open} fails open");
    assert!(defaults::raw("diagnostics.shed_never").get(open).is_none(), "precondition: {open} is not a recorder");
    assert_eq!(crate::script::failure_mode(closed), defaults::text("script.failure_mode_closed"), "precondition: {closed} fails closed");
    crate::metrics::reset_this_thread();
    let rows = dispatch_one(&sh, open, "Agent", r#"{"prompt":"x"}"#, true);
    let lost = |c: &str| crate::metrics::bumped_on_this_thread("delivery_lost", &[("check", c), ("reason", reason)]);
    assert_eq!(lost(open), 1, "the skipped check is counted lost once, as {reason}: {rows:?}");
    let row = rows.iter().find(|r| r[0] == open).expect("the skipped check answers its entry (quietly)");
    assert_eq!((row[1].as_i64(), row[2].as_str(), row[3].as_str()), (Some(0), Some(""), Some("")), "skipped = nothing to say: {row}");
    let (decided, undelivered) = sh.telemetry.with_metrics(|m| {
        (
            m.counter("delivery_stage", &[("check", open), ("stage", defaults::text("delivery.stage_decided"))]),
            m.counter("delivery_lost", &[("check", open), ("reason", defaults::text("delivery.reason_undelivered"))]),
        )
    });
    assert_eq!((decided, undelivered), (0, 0), "a skipped check is not counted decided, then undelivered");
    let rows = dispatch_one(&sh, "command-guard", "Bash", r#"{"command":"echo hi"}"#, true);
    assert_eq!(lost(closed), 0, "a fail-closed check is never shed: {rows:?}");
    assert!(rows.iter().any(|r| r[0] == "command-guard"), "and it answered: {rows:?}");
}
