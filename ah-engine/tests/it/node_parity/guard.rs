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
            dual: false,
            state_files: None,
            state_norm: None,
            shared_files: None,
            fallback_real: false,
            fallback_argv: Vec::new(),
            strict_defer_prefix: None,
            mutate: false,
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

fn state_diff(home_n: &Path, home_e: &Path, re: &Regex, norm: Option<fn(&str, &str) -> String>) -> Option<(String, String, String)> {
    let list = |h: &Path| -> Vec<String> {
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
        v.sort();
        v
    };
    let read = |h: &Path, f: &str| -> Option<String> { std::fs::read(h.join(".anti-hall").join(f)).ok().map(|b| String::from_utf8_lossy(&b).to_string()) };
    let nrm = |f: &str, t: Option<String>| -> Option<String> { t.map(|t| norm.map(|n| n(f, &t)).unwrap_or(t)) };
    let a = list(home_n);
    let b = list(home_e);
    let names: BTreeSet<String> = a.into_iter().chain(b).collect();
    for f in names {
        let x = nrm(&f, read(home_n, &f));
        let y = nrm(&f, read(home_e, &f));
        if x != y {
            return Some((f, x.unwrap_or("null".into()), y.unwrap_or("null".into())));
        }
    }
    None
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

pub fn run_guard(o: &Opts, hooks: &Path, scenarios: &[Scenario]) -> Report {
    let plugin_root = hooks.parent().unwrap().to_path_buf();
    let scratch = Scratch::new(o.name);
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
    let node_step = |payload: &Value, step: &Step, home: &str, ctx: &Ctx| -> Out {
        let mut args = o.node_flags.clone();
        args.push(hook_path.to_string_lossy().to_string());
        args.extend(step.argv.clone().unwrap_or_else(|| o.node_argv.map(|f| f(step)).unwrap_or_default()));
        let input = step.raw.clone().unwrap_or_else(|| serde_json::to_string(payload).unwrap());
        let r = node(&args, input.as_bytes(), &node_env(home, ctx), "/tmp");
        let mut out = if o.node_cli { r.trimmed() } else { Out { code: if r.code_is(2) { "2".into() } else { "0".into() }, out: r.out, err: r.err }.trimmed() };
        if o.mutate {
            out.out.push_str("~mutant");
        }
        out
    };

    for (gi, (_, idxs)) in groups.iter().enumerate() {
        let gi = gi + 1;
        let ctx: &Ctx = scenarios[idxs[0]].ctx.as_deref().unwrap_or(&norm_default);
        let home = mk_home(&tmp, &gi.to_string(), ctx);
        let home_e = if o.dual { mk_home(&tmp, &format!("e{gi}"), ctx) } else { home.clone() };
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
        pool(&list, o.conc, |sc, _| {
            stats.lock().unwrap().scenarios += 1;
            let mut stopped = false;
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
                let n = node_step(&payload, step, &home_s, ctx);
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
                    && let Some(state_files) = o.state_files
                {
                    let re = state_files(&step.payload);
                    let d = state_diff(&home, &home_e, &re, o.state_norm);
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
        if o.dual
            && let Some(re) = &o.shared_files
        {
            let d = state_diff(&home, &home_e, re, o.state_norm);
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
    for m in mismatches.iter().take(15) {
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
