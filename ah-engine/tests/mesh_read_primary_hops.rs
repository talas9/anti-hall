//! `inbox read-primary <id>` where `<id>` is not a plain registered row, with NO Node: Node answers all of these, so the engine must
//! not exit 69. (a) the caller's own id before it registered: ok, empty; (b) an id a fold retired: read on the survivor, reported as
//! `redirected`/`redirectedFrom`; (c) a mesh label naming one registered row: read on that row, reported as `resolvedFrom`. (A label naming SEVERAL rows of one worktree resolves to the
//! freshest live one in Node, then widens the read to the whole mesh group: that union read is not ported, it defers `mesh-group`.)
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report
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
        let root = std::env::temp_dir().join(format!("ah-rp-hops-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(fs::remove_dir_all(&root)); // keep: our own scratch directory
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
        let o = Command::new(BIN)
            .arg("mesh")
            .args(argv)
            .current_dir(&self.repo)
            .env_clear()
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
        let v = serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("not JSON ({code}): {out}"));
        (code, v)
    }

    /// The label the caller reads as (`primary-<hash>`), from the refusal of a read of something nobody owns.
    fn caller(&self) -> String {
        self.run(&["inbox", "read-primary", "probe-nobody"]).1["callerIdentity"].as_str().unwrap().to_string()
    }

    fn register(&self, id: &str) {
        let (code, v) = self.run(&["register", id, "--worktree", self.repo.to_str().unwrap(), "--session", "s1"]);
        assert_eq!(code, 0, "{v}");
    }
}

#[test]
fn the_callers_own_unregistered_id_reads_ok_and_empty() {
    let fx = Fx::new("own");
    let me = fx.caller();
    let (code, v) = fx.run(&["inbox", "read-primary", &me]);
    assert_eq!((code, v["ok"].clone(), v["count"].clone(), v["id"].as_str()), (0, Value::Bool(true), Value::from(0), Some(me.as_str())), "{v}");
}

#[test]
fn a_fold_retired_id_reads_on_its_survivor_and_says_so() {
    let fx = Fx::new("retired");
    fx.register("survivor-ws");
    let dir = fx.home.join(".anti-hall/devswarm/retired");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("old-ws.json"), r#"{"retiredTo":"survivor-ws"}"#).unwrap();
    let (code, v) = fx.run(&["inbox", "read-primary", "old-ws"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!((v["id"].as_str(), v["redirected"].clone(), v["redirectedFrom"].as_str()), (Some("survivor-ws"), Value::Bool(true), Some("old-ws")), "{v}");
}

#[test]
fn a_mesh_label_reads_on_the_one_row_it_names_and_says_so() {
    let fx = Fx::new("label");
    fx.register("survivor-ws");
    let label = fx.caller();
    let (code, v) = fx.run(&["inbox", "read-primary", &label]);
    assert_eq!(code, 0, "{v}");
    assert_eq!((v["id"].as_str(), v["resolvedFrom"].as_str()), (Some("survivor-ws"), Some(label.as_str())), "{v}");
}

#[test]
fn an_id_prefix_naming_two_rows_is_refused_as_ambiguous_target() {
    let fx = Fx::new("ambiguous");
    fx.register("pfx-a");
    fx.register("pfx-b");
    let (code, v) = fx.run(&["inbox", "read-primary", "pfx"]);
    assert_eq!(code, 2, "{v}");
    assert_eq!((v["reason"].as_str(), v["candidates"].clone()), (Some("ambiguous-target"), serde_json::json!(["pfx-a", "pfx-b"])), "{v}");
}

#[test]
fn text_format_follows_a_redirect_and_a_resolved_label_too() {
    let fx = Fx::new("text");
    fx.register("survivor-ws");
    let dir = fx.home.join(".anti-hall/devswarm/retired");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("old-ws.json"), r#"{"retiredTo":"survivor-ws"}"#).unwrap();
    let label = fx.caller();
    for id in ["old-ws", label.as_str()] {
        let (code, out) = fx.raw(&["inbox", "read-primary", id, "--format", "text"]);
        assert_eq!((code, out.trim()), (0, "(no messages)"), "{id}");
    }
}
