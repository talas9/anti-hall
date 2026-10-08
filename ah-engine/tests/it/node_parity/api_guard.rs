//! Parity of the built-in `api-guard` check against `hooks/api-guard.js` (PreToolUse on Write, Edit, MultiEdit, Bash and
//! apply_patch). The Node guard probes the installed python3 / node, so this needs both on PATH.
//!
//! The engine must never be weaker than Node (D74): wherever Node blocks (a fabricated stdlib or builtin attribute) the engine
//! may only defer, and wherever it answers it must print what Node printed. Corpus: (1) fabricated and real references in Python
//! and JavaScript through Write, Edit and MultiEdit for every extension, shadowing, strings, comments, local and path-like
//! modules, third-party packages; (2) the shell-write shapes Node's shell-writes parser covers (redirects, tee, heredocs,
//! echo/printf, sed -i, cp/mv, python -c writes) carrying fabricated references, and the shapes it cannot see; (3) apply_patch
//! (Add, Update, Move, Delete); (4) switches (guards.apiGuard, guards.shellWriteChecks, guards.apiGuardThirdparty, skip);
//! (5) payload shape fuzz; (6) real edits and commands (`AH_PARITY_REAL_EDITS`, `AH_PARITY_REAL_CMDS`: local data, optional).

use super::guard::*;
use super::support::*;
use serde_json::{Value, json};
use std::sync::Arc;

include!("api_tables.rs");

fn pl(tool: Value, input: Option<Value>, extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PreToolUse", "tool_name": tool, "session_id": "s", "cwd": "/tmp"});
    if let Some(i) = input {
        p["tool_input"] = i;
    }
    assign(p, extra)
}
fn pls(tool: &str, input: Value) -> Value {
    pl(json!(tool), Some(input), json!({}))
}

fn mk(settings: Option<Value>, env: &[(&str, &str)], claude: Option<Value>, skip: Option<Value>) -> Arc<Ctx> {
    let mut c = Ctx::new().env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in env {
        c = c.env(k, v);
    }
    c.settings = settings.map(Doc::Json);
    c.claude = claude.map(Doc::Json);
    c.skip = skip.map(Doc::Json);
    c.arc()
}
fn mk0() -> Arc<Ctx> {
    mk(None, &[], None, None)
}

fn tools(file: &str, code: &str) -> Vec<Value> {
    vec![
        pls("Write", json!({"file_path": file, "content": code})),
        pls("Edit", json!({"file_path": file, "old_string": "x", "new_string": code})),
        pls("MultiEdit", json!({"file_path": file, "edits": [{"old_string": "a", "new_string": "harmless();"}, {"old_string": "b", "new_string": code}]})),
    ]
}

fn tool_name(p: &Value) -> String {
    p["tool_name"].as_str().unwrap_or("").to_string()
}

type Snippets = Vec<(&'static str, String)>;

fn snippets() -> (Snippets, Snippets) {
    let mut py: Vec<(&str, String)> = PY.iter().map(|(k, v)| (*k, v.to_string())).collect();
    let mut js: Vec<(&str, String)> = JS.iter().map(|(k, v)| (*k, v.to_string())).collect();
    for (k, v) in py.iter_mut() {
        if *k == "big" {
            *v = format!("import os\n{}os.fake\n", "x = 1\n".repeat(100000));
        }
    }
    for (k, v) in js.iter_mut() {
        if *k == "big" {
            *v = format!("{}Array.fakeStatic();\n", "var a = 1;\n".repeat(100000));
        }
    }
    (py, js)
}

pub fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let mut out: Vec<Scenario> = Vec::new();
    let mut add = |payload: Value, ctx: &Arc<Ctx>, id: String| out.push(Scenario { id, ctx: Some(ctx.clone()), steps: vec![Step::new(payload)] });
    let (py, js) = snippets();
    let py_get = |k: &str| py.iter().find(|(n, _)| *n == k).unwrap().1.clone();
    let js_get = |k: &str| js.iter().find(|(n, _)| *n == k).unwrap().1.clone();
    // ---- (1) edits
    for (k, code) in &py {
        for f in ["x.py", *r.pick(&PYEXT)] {
            for p in tools(f, code) {
                add(p.clone(), &mk0(), format!("py-{k}-{f}-{}", tool_name(&p)));
            }
        }
    }
    for (k, code) in &js {
        for f in ["x.js", *r.pick(&JSEXT)] {
            for p in tools(f, code) {
                add(p.clone(), &mk0(), format!("js-{k}-{f}-{}", tool_name(&p)));
            }
        }
    }
    for f in PYEXT {
        for p in tools(f, &py_get("fakeOs")) {
            add(p.clone(), &mk0(), format!("pyext-{f}-{}", tool_name(&p)));
        }
    }
    for f in JSEXT {
        for p in tools(f, &js_get("gArray")) {
            add(p.clone(), &mk0(), format!("jsext-{f}-{}", tool_name(&p)));
        }
    }
    for f in OTHER {
        for code in [py_get("fakeOs"), js_get("gArray")] {
            for p in tools(f, &code) {
                add(p.clone(), &mk0(), format!("other-{f}-{}", tool_name(&p)));
            }
        }
    }
    for (k, code) in [("py", py_get("fakeOs")), ("js", js_get("gArray"))] {
        for f in ["a.py", "a.js"] {
            add(pls("Write", json!({"file_path": f, "content": code})), &mk0(), format!("cross-{k}-{f}"));
        }
    }
    // ---- (2) shell writes
    let sw_off = mk(Some(json!({"guards": {"shellWriteChecks": false}})), &[], None, None);
    for c in SH {
        add(pls("Bash", json!({"command": c})), &mk0(), format!("bash-{}", ws_to_underscore(&clip(c, 24))));
    }
    for c in &SH[..12] {
        add(pls("Bash", json!({"command": c})), &sw_off, format!("bash-swoff-{}", clip(c, 20)));
    }
    for c in &SH[..12] {
        add(pl(json!("Bash"), Some(json!({"command": c})), json!({"cwd": "/"})), &mk0(), format!("bash-cwd-{}", clip(c, 20)));
    }
    // ---- (3) apply_patch
    for (i, c) in PATCHES.iter().enumerate() {
        add(pls("apply_patch", json!({"command": c})), &mk0(), format!("patch-{i}"));
        add(pl(json!("apply_patch"), Some(json!({"command": c})), json!({"turn_id": "t", "model": "m"})), &mk0(), format!("patchcodex-{i}"));
    }
    // ---- (4) switches
    let probe = [
        pls("Write", json!({"file_path": "a.py", "content": py_get("fakeOs")})),
        pls("Write", json!({"file_path": "a.py", "content": py_get("third")})),
        pls("Write", json!({"file_path": "a.js", "content": js_get("thirdLodash")})),
        pls("Write", json!({"file_path": "a.js", "content": js_get("gArray")})),
        pls("Bash", json!({"command": SH[0]})),
        pls("Write", json!({"file_path": "a.rs", "content": py_get("fakeOs")})),
    ];
    let now = now_ms() as i64;
    let g = |k: &str, v: Value| Some(json!({"guards": {k: v}}));
    let ctxs: Vec<(&str, Arc<Ctx>)> = vec![
        ("def", mk0()),
        ("apiOff", mk(g("apiGuard", json!(false)), &[], None, None)),
        ("apiOffWord", mk(g("apiGuard", json!("off")), &[], None, None)),
        ("apiOpt", mk(None, &[("CLAUDE_PLUGIN_OPTION_GUARDS_API_GUARD", "false")], None, None)),
        ("apiOptStored", mk(None, &[], Some(json!({"pluginConfigs": {"anti-hall": {"options": {"guards_api_guard": false}}}})), None)),
        ("apiJunk", mk(g("apiGuard", json!("maybe")), &[], None, None)),
        ("swOff", sw_off.clone()),
        ("swEnv", mk(None, &[("ANTIHALL_SHELL_WRITE_CHECKS", "0")], None, None)),
        ("swEnvOn", mk(g("shellWriteChecks", json!(false)), &[("ANTIHALL_SHELL_WRITE_CHECKS", "1")], None, None)),
        ("tpOn", mk(g("apiGuardThirdparty", json!(true)), &[], None, None)),
        ("tpEnv", mk(None, &[("ANTIHALL_API_GUARD_THIRDPARTY", "1")], None, None)),
        ("tpEnvWord", mk(None, &[("ANTIHALL_API_GUARD_THIRDPARTY", "yes")], None, None)),
        ("tpOff", mk(g("apiGuardThirdparty", json!(true)), &[("ANTIHALL_API_GUARD_THIRDPARTY", "0")], None, None)),
        ("skip", mk(None, &[], None, Some(json!({"api-guard": now + 3600000})))),
        ("skipAll", mk(None, &[], None, Some(json!({"all": now + 3600000})))),
        ("skipExpired", mk(None, &[], None, Some(json!({"all": now - 1000})))),
        ("skipOther", mk(None, &[], None, Some(json!({"git-guard": now + 3600000})))),
        ("badSettings", {
            let mut c = (*mk0()).clone();
            c.settings = Some(Doc::Raw("{x".into()));
            c.arc()
        }),
        ("badSkip", {
            let mut c = (*mk0()).clone();
            c.skip = Some(Doc::Raw("{x".into()));
            c.arc()
        }),
        ("spawnTimeout", mk(None, &[("ANTIHALL_API_GUARD_SPAWN_TIMEOUT_MS", "1")], None, None)),
    ];
    for (k, c) in &ctxs {
        for (i, p) in probe.iter().enumerate() {
            add(p.clone(), c, format!("ctx-{k}-{i}"));
        }
    }
    // ---- (5) payload shape fuzz
    let fake = py_get("fakeOs");
    let shapes: Vec<(&str, Value)> = vec![
        ("no-tool-input", json!({"hook_event_name": "PreToolUse", "tool_name": "Write"})),
        ("null-input", pl(json!("Write"), Some(Value::Null), json!({}))),
        ("str-input", pls("Write", json!("x"))),
        ("arr-input", pls("Write", json!([1]))),
        ("num-input", pls("Write", json!(5))),
        ("content-num", pls("Write", json!({"file_path": "a.py", "content": 5}))),
        ("content-null", pls("Write", json!({"file_path": "a.py", "content": null}))),
        ("content-arr", pls("Write", json!({"file_path": "a.py", "content": [fake]}))),
        ("content-obj", pls("Write", json!({"file_path": "a.py", "content": {"a": 1}}))),
        ("path-num", pls("Write", json!({"file_path": 5, "content": fake}))),
        ("path-arr", pls("Write", json!({"file_path": ["a.py"], "content": fake}))),
        ("path-obj", pls("Write", json!({"file_path": {"toString": 1}, "content": fake}))),
        ("path-true", pls("Write", json!({"file_path": true, "content": fake}))),
        ("path-null", pls("Write", json!({"file_path": null, "content": fake}))),
        ("path-empty", pls("Write", json!({"file_path": "", "content": fake}))),
        ("path-missing", pls("Write", json!({"content": fake}))),
        ("path-zero", pls("Write", json!({"file_path": 0, "content": fake}))),
        ("edit-newstring-missing", pls("Edit", json!({"file_path": "a.py", "old_string": "x"}))),
        ("edit-newstring-num", pls("Edit", json!({"file_path": "a.py", "new_string": 5}))),
        ("multi-no-edits", pls("MultiEdit", json!({"file_path": "a.py"}))),
        ("multi-edits-str", pls("MultiEdit", json!({"file_path": "a.py", "edits": "x"}))),
        ("multi-edits-null-entry", pls("MultiEdit", json!({"file_path": "a.py", "edits": [null, 5, {"new_string": fake}, {}]}))),
        ("multi-edits-fake-first", pls("MultiEdit", json!({"file_path": "a.py", "edits": [{"new_string": fake}]}))),
        ("notebook", pls("NotebookEdit", json!({"notebook_path": "a.ipynb", "new_source": fake}))),
        ("read-tool", pls("Read", json!({"file_path": "a.py"}))),
        ("no-tool", json!({"hook_event_name": "PreToolUse", "tool_input": {"file_path": "a.py", "content": fake}})),
        ("tool-num", pl(json!(5), Some(json!({"file_path": "a.py", "content": fake})), json!({}))),
        ("bash-cmd-num", pls("Bash", json!({"command": 5}))),
        ("bash-cmd-arr", pls("Bash", json!({"command": ["cat > a.py"]}))),
        ("bash-cmd-null", pls("Bash", json!({"command": null}))),
        ("bash-no-cmd", pls("Bash", json!({}))),
        ("bash-no-input", pl(json!("Bash"), None, json!({}))),
        ("patch-cmd-num", pls("apply_patch", json!({"command": 5}))),
        ("patch-no-cmd", pls("apply_patch", json!({}))),
        ("patch-arr", pls("apply_patch", json!({"command": [PATCHES[0]]}))),
        ("huge-code", pls("Write", json!({"file_path": "a.py", "content": format!("import os\n{}\nos.fake\n", "x".repeat(700000))}))),
        ("unicode-path", pls("Write", json!({"file_path": "d\u{e9}/\u{e9}.py", "content": fake}))),
        ("nul-path", pls("Write", json!({"file_path": "a\u{0}.py", "content": fake}))),
        ("agent-fields", pl(json!("Write"), Some(json!({"file_path": "a.py", "content": fake})), json!({"agent_id": "a", "agent_type": "x"}))),
        ("codex-fields", pl(json!("Write"), Some(json!({"file_path": "a.py", "content": fake})), json!({"turn_id": "t", "model": "m"}))),
    ];
    for (id, p) in shapes {
        add(p, &mk0(), format!("shape-{id}"));
    }
    // ---- (6) real edits and commands
    let want = real_limit().min(400);
    let edits = real_edits();
    let cmds = real_cmds();
    for i in 0..want.min(edits.len()) {
        let e = r.pick(&edits).clone();
        let (tool, file, code) = (e["tool"].as_str().unwrap_or(""), e["file"].clone(), e["code"].clone());
        let input = match tool {
            "Write" => json!({"file_path": file, "content": code}),
            "Edit" => json!({"file_path": file, "old_string": "x", "new_string": code}),
            _ => json!({"file_path": file, "edits": [{"old_string": "x", "new_string": code}]}),
        };
        add(pl(json!(tool), Some(input), json!({})), &mk0(), format!("real-edit-{i}"));
    }
    let retarget: Vec<&str> = PYEXT[..3].iter().chain(JSEXT[..6].iter()).copied().collect();
    for i in 0..want.min(edits.len()) {
        let e = r.pick(&edits).clone();
        let f = *r.pick(&retarget);
        add(pls("Write", json!({"file_path": f, "content": e["code"]})), &mk0(), format!("real-retarget-{i}"));
    }
    for i in 0..want.min(cmds.len() * 2) {
        let c = r.pick(&cmds).clone();
        add(pls("Bash", json!({"command": c["cmd"]})), &mk0(), format!("real-cmd-{i}"));
    }
    out
}

pub fn opts() -> Opts {
    let mut o = Opts::new("api-guard", "api-guard", "api-guard.js");
    o.events = vec!["PreToolUse"];
    o.tools = vec!["*"];
    o
}
