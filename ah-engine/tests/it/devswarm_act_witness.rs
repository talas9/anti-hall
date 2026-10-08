//! The Node witness of the DevSwarm action layer. For each trigger the REAL Node lifecycle (`autoArchiveSweep`) runs in a scratch
//! home with a recording stub `hivecontrol` first on the PATH (the stub performs nothing; it appends the requested call to a
//! file), fed the same facts as the engine's fixture live state. The engine acts through its own bounded runner on the same stub.
//! The calls each side requested are compared per trigger (`dsact::shadow`). The double-run guard tests prove that Node and
//! the engine can never both act on one (workspace, HEAD): through Node's own gate (h) file in both directions, and through
//! Node's mode switch. Homes are isolated; the real `~/.anti-hall` is never touched.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::dsact::exec::Act;
use ah_engine::dsact::live::LiveState;
use ah_engine::dsact::runner::System;
use ah_engine::dsact::shadow;
use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);
const NOW: i64 = 1_800_000_000_000;
const HEAD: &str = "abc123abc123abc123abc123abc123abc123abcd";

/// One scenario: per workspace, which gate (if any) is broken.
#[derive(Clone)]
struct Ws {
    id: String,
    flaw: &'static str,
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

struct World {
    dir: PathBuf,
    home: PathBuf,
    state: PathBuf,
    stubdir: PathBuf,
    record: PathBuf,
}

fn world(tag: &str) -> World {
    ah_engine::defaults::init().unwrap();
    let dir = std::env::temp_dir().join(format!("ah-dsw-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _gone = std::fs::remove_dir_all(&dir);
    let w = World { home: dir.join("home"), state: dir.join("state"), stubdir: dir.join("bin"), record: dir.join("record.ndjson"), dir };
    for d in [&w.home, &w.state, &w.stubdir, &w.dir.join("wt/primary")] {
        std::fs::create_dir_all(d).unwrap();
    }
    let stub = w.stubdir.join("hivecontrol");
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\ncase \"$1\" in --version) echo 'hivecontrol 2.5.3'; exit 0;; esac\nprintf '{{\"args\":[%s],\"cwd\":\"%s\"}}\\n' \"$(printf '\"%s\",' \"$@\" | sed 's/,$//')\" \"$PWD\" >> '{}'\necho '{{\"archived\":true}}'\n",
            w.record.display()
        ),
    )
    .unwrap();
    let mut perm = std::fs::metadata(&stub).unwrap().permissions();
    perm.set_mode(0o755);
    std::fs::set_permissions(&stub, perm).unwrap();
    w
}

fn facts_for(w: &World, ws: &Ws) -> Value {
    let flaw = ws.flaw;
    let mut f = json!({"id": ws.id, "label": "L", "branch": format!("b/{}", ws.id), "worktreePath": w.dir.join("wt").join(&ws.id).to_string_lossy(),
        "primaryCwd": w.dir.join("wt/primary").to_string_lossy(), "isPrimary": false, "hasSummary": true, "head": HEAD,
        "done": {"done": true, "via": "done-report", "boundToHead": true}, "merged": {"merged": true, "via": "git:origin/main"}, "clean": true,
        "unread": {"toChild": 0, "toDirect": 0, "toBroadcast": 0, "fromChild": 0}, "hasLastSelected": true, "lastSelectedAt": null,
        "idle": {"ts": NOW - 7_200_000, "via": "activity", "openRealTurn": false, "pendingBackground": false}});
    match flaw {
        "dirty" => f["clean"] = json!(false),
        "unread" => f["unread"]["toChild"] = json!(2),
        "recent" => f["idle"]["ts"] = json!(NOW - 60_000),
        "unmerged" => f["merged"] = json!({"merged": false, "via": "git:not-ancestor"}),
        "primary" => f["isPrimary"] = json!(true),
        "notdone" => f["done"] = json!({"done": false, "via": null}),
        _ => {}
    }
    f
}

struct Live {
    cands: Vec<Ws>,
    facts: std::collections::HashMap<String, Value>,
}

impl LiveState for Live {
    fn present(&self) -> bool {
        true
    }
    fn now_ms(&self) -> i64 {
        NOW
    }
    fn candidates(&self) -> Vec<String> {
        self.cands.iter().map(|c| c.id.clone()).collect()
    }
    fn stale(&self) -> Vec<String> {
        vec![]
    }
    fn facts(&self, _kind: &str, id: &str) -> Option<Value> {
        self.facts.get(id).cloned()
    }
    fn archived(&self, _id: &str) -> Option<bool> {
        None
    }
    fn prune_rows(&self, _days: u64) -> Vec<Value> {
        vec![]
    }
}

fn live(w: &World, cands: &[Ws]) -> Live {
    Live { cands: cands.to_vec(), facts: cands.iter().map(|c| (c.id.clone(), facts_for(w, c))).collect() }
}

fn settings(w: &World, v: Value) {
    std::fs::create_dir_all(w.home.join(".anti-hall")).unwrap();
    std::fs::write(w.home.join(".anti-hall/settings.json"), v.to_string()).unwrap();
}

/// The real Node `autoArchiveSweep`, with sources derived from the same scenario and the stub hivecontrol on the PATH.
fn node_sweep(w: &World, cands: &[Ws]) -> Value {
    for c in cands {
        std::fs::create_dir_all(w.dir.join("wt").join(&c.id)).unwrap();
    }
    let sc: Vec<Value> = cands.iter().map(|c| json!({"id": c.id, "flaw": c.flaw})).collect();
    let script = r#"
const fs = require('fs'); const path = require('path');
const P = process.env.PLUGIN, W = process.env.WORLD, HEAD = process.env.HEAD, NOW = Number(process.env.NOW);
const sc = JSON.parse(process.env.SCENARIO);
const lc = require(P + '/companion/lib/devswarm-lifecycle.js');
const pull = require(P + '/companion/lib/devswarm-pull.js');
const flaw = (wt) => (sc.find((c) => wt === path.join(W, 'wt', c.id)) || {}).flaw;
const builders = [{ id: 'primary-b', repositoryId: 'r', branchName: 'main', worktreePath: path.join(W, 'wt/primary'), builderType: 'primary', isActive: 1, isHidden: 0, label: 'P' }]
  .concat(sc.map((c) => ({ id: c.id, repositoryId: 'r', branchName: 'b/' + c.id, worktreePath: path.join(W, 'wt', c.id), builderType: c.flaw === 'primary' ? 'primary' : 'standard', isActive: 1, isHidden: 0, lastSelectedAt: null, label: 'L' })));
const git = (cwd, a) => {
  const k = a.join(' '); const fl = flaw(cwd);
  if (k === 'rev-parse HEAD') return { ok: true, status: 0, out: HEAD + '\n' };
  if (k === 'status --porcelain') return { ok: true, status: 0, out: fl === 'dirty' ? ' M f\n' : '' };
  if (k === 'symbolic-ref refs/remotes/origin/HEAD') return { ok: true, status: 0, out: 'refs/remotes/origin/main\n' };
  if (a[0] === 'rev-parse' && a[1] === '--verify') return { ok: true, status: 0, out: 'x\n' };
  if (a[0] === 'merge-base') return { ok: fl !== 'unmerged', status: fl === 'unmerged' ? 1 : 0, out: '' };
  if (a[0] === 'log') return { ok: true, status: 0, out: '0\n' };
  return { ok: false, status: 1, out: '' };
};
const summary = { workspaces: Object.fromEntries(sc.map((c) => [c.id, { id: c.id, unread: c.flaw === 'unread' ? 2 : 0, broadcastUnread: 0, gates: { done: c.flaw !== 'notdone' }, doneHead: c.flaw === 'notdone' ? undefined : HEAD }])) };
const deps = {
  appDb: () => ({ builders, prs: [], hasLastSelected: true, hasBuilderType: true }), git, repoKey: () => 'rk', summary: () => summary,
  unreadFrom: () => 0, activityTs: () => (sc.length ? NOW - (sc.some((c) => c.flaw === 'recent') ? 60000 : 7200000) : null),
  realActivity: () => ({ known: false }), lastInboundTs: () => 0, descriptors: () => sc.map((c) => ({ id: c.id, worktreePath: path.join(W, 'wt', c.id) })),
  can: () => ({ ok: true, version: '2.5.3' }), run: (spec) => pull.defaultRun(spec), notifyPrimary: () => 'ok',
};
const r = lc.autoArchiveSweep({ home: process.env.HOME, env: process.env, deps, now: NOW });
process.stdout.write(JSON.stringify(r));
"#;
    let out = Command::new("node")
        .arg("-e")
        .arg(script)
        .env_clear()
        .env("HOME", &w.home)
        .env("USERPROFILE", &w.home)
        .env("PATH", format!("{}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", w.stubdir.display()))
        .env("PLUGIN", plugin())
        .env("WORLD", &w.dir)
        .env("HEAD", HEAD)
        .env("NOW", NOW.to_string())
        .env("SCENARIO", Value::Array(sc).to_string())
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .output()
        .expect("node");
    assert!(out.status.success(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn recorded(w: &World) -> Vec<Vec<String>> {
    shadow::node_actions(&w.record).iter().map(|a| a["args"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()).collect()
}

fn engine_sweep(w: &World, cands: &[Ws]) -> Value {
    let l = live(w, cands);
    let r = System { hc: w.stubdir.join("hivecontrol").to_string_lossy().into_owned() };
    let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    Act::new(&w.home, &w.state, env, &l, &r).auto_archive_sweep()
}

fn ws(id: &str, flaw: &'static str) -> Ws {
    Ws { id: id.into(), flaw }
}

/// Run Node (witness, scratch home A) and the engine (scratch home B) on one scenario; the calls each requested must match.
fn witness(tag: &str, trigger: &str, cands: &[Ws], set: Option<Value>) -> (Vec<Vec<String>>, Vec<Vec<String>>) {
    let (wn, we) = (world(&format!("{tag}-node")), world(&format!("{tag}-eng")));
    if let Some(s) = &set {
        settings(&wn, s.clone());
        settings(&we, s.clone());
    }
    node_sweep(&wn, cands);
    for c in cands {
        std::fs::create_dir_all(we.dir.join("wt").join(&c.id)).unwrap();
    }
    engine_sweep(&we, cands);
    // the stub paths differ per world only by the primary worktree; compare the calls with those paths removed
    let (n, e) = (recorded(&wn), recorded(&we));
    let cmp = shadow::record(&we.state, NOW, trigger, &e, &n);
    assert_eq!(cmp["match"], true, "{trigger}: {cmp}");
    let line = std::fs::read_to_string(we.state.join("dsact.shadow")).unwrap();
    assert!(line.contains(trigger));
    (e, n)
}

#[test]
fn the_engine_requests_what_node_requests_for_an_eligible_workspace() {
    let (e, n) = witness("elig", "auto-archive eligible", &[ws("ws-1", "")], None);
    assert_eq!(e, vec![vec!["workspace", "archive", "ws-1"]]);
    assert_eq!(e, n);
}

#[test]
fn every_blocked_trigger_requests_nothing_on_both_sides() {
    for flaw in ["dirty", "unread", "recent", "unmerged", "primary", "notdone"] {
        let (e, n) = witness(&format!("blk-{flaw}"), &format!("auto-archive {flaw}"), &[ws("ws-1", flaw)], None);
        assert!(e.is_empty() && n.is_empty(), "{flaw}: engine {e:?} node {n:?}");
    }
}

#[test]
fn a_mixed_sweep_and_the_per_sweep_cap_agree() {
    let c = [ws("a", ""), ws("b", "dirty"), ws("c", ""), ws("d", ""), ws("e", "")];
    let (e, n) = witness("mixed", "auto-archive mixed", &c, None);
    assert_eq!(e.len(), 3, "default maxPerSweep is 3");
    assert_eq!(e, n);
    let (e, n) = witness("cap", "auto-archive cap 2", &c, Some(json!({"devswarm": {"autoArchive": {"maxPerSweep": 2}}})));
    assert_eq!((e.len(), e), (2, n));
}

#[test]
fn dry_run_and_off_request_nothing_on_both_sides() {
    for mode in ["dry-run", "off"] {
        let (e, n) =
            witness(&format!("m-{mode}"), &format!("auto-archive {mode}"), &[ws("ws-1", "")], Some(json!({"devswarm": {"autoArchive": {"mode": mode}}})));
        assert!(e.is_empty() && n.is_empty(), "{mode}");
    }
}

#[test]
fn double_run_guard_engine_first_then_node_in_the_same_home() {
    let w = world("dbl-a");
    let c = [ws("ws-1", "")];
    for x in &c {
        std::fs::create_dir_all(w.dir.join("wt").join(&x.id)).unwrap();
    }
    engine_sweep(&w, &c);
    assert_eq!(recorded(&w).len(), 1, "the engine archived once");
    // Node's mode is still "on": its own gate (h) reads the durable file the engine wrote and refuses
    let n = node_sweep(&w, &c);
    assert_eq!(recorded(&w).len(), 1, "Node must not archive what the engine archived: {n}");
    // and the engine again: the ledger and the file refuse
    engine_sweep(&w, &c);
    assert_eq!(recorded(&w).len(), 1);
}

#[test]
fn double_run_guard_node_first_then_engine_in_the_same_home() {
    let w = world("dbl-b");
    let c = [ws("ws-1", "")];
    node_sweep(&w, &c);
    assert_eq!(recorded(&w).len(), 1, "Node archived once");
    let s = engine_sweep(&w, &c);
    assert_eq!(recorded(&w).len(), 1, "the engine must not archive what Node archived: {s}");
    assert_eq!(s["plan"][0]["blockers"][0]["gate"], "h-rearchive");
}

#[test]
fn with_the_node_actor_switched_off_only_the_engine_acts() {
    let w = world("dbl-c");
    settings(&w, json!({"devswarm": {"autoArchive": {"mode": "off"}}}));
    let c = [ws("ws-1", "")];
    for x in &c {
        std::fs::create_dir_all(w.dir.join("wt").join(&x.id)).unwrap();
    }
    // Node's switch is the same setting the engine reads as policy: here Node is off and so the engine is too; the cutover sets
    // Node's mode off through the supervisor's environment (the plist) and keeps the policy setting on for the engine
    let n = node_sweep(&w, &c);
    assert_eq!(n["mode"], "off");
    assert!(recorded(&w).is_empty());
    let s = {
        let l = live(&w, &c);
        let r = System { hc: w.stubdir.join("hivecontrol").to_string_lossy().into_owned() };
        let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned()), ("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE", "on".to_string())]);
        Act::new(&w.home, &w.state, env, &l, &r).auto_archive_sweep()
    };
    assert_eq!(s["archived"], json!(["ws-1"]), "{s}");
    assert_eq!(recorded(&w).len(), 1);
}
