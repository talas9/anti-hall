//! The DevSwarm action layer: the engine runs the hivecontrol actions Node used to run (auto-archive, poke / escalate, and on
//! the owner's request archive, create, merge and an approved delete), with Node's policy, settings and gates.
//!
//! * The DECISION (may this run, why not, its argv, its idempotency key) is the plugin script `act/devswarm-act.js`; the engine
//!   keeps only the invariants a script bug must not be able to break: the verb allow-list, an explicit id for archive and
//!   delete, who may start which kind, the ledger, the bound on the subprocess, the delete plan and its confirmation.
//! * Every action: facts re-read from [`live::LiveState`] right before acting, the script decides again, the ledger claims the
//!   key (a done or in-doubt key never runs twice), the capability / version is checked, the call runs bounded, the result is
//!   logged and recorded. DevSwarm absent makes the whole layer inert and writes nothing.
//! * No new automatic actions: `devswarm_act.automatic_kinds` is the Node set; delete is owner-only and keeps its nonce plan,
//!   exact-id confirmation, 15 minute expiry and interactive-caller rule. Nothing here deletes user data on its own.
//! * Node-compatible records (auto-archive NDJSON, the durable `auto-archived.json`, `auto-archive-state.json`, the prune log
//!   and tombstone) are written in Node's format, so Node's own gate (h) refuses to repeat an archive the engine made and the
//!   engine refuses to repeat one Node made: the two can not both act on one (workspace, HEAD).
//! * Triggers: the realtime state (lane rt2) will call [`exec::Act::auto_archive_sweep`] and [`exec::Act::poke_sweep`]; owner
//!   requests call [`exec::Act::request`] and [`exec::Act::delete_confirmed`]. Until rt2 merges nothing calls them in the
//!   daemon: the trait [`live::LiveState`] is the whole seam.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an absent field of a fact or a request is the empty value, which the decision script reads as "not proven"
// - a record that cannot be appended to a log is lost, never the action's result
pub mod audit;
pub mod decide;
pub mod exec;
pub mod ledger;
pub mod live;
pub mod runner;
pub mod settings;
pub mod shadow;

#[cfg(test)]
mod tests;
