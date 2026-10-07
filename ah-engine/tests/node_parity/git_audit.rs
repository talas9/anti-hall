//! Parity of the built-in `git-audit` check against `hooks/git-guard.js --audit` (PostToolUse on Bash). Fixture repositories
//! are built in the home with fixed author and commit dates, so both sides see the same hashes and ages.
//! Corpus: every git verb in every fixture repository, the wrappers and structure around a command, `cd` and `-C` forms,
//! payload shapes, switches, fuzzed commands, and real git commands from local data (`AH_PARITY_REAL_CMDS`, optional).

use super::guard::*;
use super::support::*;
use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

include!("git_audit_tables.rs");

/// The trailer text is assembled so this file itself never carries a credit line.
fn credit() -> String {
    ["Co-Authored", "By: Claude <noreply@anthropic.com>"].join("-")
}
fn generated() -> String {
    format!("\u{1F916} {}", ["Generated", "with [Claude Code](https://claude.com/claude-code)"].join(" "))
}

struct Fixture {
    name: String,
    commits: Vec<(String, i64)>,
}

fn fixtures() -> Vec<Fixture> {
    let c = credit();
    let g = generated();
    let fx = |name: &str, commits: Vec<(String, i64)>| Fixture { name: name.to_string(), commits };
    vec![
        fx("recent", vec![(format!("feat: x\n\n{c}"), 60)]),
        fx("old", vec![(format!("feat: x\n\n{c}"), 3000)]),
        fx("clean", vec![("feat: clean".into(), 30), ("fix: clean2".into(), 20)]),
        fx("mixed", vec![("one".into(), 100), (format!("two\n\n{c}"), 50), (format!("three\n\n{g}"), 10), ("four".into(), 5)]),
        fx("generated", vec![(format!("x\n\n{g}"), 40)]),
        fx("lower", vec![(format!("x\n\n{}", c.to_lowercase().replace("claude <noreply@anthropic.com>", "GPT <x@openai.com>")), 40)]),
        fx("escaped", vec![(format!("x \\n\\n{c}"), 40)]),
        fx("human", vec![("x\n\nCo-authored-by: Alice <alice@example.com>".into(), 40)]),
        fx("twentyfive", (0..25).map(|i| (if i == 0 { format!("oldest\n\n{c}") } else { format!("c{i}") }, 200 - i as i64)).collect()),
        fx("emptymsg", vec![(" ".into(), 30)]),
        fx("unicode", vec![(format!("\u{fc}n\u{ef} \u{2603} \u{1F600}\n\n{c}"), 25)]),
        fx("sp ace", vec![(format!("x\n\n{c}"), 25)]),
        fx("empty", vec![]),
    ]
}

fn git(cwd: &Path, args: &[&str], date: Option<&str>) {
    let mut c = Command::new("git");
    c.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    if let Some(d) = date {
        c.env("GIT_AUTHOR_DATE", d).env("GIT_COMMITTER_DATE", d);
    }
    let out = c.output().expect("git must be runnable");
    assert!(out.status.success(), "git {args:?} failed in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
}

fn commit(dir: &Path, msg: &str, age: i64, i: usize, t0: i64) {
    write_file(&dir.join("f.txt"), format!("v{i}\n").as_bytes());
    git(dir, &["add", "-A"], None);
    let d = format!("@{} +0000", t0 - age);
    let msg_file = dir.join(".msg");
    write_file(&msg_file, msg.as_bytes());
    git(
        dir,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--allow-empty-message",
            "--cleanup=verbatim",
            "-F",
            &msg_file.to_string_lossy(),
        ],
        Some(&d),
    );
    std::fs::remove_file(&msg_file).expect("the commit message file was just written");
}

fn setup(home: &Path, t0: i64) {
    for f in fixtures() {
        let dir = home.join(&f.name);
        std::fs::create_dir_all(&dir).expect("fixture directory");
        git(&dir, &["init", "-q", "-b", "main"], None);
        for (i, (m, age)) in f.commits.iter().enumerate() {
            commit(&dir, m, *age, i, t0);
        }
    }
    let aliased = home.join("aliased");
    std::fs::create_dir_all(&aliased).expect("fixture directory");
    git(&aliased, &["init", "-q", "-b", "main"], None);
    commit(&aliased, &format!("a\n\n{}", credit()), 30, 0, t0);
    for (k, v) in [
        ("alias.ci", "commit"),
        ("alias.cm", "commit -m"),
        ("alias.sh", "!git commit -m x"),
        ("alias.st", "status"),
        ("alias.chain", "ci"),
        ("alias.loop", "loop"),
        ("alias.opt", "-c x.y=1 commit"),
        ("alias.rb", "rebase"),
    ] {
        git(&aliased, &["config", k, v], None);
    }
    std::fs::create_dir_all(home.join("recent").join("sub dir")).expect("fixture directory");
}

const H: &str = "$HOME";

fn post(s: &str, command: &Value, extra: Value) -> Step {
    let p = assign(
        json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "session_id": s, "cwd": format!("{H}/recent"), "tool_input": {"command": command}}),
        extra,
    );
    Step::argv(p, &["--audit"])
}

fn wrap(c: &str) -> Vec<String> {
    vec![
        c.to_string(),
        format!("bash -c '{c}'"),
        format!("sh -c \"{c}\""),
        format!("eval \"{c}\""),
        format!("eval '{c}'"),
        format!("bash -lc \"{c}\""),
        format!("zsh -c '{c}'"),
        format!("({c})"),
        format!("{{ {c}; }}"),
        format!("echo x && {c}"),
        format!("{c} && echo done"),
        format!("false; {c}"),
        format!("true || {c}"),
        format!("{c} &"),
        format!("{c} | cat"),
        format!("echo $({c})"),
        format!("cat <<EOF\n{c}\nEOF"),
        format!("FOO=1 {c}"),
        format!("bash -c \"bash -c '{c}'\""),
        format!("eval \"eval '{c}'\""),
        format!("bash -c \"eval 'bash -c \\\"{c}\\\"'\""),
        format!("echo '{c}' | sh"),
        format!("xargs -I{{}} sh -c \"{{}}\" <<< \"{c}\""),
    ]
}

type Shape = (&'static str, fn(&mut Value));

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let t0 = (now_ms() / 1000) as i64;
    let ctx = Ctx::new().setup(move |home| setup(home, t0)).arc();
    let mut out: Vec<Scenario> = Vec::new();
    let mut n = 0usize;
    let mut sid = || {
        let v = format!("g{n}");
        n += 1;
        v
    };
    let add = |out: &mut Vec<Scenario>, steps: Vec<Step>, c: &Arc<Ctx>, id: String| out.push(Scenario { id, ctx: Some(c.clone()), steps });

    let mut one = |out: &mut Vec<Scenario>, cmd: &str, cwd_repo: Option<&str>, extra: Value| {
        let repo = cwd_repo.unwrap_or("recent");
        let s = sid();
        add(out, vec![post(&s, &json!(cmd), assign(json!({"cwd": format!("{H}/{repo}")}), extra))], &ctx, format!("u-{repo}-{}", clip(cmd, 30)));
    };
    let fx_names: Vec<String> = fixtures().into_iter().map(|f| f.name).collect();
    let repo_names: Vec<&str> = fx_names.iter().map(String::as_str).filter(|n| *n != "empty").collect();
    let mut all_repos: Vec<&str> = repo_names.clone();
    all_repos.extend(["empty", "aliased"]);
    for repo in &all_repos {
        for v in VERBS {
            one(&mut out, v, Some(repo), json!({}));
        }
    }
    // wrappers and structure
    for w in wrap("git commit -m x") {
        for repo in ["recent", "clean", "mixed"] {
            one(&mut out, &w, Some(repo), json!({}));
        }
    }
    for w in wrap("git -C $HOME/mixed commit -m x") {
        one(&mut out, &w, Some("clean"), json!({}));
    }
    // cd handling and -C forms
    for c in CDLIST {
        let repo = *r.pick(&["recent", "clean", "sub dir"]);
        one(&mut out, c, Some(repo), json!({}));
    }
    {
        let s = sid();
        add(&mut out, vec![post(&s, &json!("git commit -m x"), json!({"cwd": format!("{H}/recent/sub dir")}))], &ctx, "u-cwd-subdir".into());
    }
    // shapes (the Bash matcher of the hook wiring, not the hook, is what keeps other tools out, so no tool-name shapes here)
    let shapes: Vec<Shape> = vec![
        ("noInput", |p| {
            p.as_object_mut().map(|m| m.remove("tool_input"));
        }),
        ("nullInput", |p| p["tool_input"] = Value::Null),
        ("cmdNum", |p| p["tool_input"]["command"] = json!(5)),
        ("cmdEmpty", |p| p["tool_input"]["command"] = json!("")),
        ("noCmd", |p| p["tool_input"] = json!({})),
        ("noCwd", |p| {
            p.as_object_mut().map(|m| m.remove("cwd"));
        }),
        ("cwdEmpty", |p| p["cwd"] = json!("")),
        ("cwdNum", |p| p["cwd"] = json!(5)),
        ("cwdRel", |p| p["cwd"] = json!("recent")),
        ("cwdMissing", |p| p["cwd"] = json!("/nonexistent/dir")),
        ("cwdNotRepo", |p| p["cwd"] = json!("/tmp")),
        ("cwdSlash", |p| p["cwd"] = json!(format!("{H}/recent/"))),
        ("noSid", |p| {
            p.as_object_mut().map(|m| m.remove("session_id"));
        }),
    ];
    for (k, f) in shapes {
        let s = sid();
        let mut st = post(&s, &json!("git commit -m x"), json!({}));
        f(&mut st.payload);
        add(&mut out, vec![st], &ctx, format!("shape-{k}"));
    }
    {
        let s = sid();
        add(&mut out, vec![post(&s, &json!("git commit"), json!({"cwd": format!("{H}/old")}))], &ctx, "win-old".into());
    }
    // switches
    let now = now_ms() as i64;
    let mk = move || Ctx::new().setup(move |home| setup(home, t0));
    let two = |sid: &mut dyn FnMut() -> String| {
        let (a, b) = (sid(), sid());
        vec![post(&a, &json!("git commit -m x"), json!({})), post(&b, &json!("git -C $HOME/mixed commit"), json!({}))]
    };
    let sw: Vec<(&str, Value)> = vec![
        ("off", json!({"guards": {"gitGuard": false}})),
        ("safetyOff", json!({"safety": {"gitGuard": false}})),
        ("safetyStr", json!({"safety": {"gitGuard": "off"}})),
        ("safetyOn", json!({"safety": {"gitGuard": "on"}})),
        ("junk", json!({"safety": {"gitGuard": "zz"}})),
    ];
    for (k, s) in sw {
        let c = mk().settings(s).arc();
        let steps = two(&mut sid);
        add(&mut out, steps, &c, format!("ctx-{k}"));
    }
    for (k, (ek, ev)) in [
        ("envOff", ("ANTIHALL_GIT_GUARD", "off")),
        ("env0", ("ANTIHALL_GIT_GUARD", "0")),
        ("env1", ("ANTIHALL_GIT_GUARD", "1")),
        ("optFalse", ("CLAUDE_PLUGIN_OPTION_SAFETY_GIT_GUARD", "false")),
    ] {
        let c = mk().env(ek, ev).arc();
        let steps = two(&mut sid);
        add(&mut out, steps, &c, format!("ctx-{k}"));
    }
    for (k, s) in [
        ("skip", Some(json!({"git-guard": now + 3600000}))),
        ("skipAll", Some(json!({"all": now + 3600000}))),
        ("skipExpired", Some(json!({"git-guard": now - 1000}))),
        ("skipJunk", None),
    ] {
        let c = match s {
            Some(v) => mk().skip(v),
            None => mk().skip_raw("{no"),
        }
        .arc();
        let steps = two(&mut sid);
        add(&mut out, steps, &c, format!("ctx-{k}"));
    }
    // real commands, run in a fixture repo (local data)
    let git_cmds: Vec<Value> =
        real_cmds().into_iter().filter(|c| c["cmd"].as_str().is_some_and(|s| regex::Regex::new(r"\bgit\b").unwrap().is_match(s))).collect();
    for i in 0..real_limit().min(1500).min(git_cmds.len()) {
        let s = sid();
        let c = git_cmds[r.below(git_cmds.len())].clone();
        let repo = *r.pick(&["recent", "mixed", "clean", "aliased"]);
        add(&mut out, vec![post(&s, &c["cmd"], json!({"cwd": format!("{H}/{repo}")}))], &ctx, format!("real-{i}"));
    }
    // fuzz
    for i in 0..1500 {
        let mut parts = String::new();
        let k = 1 + r.below(10);
        for _ in 0..k {
            parts.push_str(r.pick(&FRAG));
            parts.push_str(r.pick(&WS));
        }
        let s = sid();
        let repo = *r.pick(&["recent", "mixed", "aliased"]);
        add(&mut out, vec![post(&s, &json!(parts), json!({"cwd": format!("{H}/{repo}")}))], &ctx, format!("fuzz-{i}"));
    }
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("git-audit", "git-audit", "git-guard.js");
    o.mode = Mode::Daemon;
    o.events = vec!["PostToolUse"];
    o.conc = 6;
    o.node_argv = Some(|_| strs(&["--audit"]));
    o
}
