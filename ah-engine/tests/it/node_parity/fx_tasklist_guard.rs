//! Parity of the built-in `tasklist-guard` check against `hooks/tasklist-guard.js` (Stop). The engine answers every Stop on which
//! Node does not block (with the same files written: the progress directory, the progress and history indexes, the
//! resume-verification marker) and defers every Stop on which Node blocks. Compared: exit code, stdout, stderr and the whole file
//! tree. Families:
//!   work-*     one tool use per transcript with the work threshold at 1 and no task activity: Node blocks iff the tool use counts
//!              as work, so the engine must answer exactly the ones Node leaves alone (answer_when_silent);
//!   tracked-*  tracked work with a fresh or stale progress file, stale in-progress tasks, resets, TodoWrite;
//!   resume-*, mode-*, switch-*, root-*: the resume nudge, plan mode, switches, project-root resolution;
//!   real-*     whole real transcripts (`AH_PARITY_REAL_TRANSCRIPTS`, local data, optional).

use super::fx::*;
use super::fx_tasklines::*;
use super::jsjson::J;
use super::support::*;
use std::cell::{Cell, RefCell};
use std::path::Path;
use std::sync::Arc;

include!("fx_tasklist_tables.rs");

#[derive(Clone, Copy, Default)]
struct Flags {
    silent: bool,
}

fn stop(tp: Option<J>, extra: &[(&str, Option<J>)]) -> J {
    let mut p = match tp {
        Some(t) => jo! {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": "$PROJ", "transcript_path": t, "stop_hook_active": false},
        None => jo! {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": "$PROJ", "stop_hook_active": false},
    };
    for (k, v) in extra {
        match v {
            Some(v) => p.set(k, v.clone()),
            None => p.remove(k),
        }
    }
    p
}
fn tpj(p: &str) -> Option<J> {
    Some(J::from(p))
}
fn st(k: &'static str, v: impl Into<J>) -> (&'static str, Option<J>) {
    (k, Some(v.into()))
}
fn status(s: &str) -> Vec<(&'static str, J)> {
    vec![("status", J::from(s))]
}

fn touch_at(rel: &str, secs: f64) -> Before {
    let rel = rel.to_string();
    Arc::new(move |w: &Path| set_mtime(&w.join(&rel), secs))
}

pub(crate) fn corpus() -> (Vec<Scenario>, Scratch) {
    let mut r = Rng::new(1);
    let tl = Tl::new();
    let shared = Scratch::new("tl-shared");
    let nf = Cell::new(0usize);
    let put = |lines: &[String], name: Option<&str>| -> String {
        let n = match name {
            Some(n) => n.to_string(),
            None => {
                let v = nf.get();
                nf.set(v + 1);
                format!("f{v}")
            }
        };
        let f = shared.path().join(format!("{n}.jsonl"));
        write_file(&f, format!("{}\n", lines.join("\n")).as_bytes());
        f.to_string_lossy().to_string()
    };
    let today = iso_from_ms(now_ms() as i64)[..10].to_string();
    let prog = format!("proj/.anti-hall/progress/{today}/sess-1.md");
    let hist = format!("proj/.anti-hall/history/{today}/sess-1.md");
    let out: RefCell<Vec<Scenario>> = RefCell::new(Vec::new());
    let add = |id: &str, payload: J, world: &World, f: Flags| {
        let mut sc = Scenario::one(id, payload, world);
        sc.answer_when_silent = f.silent;
        out.borrow_mut().push(sc);
    };
    let silent = Flags { silent: true };
    let none = Flags::default();
    let repo = World::new().git("proj");
    let t1 = World::new().git("proj").file("home/.anti-hall/settings.json", "{\"guards\":{\"tasklistWorkThreshold\":1}}");
    let now = now_ms() as f64 / 1000.0;
    let old_secs = now - 40.0 * 86400.0;
    let edit_n = |fp: &str, n: Option<usize>| {
        let tu = tl.use_(
            "Edit",
            jo! {"file_path": fp, "old_string": "a", "new_string": format!("b{}", n.filter(|x| *x != 0).map_or(String::new(), |x| x.to_string()))},
        );
        tl.asst(vec![tu])
    };
    let write_l = |fp: &str| {
        let tu = tl.use_("Write", jo! {"file_path": fp, "content": "x"});
        tl.asst(vec![tu])
    };
    let task = |n: i64, s: &str| tl.create(n, jo! {"subject": s});
    let upd = |n: i64, extra: Vec<(&str, J)>| tl.update(n, extra);

    // ---- work family: does this tool use count?
    let wi = Cell::new(0usize);
    let work_lines = |lines: Vec<String>, id: String| {
        let n = wi.get();
        wi.set(n + 1);
        let f = put(&lines, Some(&format!("w{n}")));
        add(&id, stop(tpj(&f), &[]), &t1, silent);
    };
    let work_cmd = |id: String, cmd: &str| {
        let mut lines = vec![tl.prompt("go")];
        lines.extend(tl.bash(cmd));
        work_lines(lines, id);
    };
    let work_tool = |id: String, blocks: Vec<String>| {
        let mut lines = vec![tl.prompt("go")];
        lines.extend(blocks);
        work_lines(lines, id);
    };
    for c in HAND {
        work_cmd(format!("work-hand-{}", wi.get()), c);
    }
    let cmds = real_cmds();
    for c in cmds.iter().take(real_limit().min(1500)) {
        work_cmd(format!("work-real-{}", wi.get()), c["cmd"].as_str().unwrap_or(""));
    }
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(300);
    for _ in 0..nfuzz {
        let mut c = String::new();
        let n = 1 + r.below(6);
        for _ in 0..n {
            c.push_str(r.pick(&WORDS));
            c.push_str(r.pick(&["", " ", " "]));
        }
        work_cmd(format!("work-fuzz-{}", wi.get()), &c);
    }
    let paths = [
        "/p/src/a.js",
        "/p/x/scratchpad/y",
        "/p/.anti-hall/progress/2026-01-01/s.md",
        "/p/.anti-hall/history/x.md",
        "/p/.anti-hall/handovers/a.md",
        "",
        "/tmp/x",
        "/private/tmp/y",
        "/p/.anti-hall/other/z",
        "rel.js",
        ".anti-hall/progress/x.md",
        "/p/scratchpad/y",
    ];
    for tool in ["Edit", "Write", "MultiEdit", "NotebookEdit"] {
        for fp in paths {
            let input = if tool == "NotebookEdit" {
                jo! {"notebook_path": fp}
            } else {
                jo! {"file_path": fp}
            };
            let tu = tl.use_(tool, input);
            let l = tl.asst(vec![tu]);
            work_tool(format!("work-tool-{tool}-{}", wi.get()), vec![l]);
            if tool != "NotebookEdit" {
                let tu = tl.use_(tool, jo! {"file_path": fp});
                let l = tl.asst(vec![tu]);
                work_tool(format!("work-tool-fp-{tool}-{}", wi.get()), vec![l]);
            }
        }
    }
    let shape_blocks: Vec<(&str, Vec<J>)> = vec![
        ("agent", vec![tl.use_("Agent", jo! {"prompt": "x", "description": "d"})]),
        ("task", vec![tl.use_("Task", jo! {})]),
        ("cron", vec![tl.use_("CronCreate", jo! {"x": 1})]),
        ("read", vec![tl.use_("Read", jo! {"file_path": "/p/a"})]),
        ("grep", vec![tl.use_("Grep", jo! {"pattern": "x"})]),
        ("bash-nocmd", vec![tl.use_("Bash", jo! {})]),
        ("bash-num", vec![tl.use_("Bash", jo! {"command": 5})]),
        ("edit-noinput", vec![jo! {"type": "tool_use", "id": "e1", "name": "Edit"}]),
        ("edit-numfp", vec![tl.use_("Edit", jo! {"file_path": 5})]),
        ("two-edits", vec![tl.use_("Edit", jo! {"file_path": "/p/a"}), tl.use_("Write", jo! {"file_path": "/p/b"})]),
        ("name-lower", vec![tl.use_("edit", jo! {"file_path": "/p/a"})]),
    ];
    for (id, blocks) in shape_blocks {
        let l = tl.asst(blocks);
        work_tool(format!("work-shape-{id}"), vec![l]);
    }
    // timestamps: a counted action with and without a usable timestamp
    let edit_rec = |extra: Vec<(&str, J)>, id: &str| {
        let mut v = jo! {"type": "assistant"};
        for (k, x) in extra {
            v.set(k, x);
        }
        v.set("message", jo! {"id": id, "role": "assistant", "content": ja![tl.use_("Edit", jo! {"file_path": "/p/a.js"})]});
        v.text()
    };
    work_tool("work-nots".into(), vec![edit_rec(vec![], "m1")]);
    work_tool("work-badts".into(), vec![edit_rec(vec![("timestamp", J::from("not a date"))], "m1")]);
    work_tool("work-oddts".into(), vec![edit_rec(vec![("timestamp", J::from("Oct 5 2026 10:00"))], "m1")]);
    work_tool("work-sidechain".into(), vec![edit_rec(vec![("isSidechain", J::Bool(true)), ("timestamp", J::from(tl.ts(1)))], "m1")]);
    work_tool("work-null-line".into(), {
        let l = edit_n("/p/a.js", None);
        vec!["null".into(), l]
    });
    {
        let mut lines = vec![tl.prompt("go")];
        let tu = tl.use_("TodoWrite", jo! {"todos": ja![J::Null]});
        lines.push(tl.asst(vec![tu]));
        lines.push(edit_n("/p/a.js", None));
        let f = put(&lines, Some("ntd"));
        add("work-null-todo", stop(tpj(&f), &[]), &t1, silent);
    }
    work_tool("work-broken-line".into(), {
        let l = edit_n("/p/a.js", None);
        vec!["{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\"".into(), l]
    });

    // ---- tracked work: threshold 3, task activity and progress freshness
    let works = |n: usize| -> Vec<String> { (0..n).map(|i| edit_n(&format!("/p/src/f{i}.js"), Some(i))).collect() };
    let w3 = |lines: Vec<String>| -> String {
        let mut all = vec![tl.prompt("go")];
        all.extend(lines);
        put(&all, None)
    };
    let fresh = World::new().git("proj").file(&prog, "# progress\n");
    let stale = fresh.clone();
    let stale_step = |p: J| {
        let mut s = Step::payload(p);
        s.before = Some(touch_at(&prog, old_secs));
        s
    };
    let track = |id: &str, lines: Vec<String>, world: &World, is_stale: bool, answer: bool| {
        let f = w3(lines);
        let p = stop(tpj(&f), &[]);
        let step = if is_stale { stale_step(p) } else { Step::payload(p) };
        let mut sc = Scenario::new(id, world.clone(), vec![step]);
        sc.answer_when_silent = answer;
        out.borrow_mut().push(sc);
    };
    for n in [0usize, 1, 2, 3, 4, 9] {
        track(&format!("tracked-notasks-n{n}-fresh"), works(n), &fresh, false, n < 3);
    }
    for n in [3usize, 4] {
        track(&format!("tracked-tasks-n{n}-fresh"), cat(vec![task(1, "a"), works(n)]), &fresh, false, true);
        track(&format!("tracked-tasks-n{n}-stale"), cat(vec![task(1, "a"), works(n)]), &stale, true, false);
        track(&format!("tracked-tasks-n{n}-missing"), cat(vec![task(1, "a"), works(n)]), &repo, false, false);
        track(&format!("tracked-todowrite-n{n}-fresh"), cat(vec![tl.todo(ja![jo! {"content": "a", "status": "pending"}]), works(n)]), &fresh, false, true);
        track(&format!("tracked-update-only-n{n}-fresh"), cat(vec![upd(4, status("in_progress")), works(n)]), &fresh, false, true);
        track(&format!("tracked-taskget-n{n}"), cat(vec![tl.get(1, true), works(n)]), &fresh, false, false);
        track(&format!("tracked-tasks-n{n}-progress-is-dir"), cat(vec![task(1, "a"), works(n)]), &World::new().git("proj").dir(&prog), false, false);
        track(
            &format!("tracked-tasks-n{n}-progress-symlink"),
            cat(vec![task(1, "a"), works(n)]),
            &World::new().git("proj").file("elsewhere.md", "x").link(&prog, "$W/elsewhere.md"),
            false,
            false,
        );
        track(
            &format!("tracked-tasks-n{n}-history-file"),
            cat(vec![task(1, "a"), works(n)]),
            &World::new().git("proj").file(&prog, "p").file(&hist, "- x\n"),
            false,
            true,
        );
        track(&format!("tracked-tasks-n{n}-history-only"), cat(vec![task(1, "a"), works(n)]), &World::new().git("proj").file(&hist, "- x\n"), false, false);
        track(
            &format!("tracked-tasks-n{n}-index-present"),
            cat(vec![task(1, "a"), works(n)]),
            &World::new().git("proj").file(&prog, "p").file("proj/.anti-hall/progress/INDEX.md", "- sess-1 already\n"),
            false,
            true,
        );
    }
    track("tracked-inprogress-one", cat(vec![task(1, "a"), upd(1, status("in_progress")), works(3)]), &fresh, false, true);
    track(
        "tracked-inprogress-two-agentscan",
        cat(vec![task(1, "a"), task(2, "b"), upd(1, status("in_progress")), upd(2, status("in_progress")), works(3)]),
        &fresh,
        false,
        false,
    );
    track(
        "tracked-inprogress-two-below-threshold",
        cat(vec![task(1, "a"), task(2, "b"), upd(1, status("in_progress")), upd(2, status("in_progress")), works(2)]),
        &fresh,
        false,
        true,
    );
    track(
        "tracked-inprogress-two-low",
        cat(vec![
            task(1, "a"),
            task(2, "b"),
            upd(1, vec![("status", J::from("in_progress")), ("priority", J::from("P2"))]),
            upd(2, vec![("status", J::from("in_progress")), ("metadata", jo! {"priority": "low"})]),
            works(3),
        ]),
        &fresh,
        false,
        true,
    );
    track(
        "tracked-inprogress-two-mixed",
        cat(vec![
            task(1, "a"),
            task(2, "b"),
            upd(1, vec![("status", J::from("in_progress")), ("priority", J::from("P2"))]),
            upd(2, vec![("status", J::from("in_progress")), ("priority", J::from("P1"))]),
            works(3),
        ]),
        &fresh,
        false,
        true,
    );
    track("tracked-completed", cat(vec![task(1, "a"), upd(1, status("completed")), works(4)]), &fresh, false, true);
    track("tracked-reset-notfound", cat(vec![task(1, "a"), tl.get(1, false), works(3)]), &fresh, false, false);
    track("tracked-restart", cat(vec![task(1, "a"), task(2, "b"), task(1, "again"), works(3)]), &fresh, false, true);
    track(
        "tracked-status-weird",
        cat(vec![
            task(1, "a"),
            {
                let tu = tl.use_("TaskUpdate", jo! {"taskId": "1", "status": 5});
                vec![tl.asst(vec![tu])]
            },
            works(3),
        ]),
        &fresh,
        false,
        false,
    );
    track(
        "tracked-activity-only-in-wide-window",
        cat(vec![
            (0..6000)
                .map(|i| {
                    let t = tl.text(&format!("filler {i} {}", "x".repeat(300)));
                    tl.asst(vec![t])
                })
                .collect(),
            works(3),
        ]),
        &fresh,
        false,
        false,
    );
    {
        let filler: Vec<String> = (0..2500)
            .map(|i| {
                let t = tl.text(&format!("filler {i} {}", "x".repeat(400)));
                tl.asst(vec![t])
            })
            .collect();
        let mut l1 = vec![tl.prompt("go")];
        l1.extend(task(1, "early"));
        l1.extend(task(2, "early2"));
        l1.extend(filler.clone());
        l1.extend(upd(1, status("in_progress")));
        l1.extend(works(3));
        let f = put(&l1, Some("wide1"));
        add("tracked-truncated-backfill", stop(tpj(&f), &[]), &fresh, silent);
        let mut l2 = vec![tl.prompt("go")];
        l2.extend(task(1, "early"));
        l2.extend(filler.clone());
        l2.extend(works(3));
        let g = put(&l2, Some("wide2"));
        add("tracked-truncated-wide-activity", stop(tpj(&g), &[]), &fresh, silent);
        let mut l3 = vec![tl.prompt("go")];
        l3.extend(filler.clone());
        l3.extend(works(3));
        let h = put(&l3, Some("wide3"));
        add("tracked-truncated-no-activity", stop(tpj(&h), &[]), &fresh, none);
        let mut l4 = vec![tl.prompt("go")];
        l4.extend(task(1, "early"));
        l4.extend(filler);
        l4.extend(upd(1, vec![("description", J::from("d"))]));
        l4.extend(works(3));
        let k = put(&l4, Some("wide4"));
        add("tracked-truncated-unknown-task", stop(tpj(&k), &[]), &fresh, silent);
    }
    // progress freshness against the work time (timestamps are in the past; the file time decides)
    track("fresh-file-newer-than-work", cat(vec![task(1, "a"), works(3)]), &fresh, false, true);
    track("fresh-file-older-than-work", cat(vec![task(1, "a"), works(3)]), &stale, true, false);
    {
        // work timestamps in the future of the file: stale
        let fut = iso_from_ms(now_ms() as i64 + 86_400_000);
        let rec = |ts: Option<&str>, prefix: &str, i: usize| {
            let mut v = jo! {"type": "assistant"};
            if let Some(t) = ts {
                v.set("timestamp", J::from(t));
            }
            v.set("message", jo! {"id": format!("{prefix}{i}"), "role": "assistant", "content": ja![tl.use_("Edit", jo! {"file_path": format!("/p/f{i}")})]});
            v.text()
        };
        let mut lines = vec![tl.prompt("go")];
        lines.extend(task(1, "a"));
        lines.extend((1..=3).map(|i| rec(Some(&fut), "m", i)));
        add("fresh-work-in-future", stop(tpj(&put(&lines, Some("fut"))), &[]), &fresh, none);
        let mut nots = vec![tl.prompt("go")];
        nots.extend(task(1, "a"));
        nots.extend((1..=3).map(|i| rec(None, "n", i)));
        add("fresh-no-work-ts-fresh-file", stop(tpj(&put(&nots, Some("nots"))), &[]), &fresh, silent);
        out.borrow_mut().push(Scenario::new("fresh-no-work-ts-stale-file", stale.clone(), vec![stale_step(stop(tpj(&put(&nots, Some("nots2"))), &[]))]));
        let mut s3 = Step::payload(stop(tpj(&put(&nots, Some("nots3"))), &[]));
        s3.before = Some(touch_at(&prog, now - 5.0));
        out.borrow_mut().push(Scenario::new(
            "fresh-ms-setting-small",
            World::new().git("proj").file(&prog, "p").file("home/.anti-hall/settings.json", "{\"guards\":{\"progressFreshMs\":1}}"),
            vec![s3],
        ));
        let mut s4 = Step::payload(stop(tpj(&put(&nots, Some("nots4"))), &[]));
        s4.before = Some(touch_at(&prog, old_secs));
        let mut sc = Scenario::new(
            "fresh-ms-setting-large",
            World::new().git("proj").file(&prog, "p").file("home/.anti-hall/settings.json", "{\"guards\":{\"progressFreshMs\":1000000000000}}"),
            vec![s4],
        );
        sc.answer_when_silent = true;
        out.borrow_mut().push(sc);
    }
    // a command or tool call that writes the progress file counts as a fresh write (FIX 6); one that only reads it does not.
    // The transcript lives in the world (its text names the world's own progress path through `$PROJ`).
    {
        let pa = format!("$PROJ/.anti-hall/progress/{today}/sess-1.md");
        let stale_world = |lines: &[String]| World::new().git("proj").file(&prog, "# progress\n").file("t.jsonl", &format!("{}\n", lines.join("\n")));
        type Tail<'a> = Box<dyn Fn() -> Vec<String> + 'a>;
        let tlr = &tl;
        let b = |cmd: String| -> Tail<'_> { Box::new(move || tlr.bash(&cmd)) };
        let cases: Vec<(&str, Tail<'_>, bool)> = vec![
            ("redirect-append", b(format!("echo done >> {pa}")), true),
            ("redirect-truncate", b(format!("echo done > {pa}")), true),
            ("redirect-dq", b(format!("echo done > \"{pa}\"")), true),
            ("redirect-sq", b(format!("echo done > '{pa}'")), true),
            ("tee", b(format!("echo done | tee {pa}")), true),
            ("tee-flag", b(format!("echo done | tee -a {pa}")), true),
            ("cp", b(format!("cp /x/a {pa}")), true),
            ("mv", b(format!("mv /x/a {pa}")), true),
            ("heredoc", b(format!("cat >> {pa} <<EOF\nx\nEOF")), true),
            ("write-tool", Box::new(|| vec![write_l(&pa)]), true),
            ("edit-tool", Box::new(|| vec![edit_n(&pa, None)]), true),
            ("read-only", b(format!("cat {pa} >> /elsewhere/log")), false),
            ("other-file", b("echo done >> /elsewhere/log".into()), false),
            ("fd-dup", b(format!("cmd 2>&1 {pa}")), false),
            ("quoted-text", b(format!("echo \"write > {pa}\"")), false),
            ("two-redirects", b(format!("echo a > /x/y; echo b > {pa}")), false),
            ("other-session", b(format!("echo done >> $PROJ/.anti-hall/progress/{today}/sess-2.md")), false),
            ("other-day", b("echo done >> $PROJ/.anti-hall/progress/2020-01-01/sess-1.md".into()), false),
        ];
        for (id, tail, answer) in cases {
            let mut lines = vec![tl.prompt("go")];
            lines.extend(task(1, "a"));
            lines.extend(works(3));
            lines.extend(tail());
            let mut sc = Scenario::new(&format!("fresh-write-{id}"), stale_world(&lines), vec![stale_step(stop(tpj("$W/t.jsonl"), &[]))]);
            sc.answer_when_silent = answer;
            out.borrow_mut().push(sc);
        }
    }
    // the grace boundary: work exactly 1000 ms newer than the file still counts as covered, 1 ms more does not
    for (id, delta_ms, covered) in [("equal", 1000i64, true), ("plus1", 1001, false), ("minus1", 999, true), ("zero", 0, true)] {
        let work_ts: i64 = 1_791_273_630_000; // Date.UTC(2026, 9, 6, 8, 0, 30, 0)
        let mk = |i: usize| {
            jo! {"type": "assistant", "timestamp": iso_from_ms(work_ts), "message": jo! {"id": format!("b{i}"), "role": "assistant", "content": ja![tl.use_("Edit", jo! {"file_path": format!("/p/b{i}")})]}}.text()
        };
        let mut lines = vec![tl.prompt("go")];
        lines.extend(task(1, "a"));
        lines.extend((1..=3).map(mk));
        let mut step = Step::payload(stop(tpj(&put(&lines, Some(&format!("bd{id}")))), &[]));
        step.before = Some(touch_at(&prog, (work_ts - delta_ms) as f64 / 1000.0));
        let mut sc = Scenario::new(&format!("fresh-boundary-{id}"), fresh.clone(), vec![step]);
        sc.answer_when_silent = covered;
        out.borrow_mut().push(sc);
    }

    // ---- cwd, root, session and payload shapes
    let tr = {
        let mut lines = vec![tl.prompt("go")];
        lines.extend(task(1, "a"));
        lines.extend(works(3));
        put(&lines, Some("shape"))
    };
    let pf = |sess: &str| format!("proj/.anti-hall/progress/{today}/{sess}.md");
    let wt_prog = format!("wt/.anti-hall/progress/{today}/sess-1.md");
    let plain_prog = format!("plain/.anti-hall/progress/{today}/sess-1.md");
    let shape_list: Vec<(&str, J, World, bool)> = vec![
        ("cwd-missing", stop(tpj(&tr), &[("cwd", None)]), fresh.clone(), true),
        ("cwd-null", stop(tpj(&tr), &[("cwd", Some(J::Null))]), fresh.clone(), true),
        ("cwd-num", stop(tpj(&tr), &[st("cwd", 5)]), fresh.clone(), true),
        ("cwd-empty", stop(tpj(&tr), &[st("cwd", "")]), fresh.clone(), true),
        ("cwd-nonexistent", stop(tpj(&tr), &[st("cwd", "$W/nowhere")]), fresh.clone(), true),
        ("cwd-file", stop(tpj(&tr), &[st("cwd", "$W/afile")]), World::new().file("afile", "x").git("proj"), true),
        ("cwd-subdir", stop(tpj(&tr), &[st("cwd", "$PROJ/src")]), World::new().git("proj").dir("proj/src").file(&prog, "p"), true),
        ("cwd-no-git", stop(tpj(&tr), &[st("cwd", "$W/plain")]), World::new().dir("plain").file(&plain_prog, "p"), true),
        ("cwd-relative", stop(tpj(&tr), &[st("cwd", "proj")]), fresh.clone(), false),
        ("cwd-trailing-slash", stop(tpj(&tr), &[st("cwd", "$PROJ/")]), fresh.clone(), true),
        ("cwd-nested-repo", stop(tpj(&tr), &[st("cwd", "$PROJ/inner")]), World::new().git("proj").git("proj/inner").file(&prog, "p"), false),
        (
            "cwd-gitfile-worktree",
            stop(tpj(&tr), &[st("cwd", "$W/wt")]),
            World::new().dir("store/wt").dir("wt").file("wt/.git", "gitdir: $W/store/wt\n").file("store/wt/commondir", "../..\n"),
            false,
        ),
        (
            "cwd-gitfile-plain",
            stop(tpj(&tr), &[st("cwd", "$W/wt")]),
            World::new().dir("store/wt").dir("wt").file("wt/.git", "gitdir: $W/store/wt\n").file(&wt_prog, "p"),
            true,
        ),
        ("cwd-home-repo", stop(tpj(&tr), &[st("cwd", "$HOME/sub")]), World::new().git("home").dir("home/sub"), false),
        ("session-missing", stop(tpj(&tr), &[("session_id", None)]), World::new().git("proj").file(&pf("unknown-session"), "p"), true),
        ("session-weird", stop(tpj(&tr), &[st("session_id", "a/b c")]), World::new().git("proj").file(&pf("abc"), "p"), true),
        ("session-number", stop(tpj(&tr), &[st("session_id", 7)]), World::new().git("proj").file(&pf("7"), "p"), true),
        ("no-transcript", stop(None, &[]), fresh.clone(), true),
        ("empty-transcript", stop(tpj(""), &[]), fresh.clone(), true),
        ("num-transcript", stop(Some(J::from(5)), &[]), fresh.clone(), true),
        ("missing-transcript", stop(tpj("$W/none.jsonl"), &[]), fresh.clone(), true),
        ("null-payload", J::Null, fresh.clone(), true),
        ("array-payload", ja![1], fresh.clone(), true),
        ("hook-active", stop(tpj(&tr), &[st("stop_hook_active", true)]), fresh.clone(), true),
        ("codex-turn", stop(tpj(&tr), &[st("turn_id", "t1"), st("model", "m")]), fresh.clone(), true),
        ("codex-path", stop(tpj("$W/.codex/sessions/rollout-1.jsonl"), &[]), fresh.clone(), true),
    ];
    for (id, p, world, ans) in shape_list {
        add(&format!("shape-{id}"), p, &world, if ans { silent } else { none });
    }
    {
        let mut lines = vec![tl.prompt("go")];
        lines.extend(cat(vec![task(1, "a"), task(2, "b"), upd(1, status("in_progress")), upd(2, status("in_progress")), works(3)]));
        let f = put(&lines, Some("cx"));
        add("shape-codex-two-inprogress", stop(tpj(&f), &[st("turn_id", "t1"), st("model", "m")]), &fresh, silent);
    }

    // ---- modes, switches, resume verification
    add("mode-plan", stop(tpj(&tr), &[st("permission_mode", "plan")]), &fresh, none);
    add("mode-plan-caps", stop(tpj(&tr), &[st("permission_mode", "PLAN")]), &fresh, none);
    let modes: Vec<(String, J)> = vec![
        ("\"default\"".into(), J::from("default")),
        ("\"acceptEdits\"".into(), J::from("acceptEdits")),
        ("\"\"".into(), J::from("")),
        ("null".into(), J::Null),
        ("5".into(), J::from(5)),
        ("[\"plan\"]".into(), ja!["plan"]),
        ("\"plan \"".into(), J::from("plan ")),
    ];
    for (id, m) in modes {
        add(&format!("mode-other-{id}"), stop(tpj(&tr), &[st("permission_mode", m)]), &fresh, silent);
    }
    add("mode-plan-no-transcript", stop(None, &[st("permission_mode", "plan")]), &fresh, none);
    let five_works = |name: &str| -> String {
        let mut l = vec![tl.prompt("go")];
        l.extend(works(5));
        put(&l, Some(name))
    };
    add(
        "switch-off",
        stop(tpj(&five_works("sw1")), &[]),
        &World::new().git("proj").file("home/.anti-hall/settings.json", "{\"guards\":{\"tasklistGuard\":false}}"),
        none,
    );
    out.borrow_mut().push(Scenario::new(
        "switch-option-off",
        repo.clone(),
        vec![Step::payload(stop(tpj(&five_works("sw2")), &[])).env("CLAUDE_PLUGIN_OPTION_GUARDS_TASKLIST_GUARD", "false")],
    ));
    out.borrow_mut().push(Scenario::new("judge-child", repo.clone(), vec![Step::payload(stop(tpj(&five_works("sw3")), &[])).env("ANTIHALL_JUDGE_CHILD", "1")]));
    let nowi = now_ms() as i64;
    add(
        "skip",
        stop(tpj(&five_works("sw4")), &[]),
        &World::new().git("proj").file("home/.anti-hall/skip.json", &format!("{{\"tasklist-guard\":{}}}", nowi + 3_600_000)),
        none,
    );
    add(
        "skip-all",
        stop(tpj(&five_works("sw5")), &[]),
        &World::new().git("proj").file("home/.anti-hall/skip.json", &format!("{{\"all\":{}}}", nowi + 3_600_000)),
        none,
    );
    for (id, v) in [("2", "2"), ("5", "5"), ("str", "\" 4 \""), ("zero", "0"), ("garbage", "\"x\""), ("frac", "3.5"), ("huge", "1000000000")] {
        let mut l = vec![tl.prompt("go")];
        l.extend(works(4));
        let f = put(&l, Some(&format!("th{id}")));
        add(
            &format!("threshold-{id}"),
            stop(tpj(&f), &[]),
            &World::new().git("proj").file("home/.anti-hall/settings.json", &format!("{{\"guards\":{{\"tasklistWorkThreshold\":{v}}}}}")),
            if id != "2" && id != "zero" && id != "garbage" { silent } else { none },
        );
    }
    {
        let mut l = vec![tl.prompt("go")];
        l.extend(works(4));
        let f = put(&l, Some("the"));
        let mut sc = Scenario::new("threshold-env", repo.clone(), vec![Step::payload(stop(tpj(&f), &[])).env("ANTIHALL_TASKLIST_WORK_THRESHOLD", "9")]);
        sc.answer_when_silent = true;
        out.borrow_mut().push(sc);
    }
    // resume verification
    let marker = |f: &str| format!("{{\"handoverFile\":{}}}", J::from(f).text());
    let resume_world = |hbody: &str, extra: &[(&str, &str)]| {
        let mut wd =
            World::new().git("proj").file("ho/HANDOVER.md", hbody).file("home/.anti-hall/handover-resume-state-sess-1.json", &marker("$W/ho/HANDOVER.md"));
        for (k, v) in extra {
            wd = wd.file(k, v);
        }
        wd
    };
    let trw = {
        let mut l = vec![tl.prompt("go")];
        l.extend(works(3));
        put(&l, Some("resume"))
    };
    let state_f = "home/.anti-hall/handover-resume-state-sess-1.json";
    add("resume-nudge", stop(tpj(&trw), &[]), &resume_world("# h\n", &[]), none);
    add("resume-verified", stop(tpj(&trw), &[]), &resume_world("# h\nresume-verified: 2026 -- ok\n", &[]), silent);
    add("resume-already-nudged", stop(tpj(&trw), &[]), &resume_world("# h\n", &[("home/.anti-hall/resume-verify-nudged-sess-1.json", "{}")]), none);
    {
        let mut l = vec![tl.prompt("go")];
        l.extend(works(2));
        let f = put(&l, Some("resume2"));
        add("resume-below-threshold", stop(tpj(&f), &[]), &resume_world("# h\n", &[]), silent);
    }
    add("resume-missing-handover", stop(tpj(&trw), &[]), &World::new().git("proj").file(state_f, &marker("$W/ho/none.md")), none);
    add(
        "resume-relative-handover",
        stop(tpj(&trw), &[]),
        &World::new().git("proj").file(state_f, &marker("ho/HANDOVER.md")).file("ho/HANDOVER.md", "# h\n"),
        none,
    );
    add("resume-bad-marker", stop(tpj(&trw), &[]), &World::new().git("proj").file(state_f, "{nope"), none);
    add("resume-marker-no-file", stop(tpj(&trw), &[]), &World::new().git("proj").file(state_f, "{}"), none);
    add("resume-marker-empty-file", stop(tpj(&trw), &[]), &World::new().git("proj").file(state_f, &marker("")), none);
    add("resume-marker-file-number", stop(tpj(&trw), &[]), &World::new().git("proj").file(state_f, "{\"handoverFile\":5}"), none);
    add(
        "resume-path-quotes",
        stop(tpj(&trw), &[]),
        &World::new().git("proj").file("ho/a \"q\" \\ b.md", "# h\n").file(state_f, &marker("$W/ho/a \"q\" \\ b.md")),
        none,
    );
    add(
        "resume-path-unicode",
        stop(tpj(&trw), &[]),
        &World::new().git("proj").file("ho/\u{e9}\u{65e5}\u{672c} \u{1f600}.md", "# h\n").file(state_f, &marker("$W/ho/\u{e9}\u{65e5}\u{672c} \u{1f600}.md")),
        none,
    );
    add("resume-path-newline", stop(tpj(&trw), &[]), &World::new().git("proj").file("ho/a\nb.md", "# h\n").file(state_f, &marker("$W/ho/a\nb.md")), none);
    add(
        "resume-path-long",
        stop(tpj(&trw), &[]),
        &World::new().git("proj").file(&format!("ho/{}.md", "x".repeat(200)), "# h\n").file(state_f, &marker(&format!("$W/ho/{}.md", "x".repeat(200)))),
        none,
    );
    add("resume-nudged-is-dir", stop(tpj(&trw), &[]), &resume_world("# h\n", &[]), none);
    out.borrow_mut().push(Scenario::new(
        "resume-twice",
        resume_world("# h\n", &[]),
        vec![Step::payload(stop(tpj(&trw), &[])), Step::payload(stop(tpj(&trw), &[])), Step::payload(stop(tpj(&trw), &[]))],
    ));

    // ---- sequences: index idempotence across Stops
    {
        let mk = |n: usize| {
            let mut v = cat(vec![task(1, "a"), works(n)]);
            let f = w3(std::mem::take(&mut v));
            stop(tpj(&f), &[])
        };
        let (a, b, c2) = (mk(3), mk(3), mk(2));
        let mut sc = Scenario::new("seq-index-idempotent", fresh.clone(), vec![Step::payload(a), Step::payload(b), Step::payload(c2)]);
        sc.answer_when_silent = true;
        out.borrow_mut().push(sc);
        let f1 = w3(cat(vec![task(1, "a"), works(3)]));
        let f2 = w3(cat(vec![task(1, "a"), works(3)]));
        let mut sc = Scenario::new(
            "seq-two-sessions",
            World::new().git("proj").file(&prog, "p").file(&format!("proj/.anti-hall/progress/{today}/sess-2.md"), "p"),
            vec![Step::payload(stop(tpj(&f1), &[])), Step::payload(stop(tpj(&f2), &[st("session_id", "sess-2")]))],
        );
        sc.answer_when_silent = true;
        out.borrow_mut().push(sc);
    }

    // ---- real transcripts (local data)
    for f in real_files("\"name\":\"Edit\"", 20e3, 450e3, real_limit().min(120), 21) {
        let base = Path::new(&f).file_stem().map_or(String::new(), |s| s.to_string_lossy().to_string());
        add(&format!("real-fresh-{}", clip(&base, 8)), stop(tpj(&f), &[]), &fresh, silent);
        add(&format!("real-nofile-{}", clip(&base, 8)), stop(tpj(&f), &[]), &repo, none);
    }
    for f in real_files("\"name\":\"TaskCreate\"", 600e3, 60e6, 30, 23) {
        let base = Path::new(&f).file_stem().map_or(String::new(), |s| s.to_string_lossy().to_string());
        add(&format!("real-big-fresh-{}", clip(&base, 8)), stop(tpj(&f), &[]), &fresh, silent);
        add(&format!("real-big-nofile-{}", clip(&base, 8)), stop(tpj(&f), &[]), &repo, none);
    }
    (out.into_inner(), shared)
}

pub(crate) fn opts() -> Opts {
    Opts::new("tasklist-guard", "tasklist-guard.js", "tasklist-guard")
}
