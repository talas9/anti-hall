//! D45 stage 2: the mesh CLI verbs that WRITE the per-repo DevSwarm store, behind `mesh.engine_writes`.
//!
//! `ah-engine mesh <devswarm.js argv...>` takes exactly the arguments `node scripts/devswarm.js <argv...>` took and prints the
//! same stdout and exits with the same code. The engine is the only process that acts; there is no Node to hand a verb to:
//!
//! * `on` (shipped default; `shadow`, a position of earlier versions, reads as `on`): the engine runs the verb. One it cannot
//!   answer (an unported verb, no plugin context, a failure of the verb's own reads) is UNABLE: nothing was written, it is counted
//!   (`abandoned`), one line says so on stderr and the exit code is `mesh_write.exit_unable`;
//! * `off`: the diagnostic switch. Nothing is done; it is counted, said on stderr, and the exit code is `mesh_write.exit_unable`.
//!   Never a silent success.
//!
//! Ported verbs: `send` (direct, `--to-primary`, `--broadcast`), `mesh read` (consuming and `--peek`), `mesh history`,
//! `roster --ack`, `inbox ack-primary`, the plain `heartbeat`, `inbox tick <id>`, the single-partition `inbox read-primary` and the plain `roster`; and the store-free verbs of [`simple`] (`help`, the unknown-command answer, `skip`, `archive-ignore`, `archive-unignore`, `gate-intent`, `notice --list`), plus the plan, scope, gate, workspace and extension verbs.
//!
//! The exit-code contract (`mesh_write.exit_unable`, `mesh_write.exit_committed_failure`):
//!
//! * exit 69 (`exit_unable`, sysexits EX_UNAVAILABLE) is "unable or switched off, nothing written", with a stderr line naming the site.
//!   It is a visible error, never the silent 75 of a deferral, and is never used after a write.
//! * a failure AFTER the first store write (a panic, or a deferral decided late by a bug) exits `exit_committed_failure`
//!   (70): running the verb again would write twice.
//! * every other code is the verb's own result and passes through.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - the shadow is advisory: a failure to copy, compare or log never changes what Node did (it is logged when it can be)
// - text that does not parse or decode is the absent value (Node JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.
pub mod actverbs;
pub mod appdb;
pub mod appid;
pub mod appverbs;
pub mod archiveverb;
pub mod args;
pub mod clog;
pub mod common;
pub mod cursors;
pub mod diagverbs;
pub mod dsbverbs;
pub mod extverbs;
pub mod gitverbs;
pub mod heartbeat;
pub mod hivecontrol;
pub mod ident;
pub mod idlock;
pub mod inbox;
pub mod inboxcmd;
pub mod lifeverbs;
pub mod meshgroup;
pub mod mboxtool;
pub mod orphan;
pub mod plan;
pub mod planverbs;
pub mod pull;
pub mod read;
pub mod readprimary;
pub mod reconcileverb;
pub mod reportverbs;
pub mod roster;
pub mod rosterrows;
pub mod rostertail;
pub mod send;
pub mod simple;
pub mod spawnverb;
pub mod store;
pub mod summary;
pub mod tick;
pub mod tickarm;
pub mod union;
pub mod watcher;
pub mod wsverbs;

use crate::defaults;
use common::Inv;
use ident::R;
use send::Answer;
use std::io::{Read, Write};
use std::path::PathBuf;

/// Set at a verb's commit point (its first store write succeeded): from then on Node must never run the same verb in
/// this process, since that would write twice.
pub static COMMITTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Mark the commit point (see [`COMMITTED`]).
pub fn mark_committed() {
    COMMITTED.store(true, std::sync::atomic::Ordering::SeqCst);
    // the launcher that may stop this process at its time limit learns from this file that the verb already acted
    if let Some(mark) = std::env::var_os(defaults::text("mesh_write.env_commit_mark")).filter(|m| !m.is_empty()) {
        crate::discard::harmless(std::fs::OpenOptions::new().create(true).append(true).open(mark)); // keep: the mark is advisory; a failed create only leaves today's behaviour
    }
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

/// Remember that `rel` now holds exactly `bytes` (a file the verb rewrote, possibly more than once): the last write wins.
pub fn set_written(rel: &str, bytes: &[u8]) {
    if let Ok(mut w) = WRITTEN.lock() {
        match w.0.iter_mut().find(|(k, _)| k == rel) {
            Some((_, b)) => *b = bytes.to_vec(),
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

/// The two positions of `mesh.engine_writes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Switched off: the mesh write verbs do nothing (counted, with a message, exit `mesh_write.exit_unable`).
    Off,
    /// The engine acts (`shadow`, a position of earlier versions, reads as `on`).
    On,
}

/// `mesh.engine_writes` from the layered config (env, `settings.json`, `config.toml`, shipped default); an unknown word
/// is `off`.
pub fn mode() -> Mode {
    let (layers, _errs) = crate::cfgstore::load_layers_cold(&crate::cfgstore::Paths::from_env());
    let v = crate::cfgstore::Effective::resolve_process(&layers).text("mesh.engine_writes").trim().to_ascii_lowercase();
    let modes = defaults::list("mesh.engine_writes_modes");
    match modes.iter().position(|m| *m == v) {
        Some(1) | Some(2) => Mode::On,
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
    /// `inbox count <id>` (see [`inboxcmd`]).
    InboxCount,
    /// `inbox read <id>` (see [`inboxcmd`]).
    InboxRead,
    /// `inbox peek-primary <id>` (see [`readprimary`]).
    InboxPeekPrimary,
    /// `inbox ack <id>` (see [`inboxcmd`]).
    InboxAck,
    /// `inbox pull <id>` (see [`inboxcmd`]).
    InboxPull,
    /// `inbox messages <id>` (see [`readprimary::run_messages`]).
    InboxMessages,
    /// `inbox drain-primary-legacy <id>`: `read-primary --legacy-ack-now` under its own name (see [`readprimary`]).
    InboxDrain,
    /// `inbox <anything else> ...`: devswarm.js refuses it (`unknown inbox subcommand`, exit 2).
    InboxUnknown,
    /// `reconcile`: drain every worktree registered in the project's store (see [`reconcileverb`]).
    Reconcile,
    /// A verb that needs no store: `help` and the unknown-command answer, `skip`, `archive-ignore`, `archive-unignore`,
    /// `gate-intent`, `notice --list` (see [`simple`]).
    Simple(simple::Simple),
    /// `migrate`: the engine's migration pass (see [`run_migrate`]).
    Migrate,
    /// `plan set|show <id>` (see [`planverbs`]).
    Plan,
    /// `scope add <id>` (see [`planverbs`]).
    Scope,
    /// `gate <id> --set ... --clear ...` (see [`wsverbs`]).
    Gate,
    /// `workspaces list` (see [`wsverbs`]).
    Workspaces,
    /// `mesh <anything but read|history>`: devswarm.js refuses it (`unknown mesh subcommand`, exit 2).
    MeshUnknown,
    /// The verbs of lane l8b (see [`extverbs`]).
    Ext(extverbs::Ext),
}

/// Whether the verb is checked by the CLI-verb Node witness (`simple::prepare` / `launch` / `run_witness`).
fn cli_witnessed(v: Option<Verb>) -> bool {
    matches!(v, Some(Verb::Simple(_) | Verb::Plan | Verb::Scope | Verb::Gate | Verb::Workspaces)) || matches!(v, Some(Verb::Ext(e)) if extverbs::witnessed(e))
}

/// The verb's name as the telemetry log spells it (`Send`, `MeshRead`, `MeshHistory`, `InboxAckPrimary`).
pub fn verb_label(a: &args::Args) -> String {
    match verb_of(a) {
        Some(Verb::Simple(v)) => format!("{v:?}"),
        Some(Verb::Ext(v)) => format!("{v:?}"),
        v => v.map(|v| format!("{v:?}")).unwrap_or_default(),
    }
}

/// The ported verb of a parsed argv.
pub fn verb_of(a: &args::Args) -> Option<Verb> {
    if let Some(v) = simple::classify(a) {
        return Some(Verb::Simple(v));
    }
    if let Some(v) = extverbs::classify(a) {
        return Some(Verb::Ext(v));
    }
    let p0 = a.positionals.first().map(String::as_str)?;
    let p1 = a.positionals.get(1).map(String::as_str);
    if p0 == defaults::text("mesh_write.verb_send") {
        return Some(Verb::Send);
    }
    if p0 == defaults::text("devswarm_cli.verb_migrate") {
        return Some(Verb::Migrate);
    }
    if p0 == defaults::text("devswarm_cli.verb_plan") {
        return Some(Verb::Plan);
    }
    if p0 == defaults::text("devswarm_cli.verb_scope") {
        return Some(Verb::Scope);
    }
    if p0 == defaults::text("devswarm_cli.verb_gate") {
        return Some(Verb::Gate);
    }
    if p0 == defaults::text("devswarm_cli.verb_workspaces") {
        return Some(Verb::Workspaces);
    }
    if p0 == defaults::text("mesh_write.verb_mesh") && p1 == Some(defaults::text("mesh_write.verb_read")) {
        return Some(Verb::MeshRead);
    }
    if p0 == defaults::text("mesh_write.verb_mesh") && p1 == Some(defaults::text("mesh_write.verb_history")) {
        return Some(Verb::MeshHistory);
    }
    if p0 == defaults::text("mesh_write.verb_mesh") {
        return Some(Verb::MeshUnknown);
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
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_count")) {
        return Some(Verb::InboxCount);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_read")) {
        return Some(Verb::InboxRead);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_peek_primary")) {
        return Some(Verb::InboxPeekPrimary);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_ack")) {
        return Some(Verb::InboxAck);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_pull")) {
        return Some(Verb::InboxPull);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_tick")) {
        return Some(Verb::InboxTick);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_read_primary")) {
        return Some(Verb::InboxReadPrimary);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_messages")) {
        return Some(Verb::InboxMessages);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") && p1 == Some(defaults::text("mesh_write.verb_drain_primary_legacy")) {
        return Some(Verb::InboxDrain);
    }
    if p0 == defaults::text("mesh_write.verb_inbox") {
        return Some(Verb::InboxUnknown);
    }
    if p0 == defaults::text("mesh_write.verb_reconcile") {
        return Some(Verb::Reconcile);
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
        Some(Verb::InboxCount) => inboxcmd::run_count(inv, a),
        Some(Verb::InboxRead) => inboxcmd::run_read(inv, a),
        Some(Verb::InboxPeekPrimary) => readprimary::run_peek(inv, a),
        Some(Verb::InboxAck) => inboxcmd::run_ack(inv, a),
        Some(Verb::InboxPull) => inboxcmd::run_pull(inv, a),
        Some(Verb::InboxMessages) => readprimary::run_messages(inv, a),
        Some(Verb::InboxDrain) => readprimary::run(inv, a),
        Some(Verb::InboxUnknown) => Ok(inbox_unknown(a)),
        Some(Verb::Reconcile) => reconcileverb::run(inv, a),
        Some(Verb::Simple(v)) => simple::run(inv, a, v),
        Some(Verb::Migrate) => Ok(run_migrate(inv)),
        Some(Verb::Plan) => planverbs::run_plan(inv, a),
        Some(Verb::Scope) => planverbs::run_scope(inv, a),
        Some(Verb::Gate) => wsverbs::run_gate(inv, a),
        Some(Verb::Workspaces) => wsverbs::run_workspaces(inv, a),
        Some(Verb::Ext(v)) => extverbs::run(inv, a, v),
        Some(Verb::MeshUnknown) => Ok(mesh_unknown(a)),
        // unreachable: `run_front` answers `unable` for an argv with no verb before it calls this
        None => Ok(Answer { code: defaults::num("mesh_write.exit_unable") as i32, stdout: String::new(), effect: send::Effect::None }),
    }
}

/// devswarm.js `case 'mesh'` (scripts/devswarm.js:954-969): any subcommand but `read` and `history` is refused with exit 2.
fn mesh_unknown(a: &args::Args) -> Answer {
    let sub = a.positionals.get(1).map_or("", String::as_str);
    let msg = defaults::render("mesh_write.msg_unknown_mesh_sub", &[("sub", &crate::checks::guardkit::ojson::OVal::Str(sub.to_string()).stringify())]);
    let mut o = common::Obj::default();
    o.put("ok", crate::checks::guardkit::ojson::OVal::Bool(false)).put("error", common::s(&msg));
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: send::Effect::None }
}

/// `cmdInbox`'s last line (`devswarm-lib/inbox-cmd.js`): an `inbox` subcommand that is none of the known ones is refused with exit 2, after
/// the id check every `inbox` verb starts with (`invalid or missing workspace id`).
fn inbox_unknown(a: &args::Args) -> Answer {
    let id_ok = a.positionals.get(2).is_some_and(|i| idlock::is_safe_id(i));
    let mut o = common::Obj::default();
    o.put("ok", crate::checks::guardkit::ojson::OVal::Bool(false));
    if !id_ok {
        o.put("error", common::s(defaults::text("devswarm_cli.msg_bad_id")));
    } else {
        let sub = a.positionals.get(1).map_or(String::new(), |s| crate::checks::guardkit::ojson::OVal::Str(s.clone()).stringify());
        o.put("error", common::s(&defaults::render("mesh_write.msg_unknown_inbox_sub", &[("sub", &sub)])));
    }
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: send::Effect::None }
}

/// `devswarm.js migrate`: Node's `migrateToStore` imported descriptors into the first store layouts, which no install holds any more;
/// what is left of it (the hash-store fold and the other persisted-state repairs) is the engine's migration pass, which is run here.
/// The answer is that pass's report (`ok`, `action`, `version`, `error`, `repairs`), exit 0 unless a repair failed.
fn run_migrate(inv: &Inv) -> Answer {
    let env: std::collections::BTreeMap<String, String> = inv.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let root = crate::ops::plugin_root(&env);
    let mut ctx = crate::migrate::Ctx::new(inv.home.to_string_lossy().into_owned(), inv.cwd.clone(), env, false, None, root.clone());
    ctx.version = root.as_deref().and_then(|r| crate::migrate::plugin_version(&ctx, r));
    let rows = crate::migrate::run(&ctx);
    for n in ctx.take_notes() {
        eprintln!("{}", defaults::render("migrate_msg.note_line", &[("note", &n)]));
    }
    let shown = ctx.version.clone().unwrap_or_else(|| defaults::text("migrate_msg.unknown_version").to_string());
    let failed = rows.iter().any(|r| r.status == "failed");
    let out = crate::checks::jsport::json::stringify(&crate::migrate::report(&shown, &rows, None));
    Answer { code: if failed { 2 } else { 0 }, stdout: format!("{out}\n"), effect: send::Effect::None }
}

/// The invocation context of this process.
pub fn inv_from_process(stdin: Option<String>) -> Option<Inv> {
    let home = std::env::var_os(defaults::text("mesh_write.env_home")).filter(|h| !h.is_empty()).map(PathBuf::from)?;
    let cwd = std::env::current_dir().ok()?.to_str()?.to_string();
    let env: ident::Env = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let now = defaults::env_var("mesh_now").and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or_else(common::now_ms);
    Some(Inv { write_home: home.clone(), home, env, cwd, now, stdin, store_override: None })
}

/// The engine cannot answer this call and there is no Node to hand it to: count it, say so on stderr with the site, and exit with
/// the visible error code `mesh_write.exit_unable` (nothing was done; never the 75 of a deferral).
fn unable(json: bool, site: &str, detail: &str) -> i32 {
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, site, detail);
    let msg = defaults::render("mesh_write.msg_unable", &[("site", &site), ("detail", &detail)]);
    eprintln!("{msg}");
    let code = defaults::num("mesh_write.exit_unable") as i32;
    emit(loud_line(json, site, &msg, code).as_bytes());
    code
}

/// A form this CLI does not have. A verb of the old Node CLI that moved says where to (`mesh_write.retired_verbs`); any other word is
/// named with the way to list the verbs. Nothing was done; the exit code is `mesh_write.exit_unsupported` (a refusal, as Node's own
/// unknown-command answer is), never the 69 of an engine that could not do what the CLI offers.
fn unsupported(json: bool, a: &args::Args) -> i32 {
    let word = a.positionals.first().map_or("", String::as_str);
    let retired = defaults::raw("mesh_write.retired_verbs").get(word).and_then(|v| v.as_str());
    let (reason, msg) = match retired {
        Some(replacement) => (
            defaults::text("mesh_write.reason_retired_verb"),
            defaults::render("mesh_write.msg_retired_verb", &[("verb", &word), ("use", &replacement)]),
        ),
        None => (defaults::text("mesh_write.reason_unsupported_verb"), defaults::render("mesh_write.msg_unsupported_verb", &[("argv", &a.positionals.join(" "))])),
    };
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, "meshw:unsupported_verb", &call_detail(a, reason));
    eprintln!("{msg}");
    let code = defaults::num("mesh_write.exit_unsupported") as i32;
    if json {
        let mut o = common::Obj::default();
        o.put("ok", crate::checks::guardkit::ojson::OVal::Bool(false))
            .put("reason", common::s(reason))
            .put("error", common::s(&msg))
            .put("verb", common::s(word))
            .put("exit", crate::checks::guardkit::ojson::OVal::Num(f64::from(code)));
        emit(format!("{}\n", o.done().stringify()).as_bytes());
    } else {
        emit(format!("{msg}\n").as_bytes());
    }
    code
}

/// An `inbox <sub>` that takes a workspace id, run from a workspace session without one, reads the session's own: the id DevSwarm
/// handed it (`DEVSWARM_BUILDER_ID`), else the id its checkout derives. (devswarm.js refused such a call with `invalid or missing
/// workspace id`; the wake directives teach `inbox tick <id>` with the id spelled out, and a missing one is almost always a session
/// that has its own.) A session with neither is told what is missing.
fn with_self_id(inv: &Inv, a: args::Args) -> Result<args::Args, send::Answer> {
    let sub = a.positionals.get(1).map(String::as_str);
    let takes_id = a.positionals.first().map(String::as_str) == Some(defaults::text("mesh_write.verb_inbox"))
        && a.positionals.len() == 2
        && sub.is_some_and(|s| defaults::list("mesh_write.inbox_self_id_subs").contains(&s))
        && !a.is_help();
    if !takes_id {
        return Ok(a);
    }
    let own = ident::env_nonempty(&inv.env, defaults::text("mesh_write.env_builder_id"))
        .filter(|i| idlock::is_safe_id(i))
        .map(str::to_string)
        .or_else(|| ident::caller_identity_detailed(&inv.env, &inv.cwd).ok().filter(|c| c.kind != defaults::text("mesh_write.kind_unresolvable")).map(|c| c.identity))
        .filter(|i| idlock::is_safe_id(i));
    match own {
        Some(id) => {
            let mut b = a;
            b.positionals.push(id);
            Ok(b)
        }
        None => {
            let mut o = common::Obj::default();
            o.put("ok", crate::checks::guardkit::ojson::OVal::Bool(false))
                .put("error", common::s(&defaults::render("mesh_write.msg_inbox_needs_id", &[("sub", &sub.unwrap_or_default())])));
            Err(send::Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: send::Effect::None })
        }
    }
}

/// The stdout twin of a stderr failure line: one JSON object `{ok,error,reason,exit}` (field names and shape from
/// `mesh_write.loud_json`) when the verb runs with `--json`, else one plain line (`mesh_write.loud_text`). A caller that reads
/// stdout never sees a silent no-op.
pub fn loud_line(json: bool, error: &str, reason: &str, exit: i32) -> String {
    let enc = |v: &str| serde_json::Value::String(v.to_string()).to_string();
    let key = if json { "mesh_write.loud_json" } else { "mesh_write.loud_text" };
    let (error_v, reason_v) = if json { (enc(error), enc(reason)) } else { (error.to_string(), reason.to_string()) };
    format!("{}\n", defaults::render(key, &[("error", &error_v), ("reason", &reason_v), ("exit", &exit)]))
}

/// Whether the raw argv asks for JSON output (`--json`).
fn json_requested(raw: &[std::ffi::OsString]) -> bool {
    let flag = format!("--{}", defaults::text("mesh_write.flag_json"));
    raw.iter().any(|a| a.to_str() == Some(flag.as_str()))
}

/// Which call gave up, for the abandoned line: the verb label, the first two positionals (the verb words, never a message body)
/// and the reason, each leading word from `mesh_write.detail_*`.
pub fn call_detail(a: &args::Args, reason: &str) -> String {
    let sub = a.positionals.iter().take(defaults::num("mesh_write.detail_positionals") as usize).cloned().collect::<Vec<_>>().join(" ");
    defaults::render("mesh_write.msg_detail", &[("verb", &verb_label(a)), ("argv", &sub), ("reason", &reason)])
}

/// The switch is off: nothing is done, and it is counted and said, never a silent success.
fn disabled(json: bool, site: &str) -> i32 {
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, site, "");
    let msg = defaults::render("mesh_write.msg_disabled", &[("site", &site)]);
    eprintln!("{msg}");
    let code = defaults::num("mesh_write.exit_unable") as i32;
    emit(loud_line(json, site, &msg, code).as_bytes());
    code
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
    let json = json_requested(raw);
    let Some(argv) = raw.iter().map(|a| a.to_str().map(str::to_string)).collect::<Option<Vec<String>>>() else {
        return unable(json, "meshw:non_utf8_argument", "");
    };
    let a = args::parse(&argv);
    if mode() == Mode::Off {
        return disabled(json, "meshw:native_off");
    }
    if verb_of(&a).is_none() {
        return unsupported(json, &a);
    }
    // a help request (or any verb of `simple`) never reads fd 0
    let wants_stdin = a.has(defaults::text("mesh_write.flag_message_stdin")) && !cli_witnessed(verb_of(&a));
    let stdin = wants_stdin.then(read_stdin);
    let t0 = common::now_ms();
    let verb = verb_label(&a);
    let w = |k: &str| defaults::text(k).to_string();
    let Some(inv) = inv_from_process(stdin) else {
        shadow_log(&serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": w("mesh_write.shadow_defer"), "reason": "no-context"}));
        return unable(json, "meshw:no_context", &call_detail(&a, "no-context"));
    };
    let a = match with_self_id(&inv, a) {
        Ok(a) => a,
        Err(answer) => {
            emit(answer.stdout.as_bytes());
            return answer.code;
        }
    };
    let r = std::panic::catch_unwind(|| run_native(&inv, &a));
    let (step, result, reason) = next_step(r, committed());
    shadow_log(&serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": result, "reason": reason, "ms": common::now_ms() - t0}));
    match step {
        Next::Print(ans) => {
            emit(ans.stdout.as_bytes());
            if ans.code != 0 && ans.stdout.is_empty() {
                // a refusal that printed nothing: say it on stdout too (the verb's own non-empty answer is left as is)
                let msg = defaults::render("mesh_write.msg_empty_failure", &[("exit", &ans.code)]);
                eprintln!("{msg}");
                emit(loud_line(json, defaults::text("mesh_write.site_empty_failure"), &msg, ans.code).as_bytes());
            }
            ans.code
        }
        Next::Refuse(body) => {
            // Node's `Object.assign({ action: cmd }, refusal)`: the verb's name first, then the refusal's own fields
            let cmd = serde_json::to_string(a.positionals.first().map_or("", String::as_str)).unwrap_or_default();
            let fields = body.strip_prefix('{').unwrap_or(&body);
            emit(format!("{{\"action\":{cmd},{fields}\n").as_bytes());
            defaults::num("mesh_write.exit_refused") as i32
        }
        Next::CommittedFailure => {
            let msg = defaults::text("mesh_write.msg_committed_failure");
            eprintln!("{msg}");
            let code = defaults::num("mesh_write.exit_committed_failure") as i32;
            emit(loud_line(json, defaults::text("mesh_write.site_committed_failure"), msg, code).as_bytes());
            code
        }
        Next::Unable => unable(json, "meshw:deferred", &call_detail(&a, &reason)),
    }
}

/// What `run_front` does after the engine's attempt in `on` mode.
pub enum Next {
    /// The engine answered: print this and exit with its code.
    Print(Answer),
    /// The verb's own refusal (a JSON object without its `action`), printed with `mesh_write.exit_refused`.
    Refuse(String),
    /// It did not act and wrote nothing: nothing more can be done (there is no Node to run the verb).
    Unable,
    /// It wrote and then failed: report, and never run the verb again (that would write twice).
    CommittedFailure,
}

/// The one decision that keeps a write from happening twice: an answer is printed; a deferral or a panic BEFORE the
/// first write is "unable"; ANY failure after it is a committed failure. Returns the step plus the log result and reason.
pub fn next_step(r: std::thread::Result<R<Answer>>, committed: bool) -> (Next, String, String) {
    let w = |k: &str| defaults::text(k).to_string();
    match r {
        Ok(Ok(ans)) => (Next::Print(ans), w("mesh_write.on_native"), String::new()),
        Ok(Err(d)) if ident::refusal_body(&d).is_some() => {
            let body = ident::refusal_body(&d).unwrap_or_default().to_string();
            (Next::Refuse(body), w("mesh_write.result_refused"), String::new())
        }
        Ok(Err(d)) if committed => (Next::CommittedFailure, w("mesh_write.result_committed"), d.0),
        Ok(Err(d)) => (Next::Unable, w("mesh_write.shadow_defer"), d.0),
        Err(_) if committed => (Next::CommittedFailure, w("mesh_write.result_committed"), String::new()),
        Err(_) => (Next::Unable, w("mesh_write.shadow_panic"), String::new()),
    }
}

// ---- the call log ------------------------------------------------------------------------------------------------------

/// One JSON line per call: whether the engine answered or could not.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn answer() -> Answer {
        Answer { code: 0, stdout: "{}\n".into(), effect: send::Effect::None }
    }

    fn panicked() -> std::thread::Result<R<Answer>> {
        Err(Box::new("boom"))
    }

    fn is_unable(n: &Next) -> bool {
        matches!(n, Next::Unable)
    }

    #[test]
    fn the_unable_code_and_the_committed_failure_code_are_different_visible_errors() {
        assert_ne!(defaults::num("mesh_write.exit_unable"), 75, "an unable or switched-off verb is a visible error, never the silent 75 of a deferral");
        assert_ne!(defaults::num("mesh_write.exit_unable"), 0);
        assert_ne!(defaults::num("mesh_write.exit_committed_failure"), defaults::num("mesh_write.exit_unable"));
        assert_ne!(defaults::num("mesh_write.exit_committed_failure"), 0);
    }

    #[test]
    fn an_abandoned_call_names_its_verb_words_and_reason_but_not_the_message() {
        let argv: Vec<String> = ["send", "--to", "ws-1", "--message", "secret body"].iter().map(|s| s.to_string()).collect();
        let d = call_detail(&args::parse(&argv), "mesh-group");
        assert!(d.contains("verb=Send") && d.contains("reason=mesh-group"), "{d}");
        assert!(!d.contains("secret body"), "{d}");
    }

    #[test]
    fn a_panic_before_any_write_is_unable() {
        let (n, result, _) = next_step(panicked(), false);
        assert!(is_unable(&n));
        assert_eq!(result, defaults::text("mesh_write.shadow_panic"));
    }

    #[test]
    fn a_verbs_own_refusal_is_printed_not_abandoned() {
        for committed in [false, true] {
            let (n, result, _) = next_step(Ok(ident::refuse("{\"ok\":false,\"reason\":\"x\"}")), committed);
            assert!(matches!(&n, Next::Refuse(b) if b == "{\"ok\":false,\"reason\":\"x\"}"));
            assert_eq!(result, defaults::text("mesh_write.result_refused"));
        }
        assert!(ident::refusal_body(&ident::Defer("some-case".into())).is_none(), "an ordinary deferral is no refusal");
    }

    #[test]
    fn nothing_that_follows_a_write_is_ever_repeated() {
        // a panic after the first write: a committed failure
        let (n, result, _) = next_step(panicked(), true);
        assert!(matches!(n, Next::CommittedFailure), "running the verb again after a write would write twice");
        assert_eq!(result, defaults::text("mesh_write.result_committed"));
    }

    #[test]
    fn an_unknown_mesh_subcommand_is_refused_natively_as_devswarm_js_refuses_it() {
        let argv: Vec<String> = ["mesh", "bogus"].iter().map(|s| s.to_string()).collect();
        let a = args::parse(&argv);
        assert_eq!(verb_of(&a), Some(Verb::MeshUnknown));
        let ans = mesh_unknown(&a);
        assert_eq!(ans.code, 2);
        assert_eq!(ans.stdout, "{\"ok\":false,\"error\":\"unknown mesh subcommand: \\\"bogus\\\" (read|history)\"}\n");
        let bare = mesh_unknown(&args::parse(&["mesh".to_string()]));
        assert!(bare.stdout.contains("unknown mesh subcommand: \\\"\\\" (read|history)"), "{}", bare.stdout);
    }

    #[test]
    fn a_failure_is_loud_on_stdout_as_json_in_json_mode_and_as_one_line_otherwise() {
        let j = loud_line(true, "meshw:deferred", "nothing \"was\" done", 69);
        let v: serde_json::Value = serde_json::from_str(j.trim_end()).expect("one JSON object");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "meshw:deferred");
        assert_eq!(v["reason"], "nothing \"was\" done");
        assert_eq!(v["exit"], 69);
        assert_eq!(j.matches('\n').count(), 1);
        let t = loud_line(false, "meshw:deferred", "nothing was done", 69);
        assert_eq!(t.matches('\n').count(), 1);
        assert!(t.contains("meshw:deferred") && t.contains("nothing was done") && t.contains("69"), "{t}");
        assert!(serde_json::from_str::<serde_json::Value>(t.trim_end()).is_err(), "plain mode is not JSON: {t}");
    }

    #[test]
    fn json_mode_is_read_from_the_raw_argv() {
        let a = |w: &[&str]| w.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert!(json_requested(&a(&["roster", "--json"])));
        assert!(!json_requested(&a(&["roster"])));
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
