//! Getting a telemetry event from anywhere in the engine to the recorder (coverage telemetry).
//!
//! Inside the daemon the events go straight to the recorder through the sink the daemon installs ([`install`]). A process
//! that is not the daemon (the hook dispatcher, a one-shot command, `jev ask`) has no recorder, so it appends its events
//! to the inbox file in the state directory ([`inbox_path`]) and the daemon reads and empties that file on every flush
//! ([`ingest_from`]). The hook path therefore pays one small append per hook call ([`queue`] collects a call's events and
//! [`flush`] writes them together), never a socket round trip. Appending is best effort and fail-open: telemetry must never
//! change what a hook answers.
//!
//! An event holds identifiers and numbers only (see [`super::event`]); the builders here take names, never text, and
//! sanitise every name that comes from outside. Field names and their types are declared in `telemetry.fields`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::event::{Event, Extras, Fields, Jev, Kind, Outcome, Token};
use crate::{defaults, paths};
use std::cell::{Cell, RefCell};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

type Sink = Box<dyn Fn(Event) + Send + Sync>;

/// Where events go inside the daemon; unset in every other process.
static SINK: OnceLock<Sink> = OnceLock::new();

thread_local! {
    /// The events of the current call, written together by [`flush`].
    static BATCH: RefCell<Vec<Event>> = const { RefCell::new(Vec::new()) };
    /// Items the running command reports as changed ([`add_items`]).
    static ITEMS: Cell<u64> = const { Cell::new(0) };
}

/// Send this process's events to `sink` instead of the inbox. Called once by the daemon; a second call changes nothing.
pub fn install(sink: Sink) {
    crate::discard::harmless(SINK.set(sink).map_err(|_| ())); // keep: already installed by an earlier start in this process
}

/// The inbox file.
pub fn inbox_path() -> PathBuf {
    paths::dir().join(defaults::text("files.telemetry_inbox"))
}

/// Record `ev` now: to the daemon's recorder when this is the daemon, else appended to the inbox.
pub fn event(ev: Event) {
    if cfg!(test) && SINK.get().is_none() {
        // a unit test must not write the real state directory: its events wait in the thread's batch for `take_queued`
        BATCH.with(|b| b.borrow_mut().push(ev));
        return;
    }
    match SINK.get() {
        Some(sink) => sink(ev),
        None => append_to(&inbox_path(), &[ev]),
    }
}

/// Collect `ev` for [`flush`] (in the daemon it is recorded at once). Cheap: no I/O.
pub fn queue(ev: Event) {
    match SINK.get() {
        Some(sink) => sink(ev),
        None => BATCH.with(|b| b.borrow_mut().push(ev)),
    }
}

/// The events collected on this thread and not yet written, emptied (for tests of the code that records them).
pub fn take_queued() -> Vec<Event> {
    BATCH.with(|b| std::mem::take(&mut *b.borrow_mut()))
}

/// Write the events collected by [`queue`] on this thread, in one append.
pub fn flush() {
    if cfg!(test) {
        BATCH.with(|b| b.borrow_mut().clear()); // a unit test must not write the real state directory
        return;
    }
    let evs = BATCH.with(|b| std::mem::take(&mut *b.borrow_mut()));
    if !evs.is_empty() {
        append_to(&inbox_path(), &evs);
    }
}

/// Append `evs` to the inbox at `path`. Best effort: a full inbox, a missing directory that cannot be made or an I/O error
/// loses the events and nothing else.
pub fn append_to(path: &Path, evs: &[Event]) {
    if evs.is_empty() {
        return;
    }
    let mut bytes = Vec::new();
    for e in evs {
        bytes.extend_from_slice(e.to_json().to_string().as_bytes());
        bytes.push(b'\n');
    }
    crate::discard::logged("tel_inbox_append", write_locked(path, &bytes));
}

fn flock(f: &std::fs::File) -> std::io::Result<()> {
    // SAFETY: `f` is an open file owned by the caller, so its descriptor is valid; `flock` takes only the descriptor and a flag.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn write_locked(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let open = || std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(path);
    let mut f = match open() {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(d) = path.parent() {
                crate::limits::ensure_private_dir(d).map_err(|e| std::io::Error::other(e.to_string()))?;
            }
            open()?
        }
        Err(e) => return Err(e),
    };
    flock(&f)?;
    if f.metadata()?.len() + bytes.len() as u64 > defaults::num("telemetry.inbox_max_bytes") {
        return Ok(()); // full: the daemon is not reading; drop rather than grow without bound
    }
    f.write_all(bytes)
}

/// What [`ingest_from`] read.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Ingested {
    /// Events handed on.
    pub events: u64,
    /// Lines the strict reader refused (not an event, an unknown field, text where an identifier belongs).
    pub bad: u64,
}

/// Read every event from the inbox at `path`, empty the file, and hand each event to `take`. Appenders wait on the file
/// lock while it is read, so nothing appended meanwhile is lost. An absent inbox is nothing to read.
pub fn ingest_from(path: &Path, mut take: impl FnMut(Event)) -> Ingested {
    let mut out = Ingested::default();
    let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(path) else { return out };
    if crate::discard::logged_ok("tel_inbox_lock", flock(&f)).is_none() {
        return out;
    }
    let mut text = String::new();
    let read = f.read_to_string(&mut text);
    if crate::discard::logged_ok("tel_inbox_read", read).is_none() {
        return out; // unreadable (not UTF-8): keep the file for a look rather than empty it
    }
    if f.seek(SeekFrom::Start(0)).is_ok() {
        crate::discard::logged("tel_inbox_clear", f.set_len(0));
    }
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<serde_json::Value>(line).ok().and_then(|v| Event::from_json(&v).ok()) {
            Some(ev) => {
                out.events += 1;
                take(ev);
            }
            None => out.bad += 1,
        }
    }
    out
}

// ---- items changed by a command --------------------------------------------------------------------------------

/// Count `n` more items the running command changed (it is reported in the command's `cmd` event).
pub fn add_items(n: u64) {
    ITEMS.with(|i| i.set(i.get().saturating_add(n)));
}

/// The items counted since the last call, and reset.
pub fn take_items() -> u64 {
    ITEMS.with(|i| i.replace(0))
}

// ---- builders ---------------------------------------------------------------------------------------------------

fn now_ms() -> u64 {
    crate::health::now_ms()
}

/// Milliseconds rounded up (the counters keep the microsecond histogram; the event keeps whole milliseconds).
fn ms_of(micros: u64) -> u32 {
    micros.div_ceil(1000).min(u32::MAX as u64) as u32
}

fn base(kind: Kind, h: &str, e: &str, o: Outcome, micros: u64, ib: u64, extras: Extras) -> Event {
    let e = if e.is_empty() { defaults::text("telemetry.no_event_label") } else { e };
    Event { ts_ms: now_ms(), kind, h: Token::sanitize(h), e: Token::sanitize(e), o, ms: ms_of(micros), ib, extras }
}

/// What one Node hook did, for [`node_run`].
pub struct NodeRun<'a> {
    /// The hook's table id.
    pub id: &'a str,
    /// The hook event it ran for.
    pub event: &'a str,
    /// How it ended.
    pub outcome: Outcome,
    /// Wall time from start to the end of the wait.
    pub micros: u64,
    /// Bytes it printed on stdout.
    pub out_bytes: u64,
    /// Bytes it printed on stderr.
    pub err_bytes: u64,
    /// Its exit code, when it exited.
    pub exit: Option<i32>,
    /// How it ended apart from what it printed (`ran`, `timeout`, `spawn`, `died`, `incomplete`).
    pub fate: &'a str,
}

/// The event for one Node hook the dispatcher ran.
pub fn node_run(r: &NodeRun<'_>) -> Event {
    let mut f = Fields::new().tok("fate", r.fate).num("err_bytes", r.err_bytes);
    if let Some(c) = r.exit {
        f = f.num("exit", c.max(0) as u64);
    }
    base(Kind::Node, r.id, r.event, r.outcome, r.micros, r.out_bytes, Extras::Fields(f))
}

/// What one Jev call came to, for [`jev_call`].
pub struct JevCall<'a> {
    /// The integration that asked.
    pub integration: &'a str,
    /// Its mode (`on`, `shadow`, `off`).
    pub mode: &'a str,
    /// What the call changed (`added`, `changed`, `would-change`, `none`, `no-answer`).
    pub verdict: &'a str,
    /// How the call ended.
    pub outcome: Outcome,
    /// Confidence in thousandths, when Jev answered.
    pub conf_pm: Option<u64>,
    /// Latency in milliseconds (0 for a cache hit or no call).
    pub ms: u64,
    /// Cost in micro-dollars.
    pub cost_uc: u64,
    /// Where the answer came from (`jev`, `cache`, `baseline-only`).
    pub backend: &'a str,
    /// The circuit breaker of the vendor asked (`open` or `closed`).
    pub breaker: &'a str,
    /// The failure reason, when there was one.
    pub error: Option<&'a str>,
}

/// The event for one Jev call.
pub fn jev_call(c: &JevCall<'_>) -> Event {
    let mut more = Fields::new().tok("backend", c.backend).tok("breaker", c.breaker);
    if let Some(p) = c.conf_pm {
        more = more.num("conf_pm", p);
    }
    if let Some(e) = c.error {
        more = more.tok("error", e);
    }
    let jev = Jev { integration: Token::sanitize(c.integration), mode: Token::sanitize(c.mode), verdict: Token::sanitize(c.verdict), cost_uc: c.cost_uc, more };
    base(Kind::Jev, c.integration, defaults::text("telemetry.no_event_label"), c.outcome, c.ms.saturating_mul(1000), 0, Extras::Jev(jev))
}

/// The event for one run of a state-writing engine command.
pub fn command_run(command: &str, sub: &str, exit: i32, micros: u64, items: u64) -> Event {
    let o = if exit == 0 { Outcome::Allow } else { Outcome::Error };
    base(Kind::Cmd, command, sub, o, micros, 0, Extras::Fields(Fields::new().num("items", items).num("exit", exit.max(0) as u64)))
}

/// The event for a daemon health snapshot: `readings` are the numbers the `daemon` schema lists.
pub fn daemon_snapshot(degraded: bool, readings: &[(&str, u64)]) -> Event {
    let mut f = Fields::new().num("degraded", u64::from(degraded));
    for (k, v) in readings {
        f = f.num(k, *v);
    }
    let o = if degraded { Outcome::Advise } else { Outcome::Allow };
    base(Kind::Daemon, defaults::text("telemetry.daemon_label"), defaults::text("telemetry.daemon_event_label"), o, 0, 0, Extras::Fields(f))
}

/// One model call, for [`model`] (see `telemetry.model_api`).
pub struct ModelCall<'a> {
    /// The backend that served it (`jev`, `codex`, `claude`, ...): an identifier.
    pub backend: &'a str,
    /// The model ALIAS (`haiku`, `sonnet`, ...), never a pinned version and never prompt text.
    pub model: &'a str,
    /// What the call was for (`judge`, ...): an identifier.
    pub purpose: &'a str,
    /// `Allow` when it answered, `Error` when it failed, `Timeout` when it ran out of time.
    pub outcome: Outcome,
    /// Wall time of the call.
    pub micros: u64,
    /// Input tokens, when the backend reported them.
    pub tokens_in: Option<u64>,
    /// Output tokens, when the backend reported them.
    pub tokens_out: Option<u64>,
}

/// The event for one model call.
pub fn model_call(c: &ModelCall<'_>) -> Event {
    let mut f = Fields::new().tok("purpose", c.purpose);
    if let Some(t) = c.tokens_in {
        f = f.num("tokens_in", t);
    }
    if let Some(t) = c.tokens_out {
        f = f.num("tokens_out", t);
    }
    base(Kind::Model, c.backend, c.model, c.outcome, c.micros, 0, Extras::Fields(f))
}

/// Record one model call (the API other lanes call; see `telemetry.model_api`). Any process may call it.
pub fn model(c: &ModelCall<'_>) {
    event(model_call(c));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-tel-emit-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(defaults::text("files.telemetry_inbox"))
    }

    fn node(id: &str, o: Outcome) -> Event {
        node_run(&NodeRun { id, event: "PreToolUse", outcome: o, micros: 4200, out_bytes: 17, err_bytes: 3, exit: Some(2), fate: "ran" })
    }

    #[test]
    fn events_appended_by_another_process_are_read_back_whole_and_the_inbox_is_emptied() {
        let p = scratch("roundtrip");
        let evs = [
            node("git-guard", Outcome::Block),
            command_run("migrate", "-", 0, 1500, 3),
            model_call(&ModelCall {
                backend: "codex",
                model: "sonnet",
                purpose: "judge",
                outcome: Outcome::Allow,
                micros: 900_000,
                tokens_in: Some(120),
                tokens_out: None,
            }),
        ];
        append_to(&p, &evs);
        append_to(&p, &evs[..1]);
        let mut got = Vec::new();
        let r = ingest_from(&p, |e| got.push(e));
        assert_eq!(r, Ingested { events: 4, bad: 0 });
        assert_eq!(got[0], evs[0]);
        assert_eq!(got[1], evs[1]);
        assert_eq!(got[2], evs[2]);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0, "emptied");
        assert_eq!(ingest_from(&p, |_| panic!("nothing left")), Ingested::default());
        assert_eq!(ingest_from(&p.with_file_name("absent"), |_| panic!("no file")), Ingested::default());
    }

    #[test]
    fn a_line_with_text_in_it_is_refused_and_counted_not_stored() {
        let p = scratch("bad");
        std::fs::write(
            &p,
            "{\"ts\":1,\"k\":\"node\",\"h\":\"x\",\"e\":\"Stop\",\"o\":\"allow\",\"ms\":1,\"ib\":0,\"prompt\":\"fix the login bug\"}\nnot json\n{\"ts\":1,\"k\":\"node\",\"h\":\"x\",\"e\":\"Stop\",\"o\":\"allow\",\"ms\":1,\"ib\":0,\"fate\":\"ran it all\"}\n",
        )
        .unwrap();
        assert_eq!(ingest_from(&p, |_| panic!("none is valid")), Ingested { events: 0, bad: 3 });
    }

    #[test]
    fn the_inbox_stops_growing_at_its_cap() {
        let p = scratch("cap");
        let one = node("a", Outcome::Allow);
        let line = one.to_json().to_string().len() as u64 + 1;
        let cap = defaults::num("telemetry.inbox_max_bytes");
        for _ in 0..(cap / line + 50) {
            append_to(&p, std::slice::from_ref(&one));
        }
        assert!(std::fs::metadata(&p).unwrap().len() <= cap);
    }

    #[test]
    fn names_from_outside_are_sanitised_and_never_keep_prose() {
        let e = node("fix the login bug; rm -rf /", Outcome::Allow);
        assert_eq!(e.h.as_str(), "fix_the_login_bug__rm_-rf_/");
        let j = jev_call(&JevCall {
            integration: "speculation",
            mode: "on",
            verdict: "none",
            outcome: Outcome::Error,
            conf_pm: None,
            ms: 12,
            cost_uc: 0,
            backend: "baseline-only",
            breaker: "closed",
            error: Some("http 500 secret-key=abc"),
        });
        let json = j.to_json().to_string();
        assert!(!json.contains(' '), "{json}");
        assert_eq!(Event::from_json(&j.to_json()).unwrap(), j);
    }

    #[test]
    fn items_count_up_and_reset() {
        take_items();
        add_items(2);
        add_items(3);
        assert_eq!(take_items(), 5);
        assert_eq!(take_items(), 0);
    }
}
