//! Corpus for precompact-snapshot (PreCompact): payload shapes, repositories, transcripts, numbering, handovers.

use super::b78::*;
use super::jsjson::{J, a, n, o, s};
use super::lab::Lab;
use super::support::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const SID: &str = "sess-1";

fn day() -> String {
    local_day(0.0)
}
fn ps(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
fn enc(p: &Path) -> String {
    enc_dashes(&ps(p))
}

/// `Object.assign({type: 'user', timestamp: ..., message: {role: 'user', content: t}}, extra)`
fn user_with(content: J, extra: Vec<(&str, Option<J>)>) -> String {
    let mut v = o(vec![("type", s("user")), ("timestamp", s("2026-10-07T10:00:00.000Z")), ("message", o(vec![("role", s("user")), ("content", content)]))]);
    for (k, x) in extra {
        match x {
            Some(x) => v.set(k, x),
            None => v.remove(k),
        }
    }
    v.text()
}
fn user(t: &str) -> String {
    user_with(s(t), vec![])
}
fn user_x(t: &str, extra: Vec<(&str, Option<J>)>) -> String {
    user_with(s(t), extra)
}
fn asst(items: Vec<J>) -> String {
    o(vec![("type", s("assistant")), ("message", o(vec![("content", a(items))]))]).text()
}
fn tool_use(name: &str, input: J, id: Option<J>) -> J {
    let mut v = vec![("type", s("tool_use")), ("name", s(name)), ("input", input)];
    if let Some(i) = id {
        v.push(("id", i));
    }
    o(v)
}
fn tool_res(id: Option<J>, content: J) -> String {
    let mut inner = vec![("type", s("tool_result"))];
    if let Some(i) = id {
        inner.push(("tool_use_id", i));
    }
    inner.push(("content", content));
    o(vec![("type", s("user")), ("message", o(vec![("content", a(vec![o(inner)]))]))]).text()
}
fn tu(name: &str, input: J) -> J {
    tool_use(name, input, None)
}
fn todo(items: Vec<J>) -> J {
    o(vec![("todos", a(items))])
}
fn td(content: &str, status: &str) -> J {
    o(vec![("content", s(content)), ("status", s(status))])
}

fn hdir(repo: &Path, sid: &str, date: Option<&str>) -> PathBuf {
    repo.join(".anti-hall/handovers").join(date.map_or_else(day, str::to_string)).join(if sid.is_empty() { SID } else { sid })
}
fn hand(lab: &Lab, repo: &Path, sid: &str, name: &str, content: Option<&str>, age: Option<i64>, date: Option<&str>) -> PathBuf {
    let f = hdir(repo, sid, date).join(name);
    write_file(&f, content.unwrap_or("# h\n").as_bytes());
    if let Some(a) = age {
        set_mtime(&f, (lab.base - a) as f64);
    }
    f
}

enum Lines {
    None,
    Text(String),
    List(Vec<String>),
}

type Before = Box<dyn Fn(&Lab, &Path, &Path) + Send + Sync>;
type PayloadFn = Box<dyn Fn(&Path, &Path, &Path) -> Vec<(&'static str, Option<J>)> + Send + Sync>;

struct Mk {
    no_repo: bool,
    lines: Box<dyn Fn() -> Lines + Send + Sync>,
    no_nl: bool,
    before: Option<Before>,
    payload: Option<PayloadFn>,
    env: Env,
}

fn mk() -> Mk {
    Mk { no_repo: false, lines: Box::new(|| Lines::None), no_nl: false, before: None, payload: None, env: Vec::new() }
}

impl Mk {
    fn no_repo(mut self) -> Mk {
        self.no_repo = true;
        self
    }
    fn lines(mut self, l: Vec<String>) -> Mk {
        self.lines = Box::new(move || Lines::List(l.clone()));
        self
    }
    fn text(mut self, t: &str) -> Mk {
        let t = t.to_string();
        self.lines = Box::new(move || Lines::Text(t.clone()));
        self
    }
    fn lines_fn(mut self, f: impl Fn() -> Vec<String> + Send + Sync + 'static) -> Mk {
        self.lines = Box::new(move || Lines::List(f()));
        self
    }
    fn no_nl(mut self) -> Mk {
        self.no_nl = true;
        self
    }
    fn before(mut self, f: impl Fn(&Lab, &Path, &Path) + Send + Sync + 'static) -> Mk {
        self.before = Some(Box::new(f));
        self
    }
    fn payload(mut self, f: impl Fn(&Path, &Path, &Path) -> Vec<(&'static str, Option<J>)> + Send + Sync + 'static) -> Mk {
        self.payload = Some(Box::new(f));
        self
    }
    fn set(self, k: &'static str, v: Option<J>) -> Mk {
        self.payload(move |_, _, _| vec![(k, v.clone())])
    }
    fn build(&self, lab: &Lab, root: &Path) -> Built {
        let repo = if self.no_repo {
            std::fs::create_dir_all(root.join("plain")).expect("plain dir");
            root.join("plain")
        } else {
            lab.repo(root, "repo", &[])
        };
        let tdir = root.join("home/.claude/projects").join(enc(&repo));
        std::fs::create_dir_all(&tdir).expect("transcript dir");
        let tp = tdir.join(format!("{SID}.jsonl"));
        match (self.lines)() {
            Lines::None => {}
            Lines::Text(t) => write_file(&tp, t.as_bytes()),
            Lines::List(l) => write_file(&tp, format!("{}{}", l.join("\n"), if self.no_nl { "" } else { "\n" }).as_bytes()),
        }
        if let Some(b) = &self.before {
            b(lab, root, &repo);
        }
        let mut p = o(vec![
            ("hook_event_name", s("PreCompact")),
            ("session_id", s(SID)),
            ("cwd", s(&ps(&repo))),
            ("transcript_path", s(&ps(&tp))),
            ("trigger", s("auto")),
        ]);
        if let Some(pf) = &self.payload {
            for (k, v) in pf(root, &repo, &tp) {
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

fn raw(id: &str, text: &'static str) -> Sc {
    Sc::setup(id, move |_, _| Built { payload: Some(Payload::Raw(text.into())), ..Built::default() })
}

fn skip_sc(id: &str, text: &'static str) -> Sc {
    Sc::setup(id, move |lab, root| {
        lab.write(root, "home/.anti-hall/skip.json", text, None);
        mk().build(lab, root)
    })
}
fn settings_sc(id: &str, text: &'static str) -> Sc {
    Sc::setup(id, move |lab, root| {
        lab.write(root, "home/.anti-hall/settings.json", text, None);
        mk().build(lab, root)
    })
}

/// A payload built for the home directory of a stand-alone repository (no transcript path).
fn bare_payload(cwd: &Path) -> Built {
    Built {
        payload: Some(Payload::Raw(o(vec![("hook_event_name", s("PreCompact")), ("session_id", s(SID)), ("cwd", s(&ps(cwd))), ("trigger", s("auto"))]).text())),
        ..Built::default()
    }
}

fn msgs(count: usize) -> Vec<String> {
    (0..count).map(|i| user(&format!("message number {i}"))).collect()
}

pub(crate) fn scenarios() -> Vec<Sc> {
    let mut out: Vec<Sc> = Vec::new();
    // ---- basics
    out.push(sc("basic-no-transcript", mk()));
    out.push(sc("basic-trigger-manual", mk().set("trigger", Some(s("manual")))));
    let triggers: Vec<(&str, Option<J>)> = vec![
        ("\"auto\"", Some(s("auto"))),
        ("\"manual\"", Some(s("manual"))),
        ("\"x\"", Some(s("x"))),
        ("\"\"", Some(s(""))),
        ("null", Some(J::Null)),
        ("5", Some(n(5.0))),
        ("undefined", None),
    ];
    for (id, v) in triggers {
        out.push(sc(&format!("trigger-{id}"), mk().set("trigger", v)));
    }
    let cis: Vec<(String, J)> = vec![
        ("\"keep it\"".into(), s("keep it")),
        ("\"  padded  \"".into(), s("  padded  ")),
        ("\"\"".into(), s("")),
        ("\"   \"".into(), s("   ")),
        ("5".into(), n(5.0)),
        ("null".into(), J::Null),
        ("\"multi\\nline  text\"".into(), s("multi\nline  text")),
        ("\"caf\u{e9} \u{1F600}\"".into(), s("caf\u{e9} \u{1F600}")),
    ];
    for (id, v) in cis {
        out.push(sc(&format!("custom-{id}"), mk().set("custom_instructions", Some(v))));
    }
    let sids: Vec<(&str, Option<J>)> = vec![
        ("num", Some(n(7.0))),
        ("zero", Some(n(0.0))),
        ("empty", Some(s(""))),
        ("array", Some(a(vec![s("a"), s("b")]))),
        ("empty-array", Some(a(vec![]))),
        ("object", Some(o(vec![("a", n(1.0))]))),
        ("slash", Some(s("a/b..c"))),
        ("unicode", Some(s("sess-\u{e9}\u{1F600}"))),
        ("spaces", Some(s("a b c"))),
        ("null", Some(J::Null)),
        ("missing", None),
        ("true", Some(J::Bool(true))),
        ("long", Some(s(&"s".repeat(300)))),
        ("dash-underscore", Some(s("a_b-c.d"))),
    ];
    for (id, v) in sids {
        out.push(sc(&format!("sid-{id}"), mk().set("session_id", v)));
    }
    let vals: Vec<(&str, J)> = vec![("null", J::Null), ("zero", n(0.0)), ("empty", s("")), ("false", J::Bool(false)), ("str", s("x")), ("obj", o(vec![]))];
    for (id, v) in vals {
        out.push(sc(&format!("agent_id-{id}"), mk().set("agent_id", Some(v.clone()))));
        out.push(sc(&format!("agent_type-{id}"), mk().set("agent_type", Some(v))));
    }
    out.push(skip_sc("skip-own", "{\"precompact-snapshot\":4102444800000}"));
    out.push(skip_sc("skip-all", "{\"all\":4102444800000}"));
    out.push(skip_sc("skip-expired", "{\"precompact-snapshot\":1000}"));
    out.push(settings_sc("switch-off-settings", "{\"maintenance\":{\"precompactSnapshot\":false}}"));
    out.push(settings_sc("switch-off-settings-str", "{\"maintenance\":{\"precompactSnapshot\":\"off\"}}"));
    out.push(sc("switch-off-plugin-option", mk()).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_PRECOMPACT_SNAPSHOT", "false"));
    out.push(sc("switch-plugin-option-default", mk()).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_PRECOMPACT_SNAPSHOT", "true"));
    out.push(sc("judge-child-env-ignored", mk()).env("ANTIHALL_JUDGE_CHILD", "1"));
    // ---- payload shapes
    out.push(sc("no-cwd", mk().set("cwd", None)));
    out.push(sc("cwd-empty", mk().set("cwd", Some(s("")))));
    out.push(sc("cwd-num", mk().set("cwd", Some(n(5.0)))));
    out.push(sc("cwd-relative", mk().set("cwd", Some(s("rel/path")))));
    out.push(sc("cwd-missing-dir", mk().payload(|r, _, _| vec![("cwd", Some(s(&ps(&r.join("nope")))))])));
    out.push(sc(
        "cwd-dotdot",
        mk().payload(|_, repo, _| vec![("cwd", Some(s(&path_join(&[&ps(repo), "x", ".."]))))])
            .before(|_, _, repo| std::fs::create_dir_all(repo.join("x")).expect("dir")),
    ));
    out.push(raw("payload-array", "[1]"));
    out.push(raw("payload-null", "null"));
    out.push(raw("payload-malformed", "{\"a\":"));
    out.push(raw("payload-empty", ""));
    out.push(sc("transcript-missing", mk().set("transcript_path", None)));
    out.push(sc("transcript-relative", mk().set("transcript_path", Some(s("rel/t.jsonl")))));
    out.push(sc("transcript-num", mk().set("transcript_path", Some(n(5.0)))));
    out.push(sc("transcript-nofile", mk().payload(|_, _, tp| vec![("transcript_path", Some(s(&format!("{}.none", ps(tp)))))])));
    out.push(sc("transcript-dir", mk().payload(|_, _, tp| vec![("transcript_path", Some(s(&ps(tp.parent().expect("transcript dir")))))])));
    out.push(sc("transcript-empty-file", mk().text("")));
    // ---- repository shapes
    out.push(sc("repo-clean", mk()));
    out.push(sc(
        "repo-dirty-mix",
        mk().before(|l, _, repo| {
            l.write(repo, "a.txt", "changed\n", None);
            l.write(repo, "new.txt", "n\n", None);
            l.write(repo, "staged.txt", "s\n", None);
            l.git(repo, &["add", "staged.txt"]);
        }),
    ));
    out.push(sc(
        "repo-dirty-70",
        mk().before(|l, _, repo| {
            for i in 0..70 {
                l.write(repo, &format!("d/f{i:02}.txt"), "x", None);
            }
        }),
    ));
    out.push(sc(
        "repo-dirty-exact-50",
        mk().before(|l, _, repo| {
            for i in 0..50 {
                l.write(repo, &format!("f{i:02}.txt"), "x", None);
            }
        }),
    ));
    out.push(sc(
        "repo-dirty-51",
        mk().before(|l, _, repo| {
            for i in 0..51 {
                l.write(repo, &format!("f{i:02}.txt"), "x", None);
            }
        }),
    ));
    out.push(sc(
        "repo-unicode-names",
        mk().before(|l, _, repo| {
            for f in ["caf\u{e9}.txt", "sp ace.txt", "tab\tname.txt", "\u{1F600}.txt"] {
                l.write(repo, f, "x", None);
            }
        }),
    ));
    out.push(sc(
        "repo-renamed-deleted",
        mk().before(|l, _, repo| {
            l.git(repo, &["mv", "a.txt", "b.txt"]);
            l.write(repo, "gone.txt", "g", None);
            l.git(repo, &["add", "gone.txt"]);
            l.git(repo, &["commit", "-q", "-m", "g"]);
            std::fs::remove_file(repo.join("gone.txt")).expect("remove");
        }),
    ));
    out.push(sc(
        "repo-detached",
        mk().before(|l, _, repo| {
            l.git(repo, &["checkout", "-q", "--detach"]);
        }),
    ));
    out.push(Sc::setup("repo-no-commits", |lab, root| {
        let d = root.join("repo");
        std::fs::create_dir_all(&d).expect("repo dir");
        lab.git(&d, &["init", "-q", "-b", "main"]);
        lab.write(&d, "x.txt", "x", None);
        std::fs::create_dir_all(root.join("home/.claude/projects").join(enc(&d))).expect("transcript dir");
        bare_payload(&d)
    }));
    out.push(sc(
        "repo-upstream-ahead",
        mk().before(|l, r, repo| {
            let bare = r.join("bare.git");
            let out = std::process::Command::new("git").args(["init", "-q", "--bare", &ps(&bare)]).output().expect("git");
            assert!(out.status.success());
            l.git(repo, &["remote", "add", "origin", &ps(&bare)]);
            l.git(repo, &["push", "-q", "-u", "origin", "main"]);
            l.write(repo, "more.txt", "m", None);
            l.git(repo, &["add", "-A"]);
            l.git(repo, &["commit", "-q", "-m", "ahead"]);
        }),
    ));
    out.push(sc(
        "repo-long-subject",
        mk().before(|l, _, repo| {
            l.write(repo, "z.txt", "z", None);
            l.git(repo, &["add", "-A"]);
            l.git(repo, &["commit", "-q", "-m", &format!("subject with  double  spaces and \u{e9}\u{1F600} unicode {}", "x".repeat(300))]);
        }),
    ));
    out.push(sc(
        "cwd-subdir",
        mk().before(|_, _, repo| std::fs::create_dir_all(repo.join("sub")).expect("dir")).payload(|_, repo, _| vec![("cwd", Some(s(&ps(&repo.join("sub")))))]),
    ));
    out.push(sc("cwd-not-git", mk().no_repo()));
    out.push(sc(
        "cwd-in-handovers-dir",
        mk().before(|_, _, repo| std::fs::create_dir_all(repo.join(".anti-hall/handovers")).expect("dir"))
            .payload(|_, repo, _| vec![("cwd", Some(s(&ps(&repo.join(".anti-hall/handovers")))))]),
    ));
    out.push(sc(
        "cwd-symlink",
        mk().before(|_, r, repo| std::os::unix::fs::symlink(repo, r.join("lnk")).expect("symlink"))
            .payload(|r, _, _| vec![("cwd", Some(s(&ps(&r.join("lnk")))))]),
    ));
    let home_repo = |sub: bool| {
        move |lab: &Lab, root: &Path| {
            let home = root.join("home");
            lab.git(&home, &["init", "-q", "-b", "main"]);
            lab.write(&home, "dot.txt", "d", None);
            lab.git(&home, &["add", "dot.txt"]);
            lab.git(&home, &["commit", "-q", "-m", "dots"]);
            std::fs::create_dir_all(home.join("proj")).expect("dir");
            bare_payload(&if sub { home.join("proj") } else { home })
        }
    };
    out.push(Sc::setup("cwd-is-home-repo", home_repo(false)));
    out.push(Sc::setup("cwd-in-home-repo-subdir", home_repo(true)));
    out.push(sc(
        "cwd-linked-worktree",
        mk().before(|l, r, repo| {
            l.git(repo, &["worktree", "add", "-q", &ps(&r.join("wt")), "-b", "feat"]);
        })
        .payload(|r, _, _| vec![("cwd", Some(s(&ps(&r.join("wt")))))]),
    ));
    out.push(Sc::setup("cwd-submodule", |lab, root| {
        let repo = lab.repo_no_files(root, "repo");
        let sub = lab.repo(root, "subsrc", &[("s.txt", "s")]);
        lab.git(&repo, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &ps(&sub), "vendor/sub"]);
        lab.git(&repo, &["commit", "-q", "-m", "sub"]);
        bare_payload(&repo.join("vendor/sub"))
    }));
    out.push(Sc::setup("cwd-nested-repo", |lab, root| {
        lab.repo_no_files(root, "repo");
        let inner = lab.repo(root, "repo/inner", &[("i.txt", "i")]);
        bare_payload(&inner)
    }));
    out.push(Sc::setup("cwd-dir-named-git-file", |lab, root| {
        let d = root.join("weird");
        std::fs::create_dir_all(&d).expect("dir");
        lab.write(&d, ".git", "gitdir: /nonexistent\n", None);
        bare_payload(&d)
    }));
    // ---- numbering and existing files
    let h = |lab: &Lab, repo: &Path, sid: &str, name: &str, c: &str| {
        hand(lab, repo, sid, name, Some(c), None, None);
    };
    out.push(sc(
        "num-existing-1-2",
        mk().before(move |l, _, r| {
            h(l, r, SID, "PRECOMPACT-1.md", "a");
            h(l, r, SID, "PRECOMPACT-2.md", "b");
        }),
    ));
    out.push(sc(
        "num-gap",
        mk().before(move |l, _, r| {
            h(l, r, SID, "PRECOMPACT-5.md", "a");
            h(l, r, SID, "PRECOMPACT-2.md", "b");
        }),
    ));
    out.push(sc(
        "num-nonmatching",
        mk().before(move |l, _, r| {
            for nme in ["PRECOMPACT-.md", "PRECOMPACT-x.md", "PRECOMPACT-1.txt", "precompact-9.md", "PRECOMPACT-1.md.bak", "HANDOVER.md"] {
                h(l, r, SID, nme, "a");
            }
        }),
    ));
    out.push(sc("num-leading-zero", mk().before(move |l, _, r| h(l, r, SID, "PRECOMPACT-007.md", "a"))));
    out.push(sc("num-huge", mk().before(move |l, _, r| h(l, r, SID, "PRECOMPACT-99999999999999999999.md", "a"))));
    out.push(sc("num-other-session", mk().before(move |l, _, r| h(l, r, "other", "PRECOMPACT-9.md", "a"))));
    out.push(sc(
        "num-other-date",
        mk().before(|l, _, r| {
            hand(l, r, SID, "PRECOMPACT-4.md", Some("a"), None, Some("2020-01-01"));
        }),
    ));
    out.push(sc("num-dir-named-like-file", mk().before(|_, _, r| std::fs::create_dir_all(hdir(r, SID, None).join("PRECOMPACT-3.md")).expect("dir"))));
    out.push(sc(
        "dir-is-file",
        mk().before(|l, _, r| {
            std::fs::create_dir_all(r.join(".anti-hall/handovers").join(day())).expect("dir");
            l.write(r, &format!(".anti-hall/handovers/{}/{SID}", day()), "file", None);
        }),
    ));
    out.push(sc(
        "handovers-is-file",
        mk().before(|l, _, r| {
            l.write(r, ".anti-hall/handovers", "file", None);
        }),
    ));
    out.push(sc(
        "repo-unwritable",
        mk().before(|_, _, r| {
            std::fs::create_dir_all(r.join(".anti-hall")).expect("dir");
            std::fs::set_permissions(r.join(".anti-hall"), std::fs::Permissions::from_mode(0o555)).expect("chmod");
        }),
    ));
    // ---- newest handover
    let ha = |lab: &Lab, repo: &Path, sid: &str, name: &str, c: &str, age: i64| {
        hand(lab, repo, sid, name, Some(c), Some(age), None);
    };
    out.push(sc("handover-same-session", mk().before(move |l, _, r| ha(l, r, SID, "HANDOVER.md", "# a", 3600))));
    out.push(sc(
        "handover-other-newer",
        mk().before(move |l, _, r| {
            ha(l, r, SID, "HANDOVER.md", "# a", 3600);
            ha(l, r, "other", "HANDOVER.md", "# b", 10);
        }),
    ));
    out.push(sc(
        "handover-only-other",
        mk().before(move |l, _, r| {
            ha(l, r, "other", "HANDOVER.md", "# b", 10);
            ha(l, r, "third", "HANDOVER-2.md", "# c", 5);
        }),
    ));
    out.push(sc(
        "handover-tie",
        mk().before(move |l, _, r| {
            ha(l, r, "aaa", "HANDOVER.md", "# a", 100);
            ha(l, r, "bbb", "HANDOVER.md", "# b", 100);
        }),
    ));
    out.push(sc(
        "handover-seq-names",
        mk().before(move |l, _, r| {
            for nme in ["HANDOVER.md", "HANDOVER-2.md", "HANDOVER-10.md", "HANDOVER-x.md", "HANDOVER-.md", "HANDOVER2.md"] {
                ha(l, r, SID, nme, "# a", 100);
            }
        }),
    ));
    out.push(sc("handover-huge-seq", mk().before(move |l, _, r| ha(l, r, SID, "HANDOVER-99999999999999999999.md", "# a", 100))));
    out.push(sc(
        "handover-symlink-dir-ignored",
        mk().before(move |l, _, r| {
            ha(l, r, "real", "HANDOVER.md", "# a", 100);
            std::os::unix::fs::symlink(hdir(r, "real", None), r.join(".anti-hall/handovers").join(day()).join("lnk")).expect("symlink");
        }),
    ));
    out.push(sc(
        "handover-symlink-file",
        mk().before(|l, r, repo| {
            l.write(r, "elsewhere.md", "# a", Some(50));
            std::fs::create_dir_all(hdir(repo, SID, None)).expect("dir");
            std::os::unix::fs::symlink(r.join("elsewhere.md"), hdir(repo, SID, None).join("HANDOVER.md")).expect("symlink");
        }),
    ));
    out.push(sc("handover-dir-named-like-file", mk().before(|_, _, r| std::fs::create_dir_all(hdir(r, SID, None).join("HANDOVER.md")).expect("dir"))));
    out.push(sc(
        "handover-old-dates",
        mk().before(|l, _, r| {
            hand(l, r, SID, "HANDOVER.md", Some("# a"), Some(100), Some("2020-01-01"));
            hand(l, r, SID, "HANDOVER.md", Some("# b"), Some(90), Some("2021-02-02"));
        }),
    ));
    out.push(sc(
        "handover-fractional-mtime",
        mk().before(|l, _, r| {
            let f = hand(l, r, SID, "HANDOVER.md", Some("# a"), None, None);
            set_mtime(&f, 1790000000.987654);
        }),
    ));
    // ---- user messages
    for count in [0usize, 1, 9, 10, 11, 25] {
        out.push(sc(&format!("msgs-{count}"), mk().lines(msgs(count))));
    }
    out.push(sc("msgs-trim-and-empty", mk().lines(vec![user("  padded  "), user(""), user("   \n "), user("real")])));
    out.push(sc(
        "msgs-harness-tags",
        mk().lines(
            [
                "<task-notification>x",
                "<local-command-stdout>x",
                "<local-command-caveat>x",
                "<system-reminder>x",
                "<bash-stdout>x",
                "<bash-stderr>x",
                "<command-name>x",
                "<command-message>x",
                "<command-args>x",
                "<command-other>x",
                "<bash-std>x",
                "real message",
                " <system-reminder> leading space trimmed",
            ]
            .iter()
            .map(|t| user(t))
            .collect(),
        ),
    ));
    out.push(sc(
        "msgs-flags",
        mk().lines(vec![
            user_x("a", vec![("isMeta", Some(J::Bool(true)))]),
            user_x("b", vec![("isSidechain", Some(J::Bool(true)))]),
            user_x("c", vec![("isCompactSummary", Some(J::Bool(true)))]),
            user_x("d", vec![("isMeta", Some(J::Bool(false)))]),
            user_x("e", vec![("isMeta", Some(n(0.0)))]),
            user_x("f", vec![("isMeta", Some(s("yes")))]),
            user_x("g", vec![("isMeta", Some(J::Null))]),
        ]),
    ));
    let um = |content: J| o(vec![("type", s("user")), ("message", o(vec![("content", content)]))]).text();
    let txt = |t: J| o(vec![("type", s("text")), ("text", t)]);
    out.push(sc(
        "msgs-array-content",
        mk().lines(vec![
            um(a(vec![txt(s("one")), txt(s("two")), o(vec![("type", s("image")), ("source", s("x"))]), txt(n(5.0))])),
            um(a(vec![o(vec![("type", s("tool_result")), ("content", s("out"))]), txt(s("hidden by tool_result"))])),
            um(a(vec![])),
            um(a(vec![J::Null, txt(s("ok"))])),
        ]),
    ));
    out.push(sc(
        "msgs-weird-message",
        mk().lines(vec![
            o(vec![("type", s("user")), ("message", s("str"))]).text(),
            o(vec![("type", s("user")), ("message", J::Null)]).text(),
            um(n(5.0)),
            o(vec![("type", s("user")), ("message", a(vec![n(1.0)]))]).text(),
            o(vec![("type", s("user"))]).text(),
            o(vec![("type", s("assistant")), ("message", o(vec![("content", s("user"))]))]).text(),
        ]),
    ));
    let ev = |payload: J| o(vec![("type", s("event_msg")), ("payload", payload)]);
    out.push(sc(
        "msgs-codex-shape",
        mk().lines(vec![
            o(vec![("type", s("event_msg")), ("timestamp", s("t1")), ("payload", o(vec![("type", s("user_message")), ("message", s("codex says hi"))]))])
                .text(),
            o(vec![
                ("type", s("response_item")),
                (
                    "payload",
                    o(vec![
                        ("type", s("message")),
                        ("role", s("user")),
                        ("content", a(vec![o(vec![("type", s("input_text")), ("text", s("AGENTS.md injection"))])])),
                    ]),
                ),
            ])
            .text(),
            ev(o(vec![("type", s("user_message")), ("message", n(5.0))])).text(),
            ev(o(vec![("type", s("agent_message")), ("message", s("x"))])).text(),
        ]),
    ));
    out.push(sc(
        "msgs-timestamps",
        mk().lines(vec![
            user_x("a", vec![("timestamp", Some(n(5.0)))]),
            user_x("b", vec![("timestamp", Some(J::Null))]),
            o(vec![("type", s("user")), ("message", o(vec![("content", s("c"))]))]).text(),
            user_x("d", vec![("timestamp", Some(s("")))]),
        ]),
    ));
    out.push(sc("msgs-long-4000", mk().lines(vec![user(&"x".repeat(4000)), user(&"y".repeat(4001)), user(&"z".repeat(9000))])));
    out.push(sc(
        "msgs-long-emoji-boundary",
        mk().lines(vec![
            user(&format!("{}\u{1F600}tail", "a".repeat(3999))),
            user(&format!("{}\u{1F600}\u{1F600}x", "b".repeat(3998))),
            user(&"\u{1F600}".repeat(3000)),
        ]),
    ));
    out.push(sc(
        "msgs-unicode",
        mk().lines(vec![
            user("caf\u{e9} \u{1F600} \u{4e2d}\u{6587}"),
            user("line1\nline2\r\nline3"),
            user("````text fence inside ````"),
            user("| pipes | here |"),
        ]),
    ));
    out.push(sc(
        "msgs-user-in-string-only",
        mk().lines(vec![o(vec![("type", s("assistant")), ("message", o(vec![("content", s("the word \"user\" appears"))]))]).text()]),
    ));
    out.push(sc(
        "msgs-invalid-lines",
        mk().lines(vec![
            "not json \"user\"".into(),
            "{\"type\":\"user\",\"message\":{\"content\":\"ok\"}}".into(),
            "{\"type\":\"user\"".into(),
            String::new(),
            "   ".into(),
            user("after"),
        ]),
    ));
    out.push(sc("msgs-lone-surrogate", mk().lines(vec![user("fine"), "{\"type\":\"user\",\"message\":{\"content\":\"bad \\ud83d here\"}}".into()])));
    out.push(sc("msgs-number-out-of-range", mk().lines(vec![user("fine"), "{\"type\":\"user\",\"n\":1e999,\"message\":{\"content\":\"x\"}}".into()])));
    out.push(sc(
        "msgs-deep",
        mk().lines(vec![user("fine"), format!("{{\"type\":\"user\",\"message\":{{\"content\":\"x\"}},\"d\":{}{}}}", "[".repeat(300), "]".repeat(300))]),
    ));
    out.push(sc("msgs-crlf", mk().lines(msgs(3)).no_nl()));
    out.push(sc("transcript-big-tail", mk().lines_fn(|| (0..1000).map(|i| user(&format!("{}{i}", "p".repeat(2000)))).collect())));
    out.push(sc("transcript-big-multibyte-cut", mk().lines_fn(|| vec![user(&"\u{e9}".repeat(1000000)), user(&"\u{e9}".repeat(1000000)), user("last")])));
    out.push(sc(
        "transcript-exact-cap",
        mk().lines_fn(|| {
            let one = user("first");
            let pad = 1572864usize.saturating_sub(one.len() + 1);
            vec![format!("{one}{}", " ".repeat(pad))]
        }),
    ));
    // ---- task list
    let sub_item = |k: &str, v: J| o(vec![(k, v)]);
    out.push(sc(
        "tasks-todowrite",
        mk().lines(vec![asst(vec![tu(
            "TodoWrite",
            todo(vec![
                td("first", "completed"),
                td("second | pipe", "in_progress"),
                o(vec![("subject", s("third")), ("status", s("pending"))]),
                o(vec![("content", s("")), ("subject", s("sub-fallback"))]),
                J::Null,
                s("str"),
                sub_item("content", n(5.0)),
                o(vec![("content", s(&"x".repeat(300))), ("status", n(7.0))]),
            ]),
        )])]),
    ));
    out.push(sc("tasks-todowrite-empty", mk().lines(vec![asst(vec![tu("TodoWrite", todo(vec![]))])])));
    out.push(sc(
        "tasks-todowrite-replaced",
        mk().lines(vec![asst(vec![tu("TodoWrite", todo(vec![td("a", "pending")]))]), asst(vec![tu("TodoWrite", todo(vec![td("b", "pending")]))])]),
    ));
    out.push(sc("tasks-todowrite-not-array", mk().lines(vec![asst(vec![tu("TodoWrite", o(vec![("todos", s("x"))]))])])));
    let created = |id: &str, text: &str| tool_res(Some(s(id)), s(text));
    out.push(sc(
        "tasks-create-update",
        mk().lines(vec![
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("Do A"))]), Some(s("tu1")))]),
            created("tu1", "Task #1 created successfully: Do A"),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("Do B"))]), Some(s("tu2")))]),
            tool_res(Some(s("tu2")), a(vec![o(vec![("type", s("text")), ("text", s("Task #2 created successfully: Do B"))])])),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", s("1")), ("status", s("in_progress"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", n(2.0)), ("status", s("deleted"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", s("9")), ("status", s("pending")), ("subject", s("ghost"))]))]),
        ]),
    ));
    out.push(sc(
        "tasks-update-before-create",
        mk().lines(vec![
            asst(vec![tu("TaskUpdate", o(vec![("taskId", s("1")), ("status", s("completed"))]))]),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("Late"))]), Some(s("tu1")))]),
            created("tu1", "Task #1 created successfully: Late"),
        ]),
    ));
    out.push(sc(
        "tasks-ids-variants",
        mk().lines(vec![
            asst(vec![tu("TaskUpdate", o(vec![("id", s("abc")), ("status", s("x"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", J::Null), ("id", n(4.0)), ("status", s("y"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", n(0.0)), ("status", s("z"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", s("")), ("status", s("w"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("status", s("nothing"))]))]),
            asst(vec![tu("TaskUpdate", o(vec![("taskId", a(vec![s("a"), s("b")])), ("subject", n(5.0)), ("status", o(vec![("a", n(1.0))]))]))]),
        ]),
    ));
    out.push(sc(
        "tasks-create-id-types",
        mk().lines(vec![
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("n"))]), Some(n(5.0)))]),
            tool_res(Some(n(5.0)), s("Task #1 created successfully")),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("z"))]), Some(n(0.0)))]),
            tool_res(Some(n(0.0)), s("Task #2 created successfully")),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("o"))]), Some(o(vec![("a", n(1.0))])))]),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("t"))]), Some(J::Bool(true)))]),
            tool_res(Some(J::Bool(true)), s("Task #3 created successfully")),
            asst(vec![tu("TaskCreate", o(vec![("subject", s("nid"))]))]),
            tool_res(None, s("Task #4 created successfully")),
        ]),
    ));
    out.push(sc(
        "tasks-create-text-variants",
        mk().lines(vec![
            asst(vec![tool_use("TaskCreate", o(vec![]), Some(s("a")))]),
            created("a", "Task #12 created successfully: x"),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("b"))]), Some(s("b")))]),
            created("b", "no number here"),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("c"))]), Some(s("c")))]),
            tool_res(Some(s("c")), a(vec![o(vec![("type", s("text")), ("text", s("Task #\u{663} created successfully"))])])),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("d"))]), Some(s("d")))]),
            tool_res(Some(s("d")), J::Null),
        ]),
    ));
    out.push(sc(
        "tasks-recreate-keeps-status",
        mk().lines(vec![
            asst(vec![tu("TaskUpdate", o(vec![("taskId", s("1")), ("status", s("in_progress"))]))]),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("S"))]), Some(s("a")))]),
            created("a", "Task #1 created successfully"),
        ]),
    ));
    let side = |flag: bool, content: &str| {
        o(vec![
            ("type", s("assistant")),
            ("isSidechain", J::Bool(flag)),
            ("message", o(vec![("content", a(vec![tu("TodoWrite", todo(vec![td(content, "pending")]))]))])),
        ])
        .text()
    };
    out.push(sc("tasks-sidechain-ignored", mk().lines(vec![side(true, "side"), side(false, "main")])));
    out.push(sc(
        "tasks-only-user-lines",
        mk().lines(vec![
            user("TodoWrite is a tool"),
            um(a(vec![o(vec![("type", s("tool_use")), ("name", s("TodoWrite")), ("input", todo(vec![o(vec![("content", s("x"))])]))])])),
        ]),
    ));
    out.push(sc(
        "tasks-weird-items",
        mk().lines(vec![
            o(vec![
                ("type", s("assistant")),
                (
                    "message",
                    o(vec![(
                        "content",
                        a(vec![J::Null, n(0.0), s("TaskCreate"), o(vec![("type", s("tool_use"))]), tu("TodoWrite", J::Null), tu("TaskUpdate", s("str"))]),
                    )]),
                ),
            ])
            .text(),
            o(vec![("type", s("assistant")), ("message", o(vec![("content", s("TodoWrite"))]))]).text(),
            a(vec![s("TodoWrite")]).text(),
        ]),
    ));
    out.push(sc(
        "tasks-many-cells",
        mk().lines(vec![asst(vec![tu(
            "TodoWrite",
            todo(vec![
                td("caf\u{e9} \u{1F600}\n\tline | two", "pending"),
                td(&"\u{1F600}".repeat(150), "pending"),
                td(&format!("{}\u{1F600}", "a".repeat(199)), "pending"),
            ]),
        )])]),
    ));
    out.push(sc(
        "tasks-and-messages-together",
        mk().lines(vec![
            user("first"),
            asst(vec![tu("TodoWrite", todo(vec![td("a", "pending")]))]),
            user("second"),
            asst(vec![tool_use("TaskCreate", o(vec![("subject", s("N"))]), Some(s("q")))]),
            created("q", "Task #3 created successfully"),
            user("third"),
        ]),
    ));
    // ---- fuzz: random transcripts, same seed for both sides ----
    let mut f = Fz { r: Rng::new(4242) };
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(120);
    for i in 0..nfuzz {
        let count = 2 + f.r.below(10);
        let lines: Vec<String> = (0..count).map(|_| f.line()).collect();
        out.push(sc(&format!("fuzz-{i}"), mk().lines(lines)));
    }
    out
}

struct Fz {
    r: Rng,
}

const WORDS_LEN: usize = 21;

impl Fz {
    fn word(&mut self) -> String {
        let words: [String; WORDS_LEN] = [
            "".into(),
            " ".into(),
            "a".into(),
            "caf\u{e9}".into(),
            "\u{1F600}".into(),
            "|".into(),
            "||x".into(),
            "line\nbreak".into(),
            "tab\there".into(),
            "<system-reminder>x".into(),
            "<task-notification>".into(),
            "  pad  ".into(),
            "x".repeat(250),
            "\u{1F600}".repeat(120),
            "deleted".into(),
            "pending".into(),
            "completed".into(),
            "in_progress".into(),
            "0".into(),
            "TodoWrite".into(),
            "user".into(),
        ];
        self.r.pick(&words).clone()
    }
    fn scalar(&mut self) -> J {
        // the corpus built the array (two word draws) before picking from it
        let w1 = self.word();
        let w2 = self.word();
        let items: [J; 14] =
            [J::Null, J::Bool(true), J::Bool(false), n(0.0), n(1.0), n(-1.0), n(2.5), n(1e21), s(""), s("x"), s("deleted"), s("pending"), s(&w1), s(&w2)];
        self.r.pick(&items).clone()
    }
    fn rv(&mut self, d: i32) -> J {
        let x = self.r.next();
        if d <= 0 || x < 0.55 {
            return self.scalar();
        }
        if x < 0.75 {
            let len = self.r.below(3);
            return a((0..len).map(|_| self.rv(d - 1)).collect());
        }
        let mut obj: Vec<(&str, J)> = Vec::new();
        for k in ["content", "subject", "status", "type", "text", "id", "taskId"] {
            if self.r.next() < 0.4 {
                let v = self.rv(d - 1);
                obj.push((k, v));
            }
        }
        o(obj)
    }
    fn line(&mut self) -> String {
        let x = self.r.next();
        if x < 0.25 {
            let w1 = self.word();
            let w2 = self.word();
            return user(&format!("{w1}{w2}"));
        }
        if x < 0.35 {
            let types: [J; 5] = [s("user"), s("assistant"), s("event_msg"), s("x"), n(5.0)];
            let ty = self.r.pick(&types).clone();
            let metas: [Option<J>; 5] = [None, Some(J::Bool(true)), Some(J::Bool(false)), Some(n(0.0)), Some(s("x"))];
            let meta = self.r.pick(&metas).clone();
            let sides: [Option<J>; 4] = [None, Some(J::Bool(true)), Some(J::Bool(false)), Some(s("true"))];
            let side = self.r.pick(&sides).clone();
            let message = self.rv(2);
            let payload = self.rv(2);
            let stamps: [Option<J>; 4] = [None, Some(s("t")), Some(n(5.0)), Some(J::Null)];
            let stamp = self.r.pick(&stamps).clone();
            let mut v = vec![("type", ty)];
            if let Some(m) = meta {
                v.push(("isMeta", m));
            }
            if let Some(m) = side {
                v.push(("isSidechain", m));
            }
            v.push(("message", message));
            v.push(("payload", payload));
            if let Some(m) = stamp {
                v.push(("timestamp", m));
            }
            return o(v).text();
        }
        if x < 0.55 {
            let todos = if self.r.next() < 0.9 {
                let len = self.r.below(4);
                a((0..len).map(|_| self.rv(1)).collect())
            } else {
                self.rv(1)
            };
            return asst(vec![tu("TodoWrite", o(vec![("todos", todos)]))]);
        }
        if x < 0.7 {
            let input = if self.r.next() < 0.8 {
                let sub = self.rv(0);
                o(vec![("subject", sub)])
            } else {
                self.rv(1)
            };
            let id = if self.r.next() < 0.8 {
                let k = self.r.below(4);
                s(&format!("id{k}"))
            } else {
                self.rv(0)
            };
            return asst(vec![tool_use("TaskCreate", input, Some(id))]);
        }
        if x < 0.82 {
            let input = if self.r.next() < 0.85 {
                let ids: [J; 7] = [n(1.0), s("1"), s("2"), n(3.0), J::Null, s("x"), a(vec![s("a")])];
                let task_id = self.r.pick(&ids).clone();
                let status = self.rv(0);
                let subject = self.rv(0);
                o(vec![("taskId", task_id), ("status", status), ("subject", subject)])
            } else {
                self.rv(1)
            };
            return asst(vec![tu("TaskUpdate", input)]);
        }
        if x < 0.92 {
            let k = self.r.below(4);
            let id = format!("id{k}");
            let k2 = self.r.below(4);
            let nested = self.rv(1);
            let items: [J; 5] = [
                s(&format!("Task #{k2} created successfully")),
                s("x"),
                J::Null,
                a(vec![o(vec![("type", s("text")), ("text", s("Task #1 created successfully"))])]),
                nested,
            ];
            let content = self.r.pick(&items).clone();
            return tool_res(Some(s(&id)), content);
        }
        let deep = self.rv(3).text();
        let items = ["".to_string(), " ".into(), "not json".into(), "{\"type\":\"user\"".into(), "[1]".into(), "null".into(), "5".into(), deep];
        self.r.pick(&items).clone()
    }
}
