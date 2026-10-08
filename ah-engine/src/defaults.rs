//! Shipped defaults (D17, amended): every tunable, table, message text, path, env-var name, limit and timeout lives in the
//! plugin's `engine/defaults/*.toml` and is read through this module AT RUN TIME. Nothing is compiled into the binary.
//!
//! File format: each setting is a table `[section.name]` with `value`, `doc` and optionally `env`, `min`, `max`
//! and `unit` (see the header of `engine.toml`). Why one table per setting: the docs generator, the
//! coverage tests and the config reload all enumerate settings, and a uniform shape makes every one of
//! them self-describing.
//!
//! # Where the data comes from
//!
//! The data is one immutable, validated snapshot behind an `Arc` that is swapped atomically (see [`load`]). The
//! accessors below keep their signatures (`&'static` values), so call sites do not care that the backend is a snapshot:
//! a value that changed in a reload is leaked once, an unchanged one is reused, and a request that already holds a value
//! sees the old or the new one entirely.
//!
//! * **daemon and tooling** (`serve`, `docs`, `gen-hooks`, tests) read and validate the plugin's files ([`init`]), the
//!   daemon watches them and swaps in a new snapshot on change ([`reload`]); an invalid edit keeps the last good one.
//! * **the thin hook client** reads the daemon's snapshot cache instead (`load::Lazy`), because parsing the 28 files per
//!   call nearly doubled its start-up (3.7 ms against 2.0 ms measured in D17); the measurement of this design is in
//!   DECISIONS.md.
//! * **no files, no cache** is an error ([`DefaultsError`]), never a silent default: the caller answers "unavailable"
//!   and the wrapper falls back to Node.
//!
//! Where the plugin root is found is documented in [`crate::bootstrap`].
mod load;
pub use load::{DefaultsError, Fingerprint, Healed, Layer, Note, Report, fingerprint, heal, heal_file, heal_line, in_checkout, load_from, write_lkg};
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unset or non-UTF-8 variable is an unset one
// A failure that must be seen goes through `crate::discard` instead.

use serde_json::{Value as Json, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

/// A default's value: the TOML types the defaults use, as static data.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum V {
    /// An integer.
    Int(i64),
    /// A boolean.
    Bool(bool),
    /// A string.
    Str(&'static str),
    /// A list.
    List(&'static [V]),
    /// A table, as (key, value) pairs in key order.
    Table(&'static [(&'static str, V)]),
}

impl V {
    /// The string, if this is one.
    pub fn as_str(&self) -> Option<&'static str> {
        match self {
            V::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The integer, if this is one.
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            V::Int(n) => Some(*n),
            _ => None,
        }
    }

    /// The boolean, if this is one.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            V::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The items, if this is a list.
    pub fn as_array(&self) -> Option<&'static [V]> {
        match self {
            V::List(a) => Some(a),
            _ => None,
        }
    }

    /// The pairs, if this is a table.
    pub fn as_table(&self) -> Option<&'static [(&'static str, V)]> {
        match self {
            V::Table(t) => Some(t),
            _ => None,
        }
    }

    /// The field `key` of a table.
    pub fn get(&self, key: &str) -> Option<&'static V> {
        self.as_table()?.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    /// A string field of a table (empty when missing or not a string).
    pub fn str_field(&self, key: &str) -> &'static str {
        self.get(key).and_then(V::as_str).unwrap_or("")
    }

    /// The strings of a list (non-strings skipped).
    pub fn strings(&self) -> Vec<&'static str> {
        self.as_array().map(|a| a.iter().filter_map(V::as_str).collect()).unwrap_or_default()
    }

    /// The value as JSON, for `--json` output.
    pub fn to_json(&self) -> Json {
        match self {
            V::Int(n) => json!(n),
            V::Bool(b) => json!(b),
            V::Str(s) => json!(s),
            V::List(a) => Json::Array(a.iter().map(V::to_json).collect()),
            V::Table(t) => Json::Object(t.iter().map(|(k, v)| (k.to_string(), v.to_json())).collect()),
        }
    }
}

/// One setting as shipped.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    /// `section.name`.
    pub key: &'static str,
    /// File the entry ships in.
    pub file: &'static str,
    /// The default value.
    pub value: V,
    /// One-sentence description.
    pub doc: &'static str,
    /// Environment variable that overrides a numeric value, if any.
    pub env: Option<&'static str>,
    /// Lower clamp for a numeric value.
    pub min: Option<i64>,
    /// Upper clamp for a numeric value.
    pub max: Option<i64>,
    /// Unit of a numeric value (documentation only).
    pub unit: Option<&'static str>,
}

/// The value type a source read of a setting expects (collected by `build.rs`, see `build_support/keyscan.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Any type: the key must exist.
    Any,
    /// An integer.
    Int,
    /// A string.
    Str,
    /// A list.
    List,
}

/// The keys this build reads, with the type each read expects: a plugin whose defaults lack one, or give it another
/// type, is rejected at load.
pub fn required() -> &'static [(&'static str, Kind)] {
    generated::REQUIRED
}

mod generated {
    //! The keys this build reads (collected from the source by `build.rs`): a plugin whose defaults lack one is rejected at load.
    include!(concat!(env!("OUT_DIR"), "/required_keys.rs"));
}

enum Backend {
    Full(load::Data),
    Lazy(load::Lazy),
}

static CUR: RwLock<Option<Arc<Backend>>> = RwLock::new(None);
static CLIENT: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CACHE_WRITES: AtomicBool = AtomicBool::new(false);

/// Make [`init`] read the daemon's snapshot cache (the thin hook client) instead of parsing the plugin's files. Call before
/// the first read.
pub fn use_cache() {
    CLIENT.store(true, Ordering::SeqCst);
}

/// Let loads write the snapshot cache (the daemon, and a client that had to parse the files itself). Off by default so
/// in-process tests and one-off commands never touch the state directory.
pub fn write_cache_on_load() {
    CACHE_WRITES.store(true, Ordering::SeqCst);
}

fn current() -> Option<Arc<Backend>> {
    CUR.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn cache_best_effort(d: &load::Data) {
    if CACHE_WRITES.load(Ordering::SeqCst)
        && let Some(p) = crate::bootstrap::cache_path()
    {
        crate::discard::harmless(load::write_cache(d, &p)); // keep: the cache only speeds up the thin client; the next load rewrites it
    }
}

/// What follows a load that may write (the daemon, a client that parsed the files): log its fallbacks, keep the
/// last-known-good copy. In-process tests and one-off commands write nothing.
fn after_load(report: &load::Report, root: &Path) {
    if CACHE_WRITES.load(Ordering::SeqCst) {
        load::after(report, root);
    }
}

/// Load the defaults if nothing is loaded yet. Idempotent. In cache mode ([`use_cache`]) this reads the snapshot cache and
/// parses the plugin's files only when the cache is missing or belongs to another plugin root.
pub fn init() -> Result<(), DefaultsError> {
    if current().is_some() {
        return Ok(());
    }
    let cache = crate::bootstrap::cache_path();
    if CLIENT.load(Ordering::SeqCst) {
        let want = crate::bootstrap::env_root();
        if let Some(lazy) = cache.as_deref().and_then(|c| load::Lazy::open(c, want.as_deref())) {
            let mut w = CUR.write().unwrap_or_else(|e| e.into_inner());
            w.get_or_insert_with(|| Arc::new(Backend::Lazy(lazy)));
            return Ok(());
        }
    }
    let cached = cache.as_deref().and_then(load::cache_root);
    let root = crate::bootstrap::locate_root(cached.as_deref()).ok_or_else(|| DefaultsError {
        code: "no_root",
        file: String::new(),
        key: String::new(),
        detail: "no plugin root with engine/defaults/index.toml (see bootstrap)".into(),
    })?;
    let data = load::load(&root, None)?;
    cache_best_effort(&data);
    let (report, root) = (data.report.clone(), data.root().to_path_buf());
    {
        let mut w = CUR.write().unwrap_or_else(|e| e.into_inner());
        w.get_or_insert_with(|| Arc::new(Backend::Full(data)));
    }
    GENERATION.fetch_add(1, Ordering::SeqCst);
    after_load(&report, &root);
    Ok(())
}

/// A value derived from the defaults (a compiled regex, a parsed table) that stays valid until the defaults change. It is
/// rebuilt on first use after each applied reload and the previous one is leaked, which is bounded by the number of reloads
/// (a plugin update or an edit of a defaults file). Reads take a shared lock only.
pub struct Cache<T: 'static> {
    slot: RwLock<Option<(u64, &'static T)>>,
}

impl<T: 'static> Cache<T> {
    /// An empty cache.
    pub const fn new() -> Cache<T> {
        Cache { slot: RwLock::new(None) }
    }

    /// The value built by `build` for the current defaults.
    pub fn get_or_init(&self, build: impl FnOnce() -> T) -> &'static T {
        let generation = generation();
        if let Some((g, v)) = *self.slot.read().unwrap_or_else(|e| e.into_inner())
            && g == generation
        {
            return v;
        }
        let mut w = self.slot.write().unwrap_or_else(|e| e.into_inner());
        if let Some((g, v)) = *w
            && g == generation
        {
            return v;
        }
        let v: &'static T = Box::leak(Box::new(build()));
        *w = Some((generation, v));
        v
    }
}

impl<T: 'static> Default for Cache<T> {
    fn default() -> Self {
        Cache::new()
    }
}

/// What a [`reload`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Reloaded {
    /// A new snapshot is active.
    Applied,
    /// The files read the same as the active snapshot.
    Unchanged,
}

/// Read the plugin at `root` (the active root when `None`) and swap it in when it validates and differs from the active
/// snapshot. On any error the active snapshot stays. Only a full (daemon / tooling) snapshot can be reloaded.
pub fn reload(root: Option<&Path>) -> Result<Reloaded, DefaultsError> {
    let prev = current();
    let prev_data = match prev.as_deref() {
        Some(Backend::Full(d)) => Some(d),
        _ => None,
    };
    let root = root.map(Path::to_path_buf).or_else(|| prev_data.map(|d| d.root().to_path_buf())).ok_or_else(|| DefaultsError {
        code: "no_root",
        file: String::new(),
        key: String::new(),
        detail: "nothing to reload".into(),
    })?;
    let data = load::load(&root, prev_data)?;
    if let Some(p) = prev_data
        && p.root() == data.root()
        && p.entries.len() == data.entries.len()
        && p.entries.iter().zip(data.entries).all(|(a, b)| std::ptr::eq(*a, *b))
    {
        // the same values, but possibly from another layer (a broken edit answered by its last-known-good copy): say so
        after_load(&data.report, data.root());
        return Ok(Reloaded::Unchanged);
    }
    cache_best_effort(&data);
    let (report, root) = (data.report.clone(), data.root().to_path_buf());
    *CUR.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(Backend::Full(data)));
    GENERATION.fetch_add(1, Ordering::SeqCst);
    after_load(&report, &root);
    Ok(Reloaded::Applied)
}

/// Counts up by one per applied snapshot in this process.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// The plugin root the active snapshot was read from.
pub fn root() -> Option<PathBuf> {
    match current()?.as_ref() {
        Backend::Full(d) => Some(d.root().to_path_buf()),
        Backend::Lazy(l) => Some(l.root().to_path_buf()),
    }
}

/// Note a failed load where it can be found (see `load::report_unavailable`).
pub fn report_unavailable(e: &DefaultsError) {
    load::report_unavailable(e);
}

/// Log a daemon that could not start for want of defaults as a crash (see `load::log_start_failure`).
pub fn log_start_failure(e: &DefaultsError) {
    load::log_start_failure(e);
}

/// The snapshot, loading it on first use. Panics (a bug) when nothing can be loaded: entry points call [`init`] first and
/// answer "unavailable" instead of getting here.
fn backend() -> Arc<Backend> {
    if let Some(b) = current() {
        return b;
    }
    if let Err(e) = init() {
        panic!("shipped defaults unavailable: {e}");
    }
    current().unwrap_or_else(|| panic!("init() installed a snapshot"))
}

/// The entry for `key`, if shipped.
fn find(key: &str) -> Option<&'static Entry> {
    match backend().as_ref() {
        Backend::Full(d) => d.find(key),
        Backend::Lazy(l) => l.find(key),
    }
}

fn entry(key: &str) -> &'static Entry {
    find(key).unwrap_or_else(|| panic!("defaults key {key:?} is not shipped (a source reference the `defaults` tests should have caught)"))
}

/// The entry for `key`, if shipped (without panicking).
pub fn get(key: &str) -> Option<&'static Entry> {
    find(key)
}

/// True when `key` is shipped (without panicking, unlike the typed getters).
pub fn has(key: &str) -> bool {
    find(key).is_some()
}

/// The raw default value of `key`.
pub fn raw(key: &str) -> &'static V {
    &entry(key).value
}

/// A numeric setting: the default, overridden by its `env` variable when that holds a number, then clamped to
/// its `min`/`max`.
pub fn num(key: &str) -> u64 {
    let e = entry(key);
    let default = e.value.as_integer().unwrap_or_else(|| panic!("defaults key {key:?} is not an integer")).max(0) as u64;
    let mut v = e.env.and_then(|n| std::env::var(n).ok()).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(default);
    if let Some(min) = e.min {
        v = v.max(min.max(0) as u64);
    }
    if let Some(max) = e.max {
        v = v.min(max.max(0) as u64);
    }
    v
}

/// A numeric setting expressed in milliseconds, as a `Duration`.
pub fn millis(key: &str) -> std::time::Duration {
    std::time::Duration::from_millis(num(key))
}

/// A numeric setting expressed in seconds, as a `Duration`.
pub fn secs(key: &str) -> std::time::Duration {
    std::time::Duration::from_secs(num(key))
}

/// A string setting.
pub fn text(key: &str) -> &'static str {
    raw(key).as_str().unwrap_or_else(|| panic!("defaults key {key:?} is not a string"))
}

/// A list-of-strings setting.
pub fn list(key: &str) -> Vec<&'static str> {
    raw(key).as_array().unwrap_or_else(|| panic!("defaults key {key:?} is not a list")).iter().filter_map(V::as_str).collect()
}

/// A string setting split on whitespace (compact option-name sets).
pub fn words(key: &str) -> Vec<&'static str> {
    text(key).split_whitespace().collect()
}

/// A message with `{name}` placeholders replaced by `args`. Unknown placeholders are left as written.
pub fn render(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    fill(text(key), args)
}

/// Replace `{name}` in `template` with the matching value of `args`.
pub fn fill(template: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), &value.to_string());
    }
    out
}

/// The environment variable that overrides the numeric setting `key`, if it has one.
pub fn env_of(key: &str) -> Option<&'static str> {
    entry(key).env
}

/// The name of the environment variable shipped as `env.<name>`.
pub fn env_name(name: &str) -> &'static str {
    text(&format!("env.{name}"))
}

/// Read the environment variable shipped as `env.<name>`.
pub fn env_var(name: &str) -> Option<String> {
    std::env::var(env_name(name)).ok()
}

/// The settings whose key starts with `prefix`, without reading the rest (the thin client asks for `cmd.` and `dispatch.hooks_`).
pub fn with_prefix(prefix: &str) -> Vec<&'static Entry> {
    match backend().as_ref() {
        Backend::Full(d) => d.entries.iter().copied().filter(|e| e.key.starts_with(prefix)).collect(),
        Backend::Lazy(l) => l.with_prefix(prefix),
    }
}

/// Every shipped setting, in file order (sorted by key within a file). A cache-backed snapshot has no docs and lists by key.
pub fn all() -> &'static [&'static Entry] {
    match backend().as_ref() {
        Backend::Full(d) => d.entries,
        Backend::Lazy(l) => l.all(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_has_a_value_and_a_sentence_doc() {
        assert!(all().len() > 100, "defaults are not being enumerated: {}", all().len());
        for e in all() {
            assert!(e.doc.trim().ends_with('.'), "{} doc should be a sentence ending in a period: {:?}", e.key, e.doc);
            assert!(has(e.key));
        }
    }

    #[test]
    fn keys_are_unique_and_the_index_is_sorted() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            assert!(seen.insert(e.key), "duplicate setting {}", e.key);
        }
        for e in all() {
            assert!(find(e.key).is_some_and(|f| std::ptr::eq(f, find(e.key).unwrap())), "{} is not findable by key", e.key);
        }
    }

    #[test]
    fn env_names_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            if let Some(n) = e.env {
                assert!(n.starts_with("AH_ENGINE_"), "{} env {n} lacks the AH_ENGINE_ prefix", e.key);
                assert!(seen.insert(n), "env var {n} is used twice");
            }
        }
    }

    #[test]
    #[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation; the single-thread audit is the FIXME beside each call
    fn numeric_clamps_hold_and_env_overrides_apply() {
        assert_eq!(num("daemon.workers"), 4);
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("AH_ENGINE_QUEUE", "999999") };
        assert_eq!(num("daemon.queue"), 1024, "clamped to max");
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("AH_ENGINE_QUEUE", "junk") };
        assert_eq!(num("daemon.queue"), 16, "unparseable falls back to the default");
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::remove_var("AH_ENGINE_QUEUE") };
    }

    #[test]
    fn render_fills_placeholders() {
        assert_eq!(fill("a {x} b {y}", &[("x", &"1"), ("y", &"2")]), "a 1 b 2");
        assert_eq!(fill("{missing}", &[("x", &"1")]), "{missing}");
    }

    #[test]
    fn values_convert_to_json() {
        assert_eq!(raw("health.crashy_kinds").to_json()[0], "crash");
        assert_eq!(raw("impact.block").get("counted").and_then(V::as_str), Some("exact"));
    }
}
