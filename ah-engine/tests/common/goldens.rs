//! Node goldens: a parity lane's Node answers, recorded once and replayed, so an everyday run spawns the engine only.
//!
//! The parity lanes compare the engine against the real Node hook. Node is the slow half of each comparison, and its answers
//! only change when the Node code they exercise (or the toolchain) changes. A golden stores those answers next to a fingerprint
//! of exactly that code: the static require-closure of the lane's entry files (SHA-256 per file) plus the `--version` text of the
//! tools Node shells out to. See `tests/goldens/README.md`.
//!
//! Modes (`mode()`): Replay is the default and serves recorded answers; a stale fingerprint fails the test and names the files that
//! changed. `AH_RECORD_NODE=1` runs Node live and writes the golden (never in CI). `AH_LIVE_NODE=1` runs Node live and, when a fresh
//! golden exists, also checks the live answers against it (the safety net for a file the closure scan missed).
#![allow(dead_code)] // each test binary uses a subset

use regex::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeMode {
    Replay,
    Record,
    Live,
}

fn flag(k: &str) -> bool {
    std::env::var(k).is_ok_and(|v| v == "1")
}

/// The mode of this run. Both flags at once, or recording in CI, is a mistake and panics.
pub fn mode() -> NodeMode {
    let (rec, live) = (flag("AH_RECORD_NODE"), flag("AH_LIVE_NODE"));
    assert!(!(rec && live), "AH_RECORD_NODE=1 and AH_LIVE_NODE=1 are exclusive");
    if rec {
        assert!(!std::env::var("CI").is_ok_and(|v| v == "true"), "AH_RECORD_NODE=1 in CI: goldens are recorded on a dev machine and reviewed");
        NodeMode::Record
    } else if live {
        NodeMode::Live
    } else {
        NodeMode::Replay
    }
}

/// A tool the Node code shells out to: its full `--version` text is part of the fingerprint.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Node,
    Python3,
    Git,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Tool::Node => "node",
            Tool::Python3 => "python3",
            Tool::Git => "git",
        }
    }
    fn version(self) -> String {
        std::process::Command::new(self.name())
            .arg("--version")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "missing".into())
    }
}

pub fn sha256_hex(b: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, b).as_ref().iter().map(|x| format!("{x:02x}")).collect()
}

fn repo_root() -> PathBuf {
    let r = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    r.canonicalize().unwrap_or(r)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub hex: String,
    /// (path relative to the repository root, SHA-256) per file of the closure, sorted.
    pub parts: Vec<(String, String)>,
    pub tools: BTreeMap<String, String>,
}

static STR_LIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`"#).unwrap());
static JOIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"path\.(?:join|resolve)\(([^()]*)\)").unwrap());

fn is_code(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()), Some("js" | "cjs" | "mjs"))
}

/// Every plugin file `file` may load: `require('./x')`, `path.join(__dirname, 'a', 'b.js')` and any literal that ends in
/// `.js/.json/.sh` or starts with `./`/`../`, resolved against the file's directory and each ancestor up to the plugin root.
/// Over-inclusion is safe (a needless re-record); a miss is caught by the live soak run.
fn refs(file: &Path, src: &str, plugin: &Path) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    let mut d = file.parent();
    while let Some(x) = d {
        bases.push(x.to_path_buf());
        if x == plugin || !x.starts_with(plugin) {
            break;
        }
        d = x.parent();
    }
    let lits =
        |t: &str| -> Vec<String> { STR_LIT.captures_iter(t).filter_map(|c| c.get(1).or(c.get(2)).or(c.get(3)).map(|m| m.as_str().to_string())).collect() };
    let mut cands: Vec<String> = Vec::new();
    for c in JOIN.captures_iter(src) {
        let parts = lits(&c[1]);
        if !parts.is_empty() {
            cands.push(parts.join("/"));
        }
    }
    for l in lits(src) {
        let ext = [".js", ".cjs", ".mjs", ".json", ".sh"].iter().any(|e| l.ends_with(e));
        if (ext || l.starts_with("./") || l.starts_with("../")) && !l.contains('\n') && l.len() < 300 {
            cands.push(l);
        }
    }
    let mut out = Vec::new();
    for c in cands {
        let c = c.trim_start_matches('/');
        for b in &bases {
            for suffix in ["", ".js", "/index.js"] {
                let p = b.join(format!("{c}{suffix}"));
                if p.is_file()
                    && let Ok(p) = p.canonicalize()
                    && p.starts_with(plugin)
                {
                    out.push(p);
                    break;
                }
            }
        }
    }
    out
}

/// The fingerprint of `entries` (paths relative to the repository root, e.g. `plugins/anti-hall/hooks/api-guard.js`) and their
/// require-closure, plus `.claude-plugin/plugin.json` (read by the settings layer) and the tools' versions.
pub fn fingerprint(entries: &[&str], tools: &[Tool]) -> Fingerprint {
    let root = repo_root();
    let plugin = root.join("plugins/anti-hall");
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut todo: Vec<PathBuf> = entries.iter().map(|e| root.join(e)).collect();
    todo.push(plugin.join(".claude-plugin/plugin.json"));
    while let Some(p) = todo.pop() {
        let Ok(p) = p.canonicalize() else { continue };
        if !seen.insert(p.clone()) {
            continue;
        }
        if is_code(&p)
            && let Ok(src) = std::fs::read_to_string(&p)
        {
            todo.extend(refs(&p, &src, &plugin));
        }
    }
    let parts: Vec<(String, String)> =
        seen.iter().map(|p| (p.strip_prefix(&root).unwrap_or(p).to_string_lossy().to_string(), sha256_hex(&std::fs::read(p).unwrap_or_default()))).collect();
    let tools: BTreeMap<String, String> = tools.iter().map(|t| (t.name().to_string(), t.version())).collect();
    let mut all = String::new();
    for (r, h) in &parts {
        all.push_str(&format!("{r} {h}\n"));
    }
    for (t, v) in &tools {
        all.push_str(&format!("tool {t} {v}\n"));
    }
    Fingerprint { hex: sha256_hex(all.as_bytes()), parts, tools }
}

/// One Node answer: exit code, stdout, stderr, and (for lanes that compare state) the state files Node left, by name
/// (`None`: listed but unreadable).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Answer {
    pub code: String,
    pub out: String,
    pub err: String,
    pub state: BTreeMap<String, Option<String>>,
}

impl Answer {
    /// The same answer with `f` applied to every text (out, err, state names and contents).
    pub fn map(&self, f: impl Fn(&str) -> String) -> Answer {
        Answer {
            code: self.code.clone(),
            out: f(&self.out),
            err: f(&self.err),
            state: self.state.iter().map(|(k, v)| (f(k), v.as_ref().map(|x| f(x)))).collect(),
        }
    }
    fn to_json(&self, id: &str, input: &str) -> Value {
        let mut v = json!({"id": id, "in": input, "code": self.code, "out": self.out, "err": self.err});
        if !self.state.is_empty() {
            v["state"] = json!(self.state);
        }
        v
    }
    fn from_json(v: &Value) -> (String, String, Answer) {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let state =
            v.get("state").and_then(Value::as_object).map(|m| m.iter().map(|(k, x)| (k.clone(), x.as_str().map(str::to_string))).collect()).unwrap_or_default();
        (s("id"), s("in"), Answer { code: s("code"), out: s("out"), err: s("err"), state })
    }
}

/// Placeholder tokens for run-specific text (scratch paths with pids): applied before an answer or input is stored or hashed, and
/// undone on replay. A path also registers its canonical form (`/tmp` is `/private/tmp` on macOS) as `{TOKEN:real}`.
#[derive(Clone, Default)]
pub struct Norm {
    subs: Vec<(String, String)>,
    res: Vec<(Regex, String)>,
}

impl Norm {
    pub fn new() -> Norm {
        Norm::default()
    }
    pub fn path(mut self, p: &Path, tok: &str) -> Norm {
        let raw = p.to_string_lossy().to_string();
        if let Ok(real) = p.canonicalize() {
            let real = real.to_string_lossy().to_string();
            if real != raw {
                self.subs.push((real, format!("{{{tok}:real}}")));
            }
        }
        self.subs.push((raw, format!("{{{tok}}}")));
        // longest first: a home inside the scratch root is replaced before the root
        self.subs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        self
    }
    /// A one-way mask (the masked text cannot be restored on replay, so use it only for text the comparison masks too).
    pub fn re(mut self, re: Regex, tok: &str) -> Norm {
        self.res.push((re, tok.to_string()));
        self
    }
    pub fn apply(&self, s: &str) -> String {
        let mut t = s.to_string();
        for (from, to) in &self.subs {
            if !from.is_empty() {
                t = t.replace(from.as_str(), to);
            }
        }
        for (re, tok) in &self.res {
            t = re.replace_all(&t, tok.as_str()).to_string();
        }
        t
    }
    pub fn undo(&self, s: &str) -> String {
        let mut t = s.to_string();
        // the `:real` tokens first: `{HOME}` is a prefix of `{HOME:real}` only by name, never by text, but keep the order explicit
        let mut subs = self.subs.clone();
        subs.sort_by_key(|(_, tok)| !tok.ends_with(":real}"));
        for (from, to) in &subs {
            t = t.replace(to.as_str(), from);
        }
        t
    }
}

pub fn goldens_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens")
}

/// The case of a case-and-step id `<case>#<step>` (the whole id when it has no step).
fn case_of(id: &str) -> &str {
    id.rsplit_once('#').map_or(id, |(c, _)| c)
}

fn os_tag() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn record_cmd(test: &str) -> String {
    format!("AH_RECORD_NODE=1 cargo nextest run --release --profile record -E 'test(<the lane's test>)'  # lane {test}")
}

struct Loaded {
    fp_hex: String,
    files: BTreeMap<String, String>,
    tools: BTreeMap<String, String>,
    os: String,
    cases: BTreeMap<String, (String, Answer)>,
    volatile: BTreeSet<String>,
}

fn load(test: &str) -> Option<Loaded> {
    let dir = goldens_dir().join(test);
    let m: Value = serde_json::from_slice(&std::fs::read(dir.join("MANIFEST.json")).ok()?).ok()?;
    let smap = |k: &str| -> BTreeMap<String, String> {
        m.get(k)
            .and_then(Value::as_object)
            .map(|o| o.iter().map(|(a, b)| (a.clone(), b.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default()
    };
    let mut cases = BTreeMap::new();
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("cases") && n.ends_with(".jsonl")))
        .collect();
    names.sort();
    for f in names {
        for l in std::fs::read_to_string(&f).ok()?.lines().filter(|l| !l.is_empty()) {
            let (id, inp, a) = Answer::from_json(&serde_json::from_str(l).ok()?);
            cases.insert(id, (inp, a));
        }
    }
    Some(Loaded {
        fp_hex: m.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_string(),
        files: smap("files"),
        tools: smap("tools"),
        os: m.get("os").and_then(Value::as_str).unwrap_or_default().to_string(),
        cases,
        volatile: m.get("volatile").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
    })
}

/// Why a golden no longer matches the code: each changed, added or removed file and tool.
fn stale_reasons(l: &Loaded, fp: &Fingerprint) -> Vec<String> {
    let now: BTreeMap<String, String> = fp.parts.iter().cloned().collect();
    let mut why = Vec::new();
    for (f, h) in &now {
        match l.files.get(f) {
            None => why.push(format!("{f} (new in the closure)")),
            Some(o) if o != h => why.push(format!("{f} changed ({} -> {})", &o[..12.min(o.len())], &h[..12])),
            _ => {}
        }
    }
    for f in l.files.keys().filter(|f| !now.contains_key(*f)) {
        why.push(format!("{f} (left the closure)"));
    }
    for (t, v) in &fp.tools {
        if l.tools.get(t) != Some(v) {
            why.push(format!("tool {t}: {:?} -> {v:?}", l.tools.get(t)));
        }
    }
    why
}

/// The golden of one lane. Thread-safe: a lane's worker pool calls `node` concurrently.
pub struct Golden {
    test: String,
    mode: NodeMode,
    fp: Fingerprint,
    loaded: Option<Loaded>,
    recorded: Mutex<BTreeMap<String, (String, Answer)>>,
    used: Mutex<BTreeSet<String>>,
    problems: Mutex<Vec<String>>,
}

impl Golden {
    /// Open the golden of `test` in the current `mode()`. Replay panics when the golden is missing or stale; on another OS than
    /// the one it was recorded on it falls back to Live (a golden is per OS).
    pub fn open(test: &str, fp: Fingerprint) -> Golden {
        Golden::open_in(test, fp, mode())
    }

    pub fn open_in(test: &str, fp: Fingerprint, mut mode: NodeMode) -> Golden {
        let mut loaded = if mode == NodeMode::Record { None } else { load(test) };
        if mode == NodeMode::Replay {
            let Some(l) = &loaded else {
                panic!("no Node golden for {test} (tests/goldens/{test}). Record it: {}", record_cmd(test));
            };
            let ci = std::env::var("CI").is_ok_and(|v| v == "true");
            let tools_moved = l.tools != fp.tools;
            if l.os != os_tag() || (ci && tools_moved && l.files == fp.parts.iter().cloned().collect::<BTreeMap<String, String>>()) {
                // a golden belongs to the OS and toolchain it was recorded with; a CI runner has its own toolchain, so there the
                // lane runs Node live (the Node code itself must still match: a changed file fails everywhere)
                eprintln!("goldens: {test} was recorded on {} with {:?}; this is {} with {:?}: running Node live", l.os, l.tools, os_tag(), fp.tools);
                mode = NodeMode::Live;
                loaded = None;
            } else if l.fp_hex != fp.hex {
                panic!(
                    "stale Node golden {test}: {}. Re-record: {}, then review git diff tests/goldens/{test}",
                    stale_reasons(l, &fp).join("; "),
                    record_cmd(test)
                );
            }
        }
        if mode == NodeMode::Live && loaded.as_ref().is_some_and(|l| l.fp_hex != fp.hex || l.os != os_tag()) {
            loaded = None; // a stale golden says nothing about this code
        }
        Golden { test: test.into(), mode, fp, loaded, recorded: Mutex::default(), used: Mutex::default(), problems: Mutex::default() }
    }

    pub fn mode(&self) -> NodeMode {
        self.mode
    }

    /// True when the golden lists the case of `id` (`<case>#<step>`) as volatile: every step of it runs Node live.
    pub fn is_volatile(&self, id: &str) -> bool {
        self.loaded.as_ref().is_some_and(|l| l.volatile.contains(case_of(id)))
    }

    /// Node's answer for case `id` (one id per case and step). `input` is everything that determines the answer, already free of
    /// run-specific text except what `norm` replaces; it is stored only as a hash. `live` runs Node.
    pub fn node(&self, id: &str, input: &[u8], norm: &Norm, live: impl FnOnce() -> Answer) -> Answer {
        let in_hash = sha256_hex(norm.apply(&String::from_utf8_lossy(input)).as_bytes())[..16].to_string();
        let volatile = self.is_volatile(id);
        match self.mode {
            NodeMode::Replay if !volatile => {
                self.used.lock().unwrap().insert(id.to_string());
                match self.loaded.as_ref().and_then(|l| l.cases.get(id)) {
                    Some((h, a)) if *h == in_hash => a.map(|s| norm.undo(s)),
                    Some(_) => {
                        self.problems.lock().unwrap().push(format!("{id}: input changed since recording"));
                        Answer { code: "golden-input-changed".into(), ..Answer::default() }
                    }
                    None => {
                        self.problems.lock().unwrap().push(format!("{id}: not in the golden"));
                        Answer { code: "golden-missing".into(), ..Answer::default() }
                    }
                }
            }
            NodeMode::Record => {
                let a = live();
                let prev = self.recorded.lock().unwrap().insert(id.to_string(), (in_hash, a.map(|s| norm.apply(s))));
                if prev.is_some() {
                    self.problems.lock().unwrap().push(format!("{id}: recorded twice (case ids must be unique)"));
                }
                a
            }
            _ => {
                let a = live();
                if !volatile
                    && let Some((h, g)) = self.loaded.as_ref().and_then(|l| l.cases.get(id))
                    && *h == in_hash
                    && *g != a.map(|s| norm.apply(s))
                {
                    self.problems.lock().unwrap().push(format!("{id}: live Node differs from the fresh golden (a file the closure scan missed?)"));
                }
                a
            }
        }
    }

    /// Replay: fail on a missing case or a changed input, and report recorded cases nothing asked for. Live: fail when a live
    /// answer differs from a fresh golden. Record: nothing (see `write_pair`).
    pub fn finish(self) {
        let problems = self.problems.into_inner().unwrap();
        if self.mode == NodeMode::Replay
            && let Some(l) = &self.loaded
        {
            let used = self.used.into_inner().unwrap();
            let unused = l.cases.keys().filter(|k| !used.contains(*k)).count();
            if unused > 0 {
                eprintln!("goldens: {}: {unused} recorded cases were not asked for (a subset run, or a shrunk corpus)", self.test);
            }
        }
        assert!(
            problems.is_empty(),
            "Node golden {}: {} problems, first: {:?}. Re-record: {}",
            self.test,
            problems.len(),
            problems.iter().take(10).collect::<Vec<_>>(),
            record_cmd(&self.test)
        );
    }

    /// Write the golden from two recording passes (run under scratch roots of different path lengths): a case any of whose
    /// steps answered differently between them is volatile, listed by case only, and always runs live.
    pub fn write_pair(a: Golden, b: Golden) -> (usize, usize) {
        let test = a.test.clone();
        let fp = a.fp.clone();
        for g in [&a, &b] {
            let p = g.problems.lock().unwrap();
            assert!(p.is_empty(), "recording {test}: {:?}", p.iter().take(10).collect::<Vec<_>>());
        }
        let ra = a.recorded.into_inner().unwrap();
        let rb = b.recorded.into_inner().unwrap();
        let ids: BTreeSet<&String> = ra.keys().chain(rb.keys()).collect();
        // volatility is per case: a later step of a case cannot be replayed once an earlier one ran live (its state is missing)
        let volatile: BTreeSet<String> = ids.iter().filter(|id| ra.get(id.as_str()) != rb.get(id.as_str())).map(|id| case_of(id).to_string()).collect();
        for id in ids.iter().filter(|id| ra.get(id.as_str()) != rb.get(id.as_str())).take(3) {
            let what = match (ra.get(id.as_str()), rb.get(id.as_str())) {
                (Some(x), Some(y)) if x.0 != y.0 => "input hash".to_string(),
                (Some(x), Some(y)) => format!("answer {:?} vs {:?}", x.1, y.1),
                _ => "asked in one pass only".to_string(),
            };
            eprintln!("goldens: {test}: volatile {id}: {}", what.chars().take(600).collect::<String>());
        }
        let mut lines = Vec::new();
        for id in ids.into_iter().filter(|id| !volatile.contains(case_of(id))) {
            let x = &ra[id];
            lines.push(serde_json::to_string(&x.1.to_json(id, &x.0)).unwrap());
        }
        let dir = goldens_dir().join(&test);
        std::fs::create_dir_all(&dir).unwrap();
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with("cases") {
                std::fs::remove_file(e.path()).unwrap();
            }
        }
        let total: usize = lines.iter().map(|l| l.len() + 1).sum();
        let mut shards: BTreeMap<String, String> = BTreeMap::new();
        for l in &lines {
            let shard = if total > 2_000_000 {
                let id = serde_json::from_str::<Value>(l).unwrap()["id"].as_str().unwrap_or_default().to_string();
                format!("cases-{}.jsonl", id.split(['-', '#']).next().unwrap_or("x").chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
            } else {
                "cases.jsonl".into()
            };
            let s = shards.entry(shard).or_default();
            s.push_str(l);
            s.push('\n');
        }
        for (f, body) in &shards {
            std::fs::write(dir.join(f), body).unwrap();
        }
        let files: BTreeMap<String, String> = fp.parts.iter().cloned().collect();
        let manifest = json!({
            "test": test,
            "fingerprint": fp.hex,
            "files": files,
            "tools": fp.tools,
            "os": os_tag(),
            "cases": lines.len(),
            "volatile": volatile,
            "record": record_cmd(&test),
        });
        std::fs::write(dir.join("MANIFEST.json"), serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
        (lines.len(), volatile.len())
    }
}
