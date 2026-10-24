#![allow(clippy::panic, clippy::unreachable, dead_code, clippy::let_underscore_must_use)]
//! W4b: the steps the supervisor duties used to hold, ported natively. Every case runs in a scratch home under the system temp
//! directory (never the real one) and applies the engine's own plan.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::dssup::appsync::plan::{self, Retired};
use ah_engine::dssup::recon::view;
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::MeshStore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const NOW: i64 = 1_760_000_000_000;

struct Fix {
    home: PathBuf,
    st: Settings,
    root: PathBuf,
}

fn init_defaults() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before this process reads the defaults; nothing else here touches this variable
        unsafe { std::env::set_var("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")) };
        ah_engine::defaults::init().expect("defaults load");
    });
}

fn fix(tag: &str) -> Fix {
    init_defaults();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = std::env::temp_dir().join(format!("ah-w4b-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    std::fs::create_dir_all(&home).unwrap();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    Fix { home, st, root: ah_engine::defaults::root().unwrap() }
}

impl Fix {
    fn ctx(&self) -> Ctx<'_> {
        Ctx { home: &self.home, root: &self.root, st: &self.st, now: NOW, engine_pokes: false }
    }
    fn ds(&self, rel: &str) -> String {
        format!(".anti-hall/devswarm/{rel}")
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.home.join(rel)).ok()
    }
    fn repo(&self, name: &str) -> String {
        let p = self.home.join("repos").join(name);
        std::fs::create_dir_all(&p).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&p).status().unwrap().success());
        std::fs::canonicalize(&p).unwrap().to_string_lossy().into_owned()
    }
    fn store(&self, key: &str) -> MeshStore {
        let dir = self.home.join(self.ds(&format!("store/{key}")));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
        MeshStore::open(&dir.join("devswarm.db")).unwrap()
    }
}

impl Drop for Fix {
    fn drop(&mut self) {
        // our own scratch home, created by `fix`
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn marker(wt: &str, by: &str) -> String {
    format!(
        "{{\"id\":\"W\",\"worktreePath\":\"{wt}\",\"sessionId\":\"sw\",\"archivedBy\":\"{by}\",\"archivedAt\":5,\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null}}"
    )
}

#[test]
fn dssup_recon_w4b_retire_marker_restores_then_moves_the_marker() {
    let f = fix("retire");
    let p = f.repo("p");
    let k = ah_engine::meshw::ident::repo_key_for_worktree(&p).unwrap().unwrap();
    f.put(&f.ds("archived/W.json"), &marker(&p, "devswarm-app"));
    f.store(&k);
    let before = f.read(&f.ds("archived/W.json")).unwrap();
    assert_eq!(plan::retire_marker(&f.ctx(), "W", "W"), Retired::Done);
    // the marker left archived/, never deleted: its bytes plus the retire record are in archived-retired/
    assert!(f.read(&f.ds("archived/W.json")).is_none());
    let kept = f.read(&f.ds(&format!("archived-retired/W.{NOW}.json"))).unwrap();
    let v: serde_json::Value = serde_json::from_str(&kept).unwrap();
    assert_eq!(v["retired"]["by"], "devswarm-app-sync");
    assert_eq!(v["retired"]["builderId"], "W");
    assert_eq!(v["retired"]["restored"], true);
    assert_eq!(v["retired"]["at"], NOW);
    let prior: serde_json::Value = serde_json::from_str(&before).unwrap();
    for key in ["id", "worktreePath", "sessionId", "archivedBy", "archivedAt"] {
        assert_eq!(v[key], prior[key], "{key} kept");
    }
    // the workspace is active again: descriptor back, registry row live
    assert!(f.read(&f.ds("workspaces/W.json")).is_some());
    assert!(view::registry(&f.home, &k).unwrap().iter().any(|r| r.row.id == "W"));
    // idempotent: the marker is gone now
    assert_eq!(plan::retire_marker(&f.ctx(), "W", "W"), Retired::Gone);
}

#[test]
fn dssup_recon_w4b_retire_marker_leaves_the_marker_when_restore_fails() {
    let f = fix("retire-fail");
    // a marker with no worktree cannot be restored: nothing moves
    f.put(&f.ds("archived/W.json"), "{\"id\":\"W\",\"archivedBy\":\"devswarm-app\",\"archivedAt\":5}");
    let r = plan::retire_marker(&f.ctx(), "W", "W");
    assert!(matches!(r, Retired::Left(ref why) if why.starts_with("restore-failed")), "{r:?}");
    assert!(f.read(&f.ds("archived/W.json")).is_some());
    assert!(f.read(&f.ds(&format!("archived-retired/W.{NOW}.json"))).is_none());
}

#[test]
fn dssup_recon_w4b_name_backfill_reads_labels_and_writes_the_cache() {
    use ah_engine::dssup::appsync::state;
    let f = fix("names");
    let raw = r#"[{"id":"a1","label":"First title"},{"id":"b2","label":""},{"id":7,"label":"numeric id"},"junk",{"label":"no id"},{"id":"c3"}]"#;
    let got = state::parse_labels(raw);
    assert_eq!(got, vec![("a1".to_string(), Some("First title".to_string())), ("b2".to_string(), None), ("c3".to_string(), None)]);
    // the `{children: [...]}` shape is read too, anything else is an empty list
    assert_eq!(state::parse_labels(r#"{"children":[{"id":"x","label":"L"}]}"#).len(), 1);
    assert!(state::parse_labels("not json").is_empty());
    // writing the cache: Node's `{name, updatedAt}`, an empty name writes nothing
    assert!(state::write_name(&f.home, "a1", "First title", NOW));
    assert!(!state::write_name(&f.home, "b2", "", NOW));
    assert_eq!(state::read_name(&f.home, "a1").as_deref(), Some("First title"));
    assert!(state::read_name(&f.home, "b2").is_none());
    let text = f.read(&f.ds("names/a1.json")).unwrap();
    assert_eq!(text, format!("{{\"name\":\"First title\",\"updatedAt\":{NOW}}}"));
}
