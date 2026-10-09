//! Tests of the DevSwarm action layer against a fixture live state and scripted / real stub runners.
use super::exec::{Act, Origin};
use super::ledger::{Begin, KeyState, Ledger, Word};
use super::live::LiveState;
use super::runner::{RunResult, RunSpec, Runner, System, at_least, parse_version};
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const NOW: i64 = 1_800_000_000_000;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-dsact-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join("home")).unwrap();
    std::fs::create_dir_all(d.join("state")).unwrap();
    d
}

fn settings(home: &Path, v: Value) {
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), v.to_string()).unwrap();
}

/// Facts for an eligible auto-archive candidate.
fn good(id: &str) -> Value {
    json!({"id": id, "label": "Label", "branch": "b/x", "worktreePath": "/w", "primaryCwd": "/p", "isPrimary": false, "hasSummary": true,
        "head": "abc123abc123", "done": {"done": true, "via": "done-report", "boundToHead": true},
        "merged": {"merged": true, "via": "git:origin/main"}, "clean": true,
        "unread": {"toChild": 0, "toDirect": 0, "toBroadcast": 0, "fromChild": 0},
        "hasLastSelected": true, "lastSelectedAt": null,
        "idle": {"ts": NOW - 3_600_000, "via": "real-work", "openRealTurn": false, "pendingBackground": false}})
}

struct Fixture {
    present: bool,
    now: Cell<i64>,
    candidates: Vec<String>,
    stale: Vec<String>,
    /// Facts by `kind:id`; each read pops the first entry, the last one stays.
    facts: RefCell<HashMap<String, Vec<Value>>>,
    archived: RefCell<HashMap<String, bool>>,
    prune: Vec<Value>,
    reads: Cell<usize>,
    post: RefCell<HashMap<String, Value>>,
}

impl Fixture {
    fn new() -> Fixture {
        Fixture {
            present: true,
            now: Cell::new(NOW),
            candidates: vec![],
            stale: vec![],
            facts: RefCell::new(HashMap::new()),
            archived: RefCell::new(HashMap::new()),
            prune: vec![],
            reads: Cell::new(0),
            post: RefCell::new(HashMap::new()),
        }
    }
    fn with(self, key: &str, seq: Vec<Value>) -> Fixture {
        self.facts.borrow_mut().insert(key.into(), seq);
        self
    }
}

impl LiveState for Fixture {
    fn present(&self) -> bool {
        self.present
    }
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn candidates(&self) -> Vec<String> {
        self.candidates.clone()
    }
    fn stale(&self) -> Vec<String> {
        self.stale.clone()
    }
    fn facts(&self, kind: &str, id: &str) -> Option<Value> {
        self.reads.set(self.reads.get() + 1);
        let mut m = self.facts.borrow_mut();
        let v = m.get_mut(&format!("{kind}:{id}"))?;
        Some(if v.len() > 1 { v.remove(0) } else { v[0].clone() })
    }
    fn archived(&self, id: &str) -> Option<bool> {
        self.archived.borrow().get(id).copied()
    }
    fn post_archive(&self, id: &str) -> Option<Value> {
        self.post.borrow().get(id).cloned()
    }
    fn prune_rows(&self, _days: u64) -> Vec<Value> {
        self.prune.clone()
    }
}

/// A scripted runner: records every call; `--version` answers the configured version; the rest come from `respond`.
type Respond = Box<dyn Fn(&RunSpec, usize) -> RunResult>;
type Mutation = Box<dyn Fn(&mut Value)>;

struct Scripted {
    version: Option<&'static str>,
    missing: bool,
    calls: RefCell<Vec<RunSpec>>,
    respond: Respond,
}

fn ok(out: &str) -> RunResult {
    RunResult { ok: true, status: Some(0), stdout: out.into(), ..RunResult::default() }
}
fn fail(err: &str) -> RunResult {
    RunResult { ok: false, status: Some(1), stderr: err.into(), ..RunResult::default() }
}

impl Scripted {
    fn new() -> Scripted {
        Scripted { version: Some("hivecontrol 2.5.3"), missing: false, calls: RefCell::new(vec![]), respond: Box::new(|_, _| ok("{}")) }
    }
    fn answers(mut self, f: impl Fn(&RunSpec, usize) -> RunResult + 'static) -> Scripted {
        self.respond = Box::new(f);
        self
    }
    fn actions(&self) -> Vec<Vec<String>> {
        self.calls.borrow().iter().filter(|c| c.args != ["--version"]).map(|c| c.args.clone()).collect()
    }
}

impl Runner for Scripted {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.calls.borrow_mut().push(spec.clone());
        if spec.args == ["--version"] {
            return match (self.missing, self.version) {
                (true, _) => RunResult { missing: true, error: Some("not found".into()), ..RunResult::default() },
                (_, Some(v)) => ok(v),
                _ => ok("no version here"),
            };
        }
        let n = self.calls.borrow().len();
        (self.respond)(spec, n)
    }
}

fn act<'a>(d: &Path, live: &'a Fixture, runner: &'a dyn Runner) -> Act<'a> {
    let h = d.join("home").to_string_lossy().into_owned();
    Act::new(&d.join("home"), &d.join("state"), RequestEnv::from_pairs([("HOME", h)]), live, runner)
}

fn archive_argv(id: &str) -> Vec<String> {
    vec!["workspace".into(), "archive".into(), id.into()]
}

fn one_candidate(id: &str) -> Fixture {
    let mut f = Fixture::new().with(&format!("auto-archive:{id}"), vec![good(id)]);
    f.candidates = vec![id.into()];
    f
}

#[test]
fn an_eligible_workspace_is_archived_once_with_its_explicit_id_in_the_primary_worktree() {
    let d = scratch("auto1");
    let live = one_candidate("ws-1");
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let s = a.auto_archive_sweep();
    assert_eq!(s["archived"], json!(["ws-1"]), "{s}");
    assert_eq!(r.actions(), vec![archive_argv("ws-1")]);
    assert_eq!(r.calls.borrow().last().unwrap().cwd.as_deref(), Some("/p"));
    // Node's own records: the durable gate-(h) file, the NDJSON line, the owned-ids file
    let state: Value = serde_json::from_str(&std::fs::read_to_string(d.join("home/.anti-hall/devswarm/auto-archived.json")).unwrap()).unwrap();
    assert_eq!(state["ws-1"][0]["doneHead"], "abc123abc123");
    let line: Value =
        serde_json::from_str(std::fs::read_to_string(d.join("home/.anti-hall/logs/devswarm-auto-archive.ndjson")).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!((line["action"].as_str(), line["ok"].as_bool(), line["id"].as_str()), (Some("auto-archive"), Some(true), Some("ws-1")));
    assert_eq!(s["notices"][0]["id"], "ws-1");
}

#[test]
fn a_repeated_trigger_runs_exactly_one_archive() {
    let d = scratch("idem");
    let live = one_candidate("ws-1");
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    for _ in 0..4 {
        a.auto_archive_sweep();
    }
    assert_eq!(r.actions().len(), 1);
    // even with Node's file gone, the ledger alone refuses the key
    std::fs::remove_file(d.join("home/.anti-hall/devswarm/auto-archived.json")).unwrap();
    a.auto_archive_sweep();
    assert_eq!(r.actions().len(), 1, "the ledger key auto-archive:ws-1:<head> is done");
}

#[test]
fn an_archive_node_made_at_this_head_is_never_repeated() {
    let d = scratch("nodeprior");
    std::fs::create_dir_all(d.join("home/.anti-hall/devswarm")).unwrap();
    std::fs::write(d.join("home/.anti-hall/devswarm/auto-archived.json"), json!({"ws-1": [{"doneHead": "abc123abc123", "at": 1}]}).to_string()).unwrap();
    let live = one_candidate("ws-1");
    let r = Scripted::new();
    let s = act(&d, &live, &r).auto_archive_sweep();
    assert!(r.actions().is_empty());
    assert_eq!(s["plan"][0]["blockers"][0]["gate"], "h-rearchive");
}

#[test]
fn state_that_changed_since_the_plan_is_rejected_at_the_recheck() {
    let d = scratch("stale");
    let mut dirty = good("ws-1");
    dirty["clean"] = json!(false);
    dirty["cleanReason"] = json!("uncommitted-changes");
    let mut live = Fixture::new().with("auto-archive:ws-1", vec![good("ws-1"), dirty]);
    live.candidates = vec!["ws-1".into()];
    let r = Scripted::new();
    let s = act(&d, &live, &r).auto_archive_sweep();
    assert!(r.actions().is_empty(), "the second read was dirty: nothing may run");
    assert_eq!(s["failed"][0]["reason"], "stale");
    assert!(!d.join("state/dsact.ledger").exists() || Ledger::open(&d.join("state")).state("auto-archive:ws-1:abc123abc123") == KeyState::Fresh);
}

#[test]
fn every_gate_blocks_and_names_itself() {
    let cases: Vec<(&str, Mutation)> = vec![
        ("e-primary", Box::new(|f| f["isPrimary"] = json!(true))),
        ("a-done", Box::new(|f| f["done"] = json!({"done": false, "via": null}))),
        ("b-merged", Box::new(|f| f["merged"] = json!({"merged": false, "via": "git:not-ancestor"}))),
        ("c-clean", Box::new(|f| f["clean"] = json!(false))),
        ("d-unread", Box::new(|f| f["unread"]["toChild"] = json!(1))),
        ("d-unread", Box::new(|f| f["unread"]["fromChild"] = Value::Null)),
        ("f-viewed", Box::new(|f| f["lastSelectedAt"] = json!(NOW - 60_000))),
        ("f-viewed", Box::new(|f| f["hasLastSelected"] = json!(false))),
        ("g-idle", Box::new(|f| f["idle"]["ts"] = json!(NOW - 60_000))),
        ("g-idle", Box::new(|f| f["idle"]["openRealTurn"] = json!(true))),
        ("g-idle", Box::new(|f| f["idle"]["pendingBackground"] = json!(true))),
        ("g-idle", Box::new(|f| f["idle"]["ts"] = Value::Null)),
    ];
    for (i, (gate, mutate)) in cases.iter().enumerate() {
        let d = scratch(&format!("gate{i}"));
        let mut f = good("ws-1");
        mutate(&mut f);
        let mut live = Fixture::new().with("auto-archive:ws-1", vec![f]);
        live.candidates = vec!["ws-1".into()];
        let r = Scripted::new();
        let s = act(&d, &live, &r).auto_archive_sweep();
        assert!(r.actions().is_empty(), "case {i} ({gate}) must not archive: {s}");
        let gates: Vec<&str> = s["plan"][0]["blockers"].as_array().unwrap().iter().filter_map(|b| b["gate"].as_str()).collect();
        assert!(gates.contains(gate), "case {i}: {gates:?} lacks {gate}");
    }
}

#[test]
fn modes_dry_run_and_off_spawn_nothing_and_write_nothing() {
    for mode in ["dry-run", "off"] {
        let d = scratch(&format!("mode-{mode}"));
        settings(&d.join("home"), json!({"devswarm": {"autoArchive": {"mode": mode}}}));
        let live = one_candidate("ws-1");
        let r = Scripted::new();
        let s = act(&d, &live, &r).auto_archive_sweep();
        assert!(r.actions().is_empty(), "{mode}");
        assert_eq!(s["mode"], mode);
        assert!(!d.join("state/dsact.ledger").exists());
        if mode == "dry-run" {
            assert_eq!(s["wouldArchive"], json!(["ws-1"]));
        }
    }
}

#[test]
fn max_per_sweep_and_the_flat_dotted_key_are_honoured() {
    let d = scratch("max");
    settings(&d.join("home"), json!({"devswarm": {"autoArchive.maxPerSweep": 2}}));
    let mut live = Fixture::new();
    for i in 0..4 {
        live = live.with(&format!("auto-archive:w{i}"), vec![good(&format!("w{i}"))]);
        live.candidates.push(format!("w{i}"));
    }
    let r = Scripted::new();
    let s = act(&d, &live, &r).auto_archive_sweep();
    assert_eq!(s["archived"].as_array().unwrap().len(), 2, "{s}");
}

#[test]
fn devswarm_absent_makes_the_layer_inert() {
    let d = scratch("absent");
    let mut live = one_candidate("ws-1");
    live.present = false;
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let s = a.auto_archive_sweep();
    assert_eq!(s["dormant"], "DevSwarm not installed");
    assert!(a.poke_sweep().is_empty());
    let q = a.request("archive", &json!({"id": "ws-1", "request": "r1"}));
    assert_eq!(q.word, Word::Inert);
    assert!(r.calls.borrow().is_empty(), "no process may start");
    assert!(!d.join("state/dsact.ledger").exists());
}

#[test]
fn a_missing_or_old_hivecontrol_is_unavailable_and_nothing_is_recorded() {
    let d = scratch("nohc");
    let live = one_candidate("ws-1");
    let mut r = Scripted::new();
    r.missing = true;
    let s = act(&d, &live, &r).auto_archive_sweep();
    assert_eq!(s["dormant"], "DevSwarm not installed");
    assert!(r.actions().is_empty());
    let mut old = Scripted::new();
    old.version = Some("hivecontrol 2.5.2");
    let s = act(&d, &live, &old).auto_archive_sweep();
    assert!(s["dormant"].as_str().unwrap().contains("2.5.3"), "{s}");
    let mut none = Scripted::new();
    none.version = None;
    assert!(act(&d, &live, &none).auto_archive_sweep()["dormant"].is_string());
    assert!(!d.join("state/dsact.ledger").exists());
}

#[test]
fn a_failed_archive_is_recorded_retried_with_a_backoff_and_capped() {
    let d = scratch("fail");
    let live = one_candidate("ws-1");
    let r = Scripted::new().answers(|_, _| fail("boom"));
    let a = act(&d, &live, &r);
    let s = a.auto_archive_sweep();
    assert_eq!(s["failed"][0]["outcome"], "failed");
    assert!(s["archived"].as_array().unwrap().is_empty());
    assert!(!d.join("home/.anti-hall/devswarm/auto-archived.json").exists(), "a failure is not a done record");
    let k = "auto-archive:ws-1:abc123abc123";
    assert!(matches!(Ledger::open(&d.join("state")).state(k), KeyState::Failed { attempts: 1, .. }));
    a.auto_archive_sweep();
    assert_eq!(r.actions().len(), 1, "inside the backoff window the key is refused");
    live.now.set(NOW + 3_600_000);
    a.auto_archive_sweep();
    assert_eq!(r.actions().len(), 2);
    for i in 0..5 {
        live.now.set(NOW + 7_200_000 * (i + 1));
        a.auto_archive_sweep();
    }
    assert_eq!(r.actions().len(), 3, "capped at devswarm_act.max_attempts");
}

#[test]
fn a_hung_call_is_a_timeout_not_a_done() {
    let d = scratch("hang");
    let live = one_candidate("ws-1");
    let r = Scripted::new().answers(|_, _| RunResult { timed_out: true, error: Some("t".into()), ..RunResult::default() });
    let s = act(&d, &live, &r).auto_archive_sweep();
    assert_eq!(s["failed"][0]["outcome"], "timeout");
    assert!(s["archived"].as_array().unwrap().is_empty());
}

#[test]
fn an_unfinished_attempt_is_in_doubt_and_never_repeated() {
    let d = scratch("doubt");
    let l = Ledger::open(&d.join("state"));
    assert_eq!(l.begin("k", "archive", "i", NOW), Begin::Claimed(1));
    assert_eq!(l.state("k"), KeyState::InDoubt);
    assert_eq!(l.begin("k", "archive", "i", NOW + 10_000_000), Begin::Refused(KeyState::InDoubt));
    l.finish("k", "archive", "i", NOW, Word::Done, None);
    assert_eq!(l.begin("k", "archive", "i", NOW), Begin::Refused(KeyState::Done));
}

#[test]
fn an_unwritable_ledger_runs_nothing() {
    let d = scratch("ro");
    let live = one_candidate("ws-1");
    let r = Scripted::new();
    let a =
        Act::new(&d.join("home"), &d.join("state/not-a-dir/x"), RequestEnv::from_pairs([("HOME", d.join("home").to_string_lossy().into_owned())]), &live, &r);
    std::fs::write(d.join("state/not-a-dir"), "file").unwrap();
    let s = a.auto_archive_sweep();
    assert!(r.actions().is_empty(), "{s}");
}

#[test]
fn only_the_nodes_automatic_kinds_may_start_without_the_owner() {
    let d = scratch("origin");
    let live = Fixture::new();
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    for k in ["archive", "create", "merge", "delete"] {
        assert_eq!(a.permit(Origin::Automatic, k).unwrap_err().word, Word::Refused, "{k}");
    }
    for k in ["auto-archive", "poke", "escalate"] {
        assert!(a.permit(Origin::Automatic, k).is_ok(), "{k}");
        assert_eq!(a.permit(Origin::Owner, k).unwrap_err().word, Word::Refused, "{k} is not an owner kind");
    }
    for k in ["recover", "drain", "read-messages"] {
        assert_eq!(a.permit(Origin::Owner, k).unwrap_err().word, Word::Deferred, "{k}");
        assert_eq!(a.permit(Origin::Automatic, k).unwrap_err().word, Word::Deferred, "{k}");
    }
}

fn app_facts(builder_type: &str, archived: bool) -> Value {
    json!({"appReadable": true, "found": true, "builderType": builder_type, "archived": archived, "cwd": "/p"})
}

#[test]
fn an_owner_archive_checks_the_app_db_and_verifies_the_result() {
    let d = scratch("own");
    let live = Fixture::new().with("archive:ws-1", vec![app_facts("standard", false)]);
    live.archived.borrow_mut().insert("ws-1".into(), true);
    let r = Scripted::new().answers(|_, _| ok(r#"{"archived":true}"#));
    let a = act(&d, &live, &r);
    let rep = a.request("archive", &json!({"id": "ws-1", "request": "r1"}));
    assert_eq!(rep.word, Word::Done, "{:?}", rep.detail);
    assert_eq!(r.actions(), vec![archive_argv("ws-1")]);
    // the same request again is one action
    assert_eq!(a.request("archive", &json!({"id": "ws-1", "request": "r1"})).word, Word::Skipped);
    assert_eq!(r.actions().len(), 1);
    // an app that still lists it open means the archive did not happen
    let live2 = Fixture::new().with("archive:ws-2", vec![app_facts("standard", false)]);
    live2.archived.borrow_mut().insert("ws-2".into(), false);
    let r2 = Scripted::new().answers(|_, _| ok("{}"));
    assert_eq!(act(&d, &live2, &r2).request("archive", &json!({"id": "ws-2", "request": "r2"})).word, Word::Failed);
}

#[test]
fn an_owner_archive_refuses_unsafe_targets_before_any_process() {
    let d = scratch("own-refuse");
    for (id, facts) in [
        ("ws-p", app_facts("primary", false)),
        ("ws-a", app_facts("standard", true)),
        ("ws-u", app_facts("", false)),
        ("primary-abc", app_facts("standard", false)),
        ("-x", app_facts("standard", false)),
        ("", app_facts("standard", false)),
        ("ws-none", json!({"appReadable": false})),
    ] {
        let live = Fixture::new().with(&format!("archive:{id}"), vec![facts]);
        let r = Scripted::new();
        let rep = act(&d, &live, &r).request("archive", &json!({"id": id, "request": "r"}));
        assert_eq!(rep.word, Word::Refused, "{id}: {:?}", rep.detail);
        assert!(r.calls.borrow().is_empty(), "{id}: no process, not even a probe");
    }
}

#[test]
fn an_archive_retries_once_on_the_flaky_confirmation_error_and_rejects_archived_false() {
    let d = scratch("retry");
    let live = Fixture::new().with("archive:ws-1", vec![app_facts("standard", false)]);
    live.archived.borrow_mut().insert("ws-1".into(), true);
    let r = Scripted::new().answers(|_, n| if n == 2 { fail("Could not confirm terminal") } else { ok("{}") });
    let rep = act(&d, &live, &r).request("archive", &json!({"id": "ws-1", "request": "r1"}));
    assert_eq!((rep.word, rep.detail["retried"].as_bool()), (Word::Done, Some(true)));
    let live = Fixture::new().with("archive:ws-1", vec![app_facts("standard", false)]);
    let r = Scripted::new().answers(|_, _| ok(r#"{"archived":false}"#));
    assert_eq!(act(&scratch("retry2"), &live, &r).request("archive", &json!({"id": "ws-1", "request": "r1"})).word, Word::Failed);
}

#[test]
fn create_passes_the_owners_arguments_minus_the_local_flag_then_titles_best_effort() {
    let d = scratch("create");
    let live = Fixture::new();
    let r = Scripted::new();
    let rep =
        act(&d, &live, &r).request("create", &json!({"rest": ["feat/x", "--from-local", "-p", "brief"], "title": "My title", "cwd": "/p", "request": "c1"}));
    assert_eq!(rep.word, Word::Done);
    assert_eq!(r.actions(), vec![vec!["workspace", "create", "feat/x", "-p", "brief"], vec!["workspace", "update-title", "-b", "feat/x", "My title"]]);
    // a refused source check and a missing request id run nothing
    let r2 = Scripted::new();
    let live2 = Fixture::new().with("create:", vec![json!({"sourceCheck": {"refuse": true, "error": "source is behind"}})]);
    assert_eq!(act(&d, &live2, &r2).request("create", &json!({"rest": ["feat/y"], "request": "c2"})).word, Word::Refused);
    assert_eq!(act(&d, &live2, &r2).request("create", &json!({"rest": ["feat/y"]})).word, Word::Refused);
    assert!(r2.actions().is_empty());
}

#[test]
fn merge_runs_check_merge_then_merge_into_source_once_per_request() {
    let d = scratch("merge");
    let live = Fixture::new();
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let q = json!({"rest": ["--squash"], "cwd": "/w", "request": "m1"});
    assert_eq!(a.request("merge", &q).word, Word::Done);
    assert_eq!(a.request("merge", &q).word, Word::Skipped);
    assert_eq!(r.actions(), vec![vec!["workspace", "check-merge"], vec!["workspace", "merge-into-source", "--squash"]]);
}

fn stale_facts(attempts: u64, nudged_at: Option<i64>, nudge: bool) -> Value {
    json!({"id": "ws-1", "status": "stale", "nudgeAttempts": attempts, "nudgedAt": nudged_at, "nudgeArgv": if nudge { json!(["/bin/echo", "wake"]) } else { Value::Null }, "escalateArgv": ["/bin/echo", "help"]})
}

#[test]
fn a_stale_workspace_is_poked_then_escalated_once() {
    let d = scratch("poke");
    let mut live = Fixture::new().with("poke-or-escalate:ws-1", vec![stale_facts(0, None, true)]);
    live.stale = vec!["ws-1".into()];
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let out = a.poke_sweep();
    assert_eq!((out[0].kind.as_str(), out[0].word), ("poke", Word::Done));
    assert_eq!(r.calls.borrow().last().unwrap().bin.as_deref(), Some("/bin/echo"));
    assert_eq!(a.poke_sweep()[0].word, Word::Skipped, "poke:ws-1:1 is done");
    // cooldown not elapsed after one attempt: escalate (not a second poke)
    live.facts.borrow_mut().insert("poke-or-escalate:ws-1".into(), vec![stale_facts(1, Some(NOW - 1000), true)]);
    let e = a.poke_sweep();
    assert_eq!((e[0].kind.as_str(), e[0].word), ("escalate", Word::Done));
    assert_eq!(a.poke_sweep()[0].word, Word::Skipped, "escalate is terminal");
    // attempts exhausted and no nudge command at all: escalate
    let d2 = scratch("poke2");
    let mut live2 = Fixture::new().with("poke-or-escalate:ws-1", vec![stale_facts(2, Some(NOW - 9_999_999), true)]);
    live2.stale = vec!["ws-1".into()];
    assert_eq!(act(&d2, &live2, &Scripted::new()).poke_sweep()[0].kind, "escalate");
    live2.facts.borrow_mut().insert("poke-or-escalate:ws-1".into(), vec![stale_facts(0, None, false)]);
    assert_eq!(act(&d2, &live2, &Scripted::new()).poke_sweep()[0].kind, "escalate");
}

#[test]
fn delete_needs_the_owner_approved_exact_unexpired_plan() {
    let d = scratch("del");
    let mut live = Fixture::new();
    live.prune = vec![json!({"id": "old-1", "eligible": true}), json!({"id": "old-2", "eligible": false}), json!({"id": "old-3", "eligible": true})];
    let row = json!({"appReadable": true, "found": true, "archived": true, "isPrimary": false, "clean": true});
    for id in ["old-1", "old-3"] {
        live.facts.borrow_mut().insert(format!("delete:{id}"), vec![row.clone()]);
    }
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let plan = a.plan_prune(30).unwrap();
    let nonce = plan["nonce"].as_str().unwrap().to_string();
    assert_eq!(plan["eligibleIds"], json!(["old-1", "old-3"]));
    assert!(r.calls.borrow().is_empty(), "the dry run spawns nothing");
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // wrong ids, unknown nonce
    assert_eq!(a.delete_confirmed(&ids(&["old-1"]), &nonce)["ok"], false);
    assert_eq!(a.delete_confirmed(&ids(&["old-1", "old-3"]), "0000000000000000")["ok"], false);
    assert!(r.actions().is_empty());
    // an automated caller is refused and does not consume the plan
    let h = d.join("home").to_string_lossy().into_owned();
    let auto = Act::new(&d.join("home"), &d.join("state"), RequestEnv::from_pairs([("HOME", h), ("ANTIHALL_CALLER", "supervisor".to_string())]), &live, &r);
    assert!(auto.delete_confirmed(&ids(&["old-1", "old-3"]), &nonce)["error"].as_str().unwrap().contains("automated"));
    assert!(r.actions().is_empty());
    // the confirmed run
    let out = a.delete_confirmed(&ids(&["old-3", "old-1"]), &nonce);
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(r.actions(), vec![vec!["workspace", "delete", "old-1"], vec!["workspace", "delete", "old-3"]]);
    assert!(d.join("home/.anti-hall/devswarm/pruned/old-1.json").exists());
    let log = std::fs::read_to_string(d.join("home/.anti-hall/logs/devswarm-prune.ndjson")).unwrap();
    assert_eq!(log.lines().count(), 2);
    // the plan is single use
    assert!(a.delete_confirmed(&ids(&["old-1", "old-3"]), &nonce)["error"].as_str().unwrap().contains("already"));
    assert_eq!(r.actions().len(), 2);
}

#[test]
fn delete_rechecks_every_row_and_an_expired_plan_is_refused() {
    let d = scratch("del2");
    let mut live = Fixture::new();
    live.prune = vec![
        json!({"id": "a", "eligible": true}),
        json!({"id": "b", "eligible": true}),
        json!({"id": "c", "eligible": true}),
        json!({"id": "e", "eligible": true}),
    ];
    let base = json!({"appReadable": true, "found": true, "archived": true, "isPrimary": false, "clean": true});
    let mut dirty = base.clone();
    dirty["clean"] = json!(false);
    let mut unarchived = base.clone();
    unarchived["archived"] = json!(false);
    let mut primary = base.clone();
    primary["isPrimary"] = json!(true);
    for (id, f) in [("a", base.clone()), ("b", dirty), ("c", unarchived), ("e", primary)] {
        live.facts.borrow_mut().insert(format!("delete:{id}"), vec![f]);
    }
    let r = Scripted::new();
    let a = act(&d, &live, &r);
    let plan = a.plan_prune(0).unwrap();
    let nonce = plan["nonce"].as_str().unwrap();
    let all: Vec<String> = ["a", "b", "c", "e"].iter().map(|s| s.to_string()).collect();
    let out = a.delete_confirmed(&all, nonce);
    assert_eq!(r.actions(), vec![vec!["workspace", "delete", "a"]], "{out}");
    assert_eq!(out["results"][1]["refused"], "unclean", "{out}");
    // expiry
    let plan = a.plan_prune(0).unwrap();
    live.now.set(NOW + 16 * 60_000);
    let late = a.delete_confirmed(&all, plan["nonce"].as_str().unwrap());
    assert!(late["error"].as_str().unwrap().contains("expired"), "{late}");
    assert_eq!(r.actions().len(), 1);
}

#[test]
fn a_script_answer_that_breaks_an_invariant_still_runs_nothing() {
    // an owner override of the script returns an archive of an empty id and another verb: the engine's own checks refuse both
    let d = scratch("badscript");
    std::fs::create_dir_all(d.join("home/.anti-hall/logic/act")).unwrap();
    let body = |argv: &str| {
        format!(
            "function decide(p) {{ return {{exact: {{code: 0, out: JSON.stringify({{eligible: true, key: 'k:' + p.request.request, argv: {argv}}}), err: ''}}}}; }}"
        )
    };
    for (i, argv) in [
        r#"['workspace','archive','']"#,
        r#"['workspace','archive']"#,
        r#"['workspace','archive','-x']"#,
        r#"['workspace','nuke','id']"#,
        r#"['rm','-rf','/']"#,
    ]
    .iter()
    .enumerate()
    {
        std::fs::write(d.join("home/.anti-hall/logic/act/devswarm-act.js"), body(argv)).unwrap();
        let live = Fixture::new();
        let r = Scripted::new();
        let rep = act(&d, &live, &r).request("archive", &json!({"id": "x", "request": format!("q{i}")}));
        assert_eq!(rep.word, Word::Unavailable, "{argv}: {:?}", rep.detail);
        assert!(r.actions().is_empty(), "{argv}");
    }
}

#[test]
fn the_real_runner_reports_success_failure_hang_and_missing() {
    let d = scratch("sys");
    let script = |name: &str, body: &str| {
        let p = d.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&p, perm).unwrap();
        p.to_string_lossy().into_owned()
    };
    let spec = |ms: u64| RunSpec { bin: None, args: vec!["workspace".into(), "archive".into(), "i".into()], cwd: None, timeout_ms: ms, ..RunSpec::default() };
    let okb = System { hc: script("ok", "echo '{\"archived\":true}'") };
    let r = okb.run(&spec(5000));
    assert!(r.ok && r.stdout.contains("archived"), "{r:?}");
    let bad = System { hc: script("bad", "echo boom >&2; exit 3") };
    let r = bad.run(&spec(5000));
    assert!(!r.ok && r.status == Some(3) && r.stderr.contains("boom") && !r.missing, "{r:?}");
    let hang = System { hc: script("hang", "exec sleep 30") };
    let t0 = std::time::Instant::now();
    let r = hang.run(&spec(300));
    assert!(r.timed_out && !r.ok, "{r:?}");
    assert!(t0.elapsed() < std::time::Duration::from_secs(10), "the hung child was killed");
    let gone = System { hc: d.join("nope").to_string_lossy().into_owned() };
    assert!(gone.run(&spec(300)).missing);
}

#[test]
fn versions_parse_and_compare() {
    assert_eq!(parse_version("hivecontrol 2.5.3 (build 9)"), Some(vec![2, 5, 3]));
    assert_eq!(parse_version("nothing"), None);
    assert!(at_least(&[2, 5, 3], &[2, 5, 3]) && at_least(&[2, 10, 0], &[2, 5, 3]) && !at_least(&[2, 5, 2], &[2, 5, 3]));
}

#[test]
fn the_comparison_counts_calls_only_one_side_made() {
    let a = vec!["workspace".to_string(), "archive".into(), "x".into()];
    let b = vec!["workspace".to_string(), "archive".into(), "y".into()];
    assert_eq!(super::shadow::compare("t", std::slice::from_ref(&a), std::slice::from_ref(&a))["match"], true);
    let c = super::shadow::compare("t", std::slice::from_ref(&a), std::slice::from_ref(&b));
    assert_eq!((c["match"].clone(), c["onlyEngine"][0][2].clone(), c["onlyNode"][0][2].clone()), (json!(false), json!("x"), json!("y")));
    assert_eq!(super::shadow::compare("t", &[a.clone(), a.clone()], std::slice::from_ref(&a))["onlyEngine"].as_array().unwrap().len(), 1);
}

// ---- DevSwarm expansion: event-driven auto-archive (feature 3), the nag (feature 2), telemetry --------------------------------

mod dsx {
    use super::*;
    use crate::devswarm_rt::state::{Edge, EdgeKind};
    use crate::dsact::events::{Dirty, lock_id};
    use crate::dsact::nag::{Notifier, PendingFile, take_pending};
    use crate::dsact::tele;

    fn edge(ws: &str, kind: EdgeKind) -> Edge {
        Edge { ws: ws.into(), kind, from: "a".into(), to: "b".into(), generation: 1, at_ms: NOW, while_down: false, hold_until_ms: 0 }
    }

    fn events(d: &Path) -> Vec<Value> {
        std::fs::read_to_string(d.join("state/dsact.events")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    fn quick(d: &Path) {
        settings(&d.join("home"), json!({"devswarm": {"autoArchive.eventDebounceMs": 0}}));
    }

    #[test]
    fn an_edge_archives_once_and_the_timer_that_follows_does_not_repeat_it() {
        let d = scratch("dsx-edge");
        quick(&d);
        let live = one_candidate("dsx-e1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        assert_eq!(dirty.mark(&[edge("dsx-e1", EdgeKind::Pr), edge("dsx-e1", EdgeKind::Unread)], NOW), 1, "unread is no event kind");
        let s = a.auto_archive_events(&dirty);
        assert_eq!(s["archived"], json!(["dsx-e1"]), "{s}");
        // the timer sweep and a second edge both come after: nothing more runs
        a.auto_archive_sweep();
        dirty.mark(&[edge("dsx-e1", EdgeKind::Lifecycle)], NOW);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions(), vec![archive_argv("dsx-e1")]);
        let ev = events(&d);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!((ev[0]["feature"].as_str(), ev[0]["trigger"].as_str(), ev[0]["outcome"].as_str()), (Some("auto-archive"), Some("event"), Some("ok")));
        assert_eq!(ev[0]["target"], json!({"id": "dsx-e1", "doneHead": "abc123abc123"}));
        assert!(ev[0]["gates"].as_object().unwrap().values().all(|v| v == "pass") && ev[0]["gates"].as_object().unwrap().len() == 8, "{}", ev[0]["gates"]);
        assert!(ev[0]["latency_ms"].is_u64());
    }

    #[test]
    fn the_timer_first_then_the_edge_is_also_once() {
        let d = scratch("dsx-race");
        quick(&d);
        let live = one_candidate("dsx-r1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        a.auto_archive_sweep();
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-r1", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions().len(), 1);
    }

    #[test]
    fn a_burst_waits_for_the_debounce_and_is_one_look() {
        let d = scratch("dsx-debounce");
        let live = one_candidate("dsx-d1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-d1", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert!(r.actions().is_empty() && dirty.pending() == 1, "default debounce is 2000 ms");
        live.now.set(NOW + 2_500);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions().len(), 1);
        assert_eq!(dirty.pending(), 0);
    }

    #[test]
    fn the_event_trigger_can_be_switched_off_and_the_sweep_still_works() {
        let d = scratch("dsx-off");
        settings(&d.join("home"), json!({"devswarm": {"autoArchive.eventTrigger": false, "autoArchive.eventDebounceMs": 0}}));
        let live = one_candidate("dsx-o1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-o1", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert!(r.actions().is_empty());
        assert!(!a.event_trigger_on());
        assert_eq!(a.auto_archive_sweep()["archived"], json!(["dsx-o1"]));
    }

    #[test]
    fn a_precondition_that_flips_between_the_decision_and_the_act_refuses_and_runs_nothing() {
        let d = scratch("dsx-flip");
        quick(&d);
        let mut dirt = good("dsx-f1");
        dirt["clean"] = json!(false);
        dirt["cleanReason"] = json!("uncommitted-changes");
        let mut live = Fixture::new().with("auto-archive:dsx-f1", vec![good("dsx-f1"), dirt]);
        live.candidates = vec!["dsx-f1".into()];
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-f1", EdgeKind::Activity)], NOW);
        let s = a.auto_archive_events(&dirty);
        assert!(r.actions().is_empty(), "{s}");
        assert_eq!(s["failed"][0]["reason"], "stale");
        let ev = events(&d);
        assert_eq!((ev[0]["outcome"].as_str(), ev[0]["reason"].as_str()), (Some("refused"), Some(crate::defaults::text("devswarm_act.msg_stale"))));
        assert_eq!(ev[0]["gates"]["c-clean"], "uncommitted-changes");
        assert_eq!(Ledger::open(&d.join("state")).state("auto-archive:dsx-f1:abc123abc123"), KeyState::Fresh);
    }

    #[test]
    fn another_trigger_holding_the_workspace_refuses_without_a_call() {
        let d = scratch("dsx-lock");
        quick(&d);
        let live = one_candidate("dsx-l1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-l1", EdgeKind::Pr)], NOW);
        let held = lock_id("dsx-l1").expect("free");
        assert!(lock_id("dsx-l1").is_none(), "the lock is exclusive");
        let s = a.auto_archive_events(&dirty);
        assert!(r.actions().is_empty(), "{s}");
        assert_eq!(events(&d)[0]["outcome"], "refused");
        drop(held);
        dirty.mark(&[edge("dsx-l1", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions().len(), 1, "released: the next edge archives");
    }

    #[test]
    fn max_per_sweep_bounds_the_event_path_and_the_rest_stays_dirty() {
        let d = scratch("dsx-cap");
        settings(&d.join("home"), json!({"devswarm": {"autoArchive.eventDebounceMs": 0, "autoArchive.maxPerSweep": 1}}));
        let mut live = Fixture::new().with("auto-archive:dsx-c1", vec![good("dsx-c1")]).with("auto-archive:dsx-c2", vec![good("dsx-c2")]);
        live.candidates = vec!["dsx-c1".into(), "dsx-c2".into()];
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-c1", EdgeKind::Pr), edge("dsx-c2", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions().len(), 1);
        assert_eq!(dirty.pending(), 1);
        a.auto_archive_events(&dirty);
        assert_eq!(r.actions().len(), 2);
    }

    #[test]
    fn an_archive_the_app_does_not_show_is_a_failed_attempt() {
        let d = scratch("dsx-verify");
        quick(&d);
        let live = one_candidate("dsx-v1");
        live.archived.borrow_mut().insert("dsx-v1".into(), false);
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-v1", EdgeKind::Pr)], NOW);
        let s = a.auto_archive_events(&dirty);
        assert_eq!(s["archived"], json!([]), "{s}");
        assert_eq!(events(&d)[0]["outcome"], "failed");
    }

    #[test]
    fn mistake_signals_are_recorded_once_and_counted() {
        let d = scratch("dsx-mistake");
        quick(&d);
        let live = one_candidate("dsx-m1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let dirty = Dirty::new();
        dirty.mark(&[edge("dsx-m1", EdgeKind::Pr)], NOW);
        a.auto_archive_events(&dirty);
        assert_eq!(a.mistake_scan(), 0, "nothing wrong yet");
        live.archived.borrow_mut().insert("dsx-m1".into(), false); // the owner unarchived it
        live.post.borrow_mut().insert("dsx-m1".into(), json!({"head": "def456", "activityMs": NOW}));
        live.now.set(NOW + 3_600_000);
        assert_eq!(a.mistake_scan(), 2, "unarchived + new commits");
        assert_eq!(a.mistake_scan(), 0, "each signal once");
        let mut m = crate::metrics::Metrics::default();
        a.tele().publish(&mut m);
        assert_eq!(m.counter("dsx_actions", &[("feature", "auto-archive"), ("outcome", "ok")]), 1);
        assert_eq!(m.counter("dsx_mistakes", &[("feature", "auto-archive"), ("signal", "unarchived")]), 1);
        assert_eq!(m.counter_total("dsx_mistakes"), 2);
        // the shared schema: the archive went through execute (one act event), the mistakes are `mistake` events about its key
        let q = crate::telemetry::emit::take_queued();
        let kinds = |k: crate::telemetry::event::Kind| q.iter().filter(|e| e.kind == k && e.h.as_str() == "auto-archive").count();
        assert_eq!((kinds(crate::telemetry::event::Kind::Act), kinds(crate::telemetry::event::Kind::Mistake)), (1, 2), "{q:?}");
        let rep = tele::report(&d.join("state"));
        assert_eq!((rep["auto-archive"]["ok"].as_u64(), rep["auto-archive"]["mistakes"].as_u64()), (Some(1), Some(2)));
        assert_eq!(rep["auto-archive"]["mistake_rate"], json!(2.0));
        assert_eq!(rep["auto-archive"]["success_rate"], json!(1.0));
    }

    // ---- nag ----

    struct Rec(RefCell<Vec<String>>, bool);
    impl Notifier for Rec {
        fn notify(&self, text: &str) -> Result<(), String> {
            if self.1 {
                return Err("no channel".into());
            }
            self.0.borrow_mut().push(text.to_string());
            Ok(())
        }
    }
    fn rec() -> Rec {
        Rec(RefCell::new(vec![]), false)
    }

    fn nag_live(id: &str) -> Fixture {
        let mut f = good(id);
        f["lifecycle"] = json!("active");
        let mut live = Fixture::new().with(&format!("nag:{id}"), vec![f]);
        live.candidates = vec![id.into()];
        live
    }

    #[test]
    fn a_done_workspace_gets_an_edge_nag_then_digests_on_the_cadence() {
        let d = scratch("dsx-nag1");
        settings(&d.join("home"), json!({"devswarm": {"nag.everyMs": 60000}}));
        let live = nag_live("nag-1");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let n = rec();
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 1);
        assert!(n.0.borrow()[0].contains("nag-1") && n.0.borrow()[0].contains("--id nag-1"), "{:?}", n.0);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 1, "not due yet");
        live.now.set(NOW + 61_000);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 2);
        assert!(n.0.borrow()[1].starts_with("still open"), "{:?}", n.0);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 2, "one digest per bucket");
        assert!(r.actions().is_empty(), "a nag acts on nothing");
        let ev = events(&d);
        assert_eq!(ev.iter().filter(|e| e["feature"] == "nag" && e["outcome"] == "ok").count(), 2);
    }

    #[test]
    fn the_hourly_cap_holds_back_a_due_digest_and_says_so() {
        let d = scratch("dsx-nag2");
        settings(&d.join("home"), json!({"devswarm": {"nag.everyMs": 1000, "nag.hourlyCap": 1}}));
        let live = nag_live("nag-2");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let n = rec();
        a.nag_tick(&n);
        live.now.set(NOW + 5_000);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 1);
        assert!(events(&d).iter().any(|e| e["outcome"] == "refused" && e["reason"] == "hourly-cap"));
        live.now.set(NOW + 3_700_000);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 2, "the hour has passed");
    }

    #[test]
    fn archived_closed_or_auto_archive_owned_workspaces_are_never_nagged() {
        let d = scratch("dsx-nag3");
        // closed: the facts say the lifecycle is not active
        let mut f = good("nag-3");
        f["lifecycle"] = json!("inactive");
        let mut live = Fixture::new().with("nag:nag-3", vec![f]);
        live.candidates = vec!["nag-3".into()];
        let r = Scripted::new();
        let n = rec();
        act(&d, &live, &r).nag_tick(&n);
        assert!(n.0.borrow().is_empty());
        // owned by auto-archive: Node's owned-ids file
        let d2 = scratch("dsx-nag3b");
        std::fs::create_dir_all(d2.join("home/.anti-hall/devswarm")).unwrap();
        std::fs::write(d2.join("home/.anti-hall/devswarm/auto-archive-state.json"), json!({"at": 1, "owned": ["nag-4"]}).to_string()).unwrap();
        let live2 = nag_live("nag-4");
        act(&d2, &live2, &r).nag_tick(&n);
        assert!(n.0.borrow().is_empty(), "auto-archive owns it");
        // not done (unread mail): silent
        let d3 = scratch("dsx-nag3c");
        let mut g = good("nag-5");
        g["lifecycle"] = json!("active");
        g["unread"]["toChild"] = json!(2);
        let mut live3 = Fixture::new().with("nag:nag-5", vec![g]);
        live3.candidates = vec!["nag-5".into()];
        act(&d3, &live3, &r).nag_tick(&n);
        assert!(n.0.borrow().is_empty());
    }

    #[test]
    fn a_nagged_workspace_that_gets_archived_counts_as_resolved_and_is_not_nagged_again() {
        let d = scratch("dsx-nag4");
        let mut live = nag_live("nag-6");
        let r = Scripted::new();
        let n = rec();
        act(&d, &live, &r).nag_tick(&n);
        live.candidates.clear(); // archived or closed since
        live.now.set(NOW + 10_000_000);
        act(&d, &live, &r).nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 1);
        let ev = events(&d);
        assert!(ev.iter().any(|e| e["feature"] == "nag" && e["action"] == "resolved" && e["outcome"] == "ok"), "{ev:?}");
    }

    #[test]
    fn a_nag_ignored_for_the_configured_cycles_is_a_mistake_signal_once() {
        let d = scratch("dsx-nag5");
        settings(&d.join("home"), json!({"devswarm": {"nag.everyMs": 1000, "nag.hourlyCap": 1000}}));
        let live = nag_live("nag-7");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        let n = rec();
        let cycles = crate::defaults::num("devswarm_act.nag_ignored_cycles");
        for i in 0..cycles + 3 {
            live.now.set(NOW + 2_000 * i as i64);
            a.nag_tick(&n);
        }
        let m = events(&d).iter().filter(|e| e["type"] == "mistake" && e["signal"] == "nag-ignored").count();
        assert_eq!(m, 1);
    }

    #[test]
    fn a_failed_delivery_is_a_failed_attempt_and_is_tried_again_after_the_backoff() {
        let d = scratch("dsx-nag6");
        let live = nag_live("nag-8");
        let r = Scripted::new();
        let a = act(&d, &live, &r);
        a.nag_tick(&Rec(RefCell::new(vec![]), true));
        assert!(events(&d).iter().any(|e| e["feature"] == "nag" && e["outcome"] == "failed"));
        let n = rec();
        live.now.set(NOW + 120_000);
        a.nag_tick(&n);
        assert_eq!(n.0.borrow().len(), 1);
    }

    #[test]
    fn queued_nags_reach_the_primary_once() {
        let d = scratch("dsx-nag7");
        let p = PendingFile(d.join("state"));
        p.notify("one").unwrap();
        p.notify("two").unwrap();
        assert_eq!(take_pending(&d.join("state")).as_deref(), Some("one\ntwo"));
        assert_eq!(take_pending(&d.join("state")), None);
    }
}
