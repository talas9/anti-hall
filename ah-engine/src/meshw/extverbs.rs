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
    /// `nudge <id>` (lane l8c).
    Nudge,
    /// `supervision-report [--days N] [--json]` (lane l8c).
    SupervisionReport,
    /// `sync-ui --titles-json F` (lane l8c).
    SyncUi,
    /// `retention status|run|restore` (lane l8c).
    Retention,
    /// `unarchive <id>` (lane l8h).
    Unarchive,
    /// `migrate-owner-keys` (lane l8h).
    MigrateOwnerKeys,
    /// `ensure <id>` (lane l8h).
    Ensure,
    /// `register <id>` (lane l8h).
    Register,
    /// `correct <id>` (lane l8h).
    Correct,
    /// `reap-orphans` (lane l8h).
    ReapOrphans,
    /// `archive <id>` (lane dsA).
    Archive,
    /// `register-primary` (lane dsA).
    RegisterPrimary,
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
    } else if is("devswarm_cli.verb_nudge") {
        Some(Ext::Nudge)
    } else if is("devswarm_cli.verb_supervision_report") {
        Some(Ext::SupervisionReport)
    } else if is("devswarm_cli.verb_sync_ui") {
        Some(Ext::SyncUi)
    } else if is("devswarm_cli.verb_retention") {
        Some(Ext::Retention)
    } else if is("devswarm_cli.verb_unarchive") {
        Some(Ext::Unarchive)
    } else if is("devswarm_cli.verb_migrate_owner_keys") {
        Some(Ext::MigrateOwnerKeys)
    } else if is("devswarm_cli.verb_ensure") {
        Some(Ext::Ensure)
    } else if is("devswarm_cli.verb_register") {
        Some(Ext::Register)
    } else if is("devswarm_cli.verb_correct") {
        Some(Ext::Correct)
    } else if is("devswarm_cli.verb_reap_orphans") {
        Some(Ext::ReapOrphans)
    } else if is("devswarm_cli.verb_archive") {
        Some(Ext::Archive)
    } else if is("devswarm_cli.verb_register_primary") {
        Some(Ext::RegisterPrimary)
    } else {
        None
    }
}

/// Whether the verb reads the project's store (the witness then copies it).
pub fn needs_store(v: Ext) -> bool {
    matches!(v, Ext::Done | Ext::Relay | Ext::ArchiveRequest | Ext::Nudge | Ext::Unarchive | Ext::Ensure | Ext::Register | Ext::Correct | Ext::ReapOrphans | Ext::RegisterPrimary)
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
        Ext::Nudge => super::actverbs::nudge(inv, a),
        Ext::SupervisionReport => super::reportverbs::supervision_report(inv, a),
        Ext::SyncUi => super::reportverbs::sync_ui(inv, a),
        Ext::Retention => super::reportverbs::retention(inv, a),
        Ext::Unarchive => super::lifeverbs::unarchive(inv, a),
        Ext::MigrateOwnerKeys => super::lifeverbs::migrate_owner_keys(inv, a),
        Ext::Ensure => super::lifeverbs::ensure(inv, a),
        Ext::Register => super::lifeverbs::register(inv, a),
        Ext::Correct => super::lifeverbs::correct(inv, a),
        Ext::ReapOrphans => super::lifeverbs::reap_orphans(inv, a),
        Ext::Archive => super::archiveverb::archive(inv, a),
        Ext::RegisterPrimary => super::lifeverbs::register_primary(inv, a),
    }
}

/// Whether the Node witness of the CLI verbs runs after the engine answered. Retention is gated before it acts (the engine's plan
/// and Node's read-only planner must agree on every row), and Node's own `run` would prune a copy of a store of any size.
pub fn witnessed(v: Ext) -> bool {
    !matches!(v, Ext::Retention | Ext::Archive)
}
