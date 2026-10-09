//! Test support shared by the handover and Codex checks: a throw-away sandbox with its own home directory.
use crate::reqenv::RequestEnv;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) struct Sandbox {
    pub(crate) root: PathBuf,
}

impl Sandbox {
    pub(crate) fn new(tag: &str) -> Sandbox {
        let root = std::env::temp_dir().join(format!("ah-codex-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&root));
        std::fs::create_dir_all(root.join("home/.anti-hall")).unwrap();
        Sandbox { root }
    }

    pub(crate) fn home(&self) -> String {
        self.root.join("home").to_string_lossy().into_owned()
    }

    pub(crate) fn env(&self, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs: Vec<(String, String)> = vec![("HOME".into(), self.home()), ("TMPDIR".into(), self.root.join("tmp").to_string_lossy().into_owned())];
        if let Some(tz) = crate::checks::jsport::date::process_zone() {
            pairs.push(("TZ".into(), tz)); // the request carries the zone this test process runs in
        }
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    pub(crate) fn write(&self, rel: &str, text: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        p
    }

    pub(crate) fn age(&self, rel: &str, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(self.root.join(rel)).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    pub(crate) fn state(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.root.join("home/.anti-hall/codex-availability.json")).unwrap()).unwrap()
    }
}

pub(crate) fn git(dir: &Path, args: &[&str]) {
    let st = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
}
