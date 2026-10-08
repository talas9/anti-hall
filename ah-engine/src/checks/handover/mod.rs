//! Handover persistence: `handover-resume` (SessionStart) points the next session at the newest handover, found through
//! [`find`], the port of `hooks/lib/handover-find.js`. `precompact-snapshot` (PreCompact) is a plugin script now
//! (`engine/logic/precompact-snapshot.js`).
pub mod find;

#[cfg(test)]
mod tests;
