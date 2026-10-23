//! D45 stage 2: the mesh CLI verbs that WRITE the per-repo DevSwarm store, behind `mesh.engine_writes`.
//!
//! `ah-engine mesh <devswarm.js argv...>` takes exactly the arguments `node scripts/devswarm.js <argv...>` took and prints the
//! same stdout and exits with the same code. The engine is the only process that acts; there is no Node to hand a verb to:
//!
//! * `on` (shipped default; `shadow`, a position of earlier versions, reads as `on`): the engine runs the verb. One it cannot
//!   answer (an [`ident::Defer`], an unported verb, no plugin context) is UNABLE: nothing was written, it is counted
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
use ident::{Defer, R};
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
        Some(Verb::Simple(v)) => simple::run(inv, a, v),
        Some(Verb::Migrate) => Ok(run_migrate(inv)),
        Some(Verb::Plan) => planverbs::run_plan(inv, a),
        Some(Verb::Scope) => planverbs::run_scope(inv, a),
        Some(Verb::Gate) => wsverbs::run_gate(inv, a),
        Some(Verb::Workspaces) => wsverbs::run_workspaces(inv, a),
        Some(Verb::Ext(v)) => extverbs::run(inv, a, v),
        None => ident::defer("not-ported"),
    }
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
fn unable(site: &str, detail: &str) -> i32 {
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, site, detail);
    eprintln!("{}", defaults::render("mesh_write.msg_unable", &[("site", &site), ("detail", &detail)]));
    defaults::num("mesh_write.exit_unable") as i32
}

/// Which call gave up, for the abandoned line: the verb label, the first two positionals (the verb words, never a message body)
/// and the reason, each leading word from `mesh_write.detail_*`.
pub fn call_detail(a: &args::Args, reason: &str) -> String {
    let sub = a.positionals.iter().take(defaults::num("mesh_write.detail_positionals") as usize).cloned().collect::<Vec<_>>().join(" ");
    defaults::render("mesh_write.msg_detail", &[("verb", &verb_label(a)), ("argv", &sub), ("reason", &reason)])
}

/// The switch is off: nothing is done, and it is counted and said, never a silent success.
fn disabled(site: &str) -> i32 {
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, site, "");
    eprintln!("{}", defaults::render("mesh_write.msg_disabled", &[("site", &site)]));
    defaults::num("mesh_write.exit_unable") as i32
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
        return unable("meshw:non_utf8_argument", "");
    };
    let a = args::parse(&argv);
    if mode() == Mode::Off {
        return disabled("meshw:native_off");
    }
    if verb_of(&a).is_none() {
        return unable("meshw:unhandled_verb", &call_detail(&a, ""));
    }
    // a help request (or any verb of `simple`) never reads fd 0
    let wants_stdin = a.has(defaults::text("mesh_write.flag_message_stdin")) && !cli_witnessed(verb_of(&a));
    let stdin = wants_stdin.then(read_stdin);
    let t0 = common::now_ms();
    let verb = verb_label(&a);
    let w = |k: &str| defaults::text(k).to_string();
    let Some(inv) = inv_from_process(stdin) else {
        shadow_log(&serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": w("mesh_write.shadow_defer"), "reason": "no-context"}));
        return unable("meshw:no_context", &call_detail(&a, "no-context"));
    };
    let r = std::panic::catch_unwind(|| run_native(&inv, &a));
    let (step, result, reason) = next_step(r, committed());
    shadow_log(&serde_json::json!({"ts": t0, "verb": verb, "mode": w("mesh_write.mode_on"), "result": result, "reason": reason, "ms": common::now_ms() - t0}));
    match step {
        Next::Print(ans) => {
            emit(ans.stdout.as_bytes());
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
            eprintln!("{}", defaults::text("mesh_write.msg_committed_failure"));
            defaults::num("mesh_write.exit_committed_failure") as i32
        }
        Next::Unable => unable("meshw:deferred", &call_detail(&a, &reason)),
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
        Ok(Err(Defer(d))) if committed => (Next::CommittedFailure, w("mesh_write.result_committed"), d),
        Ok(Err(Defer(d))) => (Next::Unable, w("mesh_write.shadow_defer"), d),
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
    fn a_deferral_or_panic_before_any_write_is_unable() {
        let (n, result, reason) = next_step(Ok(ident::defer("some-case")), false);
        assert!(is_unable(&n));
        assert_eq!((result.as_str(), reason.as_str()), (defaults::text("mesh_write.shadow_defer"), "some-case"));
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
        // a panic after the first write, and a deferral decided after it (a bug): both are committed failures
        for r in [panicked(), Ok(ident::defer("late"))] {
            let (n, result, _) = next_step(r, true);
            assert!(matches!(n, Next::CommittedFailure), "running the verb again after a write would write twice");
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
