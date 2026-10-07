//! The mechanics the drift-probe hooks share (`hooks/lib/drift-baseline.js`): the cache file under the home directory, its
//! freshness, the "already advised" key and the atomic rewrite, plus the semver reading the probes compare with.
//!
//! Every function mirrors its Node original and fails open the way it does: a cache that is absent, unreadable or of the
//! wrong shape reads as "stale", a failed write is swallowed.
use super::jval::{J, Parsed, parse};
use super::{js_parse_int, read_text};
use crate::checks::guardkit::text::js_trim;
use std::path::Path;

/// What reading a cache file gave.
#[derive(Debug, PartialEq)]
pub enum Cache {
    /// A readable object of the expected shape.
    Valid(J),
    /// Absent, unreadable, not JSON, or the wrong shape: Node treats it as stale.
    Stale,
    /// Text this parser may read differently from `JSON.parse`: the caller defers to Node.
    Unsure,
}

/// `readCache(file)` of `drift-baseline.js`: an object with a finite `checkedAt`. `extra` adds a shape rule of the
/// caller's own (version-alert also needs a string `latest`).
pub fn read_cache(file: &str, extra: impl Fn(&J) -> bool) -> Cache {
    let Some(text) = read_text(file) else { return Cache::Stale };
    match parse(&text) {
        Parsed::Ok(v) if v.is_obj() && v.get("checkedAt").and_then(J::finite).is_some() && extra(&v) => Cache::Valid(v),
        Parsed::Ok(_) | Parsed::Bad => Cache::Stale,
        Parsed::Unsure => Cache::Unsure,
    }
}

/// `isFresh(cache, now, ttl)`: the age must be non-negative, so a clock rolled back reads as stale.
pub fn is_fresh(cache: &J, now: f64, ttl_ms: f64) -> bool {
    cache.get("checkedAt").and_then(J::finite).is_some_and(|c| {
        let age = now - c;
        age >= 0.0 && age < ttl_ms
    })
}

/// `alreadyAdvisedKey(cache, key)`: `cache.lastAdvised` is an object holding exactly the keys of `key`, with values that
/// print alike. A missing or malformed `lastAdvised` never suppresses an advisory.
pub fn already_advised_key(cache: &J, key: &J) -> bool {
    let (Some(J::Obj(la)), J::Obj(k)) = (cache.get("lastAdvised"), key) else { return false };
    same_keys(la, k)
}

/// Two objects with the same keys (in any order) whose values print alike (`stableKeyString` equality).
pub fn same_keys(a: &[(String, J)], b: &[(String, J)]) -> bool {
    a.len() == b.len() && a.iter().all(|(k, v)| b.iter().any(|(bk, bv)| bk == k && bv.stringify() == v.stringify()))
}

/// `atomicWriteJSON(file, data)`: make the directory, write a temporary file beside it, rename over the target. An error
/// is returned to the caller (Node throws; each caller decides whether that is swallowed).
pub fn atomic_write(file: &str, data: &J) -> std::io::Result<()> {
    if let Some(dir) = Path::new(file).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = format!("{file}.tmp.{}", std::process::id());
    std::fs::write(&tmp, data.stringify())?;
    std::fs::rename(&tmp, file)
}

/// `persistAdvisedKey(file, cache, key)`: rewrite the cache with `lastAdvised` set to `key`; a failure is swallowed.
pub fn persist_advised_key(file: &str, cache: &J, key: J) {
    let mut next = cache.clone();
    next.set("lastAdvised", key);
    let _ = atomic_write(file, &next);
}

/// `parseSemver(v)`: `[major, minor, patch]` from `v?N.N(.N)?` (the patch defaults to 0); `None` for anything else or a
/// number too large to be finite.
pub fn parse_semver(v: &str) -> Option<[f64; 3]> {
    let t = js_trim(v);
    let t = t.strip_prefix('v').unwrap_or(t);
    let mut parts = t.split('.');
    let (a, b, c) = (parts.next()?, parts.next()?, parts.next());
    if parts.next().is_some() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.chars().all(|ch| ch.is_ascii_digit());
    if !digits(a) || !digits(b) || c.is_some_and(|c| !digits(c)) {
        return None;
    }
    let n = |s: &str| js_parse_int(s);
    let out = [n(a), n(b), c.map_or(0.0, n)];
    out.iter().all(|x| x.is_finite()).then_some(out)
}

/// Why a version pair does or does not advise.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Drift {
    /// Same major and minor, same text.
    Match,
    /// Same major and minor, different patch (or text).
    Patch,
    /// The installed major.minor is above the baseline.
    Newer,
    /// The installed major.minor is below the baseline.
    Older,
    /// Either side is not a version.
    Unparseable,
}

impl Drift {
    /// Whether this drift is advised (a major or minor difference either way).
    pub fn advise(self) -> bool {
        matches!(self, Drift::Newer | Drift::Older)
    }
}

/// `classifyVersionDrift(installed, baseline)`.
pub fn classify(installed: &str, baseline: &str) -> Drift {
    let (Some(a), Some(b)) = (parse_semver(installed), parse_semver(baseline)) else { return Drift::Unparseable };
    if a[0] == b[0] && a[1] == b[1] {
        return if installed == baseline { Drift::Match } else { Drift::Patch };
    }
    if a[0] > b[0] || (a[0] == b[0] && a[1] > b[1]) { Drift::Newer } else { Drift::Older }
}
