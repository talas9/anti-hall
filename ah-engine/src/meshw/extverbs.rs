//! The DevSwarm CLI verbs of lane l8b: the ones the engine's liveness, git, app-database and retention functions made
//! possible. Classification and dispatch live here; each family has its own module ([`super::gitverbs`]).
//!
//! Every verb answers with the exact stdout and exit code Node's `main()` prints and leaves the same bytes in the same files;
//! whatever the engine cannot reproduce is a [`crate::meshw::ident::Defer`] decided BEFORE the first write, so Node then runs
//! the verb. The Node version stays the non-acting background witness (see [`crate::meshw::simple::prepare`]).
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::Inv;
use crate::meshw::ident::R;
use crate::meshw::send::Answer;

/// A message of `devswarm_cli.toml` with its `{name}` placeholders filled in one pass (a value that itself contains `{x}` stays as is).
pub fn tpl(key: &str, args: &[(&str, &str)]) -> String {
    crate::checks::devswarm_role::text::fill_once(defaults::text(key), args)
}

/// Which verb of this family an argv names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ext {
    /// `ready-check <sha>`.
    ReadyCheck,
    /// `app-state [--json]`.
    AppState,
    /// `app-sync [--dry-run]`.
    AppSync,
    /// `done [<id>] [--summary TEXT]` (lane l8c).
    Done,
    /// `primary [status|takeover]` (lane l8c).
    Primary,
    /// `relay <seq> --to ID` (lane l8c).
    Relay,
    /// `archive-request <childId>` (lane l8c).
    ArchiveRequest,
}

/// The verb of a parsed argv (help requests are the `simple` module's and never reach here).
pub fn classify(a: &Args) -> Option<Ext> {
    let cmd = a.positionals.first().map(String::as_str)?;
    let is = |k: &str| cmd == defaults::text(k);
    if is("devswarm_cli.verb_ready_check") {
        Some(Ext::ReadyCheck)
    } else if is("devswarm_cli.verb_app_state") {
        Some(Ext::AppState)
    } else if is("devswarm_cli.verb_app_sync") {
        Some(Ext::AppSync)
    } else if is("devswarm_cli.verb_done") {
        Some(Ext::Done)
    } else if is("devswarm_cli.verb_primary") {
        Some(Ext::Primary)
    } else if is("devswarm_cli.verb_relay") {
        Some(Ext::Relay)
    } else if is("devswarm_cli.verb_archive_request") {
        Some(Ext::ArchiveRequest)
    } else {
        None
    }
}

/// Whether the verb reads the project's store (the witness then copies it).
pub fn needs_store(v: Ext) -> bool {
    matches!(v, Ext::Done | Ext::Relay | Ext::ArchiveRequest)
}

/// Run the verb.
pub fn run(inv: &Inv, a: &Args, v: Ext) -> R<Answer> {
    match v {
        Ext::ReadyCheck => super::gitverbs::ready_check(inv, a),
        Ext::AppState => super::appverbs::app_state(inv, a),
        Ext::AppSync => super::appverbs::app_sync(inv, a),
        Ext::Done => super::actverbs::done(inv, a),
        Ext::Primary => super::actverbs::primary(inv, a),
        Ext::Relay => super::actverbs::relay(inv, a),
        Ext::ArchiveRequest => super::actverbs::archive_request(inv, a),
    }
}
