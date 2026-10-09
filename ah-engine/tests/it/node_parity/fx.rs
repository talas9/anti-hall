//! Parity machinery for ported hooks whose behaviour is FILE EFFECTS plus an exit code and stdout (task-lifecycle-log,
//! task-tracker, dispatch-tier, task-guard, tasklist-guard). The real Node hook is run as a subprocess with an isolated HOME
//! (`ANTIHALL_TEST_ISOLATION=1`, `ANTIHALL_INGEST_DRY_RUN=1`) in one world directory, the engine's built-in check
//! (`ah-engine check <name>`, one process per call) in an identical second world, and the two are compared on exit code, stdout
//! and the whole file tree each world holds afterwards (paths made world-relative, ISO timestamps masked).
//!
//! A scenario is {id, world, steps: [{payload | raw, env, before}]}. A world is {files, dirs, links, gitdirs, modes}; paths are
//! relative to the world root W, with W/home as HOME and W/proj as the default working directory. The tokens `$W`, `$HOME`,
//! `$PROJ` in a payload string (any depth) or a link target are replaced by the world's paths. `before(worldRoot)` may mutate the
//! world between steps (both worlds).
//!
//! Engine answers: `AHFALLBACK` on stdout is a deferral (the dispatcher would then run the Node hook), so the Node hook is run in
//! the engine world too, keeping both worlds in step; deferrals are counted, never hidden. Anything else must equal Node exactly:
//! that is a MISMATCH otherwise.

use super::jsjson::{J, map_strings};
use super::support::*;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

/// Decides whether a deferral of a step is allowed.
pub type MayDefer = Box<dyn Fn(&Scenario, &Step) -> bool + Send + Sync>;

static BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""decision"\s*:\s*"block""#).expect("block-decision pattern"));

#[derive(Clone, Default)]
pub(crate) struct World {
    /// `None` body: an empty file.
    pub files: Vec<(String, Option<String>)>,
    pub dirs: Vec<String>,
    pub links: Vec<(String, String)>,
    pub gitdirs: Vec<String>,
    pub modes: Vec<(String, String)>,
}

impl World {
    pub(crate) fn new() -> World {
        World::default()
    }
    pub(crate) fn file(mut self, rel: &str, body: &str) -> World {
        self.files.push((rel.into(), Some(body.into())));
        self
    }
    pub(crate) fn dir(mut self, rel: &str) -> World {
        self.dirs.push(rel.into());
        self
    }
    pub(crate) fn link(mut self, rel: &str, target: &str) -> World {
        self.links.push((rel.into(), target.into()));
        self
    }
    pub(crate) fn git(mut self, rel: &str) -> World {
        self.gitdirs.push(rel.into());
        self
    }
    pub(crate) fn mode(mut self, rel: &str, octal: &str) -> World {
        self.modes.push((rel.into(), octal.into()));
        self
    }
}

pub(crate) type Before = Arc<dyn Fn(&Path) + Send + Sync>;

#[derive(Clone, Default)]
pub(crate) struct Step {
    pub payload: Option<J>,
    pub raw: Option<String>,
    pub env: Env,
    pub before: Option<Before>,
}

impl Step {
    pub(crate) fn payload(p: J) -> Step {
        Step { payload: Some(p), ..Step::default() }
    }
    pub(crate) fn raw(r: &str) -> Step {
        Step { raw: Some(r.into()), ..Step::default() }
    }
    pub(crate) fn env(mut self, k: &str, v: &str) -> Step {
        self.env.push((k.into(), Some(v.into())));
        self
    }
}

#[derive(Clone)]
pub(crate) struct Scenario {
    pub id: String,
    pub world: World,
    pub steps: Vec<Step>,
    pub expect_defer: bool,
    pub answer_when_silent: bool,
    pub answer_when_no_block: bool,
    /// The Node hook also starts a detached worker whose files land after it exits (the Jev ask): the tree comparison leaves the
    /// worker's log out and masks the request-marker times, and the engine must still answer.
    pub async_effects: bool,
}

impl Scenario {
    pub(crate) fn new(id: &str, world: World, steps: Vec<Step>) -> Scenario {
        Scenario { id: id.into(), world, steps, expect_defer: false, answer_when_silent: false, answer_when_no_block: false, async_effects: false }
    }
    /// One step with a payload.
    pub(crate) fn one(id: &str, payload: J, world: &World) -> Scenario {
        Scenario::new(id, world.clone(), vec![Step::payload(payload)])
    }
    pub(crate) fn async_effects(mut self) -> Scenario {
        self.async_effects = true;
        self
    }
}

pub(crate) struct Opts {
    pub name: &'static str,
    pub hook_file: &'static str,
    pub check: &'static str,
    pub node_args: Vec<String>,
    pub extra_env: Env,
    pub skip: Option<fn(&str) -> bool>,
    pub mask_out: Option<fn(&str) -> String>,
    /// When given, a deferral it does not allow is a MISMATCH (the engine must answer).
    pub may_defer: Option<MayDefer>,
    pub conc: usize,
    /// Self-test of the harness: Node's stdout is altered before it is compared.
    pub mutate: bool,
}

impl Opts {
    pub(crate) fn new(name: &'static str, hook_file: &'static str, check: &'static str) -> Opts {
        Opts { name, hook_file, check, node_args: Vec::new(), extra_env: Vec::new(), skip: None, mask_out: None, may_defer: None, conc: 6, mutate: false }
    }
}

#[derive(Default, Debug, Clone)]
pub(crate) struct Stats {
    pub scenarios: usize,
    pub steps: usize,
    pub same: usize,
    pub deferred: usize,
    pub unneeded: usize,
    pub mismatch: usize,
    pub node_out: usize,
    pub node_blocks: usize,
    pub effects: usize,
}

pub(crate) struct Report {
    pub stats: Stats,
    pub summary: String,
}

fn subst(v: J, w: &Path) -> J {
    let home = w.join("home").to_string_lossy().to_string();
    let proj = w.join("proj").to_string_lossy().to_string();
    let ws = w.to_string_lossy().to_string();
    map_strings(v, &|s| subst_str(s, &home, &proj, &ws))
}

fn subst_str(s: &str, home: &str, proj: &str, w: &str) -> String {
    s.replace("$HOME", home).replace("$PROJ", proj).replace("$W", w)
}

fn build(w: &Path, spec: &World) {
    std::fs::create_dir_all(w.join("home/.anti-hall")).expect("home");
    std::fs::create_dir_all(w.join("proj")).expect("proj");
    for d in &spec.dirs {
        std::fs::create_dir_all(w.join(d)).expect("dir");
    }
    for g in &spec.gitdirs {
        std::fs::create_dir_all(w.join(g).join(".git")).expect("gitdir");
    }
    let (home, proj, ws) = (w.join("home").to_string_lossy().to_string(), w.join("proj").to_string_lossy().to_string(), w.to_string_lossy().to_string());
    for (rel, body) in &spec.files {
        write_file(&w.join(rel), body.as_ref().map_or(String::new(), |b| subst_str(b, &home, &proj, &ws)).as_bytes());
    }
    for (rel, t) in &spec.links {
        let f = w.join(rel);
        std::fs::create_dir_all(f.parent().expect("a link has a parent")).expect("dir");
        std::os::unix::fs::symlink(subst_str(t, &home, &proj, &ws), &f).expect("link");
    }
    for (rel, m) in &spec.modes {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(w.join(rel), std::fs::Permissions::from_mode(u32::from_str_radix(m, 8).unwrap_or(0o755))).expect("mode");
    }
}

/// The tree under W as path to content. Directories are listed as `<dir>`; symlinks as `-> target`.
fn snapshot(w: &Path, skip: Option<fn(&str) -> bool>, async_effects: bool) -> BTreeMap<String, String> {
    let ws = w.to_string_lossy().to_string();
    let ts = Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap();
    let sweep = Regex::new(r#""lastSweep":\d+"#).unwrap();
    let tsn = Regex::new(r#""ts":\d{12,}"#).unwrap();
    let project = Regex::new(r#""project":"[ne]\d+""#).unwrap();
    let clock = Regex::new(r":\d{12,13}([,}\]])").unwrap();
    let mut out = BTreeMap::new();
    #[allow(clippy::too_many_arguments)]
    fn walk(d: &Path, rel: &str, ws: &str, skip: Option<fn(&str) -> bool>, res: &[&Regex; 5], asynchronous: bool, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let p = d.join(&n);
            let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            if r.ends_with(".anti-hall/ah-engine") {
                continue; // the engine's own state dir (its telemetry): Node has nothing to compare it with
            }
            if skip.is_some_and(|f| f(&r)) || (asynchronous && r.ends_with("logs/jev-assist.ndjson")) {
                continue;
            }
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                let t = std::fs::read_link(&p).map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                out.insert(r, format!("-> {}", t.replace(ws, "<W>")));
            } else if md.is_dir() {
                // the async jev-assist writer creates this directory late (or not at all) on either side
                if !(asynchronous && r == "home/.anti-hall/logs") {
                    out.insert(r.clone(), "<dir>".into());
                }
                walk(&p, &r, ws, skip, res, asynchronous, out);
            } else {
                let t = String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()).replace(ws, "<W>");
                let t = res[0].replace_all(&t, "<TS>").to_string();
                let t = res[1].replace_all(&t, "\"lastSweep\":<N>").to_string();
                let t = res[2].replace_all(&t, "\"ts\":<N>").to_string();
                let t = res[3].replace_all(&t, "\"project\":\"<W>\"").to_string();
                let t = if asynchronous { res[4].replace_all(&t, ":<N>$1").to_string() } else { t };
                out.insert(r, t);
            }
        }
    }
    walk(w, "", &ws, skip, &[&ts, &sweep, &tsn, &project, &clock], async_effects, &mut out);
    out
}

fn diff_trees(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> Vec<String> {
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter()
        .filter(|k| a.get(*k) != b.get(*k))
        .map(|k| {
            format!(
                "{k}: node={} engine={}",
                a.get(k).map_or("(absent)".to_string(), |v| clip(v, 300)),
                b.get(k).map_or("(absent)".to_string(), |v| clip(v, 300))
            )
        })
        .collect()
}

fn lock(m: &Mutex<Stats>) -> std::sync::MutexGuard<'_, Stats> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn run_fx(o: &Opts, hooks: &Path, scenarios: &[Scenario]) -> Report {
    let plugin_root = hooks.parent().expect("hooks directory has a parent").to_path_buf();
    let hook = hooks.join(o.hook_file);
    let scratch = Scratch::new(&format!("fx-{}", o.name));
    let tmp = scratch.path().to_path_buf();
    let stats = Mutex::new(Stats::default());
    let mism: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let dids: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mask = |s: &str| o.mask_out.map_or_else(|| s.to_string(), |f| f(s));
    let base_path = std::env::var("PATH").unwrap_or_default();
    // The hooks' temp root is a directory of its own, never an ancestor of the worlds (which live under /tmp for a short socket
    // path): with TMPDIR unset it is /tmp, a relative path in a world would then be "under the temp root" and the engine
    // defers it to Node on purpose. A developer's shell always has TMPDIR set, a CI runner does not.
    let hook_tmp = tmp.join("hook-tmp");
    std::fs::create_dir_all(&hook_tmp).expect("hook tmp");
    let hook_tmp = hook_tmp.to_string_lossy().to_string();
    let base_env = |home: &str, extra: &Env| {
        env_merge(
            &env_merge(
                &env_of(&[
                    ("PATH", &base_path),
                    ("HOME", home),
                    ("USERPROFILE", home),
                    ("ANTIHALL_TEST_ISOLATION", "1"),
                    ("ANTIHALL_INGEST_DRY_RUN", "1"),
                    ("TMPDIR", &hook_tmp),
                ]),
                &o.extra_env,
            ),
            extra,
        )
    };
    let only = std::env::var("AH_PARITY_ONLY").ok().and_then(|p| Regex::new(&p).ok());
    let list: Vec<&Scenario> = scenarios.iter().filter(|s| only.as_ref().is_none_or(|re| re.is_match(&s.id))).collect();
    let counter = std::sync::atomic::AtomicUsize::new(0);
    pool(&list, o.conc, |sc, _| {
        let id = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (wn, we) = (tmp.join(format!("n{id}")), tmp.join(format!("e{id}")));
        for w in [&wn, &we] {
            std::fs::create_dir_all(w).expect("world");
            build(w, &sc.world);
        }
        lock(&stats).scenarios += 1;
        for (si, step) in sc.steps.iter().enumerate() {
            lock(&stats).steps += 1;
            if let Some(b) = &step.before {
                b(&wn);
                b(&we);
            }
            let input = |w: &Path| -> String {
                match (&step.raw, &step.payload) {
                    (Some(r), _) => subst_str(r, &w.join("home").to_string_lossy(), &w.join("proj").to_string_lossy(), &w.to_string_lossy()),
                    (None, Some(p)) => subst(p.clone(), w).text(),
                    (None, None) => String::new(),
                }
            };
            let node_run = |w: &Path| -> Out {
                let mut args = vec![hook.to_string_lossy().to_string()];
                args.extend(o.node_args.clone());
                let r = node(&args, input(w).as_bytes(), &base_env(&w.join("home").to_string_lossy(), &step.env), &w.to_string_lossy());
                let ws = w.to_string_lossy().to_string();
                Out { code: r.code, out: mask(&r.out.replace(&ws, "<W>")), err: r.err.replace(&ws, "<W>") }
            };
            let mut n1 = node_run(&wn);
            if o.mutate {
                n1.out.push_str("~mutant");
            }
            {
                let mut st = lock(&stats);
                if !n1.out.trim().is_empty() {
                    st.node_out += 1;
                }
                if n1.code_is(2) {
                    st.node_blocks += 1;
                }
            }
            let ws_e = we.to_string_lossy().to_string();
            let er = run(
                ENGINE,
                &strs(&["check", o.check]),
                input(&we).as_bytes(),
                &env_merge(&base_env(&we.join("home").to_string_lossy(), &step.env), &env_of(&[("AH_ENGINE_PLUGIN_ROOT", &plugin_root.to_string_lossy())])),
                &ws_e,
            );
            let mut e1 = Out { code: er.code.clone(), out: mask(&er.out.replace(&ws_e, "<W>")), err: er.err.replace(&ws_e, "<W>") };
            let mut deferred = false;
            if e1.out.trim() == "AHFALLBACK" {
                deferred = true;
                e1 = node_run(&we);
            }
            let note = |m: &str| {
                format!(
                    "{} step {si}: {m}: node=({}, {:?}, {:?}) engine=({}, {:?}, {:?})",
                    sc.id,
                    n1.code,
                    clip(&n1.out, 160),
                    clip(&n1.err, 160),
                    e1.code,
                    clip(&e1.out, 160),
                    clip(&e1.err, 160)
                )
            };
            let mut st = lock(&stats);
            if deferred && sc.answer_when_silent && n1.code_is(0) && n1.out.trim().is_empty() {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(note("engine deferred where Node allowed silently"));
                continue;
            }
            if deferred && sc.answer_when_no_block && n1.code_is(0) && !BLOCK_RE.is_match(&n1.out) {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(note("engine deferred where Node did not block"));
                continue;
            }
            if deferred && !sc.expect_defer && o.may_defer.as_ref().is_some_and(|f| !f(sc, step)) {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(note("engine deferred where it must answer"));
                continue;
            }
            if sc.expect_defer {
                // The Node hook starts detached workers whose files land asynchronously: only the deferral itself is checked.
                if deferred {
                    st.deferred += 1;
                } else if n1.code == e1.code && n1.out.trim() == e1.out.trim() && n1.err.trim() == e1.err.trim() {
                    // a scripted check runs in a UTF-16 interpreter: the lone surrogate the compiled port could not hold is held, so the
                    // engine may answer where it once deferred, as long as the answer is Node's byte for byte
                    st.same += 1;
                } else {
                    st.mismatch += 1;
                    mism.lock().unwrap_or_else(|e| e.into_inner()).push(note("expected a deferral (or Node's own answer)"));
                }
                continue;
            }
            let (tn, te) = (snapshot(&wn, o.skip, sc.async_effects), snapshot(&we, o.skip, sc.async_effects));
            let fx = diff_trees(&tn, &te);
            let same_io = n1.code == e1.code && n1.out.trim() == e1.out.trim() && n1.err.trim() == e1.err.trim();
            if deferred {
                st.deferred += 1;
                dids.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{}#{si}", sc.id));
                if n1.out.trim().is_empty() && n1.code_is(0) && tn.is_empty() {
                    st.unneeded += 1;
                }
            } else if same_io && fx.is_empty() {
                st.same += 1;
                if tn.keys().any(|k| !k.starts_with("home")) {
                    st.effects += 1;
                }
            } else {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!(
                    "{} step {si}: node=({}, {:?}, {:?}) engine=({}, {:?}, {:?}) tree: {}",
                    sc.id,
                    n1.code,
                    clip(&n1.out, 160),
                    clip(&n1.err, 160),
                    e1.code,
                    clip(&e1.out, 160),
                    clip(&e1.err, 160),
                    fx.iter().take(6).cloned().collect::<Vec<_>>().join(" ; ")
                ));
            }
            if deferred && same_io && !fx.is_empty() {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!(
                    "{} step {si}: tree differs after a deferral round: {}",
                    sc.id,
                    fx.iter().take(6).cloned().collect::<Vec<_>>().join(" ; ")
                ));
            }
        }
        wipe(&wn);
        wipe(&we);
    });
    let stats = stats.into_inner().unwrap_or_else(|e| e.into_inner());
    let mism = mism.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut summary = format!(
        "{}: scenarios={} steps={} same={} (with file effects: {}) deferred={} (Node did nothing: {}) MISMATCH={} node-stdout={} node-blocks={}\n",
        o.name, stats.scenarios, stats.steps, stats.same, stats.effects, stats.deferred, stats.unneeded, stats.mismatch, stats.node_out, stats.node_blocks
    );
    for m in mism.iter().take(12) {
        summary.push_str(&format!("  MISMATCH {m}\n"));
    }
    summary.push_str(&timing::line(o.name));
    drop(scratch);
    Report { stats, summary }
}

/// Write the corpus (ids, worlds, payloads) for comparison with the corpus a port replaced.
pub(crate) fn dump_fx(name: &str, scenarios: &[Scenario]) {
    let Some(dir) = std::env::var_os("AH_PARITY_DUMP") else { return };
    let mut out = String::new();
    for sc in scenarios {
        let w = &sc.world;
        let steps: Vec<serde_json::Value> = sc
            .steps
            .iter()
            .map(|s| {
                let env: BTreeMap<String, Option<String>> = s.env.iter().cloned().collect();
                serde_json::json!({"payload": s.payload.as_ref().map(|p| p.text()), "raw": s.raw, "env": env, "before": s.before.is_some()})
            })
            .collect();
        let files: BTreeMap<String, Option<String>> = w.files.iter().cloned().collect();
        let links: BTreeMap<String, String> = w.links.iter().cloned().collect();
        let modes: BTreeMap<String, String> = w.modes.iter().cloned().collect();
        out.push_str(&serde_json::json!({"id": sc.id, "world": {"files": files, "dirs": w.dirs, "links": links, "gitdirs": w.gitdirs, "modes": modes}, "steps": steps, "expectDefer": sc.expect_defer, "answerWhenSilent": sc.answer_when_silent, "answerWhenNoBlock": sc.answer_when_no_block}).to_string());
        out.push('\n');
    }
    std::fs::create_dir_all(&dir).ok();
    std::fs::write(Path::new(&dir).join(format!("fx-{name}.scenarios.jsonl")), out).expect("dump");
}

pub(crate) fn require(o: &Opts, hooks: &Path, scenarios: Vec<Scenario>, min: usize) {
    dump_fx(o.name, &scenarios);
    if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
        return;
    }
    let rep = run_fx(o, hooks, &scenarios);
    println!("{}", rep.summary);
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        std::fs::write(Path::new(&dir).join(format!("fx-{}.summary.txt", o.name)), &rep.summary).ok();
    }
    assert_eq!(rep.stats.mismatch, 0, "{}: mismatches:\n{}", o.name, rep.summary);
    assert!(rep.stats.scenarios >= min, "{}: only {} scenarios", o.name, rep.stats.scenarios);
    assert!(rep.stats.same + rep.stats.deferred > 0, "{}: nothing compared\n{}", o.name, rep.summary);
}
