//! "No Node installed" acceptance harness (v1.0 Node-free plan, lane L01). Each test builds a fresh scratch HOME with the
//! engine installed where the wrappers find it, a copy of the plugin, and a PATH with no Node on it but a recording `node`
//! shim first; then it drives one surface the way the host or the OS does (every hook event of both hosts, every command
//! line of the skills and agents, the status line, the monitors, the daemon) and records every `node` start.
//!
//! `expected_failures.toml` is the live backlog of Node paths: a Node start that is not listed fails, and so does a listed
//! path that is no longer reached, so each lane that removes a Node path deletes its entry. v1.0 needs the list empty.
//! Reports (per test, JSON) land in `$CARGO_TARGET_TMPDIR/no_node/`. Run: `cargo nextest run --test no_node`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

#[path = "../common/mod.rs"]
mod common;

mod callsites;
mod expected;
mod harness;
mod hooks;
mod surfaces;
