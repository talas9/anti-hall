//! Parity machinery for the handover and Codex hooks (handover-resume, precompact-snapshot, codex-availability,
//! codex-quota-detect, codex-nudge). Each scenario builds a sandbox (a home directory, repositories, transcripts) twice, once
//! for the Node hook and once for the engine's built-in check, runs both on the same payload and environment, and compares
//! exit code, stdout, stderr and the files each run left behind. Paths and timestamps are normalized.

use super::lab::*;
use super::support::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(crate) enum Payload {
    Json(Value),
    Raw(String),
}

impl Payload {
    fn text(&self) -> String {
        match self {
            Payload::Json(v) => v.to_string(),
            Payload::Raw(s) => s.clone(),
        }
    }
}

/// What a scenario's setup decides once the sandbox exists.
#[derive(Default)]
pub(crate) struct Built {
    pub payload: Option<Payload>,
    pub env: Env,
    pub run_cwd: Option<PathBuf>,
}

pub(crate) type Setup = Box<dyn Fn(&Lab, &Path) -> Built + Send + Sync>;

pub(crate) struct Sc {
    pub id: String,
    pub payload: Option<Payload>,
    pub setup: Option<Setup>,
    pub env: Env,
    /// `Some(false)`: the scenario writes no files by design (not counted as a state-changing scenario).
    pub expect_files: Option<bool>,
}

impl Sc {
    pub(crate) fn payload(id: &str, payload: Payload) -> Sc {
        Sc { id: id.into(), payload: Some(payload), setup: None, env: Vec::new(), expect_files: None }
    }
    pub(crate) fn json(id: &str, v: Value) -> Sc {
        Sc::payload(id, Payload::Json(v))
    }
    pub(crate) fn raw(id: &str, s: &str) -> Sc {
        Sc::payload(id, Payload::Raw(s.into()))
    }
    pub(crate) fn setup(id: &str, f: impl Fn(&Lab, &Path) -> Built + Send + Sync + 'static) -> Sc {
        Sc { id: id.into(), payload: None, setup: Some(Box::new(f)), env: Vec::new(), expect_files: None }
    }
    pub(crate) fn env(mut self, k: &str, v: &str) -> Sc {
        self.env = env_merge(&self.env, &vec![(k.into(), Some(v.into()))]);
        self
    }
    pub(crate) fn env_unset(mut self, k: &str) -> Sc {
        self.env = env_merge(&self.env, &vec![(k.into(), None)]);
        self
    }
}

pub(crate) struct Report {
    pub n: usize,
    pub same: usize,
    pub deferred: usize,
    pub mismatch: usize,
    pub node_out: usize,
    pub node_files: usize,
    pub deferred_ids: Vec<String>,
    pub summary: String,
}

fn volatile_key(rel: &str) -> bool {
    rel.ends_with(".tmp") || rel == "logs/jev-assist.ndjson" || rel.ends_with("/logs/jev-assist.ndjson")
}

struct Side {
    root: PathBuf,
    r: Out,
    snap: BTreeMap<String, String>,
}

/// The sandbox environment of a run: the isolated home, the fixed git identity, and the scenario's own variables.
fn sandbox_env(root: &Path, sc: &Sc, built: &Built) -> Env {
    let home = root.join("home").to_string_lossy().to_string();
    let tmp = root.join("tmp").to_string_lossy().to_string();
    let path = std::env::var("PATH").unwrap_or_default();
    let mut env =
        env_of(&[("PATH", &path), ("HOME", &home), ("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_INGEST_DRY_RUN", "1"), ("TMPDIR", &tmp), ("TZ", "UTC")]);
    env = env_merge(&env, &env_of(&GITENV));
    env = env_merge(&env, &sc.env);
    env_merge(&env, &built.env)
}

pub(crate) fn run_lane(name: &str, check: &str, hook_file: &str, hooks: &Path, scenarios: &[Sc], mutate: bool) -> Report {
    let hook = hooks.join(hook_file);
    let scratch = Scratch::new(&format!("b78-{name}"));
    let tmp = scratch.path().to_path_buf();
    let only = std::env::var("AH_PARITY_ONLY").ok();
    let mut rep = Report { n: 0, same: 0, deferred: 0, mismatch: 0, node_out: 0, node_files: 0, deferred_ids: Vec::new(), summary: String::new() };
    let mut mism: Vec<String> = Vec::new();
    for sc in scenarios {
        if only.as_ref().is_some_and(|o| !sc.id.contains(o.as_str())) {
            continue;
        }
        rep.n += 1;
        let lab = Lab { base: (now_ms() / 1000) as i64 };
        let run_sides = || -> Vec<Side> {
            let mut sides: Vec<Side> = Vec::new();
            for side in ["node", "engine"] {
                // both sides run at the SAME absolute path (one after the other) so paths in outputs and encoded directory names agree
                let root = tmp.join(rep.n.to_string());
                wipe(&root);
                std::fs::create_dir_all(root.join("home/.anti-hall")).expect("sandbox");
                let built = sc.setup.as_ref().map(|f| f(&lab, &root)).unwrap_or_default();
                let payload = built.payload.as_ref().or(sc.payload.as_ref());
                let input = payload.map(Payload::text).unwrap_or_default();
                let mut env = sandbox_env(&root, sc, &built);
                env.retain(|(_, v)| v.is_some());
                let cwd = built.run_cwd.clone().unwrap_or_else(|| root.clone());
                let t0 = now_ms();
                let r = if side == "node" {
                    node(&strs(&[&hook.to_string_lossy()]), input.as_bytes(), &env, &cwd.to_string_lossy())
                } else {
                    run(ENGINE, &strs(&["check", check]), input.as_bytes(), &env, &cwd.to_string_lossy())
                };
                let t1 = now_ms();
                let snap = snapshot(&root, (t0 + t1) as f64 / 2.0);
                if side == "node" {
                    let moved = PathBuf::from(format!("{}.node", root.display()));
                    wipe(&moved);
                    std::fs::rename(&root, &moved).expect("keep the node side");
                }
                sides.push(Side { root, r, snap });
            }
            sides
        };
        let mut sides = run_sides();
        // git calls carry a per-call timeout (a load-induced timeout on either side shows up as a
        // one-off difference), so a differing, non-mutated scenario is re-run once; a real
        // divergence reproduces, a timeout does not.
        if !mutate && !sides_equal(&sides) {
            let moved = PathBuf::from(format!("{}.node", sides[0].root.display()));
            wipe(&moved);
            wipe(&sides[1].root);
            sides = run_sides();
        }
        let (n, e) = (&sides[0], &sides[1]);
        let mut nr = Out { code: n.r.code.clone(), out: norm_text(&n.r.out, &n.root.to_string_lossy()), err: norm_text(&n.r.err, &n.root.to_string_lossy()) };
        if mutate {
            nr.out.push_str("~mutant");
        }
        let er = Out { code: e.r.code.clone(), out: norm_text(&e.r.out, &e.root.to_string_lossy()), err: norm_text(&e.r.err, &e.root.to_string_lossy()) };
        if !nr.out.is_empty() {
            rep.node_out += 1;
        }
        let state_files =
            n.snap.keys().filter(|k| !volatile_key(k) && !matches!(k.as_str(), "home/.anti-hall/settings.json" | "home/.anti-hall/skip.json")).count();
        if state_files > 0 && sc.expect_files != Some(false) {
            rep.node_files += 1;
        }
        let moved = PathBuf::from(format!("{}.node", n.root.display()));
        if er.out.trim() == "AHFALLBACK" {
            rep.deferred += 1;
            rep.deferred_ids.push(sc.id.clone());
            wipe(&moved);
            wipe(&e.root);
            continue;
        }
        let strip = |s: &BTreeMap<String, String>| -> BTreeMap<String, String> {
            s.iter().filter(|(k, _)| !volatile_key(k)).map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        let (ns, es) = (strip(&n.snap), strip(&e.snap));
        if nr == er && ns == es {
            rep.same += 1;
        } else {
            rep.mismatch += 1;
            if mism.len() < 500 {
                let mut m = format!(
                    "--- {}\n  node  : {:?}\n  engine: {:?}\n",
                    sc.id,
                    (&nr.code, clip(&nr.out, 400), clip(&nr.err, 200)),
                    (&er.code, clip(&er.out, 400), clip(&er.err, 200))
                );
                for k in ns.keys().chain(es.keys()).collect::<std::collections::BTreeSet<_>>() {
                    if ns.get(k) != es.get(k) {
                        m.push_str(&format!(
                            "  file {k}\n    node  : {}\n    engine: {}\n",
                            diff_window(&format!("{:?}", ns.get(k)), &format!("{:?}", es.get(k)), true),
                            diff_window(&format!("{:?}", ns.get(k)), &format!("{:?}", es.get(k)), false)
                        ));
                    }
                }
                mism.push(m);
            }
        }
        wipe(&moved);
        wipe(&e.root);
    }
    let mut s = format!(
        "{name}: scenarios={} same={} deferred={} MISMATCH={} (node printed output in {}, left files in {})\n",
        rep.n, rep.same, rep.deferred, rep.mismatch, rep.node_out, rep.node_files
    );
    if rep.deferred > 0 {
        s.push_str(&format!("  deferred: {}\n", rep.deferred_ids.iter().take(12).cloned().collect::<Vec<_>>().join(" | ")));
    }
    for m in mism.iter().take(10) {
        s.push_str(m);
    }
    rep.summary = s;
    rep
}

/// Write the corpus the way the sandbox builds it (one fixed clock, one fixed root), for comparison with the corpus a port replaced.
pub(crate) fn dump_lane(name: &str, scenarios: &[Sc]) {
    let Some(dir) = std::env::var_os("AH_PARITY_DUMP") else { return };
    let mut out = String::new();
    let base: i64 = 1_000_000_000;
    for sc in scenarios {
        let root = PathBuf::from("/tmp/ah-dump-root");
        wipe(&root);
        std::fs::create_dir_all(root.join("home/.anti-hall")).expect("sandbox");
        let lab = Lab { base };
        let built = sc.setup.as_ref().map(|f| f(&lab, &root)).unwrap_or_default();
        let payload = built.payload.as_ref().or(sc.payload.as_ref()).map(|p| match p {
            Payload::Json(v) => serde_json::json!({"json": v}),
            Payload::Raw(s) => serde_json::json!({"raw": s}),
        });
        let mut env: BTreeMap<String, Option<String>> = BTreeMap::new();
        for (k, v) in sc.env.iter().chain(built.env.iter()) {
            env.insert(k.clone(), v.as_ref().map(|s| s.replace("/tmp/ah-dump-root", "$R")));
        }
        let mut files: BTreeMap<String, String> = BTreeMap::new();
        fn walk(d: &Path, rel: &str, base: i64, out: &mut BTreeMap<String, String>) {
            use std::os::unix::fs::PermissionsExt;
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                if name == ".git" {
                    out.insert(format!("{r}/"), "<git>".into());
                    continue;
                }
                let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue };
                if md.file_type().is_symlink() {
                    out.insert(
                        r,
                        format!("-> {}", std::fs::read_link(e.path()).map(|p| p.to_string_lossy().replace("/tmp/ah-dump-root", "$R")).unwrap_or_default()),
                    );
                } else if md.is_dir() {
                    out.insert(format!("{r}/"), format!("dir {:o}", md.permissions().mode() & 0o7777));
                    walk(&e.path(), &r, base, out);
                } else {
                    let txt = String::from_utf8_lossy(&std::fs::read(e.path()).unwrap_or_default()).replace("/tmp/ah-dump-root", "$R");
                    let m = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH_ALIAS).ok()).map_or(0, |d| d.as_secs() as i64);
                    // the age against the fixed clock, or the clock itself when the time is not a fixture age
                    let age = if (base - m).abs() < 40 * 86400 * 4 { format!("age {}", base - m) } else { "mtime now".to_string() };
                    out.insert(r, format!("{:o} {age} {txt}", md.permissions().mode() & 0o7777));
                }
            }
        }
        walk(&root, "", base, &mut files);
        out.push_str(&serde_json::to_string(&serde_json::json!({"id": sc.id, "payload": payload, "env": env, "runCwd": built.run_cwd.as_ref().map(|p| p.to_string_lossy().replace("/tmp/ah-dump-root", "$R")), "files": files})).unwrap());
        out.push('\n');
        wipe(&root);
    }
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(Path::new(&dir).join(format!("b78-{name}.scenarios.jsonl")), out).expect("dump");
}

const UNIX_EPOCH_ALIAS: std::time::SystemTime = std::time::UNIX_EPOCH;

pub(crate) fn require(name: &str, check: &str, hook_file: &str, hooks: &Path, scenarios: Vec<Sc>, min: usize) {
    dump_lane(name, &scenarios);
    if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
        return;
    }
    let rep = run_lane(name, check, hook_file, hooks, &scenarios, false);
    println!("{}", rep.summary);
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        let _ = std::fs::write(Path::new(&dir).join(format!("b78-{name}.summary.txt")), &rep.summary);
    }
    assert!(rep.mismatch == 0, "{name}: mismatches:\n{}", rep.summary);
    assert!(rep.n >= min, "{name}: only {} scenarios", rep.n);
    assert!(rep.same > 0, "{name}: nothing compared exactly\n{}", rep.summary);
}

/// A 300-char window of `a` (or `b`) starting 100 chars before the first position where the two differ.
fn diff_window(a: &str, b: &str, first: bool) -> String {
    let at = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let from = at.saturating_sub(100);
    let src = if first { a } else { b };
    format!("@{at}: {}", src.chars().skip(from).take(300).collect::<String>())
}

/// Whether the node and engine sides agree on exit code, normalised output and state files (deferrals count as agreeing).
fn sides_equal(sides: &[Side]) -> bool {
    let (n, e) = (&sides[0], &sides[1]);
    let norm =
        |s: &Side| Out { code: s.r.code.clone(), out: norm_text(&s.r.out, &s.root.to_string_lossy()), err: norm_text(&s.r.err, &s.root.to_string_lossy()) };
    let er = norm(e);
    if er.out.trim() == "AHFALLBACK" {
        return true;
    }
    let strip = |s: &BTreeMap<String, String>| -> BTreeMap<String, String> {
        s.iter().filter(|(k, _)| !volatile_key(k)).map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    norm(n) == er && strip(&n.snap) == strip(&e.snap)
}
