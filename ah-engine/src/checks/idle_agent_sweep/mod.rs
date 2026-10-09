//! The transcript replays the `idle-agent-sweep` script reads through `ah.transcript.teammates` and `ah.transcript.codexAgents`
//! (D88): which named in-process teammates (Claude, [`scan`]) or `multi_agent_v1` agents (Codex rollout, [`codex`]) a transcript
//! tail shows finished but never stopped or closed. They hold no threshold, text or rule: the script decides when to speak and
//! what to say (`engine/logic/idle-agent-sweep.js`).
//!
//! A transcript line that holds a marker but that neither JSON parser accepts, a timestamp that is not the strict ISO form, or a
//! relative transcript path is [`Defer`]: JavaScript might read it and decide differently, so the primitive answers `unsure`.
#[cfg(test)]
use crate::checks::emit_dedupe::Defer;

pub mod codex;
pub mod scan;

#[cfg(test)]
mod tests;
