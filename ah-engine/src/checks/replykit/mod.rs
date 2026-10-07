//! Shared parts of the response-correctness guards (`speculation-guard`, `speculation-judge`, `claim-ledger`,
//! `output-verify-guard`): JavaScript-faithful JSON, transcript reading, the once-per-turn gate and the file helpers.
//!
//! Every function here mirrors a Node idiom and says which. The rule for anything the engine cannot reproduce exactly
//! is [`Defer`]: the caller answers with a deferral and the client runs the Node hook, so a doubtful case is never a
//! silent allow and never a guess (D11, D74).
pub mod io;
pub mod json;
pub mod transcript;
pub mod turn_gate;

/// The engine cannot reproduce what the Node hook would do here; the Node hook decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Defer;
