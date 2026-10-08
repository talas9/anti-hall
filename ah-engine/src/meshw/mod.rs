//! D45 stage 2: the mesh CLI verbs that WRITE the per-repo DevSwarm store, behind `mesh.engine_writes`.
//!
//! `ah-engine mesh <devswarm.js argv...>` takes exactly the arguments `node scripts/devswarm.js <argv...>` takes and,
//! when it answers itself, prints the same stdout and exits with the same code. Which process acts is the switch:
//!
//! * `off` (shipped default): Node runs the verb (the engine `exec`s it, nothing else happens);
//! * `shadow`: Node runs the verb and its output is passed through unchanged; the engine then runs the same verb against
//!   a scratch COPY of the store (taken before Node ran) and a scratch home, with Node's timestamp, and appends one JSON
//!   line to `<state dir>/mesh_write.shadow_log` saying whether stdout, the exit code and the store row it wrote match.
//!   (In `on` mode the same log gets one line per call saying whether the engine answered or handed it to Node, so the
//!   native coverage is measured in both modes.)
//!   A panic or an error in the engine path is caught and logged; it never touches Node's result;
//! * `on`: the engine runs the verb; wherever it cannot reproduce Node exactly (an [`ident::Defer`]) Node runs it.
//!
//! Ported verbs: `send` (direct, `--to-primary`, `--broadcast`), `mesh read` (consuming and `--peek`), `mesh history`,
//! `roster --ack`, `inbox ack-primary`, the plain `heartbeat`, `inbox tick <id>`, the single-partition `inbox read-primary` and the empty-project plain `roster`. Every other verb runs in Node whatever the switch says.
//!
//! The exit-code contract (`mesh_write.exit_defer`, `mesh_write.exit_committed_failure`):
//!
//! * a verb the engine does not answer is DEFERRED, always before its first write; `ah-engine mesh` then runs Node
//!   itself and exits with Node's code. Exit 75 (`exit_defer`, sysexits EX_TEMPFAIL) is reserved for "deferred, nothing
//!   written, and the engine could not run Node itself": the caller runs Node. It is never used after a write.
//! * a failure AFTER the first store write (a panic, or a deferral decided late by a bug) exits `exit_committed_failure`
//!   (70) and never runs Node: running the verb again would write twice. It is deliberately not 75, the one code a
//!   caller may answer by running Node.
//! * every other code is the verb's own result and passes through.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - the shadow is advisory: a failure to copy, compare or log never changes what Node did (it is logged when it can be)
// - text that does not parse or decode is the absent value (Node JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.
pub mod appdb;
pub mod args;
pub mod common;
pub mod cursors;
pub mod heartbeat;
pub mod hivecontrol;
pub mod ident;
pub mod idlock;
pub mod inbox;
pub mod plan;
pub mod read;
pub mod readprimary;
pub mod roster;
pub mod send;
pub mod store;
pub mod summary;
pub mod tick;
pub mod union;
pub mod verify;

use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use common::Inv;
use ident::{Defer, R};
use send::Answer;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Set at a verb's commit point (its first store write succeeded): from then on Node must never run the same verb in
/// this process, since that would write twice.
pub static COMMITTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Mark the commit point (see [`COMMITTED`]).
pub fn mark_committed() {
    COMMITTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn committed() -> bool {
    COMMITTED.load(std::sync::atomic::Ordering::SeqCst)
}

/// The files a native verb wrote (path under the home, bytes appended or written) and the mesh row it appended, kept for the
/// background Node check, which compares what Node writes on a scratch copy with exactly what the engine wrote.
type Written = (Vec<(String, Vec<u8>)>, Option<String>);

static WRITTEN: std::sync::Mutex<Written> = std::sync::Mutex::new((Vec::new(), None));

/// Remember that `rel` (a path under the home) now holds / got `bytes` from this verb; bytes for the same path accumulate.
pub fn note_written(rel: &str, bytes: &[u8]) {
    if let Ok(mut w) = WRITTEN.lock() {
        match w.0.iter_mut().find(|(k, _)| k == rel) {
            Some((_, b)) => b.extend_from_slice(bytes),
            None => w.0.push((rel.to_string(), bytes.to_vec())),
        }
    }
}

/// Remember the hash of the mesh row this verb appended.
pub fn note_row(hash: &str) {
    if let Ok(mut w) = WRITTEN.lock() {
        w.1 = Some(hash.to_string());
    }
}

/// What [`note_written`] and [`note_row`] collected (the background check reads it once).
pub fn take_written() -> (Vec<(String, Vec<u8>)>, Option<String>) {
    WRITTEN.lock().map(|mut w| std::mem::take(&mut *w)).unwrap_or_default()
}

/// Log a summary refresh the engine could not do after its write (Node's next derive refreshes it).
pub fn log_summary_failure(verb: &str, reason: &str) {
    shadow_log(&serde_json::json!({"ts": common::now_ms(), "verb": verb, "result": defaults::text("mesh_write.summary_failed"), "reason": reason}));
}

/// Append one record to the background-verification log.
pub fn verify_log(rec: &serde_json::Value) {
    let p = crate::paths::dir().join(defaults::text("mesh_write.verify_log"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        crate::discard::harmless(f.write_all(format!("{rec}\n").as_bytes())); // keep: advisory log
    }
}

/// The three positions of `mesh.engine_writes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Node acts.
    Off,
    /// Node acts; the engine runs on a copy and logs differences.
    Shadow,
    /// The engine acts where it can, Node elsewhere.
    On,
}

/// `mesh.engine_writes` from the layered config (env, `settings.json`, `config.toml`, shipped default); an unknown word
/// is `off`.
pub fn mode() -> Mode {
    let (layers, _errs) = crate::cfgstore::load_layers_cold(&crate::cfgstore::Paths::from_env());
    let v = crate::cfgstore::Effective::resolve_process(&layers).text("mesh.engine_writes").trim().to_ascii_lowercase();
    let modes = defaults::list("mesh.engine_writes_modes");
    match modes.iter().position(|m| *m == v) {
        Some(1) => Mode::Shadow,
        Some(2) => Mode::On,
        _ => Mode::Off,
    }
}

/// Which ported verb an argv names, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    /// `send`.
    Send,
    /// `mesh read` / `roster --ack`.
    MeshRead,
    /// `mesh history`.
    MeshHistory,
    /// `inbox ack-primary`.
    InboxAckPrimary,
    /// `heartbeat` (the plain form).
    Heartbeat,
    /// `inbox tick <id> --quiet`.
    InboxTick,
    /// `inbox read-primary <id>`.
    InboxReadPrimary,
    /// Plain `roster` (no `--ack`).
    Roster,
}

/// The verb's name as the telemetry log spells it (`Send`, `MeshRead`, `MeshHistory`, `InboxAckPrimary`).
pub fn verb_label(a: &args::Args) -> String {
    verb_of(a).map(|v| format!("{v:?}")).unwrap_or_default()
}

/// The ported verb of a parsed argv.
pub fn verb_of(a: &args::Args) -> Option<Verb> {
    let p0 = a.positionals.first().map(String::as_str)?;
    let p1 = a.positionals.get(1).map(String::as_str);
    if p0 == defaults::text("mesh_write.verb_send") {
        return Some(Verb::Send);
    }
    if p0 == defaults::text("mesh_write.verb_mesh") && p1 == Some(defaults::text("mesh_write.verb_read")) {
        return Some(Verb::MeshRead);
    }
    if p0 == defaults::text("mesh_write.verb_mesh") && p1 == Some(defaults::text("mesh_write.verb_history")) {
        return Some(Verb::MeshHistory);
    }
    if p0 == defaults::text("mesh_write.verb_roster") && a.has(defaults::text("mesh_write.flag_ack")) {
        return Some(Verb::MeshRead);
    }
    if p0 == defaults::text("mesh_write.verb_roster") {
        return Some(Verb::Roster);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_ack_primary")) {
        return Some(Verb::InboxAckPrimary);
    }
    if p0 == defaults::text("mesh_write.verb_heartbeat") {
        return Some(Verb::Heartbeat);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_tick")) {
        return Some(Verb::InboxTick);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_read_primary")) {
        return Some(Verb::InboxReadPrimary);
    }
    None
}

/// Run a ported verb natively.
pub fn run_native(inv: &Inv, a: &args::Args) -> R<Answer> {
    match verb_of(a) {
        Some(Verb::Send) => send::run(inv, a),
        Some(Verb::MeshRead) => read::run(inv, a, false),
        Some(Verb::MeshHistory) => read::run(inv, a, true),
        Some(Verb::InboxAckPrimary) => inbox::run(inv, a),
        Some(Verb::Heartbeat) => heartbeat::run(inv, a),
        Some(Verb::InboxTick) => tick::run(inv, a),
        Some(Verb::InboxReadPrimary) => readprimary::run(inv, a),
        Some(Verb::Roster) => roster::run(inv, a),
        None => ident::defer("not-ported"),
    }
}

/// The invocation context of this process.
pub fn inv_from_process(stdin: Option<String>) -> Option<Inv> {
    let home = std::env::var_os(defaults::text("mesh_write.env_home")).filter(|h| !h.is_empty()).map(PathBuf::from)?;
    let cwd = std::env::current_dir().ok()?.to_str()?.to_string();
    let env: ident::Env = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let now = defaults::env_var("mesh_now").and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or_else(common::now_ms);
    Some(Inv { write_home: home.clone(), home, env, cwd, now, stdin, store_override: None })
}

fn node_cli() -> Option<PathBuf> {
    let root = defaults::root()?;
    Some(root.join(defaults::text("mesh_write.node_cli")))
}

fn node_cmd(argv: &[String]) -> Option<Command> {
    let cli = node_cli()?;
    let mut c = Command::new(defaults::text("mesh_write.node_bin"));
    c.arg(cli).args(argv);
    Some(c)
}

/// Hand the whole invocation to Node (replaces this process; never returns on success).
fn exec_node(argv: &[String]) -> i32 {
    let Some(mut c) = node_cmd(argv) else {
        eprintln!("{}", defaults::text("mesh_write.msg_no_node_cli"));
        return defaults::num("mesh_write.exit_defer") as i32;
    };
    let e = c.exec();
    eprintln!("{}", defaults::render("mesh_write.msg_node_exec_failed", &[("err", &e)]));
    defaults::num("mesh_write.exit_defer") as i32
}

/// Run Node as a child, feeding `stdin` when given, passing its stderr through; returns (exit code, stdout bytes).
fn spawn_node(argv: &[String], stdin: Option<&str>) -> Option<(i32, Vec<u8>)> {
    let mut c = node_cmd(argv)?;
    c.stdout(Stdio::piped()).stderr(Stdio::inherit());
    c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::inherit() });
    let mut child = c.spawn().ok()?;
    if let Some(body) = stdin
        && let Some(mut w) = child.stdin.take()
    {
        crate::discard::harmless(w.write_all(body.as_bytes())); // keep: a child that exits early closes the pipe; its own output says why
    }
    let out = child.wait_with_output().ok()?;
    let code = out.status.code().unwrap_or_else(|| {
        use std::os::unix::process::ExitStatusExt;
        out.status.signal().map_or(1, |s| defaults::num("mesh_write.exit_signal_base") as i32 + s)
    });
    Some((code, out.stdout))
}

fn emit(stdout: &[u8]) {
    let o = std::io::stdout();
    let mut l = o.lock();
    crate::discard::harmless(l.write_all(stdout)); // keep: a closed stdout leaves nobody to tell
    crate::discard::harmless(l.flush()); // keep: as above
}

fn read_stdin() -> String {
    let mut b = Vec::new();
    crate::discard::harmless(std::io::stdin().read_to_end(&mut b)); // keep: Node reads what fd 0 holds; an error is an empty body
    String::from_utf8_lossy(&b).into_owned()
}

/// `ah-engine mesh <devswarm.js argv...>`: see the module header.
pub fn run_front(raw: &[std::ffi::OsString]) -> i32 {
    let Some(argv) = raw.iter().map(|a| a.to_str().map(str::to_string)).collect::<Option<Vec<String>>>() else {
        // a non-UTF-8 argument: Node reads it its own way
        let lossy: Vec<String> = raw.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        return exec_node(&lossy);
    };
    if argv.first().map(String::as_str) == Some(defaults::text("mesh_write.verify_flag")) {
        return verify::run_verifier(&argv[1..]);
    }
    let a = args::parse(&argv);
    let m = mode();
    if m == Mode::Off || verb_of(&a).is_none() {
        return exec_node(&argv);
    }
    let wants_stdin = a.has(defaults::text("mesh_write.flag_message_stdin"));
    let stdin = wants_stdin.then(read_stdin);
    match m {
        Mode::On => {
            let t0 = common::now_ms();
            let verb = verb_label(&a);
            let w = |k: &str| defaults::text(k).to_string();
            let Some(inv) = inv_from_process(stdin.clone()) else {
                shadow_log(
                    &serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": w("mesh_write.shadow_defer"), "reason": "no-context"}),
                );
                return node_with(&argv, stdin.as_deref());
            };
            // a writing verb keeps Node as a background check on a scratch copy (never a second write on the real home)
            let scratch = match verb_of(&a) {
                Some(Verb::Heartbeat) => verify::prepare(&inv, a.one(defaults::text("mesh_write.flag_summary")).is_some()),
                Some(Verb::InboxTick) => verify::prepare_tick(&inv),
                Some(Verb::InboxReadPrimary) => verify::prepare_read_primary(&inv),
                Some(Verb::Roster) => verify::prepare_roster(&inv),
                _ => None,
            };
            let r = std::panic::catch_unwind(|| run_native(&inv, &a));
            let (step, result, reason) = next_step(r, committed());
            shadow_log(
                &serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": result, "reason": reason, "ms": common::now_ms() - t0}),
            );
            match step {
                Next::Print(ans) => {
                    if let Some(sc) = &scratch {
                        verify::launch(sc, &inv, &argv, &ans.stdout);
                    }
                    emit(ans.stdout.as_bytes());
                    ans.code
                }
                Next::CommittedFailure => {
                    if let Some(sc) = &scratch {
                        verify::discard_tree(sc);
                    }
                    eprintln!("{}", defaults::text("mesh_write.msg_committed_failure"));
                    defaults::num("mesh_write.exit_committed_failure") as i32
                }
                Next::RunNode => {
                    if let Some(sc) = &scratch {
                        verify::discard_tree(sc);
                    }
                    node_with(&argv, stdin.as_deref())
                }
            }
        }
        // the write verbs replay on a copy of the store; a verb whose inputs are files outside it (a read receipt that
        // Node consumes while it runs) cannot be replayed, so it only runs in Node and is counted
        _ if matches!(verb_of(&a), Some(Verb::InboxAckPrimary | Verb::Heartbeat | Verb::InboxTick | Verb::InboxReadPrimary | Verb::Roster)) => {
            // logged BEFORE Node runs: with no stdin to forward the engine replaces itself with Node and never returns
            shadow_log(
                &serde_json::json!({"ts": common::now_ms(), "verb": verb_label(&a), "mode": defaults::text("mesh_write.mode_shadow"), "result": defaults::text("mesh_write.shadow_skipped"), "reason": "", "ms": 0}),
            );
            node_with(&argv, stdin.as_deref())
        }
        _ => shadow(&argv, &a, stdin),
    }
}

/// What `run_front` does after the engine's attempt in `on` mode.
pub enum Next {
    /// The engine answered: print this and exit with its code.
    Print(Answer),
    /// It did not act and wrote nothing: run the verb in Node.
    RunNode,
    /// It wrote and then failed: report, never run Node (that would write twice).
    CommittedFailure,
}

/// The one decision that keeps a write from happening twice: an answer is printed; a deferral or a panic BEFORE the
/// first write runs Node; ANY failure after it is a committed failure. Returns the step plus the log result and reason.
pub fn next_step(r: std::thread::Result<R<Answer>>, committed: bool) -> (Next, String, String) {
    let w = |k: &str| defaults::text(k).to_string();
    match r {
        Ok(Ok(ans)) => (Next::Print(ans), w("mesh_write.on_native"), String::new()),
        Ok(Err(Defer(d))) if committed => (Next::CommittedFailure, w("mesh_write.result_committed"), d),
        Ok(Err(Defer(d))) => (Next::RunNode, w("mesh_write.shadow_defer"), d),
        Err(_) if committed => (Next::CommittedFailure, w("mesh_write.result_committed"), String::new()),
        Err(_) => (Next::RunNode, w("mesh_write.shadow_panic"), String::new()),
    }
}

fn node_with(argv: &[String], stdin: Option<&str>) -> i32 {
    match stdin {
        None => exec_node(argv),
        Some(body) => match spawn_node(argv, Some(body)) {
            Some((code, out)) => {
                emit(&out);
                code
            }
            None => {
                eprintln!("{}", defaults::text("mesh_write.msg_no_node_cli"));
                defaults::num("mesh_write.exit_defer") as i32
            }
        },
    }
}

// ---- shadow -----------------------------------------------------------------------------------------------------------

struct Scratch {
    dir: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: our own scratch directory; leftovers are only disk
    }
}

/// The real store file of the caller's project, when the engine can name it.
fn real_store(inv: &Inv) -> R<PathBuf> {
    let cwd = ident::project_cwd_for(&inv.home, &inv.env, &inv.cwd)?;
    let Some(rk) = ident::repo_key_for_worktree(&cwd)? else { return ident::defer("no-project") };
    Ok(idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(rk).join(defaults::text("mesh_write.store_file")))
}

/// Copy a live store with SQLite's online backup (a consistent snapshot whatever writers do meanwhile).
fn snapshot(src: &Path, dst: &Path) -> Result<i64, String> {
    let from = rusqlite::Connection::open_with_flags(src, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| e.to_string())?;
    from.busy_timeout(defaults::millis("mesh.busy_timeout_ms")).map_err(|e| e.to_string())?;
    let mut to = rusqlite::Connection::open(dst).map_err(|e| e.to_string())?;
    {
        let b = rusqlite::backup::Backup::new(&from, &mut to).map_err(|e| e.to_string())?;
        b.run_to_completion(defaults::num("mesh_write.shadow_backup_pages") as i32, defaults::millis("mesh_write.shadow_backup_pause_ms"), None)
            .map_err(|e| e.to_string())?;
    }
    let max_id: i64 = to.query_row(crate::sql::MESHW_MAX_MESSAGE_ID, [], |r| r.get::<_, Option<i64>>(0)).map_err(|e| e.to_string())?.unwrap_or(0);
    Ok(max_id)
}

/// The physical row a send wrote, by hash: every column but the rowid.
fn row_by_hash(db: &Path, hash: &str) -> Option<String> {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    c.busy_timeout(defaults::millis("mesh.busy_timeout_ms")).ok()?;
    c.query_row(crate::sql::MESHW_ROW_BY_HASH, [hash], |r| {
        let mut parts = Vec::new();
        for i in 0..13 {
            parts.push(match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => "null".to_string(),
                rusqlite::types::ValueRef::Integer(x) => x.to_string(),
                rusqlite::types::ValueRef::Real(x) => x.to_string(),
                rusqlite::types::ValueRef::Text(t) => serde_json::to_string(&String::from_utf8_lossy(t)).unwrap_or_default(),
                rusqlite::types::ValueRef::Blob(b) => format!("blob:{}", b.len()),
            });
        }
        Ok(parts.join("|"))
    })
    .ok()
}

fn count_after(db: &Path, id: i64) -> i64 {
    let Ok(c) = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return -1;
    };
    c.query_row(crate::sql::MESHW_COUNT_AFTER_ID, [id], |r| r.get(0)).unwrap_or(-1)
}

fn broadcast_cursor_of(db: &Path, id: &str) -> Option<i64> {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    c.query_row(crate::sql::MESH_BROADCAST_CURSOR, [id], |r| r.get::<_, i64>(0)).ok()
}

fn cap(s: &str) -> String {
    let n = defaults::num("mesh_write.shadow_log_cap") as usize;
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn shadow_log(rec: &serde_json::Value) {
    let p = crate::paths::dir().join(defaults::text("mesh_write.shadow_log"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the append below reports nothing either way
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        // one write of the whole line: concurrent `ah-engine mesh` processes append to the same file, and `writeln!`
        // issues one write per formatting piece, which interleaves lines between processes (O_APPEND keeps one write whole)
        crate::discard::harmless(f.write_all(format!("{rec}\n").as_bytes())); // keep: the shadow log is advisory
    }
}

/// Shadow mode: Node acts; the engine replays on a copy and logs the comparison.
fn shadow(argv: &[String], a: &args::Args, stdin: Option<String>) -> i32 {
    let t0 = common::now_ms();
    let inv0 = inv_from_process(stdin.clone());
    let verb = verb_label(a);
    // 1. snapshot the store before Node writes
    let scratch_dir = crate::paths::dir().join(defaults::text("mesh_write.shadow_dir")).join(format!("{}-{}", std::process::id(), t0));
    let scratch = Scratch { dir: scratch_dir.clone() };
    let mut pre: Result<(PathBuf, i64), String> = Err(String::new());
    if let Some(inv) = &inv0 {
        pre = match real_store(inv) {
            Ok(real) if real.is_file() => {
                crate::discard::harmless(std::fs::create_dir_all(&scratch_dir)); // keep: the snapshot below reports the failure
                let copy = scratch_dir.join(defaults::text("mesh_write.store_file"));
                snapshot(&real, &copy).map(|max| (real, max))
            }
            Ok(_) => Err(defaults::text("mesh_write.shadow_no_store").to_string()),
            Err(Defer(d)) => Err(d),
        };
    }
    // 2. Node acts, its output passes through unchanged
    let Some((node_code, node_out)) = spawn_node(argv, stdin.as_deref()) else {
        eprintln!("{}", defaults::text("mesh_write.msg_no_node_cli"));
        return defaults::num("mesh_write.exit_defer") as i32;
    };
    emit(&node_out);
    // 3. the engine replays on the copy; nothing below can change what Node did
    let rec = std::panic::catch_unwind(|| compare(inv0, a, pre, &scratch_dir, node_code, &node_out))
        .unwrap_or_else(|_| serde_json::json!({"result": defaults::text("mesh_write.shadow_panic")}));
    let mut rec = rec;
    rec["ts"] = serde_json::json!(t0);
    rec["verb"] = serde_json::json!(verb);
    rec["ms"] = serde_json::json!(common::now_ms() - t0);
    rec["mode"] = serde_json::json!(defaults::text("mesh_write.mode_shadow"));
    shadow_log(&rec);
    drop(scratch);
    node_code
}

fn compare(inv0: Option<Inv>, a: &args::Args, pre: Result<(PathBuf, i64), String>, scratch: &Path, node_code: i32, node_out: &[u8]) -> serde_json::Value {
    let w = |k: &str| defaults::text(k).to_string();
    let Some(mut inv) = inv0 else { return serde_json::json!({"result": w("mesh_write.shadow_defer"), "reason": "no-context"}) };
    let (real, max_id) = match pre {
        Ok(x) => x,
        Err(reason) => return serde_json::json!({"result": w("mesh_write.shadow_defer"), "reason": reason}),
    };
    let node_text = String::from_utf8_lossy(node_out).into_owned();
    let node_json = OVal::parse(node_text.trim_end());
    // replay Node's clock: a send's row carries it (the hash covers it); otherwise "now"
    let node_hash = node_json.as_ref().and_then(|j| match j.get("hash") {
        Some(OVal::Str(h)) => Some(h.clone()),
        _ => None,
    });
    if let Some(h) = &node_hash
        && let Ok(c) = rusqlite::Connection::open_with_flags(&real, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        && let Ok(ts) = c.query_row(crate::sql::MESHW_TS_BY_HASH, [h], |r| r.get::<_, i64>(0))
    {
        inv.now = ts;
    }
    inv.store_override = Some(scratch.join(defaults::text("mesh_write.store_file")));
    inv.write_home = scratch.join(defaults::text("mesh_write.shadow_home"));
    let eng = run_native(&inv, a);
    let concurrent = count_after(&real, max_id) > i64::from(node_hash.is_some());
    match eng {
        Err(Defer(reason)) => serde_json::json!({"result": w("mesh_write.shadow_defer"), "reason": reason, "nodeCode": node_code}),
        Ok(ans) => {
            let same_out = ans.stdout == node_text;
            let same_code = ans.code == node_code;
            let copy = scratch.join(defaults::text("mesh_write.store_file"));
            let same_row = match &ans.effect {
                send::Effect::Row(h) => row_by_hash(&real, h) == row_by_hash(&copy, h),
                send::Effect::BroadcastCursor(k) => broadcast_cursor_of(&real, k) == broadcast_cursor_of(&copy, k),
                send::Effect::None => true,
            };
            let ok = same_out && same_code && same_row;
            let result = if ok {
                w("mesh_write.shadow_match")
            } else if concurrent {
                w("mesh_write.shadow_concurrent")
            } else {
                w("mesh_write.shadow_mismatch")
            };
            let mut rec = serde_json::json!({"result": result, "sameStdout": same_out, "sameCode": same_code, "sameRow": same_row, "nodeCode": node_code, "engineCode": ans.code});
            if !ok {
                rec["node"] = serde_json::json!(cap(&node_text));
                rec["engine"] = serde_json::json!(cap(&ans.stdout));
            }
            rec
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer() -> Answer {
        Answer { code: 0, stdout: "{}\n".into(), effect: send::Effect::None }
    }

    fn panicked() -> std::thread::Result<R<Answer>> {
        Err(Box::new("boom"))
    }

    fn is_node(n: &Next) -> bool {
        matches!(n, Next::RunNode)
    }

    #[test]
    fn exit_75_and_the_committed_failure_code_are_different_codes() {
        assert_eq!(defaults::num("mesh_write.exit_defer"), 75, "75 is sysexits EX_TEMPFAIL, the engine-wide 'deferred, nothing written'");
        assert_ne!(defaults::num("mesh_write.exit_committed_failure"), defaults::num("mesh_write.exit_defer"));
        assert_ne!(defaults::num("mesh_write.exit_committed_failure"), 0);
    }

    #[test]
    fn a_deferral_or_panic_before_any_write_runs_node() {
        let (n, result, reason) = next_step(Ok(ident::defer("some-case")), false);
        assert!(is_node(&n));
        assert_eq!((result.as_str(), reason.as_str()), (defaults::text("mesh_write.shadow_defer"), "some-case"));
        let (n, result, _) = next_step(panicked(), false);
        assert!(is_node(&n));
        assert_eq!(result, defaults::text("mesh_write.shadow_panic"));
    }

    #[test]
    fn nothing_that_follows_a_write_ever_runs_node() {
        // a panic after the first write, and a deferral decided after it (a bug): both are committed failures
        for r in [panicked(), Ok(ident::defer("late"))] {
            let (n, result, _) = next_step(r, true);
            assert!(matches!(n, Next::CommittedFailure), "running Node after a write would write twice");
            assert_eq!(result, defaults::text("mesh_write.result_committed"));
        }
    }

    #[test]
    fn an_answer_is_printed_whether_or_not_it_wrote() {
        for committed in [false, true] {
            let (n, result, _) = next_step(Ok(Ok(answer())), committed);
            assert!(matches!(n, Next::Print(_)));
            assert_eq!(result, defaults::text("mesh_write.on_native"));
        }
    }
}
