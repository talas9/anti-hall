//! Two registry rows on one worktree are ONE recipient: `inbox read-primary` reads every partition of the group, each message once,
//! and the ack moves every partition's cursor; with NO Node and no exit 69. (Node: `resolveMeshPartitionIds` + the sibling fold.)
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report
use ah_engine::meshw::store::{MeshRow, MeshStore};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

struct Fx {
    home: PathBuf,
    repo: PathBuf,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let root = std::env::temp_dir().join(format!("ah-group-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (home, repo) = (root.join("home"), root.join("repo"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let o = Command::new("git")
                .current_dir(&repo)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        fs::write(repo.join("f"), "x").unwrap();
        git(&["add", "f"]);
        git(&["commit", "-q", "-m", "i"]);
        Fx { home, repo: repo.canonicalize().unwrap() }
    }

    fn raw(&self, argv: &[&str]) -> (i32, String) {
        self.raw_env(argv, &[])
    }

    fn raw_env(&self, argv: &[&str], envs: &[(&str, &str)]) -> (i32, String) {
        let o = Command::new(BIN)
            .arg("mesh")
            .args(argv)
            .current_dir(&self.repo)
            .env_clear()
            .envs(envs.iter().copied())
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin")
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall"))
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        (o.status.code().unwrap(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
    }

    fn run(&self, argv: &[&str]) -> (i32, Value) {
        let (code, out) = self.raw(argv);
        (code, serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("not JSON ({code}): {out}")))
    }

    /// The caller's own label, its project key, and the twin: the label row (`register-primary`) and a child row on the same worktree.
    fn twins(&self) -> (String, String) {
        let (code, v) = self.run(&["register-primary", "--worktree", self.repo.to_str().unwrap(), "--session", "s-label"]);
        assert_eq!(code, 0, "{v}");
        let label = v["id"].as_str().unwrap().to_string();
        let (code, v) = self.run(&["register", "child-x", "--worktree", self.repo.to_str().unwrap(), "--session", "s-child"]);
        assert_eq!(code, 0, "{v}");
        let key = v["descriptor"]["repoKey"].as_str().unwrap().to_string();
        (label, key)
    }

    fn store(&self, key: &str) -> MeshStore {
        MeshStore::open(&self.home.join(".anti-hall/devswarm/store").join(key).join("devswarm.db")).unwrap()
    }
}

fn row(partition: &str, ts: i64, hash: &str, body: &str, sender: &str) -> MeshRow {
    MeshRow {
        workspace_id: partition.into(),
        ts,
        hash: Some(hash.into()),
        body: body.into(),
        sender: Some(sender.into()),
        recipient: Some(partition.into()),
        mtype: Some("direct".into()),
        urgency: Some("normal".into()),
        is_heartbeat: false,
        needs_reply: false,
        orig_hash: None,
        instance_nonce: None,
    }
}

#[test]
fn a_read_of_twin_rows_unions_both_partitions_once_and_the_ack_moves_both() {
    let fx = Fx::new("union");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row(&label, 1_000, "h-a1", "to label 1", "peer-a")).unwrap();
        st.append_mesh_row(&row(&label, 3_000, "h-a2", "to label 2", "peer-a")).unwrap();
        st.append_mesh_row(&row("child-x", 2_000, "h-b1", "to child 1", "peer-b")).unwrap();
        st.append_mesh_row(&row("child-x", 4_000, "h-b2", "to child 2", "peer-b")).unwrap();
    }
    let (code, v) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["ok"], Value::Bool(true), "{v}");
    let bodies: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["to label 1", "to child 1", "to label 2", "to child 2"], "merged by time: {v}");
    assert_eq!((v["count"].clone(), v["unreadCount"].clone(), v["total"].clone()), (Value::from(4), Value::from(4), Value::from(4)), "{v}");
    let ids: Vec<&str> = v["meshPartitionIds"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert!(ids.contains(&label.as_str()) && ids.contains(&"child-x") && ids.len() == 2, "{v}");
    assert_eq!(v["messages"][1]["partitionId"].as_str(), Some("child-x"), "a sibling row names its partition: {v}");
    // the read acked nothing; the receipt carries the moves
    let rid = v["readReceiptId"].as_str().unwrap().to_string();
    let (code, a) = fx.run(&["inbox", "ack-primary", &label, "--receipt", &rid]);
    assert_eq!(code, 0, "{a}");
    assert_eq!(a["ok"], Value::Bool(true), "{a}");
    // everything is read now, in both partitions
    let (code, again) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{again}");
    assert_eq!((again["count"].clone(), again["unreadCount"].clone()), (Value::from(0), Value::from(0)), "{again}");
}

#[test]
fn a_message_present_in_both_partitions_is_delivered_once() {
    let fx = Fx::new("dup");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row(&label, 1_000, "h-same", "same body", "peer-a")).unwrap();
        // a forwarded copy: same content under another hash, marked with the original's
        let mut copy = row("child-x", 1_000, "h-copy", "same body", "peer-a");
        copy.orig_hash = Some("h-same".into());
        st.append_mesh_row(&copy).unwrap();
        st.append_mesh_row(&row("child-x", 2_000, "h-only", "only here", "peer-b")).unwrap();
    }
    let (code, v) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{v}");
    let bodies: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["same body", "only here"], "{v}");
}

#[test]
fn a_live_sibling_is_read_but_never_acked_by_the_caller() {
    let fx = Fx::new("live");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row(&label, 1_000, "h-a1", "to label", "peer-a")).unwrap();
        st.append_mesh_row(&row("child-x", 2_000, "h-b1", "to live child", "peer-b")).unwrap();
    }
    // the child is alive: a fresh heartbeat of its own session
    let beats = fx.home.join(".anti-hall/devswarm/heartbeats");
    fs::create_dir_all(&beats).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    fs::write(beats.join("child-x.json"), format!(r#"{{"ts":{now},"sessionId":"s-child"}}"#)).unwrap();
    let (code, v) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["count"], Value::from(2), "the live child's mail is shown: {v}");
    assert_eq!(v["liveSiblingsSkipped"], serde_json::json!(["child-x"]), "{v}");
    let rid = v["readReceiptId"].as_str().unwrap().to_string();
    let (code, a) = fx.run(&["inbox", "ack-primary", &label, "--receipt", &rid]);
    assert_eq!(code, 0, "{a}");
    // the caller-scoped watermark hides what it has seen from its next read ...
    let (code, again) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{again}");
    assert_eq!(again["count"], Value::from(0), "{again}");
    // ... but the child's own cursor never moved: its mail is still unread for the child
    let st = fx.store(&key);
    let rows = st.reader().reader_cursors("child-x").unwrap();
    let floor = rows.iter().find(|r| r["ns"] == "store" && r["reader"] == "#floor").map(|r| r["value"].as_f64().unwrap_or(0.0)).unwrap_or(0.0);
    assert_eq!(floor, 0.0, "{rows:?}");
    assert!(
        fx.home.join(".anti-hall/devswarm/cursors").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".seen-")),
        "the watermark file"
    );
}

#[test]
fn a_tick_of_a_twin_counts_both_partitions_without_exit_69() {
    let fx = Fx::new("tick");
    let (label, key) = fx.twins();
    // a third row with an NDJSON inbox, as a ticking child has, and a live watcher on it
    let (inbox, cursor) = (fx.home.join("tick-w.ndjson"), fx.home.join("tick-w.cursor"));
    fs::write(&inbox, "").unwrap();
    fs::write(&cursor, "0").unwrap();
    let (code, v) = fx.run(&[
        "register",
        "tick-w",
        "--worktree",
        fx.repo.to_str().unwrap(),
        "--session",
        "s-tick",
        "--inbox",
        inbox.to_str().unwrap(),
        "--cursor",
        cursor.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{v}");
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row("tick-w", 1_000, "h-w1", "to tick-w", "peer-a")).unwrap();
        st.append_mesh_row(&row(&label, 2_000, "h-l1", "to label", "peer-b")).unwrap();
        st.append_mesh_row(&row("child-x", 3_000, "h-c1", "to child", "peer-c")).unwrap();
    }
    let locks = fx.home.join(".anti-hall/devswarm/locks");
    fs::create_dir_all(&locks).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    fs::write(locks.join("wake-watch-tick-w.lock"), format!(r#"{{"pid":{},"ts":{now}}}"#, std::process::id())).unwrap();
    let (code, v) = fx.run(&["inbox", "tick", "tick-w"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["unreadTotal"], Value::from(3), "{v}");
    assert_eq!(v["meshPartitionIds"].as_array().unwrap().len(), 3, "{v}");
}

#[test]
fn read_primary_text_with_ack_after_print_on_twin_rows_answers_and_acks_both_partitions() {
    // the argv a Primary runs on its hot path; it exited 69 (mesh-group) before the group read was native
    let fx = Fx::new("textack");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row(&label, 1_000, "h-a1", "to label", "peer-a")).unwrap();
        st.append_mesh_row(&row("child-x", 2_000, "h-b1", "to child", "peer-b")).unwrap();
    }
    let (code, out) = fx.raw(&["inbox", "read-primary", &label, "--format", "text", "--ack-after-print"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("to label") && out.contains("to child"), "{out}");
    // the ack ran in the same call: nothing is left unread in either partition
    let (code, again) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{again}");
    assert_eq!((again["count"].clone(), again["unreadCount"].clone()), (Value::from(0), Value::from(0)), "{again}");
}

#[test]
fn a_legacy_forwarded_row_without_orig_hash_is_marked_with_the_hash_the_original_had() {
    use ah_engine::meshw::store::mesh_message_hash;
    let fx = Fx::new("legacyfwd");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        // forwarded by an older build: the envelope is in the body, `origHash` was never stamped
        st.append_mesh_row(&row(&label, 1_500, "h-fwd", "[forwarded from archived old-ws] hello", "peer-a")).unwrap();
    }
    let (code, v) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{v}");
    let m = &v["messages"][0];
    let expect = mesh_message_hash(Some("peer-a"), Some("old-ws"), "direct", "normal", "hello", "1500", false);
    assert_eq!((m["forwarded"].clone(), m["origHash"].as_str()), (Value::Bool(true), Some(expect.as_str())), "{v}");
}

/// A sqlite file shaped like the DevSwarm app's: one builder on `worktree` whose terminal runs Claude session `session`.
fn app_db(path: &Path, worktree: &Path, session: &str) {
    let c = rusqlite::Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);",
    )
    .unwrap();
    c.execute(
        "INSERT INTO builders (id, worktreePath, isActive, isHidden, builderType, branchName, label) VALUES ('seat-1', ?1, 1, 0, 'standard', 'b', 'l')",
        [worktree.to_str().unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO builder_terminals VALUES ('t1','seat-1','term.1','ai','claude',?1,1,'idle','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','x',NULL,NULL)",
        [format!(r#"{{"sessionId":"{session}"}}"#)],
    )
    .unwrap();
}

/// A child standing on the Primary's worktree under ANOTHER session than the anchor row records (a resumed session): who owns the
/// anchor is the app's call when its transcript corroborates it (Node: `appSessionOnWorktree`), else liveness. Either way the read
/// answers (it used to exit 69), and a corroborated app verdict "this worktree" lets the caller ack the anchor partition it shares
/// with its live twin, which the liveness fallback (the caller's session is not provably alive) does not.
#[test]
fn a_caller_whose_session_differs_from_the_anchors_is_decided_by_the_app_record_then_liveness() {
    let run = |with_app: bool| {
        let fx = Fx::new(if with_app { "seat-app" } else { "seat-live" });
        let (label, key) = fx.twins();
        {
            let st = fx.store(&key);
            st.append_mesh_row(&row(&label, 1_000, "h-a1", "to label", "peer-a")).unwrap();
        }
        let sid = "s-resumed";
        let db = fx.home.join("app.db");
        if with_app {
            app_db(&db, &fx.repo, sid);
            // the session's own transcript records the worktree it runs in
            let enc: String = fx.repo.to_str().unwrap().chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
            let dir = fx.home.join(".claude/projects").join(enc);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("{sid}.jsonl")), format!("{{\"cwd\":{}}}\n", serde_json::to_string(fx.repo.to_str().unwrap()).unwrap())).unwrap();
        }
        // the label's twin is alive (a fresh heartbeat of its own session)
        let beats = fx.home.join(".anti-hall/devswarm/heartbeats");
        fs::create_dir_all(&beats).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        fs::write(beats.join("child-x.json"), format!(r#"{{"ts":{now},"sessionId":"s-child"}}"#)).unwrap();
        let envs = [("DEVSWARM_BUILDER_ID", "child-x"), ("CLAUDE_CODE_SESSION_ID", sid), ("ANTIHALL_DEVSWARM_APP_DB", db.to_str().unwrap())];
        let (code, out) = fx.raw_env(&["inbox", "read-primary", &label], &envs);
        assert_eq!(code, 0, "{out}");
        serde_json::from_str::<Value>(out.trim()).unwrap_or_else(|_| panic!("not JSON: {out}"))
    };
    let without = run(false);
    let with = run(true);
    assert_eq!(without["ok"], Value::Bool(true), "{without}");
    assert_eq!(with["ok"], Value::Bool(true), "{with}");
    assert_ne!(without["liveSiblingsSkipped"], with["liveSiblingsSkipped"], "the app record changes who owns the anchor: {without} vs {with}");
}

/// Node answers `inbox count|read|ack` for an address that resolves to a row with no inbox path with the refusal for the row it
/// resolved to, and for a retired id whose survivor has no inbox with the refusal for the retired id itself; the engine used to
/// exit 69 for both (and for a descriptor without an inbox path).
#[test]
fn an_address_that_lands_on_a_row_without_an_inbox_is_refused_like_node_not_deferred() {
    let fx = Fx::new("noinbox");
    let (code, v) = fx.run(&["register", "solo", "--worktree", fx.repo.to_str().unwrap(), "--session", "s-solo"]);
    assert_eq!(code, 0, "{v}");
    let mesh = ah_engine::meshw::ident::mesh_id_for_real_path(fx.repo.to_str().unwrap());
    // a retired id whose survivor never had an inbox
    let retired = fx.home.join(".anti-hall/devswarm/retired");
    fs::create_dir_all(&retired).unwrap();
    fs::write(retired.join("gone-ws.json"), r#"{"retiredTo":"solo"}"#).unwrap();
    for sub in ["count", "read", "ack"] {
        // the exact id, a unique prefix of it, and the mesh label of its worktree
        for addr in ["solo", "sol", mesh.as_str()] {
            let (code, v) = fx.run(&["inbox", sub, addr]);
            assert_eq!((code, v["reason"].as_str(), v["id"].as_str()), (2, Some("no-inbox-path"), Some("solo")), "inbox {sub} {addr}: {v}");
        }
        let (code, v) = fx.run(&["inbox", sub, "gone-ws"]);
        assert_eq!((code, v["reason"].as_str(), v["id"].as_str()), (2, Some("unregistered-workspace"), Some("gone-ws")), "inbox {sub} gone-ws: {v}");
    }
}

/// A downstream Primary's hot path: twin rows on one worktree, each carrying an archive marker that a newer occupant of the id
/// superseded (the live session differs from the marker's) and a caller whose session is not the anchor's. Node reads such a
/// marker as "not archived" and answers; the engine used to defer (`marker-superseded`) the text read and the tick.
#[test]
fn twin_rows_with_a_superseded_archive_marker_and_an_app_session_seat_answer_read_and_tick() {
    let fx = Fx::new("superseded");
    let (label, key) = fx.twins();
    {
        let st = fx.store(&key);
        st.append_mesh_row(&row(&label, 1_000, "h-a1", "to label", "peer-a")).unwrap();
        st.append_mesh_row(&row("child-x", 2_000, "h-b1", "to child", "peer-b")).unwrap();
    }
    let archived = fx.home.join(".anti-hall/devswarm/archived");
    fs::create_dir_all(&archived).unwrap();
    let wt = serde_json::to_string(fx.repo.to_str().unwrap()).unwrap();
    for id in ["child-x", label.as_str()] {
        fs::write(archived.join(format!("{id}.json")), format!(r#"{{"id":"{id}","sessionId":"s-old-occupant","worktreePath":{wt}}}"#)).unwrap();
    }
    let db = fx.home.join("app.db");
    app_db(&db, &fx.repo, "s-resumed");
    let enc: String = fx.repo.to_str().unwrap().chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
    let dir = fx.home.join(".claude/projects").join(enc);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("s-resumed.jsonl"), format!("{{\"cwd\":{wt}}}\n")).unwrap();
    let envs = [("DEVSWARM_BUILDER_ID", "child-x"), ("CLAUDE_CODE_SESSION_ID", "s-resumed"), ("ANTIHALL_DEVSWARM_APP_DB", db.to_str().unwrap())];
    let (code, out) = fx.raw_env(&["inbox", "read-primary", &label, "--format", "text", "--ack-after-print"], &envs);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("to label"), "{out}");
    // the ticking row of the group has an NDJSON inbox and a live watcher, as the Primary's has
    let (inbox, cursor) = (fx.home.join("tick-w.ndjson"), fx.home.join("tick-w.cursor"));
    fs::write(&inbox, "").unwrap();
    fs::write(&cursor, "0").unwrap();
    let (code, v) = fx.run(&[
        "register",
        "tick-w",
        "--worktree",
        fx.repo.to_str().unwrap(),
        "--session",
        "s-tick",
        "--inbox",
        inbox.to_str().unwrap(),
        "--cursor",
        cursor.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{v}");
    let locks = fx.home.join(".anti-hall/devswarm/locks");
    fs::create_dir_all(&locks).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    fs::write(locks.join("wake-watch-tick-w.lock"), format!(r#"{{"pid":{},"ts":{now}}}"#, std::process::id())).unwrap();
    let (code, out) = fx.raw_env(&["inbox", "tick", "tick-w", "--quiet"], &envs);
    assert_eq!(code, 0, "{out}");
}
