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
