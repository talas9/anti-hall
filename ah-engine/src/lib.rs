//! anti-hall engine: a tiny hook daemon + client. See README.md.
#![deny(missing_docs)]
pub mod atomic;
pub mod backup;
pub mod bootstrap;
pub mod cfgstore;
pub mod checks;
pub mod cli;
pub mod client;
pub mod config;
pub mod daemon;
pub mod deadline;
pub mod db;
pub mod defaults;
#[cfg(feature = "diag")]
pub mod diag;
pub mod discard;
pub mod dispatch;
pub mod docs;
pub mod doctor;
pub mod error;
pub mod frame;
pub mod gate;
pub mod gitcache;
pub mod health;
pub mod hookcfg;
pub mod hookio;
pub mod hooksgen;
pub mod impact;
pub mod jev;
pub mod limits;
pub mod load;
pub mod maintain;
pub mod memstat;
pub mod mesh;
pub mod metrics;
pub mod migrate;
pub mod paths;
pub mod reqenv;
pub mod rules;
pub mod schedule;
pub mod setup;
pub mod spool;
pub mod sql;
pub mod storage;
pub mod store;
pub mod telemetry;
pub mod tier;
pub mod transcript;

/// Version this build reports and compares for handoff. The `version` env override (plugin
/// version in production, arbitrary in tests).
pub fn version() -> String {
    defaults::env_var("version").unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

/// Numeric dotted-version compare ("0.10.0" > "0.9.0"); non-numeric parts count as 0, a pre-release
/// suffix ("1.0.0-rc1") is ignored.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(v: &str) -> Vec<u64> {
        v.trim_start_matches('v').split('-').next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
    }
    let (mut x, mut y) = (parts(a), parts(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    x.cmp(&y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;
    #[test]
    fn version_ordering() {
        assert_eq!(version_cmp("0.10.0", "0.9.0"), Greater);
        assert_eq!(version_cmp("1.0", "1.0.0"), Equal);
        assert_eq!(version_cmp("v0.1.0", "0.2.0"), Less);
        assert_eq!(version_cmp("1.0.0-rc1", "1.0.0"), Equal);
    }
}
