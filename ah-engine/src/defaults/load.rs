//! Reading, validating and caching the shipped defaults at run time (D17, amended).
//!
//! The plugin ships `engine/defaults/index.toml` and the files it names. [`load`] reads and validates them with the checks
//! `build.rs` used to apply at compile time (a malformed, undocumented or duplicated entry is an error with a reason
//! code), then builds one immutable [`Data`]. Entries that did not change since the previous load are reused, so a reload
//! leaks only what changed (the values are `'static` so every call site keeps its signature).
//!
//! # The snapshot cache
//!
//! Parsing 28 TOML files per hook call would double the thin client's start-up (measured in D17), so a loaded `Data` is
//! also written to ONE small file in the state directory ([`write_cache`]), regenerated on every successful load. The
//! client reads that file instead ([`Lazy`]): one `read`, an index of its lines, and a JSON parse of only the keys a
//! call actually asks for. The cache is derived data, never configuration: delete it and the next load rebuilds it.
use super::{Entry, Kind, V};
use crate::bootstrap;
use crate::dispatch::table;
use serde_json::Value as Json;
use std::collections::HashMap;
use std::fmt;
use std::io::Write as _;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Why the defaults could not be loaded. `code` is stable and short; the other fields say where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultsError {
    /// Reason code (`no_root`, `io`, `parse`, `index`, `entry`, `doc`, `value`, `field`, `unsupported`, `duplicate`, `missing_key`, `hooks`, `dispatch`, `type`, `range`).
    pub code: &'static str,
    /// The file the problem is in (relative to the defaults directory), if any.
    pub file: String,
    /// The setting the problem is in, if any.
    pub key: String,
    /// The parser's or validator's detail.
    pub detail: String,
}

impl DefaultsError {
    fn new(code: &'static str, file: &str, key: &str, detail: impl fmt::Display) -> DefaultsError {
        DefaultsError { code, file: file.to_string(), key: key.to_string(), detail: detail.to_string() }
    }
}

impl fmt::Display for DefaultsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} file={} key={} detail={}", self.code, self.file, self.key, self.detail)
    }
}

impl std::error::Error for DefaultsError {}

/// Every shipped setting of one plugin, validated.
pub struct Data {
    pub(super) root: PathBuf,
    /// In file order (keys sorted within a file).
    pub(super) entries: &'static [&'static Entry],
    /// Sorted by key, for binary search.
    pub(super) index: Vec<(&'static str, &'static Entry)>,
    /// Canonical text of each entry's source table, to tell a changed entry from an unchanged one at the next load.
    canon: HashMap<&'static str, String>,
    /// What the load fell back on, what to heal and what to keep as last-known-good.
    pub(super) report: Report,
}

impl Data {
    /// The plugin root these defaults were read from.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// What the load fell back on and what it found missing.
    pub fn report(&self) -> &Report {
        &self.report
    }

    pub(super) fn find(&self, key: &str) -> Option<&'static Entry> {
        let i = self.index.binary_search_by(|(k, _)| (*k).cmp(key)).ok()?;
        Some(self.index[i].1)
    }
}

fn leak_str(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn to_v(v: &toml::Value) -> Option<V> {
    Some(match v {
        toml::Value::Integer(n) => V::Int(*n),
        toml::Value::Boolean(b) => V::Bool(*b),
        toml::Value::String(s) => V::Str(leak_str(s)),
        toml::Value::Array(a) => V::List(Box::leak(a.iter().map(to_v).collect::<Option<Vec<_>>>()?.into_boxed_slice())),
        toml::Value::Table(t) => V::Table(Box::leak(t.iter().map(|(k, x)| Some((leak_str(k), to_v(x)?))).collect::<Option<Vec<_>>>()?.into_boxed_slice())),
        _ => return None,
    })
}

fn json_to_v(v: &Json) -> Option<V> {
    Some(match v {
        Json::Number(n) => V::Int(n.as_i64()?),
        Json::Bool(b) => V::Bool(*b),
        Json::String(s) => V::Str(leak_str(s)),
        Json::Array(a) => V::List(Box::leak(a.iter().map(json_to_v).collect::<Option<Vec<_>>>()?.into_boxed_slice())),
        Json::Object(t) => V::Table(Box::leak(t.iter().map(|(k, x)| Some((leak_str(k), json_to_v(x)?))).collect::<Option<Vec<_>>>()?.into_boxed_slice())),
        Json::Null => return None,
    })
}

fn read(path: &Path, name: &str) -> Result<String, DefaultsError> {
    std::fs::read_to_string(path).map_err(|e| DefaultsError::new("io", name, "", format!("{}: {e}", path.display())))
}

/// The files of the plugin at `root`, in listing order: the index's `files`, then the `*.toml` of its `extra_dir` by name.
fn file_list(dir: &Path) -> Result<Vec<String>, DefaultsError> {
    let index = bootstrap::INDEX_FILE;
    let table: toml::Table = read(&dir.join(index), index)?.parse().map_err(|e: toml::de::Error| DefaultsError::new("parse", index, "", e))?;
    let safe = |n: &str| Path::new(n).components().all(|c| matches!(c, Component::Normal(_)));
    let mut files = Vec::new();
    for f in
        table.get("files").and_then(toml::Value::as_array).ok_or_else(|| DefaultsError::new("index", index, "files", "`files` must be a list of file names"))?
    {
        let n = f
            .as_str()
            .filter(|n| safe(n) && n.ends_with(".toml"))
            .ok_or_else(|| DefaultsError::new("index", index, "files", format!("bad file name {f:?}")))?;
        files.push(n.to_string());
    }
    if let Some(extra) = table.get("extra_dir") {
        let d = extra
            .as_str()
            .filter(|d| safe(d))
            .ok_or_else(|| DefaultsError::new("index", index, "extra_dir", "`extra_dir` must be a relative directory name"))?;
        if let Ok(rd) = std::fs::read_dir(dir.join(d)) {
            let mut more: Vec<String> =
                rd.flatten().filter_map(|e| e.file_name().to_str().filter(|n| n.ends_with(".toml")).map(|n| format!("{d}/{n}"))).collect();
            more.sort();
            files.extend(more);
        }
    }
    Ok(files)
}

const FIELDS: [&str; 6] = ["value", "doc", "env", "min", "max", "unit"];

/// The checks of one setting's fields beyond their presence: `env` and `unit` are strings; `min` and `max` are integers, in
/// order, bound an integer value and hold it; a setting with `env` (a numeric override) is an integer; and the value has the type the source reads it as (`kind`, from
/// [`super::required`]). A value of the wrong type would make its reader panic; a panic in a guard event used to block.
fn check_entry(file: &str, key: &str, e: &toml::Table, kind: Option<Kind>) -> Result<(), DefaultsError> {
    for f in ["env", "unit"] {
        if e.get(f).is_some_and(|x| !x.is_str()) {
            return Err(DefaultsError::new("field", file, key, format!("`{f}` must be a string")));
        }
    }
    let bound = |f: &str| match e.get(f) {
        None => Ok(None),
        Some(toml::Value::Integer(n)) => Ok(Some(*n)),
        Some(_) => Err(DefaultsError::new("range", file, key, format!("`{f}` must be an integer"))),
    };
    let (min, max) = (bound("min")?, bound("max")?);
    let value = e.get("value");
    if let (Some(a), Some(b)) = (min, max)
        && a > b
    {
        return Err(DefaultsError::new("range", file, key, format!("min {a} is above max {b}")));
    }
    if e.contains_key("env") && !value.is_some_and(toml::Value::is_integer) {
        return Err(DefaultsError::new("type", file, key, "a setting with `env` is numeric: its value must be an integer"));
    }
    if min.is_some() || max.is_some() {
        let Some(n) = value.and_then(toml::Value::as_integer) else {
            return Err(DefaultsError::new("range", file, key, "`min` and `max` bound an integer value only"));
        };
        if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
            return Err(DefaultsError::new("range", file, key, format!("value {n} is outside min {min:?} .. max {max:?}")));
        }
    }
    let ok = match kind {
        None | Some(Kind::Any) => true,
        Some(Kind::Int) => value.is_some_and(toml::Value::is_integer),
        Some(Kind::Str) => value.is_some_and(toml::Value::is_str),
        Some(Kind::List) => value.is_some_and(toml::Value::is_array),
    };
    if !ok {
        return Err(DefaultsError::new("type", file, key, format!("the engine reads this setting as {kind:?}")));
    }
    Ok(())
}

// ---- layered resolution (failover) ---------------------------------------------------------------------------------------
//
// Three sources of the same files, tried in order and each through the same full validation:
//   1. edited    the plugin's `engine/defaults/` (what the owner edits)
//   2. lkg       the last-known-good copy in the state directory: every edited file that last validated in full, written
//                after each successful load; used only when its stamp (engine version, plugin root, plugin version) matches
//   3. pristine  the plugin's read-only `engine/defaults.pristine/`, byte-identical to the shipped defaults
// Resolution is per file and per setting: a file that does not parse falls back as a whole, a setting that fails validation
// falls back alone, and a setting the edited files lack is taken from the pristine copy (and reported for healing). When the
// assembled set still fails a cross-file check (a duplicate, a required key, the hooks or the dispatch table), the whole
// last-known-good copy is tried, then the whole pristine copy. Only when all fail is the load an error (exit 75: Node runs).

/// A source of defaults files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Layer {
    /// The plugin's editable `engine/defaults/`.
    Edited,
    /// The last-known-good copy in the state directory.
    Lkg,
    /// The plugin's pristine copy.
    Pristine,
}

impl Layer {
    /// The stable code of the layer, for the event log.
    pub fn code(self) -> &'static str {
        match self {
            Layer::Edited => "edited",
            Layer::Lkg => "lkg",
            Layer::Pristine => "pristine",
        }
    }
}

/// One fallback a load took: what was rejected and which layer answered instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    /// The rejection's reason code (a [`DefaultsError`] code).
    pub code: &'static str,
    /// The file, relative to the defaults directory.
    pub file: String,
    /// The setting (empty for a whole file or the whole set).
    pub key: String,
    /// The layer that answered.
    pub layer: Layer,
    /// The validator's detail.
    pub detail: String,
}

/// What a load did besides producing values: the fallbacks, the settings to heal, and the files to keep as last-known-good.
#[derive(Debug, Clone, Default)]
pub struct Report {
    /// Every fallback, in order.
    pub notes: Vec<Note>,
    /// Per edited file, the settings it lacks that the pristine copy has.
    pub missing: std::collections::BTreeMap<String, Vec<String>>,
    /// The edited files that validated in full, with their text.
    pub clean: Vec<(String, String)>,
    /// The stamp the last-known-good copy is written under.
    pub stamp: String,
}

/// The directories of the three layers for one plugin root.
struct Dirs {
    edited: PathBuf,
    lkg: Option<PathBuf>,
    pristine: Option<PathBuf>,
    stamp: String,
}

impl Dirs {
    fn new(root: &Path, lkg_base: Option<&Path>) -> Dirs {
        let pristine = Some(root.join(bootstrap::PRISTINE_DIR)).filter(|d| d.is_dir());
        let stamp = stamp(root);
        let lkg = lkg_base.map(|b| b.join(stamp_dir(&stamp))).filter(|d| std::fs::read_to_string(d.join(bootstrap::LKG_STAMP)).is_ok_and(|s| s == stamp));
        Dirs { edited: root.join(bootstrap::DEFAULTS_DIR), lkg, pristine, stamp }
    }

    fn dir(&self, l: Layer) -> Option<&Path> {
        match l {
            Layer::Edited => Some(&self.edited),
            Layer::Lkg => self.lkg.as_deref(),
            Layer::Pristine => self.pristine.as_deref(),
        }
    }

    /// The layers after `base` that exist, in fallback order.
    fn after(&self, base: Layer) -> Vec<(Layer, &Path)> {
        [Layer::Lkg, Layer::Pristine].into_iter().filter(|l| *l > base).filter_map(|l| self.dir(l).map(|d| (l, d))).collect()
    }
}

/// What makes a last-known-good copy usable: the same engine version, plugin root and plugin version (from the plugin's
/// manifest; a damaged pristine copy must not invalidate the copy that stands in for it).
fn stamp(root: &Path) -> String {
    let manifest = std::fs::read_to_string(root.join(bootstrap::PLUGIN_MANIFEST)).ok().and_then(|t| serde_json::from_str::<Json>(&t).ok());
    let version = manifest.as_ref().and_then(|m| m.get("version")).and_then(Json::as_str).unwrap_or("-").to_string();
    format!("{}\t{}\t{version}", env!("CARGO_PKG_VERSION"), root.display())
}

/// The subdirectory of the last-known-good base that holds the copy for `stamp`.
fn stamp_dir(stamp: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, stamp.as_bytes());
    d.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The settings of one file, in file order, after the structural checks (a section is a table of settings, a setting a table).
type Rows = Vec<(String, toml::Table)>;

/// Read one file of a layer: its text and its settings.
fn read_rows(dir: &Path, file: &str) -> Result<(String, Rows), DefaultsError> {
    let text = read(&dir.join(file), file)?;
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| DefaultsError::new("parse", file, "", e))?;
    let mut rows = Vec::new();
    for (section, body) in table {
        let toml::Value::Table(body) = body else {
            return Err(DefaultsError::new("entry", file, &section, "a section must be a table of settings"));
        };
        for (name, e) in body {
            let key = format!("{section}.{name}");
            let toml::Value::Table(e) = e else {
                return Err(DefaultsError::new("entry", file, &key, "a setting must be a table with `value` and `doc`"));
            };
            rows.push((key, e));
        }
    }
    Ok((text, rows))
}

/// Every check of one setting on its own: the fields, the value's type and range, and the type the shipped copy gives it.
fn validate(file: &str, key: &str, e: &toml::Table, kinds: &HashMap<&str, Kind>, shipped: Option<&toml::Value>) -> Result<(), DefaultsError> {
    let doc = e.get("doc").and_then(toml::Value::as_str).ok_or_else(|| DefaultsError::new("doc", file, key, "no `doc`"))?;
    if !doc.trim().ends_with('.') {
        return Err(DefaultsError::new("doc", file, key, "doc must be a sentence ending in a period"));
    }
    let v = e.get("value").ok_or_else(|| DefaultsError::new("value", file, key, "no `value`"))?;
    if let Some(k) = e.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        return Err(DefaultsError::new("field", file, key, format!("unknown field {k:?}")));
    }
    check_entry(file, key, e, kinds.get(key).copied())?;
    if !supported(v) {
        return Err(DefaultsError::new("unsupported", file, key, "use integers, booleans, strings, arrays and tables"));
    }
    if let Some(s) = shipped.and_then(|s| s.as_table()).and_then(|s| s.get("value"))
        && s.type_str() != v.type_str()
    {
        return Err(DefaultsError::new("type", file, key, format!("the shipped value is {}, this one is {}", s.type_str(), v.type_str())));
    }
    let row_ok =
        |r: &toml::Value| r.as_table().is_some_and(|t| t.get("id").is_some_and(toml::Value::is_str) && t.get("command").is_some_and(toml::Value::is_str));
    if key.starts_with(table::key("", "").trim_end_matches('_')) && !v.as_array().is_some_and(|a| a.iter().all(row_ok)) {
        return Err(DefaultsError::new("dispatch", file, key, "a dispatch row must be a list of entry tables, each with a string id and command"));
    }
    Ok(())
}

/// Whether [`to_v`] can convert `v` (checked without converting, which would leak).
fn supported(v: &toml::Value) -> bool {
    match v {
        toml::Value::Integer(_) | toml::Value::Boolean(_) | toml::Value::String(_) => true,
        toml::Value::Array(a) => a.iter().all(supported),
        toml::Value::Table(t) => t.values().all(supported),
        _ => false,
    }
}

/// One chosen setting: its file, key and table.
struct Pick {
    file: String,
    key: String,
    e: toml::Table,
}

/// Parsed files of the fallback layers, read once per load.
#[derive(Default)]
struct Files(HashMap<(Layer, String), Option<Rows>>);

impl Files {
    fn rows(&mut self, layer: Layer, dir: &Path, file: &str) -> Option<&Rows> {
        self.0.entry((layer, file.to_string())).or_insert_with(|| read_rows(dir, file).ok().map(|(_, r)| r)).as_ref()
    }

    fn setting(&mut self, layer: Layer, dir: &Path, file: &str, key: &str) -> Option<toml::Table> {
        self.rows(layer, dir, file)?.iter().find(|(k, _)| k == key).map(|(_, e)| e.clone())
    }
}

/// The settings of the layer `base`, with per-file and per-setting fallback to the layers after it.
fn assemble(d: &Dirs, base: Layer, kinds: &HashMap<&str, Kind>, report: &mut Report) -> Result<Vec<Pick>, DefaultsError> {
    let base_dir = d.dir(base).ok_or_else(|| DefaultsError::new("io", "", "", format!("no {} layer", base.code())))?;
    let fallbacks = d.after(base);
    let mut cache = Files::default();
    // what the shipped copy says about each setting: its type is the expected one
    let mut shipped: HashMap<String, toml::Value> = HashMap::new();
    let pristine_files = d.pristine.as_deref().and_then(|p| file_list(p).ok().map(|f| (p, f)));
    if let Some((p, files)) = &pristine_files {
        for f in files {
            if let Some(rows) = cache.rows(Layer::Pristine, p, f) {
                shipped.extend(rows.iter().map(|(k, e)| (k.clone(), toml::Value::Table(e.clone()))));
            }
        }
    }
    let files = match file_list(base_dir) {
        Ok(f) => f,
        Err(e) => {
            let (layer, f) = fallbacks.iter().find_map(|(l, dir)| file_list(dir).ok().map(|f| (*l, f))).ok_or_else(|| e.clone())?;
            report.notes.push(Note { code: e.code, file: e.file.clone(), key: String::new(), layer, detail: e.detail.clone() });
            f
        }
    };
    let mut picks: Vec<Pick> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for file in &files {
        let (rows, from, text) = match read_rows(base_dir, file) {
            Ok((text, rows)) => (rows, base, Some(text)),
            // a file the edited copy does not have at all: its settings are missing ones, taken from the pristine copy below
            Err(e) if base == Layer::Edited && e.code == "io" && !base_dir.join(file).exists() && d.pristine.is_some() => (Vec::new(), base, None),
            Err(e) => {
                let found = fallbacks.iter().find_map(|(l, dir)| read_rows(dir, file).ok().map(|(_, r)| (*l, r)));
                let (layer, rows) = found.ok_or_else(|| e.clone())?;
                report.notes.push(Note { code: e.code, file: file.clone(), key: String::new(), layer, detail: e.detail.clone() });
                (rows, layer, None)
            }
        };
        let mut clean = text.is_some();
        for (key, e) in rows {
            if let Some(first) = seen.get(&key) {
                return Err(DefaultsError::new("duplicate", file, &key, format!("also in {first}")));
            }
            let e = match validate(file, &key, &e, kinds, shipped.get(&key)) {
                Ok(()) => e,
                Err(err) => {
                    clean = false;
                    let later: Vec<(Layer, &Path)> = fallbacks.iter().copied().filter(|(l, _)| *l > from).collect();
                    let alt = later.iter().find_map(|(l, dir)| {
                        let alt = cache.setting(*l, dir, file, &key)?;
                        validate(file, &key, &alt, kinds, shipped.get(&key)).ok().map(|()| (*l, alt))
                    });
                    let (layer, alt) = alt.ok_or_else(|| err.clone())?;
                    report.notes.push(Note { code: err.code, file: file.clone(), key: key.clone(), layer, detail: err.detail.clone() });
                    alt
                }
            };
            seen.insert(key.clone(), file.clone());
            picks.push(Pick { file: file.clone(), key, e });
        }
        if clean
            && from == Layer::Edited
            && let Some(t) = text
        {
            report.clean.push((file.clone(), t));
        }
    }
    // the settings the base layer lacks and the pristine copy has
    if base != Layer::Pristine
        && let Some((p, pfiles)) = &pristine_files
    {
        for file in pfiles {
            let Some(rows) = cache.rows(Layer::Pristine, p, file).cloned() else { continue };
            for (key, e) in rows {
                if seen.contains_key(&key) || validate(file, &key, &e, kinds, None).is_err() {
                    continue;
                }
                report.notes.push(Note { code: "missing_key", file: file.clone(), key: key.clone(), layer: Layer::Pristine, detail: String::new() });
                if base == Layer::Edited && files.contains(file) {
                    report.missing.entry(file.clone()).or_default().push(key.clone());
                }
                seen.insert(key.clone(), file.clone());
                picks.push(Pick { file: file.clone(), key, e });
            }
        }
    }
    Ok(picks)
}

/// Build the snapshot from the chosen settings and run the cross-file checks.
fn finish(root: &Path, picks: Vec<Pick>, prev: Option<&Data>) -> Result<Data, DefaultsError> {
    let mut entries: Vec<&'static Entry> = Vec::new();
    let mut canon: HashMap<&'static str, String> = HashMap::new();
    for Pick { file, key, e } in picks {
        let text = format!("{e:?}");
        let reused = prev.and_then(|p| p.find(&key).filter(|old| old.file == file && p.canon.get(old.key).is_some_and(|c| *c == text)));
        let entry: &'static Entry = match reused {
            Some(old) => old,
            None => {
                let v = e.get("value").ok_or_else(|| DefaultsError::new("value", &file, &key, "no `value`"))?;
                let value = to_v(v).ok_or_else(|| DefaultsError::new("unsupported", &file, &key, "use integers, booleans, strings, arrays and tables"))?;
                Box::leak(Box::new(Entry {
                    key: leak_str(&key),
                    file: leak_str(&file),
                    value,
                    doc: leak_str(e.get("doc").and_then(toml::Value::as_str).unwrap_or("")),
                    env: e.get("env").and_then(toml::Value::as_str).map(leak_str),
                    min: e.get("min").and_then(toml::Value::as_integer),
                    max: e.get("max").and_then(toml::Value::as_integer),
                    unit: e.get("unit").and_then(toml::Value::as_str).map(leak_str),
                }))
            }
        };
        canon.insert(entry.key, text);
        entries.push(entry);
    }
    let mut index: Vec<(&'static str, &'static Entry)> = entries.iter().map(|e| (e.key, *e)).collect();
    index.sort_by(|a, b| a.0.cmp(b.0));
    for (k, _) in super::generated::REQUIRED {
        if index.binary_search_by(|(x, _)| (*x).cmp(k)).is_err() {
            return Err(DefaultsError::new(
                "missing_key",
                "",
                k,
                "a setting this engine reads is not in the plugin's defaults (plugin and engine versions differ)",
            ));
        }
    }
    crate::hookcfg::check_shipped(&entries).map_err(|e| DefaultsError::new("hooks", "", "", e))?;
    check_rows(root, &entries).map_err(|e| DefaultsError::new("dispatch", "", "", e))?;
    Ok(Data { root: root.to_path_buf(), entries: Box::leak(entries.into_boxed_slice()), index, canon, report: Report::default() })
}

/// Read and validate the defaults of the plugin at `root`, falling back per file and per setting to the last-known-good
/// and pristine copies (see above). `prev` lets unchanged entries be reused instead of leaked again.
pub fn load(root: &Path, prev: Option<&Data>) -> Result<Data, DefaultsError> {
    load_from(root, bootstrap::lkg_dir().as_deref(), prev)
}

/// [`load`] with the last-known-good base directory given (`None`: no last-known-good layer).
pub fn load_from(root: &Path, lkg_base: Option<&Path>, prev: Option<&Data>) -> Result<Data, DefaultsError> {
    let d = Dirs::new(root, lkg_base);
    let kinds: HashMap<&str, Kind> = super::generated::REQUIRED.iter().copied().collect();
    let mut first: Option<DefaultsError> = None;
    for base in [Layer::Edited, Layer::Lkg, Layer::Pristine] {
        if d.dir(base).is_none() {
            continue;
        }
        let mut report = Report { stamp: d.stamp.clone(), ..Report::default() };
        match assemble(&d, base, &kinds, &mut report).and_then(|picks| finish(root, picks, prev)) {
            Ok(mut data) => {
                if let Some(e) = &first {
                    // the whole edited set was rejected: name why first
                    report.notes.insert(0, Note { code: e.code, file: e.file.clone(), key: e.key.clone(), layer: base, detail: e.detail.clone() });
                    report.missing.clear();
                    report.clean.clear();
                }
                data.report = report;
                return Ok(data);
            }
            Err(e) => {
                first.get_or_insert(e);
            }
        }
    }
    Err(first.unwrap_or_else(|| DefaultsError::new("io", "", "", "no defaults layer")))
}

/// Keep the last-known-good copy for `report` under `base`: every edited file that validated in full, then the stamp the
/// copy is valid for. Copies for older stamps beyond `defaults_load.lkg_keep` are removed (derived copies, rebuilt by the
/// next load). Called after the snapshot is installed (it reads settings).
pub fn write_lkg(report: &Report, base: &Path) -> std::io::Result<()> {
    if report.clean.is_empty() {
        return Ok(());
    }
    let dir = base.join(stamp_dir(&report.stamp));
    std::fs::create_dir_all(&dir)?;
    for (file, text) in &report.clean {
        let p = dir.join(file);
        if std::fs::read_to_string(&p).is_ok_and(|t| t == *text) {
            continue;
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::atomic::write(&p, text)?;
    }
    let stamp = dir.join(bootstrap::LKG_STAMP);
    if !std::fs::read_to_string(&stamp).is_ok_and(|s| s == report.stamp) {
        crate::atomic::write(&stamp, &report.stamp)?;
    }
    let mut olds: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(base)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && *p != dir)
        .map(|p| (std::fs::metadata(p.join(bootstrap::LKG_STAMP)).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        .collect();
    olds.sort();
    let keep = super::num("defaults_load.lkg_keep").saturating_sub(1) as usize;
    for (_, p) in olds.iter().rev().skip(keep) {
        crate::discard::harmless(std::fs::remove_dir_all(p)); // keep: a stale copy left behind is ignored (its stamp does not match)
    }
    Ok(())
}

// ---- healing missing settings ------------------------------------------------------------------------------------------

/// The outcome of healing one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Healed {
    /// The settings were added.
    Added {
        /// The file, relative to the defaults directory.
        file: String,
        /// The settings added.
        keys: Vec<String>,
        /// The backup taken first, if this was the file's first heal.
        backup: Option<PathBuf>,
    },
    /// Not written: the plugin root is a version-controlled checkout and the heal was automatic.
    Skipped {
        /// The file, relative to the defaults directory.
        file: String,
        /// The settings it lacks.
        keys: Vec<String>,
    },
    /// Not written.
    Failed {
        /// The file, relative to the defaults directory.
        file: String,
        /// The settings it lacks.
        keys: Vec<String>,
        /// Why.
        err: String,
    },
}

/// True when `root` or a directory above it holds one of `defaults_load.vcs_markers` (a `.git` directory or file).
pub fn in_checkout(root: &Path) -> bool {
    let markers = super::list("defaults_load.vcs_markers");
    root.ancestors().any(|d| markers.iter().any(|m| d.join(m).exists()))
}

/// The source text of the setting `[key]` in a defaults file's `text`: its header line through its last non-blank,
/// non-comment line before the next table header.
fn block_of(text: &str, key: &str) -> Option<String> {
    let head = format!("[{key}]");
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| l.trim_end() == head)?;
    let is_header = |l: &str| l.starts_with('[') && l.trim_end().ends_with(']') && !l.starts_with("[[");
    let mut end = lines[start + 1..].iter().position(|l| is_header(l)).map_or(lines.len(), |n| start + 1 + n);
    while end > start + 1 && (lines[end - 1].trim().is_empty() || lines[end - 1].trim_start().starts_with('#')) {
        end -= 1;
    }
    Some(lines[start..end].join("\n"))
}

/// Add the settings `keys` of `file`, as the pristine copy has them, to the end of the edited file: existing text (entries,
/// comments, order) is kept byte for byte, a setting already present is never touched, and a value the owner typed is
/// never overwritten. The new text must parse and give each added setting exactly its pristine value, or nothing is
/// written. Before a file's first heal its text is backed up beside it. Idempotent: a second run finds nothing to add.
pub fn heal_file(root: &Path, file: &str, keys: &[String]) -> Result<Option<Added>, String> {
    let path = root.join(bootstrap::DEFAULTS_DIR).join(file);
    let pristine_text = std::fs::read_to_string(root.join(bootstrap::PRISTINE_DIR).join(file)).map_err(|e| e.to_string())?;
    let pristine: toml::Table = pristine_text.parse().map_err(|e: toml::de::Error| e.to_string())?;
    let (old, existed) = match std::fs::read_to_string(&path) {
        Ok(t) => (t, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(e) => return Err(e.to_string()),
    };
    let current: toml::Table = old.parse().map_err(|e: toml::de::Error| e.to_string())?;
    let lookup = |t: &toml::Table, k: &str| -> Option<toml::Value> {
        let (s, n) = k.split_once('.')?;
        t.get(s)?.as_table()?.get(n).cloned()
    };
    let todo: Vec<&String> = keys.iter().filter(|k| lookup(&current, k).is_none() && lookup(&pristine, k).is_some()).collect();
    if todo.is_empty() {
        return Ok(None);
    }
    let mut blocks = Vec::new();
    for k in &todo {
        blocks.push(block_of(&pristine_text, k).ok_or_else(|| format!("{k}: no `[{k}]` table in the pristine copy"))?);
    }
    let mut new = old.clone();
    if !new.is_empty() && !new.ends_with('\n') {
        new.push('\n');
    }
    if !new.is_empty() {
        new.push('\n');
    }
    new.push_str(&blocks.join("\n\n"));
    new.push('\n');
    let parsed: toml::Table = new.parse().map_err(|e: toml::de::Error| e.to_string())?;
    for k in &todo {
        if lookup(&parsed, k) != lookup(&pristine, k) {
            return Err(format!("{k}: the added text does not read back as the pristine value"));
        }
    }
    let backup = if existed && !has_backup(&path) {
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let b = path.with_file_name(format!("{}{}{now}", file.rsplit('/').next().unwrap_or(file), super::text("defaults_load.backup_infix")));
        std::fs::write(&b, &old).map_err(|e| e.to_string())?;
        Some(b)
    } else {
        None
    };
    crate::atomic::write(&path, &new).map_err(|e| e.to_string())?;
    Ok(Some((todo.into_iter().cloned().collect(), backup)))
}

/// What [`heal_file`] added: the settings and the backup taken first (on a file's first heal).
pub type Added = (Vec<String>, Option<PathBuf>);

fn has_backup(path: &Path) -> bool {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return false };
    let prefix = format!("{name}{}", super::text("defaults_load.backup_infix"));
    std::fs::read_dir(dir).is_ok_and(|rd| rd.flatten().any(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(&prefix))))
}

/// Heal every file of `report.missing` under `root`. An automatic heal (`force` false) never writes into a
/// version-controlled checkout ([`in_checkout`]); `ah-engine config heal` passes `force`.
pub fn heal(root: &Path, report: &Report, force: bool) -> Vec<Healed> {
    let skip = !force && in_checkout(root);
    report
        .missing
        .iter()
        .map(|(file, keys)| {
            if skip {
                return Healed::Skipped { file: file.clone(), keys: keys.clone() };
            }
            match heal_file(root, file, keys) {
                Ok(Some((keys, backup))) => Healed::Added { file: file.clone(), keys, backup },
                Ok(None) => Healed::Added { file: file.clone(), keys: Vec::new(), backup: None },
                Err(err) => Healed::Failed { file: file.clone(), keys: keys.clone(), err },
            }
        })
        .filter(|h| !matches!(h, Healed::Added { keys, .. } if keys.is_empty()))
        .collect()
}

/// The event-log kind, reason code and detail of a heal outcome.
pub fn heal_line(h: &Healed) -> (&'static str, &'static str, String) {
    match h {
        Healed::Added { file, keys, backup } => (
            "defaults_heal",
            "missing_key",
            super::render(
                "defaults_load.msg_heal",
                &[("file", file), ("keys", &keys.join(", ")), ("backup", &backup.as_ref().map(|b| b.display().to_string()).unwrap_or_default())],
            ),
        ),
        Healed::Skipped { file, keys } => {
            ("defaults_heal_skipped", "missing_key", super::render("defaults_load.msg_heal_skipped", &[("file", file), ("keys", &keys.join(", "))]))
        }
        Healed::Failed { file, keys, err } => {
            ("defaults_heal_failed", "io", super::render("defaults_load.msg_heal_failed", &[("file", file), ("keys", &keys.join(", ")), ("err", err)]))
        }
    }
}

/// What follows a successful load once its snapshot is active: each fallback goes to the event log (which marks the
/// engine degraded, `health.degraded_kinds`), missing settings are healed (or, in a version-controlled checkout, reported
/// with the command that adds them), and the last-known-good copy is kept.
pub fn after(report: &Report, root: &Path) {
    for h in heal(root, report, false) {
        let (kind, code, detail) = heal_line(&h);
        crate::health::log_event(kind, code, &detail);
    }
    for n in &report.notes {
        let detail = super::render(
            "defaults_load.msg_fallback",
            &[
                ("file", &n.file),
                ("key", &n.key),
                ("layer", &n.layer.code()),
                ("why", &if n.detail.is_empty() { n.code.to_string() } else { n.detail.clone() }),
            ],
        );
        crate::health::log_event("defaults_fallback", n.code, &detail);
    }
    if let Some(base) = bootstrap::lkg_dir()
        && let Err(e) = write_lkg(report, &base)
    {
        crate::health::log_event("defaults_lkg_failed", "io", &super::render("defaults_load.msg_lkg_failed", &[("err", &e)]));
    }
}

// ---- the dispatch table against the wrapper's fallback lists ----------------------------------------------------------

/// Load-time check of the table against the plugin at `root` (the settings in `entries`, before they become active):
/// every `dispatch.hooks_*` row is well formed, and every event a fallback list names hooks for has a non-empty row.
/// A table that lost a row would otherwise answer the event with the neutral no-op, skipping the Node hooks the wrapper
/// would run (a silent allow). A list that is not there is not checked (the wrapper has nothing to run either).
fn check_rows(root: &Path, entries: &[&'static Entry]) -> Result<(), String> {
    let get = |k: &str| -> Option<&'static V> { entries.iter().copied().find(|e| e.key == k).map(|e| &e.value) };
    let txt = |k: &str| get(k).and_then(V::as_str).ok_or_else(|| format!("{k} is missing or not a string"));
    let prefix = table::key("", "");
    let prefix = prefix.trim_end_matches('_');
    for e in entries.iter().filter(|e| e.key.starts_with(prefix)) {
        if table::rows_of(&e.value).is_none() {
            return Err(format!("{} must be a list of entry tables, each with a string id and command", e.key));
        }
    }
    let lists = get("dispatch.fallback_lists").and_then(V::as_table).ok_or("dispatch.fallback_lists is missing or not a table")?;
    let (mark, comment, empty) = (txt("dispatch.list_event_mark")?, txt("dispatch.list_comment_mark")?, txt("dispatch.list_empty_word")?);
    for (host, rel) in lists {
        let rel = rel.as_str().ok_or_else(|| format!("dispatch.fallback_lists.{host} is not a string"))?;
        let Ok(text) = std::fs::read_to_string(root.join(rel)) else { continue };
        let mut events: Vec<(String, table::Listed)> = table::list_events(&text, mark, comment, empty).into_iter().filter(|(_, l)| l.hooks > 0).collect();
        events.sort_by(|a, b| a.0.cmp(&b.0));
        for (ev, l) in events {
            let k = table::key(host, &ev);
            if !get(&k).and_then(|v| table::rows_of(v)).is_some_and(|a| !a.is_empty()) {
                return Err(format!("{rel} runs {} hook(s) for {host} {ev}, but {k} has no entries", l.hooks));
            }
        }
    }
    Ok(())
}

// ---- change detection --------------------------------------------------------------------------------------------

/// What the watcher compares: every `*.toml` under the defaults directory and the directories themselves, by path, modification
/// time, size and inode (so an atomic rename, an editor's temp-file swap and a plugin directory swap all show).
pub type Fingerprint = Vec<(PathBuf, Option<(SystemTime, u64, u64)>)>;

/// The fingerprint of the defaults of the plugin at `root`.
pub fn fingerprint(root: &Path) -> Fingerprint {
    fn one(p: &Path) -> Option<(SystemTime, u64, u64)> {
        std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len(), m.ino())))
    }
    fn walk(dir: &Path, depth: u8, out: &mut Fingerprint) {
        out.push((dir.to_path_buf(), one(dir)));
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        items.sort();
        for p in items {
            if p.is_dir() {
                if depth > 0 {
                    walk(&p, depth - 1, out);
                }
            } else if p.extension().is_some_and(|x| x == "toml") {
                out.push((p.clone(), one(&p)));
            }
        }
    }
    let mut out = vec![(root.to_path_buf(), one(root))];
    walk(&root.join(bootstrap::DEFAULTS_DIR), 2, &mut out);
    out
}

// ---- the snapshot cache ---------------------------------------------------------------------------------------------

const MAGIC: &str = "AHDC1";
const END: &str = "AHDC-END";

/// Write `data` to `path` atomically (a temporary file in the same directory, then a rename). Entries are sorted by key.
pub fn write_cache(data: &Data, path: &Path) -> std::io::Result<()> {
    let mut out = format!("{MAGIC}\t{}\t{}\n", env!("CARGO_PKG_VERSION"), data.root.display());
    for (key, e) in &data.index {
        let mut o = serde_json::Map::new();
        o.insert("v".into(), e.value.to_json());
        if let Some(n) = e.env {
            o.insert("e".into(), n.into());
        }
        if let Some(n) = e.min {
            o.insert("n".into(), n.into());
        }
        if let Some(n) = e.max {
            o.insert("x".into(), n.into());
        }
        out.push_str(&format!("{key}\t{}\n", Json::Object(o)));
    }
    out.push_str(END);
    out.push('\n');
    let dir = path.parent().unwrap_or(Path::new("."));
    crate::discard::harmless(crate::limits::ensure_private_dir(dir)); // keep: a failure surfaces at the create that follows
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(out.as_bytes())?;
    drop(f);
    std::fs::rename(&tmp, path).inspect_err(|_| {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
    })
}

/// The root a cache file records, without reading the rest of it.
pub fn cache_root(path: &Path) -> Option<PathBuf> {
    let mut head = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(std::fs::File::open(path).ok()?), &mut head).ok()?;
    let mut f = head.trim_end_matches('\n').splitn(3, '\t');
    (f.next()? == MAGIC && f.next()? == env!("CARGO_PKG_VERSION")).then(|| PathBuf::from(f.next().unwrap_or("")))
}

/// The client's view of the defaults: the cache file, with a line index, parsed one key at a time.
pub struct Lazy {
    text: String,
    root: PathBuf,
    /// (key start, key end, body start, body end), in key order.
    lines: Vec<(usize, usize, usize, usize)>,
    memo: Mutex<HashMap<&'static str, &'static Entry>>,
}

impl Lazy {
    /// Read the cache at `path`. `None` unless it is complete, written by this engine version and (when `root` is given) for that root.
    pub fn open(path: &Path, root: Option<&Path>) -> Option<Lazy> {
        let text = std::fs::read_to_string(path).ok()?;
        let (head, rest) = text.split_once('\n')?;
        let mut f = head.splitn(3, '\t');
        if f.next()? != MAGIC || f.next()? != env!("CARGO_PKG_VERSION") {
            return None;
        }
        let cached_root = PathBuf::from(f.next()?);
        if root.is_some_and(|r| r != cached_root) || !rest.ends_with(&format!("\n{END}\n")) {
            return None;
        }
        let base = head.len() + 1;
        let mut lines = Vec::new();
        let mut at = base;
        for l in rest.split_inclusive('\n') {
            let end = at + l.len();
            if let Some(tab) = l.find('\t') {
                lines.push((at, at + tab, at + tab + 1, end - 1));
            }
            at = end;
        }
        Some(Lazy { text, root: cached_root, lines, memo: Mutex::new(HashMap::new()) })
    }

    /// The plugin root the cache was written for.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn parse(&self, i: usize) -> Option<&'static Entry> {
        let (ks, ke, bs, be) = self.lines[i];
        let body: Json = serde_json::from_str(&self.text[bs..be]).ok()?;
        let key = leak_str(&self.text[ks..ke]);
        Some(Box::leak(Box::new(Entry {
            key,
            file: "",
            value: json_to_v(body.get("v")?)?,
            doc: "",
            env: body.get("e").and_then(Json::as_str).map(leak_str),
            min: body.get("n").and_then(Json::as_i64),
            max: body.get("x").and_then(Json::as_i64),
            unit: None,
        })))
    }

    pub(super) fn find(&self, key: &str) -> Option<&'static Entry> {
        if let Some(e) = self.memo.lock().ok()?.get(key).copied() {
            return Some(e);
        }
        let i = self.lines.binary_search_by(|(ks, ke, _, _)| self.text[*ks..*ke].cmp(key)).ok()?;
        let e = self.parse(i)?;
        self.memo.lock().ok()?.insert(e.key, e);
        Some(e)
    }

    /// The entries whose key starts with `prefix`, parsing only those lines (the keys are sorted).
    pub(super) fn with_prefix(&self, prefix: &str) -> Vec<&'static Entry> {
        let start = self.lines.partition_point(|(ks, ke, _, _)| &self.text[*ks..*ke] < prefix);
        self.lines[start..]
            .iter()
            .take_while(|(ks, ke, _, _)| self.text[*ks..*ke].starts_with(prefix))
            .filter_map(|(ks, ke, _, _)| self.find(&self.text[*ks..*ke]))
            .collect()
    }

    pub(super) fn all(&self) -> &'static [&'static Entry] {
        let all: Vec<&'static Entry> = (0..self.lines.len()).filter_map(|i| self.find(&self.text[self.lines[i].0..self.lines[i].1])).collect();
        Box::leak(all.into_boxed_slice())
    }
}

/// Note why no defaults could be loaded where an operator can find it: the event log needs the very settings that are
/// missing, so this is one line in `defaults.error` in the state directory (overwritten each time) and the same on stderr.
pub fn report_unavailable(e: &DefaultsError) {
    let line = format!("ah-engine: defaults unavailable: {e}");
    crate::discard::harmless(writeln!(std::io::stderr(), "{line}")); // keep: a closed stderr leaves nobody to tell
    if let Some(p) = bootstrap::state_dir().map(|d| d.join(bootstrap::ERROR_FILE)) {
        crate::discard::harmless(crate::limits::ensure_private_dir(p.parent().unwrap_or(Path::new(".")))); // keep: the write that follows fails too and the stderr line stands
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        crate::discard::harmless(std::fs::write(p, format!("{now} {line}\n"))); // keep: the same line already went to stderr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A copy of the repository plugin's `engine/defaults/` and `hooks/` fallback lists under a fresh temporary root,
    /// without the pristine copy (so a rejection has no layer to fall back on); see [`plugin_with_pristine`].
    pub(crate) fn plugin_copy(tag: &str) -> PathBuf {
        fn cp(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for e in std::fs::read_dir(from).unwrap().flatten() {
                let (p, q) = (e.path(), to.join(e.file_name()));
                if p.is_dir() {
                    cp(&p, &q);
                } else {
                    std::fs::copy(&p, &q).unwrap();
                }
            }
        }
        let root = std::env::temp_dir().join(format!("ah-defaults-load-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&root));
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        cp(&src.join(bootstrap::DEFAULTS_DIR), &root.join(bootstrap::DEFAULTS_DIR));
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        for l in ["ah-fallback.list", "ah-fallback.codex.list"] {
            std::fs::copy(src.join("hooks").join(l), root.join("hooks").join(l)).unwrap();
        }
        root
    }

    /// Replace the TOML table `[name]` (up to the next table header) in `file` of the copy with `with`.
    pub(crate) fn replace_table(root: &Path, file: &str, name: &str, with: &str) {
        let p = root.join(bootstrap::DEFAULTS_DIR).join(file);
        let text = std::fs::read_to_string(&p).unwrap();
        let head = format!("[{name}]\n");
        let at = text.find(&head).unwrap_or_else(|| panic!("{name} not in {file}"));
        let end = text[at + head.len()..].find("\n[").map_or(text.len(), |n| at + head.len() + n + 1);
        std::fs::write(&p, format!("{}{with}{}", &text[..at], &text[end..])).unwrap();
    }

    #[test]
    fn a_table_row_the_fallback_list_runs_hooks_for_cannot_go_missing() {
        let root = plugin_copy("norow");
        assert!(load_from(&root, None, None).is_ok(), "the shipped plugin loads");
        replace_table(&root, "dispatch.toml", "dispatch.hooks_claude_Stop", "");
        let e = load_from(&root, None, None).err().expect("a lost row the list runs hooks for is rejected");
        assert_eq!(e.code, "dispatch", "{e}");
        assert!(e.detail.contains("dispatch.hooks_claude_Stop"), "{e}");
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    #[test]
    fn a_wrong_type_table_row_is_rejected() {
        let root = plugin_copy("badrow");
        replace_table(&root, "dispatch.toml", "dispatch.hooks_claude_Stop", "[dispatch.hooks_claude_Stop]\ndoc = \"Broken.\"\nvalue = \"oops\"\n");
        let e = load_from(&root, None, None).err().expect("a row that is not a list of entries is rejected");
        assert_eq!(e.code, "dispatch", "{e}");
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    #[test]
    fn a_key_read_through_a_helper_cannot_go_missing() {
        // review P1 #3: `defaults::env_var("done_file")` reads `env.done_file`; the first key scanner did not see it, so a
        // plugin without it loaded and the dispatcher panicked on first use
        for (file, name) in [("engine.toml", "env.done_file"), ("sibling_sweep.toml", "sibling_sweep.text_max_bytes")] {
            let root = plugin_copy("helperkey");
            replace_table(&root, file, name, "");
            let e = load_from(&root, None, None).err().unwrap_or_else(|| panic!("a plugin without {name} must be rejected"));
            assert_eq!((e.code, e.key.as_str()), ("missing_key", name), "{e}");
            crate::discard::harmless(std::fs::remove_dir_all(&root));
        }
    }

    #[test]
    fn a_wrong_type_or_out_of_range_value_is_rejected_not_read() {
        // review P1 #2: these used to load and then panic in the reader (`num` of a string, a clamp the value breaks)
        let cases = [
            ("engine.toml", "daemon.queue", "[daemon.queue]\ndoc = \"Queue.\"\nvalue = \"sixteen\"\nenv = \"AH_ENGINE_QUEUE\"\n", "type"),
            ("engine.toml", "daemon.accept_poll_ms", "[daemon.accept_poll_ms]\ndoc = \"Poll.\"\nvalue = true\n", "type"),
            ("engine.toml", "daemon.queue", "[daemon.queue]\ndoc = \"Queue.\"\nvalue = 16\nmin = 32\nmax = 8\n", "range"),
            ("engine.toml", "daemon.queue", "[daemon.queue]\ndoc = \"Queue.\"\nvalue = 4096\nmin = 1\nmax = 1024\n", "range"),
            ("engine.toml", "daemon.queue", "[daemon.queue]\ndoc = \"Queue.\"\nvalue = 16\nmax = \"big\"\n", "range"),
            ("dispatch.toml", "dispatch.guard_events", "[dispatch.guard_events]\ndoc = \"Guards.\"\nvalue = \"PreToolUse\"\n", "type"),
        ];
        for (file, key, with, code) in cases {
            let root = plugin_copy("badvalue");
            replace_table(&root, file, key, with);
            let e = load_from(&root, None, None).err().unwrap_or_else(|| panic!("{key} = {with:?} must be rejected"));
            assert_eq!((e.code, e.key.as_str()), (code, key), "{e}");
            crate::discard::harmless(std::fs::remove_dir_all(&root));
        }
    }

    // ---- failover: last-known-good, then pristine, then 75 ---------------------------------------------------------------

    /// [`plugin_copy`] with the pristine copy too.
    fn plugin_with_pristine(tag: &str) -> PathBuf {
        let root = plugin_copy(tag);
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").join(bootstrap::PRISTINE_DIR);
        let to = root.join(bootstrap::PRISTINE_DIR);
        std::fs::create_dir_all(&to).unwrap();
        for e in std::fs::read_dir(src).unwrap().flatten() {
            std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
        root
    }

    fn int(d: &Data, key: &str) -> i64 {
        d.find(key).and_then(|e| e.value.as_integer()).unwrap_or_else(|| panic!("{key} is not an integer"))
    }

    fn set_int(root: &Path, file: &str, key: &str, n: i64) {
        let p = root.join(bootstrap::DEFAULTS_DIR).join(file);
        let text = std::fs::read_to_string(&p).unwrap();
        let head = format!("[{key}]\n");
        let at = text.find(&head).unwrap() + head.len();
        let v = at + text[at..].find("\nvalue = ").unwrap() + 1;
        let end = v + text[v..].find('\n').unwrap();
        std::fs::write(&p, format!("{}value = {n}{}", &text[..v], &text[end..])).unwrap();
    }

    fn corrupt(dir: &Path, file: &str) {
        let p = dir.join(file);
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replacen("\n[", "\n[[[", 1)).unwrap();
    }

    #[test]
    fn a_broken_file_falls_back_to_last_known_good_alone_and_other_edits_stay() {
        let root = plugin_with_pristine("lkg");
        let lkg = root.join("state-lkg");
        // two valid edits in two files; the load keeps both files as last-known-good
        set_int(&root, "engine.toml", "daemon.queue", 33);
        set_int(&root, "git.toml", "git.max_chain", 7);
        let d = load_from(&root, Some(&lkg), None).unwrap();
        assert!(d.report.notes.is_empty(), "{:?}", d.report.notes);
        write_lkg(&d.report, &lkg).unwrap();
        // a later edit of git.toml is valid; engine.toml is broken
        set_int(&root, "git.toml", "git.max_chain", 9);
        corrupt(&root.join(bootstrap::DEFAULTS_DIR), "engine.toml");
        let d = load_from(&root, Some(&lkg), None).unwrap();
        assert_eq!(int(&d, "daemon.queue"), 33, "engine.toml comes from the last-known-good copy (with its edit)");
        assert_eq!(int(&d, "git.max_chain"), 9, "git.toml keeps its newer edit");
        let n = &d.report.notes;
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!((n[0].code, n[0].file.as_str(), n[0].layer), ("parse", "engine.toml", Layer::Lkg));
        assert!(!d.report.clean.iter().any(|(f, _)| f == "engine.toml"), "a broken file never overwrites its last-known-good copy");
        // one wrong-type setting falls back alone; the rest of its file keeps the edits
        set_int(&root, "git.toml", "git.max_chain", 9);
        let p = root.join(bootstrap::DEFAULTS_DIR).join("engine.toml");
        std::fs::write(&p, std::fs::read_to_string(root.join(bootstrap::PRISTINE_DIR).join("engine.toml")).unwrap()).unwrap();
        set_int(&root, "engine.toml", "daemon.workers", 5);
        replace_table(&root, "engine.toml", "daemon.queue", "[daemon.queue]\ndoc = \"Queue.\"\nvalue = \"x\"\nenv = \"AH_ENGINE_QUEUE\"\n");
        let d = load_from(&root, Some(&lkg), None).unwrap();
        assert_eq!((int(&d, "daemon.queue"), int(&d, "daemon.workers")), (33, 5), "only the bad setting falls back");
        assert_eq!((d.report.notes[0].code, d.report.notes[0].key.as_str(), d.report.notes[0].layer), ("type", "daemon.queue", Layer::Lkg));
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    #[test]
    fn without_last_known_good_the_pristine_copy_answers_and_with_all_three_broken_the_load_fails() {
        let root = plugin_with_pristine("pristine");
        set_int(&root, "git.toml", "git.max_chain", 9);
        corrupt(&root.join(bootstrap::DEFAULTS_DIR), "engine.toml");
        let shipped = load_from(&plugin_copy("shipped"), None, None).unwrap();
        let d = load_from(&root, None, None).unwrap();
        assert_eq!(int(&d, "daemon.queue"), int(&shipped, "daemon.queue"), "the pristine copy answers");
        assert_eq!(int(&d, "git.max_chain"), 9, "the other files keep their edits");
        assert_eq!((d.report.notes[0].file.as_str(), d.report.notes[0].layer), ("engine.toml", Layer::Pristine));
        // a broken last-known-good copy as well
        corrupt(&root.join(bootstrap::PRISTINE_DIR), "engine.toml");
        let lkg = root.join("state-lkg");
        let rep = Report { stamp: Dirs::new(&root, None).stamp, clean: vec![("engine.toml".into(), "not [ toml".into())], ..Report::default() };
        write_lkg(&rep, &lkg).unwrap();
        assert!(Dirs::new(&root, Some(&lkg)).lkg.is_some(), "the broken last-known-good copy is in play");
        let e = load_from(&root, Some(&lkg), None).err().expect("all three layers broken: no defaults (exit 75)");
        assert_eq!((e.code, e.file.as_str()), ("parse", "engine.toml"), "the edited file's own error is reported");
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    #[test]
    fn a_setting_whose_type_differs_from_the_shipped_one_is_rejected() {
        let root = plugin_with_pristine("shippedtype");
        // `daemon.workers` is read through the config layer (any type at the call site): the shipped type decides
        replace_table(&root, "engine.toml", "daemon.workers", "[daemon.workers]\ndoc = \"Workers.\"\nvalue = true\n");
        let d = load_from(&root, None, None).unwrap();
        assert_eq!((d.report.notes[0].code, d.report.notes[0].layer), ("type", Layer::Pristine));
        assert_eq!(int(&d, "daemon.workers"), 4);
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    // ---- healing missing settings ----------------------------------------------------------------------------------------

    #[test]
    fn a_missing_setting_is_healed_into_the_edited_file_keeping_its_text_and_idempotently() {
        let root = plugin_with_pristine("heal");
        assert!(!in_checkout(&root), "the temporary root is not a checkout");
        let p = root.join(bootstrap::DEFAULTS_DIR).join("engine.toml");
        replace_table(&root, "engine.toml", "daemon.queue", "");
        let edited = format!("# my own note, kept\n{}", std::fs::read_to_string(&p).unwrap());
        std::fs::write(&p, &edited).unwrap();
        let d = load_from(&root, None, None).unwrap();
        assert_eq!(int(&d, "daemon.queue"), 16, "the missing setting is read from the pristine copy");
        assert_eq!(d.report.missing.get("engine.toml"), Some(&vec!["daemon.queue".to_string()]));
        let done = heal(&root, &d.report, false);
        let Healed::Added { keys, backup: Some(backup), .. } = &done[0] else { panic!("{done:?}") };
        assert_eq!(keys, &["daemon.queue".to_string()]);
        let healed = std::fs::read_to_string(&p).unwrap();
        assert!(healed.starts_with(&edited), "the existing text (comments, entries, order) is kept byte for byte");
        assert!(
            healed.trim_end().ends_with("max = 1024") && healed.contains("\n[daemon.queue]\n"),
            "the pristine block is appended:\n{}",
            &healed[edited.len()..]
        );
        assert_eq!(std::fs::read_to_string(backup).unwrap(), edited, "a backup of the text before the first heal");
        let d = load_from(&root, None, None).unwrap();
        assert!(d.report.missing.is_empty() && d.report.notes.is_empty(), "{:?}", d.report.notes);
        // idempotent: nothing more to add, nothing written, no second backup
        assert!(heal(&root, &d.report, false).is_empty());
        assert_eq!(heal_file(&root, "engine.toml", &["daemon.queue".to_string()]), Ok(None));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), healed);
        let backups =
            std::fs::read_dir(p.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("engine.toml.bak-")).count();
        assert_eq!(backups, 1);
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }

    #[test]
    fn a_checkout_is_never_written_automatically_and_a_wrong_value_is_never_overwritten() {
        let root = plugin_with_pristine("healgit");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let p = root.join(bootstrap::DEFAULTS_DIR).join("engine.toml");
        replace_table(&root, "engine.toml", "daemon.queue", "");
        // a value the owner typed wrong, in the same file
        replace_table(&root, "engine.toml", "daemon.workers", "[daemon.workers]\ndoc = \"Workers.\"\nvalue = \"many\"\nenv = \"AH_ENGINE_WORKERS\"\n");
        let before = std::fs::read_to_string(&p).unwrap();
        let d = load_from(&root, None, None).unwrap();
        assert_eq!((int(&d, "daemon.queue"), int(&d, "daemon.workers")), (16, 4), "both fall back to the pristine copy");
        assert_eq!(d.report.missing.get("engine.toml"), Some(&vec!["daemon.queue".to_string()]), "only the missing key is a heal candidate");
        let done = heal(&root, &d.report, false);
        assert!(matches!(&done[..], [Healed::Skipped { .. }]), "{done:?}");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), before, "a checkout is not written by an automatic heal");
        assert!(heal_line(&done[0]).2.contains("ah-engine config heal"), "the warning names the command");
        // the explicit command writes the missing key, and leaves the wrong value alone
        let done = heal(&root, &d.report, true);
        assert!(matches!(&done[..], [Healed::Added { .. }]), "{done:?}");
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(after.starts_with(&before) && after.contains("value = \"many\""), "the wrong value stays as typed");
        let d = load_from(&root, None, None).unwrap();
        assert_eq!((d.report.notes.len(), d.report.notes[0].key.as_str(), d.report.notes[0].code), (1, "daemon.workers", "type"), "still falls back, named");
        crate::discard::harmless(std::fs::remove_dir_all(&root));
    }
}
