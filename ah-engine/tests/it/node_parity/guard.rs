//! The guard lane harness (the port of the retired `parity/guardlib.js` `runParity`): scenarios of one or more steps run
//! against the real Node hook (a child process with an isolated HOME) and against the engine, one-shot (`check <name>`, first
//! step only) and through a real daemon (`hook --fallback`), comparing exit code, trimmed stdout and trimmed stderr.
//!
//! A scenario is {id, ctx, steps}. Steps of one scenario run in order against one session; scenarios run in parallel.
//! `ctx` describes the home the guard sees; scenarios that share the same `Arc<Ctx>` share a home and a daemon.
//!
//! Outcomes per step: same (the engine printed what Node did), deferred (the engine answered `AHFALLBACK`, or the sentinel
//! fallback ran in daemon mode: Node decides, never a silent allow), MISMATCH (a Rust bug). After a deferral the rest of that
//! scenario is not compared (the engine's session state is then incomplete, which is the expected consequence of Node having
//! answered that step).

use super::support::*;
pub use crate::common::goldens::Tool;
use crate::common::goldens::{self, Answer, Golden, NodeMode, Norm};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub enum Doc {
    Json(Value),
    Raw(String),
}

impl Doc {
    fn text(&self) -> String {
        match self {
            Doc::Json(v) => serde_json::to_string(v).unwrap(),
            Doc::Raw(s) => s.clone(),
        }
    }
}

/// A per-context setup hook that prepares the home directory.
pub type Setup = Arc<dyn Fn(&Path) + Send + Sync>;

#[derive(Clone, Default)]
pub struct Ctx {
    pub settings: Option<Doc>,
    pub skip: Option<Doc>,
    pub claude: Option<Doc>,
    pub env: Env,
    pub files: Vec<(String, Vec<u8>)>,
    pub links: Vec<(String, String)>,
    pub setup: Option<Setup>,
}

impl Ctx {
    pub fn new() -> Ctx {
        Ctx::default()
    }
    pub fn settings(mut self, v: Value) -> Ctx {
        self.settings = Some(Doc::Json(v));
        self
    }
    pub fn settings_raw(mut self, s: &str) -> Ctx {
        self.settings = Some(Doc::Raw(s.into()));
        self
    }
    pub fn skip(mut self, v: Value) -> Ctx {
        self.skip = Some(Doc::Json(v));
        self
    }
    pub fn skip_raw(mut self, s: &str) -> Ctx {
        self.skip = Some(Doc::Raw(s.into()));
        self
    }
    pub fn claude(mut self, v: Value) -> Ctx {
        self.claude = Some(Doc::Json(v));
        self
    }
    pub fn env(mut self, k: &str, v: &str) -> Ctx {
        self.env = env_merge(&self.env, &vec![(k.into(), Some(v.into()))]);
        self
    }
    pub fn setup(mut self, f: impl Fn(&Path) + Send + Sync + 'static) -> Ctx {
        self.setup = Some(Arc::new(f));
        self
    }
    pub fn arc(self) -> Arc<Ctx> {
        Arc::new(self)
    }
}

#[derive(Clone, Default)]
pub struct Step {
    pub payload: Value,
    pub raw: Option<String>,
    pub argv: Option<Vec<String>>,
}

impl Step {
    pub fn new(payload: Value) -> Step {
        Step { payload, raw: None, argv: None }
    }
    pub fn raw(payload: Value, raw: &str) -> Step {
        Step { payload, raw: Some(raw.into()), argv: None }
    }
    pub fn argv(payload: Value, argv: &[&str]) -> Step {
        Step { payload, raw: None, argv: Some(strs(argv)) }
    }
}

#[derive(Clone)]
pub struct Scenario {
    pub id: String,
    pub ctx: Option<Arc<Ctx>>,
    pub steps: Vec<Step>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Oneshot,
    Daemon,
    Both,
}

pub struct Opts {
    pub name: &'static str,
    pub check: &'static str,
    pub hook_file: &'static str,
    /// Extra flags for the Node process before the hook path.
    pub node_flags: Vec<String>,
    /// For the raw exit code (the hook is judged as a script) instead of `2` or `0`.
    pub node_cli: bool,
    pub mode: Mode,
    pub conc: usize,
    pub events: Vec<&'static str>,
    pub tools: Vec<&'static str>,
    pub node_argv: Option<fn(&Step) -> Vec<String>>,
    /// Node and the engine each get a home of their own (the default). With one shared home the engine would read what Node
    /// wrote, which a replayed Node golden never writes.
    pub dual: bool,
    pub state_files: Option<fn(&Value) -> Regex>,
    pub state_norm: Option<fn(&str, &str) -> String>,
    pub shared_files: Option<Regex>,
    /// A deferral runs the REAL Node hook in the engine's home (as the dispatcher does); `fallback_argv` maps an event to the
    /// hook's extra arguments.
    pub fallback_real: bool,
    pub fallback_argv: Vec<(&'static str, Vec<&'static str>)>,
    pub strict_defer_prefix: Option<&'static str>,
    /// Self-test of the harness: Node's answers are altered before they are compared, so every compared step must mismatch.
    pub mutate: bool,
    /// The tools the hook shells out to: their versions are part of its Node golden's fingerprint.
    pub node_tools: Vec<Tool>,
}

impl Opts {
    pub fn new(name: &'static str, check: &'static str, hook_file: &'static str) -> Opts {
        Opts {
            name,
            check,
            hook_file,
            node_flags: Vec::new(),
            node_cli: false,
            mode: Mode::Both,
            conc: 8,
            events: vec!["PreToolUse", "PostToolUse"],
            tools: vec!["Bash"],
            node_argv: None,
            dual: true,
            state_files: None,
            state_norm: None,
            shared_files: None,
            fallback_real: false,
            fallback_argv: Vec::new(),
            strict_defer_prefix: None,
            mutate: false,
            node_tools: vec![Tool::Node, Tool::Git],
        }
    }
}

#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub post_steps: usize,
    pub scenarios: usize,
    pub steps: usize,
    pub compared: usize,
    pub same: usize,
    pub deferred: usize,
    pub unneeded: usize,
    pub skipped: usize,
    pub mismatch: usize,
    pub node_blocks: usize,
    pub node_advisories: usize,
    pub same_blocks: usize,
    pub state_mismatch: usize,
    pub state_same: usize,
    pub node_runs: usize,
    pub node_runs_by: BTreeMap<String, usize>,
    pub deferred_ids: BTreeSet<String>,
}

pub struct Mismatch {
    pub scenario: String,
    pub step: usize,
    pub mode: String,
    pub node: Out,
    pub engine: Out,
    pub cmd: String,
}

pub struct Report {
    pub stats: Stats,
    pub summary: String,
}

fn mk_home(tmp: &Path, tag: &str, ctx: &Ctx) -> PathBuf {
    let home = tmp.join(format!("h{tag}"));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    if let Some(d) = &ctx.settings {
        write_file(&home.join(".anti-hall/settings.json"), d.text().as_bytes());
    }
    if let Some(d) = &ctx.skip {
        write_file(&home.join(".anti-hall/skip.json"), d.text().as_bytes());
    }
    if let Some(d) = &ctx.claude {
        write_file(&home.join(".claude/settings.json"), d.text().as_bytes());
    }
    for (rel, body) in &ctx.files {
        write_file(&home.join(rel), body);
    }
    if let Some(f) = &ctx.setup {
        f(&home);
    }
    for (rel, target) in &ctx.links {
        let f = home.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::remove_dir(&f).ok();
        std::os::unix::fs::symlink(target.replace("$HOME", &home.to_string_lossy()), &f).unwrap();
    }
    home
}

/// A value may name the ctx home with `__HOME__` (a HOME that is the home plus a suffix).
fn homed(e: &Env, home: &str) -> Env {
    e.iter().map(|(k, v)| (k.clone(), v.as_ref().map(|s| s.replace("__HOME__", home)))).collect()
}

/// The state files of a home that `re` selects, by name (`None`: listed but unreadable, such as a sub-directory).
fn state_map(h: &Path, re: &Regex) -> BTreeMap<String, Option<String>> {
    let mut v = Vec::new();
    for sub in ["", "turn-gate"] {
        if let Ok(rd) = std::fs::read_dir(h.join(".anti-hall").join(sub)) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                v.push(if sub.is_empty() { n } else { format!("{sub}/{n}") });
            }
        }
    }
    // `readdir` of a directory lists its sub-directories too; JavaScript's listing did the same and read them as absent
    v.retain(|f| re.is_match(f));
    v.into_iter()
        .map(|f| {
            let t = std::fs::read(h.join(".anti-hall").join(&f)).ok().map(|b| String::from_utf8_lossy(&b).to_string());
            (f, t)
        })
        .collect()
}

/// Node's state as the comparison sees it (the lane's `state_norm`, which is idempotent): what a golden stores, so clock values
/// the comparison masks do not make a case volatile.
fn state_norm(o: &Opts, m: BTreeMap<String, Option<String>>) -> BTreeMap<String, Option<String>> {
    m.into_iter()
        .map(|(f, t)| {
            let t = t.map(|t| o.state_norm.map_or(t.clone(), |n| n(&f, &t)));
            (f, t)
        })
        .collect()
}

/// The first state file that differs between Node's state (as Node left it, live or from its golden) and the engine's home.
fn state_diff(node: &BTreeMap<String, Option<String>>, home_e: &Path, re: &Regex, norm: Option<fn(&str, &str) -> String>) -> Option<(String, String, String)> {
    let nrm = |f: &str, t: Option<String>| -> Option<String> { t.map(|t| norm.map(|n| n(f, &t)).unwrap_or(t)) };
    let eng = state_map(home_e, re);
    let names: BTreeSet<&String> = node.keys().chain(eng.keys()).collect();
    for f in names {
        let x = nrm(f, node.get(f).cloned().flatten());
        let y = nrm(f, eng.get(f).cloned().flatten());
        if x != y {
            return Some((f.clone(), x.unwrap_or("null".into()), y.unwrap_or("null".into())));
        }
    }
    None
}

/// The initial home of a group as text (paths relative, contents and link targets normalized): part of every golden input, so
/// a changed context re-keys its cases.
fn home_key(home: &Path, norm: &Norm) -> String {
    fn walk(d: &Path, rel: &str, norm: &Norm, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let p = d.join(&n);
            let r = format!("{rel}/{n}");
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                out.push(format!("{r} -> {}", std::fs::read_link(&p).map(|x| x.to_string_lossy().to_string()).unwrap_or_default()));
            } else if md.is_dir() {
                use std::os::unix::fs::PermissionsExt;
                out.push(format!("{r}/ {:o}", md.permissions().mode() & 0o7777));
                // a repository's objects carry commit times: the setup that made it is in the corpus, its bytes are not stable
                if n != ".git" {
                    walk(&p, &r, norm, out);
                }
            } else {
                use std::os::unix::fs::PermissionsExt;
                out.push(format!(
                    "{r} {:o} {}",
                    md.permissions().mode() & 0o7777,
                    goldens::sha256_hex(norm.apply(&String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default())).as_bytes())
                ));
            }
        }
    }
    let mut v = Vec::new();
    walk(home, "", norm, &mut v);
    norm.apply(&v.join("\n"))
}

enum R {
    Same,
    Deferred,
    Other(Out),
}

fn write_shim(path: &Path, hook: &Path, argv: &[(&str, Vec<&str>)]) {
    let mut cases = String::new();
    for (ev, a) in argv {
        cases.push_str(&format!("  {ev}) ARGS=\"{}\" ;;\n", a.join(" ")));
    }
    let body = format!(
        r#"#!/bin/sh
# Stand-in for the Node binary of the daemon's fallback: runs the REAL Node hook (as the dispatcher does) with the extra
# arguments of the payload's event, logs each run, and answers exit 2 only when the hook did.
tmp=$(mktemp)
cat > "$tmp"
ev=$(sed -n 's/.*"hook_event_name":"\([^"]*\)".*/\1/p' "$tmp" | head -n 1)
[ -n "$AH_PARITY_DEFER_LOG" ] && echo "$ev" >> "$AH_PARITY_DEFER_LOG"
ARGS=""
case "$ev" in
{cases}  *) ;;
esac
out=$(mktemp); er=$(mktemp)
node {hook:?} $ARGS < "$tmp" > "$out" 2> "$er"
st=$?
cat "$out"
cat "$er" >&2
rm -f "$tmp" "$out" "$er"
[ "$st" = 2 ] && exit 2
exit 0
"#,
        hook = hook.to_string_lossy()
    );
    write_file(path, body.as_bytes());
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Run a guard corpus with Node from its golden (see `crate::common::goldens`): replayed by default, recorded with
/// `AH_RECORD_NODE=1` (two passes, under scratch roots of different path lengths, to find volatile cases), live with
/// `AH_LIVE_NODE=1`. A harness self-test (`mutate`) never records: in a recording run it runs Node live.
pub fn run_guard(o: &Opts, hooks: &Path, scenarios: &[Scenario]) -> Report {
    let entry = hooks.join(o.hook_file);
    let root = repo_root().canonicalize().unwrap_or_else(|_| repo_root());
    let entry = entry.strip_prefix(&root).unwrap_or(&entry).to_string_lossy().to_string();
    let fp = goldens::fingerprint(&[&entry], &o.node_tools);
    let mode = goldens::mode();
    if mode == NodeMode::Record && !o.mutate {
        let a = Golden::open_in(o.name, fp.clone(), NodeMode::Record);
        let ra = run_guard_with(o, hooks, scenarios, &a, "");
        let b = Golden::open_in(o.name, fp, NodeMode::Record);
        let rb = run_guard_with(o, hooks, scenarios, &b, "-recording-pass-two");
        let (n, v) = Golden::write_pair(a, b);
        println!("goldens: recorded {}: {n} cases, {v} volatile (always live)", o.name);
        return if ra.stats.mismatch > 0 { ra } else { rb };
    }
    let g = Golden::open_in(o.name, fp, if mode == NodeMode::Record { NodeMode::Live } else { mode });
    let r = run_guard_with(o, hooks, scenarios, &g, "");
    g.finish();
    r
}

fn run_guard_with(o: &Opts, hooks: &Path, scenarios: &[Scenario], golden: &Golden, pad: &str) -> Report {
    let plugin_root = hooks.parent().unwrap().to_path_buf();
    let scratch = Scratch::new(&format!("{}{pad}", o.name));
    let tmp = scratch.path().to_path_buf();
    let base_path = std::env::var("PATH").unwrap_or_default();
    let hook_path = hooks.join(o.hook_file);
    let shim = tmp.join("real-fallback.sh");
    if o.fallback_real {
        write_shim(&shim, &hook_path, &o.fallback_argv.iter().map(|(a, b)| (*a, b.clone())).collect::<Vec<_>>());
    }
    let stats = Mutex::new(Stats::default());
    let mism: Mutex<Vec<Mismatch>> = Mutex::new(Vec::new());
    let norm_default = Ctx::default();

    // A scenario's golden key: its id, plus `~<k>` for the k-th repeat of an id (ids are not unique). A subset taken in corpus
    // order (the harness self-tests) numbers its repeats the same way.
    let mut seen_ids: BTreeMap<&str, usize> = BTreeMap::new();
    let keys: Vec<String> = scenarios
        .iter()
        .map(|sc| {
            let k = seen_ids.entry(sc.id.as_str()).or_insert(0);
            *k += 1;
            if *k == 1 { sc.id.clone() } else { format!("{}~{}", sc.id, *k - 1) }
        })
        .collect();
    // group scenarios by ctx identity
    let mut groups: Vec<(Option<*const Ctx>, Vec<usize>)> = Vec::new();
    for (i, sc) in scenarios.iter().enumerate() {
        let k = sc.ctx.as_ref().map(Arc::as_ptr);
        if let Some(g) = groups.iter_mut().find(|g| g.0 == k) {
            g.1.push(i);
        } else {
            groups.push((k, vec![i]));
        }
    }
    let node_env = |home: &str, ctx: &Ctx| -> Env {
        let base = env_of(&[("PATH", &base_path), ("HOME", home), ("USERPROFILE", home), ("ANTIHALL_TEST_ISOLATION", "1")]);
        homed(&env_merge(&base, &ctx.env), home)
    };
    // Node's answer to one step: from the golden (replay) or a live run (record, live, or a volatile case). `chain` keys the
    // case: the group's initial home plus every input of the scenario so far, so an earlier step's change re-keys later ones.
    let node_step = |id: &str,
                     chain: &mut String,
                     payload: &Value,
                     step: &Step,
                     home: &Path,
                     ctx: &Ctx,
                     (norm, norm_e): (&Norm, &Norm),
                     state_re: Option<&Regex>|
     -> (Out, Answer) {
        let home_s = home.to_string_lossy().to_string();
        let mut args = o.node_flags.clone();
        args.push(hook_path.to_string_lossy().to_string());
        args.extend(step.argv.clone().unwrap_or_else(|| o.node_argv.map(|f| f(step)).unwrap_or_default()));
        let input = step.raw.clone().unwrap_or_else(|| serde_json::to_string(payload).unwrap());
        let env = node_env(&home_s, ctx);
        // PATH is the runner's own (it differs between shells and CI); the tools it finds are in the fingerprint
        let keyed_env: Vec<&(String, Option<String>)> = env.iter().filter(|(k, _)| k != "PATH").collect();
        let this = norm.apply(&format!("args={args:?}\nenv={keyed_env:?}\nstdin={input}"));
        *chain = goldens::sha256_hex(format!("{chain}\n{this}").as_bytes());
        let a = golden.node(id, chain.as_bytes(), norm, || {
            let r = node(&args, input.as_bytes(), &env, "/tmp");
            let out = if o.node_cli { r.trimmed() } else { Out { code: if r.code_is(2) { "2".into() } else { "0".into() }, out: r.out, err: r.err }.trimmed() };
            Answer { code: out.code, out: out.out, err: out.err, state: state_re.map(|re| state_norm(o, state_map(home, re))).unwrap_or_default() }
        });
        let a = a.map(|s| norm_e.undo(&norm.apply(s)));
        let mut out = Out { code: a.code.clone(), out: a.out.clone(), err: a.err.clone() };
        if o.mutate {
            out.out.push_str("~mutant");
        }
        (out, a)
    };

    for (gi, (_, idxs)) in groups.iter().enumerate() {
        let gi = gi + 1;
        let ctx: &Ctx = scenarios[idxs[0]].ctx.as_deref().unwrap_or(&norm_default);
        let home = mk_home(&tmp, &gi.to_string(), ctx);
        let home_e = if o.dual { mk_home(&tmp, &format!("e{gi}"), ctx) } else { home.clone() };
        let norm = Norm::new().path(&tmp, "SCRATCH").path(&home, "HOME").path(&plugin_root, "PLUGIN");
        // With two homes, Node's answer names Node's home where the engine's names its own: compare them with Node's home read as
        // the engine's (what the one shared home compared implicitly).
        let norm_e = Norm::new().path(&tmp, "SCRATCH").path(&home_e, "HOME").path(&plugin_root, "PLUGIN");
        let group_key = goldens::sha256_hex(home_key(&home, &norm).as_bytes());
        let (home_s, home_e_s) = (home.to_string_lossy().to_string(), home_e.to_string_lossy().to_string());
        let dir = tmp.join(format!("e{gi}"));
        let rf = tmp.join(format!("rules{gi}.json"));
        let rule = json!({"version": 1, "rules": [{"id": o.name, "events": o.events, "tools": o.tools, "check": o.check, "action": "deny", "options": {"plugin_root": plugin_root.to_string_lossy()}}]});
        write_file(&rf, serde_json::to_string(&rule).unwrap().as_bytes());
        let eenv = homed(
            &env_merge(&env_of(&[("PATH", &base_path), ("HOME", &home_e_s), ("USERPROFILE", &home_e_s), ("ANTIHALL_TEST_ISOLATION", "1")]), &ctx.env),
            &home_e_s,
        );
        let defer_log = tmp.join(format!("defer{gi}.log"));
        let (node_bin, fb) = if o.fallback_real {
            (shim.to_string_lossy().to_string(), hook_path.to_string_lossy().to_string())
        } else {
            ("/bin/echo".to_string(), "AHDEFERRED".to_string())
        };
        let denv = env_merge(
            &eenv,
            &env_of(&[
                ("AH_PARITY_DEFER_LOG", &defer_log.to_string_lossy()),
                ("AH_ENGINE_DIR", &dir.to_string_lossy()),
                ("AH_ENGINE_RULES", &rf.to_string_lossy()),
                ("AH_ENGINE_SESSION_RPS", "0"),
                ("AH_ENGINE_PROJECT_RPS", "0"),
                ("AH_ENGINE_VERSION", "parity"),
                ("AH_ENGINE_EVAL_BUDGET_US", "0"),
                ("AH_ENGINE_DEADLINE_MS", "30000"),
                ("AH_ENGINE_NODE", &node_bin),
                ("AH_ENGINE_BREAKER_N", "1000000"),
            ]),
        );
        let oenv = env_merge(&eenv, &env_of(&[("AH_ENGINE_PLUGIN_ROOT", &plugin_root.to_string_lossy())]));
        let warm = json!({"session_id": "warm", "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "echo warm"}})
            .to_string();
        if o.mode != Mode::Oneshot {
            // a cold start answers through the fallback, so warm the daemon first (with the deferring stand-in, never the real
            // hook) and wait until it is up
            run(ENGINE, &strs(&["hook", "--fallback", "AHDEFERRED"]), warm.as_bytes(), &env_merge(&denv, &env_of(&[("AH_ENGINE_NODE", "/bin/echo")])), "/tmp");
            for _ in 0..200 {
                if run(ENGINE, &strs(&["ctl", "ping"]), b"", &denv, "/tmp").code_is(0) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        let list: Vec<&Scenario> = idxs.iter().map(|&i| &scenarios[i]).collect();
        let list_keys: Vec<&String> = idxs.iter().map(|&i| &keys[i]).collect();
        let chains: Mutex<Vec<String>> = Mutex::new(Vec::new());
        pool(&list, o.conc, |sc, li| {
            stats.lock().unwrap().scenarios += 1;
            let mut stopped = false;
            let mut chain = group_key.clone();
            for (si, step) in sc.steps.iter().enumerate() {
                {
                    let mut st = stats.lock().unwrap();
                    st.steps += 1;
                    if step.payload.get("hook_event_name").and_then(Value::as_str) == Some("PostToolUse") {
                        st.post_steps += 1;
                    }
                }
                let payload = subst_home(&step.payload, &home_s);
                let payload_e = if o.dual { subst_home(&step.payload, &home_e_s) } else { payload.clone() };
                let state_re = if o.dual { o.state_files.map(|f| f(&step.payload)) } else { None };
                let (n, n_answer) = node_step(&format!("{}#{si}", list_keys[li]), &mut chain, &payload, step, &home, ctx, (&norm, &norm_e), state_re.as_ref());
                {
                    let mut st = stats.lock().unwrap();
                    if n.code_is(2) {
                        st.node_blocks += 1;
                    } else if !n.out.is_empty() {
                        st.node_advisories += 1;
                    }
                }
                if stopped {
                    stats.lock().unwrap().skipped += 1;
                    continue;
                }
                let input = step.raw.clone().unwrap_or_else(|| serde_json::to_string(&payload_e).unwrap());
                let mut results: Vec<(&str, R)> = Vec::new();
                if matches!(o.mode, Mode::Oneshot | Mode::Both) && si == 0 {
                    let e = run(ENGINE, &strs(&["check", o.check]), input.as_bytes(), &oenv, "/tmp").trimmed();
                    results.push((
                        "oneshot",
                        if e.out == "AHFALLBACK" {
                            R::Deferred
                        } else if e == n {
                            R::Same
                        } else {
                            R::Other(e)
                        },
                    ));
                }
                if matches!(o.mode, Mode::Daemon | Mode::Both) {
                    let e = run(ENGINE, &strs(&["hook", "--fallback", &fb]), input.as_bytes(), &denv, "/tmp").trimmed();
                    results.push((
                        "daemon",
                        if e.out == "AHDEFERRED" {
                            R::Deferred
                        } else if e == n {
                            R::Same
                        } else {
                            R::Other(e)
                        },
                    ));
                }
                let cmd = || -> String {
                    let ti = payload.get("tool_input");
                    let c = ti
                        .and_then(|t| t.get("command"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .or_else(|| ti.and_then(|t| t.get("file_path")).and_then(Value::as_str))
                        .unwrap_or("");
                    clip(c, 160)
                };
                if o.dual
                    && !stopped
                    && !results.is_empty()
                    && let Some(re) = &state_re
                {
                    let d = state_diff(&n_answer.state, &home_e, re, o.state_norm);
                    let any_deferred = results.iter().any(|(_, r)| matches!(r, R::Deferred));
                    let mut st = stats.lock().unwrap();
                    match d {
                        Some((name, nn, ee)) if !any_deferred => {
                            st.compared += 1;
                            st.state_mismatch += 1;
                            st.mismatch += 1;
                            mism.lock().unwrap().push(Mismatch {
                                scenario: sc.id.clone(),
                                step: si,
                                mode: "state".into(),
                                node: Out { code: "0".into(), out: nn, err: String::new() },
                                engine: Out { code: "0".into(), out: ee, err: name },
                                cmd: cmd(),
                            });
                        }
                        None => {
                            st.compared += 1;
                            st.same += 1;
                            st.state_same += 1;
                        }
                        _ => {}
                    }
                }
                for (mode, r) in results {
                    let mut st = stats.lock().unwrap();
                    st.compared += 1;
                    match r {
                        R::Same => {
                            st.same += 1;
                            if n.code_is(2) {
                                st.same_blocks += 1;
                            }
                        }
                        R::Deferred if o.strict_defer_prefix.is_some_and(|p| sc.id.starts_with(p)) && n.out.is_empty() && n.code_is(0) => {
                            st.mismatch += 1;
                            mism.lock().unwrap().push(Mismatch {
                                scenario: sc.id.clone(),
                                step: si,
                                mode: mode.into(),
                                node: n.clone(),
                                engine: Out {
                                    code: "deferred".into(),
                                    out: "AHDEFER".into(),
                                    err: "engine deferred where Node allowed (classification divergence)".into(),
                                },
                                cmd: cmd(),
                            });
                        }
                        R::Deferred => {
                            st.deferred += 1;
                            st.deferred_ids.insert(sc.id.clone());
                            if n.out.is_empty() && n.code_is(0) {
                                st.unneeded += 1;
                            }
                            if mode == "daemon" || o.mode == Mode::Oneshot {
                                stopped = true;
                            }
                        }
                        R::Other(e) => {
                            st.mismatch += 1;
                            mism.lock().unwrap().push(Mismatch {
                                scenario: sc.id.clone(),
                                step: si,
                                mode: mode.into(),
                                node: n.clone(),
                                engine: e,
                                cmd: cmd(),
                            });
                        }
                    }
                }
            }
            chains.lock().unwrap().push(chain);
        });
        if o.fallback_real {
            let mut st = stats.lock().unwrap();
            if let Ok(t) = std::fs::read_to_string(&defer_log) {
                for l in t.split('\n').filter(|l| !l.is_empty()) {
                    *st.node_runs_by.entry(l.to_string()).or_insert(0) += 1;
                    st.node_runs += 1;
                }
            }
        }
        // The shared files at the end of the group are a golden case of their own, keyed by every scenario of the group. A volatile
        // one cannot be replayed (Node did not run the group), so it is compared only when Node really ran; a harness self-test
        // (a subset, with Node's stdout altered) leaves it out.
        let gid = format!("~group-end-{gi}#0");
        if o.dual
            && !o.mutate
            && let Some(re) = &o.shared_files
            && !(golden.mode() == NodeMode::Replay && golden.is_volatile(&gid))
        {
            let mut all = chains.into_inner().unwrap();
            all.sort();
            all.insert(0, group_key.clone());
            let node_state = golden
                .node(&gid, all.join("\n").as_bytes(), &norm, || Answer { state: state_norm(o, state_map(&home, re)), ..Answer::default() })
                .map(|s| norm_e.undo(&norm.apply(s)))
                .state;
            let d = state_diff(&node_state, &home_e, re, o.state_norm);
            let mut st = stats.lock().unwrap();
            st.compared += 1;
            if let Some((name, nn, ee)) = d {
                st.mismatch += 1;
                mism.lock().unwrap().push(Mismatch {
                    scenario: "group-end".into(),
                    step: 0,
                    mode: "shared-state".into(),
                    node: Out { code: "0".into(), out: nn, err: String::new() },
                    engine: Out { code: "0".into(), out: ee, err: name },
                    cmd: String::new(),
                });
            } else {
                st.same += 1;
            }
        }
        if o.mode != Mode::Oneshot {
            run(ENGINE, &strs(&["ctl", "stop"]), b"", &denv, "/tmp");
            for _ in 0..200 {
                if !run(ENGINE, &strs(&["ctl", "ping"]), b"", &denv, "/tmp").code_is(0) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
    }
    let stats = stats.into_inner().unwrap();
    let mismatches = mism.into_inner().unwrap();
    let pc = |x: usize| if stats.compared > 0 { format!("{:.2}%", 100.0 * x as f64 / stats.compared as f64) } else { "-".into() };
    let mut s = format!(
        "{}: scenarios={} steps={} node-blocks={} node-advisories={} mode={}\n",
        o.name,
        stats.scenarios,
        stats.steps,
        stats.node_blocks,
        stats.node_advisories,
        match o.mode {
            Mode::Oneshot => "oneshot",
            Mode::Daemon => "daemon",
            Mode::Both => "both",
        }
    );
    if o.fallback_real {
        s.push_str(&format!("  PostToolUse steps: {}\n", stats.post_steps));
        s.push_str(&format!(
            "  engine-side Node fallback runs (deferrals the engine could not decide): {} {}\n",
            stats.node_runs,
            serde_json::to_string(&stats.node_runs_by).unwrap()
        ));
    }
    s.push_str(&format!(
        "  compared={} same={} ({}) deferred={} ({}; unneeded: Node allowed silently = {}) skipped-after-defer={} MISMATCH={}\n",
        stats.compared,
        stats.same,
        pc(stats.same),
        stats.deferred,
        pc(stats.deferred),
        stats.unneeded,
        stats.skipped,
        stats.mismatch
    ));
    s.push_str(&format!(
        "  blocks the engine itself printed identically to Node: {} of {} Node blocks (the rest deferred)\n",
        stats.same_blocks, stats.node_blocks
    ));
    if !stats.deferred_ids.is_empty() {
        let mut by: BTreeMap<String, usize> = BTreeMap::new();
        for id in &stats.deferred_ids {
            *by.entry(id.split('-').next().unwrap_or("").to_string()).or_insert(0) += 1;
        }
        s.push_str(&format!("  deferred scenarios by group: {}\n", serde_json::to_string(&by).unwrap()));
    }
    for m in mismatches.iter().take(std::env::var("AH_PARITY_SHOW").ok().and_then(|v| v.parse().ok()).unwrap_or(15)) {
        s.push_str(&format!(
            "  MISMATCH {} step {} {} cmd={:?}\n    node  : {:?}\n    engine: {:?}\n",
            m.scenario,
            m.step,
            m.mode,
            m.cmd,
            (&m.node.code, clip(&m.node.out, 160), clip(&m.node.err, 160)),
            (&m.engine.code, clip(&m.engine.out, 160), clip(&m.engine.err, 160))
        ));
    }
    s.push_str(&timing::line(o.name));
    drop(scratch);
    Report { stats, summary: s }
}

/// Write the corpus (ids, payloads, contexts) in a canonical form, for comparing a port against the corpus it replaced.
pub fn dump_scenarios(name: &str, scenarios: &[Scenario]) {
    let Some(dir) = std::env::var_os("AH_PARITY_DUMP") else { return };
    fn canon_text(t: &str) -> String {
        t.split('\n')
            .map(|l| match serde_json::from_str::<Value>(l) {
                Ok(v) if v.is_object() || v.is_array() => serde_json::to_string(&v).unwrap(),
                _ => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn doc(d: &Option<Doc>) -> Value {
        match d {
            None => Value::Null,
            Some(Doc::Json(v)) => v.clone(),
            Some(Doc::Raw(s)) => json!({"$raw": s}),
        }
    }
    let mut ids: Vec<*const Ctx> = Vec::new();
    let mut out = String::new();
    for sc in scenarios {
        let ctx = sc.ctx.as_ref().map(|c| {
            let p = Arc::as_ptr(c);
            let found = ids.iter().position(|x| *x == p);
            let n = found.unwrap_or_else(|| {
                ids.push(p);
                ids.len() - 1
            });
            if found.is_some() {
                return json!({"n": n});
            }
            let files: BTreeMap<String, String> = c.files.iter().map(|(k, v)| (k.clone(), canon_text(&String::from_utf8_lossy(v)))).collect();
            let links: BTreeMap<String, String> = c.links.iter().cloned().collect();
            let env: BTreeMap<String, Option<String>> = c.env.iter().cloned().collect();
            json!({"n": n, "settings": doc(&c.settings), "skip": doc(&c.skip), "claude": doc(&c.claude), "env": env, "files": files, "links": links, "setup": c.setup.is_some()})
        });
        let steps: Vec<Value> = sc.steps.iter().map(|s| json!({"payload": s.payload, "raw": s.raw, "argv": s.argv})).collect();
        out.push_str(&serde_json::to_string(&json!({"id": sc.id, "ctx": ctx, "steps": steps})).unwrap());
        out.push('\n');
    }
    std::fs::create_dir_all(&dir).ok();
    std::fs::write(std::path::Path::new(&dir).join(format!("{name}.scenarios.jsonl")), out).unwrap();
}

/// Run a guard corpus and require a faithful comparison: no mismatch, and enough scenarios that really compared.
pub fn require(o: &Opts, hooks: &Path, scenarios: Vec<Scenario>, min_scenarios: usize) -> Report {
    dump_scenarios(o.name, &scenarios);
    if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
        return Report { stats: Stats::default(), summary: String::new() };
    }
    let rep = run_guard(o, hooks, &scenarios);
    println!("{}", rep.summary);
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        std::fs::write(Path::new(&dir).join(format!("{}.summary.txt", o.name)), &rep.summary).ok();
    }
    assert!(rep.stats.mismatch == 0, "{} mismatches:\n{}", o.name, rep.summary);
    assert!(rep.stats.scenarios >= min_scenarios, "{}: only {} scenarios", o.name, rep.stats.scenarios);
    assert!(rep.stats.same > 0, "{}: nothing compared exactly\n{}", o.name, rep.summary);
    rep
}
