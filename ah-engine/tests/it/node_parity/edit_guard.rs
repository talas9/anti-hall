//! Parity of the built-in `edit-guard` check against `hooks/edit-guard.js` (PreToolUse on Write, Edit, MultiEdit,
//! NotebookEdit and, for Codex, apply_patch). The Node hook is a script with no `evaluate()`, so each Node answer is a real
//! `node edit-guard.js` process with an isolated HOME and an explicit environment.
//!
//! The engine must never be weaker than Node (D74): wherever Node blocks the engine may only defer or print the same block, and
//! wherever it answers it must print exactly what Node printed. Corpus: (1) every path spelling that does or does not reach
//! `~/.anti-hall/bin` (literal, relative to the cwd, `..` traversal, repeated and trailing slashes, case and backslash
//! variants, symlinked directories and files, a symlinked launcher directory, a missing leaf), for each edit tool, with and
//! without agent markers, for each entry point; (2) entry points and subagent markers (Claude and Codex shapes); (3) switches
//! (safety.editGuard, skip); (4) payload shape fuzz; (5) real edit targets (`AH_PARITY_REAL_EDITS`, local data, optional).

use super::guard::*;
use super::support::*;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

const HOME: &str = "$HOME";

fn pl(tool: Value, input: Option<Value>, extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PreToolUse", "tool_name": tool, "session_id": "sess-1", "cwd": HOME});
    if let Some(i) = input {
        p["tool_input"] = i;
    }
    assign(p, extra)
}
fn pls(tool: &str, input: Value) -> Value {
    pl(json!(tool), Some(input), json!({}))
}
fn edit(file: &str, extra: Value, tool: Option<&str>) -> Value {
    pl(json!(tool.unwrap_or("Edit")), Some(json!({"file_path": file, "old_string": "a", "new_string": "b"})), extra)
}

fn base_files() -> Vec<(String, Vec<u8>)> {
    [
        (".anti-hall/bin/launcher.sh", "#!/bin/sh\n"),
        (".anti-hall/bin/sub/inner.sh", "x"),
        (".anti-hall/other.txt", "x"),
        ("proj/a.txt", "x"),
        ("realbin/r.sh", "x"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
    .collect()
}

fn base_links() -> Vec<(String, String)> {
    [
        ("lnk", "$HOME/.anti-hall/bin"),
        ("lnkfile", "$HOME/.anti-hall/bin/launcher.sh"),
        ("lnkroot", "$HOME/.anti-hall"),
        ("lnkproj", "$HOME/proj"),
        ("lnkloop", "$HOME/lnkloop"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// The base context with an entry point (None: the variable is absent) and further settings.
fn ctx(entry: Option<&str>, o: Ctx) -> Ctx {
    let mut c = Ctx { env: env_of(&[("ANTIHALL_INGEST_DRY_RUN", "1")]), files: base_files(), links: base_links(), ..Ctx::default() };
    if let Some(e) = entry {
        c = c.env("CLAUDE_CODE_ENTRYPOINT", e);
    }
    c.env = env_merge(&c.env, &o.env);
    c.settings = o.settings;
    c.skip = o.skip;
    c.claude = o.claude;
    c
}
fn with_env(entry: &str, k: &str, v: Option<&str>) -> Ctx {
    ctx(Some(entry), Ctx { env: vec![(k.to_string(), v.map(str::to_string))], ..Ctx::default() })
}
fn cli(o: Ctx) -> Arc<Ctx> {
    ctx(Some("cli"), o).arc()
}

const TOOLS: [(&str, &str); 4] = [("Edit", "file_path"), ("Write", "file_path"), ("MultiEdit", "file_path"), ("NotebookEdit", "notebook_path")];

const MARKERS: [&str; 20] = [
    "{}",
    "{\"agent_id\":\"a1\"}",
    "{\"agent_type\":\"general\"}",
    "{\"agent_id\":\"\"}",
    "{\"agent_id\":null}",
    "{\"agent_id\":0}",
    "{\"agent_id\":false}",
    "{\"agent_type\":\"\"}",
    "{\"agent_id\":\"a\",\"agent_type\":\"b\"}",
    "{\"agent_id\":[]}",
    "{\"agent_id\":{}}",
    "{\"agent_id\":1}",
    "{\"turn_id\":\"t1\",\"model\":\"m\"}",
    "{\"turn_id\":\"t1\",\"model\":\"m\",\"agent_id\":\"a\"}",
    "{\"turn_id\":\"t1\",\"model\":\"m\",\"agent_id\":\"\"}",
    "{\"turn_id\":\"t1\",\"model\":\"m\",\"agent_id\":null}",
    "{\"turn_id\":\"t1\",\"model\":\"\"}",
    "{\"turn_id\":\"\",\"model\":\"m\"}",
    "{\"turn_id\":5,\"model\":\"m\"}",
    "{\"turn_id\":\"t\",\"model\":\"m\",\"agent_type\":0}",
];

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let mut out: Vec<Scenario> = Vec::new();
    let mut add = |payload: Value, c: &Arc<Ctx>, id: String| out.push(Scenario { id, ctx: Some(c.clone()), steps: vec![Step::new(payload)] });
    let bin = format!("{HOME}/.anti-hall/bin");
    // entry-point contexts cached by name, as the corpus's `cx` did
    let mut cache: HashMap<String, Arc<Ctx>> = HashMap::new();
    let mut cx = |e: Option<&str>| -> Arc<Ctx> { cache.entry(e.unwrap_or("undefined").to_string()).or_insert_with(|| ctx(e, Ctx::default()).arc()).clone() };
    let fixed: Vec<(&str, Arc<Ctx>)> = vec![
        ("cli", ctx(Some("cli"), Ctx::default()).arc()),
        ("agent", ctx(Some("agent_tool"), Ctx::default()).arc()),
        ("none", ctx(None, Ctx::default()).arc()),
        ("sdk", ctx(Some("sdk-ts"), Ctx::default()).arc()),
        ("vscode", ctx(Some("vscode"), Ctx::default()).arc()),
        ("ide", ctx(Some("terminal_ide_x"), Ctx::default()).arc()),
    ];
    let fx = |k: &str| fixed.iter().find(|(n, _)| *n == k).unwrap().1.clone();

    // ---- (1) path spellings
    let paths: Vec<String> = vec![
        format!("{bin}/x.sh"),
        format!("{bin}/launcher.sh"),
        bin.clone(),
        format!("{bin}/"),
        format!("{bin}//x.sh"),
        format!("{bin}/sub/inner.sh"),
        format!("{bin}/sub/new/deep.sh"),
        format!("{bin}/../bin/x.sh"),
        format!("{bin}/./x.sh"),
        format!("{HOME}/.anti-hall/bin/../other.txt"),
        format!("{HOME}/.anti-hall/other.txt"),
        format!("{HOME}/.anti-hall/binx/x.sh"),
        format!("{HOME}/.anti-hall/bin.sh"),
        format!("{HOME}/.anti-hall/BIN/x.sh"),
        format!("{HOME}/.Anti-Hall/bin/x.sh"),
        format!("{HOME}/.anti-hall\\bin\\x.sh"),
        format!("{HOME}/.anti-hall\\bin"),
        format!("{HOME}\\.anti-hall\\bin\\x.sh"),
        format!("{HOME}/.anti-hall/bin\\x.sh"),
        format!("{bin} /x.sh"),
        format!(" {bin}/x.sh"),
        format!("{bin}/x.sh "),
        format!("{bin}/\u{e9}.sh"),
        format!("{bin}/x\u{0}.sh"),
        format!("{HOME}//.anti-hall//bin//x.sh"),
        format!("{HOME}/./.anti-hall/./bin/x.sh"),
        format!("{HOME}/proj/../.anti-hall/bin/x.sh"),
        format!("{HOME}/proj/../../x"),
        format!("{HOME}/{}../../x", "a/".repeat(300)),
        ".anti-hall/bin/x.sh".into(),
        "./.anti-hall/bin/x.sh".into(),
        ".anti-hall/bin".into(),
        ".anti-hall/bin/".into(),
        "../.anti-hall/bin/x.sh".into(),
        "proj/../.anti-hall/bin/launcher.sh".into(),
        "~/.anti-hall/bin/x.sh".into(),
        "$HOME/.anti-hall/bin/x.sh".into(),
        "${HOME}/.anti-hall/bin/x.sh".into(),
        "~".into(),
        "".into(),
        "x.sh".into(),
        "proj/a.txt".into(),
        ".anti-hall/other.txt".into(),
        ".anti-hall/bin.txt".into(),
        "lnk/x.sh".into(),
        "lnk/launcher.sh".into(),
        "lnk".into(),
        "lnk/".into(),
        "lnk/sub/inner.sh".into(),
        "lnk/sub/new.sh".into(),
        "lnkfile".into(),
        format!("{HOME}/lnk/launcher.sh"),
        format!("{HOME}/lnkfile"),
        "lnkroot/bin/launcher.sh".into(),
        "lnkroot/bin/x.sh".into(),
        "lnkroot/other.txt".into(),
        "lnkproj/a.txt".into(),
        "lnkproj/../.anti-hall/bin/launcher.sh".into(),
        "lnkloop".into(),
        "lnkloop/x".into(),
        "proj/lnk/launcher.sh".into(),
        "/etc/passwd".into(),
        "/".into(),
        "/tmp/x".into(),
        "/nonexistent/.anti-hall/bin/x.sh".into(),
        format!("{HOME}/realbin/r.sh"),
        format!("{HOME}/.anti-hall/bin/launcher.sh/extra"),
    ];
    for (ek, c) in &fixed {
        for f in &paths {
            for (t, field) in TOOLS {
                if *ek != "cli" && *ek != "agent" && t != "Edit" {
                    continue;
                }
                add(pls(t, json!({field: f})), c, format!("path-{ek}-{t}-{}", clip(&non_alnum_underscore(f), 40)));
            }
        }
    }
    // the field the tool does not read
    for f in [format!("{bin}/x.sh"), "proj/a.txt".to_string()] {
        let tail: String = f.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
        add(pls("NotebookEdit", json!({"file_path": f})), &fx("cli"), format!("wrongfield-nb-{tail}"));
        add(pls("Edit", json!({"notebook_path": f})), &fx("cli"), format!("wrongfield-edit-{tail}"));
    }
    // the cwd varies, the path is relative; None is `undefined` (the key is dropped)
    let cwds: Vec<Option<Value>> = vec![
        Some(json!(HOME)),
        Some(json!(format!("{HOME}/"))),
        Some(json!(format!("{HOME}/proj"))),
        Some(json!(format!("{HOME}/.anti-hall"))),
        Some(json!(format!("{HOME}/.anti-hall/bin"))),
        Some(json!(format!("{HOME}/.anti-hall/bin/sub"))),
        Some(json!(format!("{HOME}/lnk"))),
        Some(json!(format!("{HOME}/lnkproj"))),
        Some(json!("/")),
        Some(json!("/tmp")),
        Some(json!("rel")),
        Some(json!("")),
        Some(json!(5)),
        Some(Value::Null),
        None,
        Some(json!(["x"])),
        Some(json!(format!("{HOME}/proj/.."))),
        Some(json!(format!("{HOME}/nonexistent"))),
    ];
    for cwd in &cwds {
        for f in ["x.sh", "bin/x.sh", "launcher.sh", "../bin/launcher.sh", "../../.anti-hall/bin/x.sh", "sub/inner.sh", "."] {
            for ek in ["cli", "agent"] {
                let extra = match cwd {
                    Some(v) => json!({"cwd": v}),
                    None => json!({}),
                };
                let mut p = pl(json!("Edit"), Some(json!({"file_path": f})), extra);
                if cwd.is_none() {
                    p = without(p, &["cwd"]);
                }
                let shown = cwd.as_ref().map_or("undefined".to_string(), |v| v.to_string());
                add(p, &fx(ek), format!("cwd-{ek}-{}-{f}", clip(&non_alnum_underscore(&shown), 24)));
            }
        }
    }
    // a launcher directory that is itself a symlink, and one that does not exist
    let env1 = || env_of(&[("ANTIHALL_INGEST_DRY_RUN", "1")]);
    let named = |files: &[(&str, &str)], links: &[(&str, &str)]| Ctx {
        env: env1(),
        files: files.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect(),
        links: links.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        ..Ctx::default()
    };
    let sym =
        named(&[("realbin/r.sh", "x"), ("other/o.txt", "x"), ("realroot/bin/r.sh", "x"), ("realroot/other.txt", "x")], &[(".anti-hall", "$HOME/realroot")]);
    let nobin = named(&[("proj/a.txt", "x")], &[]);
    let binlink = named(&[("realbin/r.sh", "x"), (".anti-hall/other.txt", "x")], &[(".anti-hall/bin", "$HOME/realbin")]);
    let binfile = named(&[(".anti-hall/bin", "a file named bin")], &[]);
    for (name, c) in [("nobin", &nobin), ("binlink", &binlink), ("binfile", &binfile), ("rootlink", &sym)] {
        for entry in ["cli", "agent_tool"] {
            let mut cc = c.clone();
            cc.env = env_merge(&cc.env, &env_of(&[("CLAUDE_CODE_ENTRYPOINT", entry)]));
            let cc = cc.arc();
            let fs_: Vec<String> = vec![
                format!("{bin}/x.sh"),
                format!("{bin}/r.sh"),
                format!("{HOME}/realbin/r.sh"),
                format!("{HOME}/realbin/new.sh"),
                format!("{HOME}/.anti-hall/other.txt"),
                bin.clone(),
                format!("{HOME}/realroot/bin/x.sh"),
                "realbin/r.sh".into(),
                ".anti-hall/bin/r.sh".into(),
            ];
            for f in fs_ {
                let id = non_alnum_underscore(&f);
                let tail: String = id.chars().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect();
                add(edit(&f, json!({}), None), &cc, format!("bindir-{name}-{entry}-{tail}"));
            }
        }
    }

    // ---- (2) entry points and subagent markers
    let files = [format!("{bin}/x.sh"), "proj/a.txt".to_string(), ".anti-hall/other.txt".to_string(), "src/main.rs".to_string()];
    let entries: Vec<Option<&str>> = vec![
        Some("cli"),
        Some("agent_tool"),
        Some("vscode"),
        Some("jetbrains"),
        Some("vim"),
        Some("emacs"),
        Some("terminal_ide_x"),
        Some("terminal_ide_"),
        Some("terminal_ide"),
        Some("sdk-ts"),
        Some("sdk-py"),
        Some("remote"),
        Some("CLI"),
        Some(" cli"),
        Some("cli "),
        Some("agent_tool "),
        Some(""),
        None,
        Some("mcp"),
        Some("github-action"),
    ];
    for e in &entries {
        for m in MARKERS {
            let mv: Value = serde_json::from_str(m).unwrap();
            for f in &files[..2] {
                let tail: String = f.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
                let id = format!("entry-{}-{}-{tail}", non_alnum_underscore(e.unwrap_or("undefined")), clip(&non_alnum_underscore(m), 30));
                add(edit(f, mv.clone(), None), &cx(*e), id);
            }
        }
    }
    // Codex-shaped payloads for the Claude tool names and for apply_patch
    let pbin = format!("*** Begin Patch\n*** Add File: {bin}/x.sh\n+x\n*** End Patch");
    let codex_inputs: Vec<(&str, Value)> = vec![
        ("apply_patch", json!({"command": "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"})),
        ("apply_patch", json!({"command": pbin})),
        ("apply_patch", json!({"command": "junk"})),
        ("apply_patch", json!({})),
        ("Edit", json!({"file_path": "proj/a.txt"})),
        ("Write", json!({"file_path": format!("{bin}/x.sh")})),
    ];
    for e in [None, Some("cli"), Some("agent_tool")] {
        for m in [json!({"turn_id": "t", "model": "m"}), json!({"turn_id": "t", "model": "m", "agent_id": "a"})] {
            for (t, inp) in &codex_inputs {
                let len = inp.to_string().encode_utf16().count();
                let keys = m.as_object().map_or(0, |o| o.len());
                add(pl(json!(t), Some(inp.clone()), m.clone()), &cx(e), format!("codex-{}-{t}-{len}-{keys}", e.unwrap_or("undefined")));
            }
        }
    }
    let patches: Vec<String> = vec![
        "*** Begin Patch\n*** Update File: proj/a.txt\n@@\n-a\n+b\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: ../.anti-hall/bin/y.sh\n+x\n*** End Patch".into(),
        format!("*** Begin Patch\n*** Update File: a\n*** Move to: {bin}/z\n@@\n+x\n*** End Patch"),
        "*** Begin Patch\n*** End Patch".into(),
        "".into(),
        "not a patch".into(),
    ];
    for e in [None, Some("cli")] {
        for (i, c) in patches.iter().enumerate() {
            add(pls("apply_patch", json!({"command": c})), &cx(e), format!("patch-{}-{i}", e.unwrap_or("undefined")));
        }
    }

    // ---- (3) switches
    let probe = [
        edit(&format!("{bin}/x.sh"), json!({}), None),
        edit("proj/a.txt", json!({}), None),
        edit(&format!("{bin}/x.sh"), json!({"agent_id": "a"}), None),
        edit("proj/a.txt", json!({"agent_id": "a"}), None),
    ];
    let now = now_ms() as i64;
    let sset = |v: Value| cli(Ctx::default().settings(json!({"safety": {"editGuard": v}})));
    let senv = |k: &str, v: &str| cli(Ctx::default().env(k, v));
    let raw_settings = Ctx { settings: Some(Doc::Raw("{x".into())), ..Ctx::default() };
    let raw_skip = Ctx { skip: Some(Doc::Raw("{x".into())), ..Ctx::default() };
    let sw: Vec<(&str, Arc<Ctx>)> = vec![
        ("def", cli(Ctx::default())),
        ("off", sset(json!(false))),
        ("offWord", sset(json!("off"))),
        ("offNum", sset(json!(0))),
        ("onExplicit", sset(json!(true))),
        ("junk", sset(json!("maybe"))),
        ("envOff", senv("ANTIHALL_EDIT_GUARD", "off")),
        ("envOff0", senv("ANTIHALL_EDIT_GUARD", "0")),
        ("envOn", cli(Ctx::default().env("ANTIHALL_EDIT_GUARD", "1").settings(json!({"safety": {"editGuard": false}})))),
        ("envJunk", cli(Ctx::default().env("ANTIHALL_EDIT_GUARD", "zz").settings(json!({"safety": {"editGuard": false}})))),
        ("optOff", senv("CLAUDE_PLUGIN_OPTION_SAFETY_EDIT_GUARD", "false")),
        ("optStored", cli(Ctx::default().claude(json!({"pluginConfigs": {"anti-hall": {"options": {"safety_edit_guard": false}}}})))),
        ("optStoredFlat", cli(Ctx::default().claude(json!({"pluginConfigs": {"anti-hall@anti-hall": {"safety_edit_guard": "false"}}})))),
        ("optDefault", cli(Ctx::default().env("CLAUDE_PLUGIN_OPTION_SAFETY_EDIT_GUARD", "true").settings(json!({"safety": {"editGuard": false}})))),
        ("skip", cli(Ctx::default().skip(json!({"edit-guard": now + 3600000})))),
        ("skipAll", cli(Ctx::default().skip(json!({"all": now + 3600000})))),
        ("skipExpired", cli(Ctx::default().skip(json!({"all": now - 1000})))),
        ("skipOther", cli(Ctx::default().skip(json!({"git-guard": now + 3600000})))),
        ("badSettings", cli(raw_settings)),
        ("badSkip", cli(raw_skip)),
        // HOME handling: empty, relative, unset
        ("homeEmpty", with_env("cli", "HOME", Some("")).arc()),
        ("homeRel", with_env("cli", "HOME", Some("rel/home")).arc()),
        ("homeUnset", with_env("cli", "HOME", None).arc()),
        ("homeTrailing", with_env("cli", "HOME", Some("__HOME__/")).arc()),
        ("homeDots", with_env("cli", "HOME", Some("__HOME__/./proj/..")).arc()),
    ];
    for (k, c) in &sw {
        for (i, p) in probe.iter().enumerate() {
            add(p.clone(), c, format!("sw-{k}-{i}"));
        }
    }

    // ---- (4) payload shape fuzz
    let bx = format!("{bin}/x.sh");
    let shapes: Vec<(&str, Value)> = vec![
        ("no-tool-input", json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": HOME})),
        ("null-input", pl(json!("Edit"), Some(Value::Null), json!({}))),
        ("str-input", pls("Edit", json!("x"))),
        ("arr-input", pls("Edit", json!([1]))),
        ("num-input", pls("Edit", json!(5))),
        ("true-input", pls("Edit", json!(true))),
        ("path-num", pls("Edit", json!({"file_path": 5}))),
        ("path-arr", pls("Edit", json!({"file_path": [bx]}))),
        ("path-obj", pls("Edit", json!({"file_path": {}}))),
        ("path-true", pls("Edit", json!({"file_path": true}))),
        ("path-null", pls("Edit", json!({"file_path": null}))),
        ("path-zero", pls("Edit", json!({"file_path": 0}))),
        ("path-empty", pls("Edit", json!({"file_path": ""}))),
        ("path-huge", pls("Edit", json!({"file_path": format!("{bin}/{}", "x".repeat(100000))}))),
        ("path-unicode", pls("Edit", json!({"file_path": format!("{bin}/\u{1f600}/\u{e9}.sh")}))),
        ("path-newline", pls("Edit", json!({"file_path": format!("{bin}/a\nb")}))),
        ("cwd-obj", pl(json!("Edit"), Some(json!({"file_path": "x"})), json!({"cwd": {}}))),
        ("cwd-num", pl(json!("Edit"), Some(json!({"file_path": "x.sh"})), json!({"cwd": 5}))),
        ("cwd-true", pl(json!("Edit"), Some(json!({"file_path": "x.sh"})), json!({"cwd": true}))),
        ("tool-missing", json!({"hook_event_name": "PreToolUse", "cwd": HOME, "tool_input": {"file_path": bx}})),
        ("tool-num", pl(json!(5), Some(json!({"file_path": bx})), json!({}))),
        ("tool-lower", pls("edit", json!({"file_path": bx}))),
        ("tool-space", pls("Edit ", json!({"file_path": bx}))),
        ("tool-bash", pls("Bash", json!({"command": format!("echo x > {bin}/x.sh")}))),
        ("tool-read", pls("Read", json!({"file_path": bx}))),
        ("tool-notebook-nopath", pls("NotebookEdit", json!({}))),
        ("tool-multi-edits", pls("MultiEdit", json!({"file_path": "a", "edits": [{"file_path": bx}]}))),
        ("extra-fields", pl(json!("Edit"), Some(json!({"file_path": bx})), json!({"permission_mode": "plan", "transcript_path": "/x"}))),
    ];
    for (id, p) in shapes {
        for ek in ["cli", "agent"] {
            add(p.clone(), &fx(ek), format!("shape-{ek}-{id}"));
        }
    }

    // ---- (5) real edit targets
    let want = real_limit().min(600);
    let edits = real_edits();
    for i in 0..want.min(edits.len() * 2) {
        let e = r.pick(&edits).clone();
        let tool = *r.pick(&["Edit", "Write", "MultiEdit"]);
        let marker = r.pick(&[json!({}), json!({}), json!({"agent_id": "a"})]).clone();
        let c = fx(["cli", "agent", "none", "vscode"][r.below(4)]);
        add(pl(json!(tool), Some(json!({"file_path": e["file"]})), marker), &c, format!("real-{i}"));
    }
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("edit-guard", "edit-guard", "edit-guard.js");
    o.events = vec!["PreToolUse"];
    o.tools = vec!["*"];
    o.node_flags = strs(&["--no-concurrent-recompilation", "--no-concurrent-sparkplug"]);
    o
}
