//! #767: a DevSwarm child whose worktree is a subdirectory of the checkout the Primary stands in. Its registry row (`<root>/<subdir>`)
//! and the Primary's (`<root>`) resolve to one checkout root; the three symptoms below were that collapse.
use crate::defaults;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, Row};
use crate::meshw::{meshgroup, send, store};
use std::path::PathBuf;

struct Fx {
    inv: Inv,
    root: String,
    sub: String,
    primary: String,
}

/// A `git` command isolated from the ambient HOME / global / system config (a malformed `~/.gitconfig` must not break the fixtures).
fn git_cmd(dir: &std::path::Path, scratch: &std::path::Path) -> std::process::Command {
    let mut c = std::process::Command::new("git");
    c.current_dir(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .env("HOME", scratch)
        .env("XDG_CONFIG_HOME", scratch)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null");
    c
}

fn fx(tag: &str) -> Fx {
    defaults::init().unwrap();
    let home = std::env::temp_dir().join(format!("ah-subdir767-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
    let repo = home.join("repo");
    std::fs::create_dir_all(repo.join("pkg/app")).unwrap();
    let st = git_cmd(&repo, &home).args(["init", "-q", "-b", "main"]).status().unwrap();
    assert!(st.success());
    let root = repo.canonicalize().unwrap().to_string_lossy().into_owned();
    let sub = format!("{root}/pkg/app");
    let mut env: ident::Env = Default::default();
    env.insert(defaults::text("mesh_write.env_app_db").to_string(), defaults::text("mesh_write.app_db_off").to_string());
    env.insert(defaults::text("mesh_write.env_builder_id").to_string(), "child-1".into());
    env.insert(defaults::text("mesh_write.env_source_branch").to_string(), "b".into());
    let inv = Inv { home: home.clone(), write_home: home, env, cwd: sub.clone(), now: 1_000_000, stdin: None, store_override: None };
    let primary = ident::primary_workspace_id(&root).unwrap();
    Fx { inv, root, sub, primary }
}

fn row(id: &str, wt: &str, sid: &str) -> store::RegistryRow {
    store::RegistryRow { id: id.into(), worktree_path: Some(wt.into()), session_id: Some(sid.into()), ..Default::default() }
}

fn rows_of(entries: &[(&str, &str)]) -> Vec<Row> {
    entries.iter().map(|(id, wt)| Row { id: (*id).into(), worktree_path: Some((*wt).into()), session_id: None, updated_at: None }).collect()
}

fn descriptor(f: &Fx, id: &str, wt: &str) -> PathBuf {
    let dir = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(format!("{id}.json"));
    std::fs::write(&p, format!(r#"{{"id":"{id}","worktreePath":{}}}"#, crate::checks::guardkit::ojson::OVal::Str(wt.into()).stringify())).unwrap();
    p
}

/// Symptom 2: the child resolves as itself (not as the root's label, which is the Primary's) on the send side AND the caller side.
#[test]
fn a_subdirectory_child_is_itself_not_the_primary() {
    let f = fx("identity");
    descriptor(&f, "child-1", &f.sub);
    let caller = ident::caller_identity_for(&f.inv.env, &f.inv.cwd, &f.inv.home).unwrap();
    assert_eq!((caller.identity.as_str(), caller.kind.as_str()), ("child-1", "child"));
    // the Primary (a descriptor at the root, or none) stays the Primary
    let mut primary = f.inv.clone();
    primary.cwd = f.root.clone();
    assert_eq!(ident::caller_identity_for(&primary.env, &primary.cwd, &primary.home).unwrap().identity, f.primary);
    descriptor(&f, "child-1", &f.root);
    assert_eq!(
        ident::caller_identity_for(&f.inv.env, &f.inv.cwd, &f.inv.home).unwrap().identity,
        f.primary,
        "a descriptor AT the root is the root's own workspace"
    );
}

/// Symptoms 1 and 4: the child and the Primary are two recipients, not one mesh group (a group made the Primary's mail "own" mail of the
/// child, so read-primary counted 0 while the child's own inbox held it).
#[test]
fn a_subdirectory_child_and_the_primary_are_not_one_mesh_group() {
    let f = fx("group");
    let rows = rows_of(&[(f.primary.as_str(), f.root.as_str()), ("child-1", f.sub.as_str())]);
    let g = meshgroup::resolve(&rows, "child-1", Some(&f.sub)).unwrap();
    assert!(!g.active, "group of the child: {:?}", g.ids);
    let for_primary = send::mesh_candidates(&rows, Some(&f.primary)).unwrap();
    assert_eq!(for_primary.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec![f.primary.as_str()]);
    // with no other row at the root, the subdirectory row still collapses onto the root's label, as before
    let alone = rows_of(&[("child-1", f.sub.as_str())]);
    assert_eq!(send::mesh_candidates(&alone, Some(&f.primary)).unwrap().len(), 1);
}

/// Symptom 3: the id-collision guard sees `<root>` and `<root>/<subdir>` as one worktree, so the registration is updated instead of
/// refused with "possible id hash collision".
#[test]
fn the_registry_guard_accepts_a_subdirectory_of_the_registered_root() {
    let f = fx("guard");
    assert!(ident::same_registry_worktree(&f.root, &f.sub));
    assert!(ident::same_registry_worktree(&f.sub, &f.root));
    assert!(!ident::same_registry_worktree(&f.root, "/nonexistent-767/elsewhere"));
    let key = ident::repo_key_for_worktree(&f.root).unwrap().unwrap();
    crate::meshw::common::init_new_store(&f.inv, &key).unwrap();
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    assert!(st.upsert_registry(&row("child-1", &f.root, "s"), 1, |_, _| true).unwrap());
    assert!(st.upsert_registry(&row("child-1", &f.sub, "s"), 2, ident::same_registry_worktree).unwrap(), "the guard refused the subdirectory of its own root");
    assert_eq!(st.registry_row("child-1").unwrap().unwrap().worktree_path.as_deref(), Some(f.sub.as_str()));
}

fn argv(words: &[&str]) -> crate::meshw::args::Args {
    crate::meshw::args::parse(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>())
}

/// P1 of the first review: the child's identity carried the Primary's label, so a child send wrote a Primary -> child alias and every
/// reader then attributed the Primary's broadcasts to the child. End to end: the Primary broadcasts from the root, the child in
/// `<root>/<subdir>` sends to-primary; each reads only its own mail and no alias names the Primary's label.
#[test]
fn a_child_send_never_aliases_the_primary_and_each_reads_its_own_mail() {
    let f = fx("e2e");
    descriptor(&f, "child-1", &f.sub);
    let key = ident::repo_key_for_worktree(&f.root).unwrap().unwrap();
    crate::meshw::common::init_new_store(&f.inv, &key).unwrap();
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    assert!(st.upsert_registry(&row(&f.primary, &f.root, "sp"), 1, |_, _| true).unwrap());
    assert!(st.upsert_registry(&row("child-1", &f.sub, "sc"), 2, ident::same_registry_worktree).unwrap());
    drop(st);
    let mut primary = f.inv.clone();
    primary.cwd = f.root.clone();
    primary.env.remove(defaults::text("mesh_write.env_builder_id"));

    let b = send::run(&primary, &argv(&["send", "--broadcast", "--message", "from-primary-broadcast"])).unwrap();
    assert_eq!(b.code, 0, "primary broadcast: {}", b.stdout);
    let c = send::run(&f.inv, &argv(&["send", "--to-primary", "--message", "from-child"])).unwrap();
    assert_eq!(c.code, 0, "child to-primary: {}", c.stdout);

    // the alias map never names the Primary's label (the root's), only possibly the child's own
    let alias_file = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.alias_file"));
    let aliases = std::fs::read_to_string(&alias_file).unwrap_or_default();
    assert!(!aliases.contains(&f.primary), "a Primary alias was written: {aliases}");

    // the child's inbox holds the Primary's broadcast, attributed to the Primary, and not its own send
    let child_read = crate::meshw::read::run(&f.inv, &argv(&["read", "--peek"]), false).unwrap().stdout;
    assert!(child_read.contains("from-primary-broadcast"), "the child lost the Primary's broadcast: {child_read}");
    assert!(!child_read.contains("from-child"), "the child read its own send: {child_read}");
    assert!(child_read.contains(&format!("\"from\":\"{}\",\"message\":\"from-primary-broadcast", f.primary)), "broadcast misattributed: {child_read}");
    assert!(!child_read.contains("\"from\":\"child-1\",\"message\""), "mail attributed to the child: {child_read}");
    // the Primary's read-primary sees the child's to-primary mail, attributed to the child
    let primary_read = crate::meshw::readprimary::run_peek(&primary, &argv(&["inbox", "peek-primary", &f.primary])).unwrap().stdout;
    assert!(primary_read.contains("from-child"), "the Primary missed the child's mail: {primary_read}");
    assert!(
        !primary_read.contains("from-primary-broadcast") || !primary_read.contains("\"from\":\"child-1\",\"message\":\"from-primary-broadcast"),
        "misattributed: {primary_read}"
    );
}

fn registry(f: &Fx, children: &[&str]) -> (Inv, String) {
    let key = ident::repo_key_for_worktree(&f.root).unwrap().unwrap();
    crate::meshw::common::init_new_store(&f.inv, &key).unwrap();
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    assert!(st.upsert_registry(&row(&f.primary, &f.root, "sp"), 1, |_, _| true).unwrap());
    for (i, c) in children.iter().enumerate() {
        descriptor(f, c, &f.sub);
        assert!(st.upsert_registry(&row(c, &f.sub, &format!("s{i}")), 2 + i as i64, ident::same_registry_worktree).unwrap());
    }
    drop(st);
    let mut primary = f.inv.clone();
    primary.cwd = f.root.clone();
    primary.env.remove(defaults::text("mesh_write.env_builder_id"));
    (primary, key)
}

/// P1 of the second review: two children sharing one subdirectory are one mesh group; `read-primary` files the receipt under the
/// group's lowest id, so `ack-primary` of the OTHER child must look there too (it looked only under its own id: unknown-receipt).
#[test]
fn ack_primary_finds_the_receipt_a_group_sibling_filed() {
    let f = fx("ackgroup");
    let (primary, _) = registry(&f, &["child-a", "child-b"]);
    let sent = send::run(&primary, &argv(&["send", "--to", "child-b", "--message", "mail-for-b"])).unwrap();
    assert_eq!(sent.code, 0, "send: {}", sent.stdout);
    let mut b = f.inv.clone();
    b.env.insert(defaults::text("mesh_write.env_builder_id").to_string(), "child-b".into());
    let owner = defaults::text("mesh_write.flag_ack_as_owner");
    let read = crate::meshw::readprimary::run(&b, &argv(&["inbox", "read-primary", "child-b", &format!("--{owner}")])).unwrap().stdout;
    let rid = read.split("\"readReceiptId\":\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or_else(|| panic!("no receipt id: {read}")).to_string();
    let ack = crate::meshw::inbox::run(&b, &argv(&["inbox", "ack-primary", "child-b", "--receipt", &rid, &format!("--{owner}")])).unwrap();
    assert!(!ack.stdout.contains("unknown-receipt"), "the receipt is lost: {}", ack.stdout);
    assert_eq!(ack.code, 0, "ack: {}", ack.stdout);
}

/// P2 of the second review: an alias an older build wrote (the Primary's root label -> a subdirectory child) is ignored on read, so the
/// Primary's broadcasts keep the Primary as sender; the file is not rewritten or deleted.
#[test]
fn a_poisoned_primary_alias_from_an_older_build_is_ignored() {
    let f = fx("poison");
    let (primary, _) = registry(&f, &["child-1"]);
    let alias_file = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.alias_file"));
    let body = format!(
        r#"{{"version":1,"aliases":{{"{}":{{"to":"child-1","worktree":null,"at":1}},"other-label":{{"to":"child-1","worktree":null,"at":1}}}}}}"#,
        f.primary
    );
    std::fs::create_dir_all(alias_file.parent().unwrap()).unwrap();
    std::fs::write(&alias_file, &body).unwrap();
    let kept = crate::meshw::common::read_aliases(&f.inv.home, &f.inv.env);
    assert_eq!(kept, vec![("other-label".to_string(), "child-1".to_string())], "only the poisoned entry is ignored");
    assert_eq!(std::fs::read_to_string(&alias_file).unwrap(), body, "nothing rewritten or deleted");
    let b = send::run(&primary, &argv(&["send", "--broadcast", "--message", "bcast"])).unwrap();
    assert_eq!(b.code, 0, "{}", b.stdout);
    let read = crate::meshw::read::run(&f.inv, &argv(&["read", "--peek"]), false).unwrap().stdout;
    assert!(read.contains(&format!("\"from\":\"{}\",\"message\":\"bcast", f.primary)), "misattributed: {read}");
}

/// Round 3: a sole child registered at `<W>/pkg`, W being the child's OWN linked worktree with the Primary's checkout elsewhere, writes
/// the alias W's label -> child. That alias is the child's identity, not the Primary's poisoned one, so it must survive `read_aliases`.
#[test]
fn a_child_alias_for_its_own_linked_worktree_survives() {
    let f = fx("ownwt");
    let git = |dir: &str, args: &[&str]| {
        let st = git_cmd(std::path::Path::new(dir), &f.inv.home).args(args).status().unwrap();
        assert!(st.success(), "git {args:?}");
    };
    git(&f.root, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let w = format!("{}-wt", f.root);
    git(&f.root, &["worktree", "add", "-q", "-b", "wt", &w]);
    let w = std::path::Path::new(&w).canonicalize().unwrap().to_string_lossy().into_owned();
    let pkg = format!("{w}/pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    descriptor(&f, "child-1", &pkg);
    let key = ident::repo_key_for_worktree(&f.root).unwrap().unwrap();
    crate::meshw::common::init_new_store(&f.inv, &key).unwrap();
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    assert!(st.upsert_registry(&row(&f.primary, &f.root, "sp"), 1, |_, _| true).unwrap());
    assert!(st.upsert_registry(&row("child-1", &pkg, "sc"), 2, ident::same_registry_worktree).unwrap());
    drop(st);
    let mut child = f.inv.clone();
    child.cwd = pkg.clone();
    child.env.remove(defaults::text("mesh_write.env_builder_id"));
    let b = send::run(&child, &argv(&["send", "--broadcast", "--message", "from-wt-child"])).unwrap();
    assert_eq!(b.code, 0, "child broadcast: {}", b.stdout);
    let w_label = ident::primary_workspace_id(&w).unwrap();
    let kept = crate::meshw::common::read_aliases(&f.inv.home, &f.inv.env);
    assert!(kept.contains(&(w_label.clone(), "child-1".to_string())), "the child's own-worktree alias was dropped: {kept:?}");
    // and the Primary's own root label is still never aliased
    assert!(!kept.iter().any(|(k, _)| *k == f.primary), "{kept:?}");
    // the child's broadcast reads back attributed to the child
    let read = crate::meshw::read::run(&f.inv, &argv(&["read", "--peek"]), false).unwrap().stdout;
    assert!(read.contains("\"from\":\"child-1\",\"message\":\"from-wt-child"), "misattributed: {read}");
}

/// Round 4: the Primary is registered in a LINKED worktree W only through the DevSwarm app database (named by the env, not the
/// process env). Its checkout is then not the main worktree, so only the app-DB lookup recognises it; `read_aliases` must use the
/// caller's env so W's root label -> a child registered at W/pkg is rejected.
#[test]
fn a_primary_in_a_linked_worktree_known_only_via_the_app_db_has_its_alias_rejected() {
    let f = fx("appdbprimary");
    let git = |dir: &str, args: &[&str]| {
        let st = git_cmd(std::path::Path::new(dir), &f.inv.home).args(args).status().unwrap();
        assert!(st.success(), "git {args:?}");
    };
    git(&f.root, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let w = format!("{}-wt", f.root);
    git(&f.root, &["worktree", "add", "-q", "-b", "wt", &w]);
    let w = std::path::Path::new(&w).canonicalize().unwrap().to_string_lossy().into_owned();
    let pkg = format!("{w}/pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    descriptor(&f, "child-1", &pkg);
    let db = f.inv.home.join("devswarm-app.db");
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("CREATE TABLE builders (id TEXT, isActive INTEGER, isHidden INTEGER, worktreePath TEXT, builderType TEXT, branchName TEXT, repositoryId TEXT, label TEXT, pullRequestId TEXT);").unwrap();
    c.execute("INSERT INTO builders VALUES ('prim-1', 1, 0, ?1, 'primary', 'wt', 'repo-1', 'Primary', NULL)", [&w]).unwrap();
    drop(c);
    let w_label = ident::primary_workspace_id(&w).unwrap();
    let alias_file = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.alias_file"));
    std::fs::create_dir_all(alias_file.parent().unwrap()).unwrap();
    std::fs::write(&alias_file, format!(r#"{{"version":1,"aliases":{{"{w_label}":{{"to":"child-1","worktree":null,"at":1}}}}}}"#)).unwrap();
    let mut env = f.inv.env.clone();
    env.insert(defaults::text("mesh_write.env_app_db").to_string(), db.to_string_lossy().into_owned());
    let kept = crate::meshw::common::read_aliases(&f.inv.home, &env);
    assert!(kept.is_empty(), "the Primary's root alias survived: {kept:?}");
    // without the app database the same file reads as a child alias (the env is what tells the two apart)
    assert_eq!(crate::meshw::common::read_aliases(&f.inv.home, &f.inv.env), vec![(w_label, "child-1".to_string())]);
}

/// GH #845 review P2-16: an explicit ack answers one sender, so `--ack-only` with `--broadcast` is refused (nothing is stored).
#[test]
fn an_ack_only_broadcast_is_refused() {
    let f = fx("ackonly-bc");
    descriptor(&f, "child-1", &f.sub);
    let key = ident::repo_key_for_worktree(&f.root).unwrap().unwrap();
    crate::meshw::common::init_new_store(&f.inv, &key).unwrap();
    let r = send::run(&f.inv, &argv(&["send", "--broadcast", "--ack-only", "--message", "got it"])).unwrap();
    assert_ne!(r.code, 0, "{}", r.stdout);
    assert!(r.stdout.contains(defaults::text("mesh_chat.msg_ack_only_broadcast")), "{}", r.stdout);
}

fn child_with_inbox(f: &Fx) {
    let inbox = f.inv.home.join("child-1.ndjson");
    let cursor = f.inv.home.join("child-1.cursor");
    std::fs::write(&inbox, "").unwrap();
    std::fs::write(&cursor, "0").unwrap();
    let dir = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let q = |p: &std::path::Path| crate::checks::guardkit::ojson::OVal::Str(p.to_string_lossy().into_owned()).stringify();
    std::fs::write(
        dir.join("child-1.json"),
        format!(
            r#"{{"id":"child-1","worktreePath":{},"inboxPath":{},"cursorPath":{}}}"#,
            crate::checks::guardkit::ojson::OVal::Str(f.sub.clone()).stringify(),
            q(&inbox),
            q(&cursor)
        ),
    )
    .unwrap();
}

/// Re-review N-6: a bare `inbox ack` is safe by default. With no read on record it acks nothing; after a read it acks exactly what
/// that read showed, so mail that landed in between stays unread.
#[test]
fn a_bare_ack_acks_only_what_the_last_read_showed() {
    let f = fx("bareack");
    let (primary, _) = registry(&f, &["child-1"]);
    child_with_inbox(&f);
    let sent = send::run(&primary, &argv(&["send", "--to", "child-1", "--message", "first"])).unwrap();
    assert_eq!(sent.code, 0, "send: {}", sent.stdout);
    let blind = crate::meshw::inboxcmd::run_ack(&f.inv, &argv(&["inbox", "ack", "child-1"])).unwrap();
    assert_eq!(blind.code, 0, "{}", blind.stdout);
    assert!(blind.stdout.contains(defaults::text("mesh_wake.key_ack_no_read")), "{}", blind.stdout);
    let read = crate::meshw::inboxcmd::run_read(&f.inv, &argv(&["inbox", "read", "child-1"])).unwrap().stdout;
    assert!(read.contains("first"), "a blind ack acked unseen mail: {read}");
    let late = send::run(&primary, &argv(&["send", "--to", "child-1", "--message", "late"])).unwrap();
    assert_eq!(late.code, 0, "send: {}", late.stdout);
    let ack = crate::meshw::inboxcmd::run_ack(&f.inv, &argv(&["inbox", "ack", "child-1"])).unwrap();
    assert_eq!(ack.code, 0, "ack: {}", ack.stdout);
    let again = crate::meshw::inboxcmd::run_read(&f.inv, &argv(&["inbox", "read", "child-1"])).unwrap().stdout;
    assert!(again.contains("late"), "the bare ack acked the late mail unseen: {again}");
    assert!(!again.contains("\"first\""), "the read mail is still unread: {again}");
}

/// GH #845 review (the direct-mail ack race): mail that lands between `inbox read` and `inbox ack --through <ackThrough>` stays
/// unread; the ack moves only through what the read delivered.
#[test]
fn mail_arriving_between_read_and_ack_through_stays_unread() {
    let f = fx("ackthrough");
    let (primary, _) = registry(&f, &["child-1"]);
    let inbox = f.inv.home.join("child-1.ndjson");
    let cursor = f.inv.home.join("child-1.cursor");
    std::fs::write(&inbox, "").unwrap();
    std::fs::write(&cursor, "0").unwrap();
    let dir = crate::meshw::idlock::devswarm_root(&f.inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let q = |p: &std::path::Path| crate::checks::guardkit::ojson::OVal::Str(p.to_string_lossy().into_owned()).stringify();
    std::fs::write(
        dir.join("child-1.json"),
        format!(
            r#"{{"id":"child-1","worktreePath":{},"inboxPath":{},"cursorPath":{}}}"#,
            crate::checks::guardkit::ojson::OVal::Str(f.sub.clone()).stringify(),
            q(&inbox),
            q(&cursor)
        ),
    )
    .unwrap();
    let sent = send::run(&primary, &argv(&["send", "--to", "child-1", "--message", "first"])).unwrap();
    assert_eq!(sent.code, 0, "send: {}", sent.stdout);
    let read = crate::meshw::inboxcmd::run_read(&f.inv, &argv(&["inbox", "read", "child-1"])).unwrap().stdout;
    assert!(read.contains("first"), "{read}");
    let key = format!("\"{}\":\"", defaults::text("mesh_wake.key_ack_through"));
    let through = read.split(&key).nth(1).and_then(|r| r.split('"').next()).unwrap_or_else(|| panic!("no ackThrough: {read}")).to_string();
    let late = send::run(&primary, &argv(&["send", "--to", "child-1", "--message", "late"])).unwrap();
    assert_eq!(late.code, 0, "send: {}", late.stdout);
    let flag = format!("--{}", defaults::text("mesh_wake.flag_ack_through"));
    let ack = crate::meshw::inboxcmd::run_ack(&f.inv, &argv(&["inbox", "ack", "child-1", &flag, &through])).unwrap();
    assert_eq!(ack.code, 0, "ack: {}", ack.stdout);
    let again = crate::meshw::inboxcmd::run_read(&f.inv, &argv(&["inbox", "read", "child-1"])).unwrap().stdout;
    assert!(again.contains("late"), "the late mail was acked unseen: {again}");
    assert!(!again.contains("\"first\""), "the read mail is still unread: {again}");
}

/// The `--through` token round-trips, and a malformed one is rejected.
#[test]
fn the_ack_through_token_round_trips() {
    defaults::init().unwrap();
    let tok = crate::meshw::inboxcmd::encode_through(3.0, 7.0, &[("sib-a".into(), 2.0)]);
    let m = crate::meshw::inboxcmd::decode_through(&tok).unwrap();
    assert_eq!((m[defaults::text("mesh_wake.ack_through_nd")], m[defaults::text("mesh_wake.ack_through_store")], m["sib-a"]), (3.0, 7.0, 2.0));
    assert!(crate::meshw::inboxcmd::decode_through("nd:x").is_none());
    assert!(crate::meshw::inboxcmd::decode_through("").is_none());
}

/// GH #845 (owner 2026-11-28): the owner, declared as `admin` from the Primary's own checkout, reaches the Primary (it used to be
/// refused as a self-send, because the room's sends resolved AS the Primary) and a child; the rows carry `admin`, never the Primary,
/// and are listed with the human kind and rank.
#[test]
fn admin_reaches_the_primary_and_a_child_as_itself() {
    let f = fx("admin");
    let (primary, key) = registry(&f, &["child-1"]);
    let mut owner = primary.clone();
    owner.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    let to_primary = send::run(&owner, &argv(&["send", "--to-primary", "--message", "owner to primary"])).unwrap();
    assert_eq!(to_primary.code, 0, "admin -> primary: {}", to_primary.stdout);
    assert!(to_primary.stdout.contains("\"from\":\"admin\""), "{}", to_primary.stdout);
    let to_child = send::run(&owner, &argv(&["send", "--to", "child-1", "--message", "owner to child"])).unwrap();
    assert_eq!(to_child.code, 0, "admin -> child: {}", to_child.stdout);
    let peek = crate::meshw::readprimary::run_peek(&primary, &argv(&["inbox", "peek-primary", &f.primary])).unwrap().stdout;
    assert!(peek.contains("owner to primary"), "the Primary missed the owner's mail: {peek}");
    let kind = format!("\"{}\":\"human\"", defaults::text("mesh_identity.key_from_kind"));
    assert!(peek.contains(&kind), "no human kind on the owner's row: {peek}");
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    let mut child_rows = Vec::new();
    st.reader()
        .for_each_message("child-1", 0, |m| {
            child_rows.push(m);
            true
        })
        .unwrap();
    assert!(child_rows.iter().any(|m| m["sender"] == "admin" && m["body"] == "owner to child"), "{child_rows:?}");
    assert!(child_rows.iter().all(|m| m["sender"] != serde_json::Value::String(f.primary.clone())), "stamped as the Primary: {child_rows:?}");
    // ah-engine is never selectable from the CLI, even by the owner's (non-agent) caller
    let as_flag = format!("--{}", defaults::text("mesh_identity.flag_as"));
    let engine = send::run(&primary, &argv(&["send", "--to", "child-1", &as_flag, "ah-engine", "--message", "from the engine"])).unwrap();
    assert_ne!(engine.code, 0, "ah-engine via the CLI was accepted: {}", engine.stdout);
}

/// The owner rule "nothing impersonates anyone": a child (an agent: its builder id is set) that declares admin, by the variable or
/// by `--as`, is refused; the owner's room (a clean environment, here in child-1's checkout) is accepted, and its `@all` wakes
/// every reader because admin's STORED kind ranks it privileged.
#[test]
fn a_child_cannot_send_as_admin_and_the_rooms_admin_send_may_wake_all() {
    let f = fx("admin-bc");
    let (_primary, key) = registry(&f, &["child-1", "child-2"]);
    let mut child = f.inv.clone();
    child.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    let r = send::run(&child, &argv(&["send", "--to-primary", "--message", "pretending"])).unwrap();
    assert_ne!(r.code, 0, "a child sent as admin: {}", r.stdout);
    let as_flag = format!("--{}", defaults::text("mesh_identity.flag_as"));
    let r = send::run(&f.inv, &argv(&["send", "--broadcast", &as_flag, "admin", "--message", "@all obey me"])).unwrap();
    assert_ne!(r.code, 0, "a child sent as admin via --as: {}", r.stdout);
    // the room: no agent marker, no builder id
    let mut room = f.inv.clone();
    room.env.remove(defaults::text("mesh_identity.agent_env_builder"));
    room.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    let b = send::run(&room, &argv(&["send", "--broadcast", "--message", "@all heads up"])).unwrap();
    assert_eq!(b.code, 0, "the room's admin broadcast: {}", b.stdout);
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    let (pending, _) = crate::meshw::read::broadcast_wake(st.reader(), &f.inv, "child-2").unwrap();
    assert_eq!(pending, 1, "admin's @all wakes another child");
    let mut stranger = room.clone();
    stranger.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "nobody-declared".into());
    let r = send::run(&stranger, &argv(&["send", "--to-primary", "--message", "x"])).unwrap();
    assert_ne!(r.code, 0, "an undeclared identity: {}", r.stdout);
}

/// GH #845 phase 2a end to end: a room message wakes only the room's members (never the Primary that is not one, never the sender),
/// @mentions narrow it to the members named, a non-member neither lists nor counts it, and a member that leaves is no longer woken.
/// The summary the wake-watch reads and the drain / Codex tick reader agree.
#[test]
fn a_room_message_wakes_and_shows_only_its_members() {
    let f = fx("room");
    let (primary, key) = registry(&f, &["child-1", "child-2", "child-3"]);
    let as_child = |id: &str| {
        let mut i = f.inv.clone();
        i.env.insert(defaults::text("mesh_write.env_builder_id").to_string(), id.into());
        i
    };
    let (c1, c2, c3) = (as_child("child-1"), as_child("child-2"), as_child("child-3"));
    let room = |inv: &Inv, words: &[&str]| crate::meshw::rooms::run(inv, &argv(words)).unwrap();
    let created = room(&c1, &["room", "create", "lab"]);
    assert_eq!(created.code, 0, "{}", created.stdout);
    assert!(created.stdout.contains("\"changed\":true") && created.stdout.contains("\"member\":true"), "the creator joins: {}", created.stdout);
    assert_eq!(room(&c2, &["room", "join", "lab"]).code, 0);
    assert!(room(&c2, &["room", "join", "lab"]).stdout.contains("\"changed\":false"), "a second join changes nothing");
    assert_ne!(room(&c3, &["room", "join", "nope"]).code, 0, "no such room");
    assert_ne!(room(&c3, &["room", "create", "Bad Name"]).code, 0, "a bad name");
    assert_ne!(room(&c3, &["room", "frobnicate", "lab"]).code, 0, "an unknown subcommand");
    assert_ne!(send::run(&c3, &argv(&["send", "--room", "nope", "--message", "x"])).unwrap().code, 0, "a send to no room");
    assert_ne!(send::run(&c3, &argv(&["send", "--room", "lab", "--broadcast", "--message", "x"])).unwrap().code, 0, "two target modes");

    // a non-member posts: both members wake, the Primary (not a member) and the sender do not
    let s = send::run(&c3, &argv(&["send", "--room", "lab", "--message", "standup in 5"])).unwrap();
    assert_eq!(s.code, 0, "{}", s.stdout);
    assert!(s.stdout.contains("\"room\":\"lab\""), "{}", s.stdout);
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    let wake = |id: &str| crate::meshw::read::broadcast_wake(st.reader(), &f.inv, id).unwrap().0;
    assert_eq!((wake("child-1"), wake("child-2"), wake(&f.primary), wake("child-3")), (1, 1, 0, 0));

    // mentions narrow the wake to the members named
    let m = send::run(&c1, &argv(&["send", "--room", "lab", "--message", "@child-2 can you review?"])).unwrap();
    assert_eq!(m.code, 0, "{}", m.stdout);
    assert_eq!((wake("child-1"), wake("child-2"), wake(&f.primary)), (1, 2, 0));

    // the summary the watcher reads agrees, and a non-member lists nothing
    let (sum, _) = crate::meshw::summary::derive_value(&st, &f.inv, &key).unwrap();
    let field = |id: &str, k: &str| sum.get("workspaces").and_then(|w| w.get(id)).and_then(|w| w.get(k)).cloned();
    let pending = defaults::text("mesh_wake.summary_field_pending");
    assert_eq!(field("child-2", pending), Some(crate::checks::guardkit::ojson::OVal::Num(2.0)));
    assert_eq!(field(&f.primary, pending), Some(crate::checks::guardkit::ojson::OVal::Num(0.0)));
    assert_eq!(field(&f.primary, "broadcastUnread"), Some(crate::checks::guardkit::ojson::OVal::Num(0.0)), "hidden from a non-member");
    let listed = crate::meshw::read::unread_broadcasts(st.reader(), &f.inv, "child-2").unwrap();
    assert_eq!(listed.rows.len(), 2);
    assert!(listed.rows.iter().all(|r| r.get(defaults::text("mesh_room.key_room")) == Some(&crate::checks::guardkit::ojson::OVal::Str("lab".into()))));
    assert!(crate::meshw::read::unread_broadcasts(st.reader(), &f.inv, &f.primary).unwrap().rows.is_empty());
    let primary_read = crate::meshw::read::run(&primary, &argv(&["read", "--peek"]), false).unwrap().stdout;
    assert!(!primary_read.contains("standup in 5"), "a non-member's mesh read lists a room message: {primary_read}");
    let merged = crate::meshw::readprimary::run_peek(&primary, &argv(&["inbox", "peek-primary", &f.primary, "--with-broadcasts"])).unwrap().stdout;
    assert!(!merged.contains("standup in 5"), "a non-member's peek --with-broadcasts lists a room message: {merged}");
    let member = crate::meshw::readprimary::run_messages(&c2, &argv(&["inbox", "messages", "child-2", "--with-broadcasts"])).unwrap().stdout;
    assert!(member.contains("standup in 5"), "a member's merged listing lost the room message: {member}");

    // a member that leaves is not woken by the next message; the list shows who is left
    assert!(room(&c2, &["room", "leave", "lab"]).stdout.contains("\"changed\":true"));
    assert_eq!(send::run(&c3, &argv(&["send", "--room", "lab", "--message", "after the leave"])).unwrap().code, 0);
    assert_eq!((wake("child-1"), wake("child-2")), (2, 2));
    let list = room(&c1, &["room", "list"]);
    assert!(list.stdout.contains("\"members\":[\"child-1\"]") && list.stdout.contains("\"member\":true"), "{}", list.stdout);
}

/// GH #845 item 0: the owner's mailbox. Any agent may send `--to admin`; the row is stored in admin's own partition with recipient
/// admin, wakes nobody and never lands in the Primary's partition. A row from admin tells the reader to answer `--to admin`, and
/// `--reply-to <seq>` of it routes there; an unknown seq and a second target mode are refused.
#[test]
fn replies_to_the_owner_land_in_the_admin_mailbox_and_wake_nobody() {
    let f = fx("mailbox");
    let (primary, key) = registry(&f, &["child-1"]);
    let r = send::run(&f.inv, &argv(&["send", "--to", "admin", "--message", "child to owner"])).unwrap();
    assert_eq!(r.code, 0, "child -> admin: {}", r.stdout);
    assert!(r.stdout.contains("\"to\":\"admin\"") && !r.stdout.contains("nativeWake"), "{}", r.stdout);
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    let rows_of = |part: &str| {
        let mut v = Vec::new();
        st.reader()
            .for_each_message(part, 0, |m| {
                v.push(m);
                true
            })
            .unwrap();
        v
    };
    let admin_rows = rows_of("admin");
    assert!(admin_rows.iter().any(|m| m["body"] == "child to owner" && m["recipient"] == "admin" && m["sender"] == "child-1"), "{admin_rows:?}");
    assert!(rows_of(&f.primary).iter().all(|m| m["body"] != "child to owner"), "an owner reply landed in the Primary's partition");
    let (sum, _) = crate::meshw::summary::derive_value(&st, &f.inv, &key).unwrap();
    assert!(sum.get("workspaces").and_then(|w| w.get("admin")).is_none(), "the mailbox is no watched workspace");

    // the owner writes to the Primary; the Primary's read says how to answer, and --reply-to routes to the mailbox
    let mut owner = primary.clone();
    owner.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    assert_eq!(send::run(&owner, &argv(&["send", "--to-primary", "--message", "owner asks"])).unwrap().code, 0);
    let peek = crate::meshw::readprimary::run_peek(&primary, &argv(&["inbox", "peek-primary", &f.primary])).unwrap().stdout;
    let key_reply = defaults::text("mesh_identity.key_reply_with");
    assert!(peek.contains(key_reply) && peek.contains("--to admin"), "no reply hint on the owner's row: {peek}");
    let seq = rows_of(&f.primary).iter().find(|m| m["body"] == "owner asks").and_then(|m| m["storeSeq"].as_f64()).unwrap() as i64;
    let re = send::run(&primary, &argv(&["send", "--reply-to", &seq.to_string(), "--message", "primary answers owner"])).unwrap();
    assert_eq!(re.code, 0, "{}", re.stdout);
    assert!(rows_of("admin").iter().any(|m| m["body"] == "primary answers owner" && m["sender"] == f.primary), "the reply missed the mailbox");
    assert!(rows_of(&f.primary).iter().all(|m| m["body"] != "primary answers owner"), "a self-addressed reply");
    assert_ne!(send::run(&primary, &argv(&["send", "--reply-to", "999999", "--message", "x"])).unwrap().code, 0, "an unknown seq");
    assert_ne!(send::run(&primary, &argv(&["send", "--reply-to", &seq.to_string(), "--to", "child-1", "--message", "x"])).unwrap().code, 0, "two targets");
}


/// GH #862: the owner's chat reaches a Primary as an order, never as the advisory roster feed: an `admin` broadcast and an `admin` direct
/// are pendingQuestions flagged `owner` (with the text as a preview), they are left out of recent[], and a child's broadcast stays in it.
#[test]
fn owner_chat_rows_are_orders_for_the_primary_not_roster_feed() {
    use crate::checks::guardkit::ojson::OVal;
    let f = fx("owner-chat");
    let (primary, key) = registry(&f, &["child-1"]);
    let mut owner = primary.clone();
    owner.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    assert_eq!(send::run(&owner, &argv(&["send", "--broadcast", "--message", "owner says hi to all"])).unwrap().code, 0);
    assert_eq!(send::run(&owner, &argv(&["send", "--to-primary", "--message", "owner direct to you"])).unwrap().code, 0);
    assert_eq!(send::run(&f.inv, &argv(&["send", "--broadcast", "--message", "child fyi"])).unwrap().code, 0);
    let st = crate::meshw::common::open_store(&f.inv, &key).unwrap();
    let (sum, _) = crate::meshw::summary::derive_value(&st, &f.inv, &key).unwrap();
    let flag = defaults::text("mesh_write.owner_chat_flag");
    let own = sum.get("workspaces").and_then(|w| w.get(&f.primary)).expect("the primary's entry").clone();
    let Some(OVal::Arr(pq)) = own.get("pendingQuestions") else { panic!("no pendingQuestions: {}", own.stringify()) };
    let owners: Vec<&OVal> = pq.iter().filter(|q| matches!(q.get(flag), Some(OVal::Bool(true)))).collect();
    assert_eq!(owners.len(), 2, "both owner rows (the broadcast and the direct): {}", own.stringify());
    assert!(owners.iter().all(|q| matches!(q.get("from"), Some(OVal::Str(x)) if x == "admin")));
    let previews = own.get("pendingQuestionPreviews").expect("previews").stringify();
    assert!(previews.contains("owner says hi to all") && previews.contains("owner direct to you"), "{previews}");
    let recent = sum.get("recent").expect("recent").stringify();
    assert!(!recent.contains("owner says hi to all"), "the owner's row is in the advisory feed: {recent}");
    assert!(recent.contains("child fyi"), "a child's broadcast stays in the feed: {recent}");
    // a child's entry carries no owner order
    let child = sum.get("workspaces").and_then(|w| w.get("child-1")).expect("child entry").stringify();
    assert!(!child.contains(&format!("\"{flag}\":true")), "{child}");
}

/// GH #862: `mesh room create|join|leave` honour the declared sender (as `mesh send` does): the owner's room (a clean environment, here
/// in a child's checkout) joins and leaves as `admin`; an agent that declares `admin` is refused.
#[test]
fn room_ops_honour_the_declared_sender_and_refuse_an_agent() {
    let f = fx("room-admin");
    let (_primary, _key) = registry(&f, &["child-1"]);
    let mut owner = f.inv.clone();
    owner.env.remove(defaults::text("mesh_identity.agent_env_builder"));
    owner.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    let room = |inv: &Inv, words: &[&str]| crate::meshw::rooms::run(inv, &argv(words)).unwrap();
    let created = room(&owner, &["room", "create", "lab"]);
    assert_eq!(created.code, 0, "{}", created.stdout);
    assert!(created.stdout.contains("\"member\":true") && created.stdout.contains("\"admin\""), "admin created and joined: {}", created.stdout);
    let left = room(&owner, &["room", "leave", "lab"]);
    assert!(left.stdout.contains("\"changed\":true") && left.stdout.contains("\"member\":false"), "admin left: {}", left.stdout);
    let joined = room(&owner, &["room", "join", "lab"]);
    assert!(joined.stdout.contains("\"changed\":true") && joined.stdout.contains("\"member\":true"), "admin joined: {}", joined.stdout);
    // an agent (the child's builder id is set) cannot declare admin: refused, nothing changes
    let mut agent = f.inv.clone();
    agent.env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
    let refused = room(&agent, &["room", "leave", "lab"]);
    assert_ne!(refused.code, 0, "an agent left as admin: {}", refused.stdout);
    let as_flag = format!("--{}", defaults::text("mesh_identity.flag_as"));
    assert_ne!(room(&agent, &["room", "join", "lab", &as_flag, "admin"]).code, 0, "an agent joined as admin via --as");
    // the same agent, undeclared, still acts as itself
    assert_eq!(room(&f.inv, &["room", "join", "lab"]).code, 0);
}
