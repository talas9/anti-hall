//! Parity of the six built-in session-maintenance checks (version-alert, devswarm-version, claude-cli-version, repo-self-drift,
//! defect-nudge, progress-prune) against the real Node SessionStart hooks. Unlike the PreToolUse guards these hooks are scripts
//! that read and write files, so a scenario is a whole fixture directory (home, project, plugin root) and the comparison covers
//! three things: exit code, stdout bytes, and the state-file effects.
//!
//! One scenario = {id, hook, files, env, plugin, payload|raw, git, exec, afterGit, bare, cwd, expectDefer, deferOk}. It runs twice on the
//! SAME paths, each time from a freshly built copy of the fixture: first the real Node hook (a preload records every child process it
//! would start and starts none), then `ah-engine check <hook>` with the same environment. Afterwards both directory trees are
//! compared. Same paths on purpose: several state keys (the prune throttle key, the gitignore state key) are derived from a path,
//! so two different fixture paths would differ for no reason.
//!
//! A deferral (`AHFALLBACK`, the engine saying "Node decides") is correct when Node would have started a background probe (the
//! preload logged it) or the scenario says it expects one; every other deferral is reported as unexplained and counted, never
//! silently accepted. When Node started a probe and the engine decided anyway, that is a mismatch.
//!
//! The corpora are data (`session_corpus/<hook>.json`, templates such as `{{NOW-3600000}}` expanded when the fixture is built; the
//! seeded random scenarios of the old generator are frozen there too), so a scenario can be read and changed without code.

use super::jsjson::{J, map_strings, parse, stringify};
use super::support::*;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const HOOKS: [(&str, &str); 6] = [
    ("version-alert", "version-alert.js"),
    ("devswarm-version", "devswarm-version.js"),
    ("claude-cli-version", "claude-cli-version.js"),
    ("repo-self-drift", "repo-self-drift.js"),
    ("defect-nudge", "defect-nudge.js"),
    ("progress-prune", "progress-prune.js"),
];

const CORPORA: [(&str, &str); 6] = [
    ("version-alert", include_str!("session_corpus/version-alert.json")),
    ("devswarm-version", include_str!("session_corpus/devswarm-version.json")),
    ("claude-cli-version", include_str!("session_corpus/claude-cli-version.json")),
    ("repo-self-drift", include_str!("session_corpus/repo-self-drift.json")),
    ("defect-nudge", include_str!("session_corpus/defect-nudge.json")),
    ("progress-prune", include_str!("session_corpus/progress-prune.json")),
];

/// The preload that records every child process a hook would start and starts none (a few lines of JavaScript: it has to run
/// inside the Node process under test, so it cannot be Rust).
const SPY: &str = "'use strict';
const cp = require('child_process'), fs = require('fs'), path = require('path');
cp.spawn = function (cmd, args, opts) {
  try { fs.appendFileSync(process.env.ANTIHALL_SPY_LOG, JSON.stringify({ cmd: path.basename(String(cmd)), script: path.basename(String((args || [])[0] || '')), detached: !!(opts && opts.detached) }) + '\\n'); } catch (_) {}
  return { unref() {}, on() {}, pid: 0 };
};
";

/// Node's `cwdKey` (hooks/progress-prune.js): the 31-hash of the UTF-16 units, in base 36, behind `cwd_`.
fn cwd_key(cwd: &str) -> String {
    let mut hash: i32 = 0;
    for u in cwd.encode_utf16() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(u as i32);
    }
    let mut n = (hash as i64).unsigned_abs();
    let mut digits = Vec::new();
    if n == 0 {
        digits.push(b'0');
    }
    while n > 0 {
        let d = (n % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    digits.reverse();
    format!("cwd_{}", String::from_utf8(digits).expect("ascii digits"))
}

struct Vars {
    now0: i64,
    home: String,
    proj: String,
    base: String,
    plugin: String,
    today: String,
}

/// Replace `{{NOW-ms}} {{NOW+ms}} {{ISO-ms}} {{ISO+ms}} {{HOME}} {{PROJ}} {{BASE}} {{PLUGIN}} {{TODAY}}` and `{{KEY[:path]}}` (the
/// prune throttle key of a working directory, PROJ by default) in fixture text.
fn expand(text: &str, v: &Vars) -> String {
    let first = Regex::new(r"\{\{(NOW|ISO)([-+]\d+)?\}\}|\{\{(HOME|PROJ|BASE|PLUGIN|TODAY)\}\}").unwrap().replace_all(text, |c: &regex::Captures| {
        if let Some(name) = c.get(3) {
            return match name.as_str() {
                "HOME" => v.home.clone(),
                "PROJ" => v.proj.clone(),
                "BASE" => v.base.clone(),
                "PLUGIN" => v.plugin.clone(),
                _ => v.today.clone(),
            };
        }
        let off: i64 = c.get(2).map_or(0, |m| m.as_str().parse().unwrap_or(0));
        let t = v.now0 + off;
        if &c[1] == "NOW" { t.to_string() } else { iso_from_ms(t) }
    });
    Regex::new(r"\{\{KEY(?::([^}]*))?\}\}")
        .unwrap()
        .replace_all(&first, |c: &regex::Captures| cwd_key(c.get(1).map_or(v.proj.as_str(), |m| m.as_str())))
        .to_string()
}

// ---- the frozen corpora ----------------------------------------------------------------------------------------------------

/// The static tokens of a frozen corpus string: `{{HOOKS[+-k]}}` (the number of hook files of this checkout), `{{REP:cp:n}}` (a
/// character repeated) and `{{REPS:unit:n}}` (a percent-encoded unit repeated).
fn pre_expand(s: &str, hooks: i64) -> String {
    if !s.contains("{{") {
        return s.to_string();
    }
    let s1 = Regex::new(r"\{\{HOOKS([-+]\d+)?\}\}").unwrap().replace_all(s, |c: &regex::Captures| {
        let k: i64 = c.get(1).map_or(0, |m| m.as_str().parse().unwrap_or(0));
        (hooks + k).to_string()
    });
    let s2 = Regex::new(r"\{\{REP:([0-9a-f]+):(\d+)\}\}").unwrap().replace_all(&s1, |c: &regex::Captures| {
        let ch = char::from_u32(u32::from_str_radix(&c[1], 16).unwrap_or(0x78)).unwrap_or('x');
        ch.to_string().repeat(c[2].parse().unwrap_or(0))
    });
    Regex::new(r"\{\{REPS:([^:}]*):(\d+)\}\}")
        .unwrap()
        .replace_all(&s2, |c: &regex::Captures| {
            let mut unit = Vec::new();
            let b = c[1].as_bytes();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' && i + 2 < b.len() {
                    unit.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("00"), 16).unwrap_or(0));
                    i += 3;
                } else {
                    unit.push(b[i]);
                    i += 1;
                }
            }
            String::from_utf8_lossy(&unit).repeat(c[2].parse().unwrap_or(0))
        })
        .to_string()
}

fn is_undef(j: &J) -> bool {
    matches!(j, J::Obj(o) if o.len() == 1 && o[0].0 == "$undef")
}

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        if let Some(v) = val(c) {
            acc = (acc << 6) | v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
    }
    out
}

/// One scenario of a frozen corpus.
struct Sc {
    j: J,
}

impl Sc {
    fn field(&self, k: &str) -> Option<&J> {
        self.j.get(k).filter(|v| !is_undef(v))
    }
    fn id(&self) -> String {
        match self.field("id") {
            Some(J::Str(s)) => s.clone(),
            _ => String::new(),
        }
    }
    fn str_field(&self, k: &str) -> Option<String> {
        match self.field(k) {
            Some(J::Str(s)) => Some(s.clone()),
            _ => None,
        }
    }
    fn flag(&self, k: &str) -> bool {
        matches!(self.field(k), Some(J::Bool(true)))
    }
}

fn load(hook: &str, hooks_count: i64) -> Vec<Sc> {
    let text = CORPORA.iter().find(|(h, _)| *h == hook).map(|(_, t)| *t).expect("a corpus for the hook");
    let j = parse(text).expect("the corpus is valid JSON");
    let J::Arr(list) = map_strings(j, &|s| pre_expand(s, hooks_count)) else { panic!("a corpus is an array") };
    list.into_iter().map(|j| Sc { j }).collect()
}

// ---- fixtures ---------------------------------------------------------------------------------------------------------------

fn spec_content(spec: &J, v: &Vars) -> Vec<u8> {
    let text = |t: &J| -> Vec<u8> {
        match t {
            J::Obj(o) if o.len() == 1 && o[0].0 == "$b64" => match &o[0].1 {
                J::Str(s) => b64(s),
                _ => Vec::new(),
            },
            J::Str(s) => expand(s, v).into_bytes(),
            // a value the corpus left undefined was written as the text "undefined"
            x if is_undef(x) => b"undefined".to_vec(),
            other => expand(&js_string(other), v).into_bytes(),
        }
    };
    match spec {
        J::Obj(o) if !(o.len() == 1 && (o[0].0 == "$b64" || o[0].0 == "$undef")) => {
            o.iter().find(|(k, _)| k == "content").map_or_else(|| b"undefined".to_vec(), |(_, c)| text(c))
        }
        other => text(other),
    }
}

/// `String(value)` for the scalars a fixture can hold.
fn js_string(j: &J) -> String {
    match j {
        J::Null => "null".into(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => super::jsjson::js_number(*n),
        J::Str(s) => s.clone(),
        other => stringify(other),
    }
}

fn build_tree(base: &Path, files: Option<&J>, v: &Vars) {
    let Some(J::Obj(files)) = files else { return };
    for (rel0, spec) in files {
        let rel = expand(rel0, v);
        // `path.join(base, rel)`: lexically normalised ("dir/." names `dir`), and an absolute-looking `rel` stays below `base`
        let full = std::path::PathBuf::from(path_join(&[&base.to_string_lossy(), &rel]));
        if rel.ends_with('/') {
            std::fs::create_dir_all(&full).expect("fixture directory");
            continue;
        }
        let parent = full.parent().expect("a file has a parent");
        if let Err(e) = std::fs::create_dir_all(parent) {
            panic!("fixture directory {}: {e}", parent.display());
        }
        if let J::Obj(o) = spec
            && let Some((_, link)) = o.iter().find(|(k, _)| k == "link")
        {
            std::os::unix::fs::symlink(expand(&js_string(link), v), &full).expect("fixture symlink");
            continue;
        }
        if let Err(e) = std::fs::write(&full, spec_content(spec, v)) {
            panic!("fixture file {}: {e}", full.display());
        }
        if let J::Obj(o) = spec
            && !(o.len() == 1 && (o[0].0 == "$b64" || o[0].0 == "$undef"))
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some((_, J::Num(m))) = o.iter().find(|(k, _)| k == "mode") {
                std::fs::set_permissions(&full, std::fs::Permissions::from_mode(*m as u32)).expect("fixture mode");
            }
            if let Some((_, J::Num(off))) = o.iter().find(|(k, _)| k == "mtimeOffset") {
                set_mtime(&full, (v.now0 as f64 + off) / 1000.0);
            }
        }
    }
}

type Tree = BTreeMap<String, (String, String)>;

/// A tree: relative path to (type, text or target); `.git` internals are left out near the top (the hooks only read them).
fn snapshot(base: &Path) -> Tree {
    let mut out = Tree::new();
    fn walk(dir: &Path, rel: &str, out: &mut Tree) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let r0 = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            let r = match n.find(".tmp.") {
                Some(i) if n[i + 5..].bytes().all(|b| b.is_ascii_digit()) && n.len() > i + 5 => format!("{}.tmp.<pid>", &r0[..r0.len() - (n.len() - i)]),
                _ => r0,
            };
            let full = dir.join(&n);
            if n == ".git" && rel.split('/').count() <= 2 {
                out.insert(r, ("dir".into(), String::new()));
                continue;
            }
            let Ok(md) = std::fs::symlink_metadata(&full) else { continue };
            if md.file_type().is_symlink() {
                out.insert(r, ("link".into(), std::fs::read_link(&full).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()));
            } else if md.is_dir() {
                out.insert(r.clone(), ("dir".into(), String::new()));
                walk(&full, &r, out);
            } else {
                let t = std::fs::read(&full).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_else(|_| "<unreadable>".into());
                out.insert(r, ("file".into(), t));
            }
        }
    }
    walk(base, "", &mut out);
    out
}

/// Times the hook wrote itself differ by a few milliseconds between the two runs: epoch-millisecond numbers and ISO timestamps
/// near `now0` that the fixture did not write are replaced by a token, so that only their presence and place count.
struct Normalizer {
    known: BTreeSet<String>,
    now0: i64,
    ms: Regex,
    iso: Regex,
}

impl Normalizer {
    fn new(fixture_text: &str, now0: i64) -> Normalizer {
        let ms = Regex::new(r"\b1[67]\d{11}\b").unwrap();
        let iso = Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap();
        let known = ms.find_iter(fixture_text).chain(iso.find_iter(fixture_text)).map(|m| m.as_str().to_string()).collect();
        Normalizer { known, now0, ms, iso }
    }
    fn apply(&self, text: &str) -> String {
        let a = self.ms.replace_all(text, |c: &regex::Captures| {
            let m = &c[0];
            if !self.known.contains(m) && (m.parse::<i64>().unwrap_or(0) - self.now0).abs() < 120_000 { "<NOW>".to_string() } else { m.to_string() }
        });
        self.iso
            .replace_all(&a, |c: &regex::Captures| {
                let m = &c[0];
                if !self.known.contains(m) && super::lab::iso_ms(m).is_some_and(|t| (t - self.now0).abs() < 120_000) {
                    "<ISO>".to_string()
                } else {
                    m.to_string()
                }
            })
            .to_string()
    }
}

fn diff_trees(a: &Tree, b: &Tree, norm: &Normalizer) -> Vec<String> {
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    let mut diffs = Vec::new();
    for k in keys {
        let (Some(x), Some(y)) = (a.get(k), b.get(k)) else {
            diffs.push(format!("{k}: {}", if a.contains_key(k) { "only in node" } else { "only in engine" }));
            continue;
        };
        if x.0 != y.0 {
            diffs.push(format!("{k}: type {} vs {}", x.0, y.0));
            continue;
        }
        if x.0 == "file" && norm.apply(&x.1) != norm.apply(&y.1) {
            diffs.push(format!("{k}: node={:?} engine={:?}", clip(&norm.apply(&x.1), 300), clip(&norm.apply(&y.1), 300)));
        }
        if x.0 == "link" && x.1 != y.1 {
            diffs.push(format!("{k}: link {} vs {}", x.1, y.1));
        }
    }
    diffs
}

/// A plugin root is a real copy (Node resolves symlinks, so a link would read the template's files). The spec describes the
/// variations a hook reads: the running version, the KB text and where it sits, extra hook files and skill directories.
fn plugin_root(tmp: &Path, repo: &Path, spec: Option<&J>, cache: &Mutex<BTreeMap<String, PathBuf>>) -> PathBuf {
    let key = spec.map_or("{}".to_string(), stringify);
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = guard.get(&key) {
        return p.clone();
    }
    let id = guard.len();
    let top = tmp.join(format!("plug{id}"));
    let root = top.join("plugins/anti-hall");
    std::fs::create_dir_all(&root).expect("plugin root");
    let src = repo.join("plugins/anti-hall");
    for d in ["hooks", "companion", ".claude-plugin"] {
        let st = std::process::Command::new("cp").arg("-R").arg(src.join(d)).arg(root.join(d)).status().expect("cp");
        assert!(st.success(), "copying {d} failed");
    }
    std::fs::create_dir_all(root.join("skills")).expect("skills");
    let st = std::process::Command::new("cp").arg("-R").arg(src.join("skills/update")).arg(root.join("skills/update")).status().expect("cp");
    assert!(st.success(), "copying skills/update failed");
    let get = |k: &str| spec.and_then(|s| s.get(k)).filter(|v| !is_undef(v));
    let pj = root.join(".claude-plugin/plugin.json");
    match get("pluginJson") {
        Some(J::Null) => std::fs::remove_file(&pj).expect("remove plugin.json"),
        Some(J::Str(t)) => std::fs::write(&pj, t).expect("plugin.json"),
        _ => {
            if let Some(J::Str(ver)) = get("version") {
                let mut j = parse(&std::fs::read_to_string(&pj).expect("plugin.json")).expect("valid plugin.json");
                j.set("version", J::Str(ver.clone()));
                std::fs::write(&pj, stringify(&j)).expect("plugin.json");
            }
        }
    }
    let list = |k: &str| -> Vec<String> {
        match get(k) {
            Some(J::Arr(a)) => a.iter().map(js_string).collect(),
            _ => Vec::new(),
        }
    };
    for n in list("extraHooks") {
        std::fs::write(root.join("hooks").join(n), "").expect("extra hook");
    }
    for n in list("removeHooks") {
        std::fs::remove_dir_all(root.join("hooks").join(&n)).ok();
        std::fs::remove_file(root.join("hooks").join(n)).ok();
    }
    for n in list("skillDirs") {
        std::fs::create_dir_all(root.join("skills").join(n)).expect("skill dir");
    }
    for n in list("skillFiles") {
        std::fs::write(root.join("skills").join(n), "").expect("skill file");
    }
    if let Some(J::Obj(links)) = get("skillLinks") {
        for (n, t) in links {
            std::os::unix::fs::symlink(js_string(t), root.join("skills").join(n)).expect("skill link");
        }
    }
    if let Some(J::Str(kb)) = get("kbInstalled") {
        write_file(&root.join("docs/KB.md"), kb.as_bytes());
    }
    if get("kbInstalledDir").is_some_and(|v| matches!(v, J::Bool(true))) {
        std::fs::create_dir_all(root.join("docs/KB.md")).expect("kb dir");
    }
    if let Some(J::Str(kb)) = get("kbRepo") {
        write_file(&top.join("docs/KB.md"), kb.as_bytes());
    }
    guard.insert(key, root.clone());
    root
}

#[derive(Default, Debug)]
pub(crate) struct Stats {
    pub scenarios: usize,
    pub same: usize,
    pub same_out: usize,
    pub same_state: usize,
    pub defer_explained: usize,
    pub defer_fuzz: usize,
    pub defer_unexplained: usize,
    pub unneeded: usize,
    pub mismatch: usize,
    pub node_out: usize,
    pub node_state: usize,
    pub spawned: usize,
}

pub(crate) struct Report {
    pub stats: Stats,
    pub summary: String,
}

pub(crate) fn run_hook(hook: &str, hooks_dir: &Path, repo: &Path, mutate: Option<usize>) -> Report {
    let hooks_count =
        std::fs::read_dir(hooks_dir).map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".js")).count()).unwrap_or(0) as i64;
    let mut scenarios = load(hook, hooks_count);
    if let Some(n) = mutate {
        scenarios.truncate(n);
    }
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        let ids: String = scenarios.iter().map(|s| format!("{}\n", s.id())).collect();
        std::fs::create_dir_all(&dir).ok();
        std::fs::write(Path::new(&dir).join(format!("session-{hook}.ids")), ids).expect("dump");
        if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
            return Report { stats: Stats::default(), summary: String::new() };
        }
    }
    let scratch = Scratch::new(&format!("s-{hook}"));
    let tmp = scratch.path().to_path_buf();
    write_file(&tmp.join("spy.js"), SPY.as_bytes());
    let cache = Mutex::new(BTreeMap::new());
    let hook_file = HOOKS.iter().find(|(h, _)| *h == hook).map(|(_, f)| *f).expect("a known hook");
    // plugin roots are built up front (serially), so scenarios only read them
    let roots: Vec<PathBuf> = scenarios.iter().map(|s| plugin_root(&tmp, repo, s.field("plugin"), &cache)).collect();
    let stats = Mutex::new(Stats::default());
    let mism: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let unexplained: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let counter = std::sync::atomic::AtomicUsize::new(0);
    let base_path = std::env::var("PATH").unwrap_or_default();
    let items: Vec<(usize, &Sc)> = scenarios.iter().enumerate().collect();
    pool(&items, 6, |(i, sc), _| {
        let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let base = tmp.join(format!("sc{n}"));
        let root = &roots[*i];
        let now0 = now_ms() as i64;
        let vars = Vars {
            now0,
            home: base.join("home").to_string_lossy().to_string(),
            proj: base.join("proj").to_string_lossy().to_string(),
            base: base.to_string_lossy().to_string(),
            plugin: root.to_string_lossy().to_string(),
            today: iso_from_ms(now0)[..10].to_string(),
        };
        let build = || {
            std::fs::create_dir_all(&vars.home).expect("home");
            if !sc.flag("bare") {
                std::fs::create_dir_all(Path::new(&vars.home).join(".anti-hall")).expect("state dir");
            }
            build_tree(&base, sc.field("files"), &vars);
            if let Some(J::Arr(g)) = sc.field("git") {
                for d in g {
                    let dir = base.join(js_string(d));
                    std::fs::create_dir_all(&dir).expect("repo dir");
                    let st = std::process::Command::new("git")
                        .args(["init", "-q"])
                        .arg(&dir)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .expect("git");
                    assert!(st.success(), "git init failed");
                }
            }
            if let Some(J::Arr(cmds)) = sc.field("exec") {
                for c in cmds {
                    let J::Arr(parts) = c else { continue };
                    let parts: Vec<String> = parts.iter().map(|p| expand(&js_string(p), &vars)).collect();
                    let st = std::process::Command::new(&parts[0])
                        .args(&parts[1..])
                        .current_dir(&base)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .env("GIT_AUTHOR_NAME", "a")
                        .env("GIT_AUTHOR_EMAIL", "a@b")
                        .env("GIT_COMMITTER_NAME", "a")
                        .env("GIT_COMMITTER_EMAIL", "a@b")
                        .env("GIT_AUTHOR_DATE", "2020-01-01T00:00:00Z")
                        .env("GIT_COMMITTER_DATE", "2020-01-01T00:00:00Z")
                        .status()
                        .expect("fixture command");
                    assert!(st.success(), "fixture command {parts:?} failed");
                }
            }
            if let Some(J::Obj(after)) = sc.field("afterGit") {
                for (rel, text) in after {
                    write_file(&base.join(rel), expand(&js_string(text), &vars).as_bytes());
                }
            }
        };
        // the payload: the SessionStart defaults with the scenario's members laid over them; every string is expanded
        let payload_text = match sc.str_field("raw") {
            Some(raw) => expand(&raw, &vars),
            None => {
                let mut p = super::jsjson::o(vec![
                    ("hook_event_name", super::jsjson::s("SessionStart")),
                    ("session_id", super::jsjson::s("sess-1")),
                    ("cwd", super::jsjson::s(&vars.proj)),
                ]);
                if let Some(J::Obj(extra)) = sc.field("payload") {
                    for (k, v) in extra {
                        if is_undef(v) {
                            p.remove(k);
                        } else {
                            p.set(k, map_strings(v.clone(), &|t| expand(t, &vars)));
                        }
                    }
                }
                p.text()
            }
        };
        let mut env: Env = env_of(&[("PATH", &base_path), ("HOME", &vars.home), ("USERPROFILE", &vars.home), ("ANTIHALL_TEST_ISOLATION", "1")]);
        if let Some(J::Obj(e)) = sc.field("env") {
            for (k, v) in e {
                let value = match v {
                    J::Null => None,
                    other if is_undef(other) => Some(expand("undefined", &vars)),
                    other => Some(expand(&js_string(other), &vars)),
                };
                env = env_merge(&env, &vec![(k.clone(), value)]);
            }
        }
        let fixture_text = {
            let part = |k: &str| sc.field(k).map_or("null".to_string(), |v| stringify(&strip_undef(v.clone())));
            format!("[{},{},{},{}]{payload_text}", part("files"), part("afterGit"), part("payload"), part("raw"))
        };
        let norm = Normalizer::new(&fixture_text, now0);
        let run_cwd = sc.str_field("cwd").map_or("/tmp".to_string(), |c| expand(&c, &vars));
        stats.lock().unwrap_or_else(|e| e.into_inner()).scenarios += 1;
        // One attempt: Node on a fresh copy of the fixture, then the engine on another, on the same paths. A scenario whose fake `git`
        // races the probe deadline (`fake-git`) is attempted once more when the first attempt disagreed: under load the two probes can
        // straddle their deadlines, which is a timing artefact and not a difference between the hook and the check.
        let attempt = || {
            // 1. Node
            build();
            let init_tree = snapshot(&base);
            let spy_log = tmp.join(format!("spy{n}.log"));
            std::fs::remove_file(&spy_log).ok();
            let mut node_res = node(
                &strs(&["-r", &tmp.join("spy.js").to_string_lossy(), &root.join("hooks").join(hook_file).to_string_lossy()]),
                payload_text.as_bytes(),
                &env_merge(&env, &env_of(&[("ANTIHALL_SPY_LOG", &spy_log.to_string_lossy())])),
                &run_cwd,
            );
            if mutate.is_some() {
                node_res.out.push_str("~mutant");
            }
            let spawned: Vec<String> = std::fs::read_to_string(&spy_log).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
            let node_tree = snapshot(&base);
            wipe(&base);
            // 2. the engine, on a fresh copy of the same fixture
            build();
            let eng_res = run(
                ENGINE,
                &strs(&["check", hook]),
                payload_text.as_bytes(),
                &env_merge(&env, &env_of(&[("AH_ENGINE_PLUGIN_ROOT", &root.to_string_lossy()), ("AH_ENGINE_GITIGNORE_PROBE_MS", "2200")])),
                &run_cwd,
            );
            let eng_tree = snapshot(&base);
            wipe(&base);
            (init_tree, node_res, spawned, node_tree, eng_res, eng_tree)
        };
        let mut first = attempt();
        if sc.id().contains("fake-git") {
            let (_, nr, sp, nt, er, et) = &first;
            let disagreed =
                er.out.trim() != "AHFALLBACK" && (nr.code != er.code || nr.out != er.out || !sp.is_empty() || !diff_trees(nt, et, &norm).is_empty());
            if disagreed {
                first = attempt();
            }
        }
        let (init_tree, node_res, spawned, node_tree, eng_res, eng_tree) = first;
        let mut st = stats.lock().unwrap_or_else(|e| e.into_inner());
        if !node_res.out.is_empty() {
            st.node_out += 1;
        }
        if !spawned.is_empty() {
            st.spawned += 1;
        }
        let node_changed = !diff_trees(&init_tree, &node_tree, &norm).is_empty();
        if node_changed {
            st.node_state += 1;
        }
        if eng_res.out.trim() == "AHFALLBACK" {
            let touched = diff_trees(&init_tree, &eng_tree, &norm);
            if !touched.is_empty() {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{}: the engine deferred AND changed state: {}", sc.id(), touched.join(" ; ")));
                return;
            }
            if !spawned.is_empty() || sc.flag("expectDefer") {
                st.defer_explained += 1;
            } else if sc.flag("deferOk") {
                st.defer_fuzz += 1;
            } else {
                st.defer_unexplained += 1;
                if node_res.out.is_empty() && !node_changed {
                    st.unneeded += 1;
                }
                unexplained.lock().unwrap_or_else(|e| e.into_inner()).push(sc.id());
            }
            return;
        }
        let mut problems: Vec<String> = Vec::new();
        if node_res.code != eng_res.code {
            problems.push(format!("exit node={} engine={} nodeStderr={:?}", node_res.code, eng_res.code, clip(&node_res.err, 400)));
        }
        if node_res.out != eng_res.out {
            problems.push(format!("stdout node={:?} engine={:?}", clip(&node_res.out, 400), clip(&eng_res.out, 400)));
        }
        if !spawned.is_empty() {
            problems.push(format!("node started a background process ({}) but the engine decided", clip(&spawned.join("; "), 200)));
        }
        problems.extend(diff_trees(&node_tree, &eng_tree, &norm));
        if problems.is_empty() {
            st.same += 1;
            if !node_res.out.is_empty() {
                st.same_out += 1;
            }
            if node_changed {
                st.same_state += 1;
            }
        } else {
            st.mismatch += 1;
            mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{}: {}", sc.id(), problems.join(" | ")));
        }
    });
    let stats = stats.into_inner().unwrap_or_else(|e| e.into_inner());
    let unexplained = unexplained.into_inner().unwrap_or_else(|e| e.into_inner());
    let mism = mism.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut summary = format!(
        "{hook}: scenarios={} same={} (with advisory: {}, with state change: {}) deferred(explained)={} deferred(fuzz, shapes the engine hands to Node)={} deferred(unexplained)={} (node silent&unchanged: {}) MISMATCH={}\n  node: with-output={} state-changed={} started-a-probe={}\n",
        stats.scenarios,
        stats.same,
        stats.same_out,
        stats.same_state,
        stats.defer_explained,
        stats.defer_fuzz,
        stats.defer_unexplained,
        stats.unneeded,
        stats.mismatch,
        stats.node_out,
        stats.node_state,
        stats.spawned
    );
    if !unexplained.is_empty() {
        summary.push_str(&format!("  unexplained deferrals: {}\n", unexplained.iter().take(40).cloned().collect::<Vec<_>>().join(" | ")));
    }
    for m in mism.iter().take(25) {
        summary.push_str(&format!("  MISMATCH {m}\n"));
    }
    drop(scratch);
    Report { stats, summary }
}

/// `JSON.stringify` drops undefined members and prints undefined array items as null.
fn strip_undef(j: J) -> J {
    match j {
        J::Obj(o) => J::Obj(o.into_iter().filter(|(_, v)| !is_undef(v)).map(|(k, v)| (k, strip_undef(v))).collect()),
        J::Arr(a) => J::Arr(a.into_iter().map(|v| if is_undef(&v) { J::Null } else { strip_undef(v) }).collect()),
        other => other,
    }
}

pub(crate) fn require(hook: &str, hooks_dir: &Path, min: usize) {
    let repo = repo_root().canonicalize().expect("the repository root");
    let rep = run_hook(hook, hooks_dir, &repo, None);
    if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
        return;
    }
    println!("{}", rep.summary);
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        std::fs::write(Path::new(&dir).join(format!("session-{hook}.summary.txt")), &rep.summary).ok();
    }
    assert_eq!(rep.stats.mismatch, 0, "{hook}: mismatches:\n{}", rep.summary);
    assert!(rep.stats.scenarios >= min, "{hook}: only {} scenarios", rep.stats.scenarios);
    assert!(rep.stats.same > 0, "{hook}: nothing compared exactly\n{}", rep.summary);
}
