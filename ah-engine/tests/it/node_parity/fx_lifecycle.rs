//! Parity of the built-in `task-lifecycle-log` check against `hooks/task-lifecycle-log.js` (TaskCreated / TaskCompleted).
//! Compared: exit code, stdout, stderr and the whole file tree both worlds hold afterwards (ledger, INDEX.md, any directory the
//! hook created). Corpus: field shapes, text sanitizing (control characters, white space, emoji at the cut, limits), session id
//! forms, repo-root resolution (git dir, subdirectory, git file, broken git file, cwd inside the git directory, symlinked cwd,
//! missing cwd, cwd that is a file, checkout at HOME), existing ledger/index content, switches, unwritable directories, malformed
//! stdin, and a seeded fuzz.

use super::fx::*;
use super::jsjson::J;
use super::support::*;

/// `Object.assign({hook_event_name: ev, session_id: 'sess-1', cwd: '$PROJ', task_id: '7', task_subject: ..., transcript_path: '/x'}, extra)`;
/// a `None` value is an `undefined` member (dropped).
fn base_ev(extra: &[(&str, Option<J>)], ev: &str) -> J {
    let mut p =
        jo! {"hook_event_name": ev, "session_id": "sess-1", "cwd": "$PROJ", "task_id": "7", "task_subject": "write the parser", "transcript_path": "/x"};
    for (k, v) in extra {
        match v {
            Some(v) => p.set(k, v.clone()),
            None => p.remove(k),
        }
    }
    p
}
fn base(extra: &[(&str, Option<J>)]) -> J {
    base_ev(extra, "TaskCreated")
}
fn s(k: &'static str, v: impl Into<J>) -> (&'static str, Option<J>) {
    (k, Some(v.into()))
}
fn del(p: J, k: &str) -> J {
    let mut p = p;
    p.remove(k);
    p
}

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let mut out: Vec<Scenario> = Vec::new();
    let repo = World::new().git("proj");
    let add = |out: &mut Vec<Scenario>, id: &str, payload: J, world: &World| out.push(Scenario::one(id, payload, world));
    let sj = |v: &J| v.text();

    // ---- plain events and field shapes
    let events: Vec<J> = vec![
        J::from("TaskCreated"),
        J::from("TaskCompleted"),
        J::from("Stop"),
        J::from("taskcreated"),
        J::from("TaskUpdated"),
        J::from(""),
        J::Null,
        J::from(5),
        ja!["TaskCreated"],
    ];
    for ev in events {
        add(&mut out, &format!("event-{}", sj(&ev)), base(&[s("hook_event_name", ev.clone())]), &repo);
    }
    add(&mut out, "no-event", del(base(&[]), "hook_event_name"), &repo);
    add(&mut out, "teammate", base(&[s("teammate_name", "builder-1")]), &repo);
    add(&mut out, "teammate-long", base(&[s("teammate_name", "x".repeat(150))]), &repo);
    add(&mut out, "teammate-ws", base(&[s("teammate_name", "  a\t\nb  ")]), &repo);
    add(&mut out, "teammate-num", base(&[s("teammate_name", 5)]), &repo);
    add(&mut out, "subject-missing", del(base(&[]), "task_subject"), &repo);
    let subjects: Vec<J> = vec![J::from(""), J::from(0), J::Bool(false), J::Null, J::from(5), ja!["a"], jo! {"a": 1}, J::Bool(true)];
    for sub in subjects {
        add(&mut out, &format!("subject-{}", sj(&sub)), base(&[s("task_subject", sub.clone())]), &repo);
    }
    add(&mut out, "subject-long", base(&[s("task_subject", "y".repeat(400))]), &repo);
    add(&mut out, "subject-exact-200", base(&[s("task_subject", "z".repeat(200))]), &repo);
    add(&mut out, "subject-201", base(&[s("task_subject", "z".repeat(201))]), &repo);
    add(&mut out, "subject-ctl", base(&[s("task_subject", "a\u{0}b\u{1f}c\u{7f}d\u{9f}e\u{a0}f\u{2028}g\u{3000}h")]), &repo);
    add(&mut out, "subject-newlines", base(&[s("task_subject", "line1\nline2\r\n\tline3")]), &repo);
    add(&mut out, "subject-unicode", base(&[s("task_subject", "caf\u{e9} \u{2014} na\u{ef}ve \u{65e5}\u{672c}\u{8a9e} \u{fc}n\u{ef}c\u{f6}d\u{e9}")]), &repo);
    add(&mut out, "subject-emoji-cut-pair", base(&[s("task_subject", format!("{}\u{1f600}tail", "a".repeat(199)))]), &repo);
    add(&mut out, "subject-emoji-cut-clean", base(&[s("task_subject", format!("{}\u{1f600}tail", "a".repeat(198)))]), &repo);
    add(&mut out, "subject-trim-then-cut", base(&[s("task_subject", format!("{}{}", " ".repeat(10), "b".repeat(300)))]), &repo);
    add(&mut out, "subject-md", base(&[s("task_subject", "- [x] **bold** `code` | pipe")]), &repo);
    let task_ids: Vec<J> = vec![
        J::from(7),
        J::from(0),
        J::from(-1),
        J::from(1.5),
        J::from(1e21),
        J::from(1e-7),
        J::from(123456789012345680000.0),
        J::Bool(true),
        J::Bool(false),
        J::Null,
        J::from(""),
        J::from("   "),
        J::from(" 12 "),
        J::from("abc"),
        ja!["a", "b"],
        ja![1, ja![2, 3]],
        ja![J::Null, J::from(1)],
        jo! {"a": 1},
        J::from("x".repeat(250)),
        J::from("\u{fc}n\u{ef}\u{0}c\u{f8}de"),
        J::from("12\n34"),
    ];
    for t in task_ids {
        add(&mut out, &format!("task-id-{}", sj(&t)), base(&[s("task_id", t.clone())]), &repo);
    }
    add(&mut out, "task-id-missing", del(base(&[]), "task_id"), &repo);
    add(&mut out, "task-id-emoji-cut", base(&[s("task_id", format!("{}\u{1f600}", "a".repeat(199)))]), &repo);
    let sessions: Vec<J> = vec![
        J::from("sess-1"),
        J::from("a/b"),
        J::from("../../etc"),
        J::from("\u{fc}n\u{ef}"),
        J::from(""),
        J::from("   "),
        J::Null,
        J::from(5),
        J::Bool(true),
        ja!["a", "b"],
        jo! {"x": 1},
        J::from("x".repeat(300)),
        J::from("a.b.c"),
        J::from("A_B-c"),
        J::from("\u{1f600}\u{1f600}"),
        J::from(1.5),
        J::from(0),
    ];
    for sv in sessions {
        add(&mut out, &format!("session-{}", clip(&sj(&sv), 40)), base(&[s("session_id", sv.clone())]), &repo);
    }
    add(&mut out, "session-missing", del(base(&[]), "session_id"), &repo);
    let cwds: Vec<(&str, Option<J>)> = vec![
        ("undefined", None),
        ("null", Some(J::Null)),
        ("\"\"", Some(J::from(""))),
        ("5", Some(J::from(5))),
        ("true", Some(J::Bool(true))),
        ("[]", Some(ja![])),
        ("{}", Some(jo! {})),
    ];
    for (id, c) in cwds {
        let p = match c {
            None => del(base(&[]), "cwd"),
            Some(v) => base(&[s("cwd", v)]),
        };
        add(&mut out, &format!("cwd-{id}"), p, &repo);
    }
    add(&mut out, "extra-fields", base(&[s("task_description", "desc"), s("foo", jo! {"bar": ja![1, 2]})]), &repo);
    let raws: Vec<String> = vec![
        "".into(),
        "   ".into(),
        "not json".into(),
        "{".into(),
        "[]".into(),
        "null".into(),
        "5".into(),
        "\"str\"".into(),
        "true".into(),
        "{\"hook_event_name\":\"TaskCreated\"".into(),
        "\u{feff}{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"1\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"1\",\"session_id\":\"s\\ud83d\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"\\ud800x\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"1\",\"task_id\":\"2\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"1e5\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":1E2}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":12345678901234567890123}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":0.1}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":-0}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\",\"task_id\":\"\\u0000\"}".into(),
        "{\"hook_event_name\":\"TaskCreated\",\"cwd\":\"$PROJ\\u0000x\",\"task_id\":\"1\"}".into(),
    ];
    for raw in raws {
        out.push(Scenario::new(&format!("raw-{}", clip(&J::from(raw.clone()).text(), 50)), repo.clone(), vec![Step::raw(&raw)]));
    }
    add(&mut out, "huge-subject", base(&[s("task_subject", "q".repeat(2_000_000))]), &repo);
    let deep = (0..59).fold(ja![], |inner, _| ja![inner]);
    add(&mut out, "deep-json", base(&[("extra", Some(deep))]), &repo);

    // ---- project-root resolution
    let none = World::new();
    let w_dirs = |g: &[&str], d: &[&str]| {
        let mut w = World::new();
        for x in g {
            w = w.git(x);
        }
        for x in d {
            w = w.dir(x);
        }
        w
    };
    let cwd = |c: &str| base(&[s("cwd", c)]);
    add(&mut out, "root-plain-no-git", base(&[]), &none);
    add(&mut out, "root-subdir-of-repo", cwd("$PROJ/src/deep"), &w_dirs(&["proj"], &["proj/src/deep"]));
    add(&mut out, "root-cwd-trailing-slash", cwd("$PROJ/"), &repo);
    add(&mut out, "root-cwd-dotdot", cwd("$PROJ/src/../src"), &w_dirs(&["proj"], &["proj/src"]));
    add(&mut out, "root-cwd-dot", cwd("$PROJ/./"), &repo);
    add(&mut out, "root-cwd-double-slash", cwd("$PROJ//src"), &w_dirs(&["proj"], &["proj/src"]));
    add(&mut out, "root-inside-git-dir", cwd("$PROJ/.git/hooks"), &w_dirs(&["proj"], &["proj/.git/hooks"]));
    add(&mut out, "root-at-git-dir", cwd("$PROJ/.git"), &repo);
    let gf = |content: &str| World::new().file("proj/.git", content).dir("gitstore/wt");
    add(&mut out, "root-git-file-valid", cwd("$PROJ"), &gf("gitdir: $W/gitstore/wt\n"));
    add(&mut out, "root-git-file-relative", cwd("$PROJ/sub"), &World::new().file("proj/.git", "gitdir: ../gitstore/wt\n").dir("gitstore/wt").dir("proj/sub"));
    add(&mut out, "root-git-file-crlf", cwd("$PROJ"), &gf("gitdir: $W/gitstore/wt\r\n"));
    add(&mut out, "root-git-file-leading-blank", cwd("$PROJ"), &gf("\n\n  gitdir:   $W/gitstore/wt   \n"));
    add(&mut out, "root-git-file-second-line", cwd("$PROJ"), &gf("junk\ngitdir: $W/gitstore/wt\n"));
    add(&mut out, "root-git-file-no-newline", cwd("$PROJ"), &gf("gitdir: $W/gitstore/wt"));
    add(&mut out, "root-git-file-missing-target", cwd("$PROJ"), &World::new().file("proj/.git", "gitdir: $W/nowhere\n"));
    add(&mut out, "root-git-file-target-is-file", cwd("$PROJ"), &World::new().file("proj/.git", "gitdir: $W/afile\n").file("afile", "x"));
    add(&mut out, "root-git-file-garbage", cwd("$PROJ"), &World::new().file("proj/.git", "hello world\n"));
    add(&mut out, "root-git-file-empty", cwd("$PROJ"), &World::new().file("proj/.git", ""));
    add(&mut out, "root-git-file-empty-value", cwd("$PROJ"), &World::new().file("proj/.git", "gitdir:   \n"));
    add(&mut out, "root-git-file-cwd-in-target", cwd("$W/gitstore/wt/sub"), &World::new().file("proj/.git", "gitdir: $W/gitstore/wt\n").dir("gitstore/wt/sub"));
    add(&mut out, "root-git-symlink-to-dir", cwd("$PROJ"), &World::new().dir("realgit").link("proj/.git", "$W/realgit"));
    add(&mut out, "root-git-broken-symlink", cwd("$PROJ"), &World::new().link("proj/.git", "$W/nope"));
    add(&mut out, "root-symlinked-cwd", cwd("$W/link"), &World::new().git("proj").link("link", "$PROJ"));
    add(&mut out, "root-symlinked-cwd-sub", cwd("$W/link/src"), &World::new().git("proj").dir("proj/src").link("link", "$PROJ"));
    add(&mut out, "root-symlink-in-middle", cwd("$W/a/b"), &World::new().git("proj").dir("proj/x").link("a/b", "$PROJ/x"));
    add(&mut out, "root-cwd-missing", cwd("$W/nonexistent/deep/dir"), &none);
    add(&mut out, "root-cwd-missing-in-repo", cwd("$PROJ/gone/er"), &repo);
    add(&mut out, "root-cwd-is-file", cwd("$W/afile"), &World::new().file("afile", "x"));
    add(&mut out, "root-cwd-nul", cwd("$PROJ\u{0}/x"), &repo);
    add(&mut out, "root-relative-cwd", cwd("proj"), &repo);
    add(&mut out, "root-relative-dot", cwd("."), &repo);
    add(&mut out, "root-relative-dotdot", cwd("../x"), &repo);
    add(&mut out, "root-home-is-repo", cwd("$HOME/sub"), &w_dirs(&["home"], &["home/sub"]));
    add(&mut out, "root-home-is-repo-at-home", cwd("$HOME"), &w_dirs(&["home"], &[]));
    add(&mut out, "root-home-sub-repo", cwd("$HOME/proj2"), &w_dirs(&["home", "home/proj2"], &[]));
    add(&mut out, "root-nested-repo", cwd("$PROJ/inner/x"), &w_dirs(&["proj", "proj/inner"], &["proj/inner/x"]));
    add(
        &mut out,
        "root-submodule-like",
        cwd("$PROJ/mod"),
        &World::new().git("proj").file("proj/mod/.git", "gitdir: ../.git/modules/mod\n").dir("proj/.git/modules/mod"),
    );
    add(&mut out, "root-spaces-in-path", cwd("$W/my proj/x y"), &w_dirs(&["my proj"], &["my proj/x y"]));
    add(&mut out, "root-unicode-path", cwd("$W/proj\u{e9}/\u{65e5}\u{672c}"), &w_dirs(&["proj\u{e9}"], &["proj\u{e9}/\u{65e5}\u{672c}"]));
    add(&mut out, "root-git-dir-symlink-under", cwd("$PROJ"), &World::new().dir("store/g").link("proj/.git", "$W/store/g"));
    add(&mut out, "root-tilde-cwd", cwd("~/proj"), &repo);
    add(&mut out, "root-root-dir", cwd("/"), &none);

    // ---- ledger and index state
    let today = iso_from_ms(now_ms() as i64)[..10].to_string();
    let hd = format!("proj/.anti-hall/history/{today}");
    let git_files = |files: &[(&str, &str)]| {
        let mut w = World::new().git("proj");
        for (k, v) in files {
            w = w.file(k, v);
        }
        w
    };
    add(&mut out, "state-existing-ledger", base(&[]), &git_files(&[(&format!("{hd}/sess-1.md"), "- earlier line\n")]));
    add(&mut out, "state-existing-ledger-no-newline", base(&[]), &git_files(&[(&format!("{hd}/sess-1.md"), "- earlier line")]));
    add(
        &mut out,
        "state-index-has-session",
        base(&[]),
        &git_files(&[("proj/.anti-hall/history/INDEX.md", "- 2020-01-01 \u{b7} sess-1 \u{b7} [history](../x)\n")]),
    );
    add(
        &mut out,
        "state-index-has-substring",
        base(&[s("session_id", "ab")]),
        &git_files(&[("proj/.anti-hall/history/INDEX.md", "something abc something\n")]),
    );
    add(&mut out, "state-index-other", base(&[]), &git_files(&[("proj/.anti-hall/history/INDEX.md", "- other\n")]));
    add(&mut out, "state-index-no-newline", base(&[]), &git_files(&[("proj/.anti-hall/history/INDEX.md", "- other")]));
    add(&mut out, "state-index-is-dir", base(&[]), &World::new().git("proj").dir("proj/.anti-hall/history/INDEX.md"));
    add(&mut out, "state-ledger-is-dir", base(&[]), &World::new().git("proj").dir(&format!("{hd}/sess-1.md")));
    add(&mut out, "state-history-is-file", base(&[]), &git_files(&[("proj/.anti-hall/history", "x")]));
    add(&mut out, "state-anti-hall-is-file", base(&[]), &git_files(&[("proj/.anti-hall", "x")]));
    add(&mut out, "state-index-invalid-utf8", base(&[]), &git_files(&[("proj/.anti-hall/history/INDEX.md", "x\u{fffd}y\n")]));
    add(&mut out, "state-readonly-history", base(&[]), &World::new().git("proj").dir("proj/.anti-hall/history").mode("proj/.anti-hall/history", "555"));
    add(&mut out, "state-readonly-ledger", base(&[]), &git_files(&[(&format!("{hd}/sess-1.md"), "x\n")]).mode(&format!("{hd}/sess-1.md"), "444"));
    add(
        &mut out,
        "state-readonly-index",
        base(&[]),
        &git_files(&[("proj/.anti-hall/history/INDEX.md", "x\n")]).mode("proj/.anti-hall/history/INDEX.md", "444"),
    );
    add(&mut out, "state-readonly-proj", base(&[]), &World::new().git("proj").mode("proj", "555"));
    add(&mut out, "state-big-index", base(&[]), &git_files(&[("proj/.anti-hall/history/INDEX.md", &"- l\n".repeat(50000))]));

    // ---- sequences (idempotent index, ledger growth)
    let seq = |out: &mut Vec<Scenario>, id: &str, steps: Vec<J>, world: &World| {
        out.push(Scenario::new(id, world.clone(), steps.into_iter().map(Step::payload).collect()))
    };
    seq(&mut out, "seq-two-events", vec![base(&[]), base_ev(&[], "TaskCompleted")], &repo);
    seq(
        &mut out,
        "seq-many",
        (0..12)
            .map(|i| {
                base_ev(
                    &[s("task_id", i.to_string()), ("teammate_name", if i % 3 != 0 { Some(J::from("mate")) } else { None })],
                    if i % 2 != 0 { "TaskCompleted" } else { "TaskCreated" },
                )
            })
            .collect(),
        &repo,
    );
    seq(
        &mut out,
        "seq-two-sessions",
        vec![base(&[s("session_id", "a")]), base(&[s("session_id", "b")]), base(&[s("session_id", "a")]), base(&[s("session_id", "ab")])],
        &repo,
    );
    seq(&mut out, "seq-substring-sessions", vec![base(&[s("session_id", "abc")]), base(&[s("session_id", "b")]), base(&[s("session_id", "bc")])], &repo);
    seq(&mut out, "seq-two-cwds", vec![base(&[s("cwd", "$PROJ")]), base(&[s("cwd", "$PROJ/src")])], &w_dirs(&["proj"], &["proj/src"]));
    seq(&mut out, "seq-bad-then-good", vec![base(&[s("task_id", "")]), base(&[s("cwd", "")]), base(&[])], &repo);

    // ---- switches
    let st = |text: &str| World::new().git("proj").file("home/.anti-hall/settings.json", text);
    let off = st("{\"maintenance\":{\"taskLifecycleLog\":false}}");
    add(&mut out, "switch-file-off", base(&[]), &off);
    add(&mut out, "switch-file-off-string", base(&[]), &st("{\"maintenance\":{\"taskLifecycleLog\":\"off\"}}"));
    add(&mut out, "switch-file-on-string", base(&[]), &st("{\"maintenance\":{\"taskLifecycleLog\":\"on\"}}"));
    add(&mut out, "switch-file-garbage", base(&[]), &st("{not json"));
    add(&mut out, "switch-file-number-0", base(&[]), &st("{\"maintenance\":{\"taskLifecycleLog\":0}}"));
    add(&mut out, "switch-file-unrelated", base(&[]), &st("{\"maintenance\":{\"other\":false}}"));
    out.push(Scenario::new(
        "switch-option-off",
        repo.clone(),
        vec![Step::payload(base(&[])).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_TASK_LIFECYCLE_LOG", "false")],
    ));
    out.push(Scenario::new(
        "switch-option-default-true",
        off.clone(),
        vec![Step::payload(base(&[])).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_TASK_LIFECYCLE_LOG", "true")],
    ));
    add(
        &mut out,
        "switch-stored-option-off",
        base(&[]),
        &World::new()
            .git("proj")
            .file("home/.claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"maintenance_task_lifecycle_log\":false}}}}"),
    );

    // ---- seeded fuzz
    let fz_text: Vec<J> = vec![
        "",
        " ",
        "plain",
        "with  spaces",
        "tab\there",
        "nl\nnl",
        "\u{fc}n\u{ef}",
        "\u{65e5}\u{672c}\u{8a9e}",
        "\u{1f600}",
        &format!("{}\u{1f600}", "a".repeat(199)),
        &"a".repeat(200),
        &"a".repeat(201),
        "\u{0}",
        "\u{85}",
        "\u{a0}x\u{a0}",
        "\u{2028}",
        "\u{feff}",
        &"x".repeat(5000),
        "\"quoted\"",
        "\\back",
        "<b>",
        "- list",
        "| t |",
    ]
    .into_iter()
    .map(J::from)
    .collect();
    let mut fz_val = fz_text.clone();
    fz_val.extend([
        J::from(0),
        J::from(1),
        J::from(7),
        J::from(-3),
        J::from(2.5),
        J::Bool(true),
        J::Bool(false),
        J::Null,
        ja![],
        ja!["x"],
        ja![1, 2],
        jo! {},
        jo! {"a": 1},
    ]);
    let fz_worlds = [repo.clone(), World::new(), w_dirs(&["proj"], &["proj/s"])];
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(300);
    for i in 0..nfuzz {
        let ev = *r.pick(&["TaskCreated", "TaskCompleted", "TaskCreated", "Other"]);
        let sess = r.pick(&fz_val).clone();
        let cw = r.pick(&[J::from("$PROJ"), J::from("$PROJ"), J::from("$PROJ/s"), J::from("$W/none"), J::from(""), J::from(5)]).clone();
        let tid = r.pick(&fz_val).clone();
        let subj = r.pick(&fz_val).clone();
        let mate = r.pick(&fz_val).clone();
        let mut p = jo! {"hook_event_name": ev, "session_id": sess, "cwd": cw, "task_id": tid, "task_subject": subj, "teammate_name": mate};
        for k in ["hook_event_name", "session_id", "cwd", "task_id", "task_subject", "teammate_name"] {
            if r.next() < 0.08 {
                p.remove(k);
            }
        }
        let w = r.pick(&fz_worlds).clone();
        out.push(Scenario::one(&format!("fuzz-{i}"), p, &w));
    }
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("task-lifecycle-log", "task-lifecycle-log.js", "task-lifecycle-log");
    // The only inputs the engine may defer: a relative or ~ cwd, a field cut through a surrogate pair, a number JavaScript prints
    // differently, text that is not JSON (and the two malformed-surrogate escapes), and the fuzz rows that hit one of those.
    let re = regex::Regex::new(r"^(root-relative|root-tilde|subject-emoji|task-id-emoji|task-id-1e|task-id-123456789012345680000|raw-|fuzz-)").unwrap();
    o.may_defer = Some(Box::new(move |sc, _| re.is_match(&sc.id)));
    o
}
