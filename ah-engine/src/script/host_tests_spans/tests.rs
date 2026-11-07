//! The host-call timer of the request spans: a wrapped `ahHost` function books its time to its kind while a recorded check runs, passes
//! its result and its exceptions through, and costs only a flag read outside a span.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::obs::spans;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-hostspans-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    d.to_string_lossy().to_string()
}

#[test]
fn a_wrapped_host_call_is_timed_by_kind_and_still_returns_its_value() {
    let h = home("kinds");
    std::fs::write(format!("{h}/f"), "abc").unwrap();
    std::fs::write(
        format!("{h}/.anti-hall/logic/zz-span.js"),
        format!("function decide(p){{ var n = 0; for (var i = 0; i < 5; i++) {{ if (ahHost.fileSize('{h}/f') === 3) n++; }} var j = ahHost.pathJoin('a', 'b'); return (n === 5 && j === 'a/b') ? 'allow' : 'defer'; }}"),
    )
    .unwrap();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    // an unrecorded request: the wrapper only reads the flag
    assert_eq!(super::run_forced("zz-span", &json!({}), &Value::Null, "Stop", &env), Some(Some(Verdict::Allow)));
    spans::begin_if(true, std::time::Instant::now(), std::time::Duration::ZERO);
    spans::set_event("Stop", "s");
    spans::begin_check("zz-span", "spans.phase_select");
    assert_eq!(super::run_forced("zz-span", &json!({}), &Value::Null, "Stop", &env), Some(Some(Verdict::Allow)));
    spans::end_check("allow", "");
    spans::end_checks("spans.phase_post_checks");
    let s = spans::finish("spans.phase_finish", "spans.outcome_delivered", false).expect("a Stop span is recorded");
    let fs = spans::kind_of("fileSize").unwrap();
    let got = s.host.iter().find(|h| h.0 == fs).expect("fileSize time is booked to its kind");
    assert!(got.1 < 1_000_000 && got.2 <= got.1 + 1000, "CPU never exceeds the wall time it was part of");
    let doc = spans::snapshot("n=100 event=Stop");
    let mine = doc["requests"].as_array().unwrap().iter().find(|r| r["checks"][0]["check"] == "zz-span").expect("my span is listed");
    let calls = mine["checks"][0]["host"][spans::kind_name(fs)]["calls"].as_u64().unwrap();
    assert_eq!(calls, 5, "five fileSize calls; pathJoin has no kind and is not timed");
    assert!(mine["checks"][0]["acquire_us"].as_u64().is_some());
}

#[test]
fn an_exception_from_a_wrapped_function_still_reaches_the_script() {
    let h = home("throw");
    std::fs::write(
        format!("{h}/.anti-hall/logic/zz-span-throw.js"),
        "function decide(p){ try { ahHost.stateRead('/abs', 'x'); return 'defer'; } catch (e) { return 'allow'; } }",
    )
    .unwrap();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    spans::begin_if(true, std::time::Instant::now(), std::time::Duration::ZERO);
    spans::set_event("Stop", "s");
    spans::begin_check("zz", "spans.phase_select");
    let v = super::run_forced("zz-span-throw", &json!({}), &Value::Null, "Stop", &env);
    spans::end_check("allow", "");
    spans::end_checks("spans.phase_post_checks");
    spans::finish("spans.phase_finish", "spans.outcome_delivered", false);
    assert_eq!(v, Some(Some(Verdict::Allow)), "the wrapper rethrows what the host function threw");
}

/// One recorded request whose single check runs `body`; returns the span's check.
fn one_check(tag: &str, body: &str) -> serde_json::Value {
    let h = home(tag);
    std::fs::write(format!("{h}/blob"), vec![7u8; 3 << 20]).unwrap();
    std::fs::write(format!("{h}/.anti-hall/logic/zz-{tag}.js"), format!("function decide(p){{ {body} return 'allow'; }}")).unwrap();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    spans::begin_if(true, std::time::Instant::now(), std::time::Duration::ZERO);
    spans::set_event("Stop", tag);
    spans::begin_check(&format!("zz-{tag}"), "spans.phase_select");
    assert_eq!(super::run_forced(&format!("zz-{tag}"), &json!({}), &Value::Null, "Stop", &env), Some(Some(Verdict::Allow)));
    spans::end_check("allow", "");
    spans::end_checks("spans.phase_post_checks");
    spans::finish("spans.phase_finish", "spans.outcome_delivered", false).expect("recorded");
    let doc = spans::snapshot("n=200 event=Stop");
    doc["requests"].as_array().unwrap().iter().find(|r| r["checks"][0]["check"] == format!("zz-{tag}")).expect("my span")["checks"][0].clone()
}

#[test]
fn a_cpu_bound_host_call_reads_as_cpu_not_wait_and_a_sleeping_one_as_wait() {
    // CPU-bound: SHA-256 of a 3 MiB file, many times
    let c = one_check("cpu", "for (var i = 0; i < 60; i++) ahHost.fileSha256(ahHost.home() + '/blob');");
    let (wall, cpu) = (c["wall_us"].as_u64().unwrap(), c["cpu_us"].as_u64().unwrap());
    let fs = &c["host"][spans::kind_name(spans::kind_of("fileSha256").unwrap())];
    assert_eq!(fs["calls"], 60);
    assert!(fs["cpu_us"].as_u64().unwrap() * 10 >= fs["us"].as_u64().unwrap() * 7, "a computing host call is mostly CPU: {fs}");
    assert!(c["wait_us"].as_u64().unwrap() * 4 <= wall.max(cpu) + 2000, "a CPU-bound check has ~no wait: {c}");
    assert!(c["host_wait_us"].as_u64().unwrap() * 4 <= wall + 2000, "host wait of a CPU-bound call is ~0: {c}");
    // sleeping: ah sleep 80 ms
    let c = one_check("nap", "ahHost.sleep(80);");
    let nap = &c["host"][spans::kind_name(spans::kind_of("sleep").unwrap())];
    assert!(nap["wait_us"].as_u64().unwrap() >= 70_000, "a sleeping host call is wait: {nap}");
    assert!(nap["cpu_us"].as_u64().unwrap() < 20_000, "and costs no CPU: {nap}");
    assert!(c["wait_us"].as_u64().unwrap() >= 70_000 && c["host_wait_us"].as_u64().unwrap() >= 70_000, "the check's wait includes it: {c}");
}

#[test]
fn every_function_the_kind_table_lists_exists_and_is_listed_once() {
    let h = home("table");
    std::fs::write(format!("{h}/.anti-hall/logic/zz-table.js"), "function decide(p){ return {block: Object.keys(ahHost).sort().join(',')}; }").unwrap();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    let Some(Some(Verdict::Block(names))) = super::run_forced("zz-table", &json!({}), &Value::Null, "Stop", &env) else { panic!("no names") };
    let have: Vec<&str> = names.split(',').collect();
    let table = crate::defaults::raw("spans.kind_functions");
    let mut seen = std::collections::HashSet::new();
    for kind in crate::defaults::list("spans.kinds") {
        for f in table.get(kind).expect("every kind has a row").strings() {
            assert!(have.contains(&f), "{kind}: {f} is not an ahHost function");
            assert!(seen.insert(f), "{f} is listed twice");
        }
    }
    for cheap in ["pid", "jevMode", "jevEnabled", "pathJoin"] {
        assert!(spans::kind_of(cheap).is_none(), "{cheap} is not timed");
    }
}

/// What the wrapper adds to one host call: the original called directly, the wrapper outside a span, the wrapper inside one (ns per call).
/// Run with `cargo test --release --lib host_call_overhead -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn host_call_overhead() {
    let h = home("overhead");
    std::fs::write(format!("{h}/f"), "abc").unwrap();
    let body = |target: &str| {
        format!(
            "function decide(p){{ var f = {target}; var t = ahHost.now(); for (var i = 0; i < 200000; i++) f('{h}/f'); return {{block: String((ahHost.now() - t) * 1e6 / 200000)}}; }}"
        )
    };
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    for (name, target, recorded) in
        [("raw", "ahHostRaw.fileSize", false), ("wrapped_idle", "ahHost.fileSize", false), ("wrapped_timed", "ahHost.fileSize", true)]
    {
        std::fs::write(format!("{h}/.anti-hall/logic/zz-oh-{name}.js"), body(target)).unwrap();
        if recorded {
            spans::begin_if(true, std::time::Instant::now(), std::time::Duration::ZERO);
            spans::set_event("Stop", "s");
            spans::begin_check("zz", "spans.phase_select");
        }
        let v = super::run_forced(&format!("zz-oh-{name}"), &json!({}), &Value::Null, "Stop", &env);
        if recorded {
            spans::end_check("allow", "");
            spans::end_checks("spans.phase_post_checks");
            spans::finish("spans.phase_finish", "spans.outcome_delivered", false);
        }
        eprintln!("{name}: {v:?} ns per call");
    }
}
