//! anti-hall engine: a tiny hook daemon + client. See README.md.
pub mod client;
pub mod config;
pub mod daemon;
pub mod frame;
pub mod health;
pub mod hookio;
pub mod limits;
pub mod paths;
pub mod rules;
pub mod store;

/// Version this build reports and compares for handoff. `ANTIHALL_ENGINE_VERSION` overrides it (plugin
/// version in production, arbitrary in tests).
pub fn version() -> String {
    std::env::var("ANTIHALL_ENGINE_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
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
