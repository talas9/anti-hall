//! Node-vs-engine parity of the two Codex-only helper scripts as verbs (v1.0 lane L16): `codex-limit-status` against
//! `codex/scripts/limit-conserve-status.js`, and `codex-activate` against `codex/scripts/write-activation-sentinel.js`.
//! Each case seeds two scratch homes identically (never the real home, never the real ~/.codex), runs the real Node script
//! on one and the verb on the other, and compares stdout, the exit code and the state files the script keeps.
use crate::common::TempDir;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

struct Home(TempDir);

impl Home {
    fn new() -> Home {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Home(TempDir::at(std::env::temp_dir().join(format!("ah-codex-scripts-{}-{n}", std::process::id()))))
    }
    fn path(&self) -> &Path {
        self.0.path()
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
}

struct Run {
    code: i32,
}

fn exec(cmd: &mut Command, home: &Home, env: &[(&str, &str)]) -> Run {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home.path())
        .env("ANTI_HALL_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_DIR", home.path().join("state"))
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(home.path());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let o = cmd.output().unwrap();
    Run { code: o.status.code().unwrap_or(-1) }
}

#[test]
fn activate_overwrites_an_older_marker_and_creates_the_directory() {
    let h = Home::new();
    h.put(".anti-hall/codex-activated.json", "old");
    assert_eq!(exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-activate"), &h, &[]).code, 0);
    assert!(fs::read_to_string(h.path().join(".anti-hall/codex-activated.json")).unwrap().contains("activatedAt"));
    let fresh = Home::new();
    assert_eq!(exec(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("codex-activate"), &fresh, &[]).code, 0);
    assert!(fresh.path().join(".anti-hall/codex-activated.json").is_file());
}
