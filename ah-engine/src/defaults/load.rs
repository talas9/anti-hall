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
use super::{Entry, V};
use crate::bootstrap;
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
    /// Reason code (`no_root`, `io`, `parse`, `index`, `entry`, `doc`, `value`, `field`, `unsupported`, `duplicate`, `missing_key`, `hooks`).
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
}

impl Data {
    /// The plugin root these defaults were read from.
    pub fn root(&self) -> &Path {
        &self.root
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

/// Read and validate the defaults of the plugin at `root`. `prev` lets unchanged entries be reused instead of leaked again.
pub fn load(root: &Path, prev: Option<&Data>) -> Result<Data, DefaultsError> {
    let dir = root.join(bootstrap::DEFAULTS_DIR);
    let mut entries: Vec<&'static Entry> = Vec::new();
    let mut canon: HashMap<&'static str, String> = HashMap::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for file in file_list(&dir)? {
        let text = read(&dir.join(&file), &file)?;
        let table: toml::Table = text.parse().map_err(|e: toml::de::Error| DefaultsError::new("parse", &file, "", e))?;
        for (section, body) in &table {
            let body = body.as_table().ok_or_else(|| DefaultsError::new("entry", &file, section, "a section must be a table of settings"))?;
            for (name, e) in body {
                let key = format!("{section}.{name}");
                let e = e.as_table().ok_or_else(|| DefaultsError::new("entry", &file, &key, "a setting must be a table with `value` and `doc`"))?;
                let doc = e.get("doc").and_then(toml::Value::as_str).ok_or_else(|| DefaultsError::new("doc", &file, &key, "no `doc`"))?;
                if !doc.trim().ends_with('.') {
                    return Err(DefaultsError::new("doc", &file, &key, "doc must be a sentence ending in a period"));
                }
                let v = e.get("value").ok_or_else(|| DefaultsError::new("value", &file, &key, "no `value`"))?;
                if let Some(k) = e.keys().find(|k| !FIELDS.contains(&k.as_str())) {
                    return Err(DefaultsError::new("field", &file, &key, format!("unknown field {k:?}")));
                }
                if let Some(first) = seen.insert(key.clone(), file.clone()) {
                    return Err(DefaultsError::new("duplicate", &file, &key, format!("also in {first}")));
                }
                let text = format!("{e:?}");
                let reused = prev.and_then(|p| p.find(&key).filter(|old| old.file == file && p.canon.get(old.key).is_some_and(|c| *c == text)));
                let entry: &'static Entry = match reused {
                    Some(old) => old,
                    None => {
                        let value =
                            to_v(v).ok_or_else(|| DefaultsError::new("unsupported", &file, &key, "use integers, booleans, strings, arrays and tables"))?;
                        Box::leak(Box::new(Entry {
                            key: leak_str(&key),
                            file: leak_str(&file),
                            value,
                            doc: leak_str(doc),
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
        }
    }
    let mut index: Vec<(&'static str, &'static Entry)> = entries.iter().map(|e| (e.key, *e)).collect();
    index.sort_by(|a, b| a.0.cmp(b.0));
    for k in super::generated::REQUIRED {
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
    Ok(Data { root: root.to_path_buf(), entries: Box::leak(entries.into_boxed_slice()), index, canon })
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
