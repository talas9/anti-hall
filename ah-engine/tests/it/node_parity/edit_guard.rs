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
use std::path::Path;
use std::process::{Command, Stdio};
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
    // ---- (6) the main thread: the verdict on each target (lane L12)
    main_thread(&mut out);
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("edit-guard", "edit-guard", "edit-guard.js");
    o.events = vec!["PreToolUse"];
    o.tools = vec!["*"];
    o.node_flags = strs(&["--no-concurrent-recompilation", "--no-concurrent-sparkplug"]);
    o.state_files = Some(|_| regex::Regex::new(r"^\.anti-hall/inline-work-.*\.json$").unwrap());
    o
}

// ---------------------------------------------------------------------------------------------------------------------
// (6) the main thread

fn git(dir: &Path, args: &[&str]) {
    let mut c = Command::new("git");
    c.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for (k, v) in super::lab::GITENV {
        c.env(k, v);
    }
    c.output().expect("git must be runnable");
}

fn put(home: &Path, rel: &str, body: &str) {
    write_file(&home.join(rel), body.as_bytes());
}

fn sha256_hex(b: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, b).as_ref().iter().map(|x| format!("{x:02x}")).collect()
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail
    unsafe { libc::getuid() }
}

/// A repository allowlist and the matching trust record (`trust`: a different recorded hash).
fn allowlist(home: &Path, body: &str, trust: Option<&str>) {
    put(home, "proj/.anti-hall/edit-allow.json", body);
    let key = std::fs::canonicalize(home.join("proj")).unwrap().to_string_lossy().to_string();
    let hash = trust.map_or_else(|| sha256_hex(body.as_bytes()), str::to_string);
    put(home, ".anti-hall/trusted-edit-allow.json", &format!("{{{}:{}}}", serde_json::to_string(&key).unwrap(), serde_json::to_string(&hash).unwrap()));
}

/// `$HOME/proj` (a repository) with files of every kind, `$HOME/other` (a second one), links, a hard link and the harness plan files.
fn main_setup(home: &Path) {
    for (rel, body) in [
        ("proj/src/main.rs", "fn main() {}\n"),
        ("proj/src/lib.rs", "x\n"),
        ("proj/docs/readme.md", "x\n"),
        ("proj/CLAUDE.md", "x\n"),
        ("proj/AGENTS.md", "x\n"),
        ("proj/PLAN.md", "x\n"),
        ("proj/sub/CLAUDE.md", "x\n"),
        ("proj/x.txt", "x\n"),
        ("proj/handover-note.md", "x\n"),
        ("proj/CONTINUE-HERE.md", "x\n"),
        ("proj/.claude/s.json", "{}\n"),
        ("proj/.anti-hall/history/n.md", "x\n"),
        ("proj/hooks/h.js", "x\n"),
        ("other/a.txt", "x\n"),
        ("outside/o.txt", "x\n"),
        (".claude/plans/p.md", "x\n"),
        (".anti-hall/bin/launcher.sh", "#!/bin/sh\n"),
    ] {
        put(home, rel, body);
    }
    for r in ["proj", "other"] {
        git(&home.join(r), &["init", "-q", "-b", "main"]);
    }
    let l = |from: &str, to: &str| {
        std::os::unix::fs::symlink(home.join(from), home.join(to)).ok();
    };
    l("outside/o.txt", "proj/lnk.txt");
    l("outside", "proj/lnkdir");
    l("proj/src/lib.rs", "proj/STATE.json");
    l("proj", "lnkproj");
    std::fs::hard_link(home.join("proj/src/lib.rs"), home.join("proj/GEMINI.md")).ok();
    std::fs::hard_link(home.join("proj/x.txt"), home.join("proj/hard.txt")).ok();
}

fn ds_desc(home: &Path) {
    put(home, ".anti-hall/devswarm/workspaces/b1.json", "{}");
}

fn push1(out: &mut Vec<Scenario>, payload: Value, c: &Arc<Ctx>, id: String) {
    out.push(Scenario { id, ctx: Some(c.clone()), steps: vec![Step::new(payload)] });
}

fn main_thread(out: &mut Vec<Scenario>) {
    let base = |entry: &str| Ctx::new().env("ANTIHALL_INGEST_DRY_RUN", "1").env("CLAUDE_CODE_ENTRYPOINT", entry).setup(main_setup);
    let c_cli = base("cli").arc();
    let c_agent = base("agent_tool").arc();
    let c_none = Ctx::new().env("ANTIHALL_INGEST_DRY_RUN", "1").setup(main_setup).arc();
    let c_trust = base("cli")
        .setup(|h| {
            main_setup(h);
            allowlist(h, r#"{"paths":["docs/**","*.md","src/gen/*.rs","../escape","/abs","~/x",".git/hooks/*","src/lib.rs"]}"#, None);
        })
        .arc();
    let c_untrusted = base("cli")
        .setup(|h| {
            main_setup(h);
            allowlist(h, r#"{"paths":["docs/**"]}"#, Some("deadbeef"));
        })
        .arc();
    let c_trust_off = base("cli")
        .settings(json!({"guards": {"projectEditAllow": false}}))
        .setup(|h| {
            main_setup(h);
            allowlist(h, r#"{"paths":["docs/**"]}"#, None);
        })
        .arc();
    let c_extra = base("cli").settings(json!({"guards": {"editGuardAllow": "src/lib.rs,*.txt"}})).arc();
    let c_ds = base("cli").env("DEVSWARM_REPO_ID", "r1").arc();
    let c_ds_off = base("cli").env("DEVSWARM_REPO_ID", "r1").settings(json!({"devswarm": {"dispatchTierText": false}})).arc();
    let c_ds_child = base("cli")
        .env("DEVSWARM_REPO_ID", "r1")
        .env("DEVSWARM_SOURCE_BRANCH", "feat")
        .env("DEVSWARM_BUILDER_ID", "b1")
        .setup(|h| {
            main_setup(h);
            ds_desc(h);
        })
        .arc();
    let c_ds_child_nodesc = base("cli").env("DEVSWARM_REPO_ID", "r1").env("DEVSWARM_SOURCE_BRANCH", "feat").env("DEVSWARM_BUILDER_ID", "nope").arc();
    let c_ds_nudge = base("cli").env("DEVSWARM_REPO_ID", "r1").settings(json!({"devswarm": {"inlineWorkNudgeThreshold": 2}})).arc();
    let c_ds_nudge_off = base("cli").env("DEVSWARM_REPO_ID", "r1").settings(json!({"devswarm": {"inlineWorkNudge": false}})).arc();

    let plan = json!({"permission_mode": "plan"});
    let uidv = uid();
    // the session scratchpad of the transcript's project directory (any of the three temp roots)
    let scratch = format!("/tmp/claude-{uidv}/-seg-proj/sid1/scratchpad");
    let tp = json!({"transcript_path": "/x/-seg-proj/sid1.jsonl", "session_id": "sid1"});

    let paths: Vec<String> = [
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        "PLAN.md",
        "plan.md",
        "STATE.json",
        "sub/CLAUDE.md",
        "src/lib.rs",
        "src/main.rs",
        "src/new.py",
        "docs/readme.md",
        "docs/new.md",
        "x.txt",
        "new.txt",
        ".claude/s.json",
        ".claude/new.json",
        ".omc/state.json",
        ".anti-hall/history/n.md",
        ".anti-hall/history/new.md",
        ".anti-hall/other.json",
        ".anti-hall/edit-allow.json",
        ".anti-hall/EDIT-ALLOW.json",
        "../other/a.txt",
        "../outside/o.txt",
        "lnk.txt",
        "lnkdir/o.txt",
        "lnkdir/new.txt",
        "hard.txt",
        "handover-note.md",
        "docs/HANDOVER-2026.md",
        "HANDOVER-new.md",
        "x-handoff.md",
        "session-compact-handover.md",
        "handover.js",
        "CONTINUE-HERE.md",
        "NEW.continue-here.md",
        "sub/CONTINUE-HERE.md",
        "hooks/h.js",
        "hooks/hooks.json",
        ".git/config",
        ".git/hooks/pre-commit",
        "../lnkproj/CLAUDE.md",
        "$HOME/proj/CLAUDE.md",
        "$HOME/lnkproj/PLAN.md",
        "$HOME/.claude/plans/p.md",
        "$HOME/.claude/plans/new.md",
        "$HOME/.claude/plans/x.txt",
        "$HOME/.claude/plans/../s.json",
        "$HOME/handover-x.md",
        "$HOME/.anti-hall/handovers/2026-01-01/s/HANDOVER.md",
        "$HOME/.claude/projects/p/memory/MEMORY.md",
        "/tmp/x.md",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut p2 = paths.clone();
    p2.push(format!("{scratch}/n.txt"));
    p2.push(format!("{scratch}/../x.txt"));
    p2.push(format!("/tmp/claude-{uidv}/-seg-proj/other/scratchpad/n.txt"));
    let all: Vec<(&str, &Arc<Ctx>)> =
        vec![("cli", &c_cli), ("trust", &c_trust), ("untrusted", &c_untrusted), ("trustoff", &c_trust_off), ("extra", &c_extra), ("ds", &c_ds)];
    for (k, c) in &all {
        for (i, f) in p2.iter().enumerate() {
            for (t, field) in [("Edit", "file_path"), ("Write", "file_path"), ("NotebookEdit", "notebook_path")] {
                if i % 3 != 0 && t != "Edit" && *k != "cli" {
                    continue;
                }
                let payload = assign(
                    json!({"hook_event_name": "PreToolUse", "tool_name": t, "session_id": "sid1", "cwd": "$HOME/proj", "tool_input": {field: f}}),
                    tp.clone(),
                );
                push1(out, payload, c, format!("main-{k}-{t}-{i}-{}", clip(&non_alnum_underscore(f), 30)));
            }
        }
    }
    // plan mode, a subdirectory as the working directory, MultiEdit, the subagent and the unknown entry point
    for (k, c) in [("cli", &c_cli), ("ds", &c_ds), ("dsoff", &c_ds_off)] {
        for (i, f) in paths.iter().enumerate() {
            let payload = assign(
                json!({"hook_event_name": "PreToolUse", "tool_name": "Write", "session_id": "sid1", "cwd": "$HOME/proj", "tool_input": {"file_path": f}}),
                plan.clone(),
            );
            push1(out, payload, c, format!("mainplan-{k}-{i}-{}", clip(&non_alnum_underscore(f), 30)));
            let sub = json!({"hook_event_name": "PreToolUse", "tool_name": "MultiEdit", "session_id": "sid1", "cwd": "$HOME/proj/src", "tool_input": {"file_path": f}});
            push1(out, sub, c, format!("mainsub-{k}-{i}-{}", clip(&non_alnum_underscore(f), 30)));
        }
    }
    // an existing launcher file spelled in another case: the path is judged as written (fs.realpathSync keeps the spelling)
    for (k, c) in [("agent", &c_agent), ("cli", &c_cli)] {
        for (i, f) in [
            "$HOME/.Anti-Hall/bin/launcher.sh",
            "$HOME/.ANTI-HALL/bin",
            "$HOME/.anti-hall/BIN/launcher.sh",
            "$HOME/.anti-hall/bin/launcher.sh",
            "$HOME/LNKPROJ/CLAUDE.md",
        ]
        .iter()
        .enumerate()
        {
            push1(out, pls("Edit", json!({"file_path": f})), c, format!("mainlauncher-{k}-{i}"));
        }
    }
    for (k, c) in [("agent", &c_agent), ("none", &c_none)] {
        for (i, f) in ["CLAUDE.md", "src/lib.rs", ".anti-hall/bin/x.sh", "$HOME/.anti-hall/bin/x.sh"].iter().enumerate() {
            push1(out, pls("Edit", json!({"file_path": f})), c, format!("mainother-{k}-{i}"));
        }
    }
    // a DevSwarm child workspace is a worker; the descriptor, or its absence, decides
    for (k, c) in [("child", &c_ds_child), ("childnodesc", &c_ds_child_nodesc)] {
        for (i, f) in ["src/lib.rs", "CLAUDE.md", "$HOME/.anti-hall/bin/x.sh"].iter().enumerate() {
            let payload =
                json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": "sid1", "cwd": "$HOME/proj", "tool_input": {"file_path": f}});
            push1(out, payload, c, format!("mainds-{k}-{i}"));
        }
    }
    // Codex apply_patch: the targets are checked one by one, an unparseable patch is blocked
    let patches: Vec<String> = vec![
        "*** Begin Patch\n*** Add File: CLAUDE.md\n+x\n*** End Patch".into(),
        "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-x\n+y\n*** End Patch".into(),
        "*** Begin Patch\n*** Update File: CLAUDE.md\n*** Move to: src/moved.rs\n@@\n-x\n+y\n*** End Patch".into(),
        "*** Begin Patch\n*** Delete File: src/lib.rs\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: PLAN.md\n+x\n*** Add File: src/new.rs\n+y\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: src/new.rs\n+y\n*** Add File: PLAN.md\n+x\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: ../escape.md\n+x\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: $HOME/.anti-hall/bin/x.sh\n+x\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: $HOME/proj/docs/a.md\n+x\n*** End Patch".into(),
        "junk".into(),
        "".into(),
        "*** Begin Patch\n*** End Patch".into(),
        "*** Begin Patch\n*** Add File: CLAUDE.md\n+x".into(),
    ];
    for (k, c) in [("cli", &c_cli), ("trust", &c_trust), ("agent", &c_agent), ("none", &c_none)] {
        for (i, cmd) in patches.iter().enumerate() {
            let payload =
                json!({"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "session_id": "sid1", "cwd": "$HOME/proj", "tool_input": {"command": cmd}});
            push1(out, payload, c, format!("mainpatch-{k}-{i}"));
        }
    }
    let payload = |cwd: Value| json!({"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "session_id": "sid1", "cwd": cwd, "tool_input": {"command": patches[1].clone()}});
    push1(out, payload(json!("$HOME/proj/src")), &c_cli, "mainpatch-cwdsub".into());
    // the inline-work counter of a DevSwarm Primary: counted on every main-thread call, in Node's file
    for (k, c) in [("ds", &c_ds), ("dsoff", &c_ds_nudge_off), ("nudge2", &c_ds_nudge)] {
        for variant in 0..2 {
            let mut steps: Vec<Step> = Vec::new();
            for i in 0..8 {
                let f = ["docs/a.md", "CLAUDE.md", "src/lib.rs", "src/main.rs"][(i + variant) % 4];
                let extra = if k == "nudge2" && variant == 1 { json!({"transcript_path": "/nonexistent/t.jsonl"}) } else { json!({}) };
                steps.push(Step::new(assign(
                    json!({"hook_event_name": "PreToolUse", "tool_name": "Write", "session_id": "sid1", "cwd": "$HOME/proj", "tool_input": {"file_path": f}}),
                    extra,
                )));
            }
            out.push(Scenario { id: format!("mainnudge-{k}-{variant}"), ctx: Some(c.clone()), steps });
        }
    }
}
