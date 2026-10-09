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

/// Which verb of this family an argv names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ext {
    /// `ready-check <sha>`.
    ReadyCheck,
}

/// The verb of a parsed argv (help requests are the `simple` module's and never reach here).
pub fn classify(a: &Args) -> Option<Ext> {
    let cmd = a.positionals.first().map(String::as_str)?;
    let is = |k: &str| cmd == defaults::text(k);
    if is("devswarm_cli.verb_ready_check") {
        Some(Ext::ReadyCheck)
    } else {
        None
    }
}

/// Whether the verb reads the project's store (the witness then copies it).
pub fn needs_store(_v: Ext) -> bool {
    false
}

/// Run the verb.
pub fn run(inv: &Inv, a: &Args, v: Ext) -> R<Answer> {
    match v {
        Ext::ReadyCheck => super::gitverbs::ready_check(inv, a),
    }
}
