//! Corpus for codex-nudge (Stop): transcript scanning, thresholds, exclusions, quota gating, Jev, state and pruning.

use super::b78::*;
use super::jsjson::{J, a, n, o, s};
use super::lab::Lab;
use super::support::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const SID: &str = "sess-1";

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail
    unsafe { libc::getuid() }
}

/// The sandbox layout: `<root>/repo` (git), `<root>/home`, the transcript under `home/.claude/projects/<enc>/<sid>.jsonl`.
struct Base {
    cwd: PathBuf,
    repo: PathBuf,
    transcript: PathBuf,
    scratch: PathBuf,
}

fn base(lab: &Lab, root: &Path) -> Base {
    let repo = lab.repo(root, "repo", &[("a.js", "x\n")]);
    let cwd = repo.clone();
    let enc = enc_dashes(&cwd.to_string_lossy());
    let tdir = root.join("home/.claude/projects").join(&enc);
    std::fs::create_dir_all(&tdir).expect("transcript dir");
    Base {
        cwd: cwd.clone(),
        repo,
        transcript: tdir.join(format!("{SID}.jsonl")),
        scratch: root.join("tmp").join(format!("claude-{}", uid())).join(&enc).join(SID).join("scratchpad"),
    }
}

fn ps(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn tool(name: J, input: Option<J>) -> J {
    let mut v = vec![("type", s("tool_use")), ("name", name)];
    if let Some(i) = input {
        v.push(("input", i));
    }
    o(v)
}
fn edit_as(f: &str, name: &str) -> J {
    o(vec![("type", s("tool_use")), ("name", s(name)), ("id", s("t")), ("input", o(vec![("file_path", s(f))]))])
}
fn edit(f: &str) -> J {
    edit_as(f, "Edit")
}
fn tu_line(tus: Vec<J>, wrap: Option<&str>) -> String {
    match wrap {
        Some("flat") => tus[0].text(),
        Some("messages") => o(vec![("type", s("x")), ("messages", a(tus.into_iter().map(|t| o(vec![("content", a(vec![t]))])).collect()))]).text(),
        Some("parts") => o(vec![("parts", a(tus))]).text(),
        Some("tool_uses") => o(vec![("tool_uses", a(tus))]).text(),
        Some("msgobj") => o(vec![("message", o(vec![("content", a(tus))]))]).text(),
        _ => o(vec![("type", s("assistant")), ("message", o(vec![("content", a(tus))]))]).text(),
    }
}
fn e_n(count: usize, ext: &str, dir: &str) -> Vec<J> {
    (0..count).map(|i| edit(&format!("{dir}/f{i}.{ext}"))).collect()
}
fn under(b: &Base, rel: &str) -> String {
    path_join(&[&ps(&b.repo), rel])
}

type LinesFn = Box<dyn Fn(&Path, &Base) -> Vec<String> + Send + Sync>;
type BeforeFn = Box<dyn Fn(&Lab, &Path, &Base) + Send + Sync>;
type PayloadFn = Box<dyn Fn(&Path, &Base) -> Vec<(&'static str, Option<J>)> + Send + Sync>;

/// `mk(lines, o)`: write the transcript, run the `before` hook, and build the Stop payload.
struct Mk {
    lines: Result<LinesFn, String>,
    eol: &'static str,
    no_final: bool,
    before: Option<BeforeFn>,
    payload: Option<PayloadFn>,
    env: Env,
}

fn mk(f: impl Fn(&Path, &Base) -> Vec<String> + Send + Sync + 'static) -> Mk {
    Mk { lines: Ok(Box::new(f)), eol: "\n", no_final: false, before: None, payload: None, env: Vec::new() }
}
fn mk_text(text: &str) -> Mk {
    Mk { lines: Err(text.to_string()), eol: "\n", no_final: false, before: None, payload: None, env: Vec::new() }
}

impl Mk {
    fn eol(mut self, e: &'static str) -> Mk {
        self.eol = e;
        self
    }
    fn no_final(mut self) -> Mk {
        self.no_final = true;
        self
    }
    fn before(mut self, f: impl Fn(&Lab, &Path, &Base) + Send + Sync + 'static) -> Mk {
        self.before = Some(Box::new(f));
        self
    }
    fn payload(mut self, f: impl Fn(&Path, &Base) -> Vec<(&'static str, Option<J>)> + Send + Sync + 'static) -> Mk {
        self.payload = Some(Box::new(f));
        self
    }
    fn env(mut self, k: &str, v: Option<&str>) -> Mk {
        self.env.push((k.into(), v.map(str::to_string)));
        self
    }
    fn build(&self, lab: &Lab, root: &Path) -> Built {
        let b = base(lab, root);
        let text = match &self.lines {
            Ok(f) => {
                let ls = f(root, &b);
                format!("{}{}", ls.join(self.eol), if self.no_final { "" } else { "\n" })
            }
            Err(t) => t.clone(),
        };
        write_file(&b.transcript, text.as_bytes());
        if let Some(bf) = &self.before {
            bf(lab, root, &b);
        }
        let mut p = o(vec![
            ("hook_event_name", s("Stop")),
            ("session_id", s(SID)),
            ("cwd", s(&ps(&b.cwd))),
            ("transcript_path", s(&ps(&b.transcript))),
            ("stop_hook_active", J::Bool(false)),
        ]);
        if let Some(pf) = &self.payload {
            for (k, v) in pf(root, &b) {
                match v {
                    Some(v) => p.set(k, v),
                    None => p.remove(k),
                }
            }
        }
        Built { payload: Some(Payload::Raw(p.text())), env: self.env.clone(), run_cwd: None }
    }
}

fn sc(id: &str, m: Mk) -> Sc {
    Sc::setup(id, move |lab, root| m.build(lab, root))
}

fn edits(count: usize, ext: &'static str) -> Mk {
    mk(move |_, b| vec![tu_line((0..count).map(|i| edit(&under(b, &format!("f{i}.{ext}")))).collect(), None)])
}
fn edits_js(count: usize) -> Mk {
    edits(count, "js")
}
fn four_edits(f: impl Fn(&Base, usize) -> String + Send + Sync + 'static) -> Mk {
    mk(move |_, b| vec![tu_line((0..4).map(|i| edit(&f(b, i))).collect(), None)])
}

fn w_settings(lab: &Lab, root: &Path, text: &str) {
    lab.write(root, "home/.anti-hall/settings.json", text, None);
}

fn with_settings(text: String, m: Mk) -> Sc {
    Sc::setup("", move |lab, root| {
        w_settings(lab, root, &text);
        m.build(lab, root)
    })
}
fn named(mut sc: Sc, id: &str) -> Sc {
    sc.id = id.to_string();
    sc
}

pub(crate) fn scenarios() -> Vec<Sc> {
    let mut out: Vec<Sc> = Vec::new();
    // ---- thresholds
    for count in [0usize, 1, 2, 3, 4, 7] {
        out.push(sc(&format!("edits-{count}"), edits_js(count)));
    }
    out.push(sc("edits-md-only", edits(5, "md")));
    out.push(sc("edits-json-only", edits(5, "json")));
    out.push(sc("edits-upper-ext", edits(4, "JS")));
    out.push(sc(
        "edits-all-exts",
        mk(|_, b| {
            [
                "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte", "dart", "py", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "rb",
                "php", "cs", "scala", "sh", "bash", "sql", "txt", "jsonl", "yml",
            ]
            .iter()
            .map(|e| tu_line(vec![edit(&under(b, &format!("f.{e}")))], None))
            .collect()
        }),
    ));
    out.push(sc(
        "edits-no-ext",
        mk(|_, b| vec![tu_line(vec![edit(&under(b, "Makefile")), edit(&under(b, "a.js.bak")), edit(&under(b, ".js")), edit(&under(b, "x.js/"))], None)]),
    ));
    out.push(sc(
        "edits-tools-mix",
        mk(|_, b| {
            vec![tu_line(
                vec![
                    edit_as(&under(b, "a.js"), "Write"),
                    edit_as(&under(b, "b.js"), "MultiEdit"),
                    edit_as(&under(b, "c.js"), "NotebookEdit"),
                    edit_as(&under(b, "d.js"), "edit"),
                    edit_as(&under(b, "e.js"), "Read"),
                ],
                None,
            )]
        }),
    ));
    out.push(sc("edits-same-file-4x", mk(|_, b| vec![tu_line((0..4).map(|_| edit(&under(b, "a.js"))).collect(), None)])));
    out.push(sc(
        "edits-same-base-different-dirs",
        mk(|_, b| vec![tu_line(vec![edit(&under(b, "x/a.js")), edit(&under(b, "y/a.js")), edit(&under(b, "z/a.js"))], None)]),
    ));
    out.push(sc("edits-6-files-names", edits_js(6)));
    out.push(sc(
        "edits-unicode-names",
        mk(|_, b| vec![tu_line(["\u{e9}.js", "\u{1F600}.py", "sp ace.ts", "tab\there.go", "new\nline.rs"].iter().map(|n| edit(&under(b, n))).collect(), None)]),
    ));
    out.push(sc(
        "edits-sort-bmp-vs-astral",
        mk(|_, b| vec![tu_line(["\u{e000}.js", "\u{1F600}.js", "a.js", "\u{ff5e}.js"].iter().map(|n| edit(&under(b, n))).collect(), None)]),
    ));
    out.push(sc(
        "edits-file_path-types",
        mk(|_, b| {
            let fp = |v: J| tool(s("Edit"), Some(o(vec![("file_path", v)])));
            vec![tu_line(
                vec![
                    fp(n(5.0)),
                    fp(J::Null),
                    fp(a(vec![s("a.js")])),
                    tool(s("Edit"), Some(a(vec![n(1.0)]))),
                    tool(s("Edit"), Some(s("a.js"))),
                    tool(s("Edit"), None),
                    fp(s(&under(b, "ok.js"))),
                ],
                None,
            )]
        }),
    ));
    out.push(sc(
        "tool-name-types",
        mk(|_, b| {
            let inp = || Some(o(vec![("file_path", s(&under(b, "a.js")))]));
            vec![tu_line(
                vec![
                    tool(n(5.0), inp()),
                    tool(a(vec![s("Edit")]), inp()),
                    tool(s(""), inp()),
                    o(vec![("type", s("tool_use")), ("input", o(vec![("file_path", s(&under(b, "a.js")))]))]),
                ],
                None,
            )]
        }),
    ));
    for wrap in ["flat", "messages", "parts", "tool_uses", "msgobj"] {
        out.push(sc(
            &format!("wrap-{wrap}"),
            mk(move |_, b| {
                let tus = e_n(4, "js", &ps(&b.repo));
                if wrap == "flat" { tus.iter().map(J::text).collect() } else { vec![tu_line(tus, Some(wrap))] }
            }),
        ));
    }
    out.push(sc(
        "wrap-nested-deep",
        mk(|_, b| {
            vec![
                o(vec![(
                    "message",
                    o(vec![("content", a(vec![o(vec![("content", a(vec![o(vec![("message", o(vec![("parts", a(e_n(4, "js", &ps(&b.repo))))]))])]))])]))]),
                )])
                .text(),
            ]
        }),
    ));
    out.push(sc(
        "wrap-string-array-elems",
        mk(|_, b| {
            let mut items = vec![s("x"), n(5.0), J::Null];
            items.extend(e_n(4, "js", &ps(&b.repo)));
            vec![o(vec![("content", a(items))]).text()]
        }),
    ));
    // ---- codex review present
    let review = |t: J| {
        mk(move |_, b| {
            let mut tus = e_n(4, "js", &ps(&b.repo));
            tus.push(t.clone());
            vec![tu_line(tus, None)]
        })
    };
    let ag = |k: &str, v: J| tool(s("Agent"), Some(o(vec![(k, v)])));
    let reviews: Vec<(&str, J)> = vec![
        ("agent-codex-rescue", ag("subagent_type", s("codex:codex-rescue"))),
        ("task-codex", tool(s("Task"), Some(o(vec![("subagent_type", s("codex"))])))),
        ("agentType", ag("agentType", s("codex:codex-rescue"))),
        ("agent_type", ag("agent_type", s("Codex:x"))),
        ("codexy", ag("subagent_type", s("codexy"))),
        ("codex-dash", ag("subagent_type", s("codex-rescue"))),
        ("codex-underscore", ag("subagent_type", s("codex_x"))),
        ("not-codex", ag("subagent_type", s("general-purpose"))),
        ("type-num", tool(s("Agent"), Some(o(vec![("subagent_type", n(5.0)), ("agentType", s("codex"))])))),
        ("type-empty-first", tool(s("Agent"), Some(o(vec![("subagent_type", s("")), ("agentType", s("codex"))])))),
        ("skill-codex", tool(s("Skill"), Some(o(vec![("skill", s("codex:rescue"))])))),
        ("skill-command", tool(s("Skill"), Some(o(vec![("command", s("/CODEX:setup"))])))),
        ("skill-other", tool(s("Skill"), Some(o(vec![("skill", s("review"))])))),
        ("skill-num", tool(s("Skill"), Some(o(vec![("skill", n(5.0))])))),
        ("bash-codex", tool(s("Bash"), Some(o(vec![("command", s("codex exec x"))])))),
    ];
    for (id, t) in reviews {
        out.push(sc(&format!("review-{id}"), review(t)));
    }
    // ---- min threshold settings
    for v in [
        "1",
        "2",
        "3",
        "4",
        "5",
        "0",
        "-3",
        "3.5",
        "2.5",
        "abc",
        "",
        " 4 ",
        "0x4",
        "0x3",
        "1e1",
        "Infinity",
        "-Infinity",
        "4abc",
        ".5",
        "5.",
        "+4",
        "0b100",
        "0o4",
        "1_0",
        "\u{664}",
    ] {
        out.push(sc(&format!("min-env-{}", js(v)), edits_js(4)).env("ANTIHALL_CODEX_NUDGE_MIN", v));
    }
    let mins: Vec<(String, String)> = vec![
        ("1".into(), "1".into()),
        ("2".into(), "2".into()),
        ("5".into(), "5".into()),
        ("0".into(), "0".into()),
        ("-1".into(), "-1".into()),
        ("3.5".into(), "3.5".into()),
        ("4".into(), "4".into()),
        ("4".into(), "4".into()),
        ("1000000000".into(), "1000000000".into()),
        ("\"5\"".into(), "\"5\"".into()),
        ("\" 5 \"".into(), "\" 5 \"".into()),
        ("\"x\"".into(), "\"x\"".into()),
        ("true".into(), "true".into()),
        ("false".into(), "false".into()),
        ("null".into(), "null".into()),
        ("[4]".into(), "[4]".into()),
        ("{\"a\":1}".into(), "{\"a\":1}".into()),
    ];
    for (id, v) in mins {
        out.push(named(with_settings(format!("{{\"codexNudge\":{{\"min\":{v}}}}}"), edits_js(4)), &format!("min-settings-{id}")));
    }
    out.push(named(with_settings("{\"codexNudge\":{\"min\":9}}".into(), edits_js(4)), "min-env-beats-settings").env("ANTIHALL_CODEX_NUDGE_MIN", "2"));
    out.push(named(with_settings("{\"codexNudge\":{\"min\":9}}".into(), edits_js(4)), "min-env-junk-falls-to-settings").env("ANTIHALL_CODEX_NUDGE_MIN", "zzz"));
    out.push(named(with_settings("{\"codexNudge\":[1]}".into(), edits_js(4)), "min-settings-section-array"));
    out.push(named(with_settings("{nope".into(), edits_js(4)), "min-settings-corrupt"));
    // ---- switches
    for v in ["off", "0", "false", "no", "on", "1", "maybe", ""] {
        out.push(sc(&format!("switch-env-{}", js(v)), edits_js(4)).env("ANTIHALL_CODEX_NUDGE", v));
    }
    out.push(named(with_settings("{\"codexNudge\":{\"enabled\":false}}".into(), edits_js(4)), "switch-settings-false"));
    out.push(named(with_settings("{\"codexNudge\":{\"enabled\":\"off\"}}".into(), edits_js(4)), "switch-settings-str-off"));
    out.push(sc("switch-plugin-option-false", edits_js(4)).env("CLAUDE_PLUGIN_OPTION_CODEX_NUDGE_ENABLED", "false"));
    out.push(sc("switch-plugin-option-true", edits_js(4)).env("CLAUDE_PLUGIN_OPTION_CODEX_NUDGE_ENABLED", "true"));
    let skip = |id: &str, text: &'static str| {
        let m = edits_js(4);
        Sc::setup(id, move |lab, root| {
            lab.write(root, "home/.anti-hall/skip.json", text, None);
            m.build(lab, root)
        })
    };
    out.push(skip("skip-own", "{\"codex-nudge\":4102444800000}"));
    out.push(skip("skip-all", "{\"all\":4102444800000}"));
    out.push(skip("skip-expired", "{\"codex-nudge\":1000}"));
    out.push(sc("judge-child", edits_js(4)).env("ANTIHALL_JUDGE_CHILD", "1"));
    // ---- payload shapes
    out.push(sc("no-transcript-path", edits_js(4).payload(|_, _| vec![("transcript_path", None)])));
    out.push(sc("transcript-relative", edits_js(4).payload(|_, _| vec![("transcript_path", Some(s("rel/t.jsonl")))])));
    out.push(sc("transcript-num", edits_js(4).payload(|_, _| vec![("transcript_path", Some(n(5.0)))])));
    out.push(sc("transcript-missing-file", edits_js(4).payload(|_, b| vec![("transcript_path", Some(s(&format!("{}.nope", ps(&b.transcript)))))])));
    out.push(sc("transcript-is-dir", edits_js(4).payload(|_, b| vec![("transcript_path", Some(s(&ps(b.transcript.parent().expect("transcript dir")))))])));
    out.push(sc("transcript-empty", mk_text("")));
    out.push(Sc::setup("payload-array", |_, _| Built { payload: Some(Payload::Raw("[1]".into())), ..Built::default() }));
    out.push(Sc::setup("payload-null", |_, _| Built { payload: Some(Payload::Raw("null".into())), ..Built::default() }));
    out.push(Sc::setup("payload-malformed", |_, _| Built { payload: Some(Payload::Raw("{\"a\":".into())), ..Built::default() }));
    out.push(Sc::setup("payload-empty", |_, _| Built { payload: Some(Payload::Raw(String::new())), ..Built::default() }));
    // ---- transcript content shapes
    let tu4 = |b: &Base| tu_line(e_n(4, "js", &ps(&b.repo)), None);
    out.push(sc("lines-invalid-json-mixed", mk(move |_, b| vec!["not json".into(), "{\"a\":".into(), tu4(b), "[1,2".into(), String::new()])));
    out.push(sc("lines-crlf", mk(|_, b| vec![tu_line(e_n(2, "js", &ps(&b.repo)), None), tu_line(e_n(2, "ts", &ps(&b.repo)), None)]).eol("\r\n")));
    out.push(sc("lines-no-final-newline", mk(move |_, b| vec![tu4(b)]).no_final()));
    out.push(sc("lines-whitespace-padded", mk(move |_, b| vec![format!("   {}  \t", tu4(b))])));
    out.push(sc(
        "lines-lone-surrogate-escape",
        mk(|_, b| {
            vec![
                tu_line(e_n(3, "js", &ps(&b.repo)), None),
                format!("{{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{{\"file_path\":\"{}/\\ud83d.js\"}}}}", ps(&b.repo)),
            ]
        }),
    ));
    out.push(sc("lines-deep-nesting", mk(move |_, b| vec![format!("{}{}", "[".repeat(200), "]".repeat(200)), tu4(b)])));
    out.push(sc("lines-number-out-of-range", mk(move |_, b| vec!["{\"n\":1e999}".into(), tu4(b)])));
    out.push(sc("lines-bom-first", mk(move |_, b| vec![format!("\u{feff}{}", tu4(b))])));
    let pad_line = |i: usize| o(vec![("type", s("user")), ("message", o(vec![("content", s(&format!("{}{i}", "x".repeat(1000))))]))]).text();
    out.push(sc(
        "transcript-big-tail-cut",
        mk(move |_, b| {
            let mut ls: Vec<String> = (0..700).map(pad_line).collect();
            ls.push(tu_line(e_n(4, "js", &ps(&b.repo)), None));
            ls
        }),
    ));
    out.push(sc(
        "transcript-big-edits-before-window",
        mk(move |_, b| {
            let mut ls = vec![tu_line(e_n(4, "js", &ps(&b.repo)), None)];
            ls.extend((0..700).map(pad_line));
            ls
        }),
    ));
    out.push(sc(
        "transcript-exact-window",
        mk(|_, b| {
            let one = tu_line(e_n(4, "js", &ps(&b.repo)), None);
            let pad_len = 524288usize.saturating_sub(one.len() + 1);
            vec![format!("{one}{}", " ".repeat(pad_len))]
        }),
    ));
    out.push(sc("transcript-utf8-multibyte-cut", mk(|_, b| vec!["\u{e9}".repeat(300000), tu_line(e_n(4, "js", &ps(&b.repo)), None)])));
    // ---- exclusions: scratchpad and worktree
    let scr = |b: &Base, i: usize, pre: &str| edit(&path_join(&[&ps(&b.scratch), &format!("{pre}{i}.py")]));
    out.push(sc(
        "scratch-excluded",
        mk(|_, b| {
            let mut tus = e_n(2, "js", &ps(&b.repo));
            tus.push(edit(&path_join(&[&ps(&b.scratch), "x.py"])));
            tus.push(edit(&path_join(&[&ps(&b.scratch), "y.py"])));
            vec![tu_line(tus, None)]
        }),
    ));
    out.push(sc("scratch-excluded-all", mk(move |_, b| vec![tu_line((0..4).map(|i| scr(b, i, "x")).collect(), None)])));
    out.push(sc(
        "scratch-wrong-session",
        mk(|_, b| {
            vec![tu_line((0..4).map(|i| edit(&path_join(&[&ps(&b.scratch), "..", "other-session", "scratchpad", &format!("x{i}.py")]))).collect(), None)]
        }),
    ));
    out.push(
        sc(
            "scratch-via-tmp-roots",
            mk(|_, b| {
                let enc = enc_dashes(&ps(&b.cwd));
                vec![tu_line((0..4).map(|i| edit(&format!("/tmp/claude-{}/{enc}/{SID}/scratchpad/x{i}.py", uid()))).collect(), None)]
            }),
        )
        .env_unset("TMPDIR"),
    );
    out.push(sc("scratch-tmpdir-trailing-slash", mk(move |_, b| vec![tu_line((0..4).map(|i| scr(b, i, "x")).collect(), None)])));
    out.push(Sc::setup("scratch-tmp-env", |lab, root| {
        let m = mk(|r, b| {
            let enc = enc_dashes(&ps(&b.cwd));
            vec![tu_line(
                (0..4).map(|i| edit(&path_join(&[&ps(r), "alt", &format!("claude-{}", uid()), &enc, SID, "scratchpad", &format!("x{i}.py")]))).collect(),
                None,
            )]
        });
        let mut b = m.build(lab, root);
        b.env = vec![("TMPDIR".into(), None), ("TMP".into(), Some(format!("{}/", path_join(&[&ps(root), "alt"]))))];
        b
    }));
    out.push(sc(
        "scratch-session-id-invalid",
        mk(move |_, b| vec![tu_line((0..4).map(|i| scr(b, i, "x")).collect(), None)]).payload(|_, _| vec![("session_id", Some(s("a b")))]),
    ));
    out.push(sc(
        "scratch-no-session-id",
        mk(move |_, b| vec![tu_line((0..4).map(|i| scr(b, i, "x")).collect(), None)]).payload(|_, _| vec![("session_id", None)]),
    ));
    out.push(sc(
        "scratch-transcript-relative",
        mk(move |_, b| vec![tu_line((0..4).map(|i| scr(b, i, "x")).collect(), None)]).payload(|_, _| vec![("transcript_path", Some(s("rel/x.jsonl")))]),
    ));
    out.push(sc("outside-worktree-excluded", four_edits(|_, i| format!("/elsewhere/f{i}.js"))));
    out.push(sc(
        "outside-worktree-mixed",
        mk(|_, b| {
            let mut tus = e_n(2, "js", &ps(&b.repo));
            tus.push(edit("/elsewhere/a.js"));
            tus.push(edit("/elsewhere/b.js"));
            vec![tu_line(tus, None)]
        }),
    ));
    out.push(sc("relative-paths-with-cwd", four_edits(|_, i| format!("sub/f{i}.js"))));
    out.push(sc("relative-dotdot-escape", four_edits(|_, i| format!("../outside/f{i}.js"))));
    out.push(sc("relative-no-cwd", four_edits(|_, i| format!("sub/f{i}.js")).payload(|_, _| vec![("cwd", None)])));
    out.push(sc("absolute-no-cwd", four_edits(|_, i| format!("/x/f{i}.js")).payload(|_, _| vec![("cwd", None)])));
    out.push(sc("cwd-relative", four_edits(|_, i| format!("/x/f{i}.js")).payload(|_, _| vec![("cwd", Some(s("sub")))])));
    out.push(sc("cwd-num", four_edits(|_, i| format!("/x/f{i}.js")).payload(|_, _| vec![("cwd", Some(n(5.0)))])));
    out.push(sc("cwd-not-a-repo", four_edits(|_, i| format!("/x/f{i}.js")).payload(|r, _| vec![("cwd", Some(s(&ps(r))))])));
    out.push(sc(
        "cwd-missing-dir-ancestor",
        four_edits(|b, i| path_join(&[&ps(&b.repo), "gone", &format!("f{i}.js")]))
            .payload(|_, b| vec![("cwd", Some(s(&path_join(&[&ps(&b.repo), "gone", "deeper"]))))]),
    ));
    out.push(sc(
        "cwd-subdir-of-repo",
        mk(|_, b| vec![tu_line(e_n(4, "js", &ps(&b.repo)), None)])
            .before(|_, _, b| std::fs::create_dir_all(b.repo.join("sub")).expect("sub"))
            .payload(|_, b| vec![("cwd", Some(s(&path_join(&[&ps(&b.repo), "sub"]))))]),
    ));
    out.push(sc(
        "cwd-inside-dotgit",
        mk(|_, b| vec![tu_line(e_n(4, "js", &ps(&b.repo)), None)]).payload(|_, b| vec![("cwd", Some(s(&path_join(&[&ps(&b.repo), ".git"]))))]),
    ));
    out.push(sc(
        "cwd-symlink-to-repo",
        mk(|_, b| vec![tu_line(e_n(4, "js", &ps(&b.repo)), None)])
            .before(|_, r, b| std::os::unix::fs::symlink(&b.repo, r.join("lnk")).expect("symlink"))
            .payload(|r, _| vec![("cwd", Some(s(&path_join(&[&ps(r), "lnk"]))))]),
    ));
    out.push(sc(
        "edit-path-symlink-into-repo",
        mk(|r, _| vec![tu_line((0..4).map(|i| edit(&path_join(&[&ps(r), "lnk2", &format!("f{i}.js")]))).collect(), None)])
            .before(|_, r, b| std::os::unix::fs::symlink(&b.repo, r.join("lnk2")).expect("symlink")),
    ));
    out.push(sc(
        "edit-path-symlink-out-of-repo",
        mk(|_, b| vec![tu_line((0..4).map(|i| edit(&path_join(&[&ps(&b.repo), "lnk3", &format!("f{i}.js")]))).collect(), None)])
            .before(|_, _, b| std::os::unix::fs::symlink("/tmp", b.repo.join("lnk3")).expect("symlink")),
    ));
    // linked worktree, submodule and nested repo: the payload names the inner directory
    fn stop_payload(cwd: &Path, tp: &Path) -> Built {
        Built {
            payload: Some(Payload::Raw(
                o(vec![("hook_event_name", s("Stop")), ("session_id", s(SID)), ("cwd", s(&ps(cwd))), ("transcript_path", s(&ps(tp)))]).text(),
            )),
            ..Built::default()
        }
    }
    fn write_tp(root: &Path, cwd: &Path, tus: Vec<J>) -> PathBuf {
        let tdir = root.join("home/.claude/projects").join(enc_dashes(&ps(cwd)));
        std::fs::create_dir_all(&tdir).expect("transcript dir");
        let tp = tdir.join(format!("{SID}.jsonl"));
        write_file(&tp, format!("{}\n", tu_line(tus, None)).as_bytes());
        tp
    }
    out.push(Sc::setup("linked-worktree", |lab, root| {
        let b = base(lab, root);
        let wt = root.join("wt");
        lab.git(&b.repo, &["worktree", "add", "-q", &ps(&wt), "-b", "feat"]);
        let mut tus = e_n(2, "js", &ps(&wt));
        tus.extend(e_n(2, "js", &ps(&b.repo)));
        let tp = write_tp(root, &wt, tus);
        stop_payload(&wt, &tp)
    }));
    out.push(Sc::setup("submodule", |lab, root| {
        let b = base(lab, root);
        let sub = lab.repo(root, "subsrc", &[("s.js", "s\n")]);
        lab.git(&b.repo, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &ps(&sub), "vendor/sub"]);
        lab.git(&b.repo, &["commit", "-q", "-m", "sub"]);
        let cwd = b.repo.join("vendor/sub");
        let mut tus = e_n(2, "js", &ps(&cwd));
        tus.extend(e_n(2, "js", &ps(&b.repo)));
        let tp = write_tp(root, &cwd, tus);
        stop_payload(&cwd, &tp)
    }));
    out.push(Sc::setup("nested-repo-in-repo", |lab, root| {
        let b = base(lab, root);
        let inner = lab.repo(root, "repo/inner", &[("i.js", "i\n")]);
        let mut tus = e_n(2, "js", &ps(&inner));
        tus.extend(e_n(2, "js", &ps(&b.repo)));
        let tp = write_tp(root, &inner, tus);
        stop_payload(&inner, &tp)
    }));
    // ---- quota gating
    let qrec = |until_delta: i64| {
        // the corpus read the clock once, when it built the scenario
        let until = now_ms() as i64 + until_delta;
        move |lab: &Lab, r: &Path, _: &Base| {
            lab.write(
                r,
                "home/.anti-hall/codex-availability.json",
                format!("{{\"available\":true,\"quota\":{{\"available\":false,\"until\":{until},\"reason\":\"x\"}}}}"),
                None,
            );
        }
    };
    out.push(sc("quota-live", edits_js(4).before(qrec(3600000))));
    out.push(sc("quota-expired", edits_js(4).before(qrec(-3600000))));
    out.push(sc("quota-live-switch-off", edits_js(4).before(qrec(3600000))).env("ANTIHALL_CODEX_QUOTA_DETECT", "0"));
    let joblog = |lab: &Lab, r: &Path, _: &Base| {
        lab.write(
            r,
            "home/.claude/plugins/data/codex-openai-codex/state/repoA/jobs/a.log",
            "You've hit your usage limit. try again at Oct 3rd, 2030 9:11 PM.\n",
            Some(60),
        );
    };
    out.push(sc("quota-job-log", edits_js(4).before(joblog)));
    out.push(sc("quota-job-log-switch-off", edits_js(4).before(joblog)).env("ANTIHALL_CODEX_QUOTA_DETECT", "0"));
    out.push(sc(
        "quota-state-corrupt",
        edits_js(4).before(|l, r, _| {
            l.write(r, "home/.anti-hall/codex-availability.json", "{nope", None);
        }),
    ));
    out.push(sc(
        "quota-state-lone-surrogate",
        edits_js(4).before(|l, r, _| {
            l.write(r, "home/.anti-hall/codex-availability.json", "{\"a\":\"\\ud83d\"}", None);
        }),
    ));
    // ---- Jev
    out.push(named(with_settings("{\"jev\":{\"enabled\":true}}".into(), edits_js(4)), "jev-enabled-shadow"));
    out.push(sc("jev-enabled-env", edits_js(4)).env("ANTIHALL_JEV", "1"));
    out.push(named(
        with_settings("{\"jev\":{\"enabled\":true},\"jevIntegrations\":{\"codexNudgeSubstantial\":\"off\"}}".into(), edits_js(4)),
        "jev-enabled-off-integration",
    ));
    out.push(named(with_settings("{\"jev\":{\"enabled\":true}}".into(), edits_js(4)), "jev-disabled-env-zero").env("ANTIHALL_JEV", "0"));
    out.push(named(
        with_settings("{\"jev\":{\"enabled\":true},\"jevIntegrations\":{\"codexNudgeSubstantial\":\"on\"}}".into(), edits_js(4)),
        "jev-enabled-on-integration",
    ));
    let jev_file = |id: &str, text: &'static str, m: Mk| {
        Sc::setup(id, move |lab, root| {
            lab.write(root, "home/.anti-hall/jev.json", text, None);
            m.build(lab, root)
        })
    };
    out.push(jev_file("jev-legacy-file-off-integration", "{\"enabled\":true,\"integrations\":{\"codexNudgeSubstantial\":\"off\"}}", edits_js(4)));
    out.push(jev_file("jev-legacy-file", "{\"enabled\":true}", edits_js(4)));
    out.push(named(with_settings("{\"jev\":{\"enabled\":true}}".into(), edits_js(1)), "jev-enabled-but-edits-below-min"));
    // ---- session id and state file
    let sids: Vec<(&str, J)> = vec![
        ("num", n(12345.0)),
        ("array", a(vec![s("a"), s("b")])),
        ("empty-array", a(vec![])),
        ("object", o(vec![("a", n(1.0))])),
        ("zero", n(0.0)),
        ("empty", s("")),
        ("true", J::Bool(true)),
        ("unicode", s("sess-\u{e9}\u{1F600}")),
        ("slashes", s("a/b\\c:d")),
        ("long", s(&"s".repeat(300))),
        ("dots", s("..")),
        ("null", J::Null),
        ("float", n(1.5e21)),
    ];
    let mut sid_sc: Vec<(String, Option<J>)> = sids.into_iter().map(|(id, v)| (id.to_string(), Some(v))).collect();
    sid_sc.insert(12, ("missing".into(), None));
    for (id, v) in sid_sc {
        out.push(sc(&format!("sid-{id}"), edits_js(4).payload(move |_, _| vec![("session_id", v.clone())])));
    }
    let st = |name: &'static str, txt: &'static str| {
        edits_js(4).before(move |l, r, _| {
            l.write(r, &format!("home/.anti-hall/codex-nudge-state-{name}.json"), txt, None);
        })
    };
    let four_names = ["f0.js", "f1.js", "f2.js", "f3.js"];
    let sig = sha1_hex(&four_names.join("|"));
    let st_json = |sig: String, nudges: &str| -> String { oj(&[("sig", js(&sig)), ("nudges", nudges.into())]) };
    let stj = move |text: String| {
        edits_js(4).before(move |l, r, _| {
            l.write(r, &format!("home/.anti-hall/codex-nudge-state-{SID}.json"), &text, None);
        })
    };
    out.push(sc("state-same-sig", stj(st_json(sig.clone(), "1"))));
    out.push(sc("state-other-sig", stj(st_json("abc".into(), "1"))));
    out.push(sc("state-cap-reached", stj(st_json("abc".into(), "2"))));
    out.push(sc("state-cap-over", stj(st_json("abc".into(), "7"))));
    out.push(sc("state-nudges-string", stj(st_json("abc".into(), "\"2\""))));
    out.push(sc("state-nudges-float", stj(st_json("abc".into(), "1.5"))));
    out.push(sc("state-nudges-neg", stj(st_json("abc".into(), "-5"))));
    out.push(sc("state-nudges-huge", st(SID, "{\"sig\":\"abc\",\"nudges\":1e999}")));
    out.push(sc("state-sig-number", stj(oj(&[("sig", "5".into()), ("nudges", "1".into())]))));
    out.push(sc("state-array", st(SID, "[1]")));
    out.push(sc("state-null", st(SID, "null")));
    out.push(sc("state-string", st(SID, "\"x\"")));
    out.push(sc("state-corrupt", st(SID, "{nope")));
    out.push(sc("state-empty", st(SID, "")));
    out.push(sc("state-whitespace", st(SID, "  \n ")));
    out.push(sc("state-lone-surrogate", st(SID, "{\"sig\":\"\\ud83d\"}")));
    out.push(sc("state-extra-keys-dropped", stj(oj(&[("sig", js("abc")), ("nudges", "1".into()), ("extra", "1".into())]))));
    out.push(sc(
        "state-is-dir",
        edits_js(4).before(|_, r, _| std::fs::create_dir_all(r.join(format!("home/.anti-hall/codex-nudge-state-{SID}.json"))).expect("dir")),
    ));
    out.push(sc(
        "state-dir-unwritable",
        edits_js(4).before(|_, r, _| std::fs::set_permissions(r.join("home/.anti-hall"), std::fs::Permissions::from_mode(0o555)).expect("chmod")),
    ));
    out.push(sc(
        "anti-hall-is-file",
        edits_js(4).before(|_, r, _| {
            std::fs::remove_dir_all(r.join("home/.anti-hall")).expect("remove");
            write_file(&r.join("home/.anti-hall"), b"f");
        }),
    ));
    // ---- pruning of other sessions' state
    let old = |lab: &Lab, r: &Path, name: &str, days: f64| {
        lab.write(r, &format!("home/.anti-hall/codex-nudge-state-{name}.json"), "{}", None);
        set_mtime(&r.join(format!("home/.anti-hall/codex-nudge-state-{name}.json")), lab.base as f64 - days * 86400.0);
    };
    let old_other = |lab: &Lab, r: &Path, rel: &str, days: f64| {
        lab.write(r, rel, "{}", None);
        set_mtime(&r.join(rel), lab.base as f64 - days * 86400.0);
    };
    out.push(sc(
        "prune-old-and-new",
        edits_js(4).before(move |l, r, _| {
            old(l, r, "old1", 10.0);
            old(l, r, "old2", 8.0);
            old(l, r, "fresh", 1.0);
            old(l, r, "edge", 6.9);
            old_other(l, r, "home/.anti-hall/other-file.json", 20.0);
            old_other(l, r, "home/.anti-hall/codex-nudge-state-x.txt", 20.0);
            old_other(l, r, "home/.anti-hall/codex-nudge-statex.json", 20.0);
        }),
    ));
    out.push(sc("prune-own-old-file-kept", edits_js(4).before(move |l, r, _| old(l, r, SID, 30.0))));
    let stamp = |text: Box<dyn Fn() -> String + Send + Sync>| {
        edits_js(4).before(move |l, r, _| {
            old(l, r, "old1", 10.0);
            l.write(r, "home/.anti-hall/.prune-stamp-codex-nudge-state.json", text(), None);
        })
    };
    out.push(sc("prune-stamp-recent", stamp(Box::new(|| format!("{{\"lastSweep\":{}}}", now_ms() - 1000)))));
    out.push(sc("prune-stamp-old", stamp(Box::new(|| format!("{{\"lastSweep\":{}}}", now_ms() - 7 * 3600 * 1000)))));
    out.push(sc("prune-stamp-future", stamp(Box::new(|| format!("{{\"lastSweep\":{}}}", now_ms() + 99999999)))));
    out.push(sc("prune-stamp-corrupt", stamp(Box::new(|| "{x".into()))));
    out.push(sc("prune-stamp-string", stamp(Box::new(|| format!("{{\"lastSweep\":\"{}\"}}", now_ms())))));
    out.push(sc(
        "prune-symlink-old",
        edits_js(4).before(move |l, r, _| {
            l.write(r, "target.json", "{}", None);
            set_mtime(&r.join("target.json"), l.base as f64 - 40.0 * 86400.0);
            std::os::unix::fs::symlink(r.join("target.json"), r.join("home/.anti-hall/codex-nudge-state-lnk.json")).expect("symlink");
        }),
    ));
    out.push(sc(
        "prune-dir-named-like-state",
        edits_js(4).before(|_, r, _| std::fs::create_dir_all(r.join("home/.anti-hall/codex-nudge-state-d.json")).expect("dir")),
    ));
    out.push(sc("not-nudging-no-prune", edits_js(1).before(move |l, r, _| old(l, r, "old1", 10.0))));
    let sig2 = sig.clone();
    out.push(sc(
        "same-sig-no-prune",
        edits_js(4).before(move |l, r, _| {
            old(l, r, "old1", 10.0);
            l.write(r, &format!("home/.anti-hall/codex-nudge-state-{SID}.json"), st_json(sig2.clone(), "1"), None);
        }),
    ));
    // ---- fuzz: random transcripts and settings, same seed for both sides ----
    let mut r = Rng::new(777);
    let exts = ["js", "ts", "py", "md", "json", "rs", "JS", "sh", "txt", "", "go", "sql", "jsx.bak"];
    let names: Vec<String> =
        ["a", "b", "c", "caf\u{e9}", "\u{1F600}", "sp ace", &"x".repeat(40), "f1", "f2", "f3", "dup", "dup"].iter().map(|x| x.to_string()).collect();
    let dirs = ["", "sub/", "sub/deep/", "../out/", "/elsewhere/", "REPO/", "REPO/sub/", "REPO/x/../y/", "SCRATCH/", "REPO/lnk3/"];
    let fpath = |r: &mut Rng| -> String {
        let d = *r.pick(&dirs);
        let prefix = if d.starts_with("REPO/") {
            d.replacen("REPO", "@REPO@", 1)
        } else if d.starts_with("SCRATCH/") {
            "@SCRATCH@/".to_string()
        } else {
            d.to_string()
        };
        let name = r.pick(&names).clone();
        let ext = if r.next() < 0.9 { format!(".{}", r.pick(&exts)) } else { String::new() };
        format!("{prefix}{name}{ext}")
    };
    let fuzz_tu = |r: &mut Rng| -> J {
        let x = r.next();
        if x < 0.7 {
            let names2: [J; 8] = [s("Edit"), s("Edit"), s("Write"), s("MultiEdit"), s("Read"), s("Bash"), n(5.0), s("")];
            let name = r.pick(&names2).clone();
            let input = if r.next() < 0.9 {
                let fp = if r.next() < 0.9 { s(&fpath(r)) } else { r.pick(&[n(5.0), J::Null, a(vec![s("x")]), s("")]).clone() };
                o(vec![("file_path", fp)])
            } else {
                r.pick(&[J::Null, s("x"), a(vec![n(1.0)]), o(vec![])]).clone()
            };
            return o(vec![("type", s("tool_use")), ("name", name), ("input", input)]);
        }
        if x < 0.85 {
            let name = *r.pick(&["Agent", "Task"]);
            let key = *r.pick(&["subagent_type", "agentType", "agent_type"]);
            let vals: [J; 9] =
                [s("codex:codex-rescue"), s("codex"), s("Codex:x"), s("codexy"), s("general-purpose"), s(""), n(5.0), J::Null, s("codex-rescue")];
            let val = r.pick(&vals).clone();
            return o(vec![("type", s("tool_use")), ("name", s(name)), ("input", o(vec![(key, val)]))]);
        }
        let skill: [J; 4] = [s("codex:rescue"), s("review"), n(5.0), s("")];
        let sk = r.pick(&skill).clone();
        let cmds: [Option<J>; 4] = [Some(s("/codex")), Some(s("")), Some(n(7.0)), None];
        let cm = r.pick(&cmds).clone();
        let mut input = vec![("skill", sk)];
        if let Some(c) = cm {
            input.push(("command", c));
        }
        o(vec![("type", s("tool_use")), ("name", s("Skill")), ("input", o(input))])
    };
    let wrap = |r: &mut Rng, tus: Vec<J>| -> J {
        match r.below(8) {
            0 => o(vec![("type", s("assistant")), ("message", o(vec![("content", a(tus))]))]),
            1 => o(vec![("content", a(tus))]),
            2 => o(vec![("parts", a(tus))]),
            3 => o(vec![("tool_uses", a(tus))]),
            4 => o(vec![("messages", a(tus.into_iter().map(|t| o(vec![("content", a(vec![t]))])).collect()))]),
            5 => tus[0].clone(),
            6 => o(vec![("message", o(vec![("messages", a(vec![o(vec![("parts", a(tus))])]))]))]),
            _ => o(vec![("type", s("x")), ("message", s("str"))]),
        }
    };
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(120);
    for i in 0..nfuzz {
        let env_min = if r.next() < 0.3 { Some(r.pick(&["1", "2", "5", "0", "x", "2.5"]).to_string()) } else { None };
        let lines = 1 + r.below(8);
        let abstract_lines: Vec<String> = (0..lines)
            .map(|_| {
                let k = 1 + r.below(3);
                let tus: Vec<J> = (0..k).map(|_| fuzz_tu(&mut r)).collect();
                wrap(&mut r, tus).text()
            })
            .collect();
        let mut m = mk(move |_, b| {
            abstract_lines
                .iter()
                .map(|l| l.split("@REPO@").collect::<Vec<_>>().join(&ps(&b.repo)).split("@SCRATCH@").collect::<Vec<_>>().join(&ps(&b.scratch)))
                .collect()
        })
        .before(|_, _, b| {
            let _ = std::os::unix::fs::symlink("/tmp", b.repo.join("lnk3"));
        });
        if let Some(v) = env_min {
            m = m.env("ANTIHALL_CODEX_NUDGE_MIN", Some(&v));
        }
        out.push(sc(&format!("fuzz-{i}"), m));
    }
    out
}
