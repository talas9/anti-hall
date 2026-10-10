//! The native ingest drain (lane l7b) against the Node ingest daemon's own code: the batch parser, the dedupe hash and the rows of
//! a batch for a corpus of monitor outputs; the delivery WAL in both directions; the breaker ladders; the single-consumer lock in
//! both directions; and the drain end to end against a stub `hivecontrol` on a scratch home with a git repository and a store
//! Node created. Real `node` runs only in a scratch HOME. Nothing reads or writes the real home.
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::ingest::drain::{Drainer, Project, Start};
use ah_engine::dssup::ingest::import::{self, Refused};
use ah_engine::dssup::ingest::monitor::{Breaker, Poll};
use ah_engine::dssup::ingest::wal;
use ah_engine::meshw::store::MeshStore;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn have_node() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).output().is_ok_and(|o| o.status.success())
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall")
}

fn git(args: &[&str], cwd: &Path) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}");
}

/// Run a Node snippet with the plugin root and `args` after it; the last stdout line is JSON.
fn node(code: &str, args: &[&str]) -> Value {
    let o = Command::new("node").args(["-e", code]).arg(plugin()).args(args).env("ANTIHALL_TEST_ISOLATION", "1").output().unwrap();
    assert!(o.status.success(), "node: {}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("null")).unwrap_or(Value::Null)
}

struct Ix {
    _t: TempDir,
    home: PathBuf,
    main: PathBuf,
    state: PathBuf,
    project: Project,
    stub: PathBuf,
    queue: PathBuf,
    log: PathBuf,
}

/// A scratch home with a git repo, a store Node created with the Primary registered, and a stub hivecontrol that prints the next
/// queued file (one per call) and logs `cwd|args|DEVSWARM_BUILDER_ID`.
fn ix(tag: &str) -> Ix {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let root = std::fs::canonicalize(&t.0).unwrap();
    let (home, main, state) = (root.join("home"), root.join("repo"), root.join("state"));
    for d in [&home, &main, &state] {
        std::fs::create_dir_all(d).unwrap();
    }
    git(&["init", "-q"], &main);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &main);
    let project = Project::resolve(main.to_str().unwrap()).unwrap();
    // the store, written by Node's own code, with the Primary registered the way `register-primary` does
    node(
        "const S=require(process.argv[1]+'/companion/lib/devswarm-store.js');const s=S.openStore({home:process.argv[2],hash:process.argv[3]});s.upsertRegistry({id:process.argv[4],worktreePath:process.argv[5],sessionId:'sess-primary',inboxPath:'/x/inbox',cursorPath:'/x/cursor',nudgeCommand:['hivecontrol','nudge']});s.close();console.log(1)",
        &[home.to_str().unwrap(), &project.repo_key, &project.workspace_id, main.to_str().unwrap()],
    );
    let (stub, queue, log) = (root.join("hivecontrol"), root.join("queue"), root.join("calls.log"));
    std::fs::create_dir_all(&queue).unwrap();
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\necho \"$PWD|$*|${{DEVSWARM_BUILDER_ID:-unset}}\" >> '{}'\nf=$(ls '{}' 2>/dev/null | sort | head -1)\nif [ -n \"$f\" ]; then cat '{}'/\"$f\"; rm -f '{}'/\"$f\"; fi\n",
            log.display(),
            queue.display(),
            queue.display(),
            queue.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    Ix { _t: t, home, main, state, project, stub, queue, log }
}

fn st(x: &Ix) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), x.home.to_string_lossy().into_owned());
    env.insert("ANTIHALL_DEVSWARM_HIVECONTROL".into(), x.stub.to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap());
    Settings { home: x.home.to_string_lossy().into_owned(), env }
}

fn enqueue(x: &Ix, name: &str, raw: &str) {
    std::fs::write(x.queue.join(name), raw).unwrap();
}

fn dev(x: &Ix) -> PathBuf {
    x.home.join(".anti-hall/devswarm")
}

fn db(x: &Ix) -> PathBuf {
    dev(x).join("store").join(&x.project.repo_key).join("devswarm.db")
}

/// `(workspace_id, ts, hash, body)` of every native row, in insert order.
fn rows(x: &Ix) -> Vec<(String, i64, String, String)> {
    let c = rusqlite::Connection::open_with_flags(db(x), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut st = c.prepare("SELECT workspace_id, ts, hash, body FROM messages WHERE hash LIKE 'native:%' ORDER BY id").unwrap();
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().flatten().collect()
}

fn now() -> i64 {
    ah_engine::health::now_ms() as i64
}

// ---- the batch: parse, hash, rows against Node -----------------------------------------------------------------------------

const MSG: &str = r#"{"fromBranch":"feat-a","toBranch":"main","message":"hello there","status":"unread","createdAt":"2026-10-09T01:02:03.456Z"}"#;

fn corpus() -> Vec<String> {
    vec![
        format!("[{MSG}]"),
        format!("{{\"messages\":[{MSG},{MSG}]}}"),
        format!("{{\"data\":[{MSG}]}}"),
        MSG.to_string(),
        "[]".into(),
        "{\"messages\":[]}".into(),
        "{\"data\":[]}".into(),
        "   \n".into(),
        "not json at all".into(),
        "{\"foo\":1}".into(),
        "{\"messages\":\"nope\"}".into(),
        "42".into(),
        "[1,\"x\",null,{\"message\":\"only the object\"}]".into(),
        // no createdAt: the hash folds in the canonical JSON, whatever the key order or nesting
        r#"[{"message":"héllo ✓ 😀","n":1.5,"arr":[1,null,"x",true],"z":{"b":1,"a":2,"10":3,"9":4}}]"#.into(),
        r#"[{"z":{"a":2,"b":1,"9":4,"10":3},"arr":[1,null,"x",true],"n":1.5,"message":"héllo ✓ 😀"}]"#.into(),
        r#"[{"message":null,"fromBranch":"a"}]"#.into(),
        r#"[{"toBranch":"b","message":12345,"status":false,"createdAt":null}]"#.into(),
        // createdAt forms
        r#"[{"message":"a","createdAt":"2026-10-09T01:02:03Z"}]"#.into(),
        r#"[{"message":"b","createdAt":"2026-10-09T05:02:03.5+04:00"}]"#.into(),
        r#"[{"message":"c","createdAt":"2026-10-09"}]"#.into(),
        r#"[{"message":"d","createdAt":"yesterday-ish"}]"#.into(),
        r#"[{"message":"e","createdAt":1790000000000}]"#.into(),
        r#"[{"message":"f","createdAt":""}]"#.into(),
        // a message that is an array element
        r#"[["nested","array"],{"message":"after"}]"#.into(),
    ]
}

#[test]
fn the_batch_parser_the_hash_and_the_rows_are_nodes() {
    if !have_node() {
        return;
    }
    let ws = "primary-0123abcd";
    let fixed_now = 1_790_000_123_456i64;
    let cases = corpus();
    let mine: Vec<Value> = cases
        .iter()
        .map(|raw| {
            let b = import::parse_batch(raw);
            let rows = import::rows(ws, &b, fixed_now);
            let lossy = rows.is_empty() && !raw.trim().is_empty() && !b.recognized;
            json!({"total": rows.len(), "lossy": lossy, "recognized": b.recognized,
                   "rows": rows.iter().map(|r| json!({"hash": r.hash, "ts": r.ts, "body": r.body})).collect::<Vec<_>>()})
        })
        .collect();
    let input = serde_json::to_string(&cases).unwrap();
    let theirs = node(
        "const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const cases=JSON.parse(process.argv[2]);const ws=process.argv[3];const now=Number(process.argv[4]);console.log(JSON.stringify(cases.map((raw)=>{const p=(function(){let t=raw.trim();if(t==='')return{messages:[],recognized:true};let v;try{v=JSON.parse(t)}catch(e){return{messages:[],recognized:false}}return null})();const msgs=I.normalizeMonitorPayload(raw);const rows=msgs.map((m)=>{const t=Date.parse(m.createdAt);return{hash:I.messageHash(ws,m),ts:Number.isFinite(t)?t:now,body:m.message!=null?String(m.message):I.stableJson(m)}});const lossy=msgs.length===0&&I.rawIsSubstantive(raw)&&!(function(){try{const t=raw.trim();if(t==='')return true;const v=JSON.parse(t);if(Array.isArray(v))return true;if(v&&typeof v==='object'){if(Array.isArray(v.messages)||Array.isArray(v.data))return true;if('message' in v||'fromBranch' in v||'toBranch' in v)return true}return false}catch(e){return false}})();return{total:msgs.length,lossy,rows}})))",
        &[&input, ws, &fixed_now.to_string()],
    );
    let theirs = theirs.as_array().unwrap();
    for (i, raw) in cases.iter().enumerate() {
        assert_eq!(mine[i]["total"], theirs[i]["total"], "case {i}: {raw}");
        assert_eq!(mine[i]["lossy"], theirs[i]["lossy"], "case {i}: {raw}");
        assert_eq!(mine[i]["rows"], theirs[i]["rows"], "case {i}: {raw}");
    }
    // the corpus is not vacuous: messages with and without createdAt, and the unrecognised shapes
    assert!(mine.iter().any(|m| m["total"].as_u64().unwrap() >= 2));
    assert!(mine.iter().filter(|m| m["lossy"] == true).count() >= 4);
    // key order never changes a hash
    assert_eq!(mine[13]["rows"], mine[14]["rows"]);
}

// ---- the WAL, in both directions -----------------------------------------------------------------------------------------------

#[test]
fn the_wal_is_nodes_format_and_each_side_reads_the_others() {
    if !have_node() {
        return;
    }
    let t = TempDir::new("wal");
    let root = std::fs::canonicalize(&t.0).unwrap();
    let home = root.join("home");
    let devroot = home.join(".anti-hall/devswarm");
    let file = wal::wal_path(&devroot, "monitor", "proj-abc123");
    assert_eq!(file, devroot.join("wal/monitor-proj-abc123.ndjson"));
    assert_eq!(wal::wal_path(&devroot, "monitor", "we ird/key"), devroot.join("wal/monitor-we_ird_key.ndjson"));
    // the engine writes: a batch with a raw that needs escaping, a worktree, and a closed one
    let raw = "[{\"message\":\"line1\\nline2 \\\"q\\\" é\"}]\n";
    let e1 = wal::append_batch(&file, raw, 1000, Some("/wt/main"), None).unwrap();
    let e2 = wal::append_batch(&file, "second", 1001, None, None).unwrap();
    wal::close_batch(&file, &e2, "done", "\"inserted\":2,\"duplicate\":0", 1002).unwrap();
    let e3 = wal::append_batch(&file, "third", 1003, Some("/wt/main"), None).unwrap();
    wal::close_batch(&file, &e3, "quarantine", "\"reason\":\"unparseable\"", 1004).unwrap();
    let args = [home.to_str().unwrap()];
    let js = "process.env.HOME=process.argv[2];const W=require(process.argv[1]+'/companion/lib/devswarm-read-wal.js');const fs=require('fs');const f=W.walPath(process.argv[2],'monitor','proj-abc123');console.log(JSON.stringify({path:f,open:W.pending(fs,f).map((b)=>({e:b.e,raw:b.raw,ts:b.ts,worktree:b.worktree}))}))";
    let seen = node(js, &args);
    assert_eq!(seen["path"], file.to_string_lossy().as_ref());
    assert_eq!(seen["open"], json!([{"e": e1, "raw": raw, "ts": 1000, "worktree": "/wt/main"}]), "Node sees exactly the open batch");
    // Node writes (append + close), the engine reads
    let wrote = node(
        "process.env.HOME=process.argv[2];const W=require(process.argv[1]+'/companion/lib/devswarm-read-wal.js');const fs=require('fs');const f=W.walPath(process.argv[2],'monitor','proj-abc123');const a=W.appendBatch(fs,f,'from node \"x\"\\n',2000,{worktree:'/wt/other'});const b=W.appendBatch(fs,f,'closed by node',2001,{});W.closeBatch(fs,f,b,{t:'done',inserted:1,duplicate:0},2002);console.log(JSON.stringify({a}))",
        &args,
    );
    let open = wal::pending(&file).unwrap();
    assert_eq!(open.iter().map(|b| b.raw.as_str()).collect::<Vec<_>>(), [raw, "from node \"x\"\n"]);
    assert_eq!(open[1].e, wrote["a"].as_str().unwrap());
    assert_eq!(open[1].worktree.as_deref(), Some("/wt/other"));
    // a torn last line never glues onto the next record
    std::fs::write(&file, format!("{}{{\"t\":\"batch\",\"e\":\"torn", std::fs::read_to_string(&file).unwrap())).unwrap();
    let e4 = wal::append_batch(&file, "after the tear", 3000, None, None).unwrap();
    let open = wal::pending(&file).unwrap();
    assert!(open.iter().any(|b| b.e == e4 && b.raw == "after the tear"));
    assert_eq!(node(js, &args)["open"].as_array().unwrap().iter().filter(|b| b["e"] == e4.as_str()).count(), 1);
    // an unreadable file is an error, never "nothing pending"; an absent one is none
    assert!(wal::pending(&devroot.join("wal/none.ndjson")).unwrap().is_empty());
    // spill and absorb: the engine's spill file is absorbed by the engine, and Node's pending() sees the batch afterwards
    let sp = wal::spill_dir(&file);
    std::fs::create_dir_all(&sp).unwrap();
    std::fs::write(sp.join("spilled-1.json"), json!({"e": "spilled-1", "ts": 4000, "raw": "spilled raw", "worktree": "/wt/main"}).to_string()).unwrap();
    assert_eq!(wal::spilled(&file), 1);
    assert_eq!(wal::absorb_spill(&file, 5000).unwrap(), 1);
    assert_eq!(wal::spilled(&file), 0);
    assert!(sp.join("spilled-1.json.absorbed").exists(), "kept, renamed, never deleted");
    assert!(node(js, &args)["open"].as_array().unwrap().iter().any(|b| b["e"] == "spilled-1" && b["raw"] == "spilled raw"));
    assert_eq!(wal::absorb_spill(&file, 5001).unwrap(), 0, "idempotent");
    // adopt: a prior reader key's WAL whose open batches all name this worktree is claimed (renamed), one with another worktree is not
    let prior = wal::wal_path(&devroot, "monitor", "old-key");
    wal::append_batch(&prior, "prior one", 10, Some("/wt/main"), Some("p1")).unwrap();
    let foreign = wal::wal_path(&devroot, "monitor", "other-repo");
    wal::append_batch(&foreign, "foreign", 11, Some("/wt/elsewhere"), Some("f1")).unwrap();
    let mixed = wal::wal_path(&devroot, "monitor", "mixed");
    wal::append_batch(&mixed, "m1", 12, Some("/wt/main"), Some("m1")).unwrap();
    wal::append_batch(&mixed, "m2", 13, Some("/wt/zzz"), Some("m2")).unwrap();
    let got = wal::adopt_for_worktree(&devroot, "monitor", "/wt/main", &file, 6000);
    assert_eq!(got.iter().map(|(_, b)| b.e.as_str()).collect::<Vec<_>>(), ["p1"]);
    assert!(!prior.exists() && foreign.exists() && mixed.exists(), "only the all-this-worktree WAL is claimed, by rename");
    assert_eq!(wal::adopt_for_worktree(&devroot, "monitor", "/wt/main", &file, 6001).len(), 1, "a claimed file still open is returned again");
    // rotate: nothing pending and big -> archive (renamed); with something pending -> stays
    let big = wal::wal_path(&devroot, "monitor", "big");
    let e = wal::append_batch(&big, &"x".repeat(1_100_000), 1, None, None).unwrap();
    wal::maybe_rotate(&big, 7000);
    assert!(big.exists(), "pending: not rotated");
    wal::close_batch(&big, &e, "done", "", 2).unwrap();
    wal::maybe_rotate(&big, 7001);
    assert!(!big.exists() && devroot.join("wal/archive/monitor-big.7001.ndjson").exists());
    // preflight is clean on a writable directory
    assert_eq!(wal::preflight(&file), None);
}

#[test]
fn a_wal_that_cannot_be_written_spills_and_blocks_instead_of_dropping_the_batch() {
    let t = TempDir::new("wal-spill");
    let root = std::fs::canonicalize(&t.0).unwrap();
    let devroot = root.join(".anti-hall/devswarm");
    std::fs::create_dir_all(devroot.join("wal")).unwrap();
    // the WAL path is a DIRECTORY: it can never be appended to
    let file = wal::wal_path(&devroot, "monitor", "k");
    std::fs::create_dir_all(&file).unwrap();
    assert!(wal::preflight(&file).unwrap().starts_with("WAL "));
    match wal::capture_raw(&file, "precious bytes", 1, Some("/wt")) {
        wal::Capture::Spilled(p, why) => {
            assert!(!why.is_empty());
            assert!(std::fs::read_to_string(p).unwrap().contains("precious bytes"));
        }
        other => panic!("expected a spill, got {other:?}"),
    }
    assert_eq!(wal::spilled(&file), 1);
    // absorbing needs a writable WAL: it fails, the spill stays
    assert!(wal::absorb_spill(&file, 2).is_err());
    assert_eq!(wal::spilled(&file), 1, "nothing was dropped");
}

// ---- the breaker ladders ------------------------------------------------------------------------------------------------------

#[test]
fn the_breaker_ladders_are_nodes() {
    if !have_node() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let theirs = node(
        "const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const t=[],p=[];for(let n=1;n<=40;n++){t.push(I.transientBackoffMs(n,2000));p.push(I.permanentBackoffMs(n,2000))}console.log(JSON.stringify({t,p}))",
        &[],
    );
    let mut b = Breaker::new(2000);
    let transient = Poll { ok: false, error: Some("monitor x ETIMEDOUT after 40000ms".into()), code: Some("ETIMEDOUT".into()), ..Poll::default() };
    let permanent = Poll { ok: false, error: Some("spawn x ENOENT".into()), code: Some("ENOENT".into()), ..Poll::default() };
    let t: Vec<u64> = (1..=40).map(|i| b.on_failure(&transient, i).backoff_ms).collect();
    assert_eq!(json!(t), theirs["t"], "transient: base x 2^(n-1), capped");
    let mut b = Breaker::new(2000);
    let mut logged = 0;
    let p: Vec<u64> = (1..=40)
        .map(|i| {
            let v = b.on_failure(&permanent, i);
            assert!(v.permanent);
            logged += usize::from(v.log.is_some());
            v.backoff_ms
        })
        .collect();
    assert_eq!(json!(p), theirs["p"], "configuration faults: 2 s, 5 s, 30 s, 2 min, 5 min");
    assert_eq!(logged, 5, "logged only when the backoff step changes (five steps), never once per occurrence");
    // a success ends the run and says so once
    assert!(b.on_success(100).is_some());
    assert!(b.on_success(101).is_none());
    // rollup: after the ladder is capped one line per rollup interval
    let mut b = Breaker::new(2000);
    for i in 1..=6 {
        b.on_failure(&permanent, i);
    }
    assert!(b.on_failure(&permanent, 7).log.is_none());
    assert!(b.on_failure(&permanent, 7 + 900_000).log.is_some(), "the periodic rollup");
}

// ---- the drain, end to end ----------------------------------------------------------------------------------------------------

#[test]
fn the_drain_imports_a_batch_loss_free_and_idempotently_and_matches_nodes_rows() {
    if !have_node() {
        return;
    }
    let x = ix("drain");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    assert!(d.lock_path().exists(), "the project's lock is held");
    let a = r#"[{"fromBranch":"feat","toBranch":"main","message":"one","status":"unread","createdAt":"2026-10-09T01:02:03.000Z"},{"fromBranch":"feat","toBranch":"main","message":"two","status":"unread","createdAt":"2026-10-09T01:02:04.000Z"}]"#;
    enqueue(&x, "1", a);
    let step = d.step(&sys);
    assert!(!step.stop);
    let got = rows(&x);
    assert_eq!(got.len(), 2);
    assert!(got.iter().all(|r| r.0 == x.project.workspace_id && r.2.starts_with("native:")));
    // the same rows Node's ingestPayload writes for the same batch
    let theirs = node(
        "const fs=require('fs');process.env.HOME=process.argv[2];const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const S=require(process.argv[1]+'/companion/lib/devswarm-store.js');const s=S.openStore({home:process.argv[2],hash:'scratch-key',workspaceId:process.argv[3],backend:'sqlite'});s.upsertRegistry({id:process.argv[3],worktreePath:'/w',sessionId:'x',inboxPath:null,cursorPath:null,nudgeCommand:null});I.ingestPayload(s,process.argv[4],{workspaceId:process.argv[3],home:process.argv[2],now:1});const out=s.listMessages(process.argv[3]).map((m)=>({ts:m.ts,hash:m.hash,body:m.body}));console.log(JSON.stringify(out))",
        &[x.state.to_str().unwrap(), &x.project.workspace_id, a],
    );
    let mine: Vec<Value> = got.iter().map(|r| json!({"ts": r.1, "hash": r.2, "body": r.3})).collect();
    assert_eq!(json!(mine), theirs, "the engine and Node write the same rows");
    // the WAL entry was closed (nothing pending), the destructive read was made in the project's directory with no workspace identity
    assert!(wal::pending(&wal::wal_path(&dev(&x), "monitor", &x.project.repo_key)).unwrap().is_empty());
    let calls = std::fs::read_to_string(&x.log).unwrap();
    let first = calls.lines().next().unwrap();
    assert_eq!(first, format!("{}|workspace monitor -i 3 -t 30|unset", x.main.display()), "{calls}");
    // the same batch again (a re-observed in-flight batch) inserts nothing; two different ones add
    enqueue(&x, "2", a);
    d.step(&sys);
    assert_eq!(rows(&x).len(), 2, "idempotent by content hash");
    enqueue(&x, "3", r#"{"messages":[{"message":"three"}]}"#);
    d.step(&sys);
    assert_eq!(rows(&x).len(), 3);
    assert_eq!((d.stats.inserted, d.stats.duplicate), (3, 2));
    // the summary was refreshed by the engine (a file under summaries/)
    assert!(dev(&x).join("summaries").join(format!("{}.json", x.project.repo_key)).exists());
    // the self-registration kept the fuller row's fields and re-stamped the rest
    let c = rusqlite::Connection::open_with_flags(db(&x), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let reg: (Option<String>, Option<String>, Option<String>, Option<String>) = c
        .query_row("SELECT worktree_path, session_id, inbox_path, nudge_command FROM registry WHERE id = ?", [&x.project.workspace_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!(reg.0.as_deref(), Some(x.project.worktree.as_str()));
    assert_eq!(reg.1.as_deref(), Some(x.project.workspace_id.as_str()));
    assert_eq!(reg.2.as_deref(), Some("/x/inbox"), "merge-preserving");
    assert_eq!(reg.3.as_deref(), Some("[\"hivecontrol\",\"nudge\"]"));
    d.stop();
    assert!(!d.lock_path().exists(), "released");
}

#[test]
fn the_heartbeat_and_the_lock_have_nodes_shape() {
    if !have_node() {
        return;
    }
    let x = ix("beat");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    d.step(&sys);
    let hb_path = dev(&x).join(format!("heartbeats/ingest-{}.json", x.project.repo_key));
    let text = std::fs::read_to_string(&hb_path).unwrap();
    let hb: Value = serde_json::from_str(&text).unwrap();
    // the keys, in Node's order (writeIngestHeartbeat)
    let node_keys = node(
        "const fs=require('fs');const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const h=process.argv[2];I.writeIngestHeartbeat(h,'k',{workspaceId:'w',workingDir:'/d',now:1,hivecontrolBin:'b',hivecontrolSource:'env'});console.log(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(I.ingestHeartbeatPath(h,'k'),'utf8')))))",
        &[x.state.to_str().unwrap()],
    );
    let mine: Vec<&str> = {
        let mut pos: Vec<(usize, &str)> =
            node_keys.as_array().unwrap().iter().map(|k| (text.find(&format!("\"{}\"", k.as_str().unwrap())).unwrap(), k.as_str().unwrap())).collect();
        pos.sort();
        pos.into_iter().map(|(_, k)| k).collect()
    };
    assert_eq!(json!(mine), node_keys, "Node's keys in Node's order");
    assert_eq!(hb["workspaceId"], x.project.workspace_id.as_str());
    assert_eq!(hb["workingDir"], x.project.worktree.as_str());
    assert_eq!(hb["pid"], std::process::id());
    assert!(hb["lastMonitorOkMs"].is_number() && hb["lastMonitorAttemptMs"].is_number());
    assert_eq!(hb["consecutiveMonitorFailures"], 0);
    assert_eq!(hb["hivecontrolSource"], "env");
    assert!(hb["codeVersion"].is_string());
    // the lock record is Node's shape, and Node's own acquire is refused by it (the single-consumer guard, in this direction)
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(d.lock_path()).unwrap()).unwrap();
    assert_eq!(rec["pid"], std::process::id());
    assert!(rec["token"].is_string() && rec["host"].is_string() && rec["ts"].is_number());
    let got = node(
        "process.env.HOME=process.argv[2];const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const r=I.acquireIngestLock(process.argv[2],{},process.argv[3]);console.log(JSON.stringify({got:!!r}));if(r)r()",
        &[x.home.to_str().unwrap(), x.main.to_str().unwrap()],
    );
    assert_eq!(got["got"], false, "a Node daemon cannot start while the engine drains");
    assert_eq!(d.lock_path().file_name().unwrap().to_string_lossy(), format!("ingest-project-{}.lock", x.project.repo_key));
    d.stop();
}

#[test]
fn a_live_node_holder_is_never_displaced_and_a_dead_one_is() {
    if !have_node() {
        return;
    }
    let x = ix("lock");
    let sys = System::configured();
    // Node's own daemon lock, taken by a live process (a child that sleeps)
    let mut holder = Command::new("node")
        .args(["-e", "process.env.HOME=process.argv[2];const I=require(process.argv[1]+'/companion/devswarm-ingest.js');const r=I.acquireIngestLock(process.argv[2],{},process.argv[3]);console.log(r?'held':'refused');setTimeout(()=>{},60000)"])
        .arg(plugin())
        .arg(&x.home)
        .arg(&x.main)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::BufReader::new(holder.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "held");
    }
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    // even with the record aged far beyond the stale window, a live holder keeps it: the engine waits
    let lock = d.lock_path();
    let old = std::fs::read_to_string(&lock).unwrap().replacen(
        &format!("\"ts\":{}", serde_json::from_str::<Value>(&std::fs::read_to_string(&lock).unwrap()).unwrap()["ts"]),
        "\"ts\":1000",
        1,
    );
    std::fs::write(&lock, &old).unwrap();
    assert!(matches!(d.start(&sys), Start::Refused(_)));
    assert!(!x.log.exists(), "not one monitor call was made");
    assert!(std::fs::read_to_string(&lock).unwrap().contains("\"ts\":1000"), "the live holder's record is untouched");
    // the holder goes away (SIGKILL: no release): the engine takes the lock at once, whatever its age
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert_eq!(d.start(&sys), Start::Started);
    d.stop();
}

#[test]
fn a_legacy_per_worktree_consumer_that_is_alive_blocks_the_drain_and_a_dead_one_does_not() {
    let x = ix("legacy");
    let sys = System::configured();
    let hash = x.project.workspace_id.trim_start_matches("primary-").to_string();
    let lock = dev(&x).join(format!("locks/ingest-{hash}.lock"));
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    let host = {
        let o = Command::new("hostname").output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let _ = host;
    // this very process is alive
    std::fs::write(&lock, json!({"pid": std::process::id(), "ts": now(), "token": "t"}).to_string()).unwrap();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    match d.start(&sys) {
        Start::Refused(why) => assert!(why.contains("legacy"), "{why}"),
        Start::Started => panic!("a legacy consumer is alive: the engine must not drain"),
    }
    assert!(!x.log.exists(), "no monitor call");
    assert!(!d.lock_path().exists(), "and the project lock was handed back");
    // a dead pid does not block (and the legacy file is left alone)
    let dead = {
        let mut c = Command::new("true").spawn().unwrap();
        c.wait().unwrap();
        c.id()
    };
    std::fs::write(&lock, json!({"pid": dead, "ts": now(), "token": "t"}).to_string()).unwrap();
    assert_eq!(d.start(&sys), Start::Started);
    assert!(lock.exists(), "a legacy lock is never removed by the engine");
    d.stop();
}

#[test]
fn a_batch_the_store_refuses_stays_pending_in_the_wal_and_is_replayed_before_the_next_read() {
    if !have_node() {
        return;
    }
    let x = ix("pending");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    // the partition's own lock is held by another writer: the door refuses, nothing is written
    let held = ah_engine::meshw::idlock::acquire(&x.home, &x.project.workspace_id).unwrap();
    enqueue(&x, "1", r#"[{"message":"urgent one","createdAt":"2026-10-09T01:02:03.000Z"}]"#);
    let step = d.step(&sys);
    assert!(!step.stop && step.wait_ms > 0);
    assert!(rows(&x).is_empty(), "refused: nothing written");
    let walf = wal::wal_path(&dev(&x), "monitor", &x.project.repo_key);
    assert_eq!(wal::pending(&walf).unwrap().len(), 1, "but the destructive read is safe in the WAL");
    assert_eq!(d.stats.errors, 1);
    // while it is pending, no new destructive read is issued
    enqueue(&x, "2", r#"[{"message":"second","createdAt":"2026-10-09T01:02:04.000Z"}]"#);
    d.step(&sys);
    assert_eq!(std::fs::read_to_string(&x.log).unwrap().lines().count(), 1, "the second step only tried to replay");
    assert!(rows(&x).is_empty());
    held.release();
    // the lock is free: the replay imports the first batch, THEN (same iteration, as in Node) the read happens and the second batch
    // is imported too
    d.step(&sys);
    let bodies: Vec<String> = rows(&x).into_iter().map(|r| r.3).collect();
    assert_eq!(bodies, ["urgent one", "second"], "in order, nothing lost");
    assert_eq!(std::fs::read_to_string(&x.log).unwrap().lines().count(), 2, "the read followed the replay");
    assert!(wal::pending(&walf).unwrap().is_empty());
    // a WAL left open by a crashed run is replayed by a fresh drain (the restart case)
    wal::append_batch(&walf, r#"[{"message":"left by a crash","createdAt":"2026-10-09T01:02:05.000Z"}]"#, now(), Some(&x.project.worktree), None).unwrap();
    d.stop();
    let mut d2 = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d2.start(&sys), Start::Started);
    d2.step(&sys);
    assert_eq!(rows(&x).last().unwrap().3, "left by a crash");
    d2.stop();
    // an unregistered partition (rehomed away) is refused as GONE, re-registered, and imported on the retry
    let c = rusqlite::Connection::open(db(&x)).unwrap();
    c.execute("DELETE FROM registry WHERE id = ?", [&x.project.workspace_id]).unwrap();
    drop(c);
    let mut d3 = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d3.start(&sys), Start::Started, "start registers the Primary again");
    enqueue(&x, "9", r#"[{"message":"after re-register","createdAt":"2026-10-09T01:02:06.000Z"}]"#);
    d3.step(&sys);
    assert_eq!(rows(&x).last().unwrap().3, "after re-register");
    d3.stop();
}

#[test]
fn a_batch_of_no_known_shape_is_quarantined_and_kept_whole_in_the_wal() {
    let x = ix("lossy");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    enqueue(&x, "1", "WARNING: something printed garbage {not json");
    d.step(&sys);
    assert_eq!(d.stats.loss_events, 1);
    let q: Vec<_> = std::fs::read_dir(dev(&x).join("quarantine")).unwrap().flatten().collect();
    assert_eq!(q.len(), 1);
    assert!(q[0].file_name().to_string_lossy().starts_with("lost-batch-"));
    assert!(std::fs::read_to_string(q[0].path()).unwrap().contains("something printed garbage"));
    let walf = wal::wal_path(&dev(&x), "monitor", &x.project.repo_key);
    assert!(std::fs::read_to_string(&walf).unwrap().contains("\"t\":\"quarantine\""), "closed as quarantine; the raw bytes stay in the WAL");
    assert!(wal::pending(&walf).unwrap().is_empty());
    // rate limit: a second loss inside the window is counted, not written
    enqueue(&x, "2", "more garbage");
    d.step(&sys);
    assert_eq!(d.stats.loss_events, 2);
    assert_eq!(std::fs::read_dir(dev(&x).join("quarantine")).unwrap().count(), 1);
    // an empty and a well-formed-empty poll are not losses
    enqueue(&x, "3", "[]");
    enqueue(&x, "4", "  \n");
    d.step(&sys);
    d.step(&sys);
    assert_eq!(d.stats.loss_events, 2);
    d.stop();
}

#[test]
fn a_missing_binary_backs_off_on_the_configuration_ladder_and_a_killed_poll_keeps_what_it_printed() {
    let x = ix("fail");
    let sys = System::configured();
    let mut s = st(&x);
    s.env.insert("ANTIHALL_DEVSWARM_HIVECONTROL".into(), x.home.join("no-such-hivecontrol").to_string_lossy().into_owned());
    let mut d = Drainer::new(&x.home, &s, x.project.clone());
    assert_eq!(d.start(&sys), Start::Started, "a missing binary does not stop the drain: it stays up, visible in the heartbeat");
    let waits: Vec<u64> = (0..5).map(|_| d.step(&sys).wait_ms).collect();
    assert_eq!(waits, [2000, 5000, 30000, 120000, 300000]);
    let hb: Value = serde_json::from_str(&std::fs::read_to_string(dev(&x).join(format!("heartbeats/ingest-{}.json", x.project.repo_key))).unwrap()).unwrap();
    assert_eq!(hb["consecutiveMonitorFailures"], 5);
    assert_eq!(hb["lastMonitorErrorCode"], "ENOENT");
    d.stop();
    // a poll that prints a batch and then hangs is killed at the hard limit; the printed batch is imported, the poll counts as failed
    let hang = x.home.join("hang-hivecontrol");
    std::fs::write(&hang, "#!/bin/sh\nprintf '[{\"message\":\"printed before the kill\"}]'\nsleep 30\n").unwrap();
    std::fs::set_permissions(&hang, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut s = st(&x);
    s.env.insert("ANTIHALL_DEVSWARM_HIVECONTROL".into(), hang.to_string_lossy().into_owned());
    s.env.insert("ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC".into(), "1".into());
    let mut d = Drainer::new(&x.home, &s, x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    let t0 = std::time::Instant::now();
    d.step(&sys);
    assert!(t0.elapsed().as_secs() < 20, "bounded by the hard limit (timeout + margin), not by the child");
    assert_eq!(rows(&x).iter().map(|r| r.3.as_str()).collect::<Vec<_>>(), ["printed before the kill"]);
    assert_eq!(d.stats.errors, 1);
    d.stop();
}

#[test]
fn the_workspace_identity_of_the_daemon_never_reaches_the_monitor_child() {
    let x = ix("env");
    let sys = System::configured();
    // SAFETY: set before any other thread in this test reads it; the stub reports what it saw.
    unsafe { std::env::set_var("DEVSWARM_BUILDER_ID", "some-child-workspace") };
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    d.step(&sys);
    d.stop();
    // SAFETY: restoring what this test set.
    unsafe { std::env::remove_var("DEVSWARM_BUILDER_ID") };
    let line = std::fs::read_to_string(&x.log).unwrap();
    assert!(line.trim_end().ends_with("|unset"), "{line}");
}

#[test]
fn the_node_witness_agrees_with_the_engine_on_a_scratch_store_and_never_touches_the_live_one() {
    if !have_node() {
        return;
    }
    let x = ix("witness");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    enqueue(&x, "1", &format!("[{MSG}]"));
    enqueue(&x, "2", r#"{"data":[{"message":"no created at","n":[1,2,{"k":"v"}]},{"message":"b","createdAt":"2026-10-09T05:02:03.5+04:00"}]}"#);
    enqueue(&x, "3", "garbage {");
    enqueue(&x, "4", "[]");
    for _ in 0..4 {
        d.step(&sys);
    }
    let before = rows(&x);
    assert_eq!(before.len(), 3);
    // run the comparison now (the interval gate is for the loop; the comparison itself is what is tested)
    let store = MeshStore::open(&db(&x)).unwrap();
    let mirror = x.home.join(format!(".anti-hall/witness/ingest-{}.ndjson", x.project.repo_key));
    assert_eq!(std::fs::read_to_string(&mirror).unwrap().lines().count(), 3, "two batches with messages and the lossy one; the quiet polls are not mirrored");
    let mut m = ah_engine::dssup::ingest::witness::Mirror::open(&x.home, &x.project.repo_key).unwrap();
    let root = ah_engine::defaults::root().unwrap();
    let rec = m.compare(&sys, &root, &store, &x.project, now()).unwrap();
    assert_eq!(rec["match"], true, "{rec}");
    assert_eq!(rec["batches"], 3);
    assert!(!mirror.exists(), "the mirror was consumed");
    assert_eq!(std::fs::read_dir(x.home.join(".anti-hall/witness")).unwrap().count(), 0, "scratch removed");
    assert_eq!(rows(&x), before, "the live store was not touched");
    let log = std::fs::read_to_string(x.home.join(".anti-hall/logs/devswarm-ingest-witness.ndjson")).unwrap();
    assert!(log.contains("\"match\":true"));
    d.stop();
}

#[test]
fn the_witness_reports_a_row_the_engine_claims_but_the_store_does_not_have() {
    if !have_node() {
        return;
    }
    let x = ix("witness-loss");
    let sys = System::configured();
    let mut d = Drainer::new(&x.home, &st(&x), x.project.clone());
    assert_eq!(d.start(&sys), Start::Started);
    enqueue(&x, "1", &format!("[{MSG}]"));
    d.step(&sys);
    // someone deletes the row behind the engine's back: the mirror says it was written, the store has no such row
    let c = rusqlite::Connection::open(db(&x)).unwrap();
    c.execute("DELETE FROM messages WHERE hash LIKE 'native:%'", []).unwrap();
    drop(c);
    let store = MeshStore::open(&db(&x)).unwrap();
    let mut m = ah_engine::dssup::ingest::witness::Mirror::open(&x.home, &x.project.repo_key).unwrap();
    let rec = m.compare(&sys, &ah_engine::defaults::root().unwrap(), &store, &x.project, now()).unwrap();
    assert_eq!(rec["match"], false);
    assert_eq!(rec["diffs"][0]["what"], "store");
    d.stop();
}

// ---- discovery and the switch ---------------------------------------------------------------------------------------------------

#[test]
fn projects_come_from_the_setting_fresh_node_heartbeats_and_memory() {
    ah_engine::defaults::init().unwrap();
    let x = ix("discover");
    let hb_dir = dev(&x).join("heartbeats");
    std::fs::create_dir_all(&hb_dir).unwrap();
    // a fresh Node heartbeat naming the repo; a stale one naming a path that exists; a fresh one naming a path that does not
    let other = x.home.join("elsewhere");
    std::fs::create_dir_all(&other).unwrap();
    git(&["init", "-q"], &other);
    std::fs::write(hb_dir.join(format!("ingest-{}.json", x.project.repo_key)), json!({"ts": now() - 1000, "workingDir": x.main}).to_string()).unwrap();
    std::fs::write(hb_dir.join("ingest-stale.json"), json!({"ts": now() - 86_400_000, "workingDir": other}).to_string()).unwrap();
    std::fs::write(hb_dir.join("ingest-gone.json"), json!({"ts": now(), "workingDir": "/no/such/dir/anywhere"}).to_string()).unwrap();
    let found = ah_engine::dssup::ingest::discover(&x.home, &x.state, "", now());
    assert_eq!(found.iter().map(|p| p.repo_key.as_str()).collect::<Vec<_>>(), [x.project.repo_key.as_str()]);
    // remembered: still served when the heartbeat is gone; the setting adds the other repo; a non-repository path is skipped
    std::fs::remove_file(hb_dir.join(format!("ingest-{}.json", x.project.repo_key))).unwrap();
    let non_repo = x.home.join("plain");
    std::fs::create_dir_all(&non_repo).unwrap();
    let explicit = format!("{}:{}:", other.display(), non_repo.display());
    let found = ah_engine::dssup::ingest::discover(&x.home, &x.state, &explicit, now());
    let mut keys: Vec<String> = found.iter().map(|p| p.repo_key.clone()).collect();
    keys.sort();
    assert_eq!(found.len(), 2, "{keys:?}");
    assert!(keys.contains(&x.project.repo_key));
    // a LINKED worktree names the repository's main worktree as the project (what the Node unit bakes), never itself
    git(&["worktree", "add", "-q", "-b", "side", x.home.join("linked").to_str().unwrap()], &x.main);
    let linked = std::fs::canonicalize(x.home.join("linked")).unwrap();
    let p = Project::resolve(linked.to_str().unwrap()).unwrap();
    assert_eq!(p, x.project, "the same project, rooted at the main worktree");
    assert_eq!(p.worktree, x.main.to_string_lossy());
    // one project per repo key, however many paths name it
    let twice = ah_engine::dssup::ingest::discover(&x.home, &x.state, &format!("{}:{}", x.main.display(), x.main.display()), now());
    assert_eq!(twice.iter().filter(|p| p.repo_key == x.project.repo_key).count(), 1);
    // the mode switch: a typo is the Node-owned mode
    use ah_engine::dssup::ingest::Owner;
    for (w, o) in [("engine", Owner::Engine), (" ENGINE ", Owner::Engine), ("witness", Owner::Witness), ("enigne", Owner::Witness), ("", Owner::Witness)] {
        assert_eq!(Owner::parse(w), o, "{w:?}");
    }
}

#[test]
fn the_loop_drains_stops_on_request_and_leaves_no_lock_behind() {
    let x = ix("loop");
    enqueue(&x, "1", r#"[{"message":"via the loop"}]"#);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (s2, home, stn, project) = (stop.clone(), x.home.clone(), st(&x), x.project.clone());
    let h = std::thread::spawn(move || {
        ah_engine::dssup::ingest::run_project(&home, &stn, project, &System::configured(), &|| s2.load(std::sync::atomic::Ordering::SeqCst))
    });
    let t0 = std::time::Instant::now();
    while rows(&x).is_empty() && t0.elapsed().as_secs() < 20 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(rows(&x).iter().map(|r| r.3.as_str()).collect::<Vec<_>>(), ["via the loop"]);
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    h.join().unwrap();
    assert!(!dev(&x).join(format!("locks/ingest-project-{}.lock", x.project.repo_key)).exists());
    assert!(Path::new(&x.home.join(".anti-hall/devswarm-ingest.log")).exists());
    let log = std::fs::read_to_string(x.home.join(".anti-hall/devswarm-ingest.log")).unwrap();
    assert!(log.contains("ingest drain started (engine)"), "{log}");
    let _ = Refused::Busy;
}

#[test]
fn the_ingest_verb_is_read_only_open_to_every_role_and_names_the_owner_and_the_projects() {
    let x = ix("verb");
    ah_engine::defaults::init().unwrap();
    for role in ["main", "child", "subagent", "codex"] {
        assert!(ah_engine::dswire::cli::allowed(role, "ingest"), "{role}");
    }
    let hb_dir = dev(&x).join("heartbeats");
    std::fs::create_dir_all(&hb_dir).unwrap();
    std::fs::write(hb_dir.join(format!("ingest-{}.json", x.project.repo_key)), json!({"ts": now(), "workingDir": x.main}).to_string()).unwrap();
    let before: Vec<_> = std::fs::read_dir(&x.state).unwrap().flatten().map(|e| e.file_name()).collect();
    let o = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .args(["devswarm", "ingest", "--json"])
        .env_clear()
        .env("HOME", &x.home)
        .env("PATH", std::env::var("PATH").unwrap())
        .env("AH_ENGINE_DIR", &x.state)
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_NOSPAWN", "1")
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stdout)));
    assert_eq!(v["mode"], "engine", "the default: the engine drains");
    assert_eq!(v["projects"][0]["repoKey"], x.project.repo_key.as_str());
    assert_eq!(v["projects"][0]["workspaceId"], x.project.workspace_id.as_str());
    assert!(v["projects"][0]["heartbeat"]["workingDir"].is_string());
    assert!(v["projects"][0]["lock"].is_null(), "nobody holds it");
    let after: Vec<_> = std::fs::read_dir(&x.state).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(before, after, "read-only: the verb remembers and writes nothing");
    assert!(!dev(&x).join(format!("locks/ingest-project-{}.lock", x.project.repo_key)).exists());
    // nothing is running at shutdown: joining the drain threads is immediate
    assert!(ah_engine::dssup::ingest::join_all());
}
