//! Test harness: a scratch plugin root (the shipped defaults copied in), a scratch HOME, fake engines, and a runner for the
//! `ah-hook` binary. Nothing here touches the real HOME, the live engine or ~/.claude.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static N: AtomicU32 = AtomicU32::new(0);

pub struct Env {
    pub dir: PathBuf,
    pub home: PathBuf,
    pub root: PathBuf,
    pub state: PathBuf,
}

pub struct Out {
    pub code: i32,
    pub out: Vec<u8>,
    pub err: String,
    pub ms: u128,
}

pub fn repo_defaults() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults")
}

/// Replace the `value = ...` line of the first `[section]` in a TOML text.
pub fn set_value(text: &str, section: &str, value: &str) -> String {
    let head = format!("[{section}]");
    let at = text
        .find(&head)
        .unwrap_or_else(|| panic!("no section {section}"));
    let rest = &text[at..];
    let v = rest.find("\nvalue = ").expect("value line") + 1;
    let end = rest[v..].find('\n').map_or(rest.len(), |e| v + e);
    format!(
        "{}{}value = {}{}",
        &text[..at],
        &rest[..v],
        value,
        &rest[end..]
    )
}

impl Env {
    pub fn new(tag: &str) -> Env {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(format!("/tmp/ahl-{}-{n}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let home = dir.join("h");
        let root = dir.join("plugin");
        let defaults = root.join("engine/defaults");
        std::fs::create_dir_all(&defaults).unwrap();
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        for f in [
            "index.toml",
            "engine.toml",
            "dispatch.toml",
            "messages.toml",
        ] {
            std::fs::copy(repo_defaults().join(f), defaults.join(f)).unwrap();
        }
        let state = home.join(".anti-hall/ah-engine");
        Env {
            dir,
            home,
            root,
            state,
        }
    }

    pub fn edit_toml(&self, file: &str, f: impl FnOnce(&str) -> String) {
        let p = self.root.join("engine/defaults").join(file);
        let t = std::fs::read_to_string(&p).unwrap();
        std::fs::write(p, f(&t)).unwrap();
    }

    pub fn set(&self, section: &str, value: &str) {
        let file = if section.starts_with("dispatch.") {
            "dispatch.toml"
        } else if section.starts_with("msg.") {
            "messages.toml"
        } else {
            "engine.toml"
        };
        self.edit_toml(file, |t| set_value(t, section, value));
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// An executable shell script (the fake engine, a fallback runner...).
    pub fn script(&self, name: &str, body: &str) -> PathBuf {
        let p = self.dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    pub fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.dir.join(name)).unwrap_or_default()
    }

    pub fn diag(&self) -> String {
        self.read("diag")
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(self.state.join("launcher.log")).unwrap_or_default()
    }

    pub fn command(
        &self,
        event: &str,
        args: &[&str],
        engine: Option<&Path>,
        envs: &[(&str, &str)],
    ) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-hook"));
        c.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.home)
            .env("AH_WRAPPER_TEST", "1")
            .env("AH_ENGINE_WRAPPER_DIAG", self.dir.join("diag"))
            // a generous default budget: the tests run next to builds on a loaded machine; tests about time set their own
            .env("AH_HOOK_TIMEOUT_MS", "8000")
            .arg(event)
            .args(args)
            .arg("--plugin-root")
            .arg(&self.root);
        if let Some(e) = engine {
            c.env("AH_ENGINE_BIN", e);
        }
        for (k, v) in envs {
            c.env(k, v);
        }
        c
    }

    /// Run the launcher with `input` on stdin (written by a thread, so a launcher that stops reading cannot deadlock the test).
    pub fn run(
        &self,
        event: &str,
        input: &[u8],
        engine: Option<&Path>,
        envs: &[(&str, &str)],
    ) -> Out {
        self.run_args(event, &[], input, engine, envs)
    }

    pub fn run_args(
        &self,
        event: &str,
        args: &[&str],
        input: &[u8],
        engine: Option<&Path>,
        envs: &[(&str, &str)],
    ) -> Out {
        let data = input.to_vec();
        self.run_with(self.command(event, args, engine, envs), move |mut si| {
            let _ = si.write_all(&data);
        })
    }

    pub fn run_with(
        &self,
        mut cmd: Command,
        feed: impl FnOnce(ChildStdin) + Send + 'static,
    ) -> Out {
        let t = Instant::now();
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn ah-hook");
        let si = child.stdin.take().unwrap();
        let feeder = std::thread::spawn(move || feed(si));
        let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let o = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b);
            b
        });
        let e = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b);
            b
        });
        let status = child.wait().unwrap();
        let ms = t.elapsed().as_millis();
        let _ = feeder.join();
        Out {
            code: status.code().unwrap_or(-1),
            out: o.join().unwrap(),
            err: String::from_utf8_lossy(&e.join().unwrap()).into_owned(),
            ms,
        }
    }

    pub fn spawn(&self, cmd: &mut Command) -> Child {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn ah-hook")
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only probes.
    unsafe { libc::kill(pid, 0) == 0 }
}

pub fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn pid_from(path: &Path) -> Option<i32> {
    std::fs::read_to_string(path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// A deterministic non-trivial byte stream (not all zeros, so a lost chunk shows).
pub fn pattern(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i.wrapping_mul(31) ^ (i >> 7)) as u8)
        .collect()
}
