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

fn fx(tag: &str) -> Fx {
    defaults::init().unwrap();
    let home = std::env::temp_dir().join(format!("ah-subdir767-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
    let repo = home.join("repo");
    std::fs::create_dir_all(repo.join("pkg/app")).unwrap();
    let st = std::process::Command::new("git").current_dir(&repo).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
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
        let st = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
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
        let st = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
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
