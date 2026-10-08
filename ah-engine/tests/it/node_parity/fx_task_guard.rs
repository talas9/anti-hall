//! Parity of the built-in `task-guard` check against `hooks/task-guard.js` (Stop). The engine answers the Stops where no task is
//! open (state file removed, pruning advisory, unknown-state note) and defers every other Stop. Compared: exit code, stdout,
//! stderr and the whole file tree. A deferral is never a mismatch, but the scenarios that must be answered (no open task) are
//! listed as `must_answer`, so an engine that defers everything fails. Real transcripts (`AH_PARITY_REAL_TRANSCRIPTS`, local data,
//! optional) extend the corpus.

use super::fx::*;
use super::fx_tasklines::*;
use super::jsjson::J;
use super::support::*;
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Copy, Default)]
struct Flags {
    must: bool,
    silent: bool,
    no_block: bool,
}

fn stop(tp: Option<J>, extra: &[(&str, Option<J>)]) -> J {
    let mut p = jo! {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": "$PROJ", "stop_hook_active": false};
    // key order: transcript_path sits before stop_hook_active
    p = match tp {
        Some(t) => jo! {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": "$PROJ", "transcript_path": t, "stop_hook_active": false},
        None => p,
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

fn j2(tl: &Tl, m: &str, blocks: Vec<J>) -> String {
    jo! {"type": "assistant", "timestamp": tl.ts(3), "message": jo! {"id": m, "role": "assistant", "content": blocks}}.text()
}

/// Set a file's modification time in a world (a step's `before`) to the instant `secs`, read once when the corpus was built.
fn touch(rel: &str, secs: f64) -> Before {
    let rel = rel.to_string();
    Arc::new(move |w: &Path| set_mtime(&w.join(&rel), secs))
}

pub(crate) fn corpus() -> (Vec<Scenario>, Scratch, BTreeSet<String>) {
    let mut r = Rng::new(1);
    let tl = Tl::new();
    let shared = Scratch::new("tg-shared");
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
    let out: RefCell<Vec<Scenario>> = RefCell::new(Vec::new());
    let must: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
    let add = |id: &str, payload: J, world: &World, f: Flags| {
        let mut sc = Scenario::one(id, payload, world);
        sc.answer_when_silent = f.silent;
        sc.answer_when_no_block = f.no_block;
        if f.must {
            must.borrow_mut().insert(id.to_string());
        }
        out.borrow_mut().push(sc);
    };
    let w = World::new().git("proj");
    let c = |n: i64, s: &str, extra: Vec<(&str, J)>| {
        let mut input = jo! {"subject": s};
        for (k, v) in extra {
            input.set(k, v);
        }
        tl.create(n, input)
    };
    let u = |n: i64, extra: Vec<(&str, J)>| tl.update(n, extra);
    let status = |s: &str| vec![("status", J::from(s))];

    // ---- hand-written task histories
    let mut h: Vec<(&str, Option<Vec<String>>)> = vec![("empty", Some(vec![tl.prompt("hello")]))];
    h.push(("oneOpen", Some(c(1, "open one", vec![]))));
    h.push(("oneDone", Some(cat(vec![c(1, "done one", vec![]), u(1, status("completed"))]))));
    h.push(("inProgress", Some(cat(vec![c(1, "wip", vec![]), u(1, status("in_progress"))]))));
    h.push(("inProgressHyphen", Some(cat(vec![c(1, "wip", vec![]), u(1, status("in-progress"))]))));
    h.push(("upperStatus", Some(cat(vec![c(1, "x", vec![]), u(1, status("PENDING"))]))));
    h.push(("cancelled", Some(cat(vec![c(1, "x", vec![]), u(1, status("cancelled"))]))));
    h.push(("canceled", Some(cat(vec![c(1, "x", vec![]), u(1, status("Canceled"))]))));
    h.push(("deleted", Some(cat(vec![c(1, "x", vec![]), u(1, status("deleted"))]))));
    h.push(("doneThenReopen", Some(cat(vec![c(1, "x", vec![]), u(1, status("completed")), u(1, status("pending"))]))));
    h.push(("twoOneOpen", Some(cat(vec![c(1, "a", vec![]), c(2, "b", vec![]), u(1, status("completed"))]))));
    h.push(("twoDone", Some(cat(vec![c(1, "a", vec![]), c(2, "b", vec![]), u(1, status("completed")), u(2, status("done"))]))));
    h.push(("updateOnly", Some(u(5, status("completed")))));
    h.push(("updateOnlyOpen", Some(u(5, status("in_progress")))));
    h.push(("updateNoStatus", Some(u(5, vec![("description", J::from("only text"))]))));
    h.push(("updateOwnerOnly", Some(u(5, vec![("owner", J::from("agent-1"))]))));
    h.push(("updateThenCreate", Some(cat(vec![u(1, vec![("description", J::from("d"))]), c(1, "created later", vec![])]))));
    h.push(("restartNumbering", Some(cat(vec![c(1, "old", vec![]), c(2, "old2", vec![]), c(1, "new after restart", vec![])]))));
    h.push(("restartCompletedByCreate", Some(cat(vec![c(1, "old", vec![]), tl.create(1, jo! {"subject": "new", "status": "completed"})]))));
    h.push(("restartDone", Some(cat(vec![c(1, "old", vec![]), c(1, "new", vec![]), u(1, status("completed"))]))));
    h.push(("listEmpty", Some(cat(vec![c(1, "x", vec![]), tl.list(true)]))));
    h.push(("listNotEmpty", Some(cat(vec![c(1, "x", vec![]), tl.list(false)]))));
    h.push(("getNotFound", Some(cat(vec![c(1, "x", vec![]), tl.get(1, false)]))));
    h.push(("getNotFoundOther", Some(cat(vec![c(1, "x", vec![]), tl.get(9, false)]))));
    h.push(("getFound", Some(cat(vec![c(1, "x", vec![]), tl.get(1, true)]))));
    let td = |content: &str, status: &str| jo! {"content": content, "status": status};
    h.push(("todoOpen", Some(tl.todo(ja![td("a", "pending"), td("b", "completed")]))));
    h.push(("todoDone", Some(tl.todo(ja![td("a", "completed")]))));
    h.push(("todoThenCreate", Some(cat(vec![tl.todo(ja![td("a", "pending")]), c(1, "x", vec![]), u(1, status("completed"))]))));
    h.push((
        "todoIds",
        Some(tl.todo(ja![jo! {"id": "t1", "content": "a", "status": "completed"}, jo! {"id": 7, "content": "b", "status": "completed"}, jo! {"content": "c"}])),
    ));
    h.push(("todoBadElem", Some(tl.todo(ja![J::Null]))));
    h.push(("todoStringElem", Some(tl.todo(ja!["x"]))));
    h.push((
        "todoNotArray",
        Some({
            let tu = tl.use_("TodoWrite", jo! {"todos": "x"});
            vec![tl.asst(vec![tu])]
        }),
    ));
    h.push(("todoEmpty", Some(tl.todo(ja![]))));
    h.push((
        "addBlockedBy",
        Some(cat(vec![
            c(1, "a", vec![]),
            c(2, "b", vec![]),
            u(2, vec![("addBlockedBy", ja!["1"]), ("status", J::from("completed"))]),
            u(1, status("completed")),
        ])),
    ));
    h.push(("blockedOn", Some(cat(vec![c(1, "x", vec![("metadata", jo! {"blockedOn": "owner"})]), u(1, status("completed"))]))));
    h.push((
        "parallelCreates",
        Some({
            let a = tl.use_("TaskCreate", jo! {"subject": "p1"});
            let b = tl.use_("TaskCreate", jo! {"subject": "p2"});
            let m = tl.mid();
            let (ida, idb) = (id_of(&a), id_of(&b));
            let first = j2(&tl, &m, vec![a, b]);
            let res = tl.user(ja![tl.res(&idb, "Task #1 created successfully: p2"), tl.res(&ida, "Task #2 created successfully: p1")]);
            cat(vec![vec![first, res], u(1, status("completed")), u(2, status("completed"))])
        }),
    ));
    h.push(("sidechain", Some(vec![jo! {"type": "assistant", "isSidechain": true, "message": jo! {"id": "m", "role": "assistant", "content": ja![tl.use_("TaskCreate", jo! {"subject": "side"})]}}.text()])));
    h.push(("nullLine", Some(cat(vec![c(1, "a", vec![]), vec!["null".into()], u(1, status("completed"))]))));
    h.push(("numberLine", Some(cat(vec![c(1, "a", vec![]), vec!["5".into(), "\"str\"".into(), "true".into(), "[1,2]".into()], u(1, status("completed"))]))));
    h.push((
        "brokenLine",
        Some(cat(vec![c(1, "a", vec![]), vec!["{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\"".into()], u(1, status("completed"))])),
    ));
    h.push(("blankLines", Some(cat(vec![vec![String::new(), "   ".into()], c(1, "a", vec![]), vec![String::new()], u(1, status("completed"))]))));
    h.push(("crlf", None));
    let upd_raw = |extra: J| -> Vec<String> {
        let tu = tl.use_("TaskUpdate", extra);
        vec![tl.asst(vec![tu])]
    };
    h.push(("statusNumber", Some(cat(vec![c(1, "a", vec![]), upd_raw(jo! {"taskId": "1", "status": 5})]))));
    h.push(("statusObject", Some(upd_raw(jo! {"taskId": "1", "status": jo! {"a": 1}}))));
    h.push(("statusEmptyString", Some(cat(vec![c(1, "a", vec![]), u(1, status(""))]))));
    h.push(("statusNull", Some(cat(vec![c(1, "a", vec![]), u(1, vec![("status", J::Null)])]))));
    h.push(("taskIdNumber", Some(cat(vec![c(1, "a", vec![]), upd_raw(jo! {"taskId": 1, "status": "completed"})]))));
    h.push((
        "taskIdAlt",
        Some(cat(vec![c(1, "a", vec![]), upd_raw(jo! {"id": "1", "status": "completed"}), upd_raw(jo! {"task_id": "1", "status": "completed"})])),
    ));
    h.push(("taskIdObject", Some(upd_raw(jo! {"taskId": jo! {"x": 1}, "status": "completed"}))));
    h.push(("taskIdNull", Some(upd_raw(jo! {"taskId": J::Null, "status": "completed"}))));
    h.push(("inputString", Some(vec![tl.asst(vec![jo! {"type": "tool_use", "id": "tu_s", "name": "TaskUpdate", "input": "x"}])])));
    h.push(("inputMissing", Some(vec![tl.asst(vec![jo! {"type": "tool_use", "id": "tu_m", "name": "TaskCreate"}])])));
    h.push(("createNoId", Some(vec![tl.asst(vec![jo! {"type": "tool_use", "name": "TaskCreate", "input": jo! {"subject": "x"}}])])));
    h.push(("createNumId", Some(vec![tl.asst(vec![jo! {"type": "tool_use", "id": 5, "name": "TaskCreate", "input": jo! {"subject": "x"}}])])));
    h.push((
        "createSubjectVariants",
        Some({
            let a = tl.use_("TaskCreate", jo! {"title": "t"});
            let la = tl.asst(vec![a]);
            let b = tl.use_("TaskCreate", jo! {"content": "c"});
            let lb = tl.asst(vec![b]);
            let cc = tl.use_("TaskCreate", jo! {"description": "d"});
            let lc = tl.asst(vec![cc]);
            let d = tl.use_("TaskCreate", jo! {});
            let ld = tl.asst(vec![d]);
            vec![la, lb, lc, ld]
        }),
    ));
    h.push((
        "createSubjectObject",
        Some({
            let tu = tl.use_("TaskCreate", jo! {"subject": jo! {"a": 1}});
            vec![tl.asst(vec![tu])]
        }),
    ));
    h.push(("createStatus", Some(tl.create(1, jo! {"subject": "x", "status": "completed"}))));
    h.push(("createStatusWeird", Some(tl.create(1, jo! {"subject": "x", "status": 7}))));
    h.push(("nested", Some(vec![jo! {"type": "assistant", "message": jo! {"content": ja![jo! {"type": "tool_use", "id": "n1", "name": "TaskCreate", "input": jo! {"subject": "nested"}}]}, "messages": ja![jo! {"content": ja![tl.use_("TaskUpdate", jo! {"taskId": "9", "status": "completed"})]}]}.text()])));
    h.push((
        "toolUsesKey",
        Some(vec![
            jo! {"tool_uses": ja![tl.use_("TaskCreate", jo! {"subject": "tu"})]}.text(),
            jo! {"parts": ja![tl.use_("TaskUpdate", jo! {"taskId": "3", "status": "completed"})]}.text(),
        ]),
    ));
    h.push(("resultOnly", Some(vec![tl.user(ja![tl.res("toolu_x", "Task #3 created successfully: x")])])));
    let one_create_then = |result: J, tail: Vec<String>| -> Vec<String> {
        let tu = tl.use_("TaskCreate", jo! {"subject": "x"});
        let id = id_of(&tu);
        let l1 = tl.asst(vec![tu]);
        let l2 = tl.user(ja![tl.res(&id, result)]);
        let mut v = vec![l1, l2];
        v.extend(tail);
        v
    };
    h.push(("resultNotString", Some(one_create_then(ja![jo! {"type": "text", "text": "Task #1 created successfully: x"}], vec![]))));
    h.push((
        "resultCaps",
        Some({
            let tu = tl.use_("TaskCreate", jo! {"subject": "x"});
            let id = id_of(&tu);
            let l1 = tl.asst(vec![tu]);
            let l2 = tl.user(ja![tl.res(&id, "TASK  #1   CREATED   SUCCESSFULLY")]);
            let mut v = vec![l1, l2];
            v.extend(u(1, status("completed")));
            v
        }),
    ));
    h.push((
        "resultLeadingZero",
        Some({
            let tu = tl.use_("TaskCreate", jo! {"subject": "x"});
            let id = id_of(&tu);
            let l1 = tl.asst(vec![tu]);
            let l2 = tl.user(ja![tl.res(&id, "Task #007 created successfully")]);
            let mut v = vec![l1, l2];
            v.extend(u(7, status("completed")));
            v
        }),
    ));
    h.push(("unicode", Some(cat(vec![c(1, "caf\u{e9} \u{65e5}\u{672c}\u{8a9e} \u{1f600}", vec![]), u(1, status("completed"))]))));
    let many = |count: i64, label: &str, st: &dyn Fn(i64) -> &'static str| -> Vec<String> {
        let mut v = Vec::new();
        for i in 0..count {
            v.extend(c(i + 1, &format!("{label}{i}"), vec![]));
            v.extend(u(i + 1, status(st(i))));
        }
        v
    };
    h.push(("manyDone", Some(many(14, "d", &|_| "completed"))));
    h.push(("tenDone", Some(many(10, "d", &|_| "completed"))));
    h.push(("elevenDone", Some(many(11, "d", &|i| if i % 2 != 0 { "cancelled" } else { "done" }))));
    let many_done = h.iter().find(|(k, _)| *k == "manyDone").and_then(|(_, v)| v.clone()).expect("manyDone");
    h.push(("manyDoneOneOpen", Some(cat(vec![many_done, c(15, "still open", vec![])]))));
    h.push(("manyDeleted", Some(many(14, "d", &|_| "deleted"))));
    h.push(("unknownMany", Some((0..4).flat_map(|i| u(i + 20, vec![("description", J::from("x"))])).collect())));

    let mut tps: Vec<(String, String)> = Vec::new();
    for (k, lines) in &h {
        if let Some(l) = lines {
            tps.push((k.to_string(), put(l, Some(*k))));
        }
    }
    let tp = |tps: &[(String, String)], k: &str| -> String {
        tps.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_else(|| panic!("no transcript {k}"))
    };
    let done_lines = || cat(vec![c(1, "a", vec![]), u(1, status("completed"))]);
    {
        let f = shared.path().join("crlf.jsonl");
        write_file(&f, format!("{}\r\n", done_lines().join("\r\n")).as_bytes());
        tps.push(("crlf".into(), f.to_string_lossy().to_string()));
        let f = shared.path().join("nonl.jsonl");
        write_file(&f, done_lines().join("\n").as_bytes());
        tps.push(("noTrailingNewline".into(), f.to_string_lossy().to_string()));
        let f = shared.path().join("empty0.jsonl");
        write_file(&f, b"");
        tps.push(("empty0".into(), f.to_string_lossy().to_string()));
        tps.push(("dir".into(), shared.path().to_string_lossy().to_string()));
        tps.push(("missing".into(), shared.path().join("missing.jsonl").to_string_lossy().to_string()));
        let f = shared.path().join("badutf8.jsonl");
        let mut bytes = format!("{}\n", c(1, "a", vec![]).join("\n")).into_bytes();
        bytes.extend([0xff, 0xfe, 0x0a]);
        bytes.extend(format!("{}\n", u(1, status("completed")).join("\n")).into_bytes());
        write_file(&f, &bytes);
        tps.push(("invalidUtf8".into(), f.to_string_lossy().to_string()));
        let f = shared.path().join("bom.jsonl");
        write_file(&f, format!("\u{feff}{}\n", done_lines().join("\n")).as_bytes());
        tps.push(("bom".into(), f.to_string_lossy().to_string()));
    }
    let must_hand = [
        "empty",
        "oneDone",
        "twoDone",
        "updateOnly",
        "todoDone",
        "listEmpty",
        "cancelled",
        "deleted",
        "manyDone",
        "tenDone",
        "elevenDone",
        "unknownMany",
        "empty0",
        "missing",
        "dir",
        "crlf",
        "noTrailingNewline",
    ];
    for (k, p) in &tps {
        add(&format!("hand-{k}"), stop(tpj(p), &[]), &w, Flags { must: must_hand.contains(&k.as_str()), ..Flags::default() });
    }

    // ---- payload shapes against one history
    let d = tp(&tps, "oneDone");
    let must_shape = [
        "no-transcript",
        "empty-transcript",
        "number-transcript",
        "no-session",
        "session-number",
        "session-unicode",
        "session-empty",
        "session-long",
        "hook-active",
        "agent",
        "extra",
    ];
    let shapes: Vec<(&str, J)> = vec![
        ("no-transcript", stop(None, &[])),
        ("empty-transcript", stop(tpj(""), &[])),
        ("number-transcript", stop(Some(J::from(5)), &[])),
        ("null-payload", J::Null),
        ("array-payload", ja![1]),
        ("no-session", stop(tpj(&d), &[("session_id", None)])),
        ("session-number", stop(tpj(&d), &[st("session_id", 7)])),
        ("session-object", stop(tpj(&d), &[st("session_id", jo! {"a": 1})])),
        ("session-unicode", stop(tpj(&d), &[st("session_id", "s\u{e9}/ss \u{1f600}")])),
        ("session-empty", stop(tpj(&d), &[st("session_id", "")])),
        ("session-long", stop(tpj(&d), &[st("session_id", "x".repeat(300))])),
        ("hook-active", stop(tpj(&d), &[st("stop_hook_active", true)])),
        ("agent", stop(tpj(&d), &[st("agent_id", "a1")])),
        ("extra", stop(tpj(&d), &[st("foo", ja![1, 2])])),
        ("relative-transcript", stop(tpj("t.jsonl"), &[])),
        ("tilde", stop(tpj("~/x.jsonl"), &[])),
    ];
    for (id, p) in shapes {
        add(&format!("shape-{id}"), p, &w, Flags { must: must_shape.contains(&id), ..Flags::default() });
    }

    // ---- switches, skip, judge child, state files
    let one_open = tp(&tps, "oneOpen");
    let one_done = tp(&tps, "oneDone");
    let off = World::new().git("proj").file("home/.anti-hall/settings.json", "{\"guards\":{\"taskGuard\":false}}");
    let flag0 = Flags::default();
    add("switch-off", stop(tpj(&one_open), &[]), &off, flag0);
    add("switch-off-string", stop(tpj(&one_open), &[]), &World::new().file("home/.anti-hall/settings.json", "{\"guards\":{\"taskGuard\":\"off\"}}"), flag0);
    out.borrow_mut().push(Scenario::new(
        "switch-option-off",
        w.clone(),
        vec![Step::payload(stop(tpj(&one_open), &[])).env("CLAUDE_PLUGIN_OPTION_GUARDS_TASK_GUARD", "false")],
    ));
    out.borrow_mut().push(Scenario::new("judge-child", w.clone(), vec![Step::payload(stop(tpj(&one_open), &[])).env("ANTIHALL_JUDGE_CHILD", "1")]));
    let now = now_ms() as i64;
    add("skip-guard", stop(tpj(&one_open), &[]), &World::new().file("home/.anti-hall/skip.json", &format!("{{\"task-guard\":{}}}", now + 3600000)), flag0);
    add("skip-all", stop(tpj(&one_open), &[]), &World::new().file("home/.anti-hall/skip.json", &format!("{{\"all\":{}}}", now + 3600000)), flag0);
    add("skip-expired", stop(tpj(&one_open), &[]), &World::new().file("home/.anti-hall/skip.json", &format!("{{\"task-guard\":{}}}", now - 1000)), flag0);
    let state_json = "{\"hash\":\"abc\",\"blocks\":2}";
    let must1 = Flags { must: true, ..Flags::default() };
    add("state-file-removed", stop(tpj(&one_done), &[]), &World::new().file("home/.anti-hall/last-stop-taskset-sess-1", state_json), must1);
    add("state-file-kept-when-open", stop(tpj(&one_open), &[]), &World::new().file("home/.anti-hall/last-stop-taskset-sess-1", state_json), flag0);
    add("state-file-other-session", stop(tpj(&one_done), &[]), &World::new().file("home/.anti-hall/last-stop-taskset-other", "x"), must1);
    add(
        "state-file-weird-session-key",
        stop(tpj(&one_done), &[st("session_id", "a/b c")]),
        &World::new().file("home/.anti-hall/last-stop-taskset-a_b_c", "x"),
        must1,
    );
    add("state-file-is-dir", stop(tpj(&one_done), &[]), &World::new().dir("home/.anti-hall/last-stop-taskset-sess-1"), must1);
    add("state-dir-missing-home", stop(tpj(&one_done), &[]), &World::new(), must1);
    // pruning advisory thresholds and settings
    let limits: Vec<(&str, String, &str)> = vec![
        ("limit-3", "3".into(), "manyDone"),
        ("limit-string", "\" 5 \"".into(), "manyDone"),
        ("limit-hex", "\"0x5\"".into(), "manyDone"),
        ("limit-zero", "0".into(), "manyDone"),
        ("limit-neg", "-4".into(), "manyDone"),
        ("limit-frac", "2.5".into(), "manyDone"),
        ("limit-garbage", "\"abc\"".into(), "manyDone"),
        ("limit-bool", "true".into(), "manyDone"),
        ("limit-null", "null".into(), "manyDone"),
        ("limit-big", "1000000000".into(), "manyDone"),
        ("limit-1", "1".into(), "tenDone"),
        ("limit-empty", "\"\"".into(), "elevenDone"),
        ("limit-exp", "\"1e1\"".into(), "elevenDone"),
    ];
    for (id, v, key) in limits {
        add(
            &format!("prune-{id}"),
            stop(tpj(&tp(&tps, key)), &[]),
            &World::new().git("proj").file("home/.anti-hall/settings.json", &format!("{{\"guards\":{{\"pruneCompletedTasksAfter\":{v}}}}}")),
            flag0,
        );
    }
    let many_done_tp = tp(&tps, "manyDone");
    out.borrow_mut().push(Scenario::new(
        "prune-env-3",
        w.clone(),
        vec![Step::payload(stop(tpj(&many_done_tp), &[])).env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", "3")],
    ));
    out.borrow_mut().push(Scenario::new(
        "prune-env-garbage",
        w.clone(),
        vec![Step::payload(stop(tpj(&many_done_tp), &[])).env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", "zzz")],
    ));
    // unknown-state note: set-change throttle and the per-session maximum, over a sequence of Stops
    let unknown = tp(&tps, "unknownMany");
    let seq = |id: &str, steps: Vec<J>, world: &World| out.borrow_mut().push(Scenario::new(id, world.clone(), steps.into_iter().map(Step::payload).collect()));
    seq("unknown-note-repeat", vec![stop(tpj(&unknown), &[]), stop(tpj(&unknown), &[]), stop(tpj(&unknown), &[])], &w);
    seq(
        "unknown-note-changes",
        vec![
            stop(tpj(&unknown), &[]),
            stop(tpj(&tp(&tps, "updateOnly")), &[]),
            stop(tpj(&unknown), &[]),
            stop(tpj(&tp(&tps, "updateOnlyOpen")), &[]),
            stop(tpj(&tp(&tps, "updateNoStatus")), &[]),
        ],
        &w,
    );
    seq(
        "unknown-note-two-sessions",
        vec![stop(tpj(&unknown), &[st("session_id", "a")]), stop(tpj(&unknown), &[st("session_id", "b")]), stop(tpj(&unknown), &[st("session_id", "a")])],
        &w,
    );
    let lug = "home/.anti-hall/last-unknown-guard-sess-1.json";
    seq("unknown-note-corrupt-state", vec![stop(tpj(&unknown), &[])], &World::new().file(lug, "{nope"));
    seq("unknown-note-state-n-string", vec![stop(tpj(&unknown), &[])], &World::new().file(lug, "{\"hash\":\"x\",\"n\":\"2\"}"));
    seq("unknown-note-state-max", vec![stop(tpj(&unknown), &[])], &World::new().file(lug, "{\"hash\":\"x\",\"n\":3}"));
    seq("unknown-note-state-array", vec![stop(tpj(&unknown), &[])], &World::new().file(lug, "[1,2]"));
    seq("unknown-note-state-object-n", vec![stop(tpj(&unknown), &[])], &World::new().file(lug, "{\"hash\":\"x\",\"n\":{\"a\":1}}"));
    seq("unknown-note-state-dir", vec![stop(tpj(&unknown), &[])], &World::new().dir(lug));
    seq("unknown-note-ro-home", vec![stop(tpj(&unknown), &[])], &World::new().file("home/.anti-hall/keep", "x").mode("home/.anti-hall", "555"));
    // state-prune sweep: an old state file goes, a fresh one and a different prefix stay; the stamp throttles the next sweep
    let old_days = 20.0;
    let sweep_world = World::new()
        .file("home/.anti-hall/last-unknown-guard-old.json", "{}")
        .file("home/.anti-hall/last-unknown-guard-new.json", "{}")
        .file("home/.anti-hall/last-unknown-tracker-old.json", "{}")
        .file("home/.anti-hall/other-old.json", "{}");
    {
        let old_secs = now_ms() as f64 / 1000.0 - old_days * 86400.0;
        let before: Before = Arc::new(move |w2: &Path| {
            for f in ["last-unknown-guard-old.json", "last-unknown-tracker-old.json", "other-old.json"] {
                set_mtime(&w2.join("home/.anti-hall").join(f), old_secs);
            }
        });
        let mut s1 = Step::payload(stop(tpj(&unknown), &[st("session_id", "s1")]));
        s1.before = Some(before);
        out.borrow_mut().push(Scenario::new("prune-sweep", sweep_world, vec![s1, Step::payload(stop(tpj(&unknown), &[st("session_id", "s2")]))]));
    }
    let stamp_world =
        |stamp: String| World::new().file("home/.anti-hall/.prune-stamp-last-unknown.json", &stamp).file("home/.anti-hall/last-unknown-guard-old.json", "{}");
    let old_secs_const = now_ms() as f64 / 1000.0 - old_days * 86400.0;
    let old_step = |p: J| {
        let mut s = Step::payload(p);
        s.before = Some(touch("home/.anti-hall/last-unknown-guard-old.json", old_secs_const));
        s
    };
    out.borrow_mut().push(Scenario::new(
        "prune-stamp-recent",
        stamp_world(format!("{{\"lastSweep\":{}}}", now - 1000)),
        vec![old_step(stop(tpj(&unknown), &[]))],
    ));
    out.borrow_mut().push(Scenario::new(
        "prune-stamp-future",
        stamp_world(format!("{{\"lastSweep\":{}}}", now + 1_000_000_000)),
        vec![old_step(stop(tpj(&unknown), &[]))],
    ));
    out.borrow_mut().push(Scenario::new("prune-stamp-garbage", stamp_world("xx".into()), vec![old_step(stop(tpj(&unknown), &[]))]));

    // ---- truncated transcripts: the window holds only part of the history and the backfill reads before it
    let filler: Vec<String> = (0..4200)
        .map(|i| {
            let t = tl.text(&format!("filler {i} {}", "x".repeat(380)));
            tl.asst(vec![t])
        })
        .collect();
    let nb = Flags { no_block: true, ..Flags::default() };
    let big = |id: &str, before: Vec<String>, inside: Vec<String>| {
        let mut lines = vec![tl.prompt("go")];
        lines.extend(before);
        lines.extend(filler.clone());
        lines.extend(inside);
        let f = put(&lines, Some(&format!("big-{id}")));
        add(&format!("big-{id}"), stop(tpj(&f), &[]), &w, nb);
    };
    let desc = |n: i64, d: &str| u(n, vec![("description", J::from(d))]);
    let cc = |n: i64, s: &str| c(n, s, vec![]);
    big("open-before-desc-inside", cc(1, "early"), desc(1, "later text"));
    big("closed-before-desc-inside", cat(vec![cc(1, "early"), u(1, status("completed"))]), desc(1, "later text"));
    big("closed-before-status-inside-open", cat(vec![cc(1, "early"), u(1, status("completed"))]), u(1, status("in_progress")));
    big("open-before-closed-inside", cc(1, "early"), u(1, status("completed")));
    big("two-tasks-one-closed", cat(vec![cc(1, "a"), cc(2, "b"), u(1, status("completed"))]), cat(vec![desc(1, "x"), desc(2, "y")]));
    big("two-closed", cat(vec![cc(1, "a"), cc(2, "b"), u(1, status("completed")), u(2, status("cancelled"))]), cat(vec![desc(1, "x"), desc(2, "y")]));
    big("deleted-before", cat(vec![cc(1, "a"), u(1, status("deleted"))]), desc(1, "x"));
    big("create-only-before", cc(1, "a"), u(1, vec![("owner", J::from("agent"))]));
    big("update-chain-before", cat(vec![cc(1, "a"), u(1, status("in_progress")), u(1, status("completed"))]), desc(1, "x"));
    big("update-chain-reopen", cat(vec![cc(1, "a"), u(1, status("completed")), u(1, status("pending"))]), desc(1, "x"));
    big("todowrite-before", cat(vec![tl.todo(ja![td("old", "pending")]), cc(1, "a")]), desc(1, "x"));
    big("todowrite-between", cat(vec![cc(1, "a"), tl.todo(ja![td("reset", "completed")])]), desc(1, "x"));
    big("tasklist-empty-between", cat(vec![cc(1, "a"), tl.list(true)]), desc(1, "x"));
    big("restart-numbering-between", cat(vec![cc(1, "old"), u(1, status("completed")), cc(1, "new-after-restart")]), desc(1, "x"));
    big("notfound-between", cat(vec![cc(1, "a"), tl.get(1, false)]), desc(1, "x"));
    big(
        "notfound-update-between",
        cat(vec![cc(1, "a"), {
            let tu = tl.use_("TaskUpdate", jo! {"taskId": "1", "status": "completed"});
            let id = id_of(&tu);
            let l1 = tl.asst(vec![tu]);
            let l2 = tl.user(ja![tl.res(&id, "Task #1 not found")]);
            vec![l1, l2]
        }]),
        desc(1, "x"),
    );
    big("window-has-create-too", cc(1, "a"), cat(vec![cc(2, "b"), desc(1, "x"), u(2, status("completed"))]));
    big("window-restart", cat(vec![cc(1, "a"), cc(2, "b")]), cat(vec![cc(1, "fresh list"), u(1, status("completed"))]));
    big("only-high-ids", cat(vec![cc(1, "a"), cc(2, "b"), cc(3, "c"), u(3, status("completed"))]), desc(3, "x"));
    big("many-unknown", cat(vec![cc(1, "a"), cc(2, "b"), cc(3, "c"), cc(4, "d")]), cat(vec![desc(1, "x"), desc(2, "x"), desc(3, "x"), desc(4, "x")]));
    big(
        "many-unknown-closed",
        cat(vec![cc(1, "a"), cc(2, "b"), cc(3, "c"), cc(4, "d"), (1..=4).flat_map(|i| u(i, status("completed"))).collect()]),
        (1..=4).flat_map(|i| desc(i, "x")).collect(),
    );
    big(
        "blockedby-before",
        cat(vec![cc(1, "a"), cc(2, "b"), u(2, vec![("addBlockedBy", ja!["1"])]), u(1, status("completed")), u(2, status("completed"))]),
        desc(2, "x"),
    );
    big("blockedon-before", c(1, "a", vec![("metadata", jo! {"blockedOn": "owner"})]), desc(1, "x"));
    // an open task that is honestly blocked on the owner draws no block from Node, but it is open: the engine hands it over
    if let Some(s) = out.borrow_mut().iter_mut().find(|s| s.id == "big-blockedon-before") {
        s.answer_when_no_block = false;
    }
    big("sidechain-before", cat(vec![vec![jo! {"type": "assistant", "isSidechain": true, "message": jo! {"id": "sc", "role": "assistant", "content": ja![tl.use_("TaskCreate", jo! {"subject": "side"})]}}.text()], cc(1, "a"), u(1, status("completed"))]), desc(1, "x"));
    big(
        "parallel-creates-before",
        {
            let a = tl.use_("TaskCreate", jo! {"subject": "p1"});
            let b = tl.use_("TaskCreate", jo! {"subject": "p2"});
            let m = tl.mid();
            let (ida, idb) = (id_of(&a), id_of(&b));
            let first = j2(&tl, &m, vec![a, b]);
            let res = tl.user(ja![tl.res(&idb, "Task #1 created successfully: p2"), tl.res(&ida, "Task #2 created successfully: p1")]);
            cat(vec![vec![first, res], u(1, status("completed")), u(2, status("completed"))])
        },
        cat(vec![desc(1, "x"), desc(2, "x")]),
    );
    big(
        "quoted-markers-before",
        cat(vec![cc(1, "a"), u(1, status("completed")), {
            let t = tl.text("the harness said \"No tasks found\" and \"Task not found\" and \"Task #1 created successfully\"");
            vec![tl.asst(vec![t])]
        }]),
        desc(1, "x"),
    );
    big("bad-line-before", cat(vec![cc(1, "a"), vec!["{\"broken".into()], u(1, status("completed"))]), desc(1, "x"));
    big("null-line-before", cat(vec![cc(1, "a"), vec!["null".into()], u(1, status("completed"))]), desc(1, "x"));
    big("window-cuts-a-line", cat(vec![cc(1, "a"), u(1, status("completed"))]), desc(1, "x"));
    {
        // far before the window: beyond what the engine scans exactly (it must defer, never guess)
        let ff: Vec<String> = (0..24000)
            .map(|i| {
                let t = tl.text(&format!("far {i} {}", "y".repeat(380)));
                tl.asst(vec![t])
            })
            .collect();
        let mut lines = vec![tl.prompt("go")];
        lines.extend(cc(1, "ancient"));
        lines.extend(u(1, status("completed")));
        lines.extend(ff);
        lines.extend(desc(1, "x"));
        let f = put(&lines, Some("big-far"));
        add("big-far-before", stop(tpj(&f), &[]), &w, Flags::default());
    }

    // ---- real transcripts (local data)
    for f in real_files("\"name\":\"TaskCreate\"", 20e3, 1.4e6, real_limit().min(300), 3) {
        let base = Path::new(&f).file_stem().map_or(String::new(), |s| s.to_string_lossy().to_string());
        add(&format!("real-whole-{}", clip(&base, 8)), stop(tpj(&f), &[]), &w, flag0);
    }
    let win_src = real_files("\"name\":\"TaskUpdate\"", 50e3, 8e6, 80, 5);
    let mut wn = 0usize;
    for f in win_src {
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        for _ in 0..4 {
            let len = 20 + r.below(400);
            let start = (r.next() * (lines.len().saturating_sub(len)).max(1) as f64).floor() as usize;
            let id = format!("real-window-{wn}");
            wn += 1;
            let slice: Vec<String> = lines.iter().skip(start).take(len).map(|s| s.to_string()).collect();
            let p = put(&slice, Some(&format!("win{wn}")));
            add(&id, stop(tpj(&p), &[]), &w, flag0);
        }
    }
    for f in real_files("\"name\":\"TaskCreate\"", 1.7e6, 60e6, 80, 7) {
        let base = Path::new(&f).file_stem().map_or(String::new(), |s| s.to_string_lossy().to_string());
        add(&format!("real-big-{}", clip(&base, 8)), stop(tpj(&f), &[]), &w, flag0);
    }

    // ---- fuzz (mutated hand-written histories)
    let all: Vec<Vec<String>> = h.iter().filter_map(|(_, v)| v.clone()).collect();
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(200);
    for i in 0..nfuzz {
        let mut lines: Vec<String> = Vec::new();
        let n = 1 + r.below(4);
        for _ in 0..n {
            lines.extend(r.pick(&all).clone());
        }
        if r.next() < 0.3 {
            let at = r.below(lines.len());
            let junk = (*r.pick(&["null", "5", "{\"a\":", "", "[]", "\"x\""])).to_string();
            lines.insert(at, junk);
        }
        let p = put(&lines, Some(&format!("fz{i}")));
        add(&format!("fuzz-{i}"), stop(tpj(&p), &[]), &w, flag0);
    }
    let scenarios = out.into_inner();
    (scenarios, shared, must.into_inner())
}

pub(crate) fn opts(must: BTreeSet<String>) -> Opts {
    let mut o = Opts::new("task-guard", "task-guard.js", "task-guard");
    o.may_defer = Some(Box::new(move |sc, _| !must.contains(&sc.id)));
    o
}
