//! Unit tests of the batch-7 host primitives (D88): the bounded process listing, ages, service-manager probe, signal and sleep,
//! the transcript evidence and the finished-agent scans. None holds a rule; these tests pin what they extract and their bounds,
//! and that every primitive the docs name is installed.
use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-hoste-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    std::fs::canonicalize(&d).unwrap().to_string_lossy().to_string()
}

fn env(h: &str, path: Option<&str>) -> RequestEnv {
    let mut v = vec![("HOME", h)];
    if let Some(p) = path {
        v.push(("PATH", p));
    }
    RequestEnv::from_pairs(v)
}

fn put_override(h: &str, name: &str, body: &str) {
    std::fs::write(format!("{h}/.anti-hall/logic/{name}.js"), body).unwrap();
}

fn run(name: &str, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, &json!({}), &Value::Null, "PreToolUse", e)
}

/// Write an executable script. A thread of another test that forks while the file is still open for writing holds the write
/// descriptor until its own exec, and an exec of the file meanwhile fails with "text file busy": run it once, retrying, so the
/// real call that follows never races that window.
fn write_exec(f: &str, body: &str) {
    std::fs::write(f, body).unwrap();
    std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..200 {
        match std::process::Command::new(f).stdin(std::process::Stdio::null()).output() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => return,
        }
    }
}

/// A directory of fake programs, each printing its canned text, first on the PATH of the request.
fn fakes(h: &str, progs: &[(&str, &str)]) -> String {
    let d = format!("{h}/fake-bin");
    std::fs::create_dir_all(&d).unwrap();
    for (name, body) in progs {
        write_exec(&format!("{d}/{name}"), &format!("#!/bin/sh\ncat <<'EOF_FAKE'\n{body}\nEOF_FAKE\n"));
    }
    format!("{d}:/usr/bin:/bin")
}

fn out(h: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out.json")).unwrap()).unwrap()
}

const WRITE: &str = "ah.state.writeAtomic('.anti-hall/out.json', JSON.stringify(res)); return 'allow';";

#[test]
fn proc_list_returns_the_table_and_a_failed_listing_is_null_never_empty() {
    let h = home("list");
    let path = fakes(&h, &[("ps", "      1       0 /sbin/launchd\n  41234    1 node /x/server.js --mcp\nnot a row")]);
    put_override(&h, "zz-plist", &format!("function decide(p){{ var res = ah.proc.list(); {WRITE} }}"));
    assert_eq!(run("zz-plist", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!({"rows": [{"pid": 1, "ppid": 0, "cmd": "/sbin/launchd"}, {"pid": 41234, "ppid": 1, "cmd": "node /x/server.js --mcp"}]}));
    // a listing that exits non-zero, or a program that is not there, is null: never an empty table
    let bad = format!("{h}/bad-bin");
    std::fs::create_dir_all(&bad).unwrap();
    write_exec(&format!("{bad}/ps"), "#!/bin/sh\necho '1 0 x'\nexit 3\n");
    assert_eq!(run("zz-plist", &env(&h, Some(&bad))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), Value::Null);
    assert_eq!(run("zz-plist", &env(&h, Some(&format!("{h}/nowhere")))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), Value::Null);
}

#[test]
fn proc_ages_read_elapsed_seconds_then_the_start_time_and_leave_unknown_pids_out() {
    let h = home("ages");
    // elapsed seconds for 111; no row for 222, whose start time (in the one form `ps -o lstart=` prints) comes from the second probe
    let path = fakes(&h, &[("ps", "")]);
    write_exec(
        &format!("{h}/fake-bin/ps"),
        "#!/bin/sh\ncase \"$*\" in\n  *etimes*) echo '  111 7200' ;;\n  *lstart*) echo '  222 Mon Jan  1 00:00:00 2024' ;;\nesac\n",
    );
    put_override(&h, "zz-pages", &format!("function decide(p){{ var res = ah.proc.ages([111, 222, 333]); {WRITE} }}"));
    assert_eq!(run("zz-pages", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    let o = out(&h);
    assert_eq!(o["ages"]["111"], json!(7200));
    assert!(o["ages"]["222"].as_f64().unwrap() > 86_400.0 * 365.0, "{o}");
    assert!(o["ages"].get("333").is_none(), "an unknown age is left out: {o}");
    // a start time in a form the engine does not read makes the whole answer unsure
    write_exec(&format!("{h}/fake-bin/ps"), "#!/bin/sh\ncase \"$*\" in\n  *etimes*) ;;\n  *lstart*) echo '  222 yesterday evening' ;;\nesac\n");
    assert_eq!(run("zz-pages", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!({"unsure": true}));
    // an id the engine cannot hold exactly is unsure too
    put_override(&h, "zz-pages", &format!("function decide(p){{ var res = ah.proc.ages([1e300]); {WRITE} }}"));
    assert_eq!(run("zz-pages", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!({"unsure": true}));
}

#[test]
fn proc_managed_reports_the_platform_and_an_unverifiable_listing() {
    let h = home("managed");
    put_override(&h, "zz-pmanaged", &format!("function decide(p){{ var res = ah.proc.managed([4242, 4343]); {WRITE} }}"));
    if cfg!(target_os = "macos") {
        let path = fakes(&h, &[("launchctl", "PID\tStatus\tLabel\n4242\t0\tcom.example.svc\n-\t0\tcom.example.idle")]);
        assert_eq!(run("zz-pmanaged", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
        assert_eq!(out(&h), json!({"platform": "launchd", "managed": [4242], "unverifiable": false}));
        assert_eq!(run("zz-pmanaged", &env(&h, Some(&format!("{h}/nowhere")))), Some(Some(Verdict::Allow)));
        assert_eq!(out(&h), json!({"platform": "launchd", "managed": [], "unverifiable": true}));
    } else {
        assert_eq!(run("zz-pmanaged", &env(&h, None)), Some(Some(Verdict::Allow)));
        let o = out(&h);
        assert_eq!(o["unverifiable"], json!(false));
        assert!(o["managed"].as_array().unwrap().is_empty(), "{o}");
    }
}

#[test]
fn proc_signal_ends_only_a_pid_the_scripts_own_listing_showed_and_obeys_its_bounds() {
    let h = home("signal");
    let mut child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
    let pid = child.id();
    // SAFETY: getppid takes no arguments and cannot fail.
    let parent = unsafe { libc::getppid() } as u32;
    let me = std::process::id();
    let path = fakes(&h, &[("ps", &format!("      1       0 /sbin/launchd\n{pid:>7} 1 sleep 60\n{me:>7} 1 self\n{parent:>7} 1 parent"))]);
    // refused: before any listing, a never-listed pid, pid 0 and 1, this process and its parent, a forced signal before a polite one
    put_override(
        &h,
        "zz-psignal",
        &format!(
            "function decide(p){{ var res = {{}}; res.beforeList = ah.proc.signal({pid}, false); ah.proc.list(); res.unlisted = ah.proc.signal(999999, false);
               res.zero = ah.proc.signal(0, false); res.one = ah.proc.signal(1, false); res.me = ah.proc.signal({me}, false); res.parent = ah.proc.signal({parent}, false);
               res.frac = ah.proc.signal({pid}.5, false); res.forcedFirst = ah.proc.signal({pid}, true); res.term = ah.proc.signal({pid}, false); res.kill = ah.proc.signal({pid}, true); {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-psignal", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(
        out(&h),
        json!({"beforeList": false, "unlisted": false, "zero": false, "one": false, "me": false, "parent": false, "frac": false, "forcedFirst": false, "term": true, "kill": true})
    );
    let status = child.wait().unwrap();
    assert!(!status.success(), "the polite signal ended the child: {status:?}");
    // the listing of one call grants nothing to the next
    put_override(&h, "zz-psignal2", &format!("function decide(p){{ var res = {{ again: ah.proc.signal({pid}, false) }}; {WRITE} }}"));
    assert_eq!(run("zz-psignal2", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!({"again": false}));
}

#[test]
fn proc_signal_sends_at_most_the_per_call_cap() {
    let h = home("cap");
    // pids far above any real pid limit: a signal reaches nothing, the cap is what is under test
    let rows: String = (0..8).map(|i| format!("{:>8} 1 fake{i}\n", 5_000_100 + i)).collect();
    let path = fakes(&h, &[("ps", &rows)]);
    put_override(
        &h,
        "zz-pcap",
        &format!(
            "function decide(p){{ ah.proc.list(); var n = 0; for (var i = 0; i < 8; i++) if (ah.proc.signal(5000100 + i, false)) n++; var res = {{ n: n }}; {WRITE} }}"
        ),
    );
    let cap = defaults::num("hostproc.signal_max_per_call");
    assert!(cap >= 8, "the shipped cap leaves room for this test");
    assert_eq!(run("zz-pcap", &env(&h, Some(&path))), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!({"n": 8}));
}

#[test]
fn sleep_waits_but_never_longer_than_its_bounds_and_is_not_script_time() {
    let h = home("sleep");
    put_override(
        &h,
        "zz-sleep",
        &format!("function decide(p){{ var t0 = Date.now(); ah.sleep(30); ah.sleep(-5); ah.sleep(NaN); var res = {{ ms: Date.now() - t0 }}; {WRITE} }}"),
    );
    assert_eq!(run("zz-sleep", &env(&h, None)), Some(Some(Verdict::Allow)));
    let ms = out(&h)["ms"].as_f64().unwrap();
    assert!((25.0..2000.0).contains(&ms), "{ms}");
}

#[test]
fn re_numbers_gives_the_distinct_finite_numbers_of_the_matches_sorted() {
    let h = home("renum");
    put_override(
        &h,
        "zz-renum",
        &format!(
            "function decide(p){{ var res = {{ a: ah.re.numbers('\\\\d[\\\\d,]*(?:\\\\.\\\\d+)?', '', 'took 1,234.50 s, 7 files, 7 rows, 0.5 ms and 00012 bytes; 3.', ','), b: ah.re.numbers('\\\\d+', '', 'none here x', ''), c: ah.re.numbers('\\\\d+', '', '1 99999999999999999999999999 1', '') }}; {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-renum", &env(&h, None)), Some(Some(Verdict::Allow)));
    let o = out(&h);
    assert_eq!(o["a"], json!([0.5, 3, 7, 12, 1234.5]), "{o}");
    assert_eq!(o["b"], json!([]));
    assert_eq!(o["c"], json!([1, 99999999999999999999999999.0]), "{o}");
}

#[test]
fn transcript_evidence_lists_the_text_of_each_record_in_order() {
    let h = home("evidence");
    let t = format!("{h}/t.jsonl");
    let lines = [
        json!({"type": "user", "message": {"role": "user", "content": "please count the files"}}),
        json!({"type": "assistant", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls | wc -l"}}, {"type": "text", "text": "counting"}]}}),
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "42"}]}, "toolUseResult": {"stdout": "42"}}),
        json!({"type": "attachment", "attachment": {"type": "hook", "x": 1}}),
        json!({"type": "assistant", "message": {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "  "}, {"type": "text", "text": "There are 42 files."}]}}),
    ];
    std::fs::write(&t, lines.iter().map(|l| format!("{l}\n")).collect::<String>() + "not json\n").unwrap();
    let e: Value = serde_json::from_str(&host_ts::evidence(&t, 1_000_000.0)).unwrap();
    assert_eq!(e["truncated"], json!(false));
    assert_eq!(
        e["items"],
        json!([
            ["p", "please count the files"],
            ["i", "{\"command\":\"ls | wc -l\"}"],
            ["t", "counting", "m1"],
            ["r", "42"],
            ["r", "{\"stdout\":\"42\"}"],
            ["a", "{\"type\":\"hook\",\"x\":1}"],
            ["t", "   There are 42 files.", "m2"],
        ])
    );
    // a window that cuts the file drops its partial first line and says so
    let cut: Value = serde_json::from_str(&host_ts::evidence(&t, 200.0)).unwrap();
    assert_eq!(cut["truncated"], json!(true));
    assert_eq!(host_ts::evidence(&format!("{h}/none"), 1000.0), "null");
    assert_eq!(host_ts::evidence("relative.jsonl", 1000.0), r#"{"unsure":true}"#);
    // a line only JavaScript parses (a lone surrogate escape) is unsure
    std::fs::write(&t, "{\"type\":\"user\",\"message\":{\"content\":\"\\ud800\"}}\n").unwrap();
    assert_eq!(host_ts::evidence(&t, 1000.0), r#"{"unsure":true}"#);
    // through the script API
    put_override(&h, "zz-evidence", &format!("function decide(p){{ var res = ah.transcript.evidence('{h}/none', 100); {WRITE} }}"));
    assert_eq!(run("zz-evidence", &env(&h, None)), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), Value::Null);
}

#[test]
fn agent_scan_also_reports_the_stop_option_and_the_pending_teammate_messages() {
    let h = home("scanopts");
    let t = format!("{h}/t.jsonl");
    let launch = "Async agent launched successfully.\nagentId: a1b2c3d4e5f60718 (internal ID)\nThe agent is working in the background.\noutput_file: /nonexistent/out.output\n";
    let mut text = String::new();
    text.push_str(&format!("{}\n", json!({"type": "assistant", "timestamp": "2026-10-06T12:00:00.000Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "d", "prompt": "p", "run_in_background": true}}]}})));
    text.push_str(&format!("{}\n", json!({"type": "user", "timestamp": "2026-10-06T12:00:01.000Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a1", "content": launch}]}, "toolUseResult": {"isAsync": true, "status": "async_launched", "agentId": "a1b2c3d4e5f60718"}})));
    text.push_str(&format!("{}\n", json!({"type": "assistant", "timestamp": "2026-10-06T12:00:09.000Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "s1", "name": "TaskStop", "input": {"task_id": "a1b2c3d4e5f60718"}}]}})));
    std::fs::write(&t, text).unwrap();
    let plain: Value = serde_json::from_str(&host_d::agent_scan(&t, 1_000_000.0, false)).unwrap();
    let ignoring: Value = serde_json::from_str(&host_d::agent_scan(&t, 1_000_000.0, true)).unwrap();
    assert_eq!(plain["pending"], json!([]));
    assert_ne!(plain["terminal"], ignoring["terminal"], "an unanswered TaskStop counts unless the option skips it: {plain} / {ignoring}");
}

#[test]
fn the_finished_agent_scans_answer_null_for_a_missing_file_and_unsure_for_a_relative_path() {
    let h = home("finished");
    for f in [host_ts::teammates, host_ts::codex_agents] {
        assert_eq!(f(&format!("{h}/none"), 1000.0), "null");
        assert_eq!(f("relative.jsonl", 1000.0), r#"{"unsure":true}"#);
        let t = format!("{h}/empty.jsonl");
        std::fs::write(&t, "{\"type\":\"user\"}\n").unwrap();
        let r: Value = serde_json::from_str(&f(&t, 1000.0)).unwrap();
        assert!(r.get("teammates").or_else(|| r.get("agents")).unwrap().as_array().unwrap().is_empty(), "{r}");
    }
}

#[test]
fn call_fn_applies_a_rule_function_of_a_rules_script_and_answers_none_for_what_does_not_exist() {
    let args = json!({"status": {"checks": "running", "pr": "open", "running": 0}});
    assert_eq!(crate::script::call_fn("rules/gh-rt", "ghCadence", &args), Some(json!("poll_running_ms")));
    assert_eq!(crate::script::call_fn("rules/gh-rt", "ghCadence", &json!({"status": {"checks": "green", "pr": "open"}})), Some(json!("poll_idle_ms")));
    assert_eq!(crate::script::call_fn("rules/gh-rt", "noSuchFunction", &args), None, "a function the script does not define");
    assert_eq!(crate::script::call_fn("rules/no-such-script", "ghCadence", &args), None, "a script that does not exist");
}

/// Every raw function the host modules document in their header table is installed (`h.set("<name>"`): a primitive named in the docs
/// but never registered would throw "not a function" in the first script that used it (`ahHost.now` and `ahHost.stateRead` once did).
#[test]
fn every_documented_ahhost_primitive_is_registered() {
    use std::collections::BTreeSet;
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/script");
    let mut documented = BTreeSet::new();
    let mut registered = BTreeSet::new();
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        if !e.path().extension().is_some_and(|x| x == "rs") {
            continue;
        }
        let text = std::fs::read_to_string(e.path()).unwrap();
        for line in text.lines() {
            // a header table row: `//! | `name(args)` | what |` or `//! | `a(x)` / `b(y)` | ...`
            if let Some(row) = line.strip_prefix("//! | ") {
                for cell in row.split('|').take(1) {
                    for part in cell.split('`').skip(1).step_by(2) {
                        let name: String = part.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                        if !name.is_empty() && part.contains('(') {
                            documented.insert(name);
                        }
                    }
                }
            }
        }
        let mut rest = text.as_str();
        while let Some(i) = rest.find("h.set(") {
            rest = &rest[i + 6..];
            if let Some(q) = rest.trim_start().strip_prefix('"') {
                registered.insert(q.chars().take_while(|c| *c != '"').collect::<String>());
            }
        }
    }
    let missing: Vec<_> = documented.difference(&registered).collect();
    assert!(missing.is_empty(), "documented ahHost primitives the engine never registers: {missing:?}");
    for must in
        ["procList", "procAges", "procManaged", "procSignal", "sleep", "transcriptEvidence", "transcriptTeammates", "transcriptCodexAgents", "agentScan"]
    {
        assert!(documented.contains(must) && registered.contains(must), "{must} is documented and registered");
    }
    assert!(documented.len() > 30, "the scan found the documented API ({} names)", documented.len());
}
