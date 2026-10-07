//! Helpers shared by the small Bash guards ported from Node (merge-side-pick, ship-it-guard, scan-throttle,
//! coordinator-work-guard, compact-declaration-guard).
//!
//! Why a shared module: all five guards read the same switches the same way (`hooks/lib/settings.js`), honour the same
//! skip file (`hooks/skip-guard.js`), build the same message layout (`hooks/lib/block-message.js`), keep the same kind of
//! per-session state (through [`state::SessionState`], files shared with the Node guards) and use JavaScript regexes whose
//! semantics differ from Rust's in a few places ([`jsre`]). Each of those is written once here and tested against the
//! Node original, so a guard module holds only its own decision logic.
pub mod filelock;
pub mod fsio;
pub mod jsre;
pub mod jsval;
pub mod nodelock;
pub mod msg;
pub mod ojson;
pub mod paths;
pub mod settings;
pub mod state;
pub mod tail;
pub mod text;
pub mod turn_gate;

#[cfg(test)]
mod tests;
