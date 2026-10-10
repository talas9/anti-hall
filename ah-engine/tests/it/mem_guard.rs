//! Guard for the memory module (issues #21 / #158): all long-lived memory goes through `src/mem`. This test fails the build when
//! non-test code OUTSIDE `src/mem/` declares
//!  * a `static` (including inside `thread_local!`) whose type holds a collection (`HashMap`, `BTreeMap`, `HashSet`, `BTreeSet`,
//!    `VecDeque`, `BinaryHeap`, `Vec<..>`, `String`), whether bare or behind `Mutex` / `RwLock` / `OnceLock` / `LazyLock` /
//!    `OnceCell`; or
//!  * a field of a struct that holds a collection behind a lock or a once-cell (shared, long-lived state); or
//!  * any collection field of the daemon's shared state (`Shared` in `daemon.rs`),
//!
//! unless `tests/mem_allowlist.txt` lists it with a stated bound and a reason. The allowlist is the review point: an entry says
//! what bounds the thing (a count fixed by the code, a count of live workers, a cap read from config, a per-request scope) or
//! that it is registered with the memory registry. `defaults::Cache<T>` (a value derived from the config, rebuilt once per
//! config generation and counted by `mem::note_leak`) is the sanctioned config cache and is not flagged.
//!
//! Format of `tests/mem_allowlist.txt`: one entry per line, `path under src | symbol | bound | reason`; `#` starts a comment.
//! The symbol is the static's name, or `Struct.field`. A stale entry (nothing matches it any more) fails too, so the list only
//! shrinks as holders move onto the registry.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};

const COLLECTIONS: &[&str] = &["HashMap", "BTreeMap", "HashSet", "BTreeSet", "VecDeque", "BinaryHeap", "Vec<", "String"];
const SHARED: &[&str] = &["Mutex<", "RwLock<", "OnceLock<", "LazyLock<", "OnceCell<", "Arc<Mutex", "Arc<RwLock"];

/// One long-lived collection found in a file: (path relative to `src`, symbol, the declared type).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    file: String,
    symbol: String,
    ty: String,
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The non-test code of `text`: comment lines blanked, the trailing `#[cfg(test)] mod ... {` block cut off.
fn code(text: &str) -> String {
    let cut = Regex::new(r"(?m)^#\[cfg\(test\)\]\s*\n\s*(?:pub\s+)?mod\s+\w+\s*\{").unwrap();
    let text = cut.find(text).map_or(text, |m| &text[..m.start()]);
    text.lines()
        .map(|l| {
            let t = l.trim_start();
            if t.starts_with("//") {
                String::new()
            } else {
                match l.find("//") {
                    Some(i) if !l[..i].contains('"') => l[..i].to_string(),
                    _ => l.to_string(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_collection(ty: &str) -> bool {
    COLLECTIONS.iter().any(|c| ty.contains(c))
}

fn is_shared(ty: &str) -> bool {
    SHARED.iter().any(|c| ty.contains(c))
}

/// Split a struct body into `(name, type)` fields at top-level commas.
fn fields(body: &str) -> Vec<(String, String)> {
    let attrs = Regex::new(r"#\[[^\]]*\]").unwrap();
    let (mut out, mut depth, mut cur) = (Vec::new(), 0i32, String::new());
    for c in body.chars().chain(std::iter::once(',')) {
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        if c == ',' && depth <= 0 {
            // drop attributes and the visibility, then split name from type at the first colon
            let f = attrs.replace_all(&cur, "").to_string();
            let f = f.trim().trim_start_matches("pub(crate)").trim_start_matches("pub(super)").trim_start_matches("pub").trim();
            if let Some((n, t)) = f.split_once(':') {
                out.push((n.trim().to_string(), t.split_whitespace().collect::<Vec<_>>().join(" ")));
            }
            cur.clear();
            depth = 0;
        } else {
            cur.push(c);
        }
    }
    out
}

/// Every offending declaration in the non-test code of one file (`rel` is its path under `src`).
pub fn scan_text(rel: &str, text: &str) -> Vec<Site> {
    if rel.starts_with("mem/") || rel.ends_with("tests.rs") || rel.contains("/tests/") {
        return Vec::new();
    }
    let text = code(text);
    let mut out = Vec::new();
    let statics = Regex::new(r"(?s)\bstatic\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:\s*([^=;]+?)\s*=").unwrap();
    for c in statics.captures_iter(&text) {
        let ty = c[2].split_whitespace().collect::<Vec<_>>().join(" ");
        if has_collection(&ty) && !ty.contains("Cache<") {
            out.push(Site { file: rel.into(), symbol: c[1].into(), ty });
        }
    }
    let structs = Regex::new(r"(?m)^\s*(?:pub(?:\([a-z]+\))?\s+)?struct\s+(\w+)(?:<[^{;]*>)?\s*(?:where[^{;]*)?\{").unwrap();
    for c in structs.captures_iter(&text) {
        let open = c.get(0).unwrap().end();
        let (mut depth, mut end) = (1, open);
        for (i, ch) in text[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                end = open + i;
                break;
            }
        }
        let daemon_state = rel == "daemon.rs" && &c[1] == "Shared";
        for (name, ty) in fields(&text[open..end]) {
            if has_collection(&ty) && !ty.contains("Cache<") && (daemon_state || is_shared(&ty)) {
                out.push(Site { file: rel.into(), symbol: format!("{}.{name}", &c[1]), ty });
            }
        }
    }
    out
}

/// Every offending declaration under `src`.
pub fn scan_tree(src: &Path) -> Vec<Site> {
    let mut files = Vec::new();
    rust_files(src, &mut files);
    files.sort();
    files
        .iter()
        .flat_map(|f| {
            let rel = f.strip_prefix(src).unwrap().to_string_lossy().replace('\\', "/");
            scan_text(&rel, &fs::read_to_string(f).unwrap())
        })
        .collect()
}

#[derive(Debug)]
struct Entry {
    file: String,
    symbol: String,
    bound: String,
    reason: String,
}

fn allowlist() -> Vec<Entry> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/mem_allowlist.txt");
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .map(|l| {
            let p: Vec<&str> = l.splitn(4, '|').map(str::trim).collect();
            assert_eq!(p.len(), 4, "allowlist line needs `path | symbol | bound | reason`: {l}");
            Entry { file: p[0].into(), symbol: p[1].into(), bound: p[2].into(), reason: p[3].into() }
        })
        .collect()
}

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

#[test]
fn long_lived_collections_outside_the_memory_module_are_listed_with_their_bound() {
    let list = allowlist();
    let bad: Vec<String> = scan_tree(&src())
        .into_iter()
        .filter(|s| !list.iter().any(|e| e.file == s.file && e.symbol == s.symbol))
        .map(|s| format!("{} {} : {}", s.file, s.symbol, s.ty))
        .collect();
    assert!(
        bad.is_empty(),
        "long-lived collections outside src/mem: put them on the memory registry (mem::BoundedCache or a mem::Budget), or list them in tests/mem_allowlist.txt with a bound and a reason:\n{}",
        bad.join("\n")
    );
}

#[test]
fn every_allowlist_entry_states_a_bound_and_a_reason_and_still_matches_something() {
    let sites = scan_tree(&src());
    for e in allowlist() {
        assert!(e.bound.len() >= 8 && e.reason.len() >= 8, "{} {}: state the bound and the reason", e.file, e.symbol);
        assert!(sites.iter().any(|s| s.file == e.file && s.symbol == e.symbol), "stale allowlist entry (nothing matches it any more): {} {}", e.file, e.symbol);
    }
}

#[test]
fn the_guard_catches_a_planted_violation() {
    let bare = "use std::collections::HashMap;\nstatic LEAK: std::sync::Mutex<HashMap<String, Vec<u8>>> = std::sync::Mutex::new(HashMap::new());\n";
    assert_eq!(
        scan_text("planted.rs", bare),
        vec![Site { file: "planted.rs".into(), symbol: "LEAK".into(), ty: "std::sync::Mutex<HashMap<String, Vec<u8>>>".into() }]
    );
    let tl = "thread_local! {\n    static SEEN: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };\n}\n";
    assert_eq!(scan_text("planted.rs", tl).len(), 1, "a thread_local collection");
    let once = "static ALL: OnceLock<Vec<Entry>> = OnceLock::new();\n";
    assert_eq!(scan_text("planted.rs", once).len(), 1, "a OnceLock collection");
    let field = "pub struct State {\n    pub n: u32,\n    seen: Mutex<HashMap<String, u64>>,\n}\n";
    assert_eq!(scan_text("planted.rs", field)[0].symbol, "State.seen", "a lock-wrapped collection field");
    let daemon = "pub struct Shared {\n    sessions: Vec<String>,\n}\n";
    assert_eq!(scan_text("daemon.rs", daemon).len(), 1, "any collection field of the daemon state");
    assert!(scan_text("other.rs", daemon).is_empty(), "a plain transient struct is not flagged");
    // not violations: counters, config caches, test code, the memory module itself
    assert!(scan_text("planted.rs", "static N: AtomicU64 = AtomicU64::new(0);\nstatic C: defaults::Cache<Vec<String>> = defaults::Cache::new();\n").is_empty());
    assert!(scan_text("planted.rs", "// static X: Mutex<Vec<u8>> = Mutex::new(Vec::new());\n").is_empty());
    assert!(scan_text("planted.rs", &format!("fn f() {{}}\n#[cfg(test)]\nmod tests {{\n{bare}}}\n")).is_empty());
    assert!(scan_text("mem/cache.rs", bare).is_empty());
    // and through the file system, the way the real test walks the tree
    let dir = std::env::temp_dir().join(format!("ah-mem-guard-{}-{:?}", std::process::id(), std::time::SystemTime::now()));
    fs::create_dir_all(dir.join("mem")).unwrap();
    fs::write(dir.join("planted.rs"), bare).unwrap();
    fs::write(dir.join("mem/ok.rs"), bare).unwrap();
    let found = scan_tree(&dir);
    fs::remove_dir_all(&dir).unwrap(); // our own scratch directory
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].file, "planted.rs");
}
