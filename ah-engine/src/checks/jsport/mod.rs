//! JavaScript semantics the Node hooks of the handover and Codex lane depend on, written once.
//!
//! The ported hooks (`handover-resume`, `precompact-snapshot`, `codex-availability`, `codex-quota-detect`, `codex-nudge`)
//! format numbers with `String(n)`, parse with `JSON.parse`, order object keys by insertion, format dates with
//! `toISOString`, parse dates with `Date.parse`, and compare strings by UTF-16 unit. Rust differs on each, so each
//! difference is handled here and tested against Node. Anything this module cannot reproduce exactly it reports as
//! unknown, and the check then defers to the Node hook (D74: never a worse guard than Node).
pub mod date;
pub mod fsx;
pub mod gitrun;
pub mod home;
pub mod ident;
pub mod json;
pub mod num;
pub mod text;

#[cfg(test)]
pub(crate) mod testkit;
#[cfg(test)]
mod tests;
