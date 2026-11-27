//! anti-hall engine: a tiny hook daemon + client. See README.md.
#![deny(missing_docs)]
#![cfg_attr(not(test), deny(clippy::panic, clippy::unreachable))]
#![cfg_attr(test, allow(clippy::panic, clippy::unreachable))]
// D12 stages indexing/slicing with a ratchet test while request-path sites are converted.
#![allow(clippy::indexing_slicing)]
#![recursion_limit = "256"]
#![allow(rustdoc::broken_intra_doc_links, rustdoc::private_intra_doc_links, rustdoc::invalid_html_tags, rustdoc::redundant_explicit_links)]
pub mod actlog;
pub mod agents;
pub mod atomic;
pub mod audit;
pub mod backup;
pub mod binguard;
pub mod bootstrap;
pub mod budget;
pub mod buildid;
pub mod burst;
pub mod burstsym;
pub mod cfgstore;
pub mod checks;
pub mod cli;
pub mod client;
pub mod compat;
pub mod config;
pub mod crash;
pub mod currency;
pub mod daemon;
pub mod daemonenv;
pub mod db;
pub mod deadline;
pub mod debug;
pub mod defaults;
pub mod delivery;
pub mod devswarm_rt;
#[cfg(feature = "diag")]
pub mod diag;
pub mod discard;
pub mod dispatch;
pub mod docs;
pub mod doctor;
pub mod dsact;
pub mod dssup;
pub mod dswire;
pub mod error;
pub mod failopen;
pub mod frame;
pub mod funnel;
pub mod gate;
pub mod ghrt;
pub mod gitcache;
pub mod handovers;
pub mod hcguard;
pub mod health;
pub mod hookcfg;
pub mod hookio;
pub mod hooksgen;
pub mod impact;
pub mod install;
pub mod jev;
pub mod judge;
pub mod layers;
pub mod learn;
pub mod limits;
pub mod load;
pub mod loadscale;
pub mod maintain;
pub mod mem;
pub mod memdiag;
pub mod memstat;
pub mod mesh;
pub mod meshw;
pub mod metrics;
pub mod migrate;
pub mod migration;
pub mod nodeback;
pub mod obs;
pub mod operator;
pub mod ops;
pub mod paths;
pub mod proc;
pub mod procid;
/// Process watch: orphan sweep, resource and disk warnings.
pub mod procwatch;
pub mod qos;
pub mod refresh;
pub mod reqenv;
pub mod roles;
pub mod rules;
pub mod schedule;
pub mod script;
pub mod setup;
pub mod skillgen;
pub mod spool;
pub mod sql;
pub mod sqlalloc;
pub mod storage;
pub mod store;
pub mod telemetry;
pub mod threads;
pub mod tier;
pub mod tmpsweep;
pub mod transcript;
pub mod wakew;
pub mod watch;
pub mod web;
pub mod webcli;
pub mod wire;

/// Version this build reports and compares for handoff. The `version` env override (plugin
/// version in production, arbitrary in tests).
pub fn version() -> String {
    defaults::env_var("version").unwrap_or_else(|| build_version().to_string())
}

/// What this build can do that an updater must know before it hands work to it (`version --json` lists them): a build fact, not a setting.
/// `install-routine`: `update --from-local <dir>` / `update --rollback` are the ONE install routine.
pub const FEATURES: &[&str] = &["install-routine"];

/// The build version the binary's `main` hands over ([`set_build_version`]). The library never reads `AH_BUILD_VERSION` itself:
/// that compile-time variable changes on every commit and checkout, and a library that read it missed the compile cache on each
/// one. Now the library stays a cache hit across commits. The package's test and binary targets are still rebuilt on a commit
/// (the build script reruns, and cargo then rebuilds every target of the package; test and binary crates are not cacheable).
static BUILD_VERSION: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

/// Record the version this binary was built as (`env!("AH_BUILD_VERSION")` in `main`). The first call wins; a later call is ignored.
pub fn set_build_version(v: &'static str) {
    // already set by an earlier call: the first version stays (one binary, one build version)
    discard::harmless(BUILD_VERSION.set(v));
}

/// The version this binary was built as: `<crate version>+<branch>.<short sha>[-dirty]`, derived by `build.rs` and set by `main`
/// ([`set_build_version`]). Without it (the library's own tests, a caller that is not the `ah-engine` binary) it is the crate's own
/// version.
pub fn build_version() -> &'static str {
    BUILD_VERSION.get().copied().unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// Numeric dotted-version compare ("0.10.0" > "0.9.0"); non-numeric parts count as 0, a pre-release
/// suffix ("1.0.0-rc1") is ignored.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(v: &str) -> Vec<u64> {
        v.trim_start_matches('v').split('+').next().unwrap_or("").split('-').next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
    }
    let (mut x, mut y) = (parts(a), parts(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    x.cmp(&y)
}

/// Whether `v` is a component version (engine, hook client, web server) from the OLD numbering, where those binaries carried the
/// plugin's number: at or above `launcher.legacy_scheme_floor`. The floor comes from the plugin's TOML; an empty floor means none.
pub fn legacy_scheme(v: &str) -> bool {
    legacy_with(defaults::text("launcher.legacy_scheme_floor"), v)
}

fn legacy_with(floor: &str, v: &str) -> bool {
    !floor.is_empty() && version_cmp(v, floor) != std::cmp::Ordering::Less
}

/// Compare two COMPONENT versions: like [`version_cmp`], except an old-numbering version counts as older than any version below the
/// floor. The ONE comparison for engine/hook/web versions; plugin versions use [`version_cmp`].
pub fn component_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    component_with(defaults::text("launcher.legacy_scheme_floor"), a, b)
}

fn component_with(floor: &str, a: &str, b: &str) -> std::cmp::Ordering {
    match (legacy_with(floor, a), legacy_with(floor, b)) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => version_cmp(a, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;
    #[test]
    fn legacy_versions_are_older_than_per_component_ones() {
        assert_eq!(component_with("0.300.0", "0.301.1+v301-x.abc12345", "0.2.0"), Less);
        assert_eq!(component_with("0.300.0", "0.2.0", "0.300.1"), Greater);
        assert_eq!(component_with("0.300.0", "0.301.1", "0.300.1"), Greater);
        assert_eq!(component_with("0.300.0", "0.2.0", "0.1.0"), Greater);
        assert_eq!(component_with("", "0.301.1", "0.2.0"), Greater);
    }
    #[test]
    fn version_ordering() {
        assert_eq!(version_cmp("0.10.0", "0.9.0"), Greater);
        assert_eq!(version_cmp("1.0", "1.0.0"), Equal);
        assert_eq!(version_cmp("v0.1.0", "0.2.0"), Less);
        assert_eq!(version_cmp("1.0.0-rc1", "1.0.0"), Equal);
    }
}

#[cfg(test)]
#[path = "../tests/common/testtmp.rs"]
pub(crate) mod testtmp;
