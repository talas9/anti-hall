//! Handover persistence: `precompact-snapshot` (PreCompact) writes a mechanical snapshot before compaction and
//! `handover-resume` (SessionStart) points the next session at the newest handover. Ported from the Node hooks of the same
//! names; both find handovers through [`find`], the port of `hooks/lib/handover-find.js`.
pub mod find;
pub mod precompact;
pub mod resume;
pub mod transcript;

#[cfg(test)]
mod tests;
