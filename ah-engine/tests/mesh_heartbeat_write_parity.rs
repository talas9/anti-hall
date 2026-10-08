//! `heartbeat --summary` (the mesh broadcast) and `heartbeat --step` / `--summary` for a workspace WITH a plan (the plan lock and
//! the supervision events): `ah-engine mesh heartbeat ...` (mesh.engine_writes = on) against
//! `node scripts/devswarm.js heartbeat ...` on identical scratch homes.
//!
//! Every case builds ONE seeded scratch home (the D45 fixture: a real git repo with a linked child worktree, a store written by
//! Node's own `devswarm-store.js`), applies the case's setup (plan files, descriptors, settings, a pre-grown log), copies it
//! three times and runs Node on the first copy, the engine on the second and the engine with NO Node on PATH on the third.
//!
//! * a `native` case: the engine answers itself; stdout, the exit code, every store table and every file of the home tree
//!   (the heartbeat record, the verdict, the plan, the supervision log, the summary projection) are byte-identical to Node's, and the
//!   detached Node check on a scratch copy reports `match`;
//! * a `defer` case: the engine writes NOTHING and exits 75 when it cannot run Node, and hands the verb to Node otherwise.
//!
//! The other tests: concurrent writers (engine and Node on one plan and one store, loss-free), the plan lock (held by a live
//! process, left by a dead one) and injected faults (an unwritable plan directory, a store another process holds).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const T0: i64 = 1_795_000_000_000;
const CREATED: i64 = 1_794_999_000_000;

type Setup = Box<dyn Fn(&Path, &Fx)>;

struct Case {
    name: &'static str,
    cwd: &'static str,
    argv: Vec<String>,
    extra: Vec<(&'static str, String)>,
    setup: Setup,
    native: bool,
    /// Substrings of Node's stdout, so a case cannot pass by both sides refusing alike.
    expect: Vec<&'static str>,
    /// Exit code Node returns.
    code: i32,
}

fn s(x: &str) -> String {
    x.to_string()
}

fn hb(more: &[&str]) -> Vec<String> {
    let mut v = vec![s("heartbeat"), s("child-1"), s("--session"), s("s1")];
    v.extend(more.iter().map(|x| s(x)));
    v
}

fn nothing() -> Setup {
    Box::new(|_, _| {})
}

fn plan_value(key: &str, fx: &Fx, statuses: &[&str]) -> Value {
    let steps: Vec<Value> = statuses
        .iter()
        .enumerate()
        .map(|(i, st)| {
            let started = if *st == "todo" { Value::Null } else { json!(CREATED + 10_000) };
            json!({"n": i + 1, "text": format!("step {}", i + 1), "status": st, "ts": if *st == "todo" { Value::Null } else { json!(CREATED + 20_000) }, "started_at": started})
        })
        .collect();
    json!({"v": 1, "key": key, "id": "child-1", "worktreePath": fx.child.to_string_lossy(), "source": "plan-set", "created_at": CREATED, "base": null,
        "steps": steps, "scope_globs": [], "extras": [], "step_ts": null, "current": null, "warned_at": null, "warned_step": null, "summaries": []})
}

fn plans_dir(h: &Path) -> PathBuf {
    h.join(".anti-hall/devswarm/plans")
}

fn put_plan(h: &Path, key: &str, v: &Value) {
    fs::create_dir_all(plans_dir(h)).unwrap();
    fs::write(plans_dir(h).join(format!("{key}.json")), serde_json::to_string_pretty(v).unwrap()).unwrap();
}

/// A descriptor for child-1 (so the plan is found by the worktree's mesh id) and the floor rows its mailbox read needs.
fn with_descriptor(h: &Path, fx: &Fx) {
    let rows = json!([
        {"partition": "child-1", "ns": "store", "reader": "#floor", "value": 0, "updatedAt": 1_790_000_000_000i64},
        {"partition": "child-1", "ns": "nd", "reader": "#floor", "value": 0, "updatedAt": 1_790_000_000_000i64}
    ]);
    let d = json!({"id": "child-1", "worktreePath": fx.child.to_string_lossy(), "sessionId": "child-1"});
    run_seed("ack_seed.js", h, fx, &json!({"rows": rows, "descriptors": [d]}));
}

fn plan_case(statuses: &'static [&'static str], by_mesh: bool, tweak: impl Fn(&mut Value) + 'static) -> Setup {
    Box::new(move |h, fx| {
        with_descriptor(h, fx);
        let key = if by_mesh { fx.child_mesh.clone() } else { s("child-1") };
        let mut v = plan_value(&key, fx, statuses);
        tweak(&mut v);
        put_plan(h, &key, &v);
    })
}

fn run_seed(script: &str, h: &Path, fx: &Fx, spec: &Value) {
    let o = Command::new("node")
        .arg(support(script))
        .arg(h)
        .arg(&fx.repo_key)
        .arg(spec.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    assert!(o.status.success(), "{script} failed: {}", String::from_utf8_lossy(&o.stderr));
}

fn normalized(home: &Path, bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes).replace(&home.to_string_lossy().to_string(), "<HOME>").into_bytes()
}

fn no_node_path(root: &Path) -> String {
    let bin = root.join("nonode-bin");
    fs::create_dir_all(&bin).unwrap();
    for t in ["git", "ps"] {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.to_string_lossy().to_string()
}

fn tree(home: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    home_files(home).into_iter().map(|(k, v)| (k, normalized(home, &v))).collect()
}

fn assert_same_home(name: &str, a: &Path, b: &Path, key: &str, what: &str) {
    let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if db(a).is_file() && db(b).is_file() {
        let (da, dbb) = (raw_dump(&db(a)), raw_dump(&db(b)));
        assert!(da == dbb, "{name}: {what}: store differs: {}", first_diff(&da, &dbb));
    }
    let (fa, fb) = (tree(a), tree(b));
    let ka: Vec<&String> = fa.keys().collect();
    let kb: Vec<&String> = fb.keys().collect();
    assert_eq!(ka, kb, "{name}: {what}: home tree file set differs");
    for (k, v) in &fa {
        assert!(fb[k] == *v, "{name}: {what}: {k} differs:\n a: {}\n b: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&fb[k]));
    }
}

/// The detached verifier's newest record, waited for up to 40 s.
fn verify_line(state: &Path) -> Value {
    for _ in 0..400 {
        if let Ok(t) = fs::read_to_string(state.join("mesh-verify.jsonl"))
            && let Some(l) = t.lines().last()
        {
            return serde_json::from_str(l).unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    json!({"result": "none"})
}

fn prepare(h: &Path, fx: &Fx, c: &Case) {
    copy_tree(&fx.seed_home, h);
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    (c.setup)(h, fx); // after the default settings: a case may replace them
}

fn cases() -> Vec<Case> {
    let long_log = |h: &Path| {
        let p = h.join(".anti-hall/logs/devswarm-supervision.ndjson");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x".repeat(1_100_000)).unwrap();
    };
    vec![
        // ---------------- --summary: the mesh broadcast ----------------
        Case {
            name: "summary-basic",
            cwd: "child",
            argv: hb(&["--summary", "working on the parser"]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"meshBroadcast\":{\"ok\":true,\"sent\":true", "\"repoKey\""],
            code: 0,
        },
        Case {
            name: "summary-urgency-high",
            cwd: "child",
            argv: hb(&["--summary", "blocked on review", "--urgency", "high"]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"sent\":true"],
            code: 0,
        },
        Case {
            name: "summary-unicode-newline",
            cwd: "child",
            argv: hb(&["--summary", "naïve ☃ line\nbreak \"quoted\""]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"sent\":true"],
            code: 0,
        },
        Case {
            name: "summary-empty-text",
            cwd: "child",
            argv: hb(&["--summary="]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"meshBroadcast\""],
            code: 0,
        },
        Case {
            name: "summary-with-fields",
            cwd: "child",
            argv: hb(&["--summary", "x", "--progress", "40", "--phase", "build", "--wip", "a", "--blockers", "b"]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"progress_pct\":40"],
            code: 0,
        },
        Case {
            name: "summary-bare-flag-is-no-summary",
            cwd: "child",
            argv: hb(&["--summary"]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"meshBroadcast\":null"],
            code: 0,
        },
        Case {
            name: "summary-with-descriptor",
            cwd: "child",
            argv: hb(&["--summary", "with a descriptor"]),
            extra: vec![],
            setup: Box::new(|h, fx| with_descriptor(h, fx)),
            native: true,
            expect: vec!["\"sent\":true"],
            code: 0,
        },
        Case {
            name: "summary-child-env",
            cwd: "child",
            argv: hb(&["--summary", "as the builder"]),
            extra: vec![("DEVSWARM_SOURCE_BRANCH", s("feat")), ("DEVSWARM_BUILDER_ID", s("child-1"))],
            setup: nothing(),
            native: true,
            expect: vec!["\"sent\":true"],
            code: 0,
        },
        Case {
            name: "summary-primary-row-self",
            cwd: "main",
            argv: vec![s("heartbeat"), s("child-1"), s("--session"), s("sess-primary"), s("--summary"), s("from the primary")],
            extra: vec![],
            setup: nothing(),
            native: false,
            expect: vec!["\"dropped\":true"],
            code: 0,
        },
        Case {
            name: "summary-ownership-refused",
            cwd: "main",
            argv: hb(&["--summary", "forged"]),
            extra: vec![],
            setup: nothing(),
            native: false,
            expect: vec!["\"dropped\":true"],
            code: 0,
        },
        Case {
            name: "summary-unknown-id-first-claim",
            cwd: "child",
            argv: vec![s("heartbeat"), s("ghost-1"), s("--session"), s("s1"), s("--summary"), s("hi")],
            extra: vec![],
            setup: nothing(),
            native: false,
            expect: vec!["\"meshBroadcast\""],
            code: 0,
        },
        Case {
            name: "summary-bad-urgency",
            cwd: "child",
            argv: hb(&["--summary", "x", "--urgency", "bogus"]),
            extra: vec![],
            setup: nothing(),
            native: false,
            expect: vec!["allowed"],
            code: 2,
        },
        Case {
            name: "summary-without-session",
            cwd: "child",
            argv: vec![s("heartbeat"), s("child-1"), s("--summary"), s("x")],
            extra: vec![],
            setup: nothing(),
            native: false,
            expect: vec!["\"meshBroadcast\""],
            code: 0,
        },
        Case {
            name: "summary-journal-backend",
            cwd: "child",
            argv: hb(&["--summary", "x"]),
            extra: vec![("ANTIHALL_DEVSWARM_STORE_BACKEND", s("journal"))],
            setup: nothing(),
            native: false,
            expect: vec!["\"meshBroadcast\""],
            code: 0,
        },
        // ---------------- --step with a plan ----------------
        Case {
            name: "step-1-doing",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"plan\":{\"ok\":true", "\"changed\":true", "\"label\":\"0/3 done · doing #1"],
            code: 0,
        },
        Case {
            name: "step-plan-keyed-by-id",
            cwd: "child",
            argv: hb(&["--step", "2", "--status", "done"]),
            extra: vec![],
            setup: plan_case(&["todo", "doing", "todo"], false, |_| {}),
            native: true,
            expect: vec!["\"changed\":true", "\"status\":\"done\""],
            code: 0,
        },
        Case {
            name: "step-done-all",
            cwd: "child",
            argv: hb(&["--step", "3", "--status", "done"]),
            extra: vec![],
            setup: plan_case(&["done", "done", "doing"], true, |_| {}),
            native: true,
            expect: vec!["steps 3/3 done"],
            code: 0,
        },
        Case {
            name: "step-done-all-after-report",
            cwd: "child",
            argv: hb(&["--step", "3", "--status", "done"]),
            extra: vec![],
            setup: plan_case(&["done", "done", "doing"], true, |v| v["done_reported_at"] = json!(CREATED + 5)),
            native: true,
            expect: vec!["steps 3/3 done"],
            code: 0,
        },
        Case {
            name: "step-reopen-a-done-step",
            cwd: "child",
            argv: hb(&["--step", "1", "--status", "doing"]),
            extra: vec![],
            setup: plan_case(&["done", "done", "todo"], true, |_| {}),
            native: true,
            expect: vec!["(plan changed)"],
            code: 0,
        },
        Case {
            name: "step-reopen-keeps-higher-regressed",
            cwd: "child",
            argv: hb(&["--step", "1", "--status", "blocked"]),
            extra: vec![],
            setup: plan_case(&["done", "done", "todo"], true, |v| v["regressed_from"] = json!(5)),
            native: true,
            expect: vec!["1 blocked", "#1 blocked"],
            code: 0,
        },
        Case {
            name: "step-regressed-cleared",
            cwd: "child",
            argv: hb(&["--step", "2", "--status", "done"]),
            extra: vec![],
            setup: plan_case(&["done", "doing", "todo"], true, |v| v["regressed_from"] = json!(1)),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-same-status-no-change",
            cwd: "child",
            argv: hb(&["--step", "1", "--status", "doing"]),
            extra: vec![],
            setup: plan_case(&["doing", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"changed\":false"],
            code: 0,
        },
        Case {
            name: "step-two-doing-one-blocked",
            cwd: "child",
            argv: hb(&["--step", "3", "--status", "doing"]),
            extra: vec![],
            setup: plan_case(&["doing", "blocked", "todo"], true, |_| {}),
            native: true,
            expect: vec!["2 doing", "#2 blocked"],
            code: 0,
        },
        Case {
            name: "step-out-of-range",
            cwd: "child",
            argv: hb(&["--step", "9"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"reason\":\"bad-step\"", "from 1 to 2"],
            code: 2,
        },
        Case {
            name: "step-zero",
            cwd: "child",
            argv: hb(&["--step", "0"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["bad-step"],
            code: 2,
        },
        Case {
            name: "step-not-a-number",
            cwd: "child",
            argv: hb(&["--step", "abc"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["bad-step"],
            code: 2,
        },
        Case {
            name: "step-fraction",
            cwd: "child",
            argv: hb(&["--step", "1.5"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["bad-step"],
            code: 2,
        },
        Case {
            name: "step-number-forms",
            cwd: "child",
            argv: hb(&["--step", " 0x2 "]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"step\":2"],
            code: 0,
        },
        Case {
            name: "step-float-integer",
            cwd: "child",
            argv: hb(&["--step", "2.0"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"step\":2"],
            code: 0,
        },
        Case {
            name: "step-bad-status",
            cwd: "child",
            argv: hb(&["--step", "1", "--status", "paused"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["--status must be one of doing|done|blocked"],
            code: 2,
        },
        Case {
            name: "step-bad-status-ignored-without-step",
            cwd: "child",
            argv: hb(&["--status", "paused", "--summary", "s"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"plan\":{\"ok\":true"],
            code: 0,
        },
        Case {
            name: "step-bare-flag-is-no-step",
            cwd: "child",
            argv: hb(&["--step"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"idMismatch\":false}"],
            code: 0,
        },
        Case {
            name: "step-empty-value",
            cwd: "child",
            argv: hb(&["--step="]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["bad-step"],
            code: 2,
        },
        Case {
            name: "step-without-descriptor-plan-by-id",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| put_plan(h, "child-1", &plan_value("child-1", fx, &["todo", "todo"]))),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-builder-env-plan-by-worktree",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![("DEVSWARM_SOURCE_BRANCH", s("feat")), ("DEVSWARM_BUILDER_ID", s("child-1"))],
            setup: Box::new(|h, fx| put_plan(h, &fx.child_mesh, &plan_value(&fx.child_mesh, fx, &["todo", "todo"]))),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-extra-plan-fields-survive",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v["inferred_step"] = json!(2);
                v["stray_note"] = json!({"a": [1, 2, {"b": null}], "c": 1.5e300});
                v["activity_sigs"] = json!(["aaa", 7]);
                v["unicode"] = json!("é☃😀");
            }),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        // plan fields of the supervisor
        Case {
            name: "step-correction-followed",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v["warned_at"] = json!(T0 - 600_000);
                v["warned_signals"] = json!(["stall"]);
                v["warned_jev"] = json!([{"integration": "x", "supports": true}]);
            }),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-correction-followed-already",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v["warned_at"] = json!(T0 - 600_000);
                v["correction_followed_for"] = json!(T0 - 600_000);
            }),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-correction-too-old",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["warned_at"] = json!(T0 - 100_000_000)),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-correction-in-the-future",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["warned_at"] = json!(T0 + 600_000)),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-stall-setting-in-settings-json",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| {
                plan_case(&["todo", "todo"], true, |v| v["warned_at"] = json!(T0 - 600_000))(h, fx);
                fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"},\"devswarm\":{\"stepStallMin\":5}}\n").unwrap();
            }),
            native: false,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-stall-setting-env",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![("ANTIHALL_DEVSWARM_STEP_STALL_MIN", s("5"))],
            setup: plan_case(&["todo", "todo"], true, |v| v["warned_at"] = json!(T0 - 600_000)),
            native: false,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-stall-setting-env-not-reached",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![("ANTIHALL_DEVSWARM_STEP_STALL_MIN", s("5"))],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-respawn-first-progress",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["respawn"] = json!({"from": "old-ws", "at": T0 - 5000})),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-respawn-no-from",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["respawn"] = json!({"from": "", "at": "x"})),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-respawn-already-progressed",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["respawn"] = json!({"from": "old-ws", "at": T0 - 5000, "first_step_at": T0 - 100})),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-respawn-is-an-array",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["respawn"] = json!([1])),
            native: false,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-label-inferred",
            cwd: "child",
            argv: hb(&["--summary", "s"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo", "todo"], true, |v| v["inferred_step"] = json!(2)),
            native: true,
            expect: vec!["~#2"],
            code: 0,
        },
        Case {
            name: "step-label-hours-and-days",
            cwd: "child",
            argv: hb(&["--summary", "s"]),
            extra: vec![],
            setup: plan_case(&["doing", "todo"], true, |v| {
                v["steps"][0]["started_at"] = json!(T0 - 200_000_000i64);
                v["step_ts"] = json!(T0 - 7_200_000i64);
            }),
            native: true,
            expect: vec!["· 2d ·"],
            code: 0,
        },
        Case {
            name: "step-label-no-timestamps",
            cwd: "child",
            argv: hb(&["--summary", "s"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v.as_object_mut().unwrap().remove("created_at");
            }),
            native: true,
            expect: vec!["\"label\""],
            code: 0,
        },
        Case {
            name: "step-label-string-number",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["steps"][0]["n"] = json!("one")),
            native: true,
            expect: vec!["doing #one"],
            code: 0,
        },
        // plan summary recording
        Case {
            name: "plan-summary-records-activity",
            cwd: "child",
            argv: hb(&["--summary", "Parsing   the TOKENS now"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"plan\":{\"ok\":true"],
            code: 0,
        },
        Case {
            name: "plan-summary-repeat-keeps-activity-ts",
            cwd: "child",
            argv: hb(&["--summary", "same text"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v["activity_sigs"] = json!(["9d4a6bd0f2b8"]);
                v["activity_ts"] = json!(CREATED);
            }),
            native: true,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "plan-summary-trims-to-three",
            cwd: "child",
            argv: hb(&["--summary", "fourth"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| {
                v["summaries"] =
                    json!([{"ts": 1, "text": "a", "stepped": false}, {"ts": 2, "text": "b", "stepped": false}, {"ts": 3, "text": "c", "stepped": true}]);
                v["activity_sigs"] = json!(["a1", "a2", "a3", "a4", "a5"]);
            }),
            native: true,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "plan-summary-long-text-clipped",
            cwd: "child",
            argv: vec![s("heartbeat"), s("child-1"), s("--session"), s("s1"), s("--summary"), "w".repeat(260)],
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "plan-summary-and-step",
            cwd: "child",
            argv: hb(&["--step", "1", "--summary", "Starting step one"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "plan-summary-bad-step-skips-summary",
            cwd: "child",
            argv: hb(&["--step", "7", "--summary", "not recorded"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["bad-step"],
            code: 2,
        },
        Case {
            name: "plan-summary-non-ascii-defers",
            cwd: "child",
            argv: hb(&["--summary", "naïve ☃"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: false,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "plan-summary-non-ascii-without-plan-is-native",
            cwd: "child",
            argv: hb(&["--summary", "naïve ☃"]),
            extra: vec![],
            setup: nothing(),
            native: true,
            expect: vec!["\"sent\":true"],
            code: 0,
        },
        // no plan / unreadable plans
        Case {
            name: "plan-file-not-json",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| {
                with_descriptor(h, fx);
                fs::create_dir_all(plans_dir(h)).unwrap();
                fs::write(plans_dir(h).join(format!("{}.json", fx.child_mesh)), "{not json").unwrap();
            }),
            native: true,
            expect: vec!["\"reason\":\"no-plan\""],
            code: 0,
        },
        Case {
            name: "plan-file-steps-not-array",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo"], true, |v| v["steps"] = json!({"a": 1})),
            native: true,
            expect: vec!["\"reason\":\"no-plan\""],
            code: 0,
        },
        Case {
            name: "plan-file-is-an-array",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| {
                with_descriptor(h, fx);
                fs::create_dir_all(plans_dir(h)).unwrap();
                fs::write(plans_dir(h).join(format!("{}.json", fx.child_mesh)), "[1,2]").unwrap();
            }),
            native: true,
            expect: vec!["\"reason\":\"no-plan\""],
            code: 0,
        },
        Case {
            name: "plan-file-falls-back-to-id-plan",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| {
                with_descriptor(h, fx);
                fs::create_dir_all(plans_dir(h)).unwrap();
                fs::write(plans_dir(h).join(format!("{}.json", fx.child_mesh)), "nope").unwrap();
                put_plan(h, "child-1", &plan_value("child-1", fx, &["todo", "todo"]));
            }),
            native: true,
            expect: vec!["\"changed\":true", "\"key\":\"child-1\""],
            code: 0,
        },
        Case {
            name: "plan-with-null-step-defers",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |v| v["steps"][1] = Value::Null),
            native: false,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "plan-invalid-utf8-defers",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(|h, fx| {
                with_descriptor(h, fx);
                fs::create_dir_all(plans_dir(h)).unwrap();
                let mut b = serde_json::to_vec(&plan_value(&fx.child_mesh, fx, &["todo", "todo"])).unwrap();
                let at = b.len() - 2;
                b.splice(at..at, [0xffu8, 0xfe]);
                fs::write(plans_dir(h).join(format!("{}.json", fx.child_mesh)), b).unwrap();
            }),
            native: false,
            expect: vec!["\"plan\""],
            code: 0,
        },
        Case {
            name: "supervision-log-needs-rotation-defers",
            cwd: "child",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: Box::new(move |h, fx| {
                plan_case(&["todo", "todo"], true, |_| {})(h, fx);
                long_log(h);
            }),
            native: false,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
        Case {
            name: "supervision-log-big-but-no-event",
            cwd: "child",
            argv: hb(&["--step", "1", "--status", "doing"]),
            extra: vec![],
            setup: Box::new(move |h, fx| {
                plan_case(&["doing", "todo"], true, |_| {})(h, fx);
                long_log(h);
            }),
            native: true,
            expect: vec!["\"changed\":false"],
            code: 0,
        },
        // summary + plan
        Case {
            name: "summary-and-step-and-plan",
            cwd: "child",
            argv: hb(&["--summary", "all at once", "--step", "2", "--status", "done"]),
            extra: vec![],
            setup: plan_case(&["done", "doing", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"sent\":true", "\"changed\":true"],
            code: 0,
        },
        Case {
            name: "step-from-the-primary-checkout",
            cwd: "main",
            argv: hb(&["--step", "1"]),
            extra: vec![],
            setup: plan_case(&["todo", "todo"], true, |_| {}),
            native: true,
            expect: vec!["\"changed\":true"],
            code: 0,
        },
    ]
}

fn run_cases(tag: &str, list: Vec<Case>, min_native: usize, min_deferred: usize) {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture(tag);
    let nonode = no_node_path(&fx.root);
    let (mut native, mut deferred) = (0, 0);
    for (i, c) in list.iter().enumerate() {
        let now = T0 + i as i64 * 7_919;
        let cwd: PathBuf = if c.cwd == "main" { fx.main.clone() } else { fx.child.clone() };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            prepare(h, &fx, c);
        }
        let av: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let n = node_verb(&hn, &hn.join("state"), &cwd, &av, now, None, &extra);
        assert_eq!(n.code, c.code, "{}: Node's exit code: {}", c.name, n.stdout);
        for want in &c.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout);
        }
        let e = engine_verb(&he, &he.join("state"), &cwd, &av, now, None, &extra);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
            assert_same_home(c.name, &hn, &he, &fx.repo_key, "node vs engine");
            let v = verify_line(&he.join("state"));
            assert_eq!(v["result"], "match", "{}: the background Node shadow disagrees: {v}", c.name);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let before = fx.root.join(format!("{}-before", c.name));
            prepare(&before, &fx, c);
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&hd.join("state"))["result"], "defer", "{}: logged as a deferral", c.name);
            assert_same_home(c.name, &before, &hd, &fx.repo_key, "deferral wrote");
        }
    }
    eprintln!(
        "heartbeat write parity [{tag}]: {} cases, {native} answered by the engine and identical to Node (with a matching background check), {deferred} deferred with nothing written",
        list.len()
    );
    assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
}

#[test]
fn summary_and_plan_heartbeats_match_node_byte_for_byte_and_defer_without_writing() {
    run_cases("hbw", cases(), 55, 9);
}

// ---------------------------------------------------------------------------------------------------------------------
// the plan lock
// ---------------------------------------------------------------------------------------------------------------------

/// A Node process that takes the plan's lock the way `updatePlan` does and holds it.
fn hold_plan_lock(home: &Path, lock: &Path, hold_ms: u64) -> std::process::Child {
    let lock_js = plugin_root().join("companion/lib/lock.js");
    let code = format!(
        "const l=require({:?});const h=l.acquire({:?},{{waitMs:0,stealDead:true,staleMs:30000,liveStaleMs:30000}});if(!h){{console.log('FAILED');process.exit(3)}}console.log('ready');setTimeout(()=>process.exit(0),{hold_ms});",
        lock_js.to_string_lossy(),
        lock.to_string_lossy()
    );
    let mut c = Command::new("node")
        .args(["-e", &code])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(c.stdout.take().unwrap()), &mut line).unwrap();
    assert_eq!(line.trim(), "ready", "the lock holder did not start");
    c
}

fn lock_fixture(fx: &Fx, name: &str) -> (PathBuf, PathBuf, Vec<String>) {
    let h = fx.root.join(name);
    copy_tree(&fx.seed_home, &h);
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    with_descriptor(&h, fx);
    put_plan(&h, &fx.child_mesh, &plan_value(&fx.child_mesh, fx, &["todo", "todo"]));
    let lock = plans_dir(&h).join(format!("{}.json.lock", fx.child_mesh));
    (h, lock, hb(&["--step", "1"]))
}

/// A lock held by a LIVE process stays busy for the five-second wait on both sides: the heartbeat is recorded, the plan is
/// not, and the answer says so (`lock-busy`); a lock left by a DEAD process is taken over at once and the step is recorded.
#[test]
fn a_live_plan_lock_is_respected_and_a_dead_one_taken_over_like_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("hbw-lock");
    for dead in [false, true] {
        let tag = if dead { "dead" } else { "live" };
        let (hn, lock_n, argv) = lock_fixture(&fx, &format!("{tag}-node"));
        let (he, lock_e, _) = lock_fixture(&fx, &format!("{tag}-engine"));
        let av: Vec<&str> = argv.iter().map(String::as_str).collect();
        let now = T0 + 5;
        let mut holder = hold_plan_lock(&hn, &lock_n, 60_000);
        if dead {
            holder.kill().unwrap();
            holder.wait().unwrap();
        }
        let n = node_verb(&hn, &hn.join("state"), &fx.child, &av, now, None, &[]);
        holder.kill().ok();
        holder.wait().ok();
        let mut holder = hold_plan_lock(&he, &lock_e, 60_000);
        if dead {
            holder.kill().unwrap();
            holder.wait().unwrap();
        }
        let e = engine_verb(&he, &he.join("state"), &fx.child, &av, now, None, &[]);
        holder.kill().ok();
        holder.wait().ok();
        if dead {
            assert!(n.stdout.contains("\"changed\":true"), "{tag}: Node took the dead lock over: {}", n.stdout);
        } else {
            assert!(n.stdout.contains("lock-busy"), "{tag}: Node reports the busy lock: {}", n.stdout);
            assert!(he.join(".anti-hall/devswarm/heartbeats/child-1.json").is_file(), "the heartbeat itself is recorded");
        }
        assert_eq!(last_log(&he.join("state"))["result"], "native", "{tag}: the engine answers a locked plan itself");
        assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{tag}: stdout/exit differ");
        // the stale owner file of the live case is the holder's, not ours: drop both before comparing trees
        for l in [&lock_n, &lock_e] {
            fs::remove_file(l).ok();
        }
        assert_same_home(tag, &hn, &he, &fx.repo_key, "node vs engine");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// concurrent writers
// ---------------------------------------------------------------------------------------------------------------------

/// Engine and Node processes heartbeat with a step and a summary into ONE plan and ONE store at the same time: every step
/// lands in the plan, every summary is a store row, every event is in the log, nothing is left locked.
#[test]
fn engine_and_node_heartbeats_write_one_plan_and_one_store_without_loss() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    const STEPS: usize = 12;
    let fx = fixture("hbw-conc");
    let h = fx.root.join("home");
    copy_tree(&fx.seed_home, &h);
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    with_descriptor(&h, &fx);
    let statuses: Vec<&str> = vec!["todo"; STEPS];
    put_plan(&h, &fx.child_mesh, &plan_value(&fx.child_mesh, &fx, &statuses));
    let rows_before = {
        let c = rusqlite::Connection::open(h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db")).unwrap();
        c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0)).unwrap()
    };
    let mut handles = Vec::new();
    for i in 0..STEPS {
        let (h, child) = (h.clone(), fx.child.clone());
        handles.push(std::thread::spawn(move || {
            let step = (i + 1).to_string();
            let text = format!("concurrent summary number {i}");
            let a = hb(&["--step", &step, "--status", "done", "--summary", &text]);
            let av: Vec<&str> = a.iter().map(String::as_str).collect();
            let now = T0 + 100 + i as i64;
            let r = if i % 2 == 0 {
                engine_verb(&h, &h.join("state"), &child, &av, now, None, &[])
            } else {
                node_verb(&h, &h.join("state-node"), &child, &av, now, None, &[])
            };
            assert_eq!(r.code, 0, "writer {i}: {}", r.stdout);
            assert!(r.stdout.contains("\"changed\":true") && r.stdout.contains("\"sent\":true"), "writer {i}: {}", r.stdout);
        }));
    }
    for t in handles {
        t.join().unwrap();
    }
    let plan: Value = serde_json::from_str(&fs::read_to_string(plans_dir(&h).join(format!("{}.json", fx.child_mesh))).unwrap()).unwrap();
    let done = plan["steps"].as_array().unwrap().iter().filter(|s| s["status"] == "done").count();
    assert_eq!(done, STEPS, "every step landed in the plan (none lost to a concurrent writer): {plan}");
    assert!(plan["summaries"].as_array().unwrap().len() <= 3, "the plan keeps three summaries");
    let log = fs::read_to_string(h.join(".anti-hall/logs/devswarm-supervision.ndjson")).unwrap();
    assert_eq!(log.lines().filter(|l| l.contains("\"type\":\"step\"")).count(), STEPS, "one step event per step");
    let c = rusqlite::Connection::open(h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db")).unwrap();
    let rows: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(rows - rows_before, STEPS as i64, "one heartbeat row per summary");
    let hb_rows: i64 =
        c.query_row("SELECT COUNT(DISTINCT hash) FROM messages WHERE is_heartbeat=1 AND body LIKE 'concurrent summary number%'", [], |r| r.get(0)).unwrap();
    assert_eq!(hb_rows, STEPS as i64, "every summary is its own heartbeat row");
    let seqs: i64 = c.query_row("SELECT COUNT(DISTINCT seq) FROM messages WHERE seq IS NOT NULL", [], |r| r.get(0)).unwrap();
    let max_seq: i64 = c.query_row("SELECT MAX(seq) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(seqs, max_seq, "the mesh seq stays unique and gap free");
    let ok: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(ok, "ok");
    let leftovers: Vec<String> = fs::read_dir(plans_dir(&h))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n != &format!("{}.json", fx.child_mesh))
        .collect();
    assert!(leftovers.is_empty(), "no lock or temp left behind: {leftovers:?}");
}

// ---------------------------------------------------------------------------------------------------------------------
// injected faults
// ---------------------------------------------------------------------------------------------------------------------

/// Either the engine reproduces Node's answer and files exactly, or it defers and wrote nothing.
fn same_or_deferred(name: &str, fx: &Fx, prep: &dyn Fn(&Path), undo: &dyn Fn(&Path), argv: &[String]) -> bool {
    let nonode = no_node_path(&fx.root);
    let (hn, he, hd, hb4) = (
        fx.root.join(format!("{name}-node")),
        fx.root.join(format!("{name}-engine")),
        fx.root.join(format!("{name}-defer")),
        fx.root.join(format!("{name}-before")),
    );
    for h in [&hn, &he, &hd, &hb4] {
        copy_tree(&fx.seed_home, h);
        fs::create_dir_all(h.join(".anti-hall")).unwrap();
        fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        with_descriptor(h, fx);
        put_plan(h, &fx.child_mesh, &plan_value(&fx.child_mesh, fx, &["todo", "todo"]));
    }
    let av: Vec<&str> = argv.iter().map(String::as_str).collect();
    let now = T0 + 9;
    for h in [&hn, &he, &hd] {
        prep(h);
    }
    let n = node_verb(&hn, &hn.join("state"), &fx.child, &av, now, None, &[]);
    let e = engine_verb(&he, &he.join("state"), &fx.child, &av, now, None, &[]);
    let native = last_log(&he.join("state"))["result"] == "native";
    if native {
        assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{name}: stdout/exit differ");
    } else {
        assert_eq!(e.code, n.code, "{name}: exit code of the fallback");
        let d = engine_verb(&hd, &hd.join("state"), &fx.child, &av, now, None, &[("PATH", nonode.as_str())]);
        assert_eq!((d.code, d.stdout.is_empty()), (75, true), "{name}: deferral contract: {} / {}", d.code, d.stdout);
    }
    for h in [&hn, &he, &hd] {
        undo(h);
    }
    assert_same_home(name, &hn, if native { &he } else { &hd }, &fx.repo_key, if native { "node vs engine" } else { "deferral wrote" });
    if !native {
        // a deferral wrote nothing: the untouched copy is the same
        assert_same_home(name, &hb4, &hd, &fx.repo_key, "deferral wrote");
    }
    native
}

#[test]
fn an_unwritable_plan_directory_is_reproduced_or_deferred_without_a_write() {
    use std::os::unix::fs::PermissionsExt;
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("hbw-ro");
    let mode = |m: u32| move |h: &Path| fs::set_permissions(plans_dir(h), fs::Permissions::from_mode(m)).unwrap();
    let native = same_or_deferred("ro-plans-dir", &fx, &mode(0o555), &mode(0o755), &hb(&["--step", "1"]));
    eprintln!("unwritable plan directory: engine {}", if native { "reproduced Node exactly" } else { "deferred untouched" });
}

/// A store another process holds for writing past the busy timeout: the heartbeat record is already written, the broadcast
/// fails. The engine must say so (exit 70) and Node must NOT be started to write it again.
#[test]
fn a_held_store_after_the_first_write_exits_70_and_never_reruns_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("hbw-busy");
    let he = fx.root.join("home");
    copy_tree(&fx.seed_home, &he);
    fs::create_dir_all(he.join(".anti-hall")).unwrap();
    fs::write(he.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    let db = he.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let holder = rusqlite::Connection::open(&db).unwrap();
    holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let a = hb(&["--summary", "held"]);
    let av: Vec<&str> = a.iter().map(String::as_str).collect();
    let e = engine_verb(&he, &he.join("state"), &fx.child, &av, T0 + 1, None, &[]);
    let log = last_log(&he.join("state"));
    drop(holder);
    eprintln!("held store: exit {} log {log}", e.code);
    let beat = he.join(".anti-hall/devswarm/heartbeats/child-1.json").is_file();
    match log["result"].as_str() {
        Some("committed-failure") => {
            assert_eq!(e.code, 70, "a failure after the heartbeat write is exit 70");
            assert!(beat, "the heartbeat record was written before the failure");
        }
        Some("defer") | Some("panic") => assert!(!beat, "a deferral before any write leaves no record (Node runs the verb)"),
        other => panic!("unexpected outcome {other:?}: {log}"),
    }
}
