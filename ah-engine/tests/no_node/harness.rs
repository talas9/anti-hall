//! The scratch world every no-Node case runs in: a fresh HOME with the engine installed where the wrappers look for it, a
//! copy of the plugin, a fixture project, and a PATH with no Node on it but a recording `node` shim placed first.

use crate::common;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The tag the harness gives its own daemon: a Node start the daemon makes (a scheduled duty) is attributed to it, not to
/// the case that happened to be running.
pub const DAEMON_TAG: &str = "daemon";

/// This directory (tests/no_node).
pub fn here() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("no_node")
}

/// The plugin of this checkout (the harness copies it, never writes into it).
pub fn plugin_src() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall")
}

/// harness.toml.
pub fn cfg() -> toml::Table {
    let text = fs::read_to_string(here().join("harness.toml")).unwrap();
    text.parse::<toml::Table>().unwrap()
}

/// A string list at `section.key` of harness.toml.
pub fn cfg_list(cfg: &toml::Table, section: &str, key: &str) -> Vec<String> {
    cfg[section][key].as_array().unwrap_or_else(|| panic!("harness.toml {section}.{key}")).iter().map(|v| v.as_str().unwrap().to_string()).collect()
}

/// An integer at `section.key` of harness.toml.
pub fn cfg_int(cfg: &toml::Table, section: &str, key: &str) -> u64 {
    u64::try_from(cfg[section][key].as_integer().unwrap_or_else(|| panic!("harness.toml {section}.{key}"))).unwrap()
}

/// A string at `section.key` of harness.toml.
pub fn cfg_str(cfg: &toml::Table, section: &str, key: &str) -> String {
    cfg[section][key].as_str().unwrap_or_else(|| panic!("harness.toml {section}.{key}")).to_string()
}

/// One `node` start the shim recorded.
#[derive(Debug, Clone)]
pub struct Hit {
    /// The shim's argv, joined by spaces.
    pub argv: String,
}

/// What one run produced.
#[derive(Debug)]
pub struct Outcome {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub elapsed_ms: u128,
}

pub struct World {
    pub dir: common::TempDir,
    pub cfg: toml::Table,
    pub home: PathBuf,
    pub plugin: PathBuf,
    pub project: PathBuf,
    pub transcript: PathBuf,
    pub engine: PathBuf,
    pub state: PathBuf,
    shim_dir: PathBuf,
    tools_dir: PathBuf,
    log: PathBuf,
    log_offset: std::cell::Cell<usize>,
    daemon: Option<Child>,
    /// Every Node start read so far, by the tag of the run that caused it. A run's Node work can outlive it (a detached
    /// background witness), so a start is attributed by its tag, never by when it was logged.
    by_tag: std::cell::RefCell<BTreeMap<String, Vec<Hit>>>,
    /// The tag of the latest command: a start whose environment lost the tag is given to the run it appeared during.
    current: std::cell::RefCell<String>,
    seq: std::cell::Cell<u32>,
}

impl World {
    pub fn new(name: &str) -> World {
        let cfg = cfg();
        let dir = common::TempDir::at(std::env::temp_dir().join(format!("ah-nonode-{name}-{}", std::process::id())));
        let root = dir.path().to_path_buf();
        assert!(!root.to_string_lossy().contains(char::is_whitespace), "the scratch path must have no spaces (the shim log splits argv on them)");
        let home = root.join("home");
        let shim_dir = root.join("shim");
        let tools_dir = root.join("tools");
        for d in [&home, &shim_dir, &tools_dir, &root.join("tmp"), &root.join("out")] {
            fs::create_dir_all(d).unwrap();
        }

        // what the host itself leaves in a HOME it is installed in (harness.toml [home]); nothing of anti-hall
        if let Some(files) = cfg.get("home").and_then(|h| h.get("files")).and_then(|f| f.as_table()) {
            for (rel, body) in files {
                let p = home.join(rel);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(p, body.as_str().unwrap()).unwrap();
            }
        }

        // the plugin, copied: a verb that writes into its plugin (a heal, a generated file) never touches the checkout
        let plugin = root.join("plugin");
        let st = Command::new("cp").arg("-R").arg(plugin_src()).arg(&plugin).status().unwrap();
        assert!(st.success(), "copying the plugin failed");

        // the engine, installed where ah-hook.sh and ah-run.sh look first
        let engine_dir = home.join(".anti-hall").join("ah-engine").join("bin");
        fs::create_dir_all(&engine_dir).unwrap();
        let engine = engine_dir.join("ah-engine");
        fs::copy(env!("CARGO_BIN_EXE_ah-engine"), &engine).unwrap();
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        let state = home.join(".anti-hall").join("ah-engine");

        // PATH: symlinks to the system tools minus the exclusions; no Node anywhere
        let exclude = cfg_list(&cfg, "path", "exclude");
        for sys in cfg_list(&cfg, "path", "system_dirs") {
            let Ok(rd) = fs::read_dir(&sys) else { continue };
            for e in rd.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if exclude.iter().any(|x| x == n.as_ref()) {
                    continue;
                }
                let link = tools_dir.join(&name);
                if link.symlink_metadata().is_ok() {
                    continue; // an earlier system dir already provides it
                }
                ah_engine::discard::harmless(std::os::unix::fs::symlink(e.path(), &link));
            }
        }
        for x in &exclude {
            assert!(tools_dir.join(x).symlink_metadata().is_err(), "{x} must not be on the harness PATH");
        }

        // the recording shim: logs "<tag>\t<argv>" and fails the way a missing command does
        let log = root.join("node-hits.log");
        fs::write(&log, "").unwrap();
        let shim = shim_dir.join("node");
        let body = format!(
            "#!/bin/sh\nprintf '%s\\t%s\\n' \"${{AH_NO_NODE_CASE:-unknown}}\" \"$*\" >> '{}'\nprintf '%s\\n' '{}' >&2\nexit {}\n",
            log.display(),
            cfg_str(&cfg, "shim", "stderr"),
            cfg_int(&cfg, "shim", "exit")
        );
        fs::write(&shim, body).unwrap();
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();

        // a fixture project: a git repo with one commit, and a short transcript
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("README.md"), "fixture\n").unwrap();
        let git = |args: &[&str]| {
            let o = Command::new("git")
                .args(["-c", "user.name=no-node", "-c", "user.email=no-node@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&project)
                .env("HOME", &home)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        };
        git(&["init", "-q"]);
        git(&["add", "README.md"]);
        git(&["commit", "-q", "-m", "fixture"]);
        let transcript = root.join("transcript.jsonl");
        fs::write(
            &transcript,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Please list the files in this repo.\"},\"sessionId\":\"no-node\"}\n",
        )
        .unwrap();

        World {
            dir,
            cfg,
            home,
            plugin,
            project,
            transcript,
            engine,
            state,
            shim_dir,
            tools_dir,
            log,
            log_offset: std::cell::Cell::new(0),
            daemon: None,
            by_tag: std::cell::RefCell::new(BTreeMap::new()),
            current: std::cell::RefCell::new(String::new()),
            seq: std::cell::Cell::new(0),
        }
    }

    /// The PATH every run gets.
    pub fn path_var(&self) -> String {
        format!("{}:{}", self.shim_dir.display(), self.tools_dir.display())
    }

    /// Replace the harness placeholders ({cwd}, {transcript}, {home}, {plugin}) in `s`.
    pub fn subst(&self, s: &str) -> String {
        s.replace("{cwd}", &self.project.to_string_lossy())
            .replace("{transcript}", &self.transcript.to_string_lossy())
            .replace("{home}", &self.home.to_string_lossy())
            .replace("{plugin}", &self.plugin.to_string_lossy())
    }

    /// A command with the cleared, no-Node environment of a run tagged `tag`.
    pub fn command(&self, program: impl AsRef<std::ffi::OsStr>, tag: &str) -> Command {
        self.current.replace(tag.to_string());
        let mut c = Command::new(program);
        c.env_clear()
            .env("PATH", self.path_var())
            .env("HOME", &self.home)
            .env("USER", "no-node")
            .env("LOGNAME", "no-node")
            .env("SHELL", "/bin/sh")
            // the test's own temp dir: the daemon socket falls back under it when the state path is too long, and the test
            // must compute the same socket path as the daemon
            .env("TMPDIR", std::env::temp_dir())
            .env("CLAUDE_PLUGIN_ROOT", &self.plugin)
            .env("AH_NO_NODE_CASE", tag)
            .current_dir(&self.project);
        if let Some(env) = self.cfg.get("env").and_then(|v| v.as_table()) {
            for (k, v) in env {
                c.env(k, v.as_str().unwrap());
            }
        }
        for name in cfg_list(&self.cfg, "passthrough", "names") {
            if let Some(v) = std::env::var_os(&name) {
                c.env(name, v);
            }
        }
        c
    }

    /// Start the engine daemon under the daemon tag, so the clients of every case use it (and none starts its own).
    pub fn start_daemon(&mut self) {
        let mut c = self.command(&self.engine, DAEMON_TAG);
        c.arg("serve").stdin(Stdio::null()).stdout(Stdio::from(self.out_file("daemon.out"))).stderr(Stdio::from(self.out_file("daemon.err")));
        c.process_group(0);
        self.daemon = Some(c.spawn().unwrap());
        let ready = Duration::from_secs(cfg_int(&self.cfg, "timeouts", "daemon_ready_s"));
        let sock = ah_engine::paths::socket_in(&self.state);
        let t = Instant::now();
        while t.elapsed() < ready {
            if sock.exists() && common::marker_pid(&self.state).is_some() {
                return;
            }
            if let Some(st) = self.daemon.as_mut().unwrap().try_wait().unwrap() {
                panic!(
                    "the harness daemon exited ({st}) before it was ready; stderr: {}",
                    fs::read_to_string(self.dir.join("out").join("daemon.err")).unwrap_or_default()
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!(
            "the harness daemon did not come up within {ready:?}; stderr: {}",
            fs::read_to_string(self.dir.join("out").join("daemon.err")).unwrap_or_default()
        );
    }

    fn out_file(&self, name: &str) -> fs::File {
        fs::File::create(self.dir.join("out").join(name)).unwrap()
    }

    /// Run `c` (built by `command`) with `stdin`, bounded by `timeout`; the process group is killed on a timeout.
    pub fn run(&self, mut c: Command, stdin: Option<&str>, timeout: Duration) -> Outcome {
        let n = self.seq.get() + 1;
        self.seq.set(n);
        let (out_p, err_p) = (self.dir.join("out").join(format!("{n}.out")), self.dir.join("out").join(format!("{n}.err")));
        c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::from(fs::File::create(&out_p).unwrap()))
            .stderr(Stdio::from(fs::File::create(&err_p).unwrap()));
        c.process_group(0);
        let t = Instant::now();
        let mut ch = c.spawn().unwrap();
        if let Some(input) = stdin {
            let mut si = ch.stdin.take().unwrap();
            match si.write_all(input.as_bytes()) {
                Ok(()) | Err(_) => {} // a command that does not read its stdin closes the pipe early: not an error of the case
            }
        }
        let mut timed_out = false;
        let code = loop {
            if let Some(st) = ch.try_wait().unwrap() {
                break st.code();
            }
            if t.elapsed() > timeout {
                timed_out = true;
                let pid = i32::try_from(ch.id()).unwrap();
                // SAFETY: plain integer arguments; the group is the one this run created (process_group(0)).
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                break ch.wait().unwrap().code();
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let elapsed_ms = t.elapsed().as_millis();
        self.take_hits(); // now, so a start that lost its tag is given to this run
        Outcome { code, stdout: fs::read_to_string(&out_p).unwrap_or_default(), stderr: fs::read_to_string(&err_p).unwrap_or_default(), timed_out, elapsed_ms }
    }

    /// Read the shim lines written since the last call into the per-tag record.
    pub fn take_hits(&self) {
        let text = fs::read_to_string(&self.log).unwrap_or_default();
        let start = self.log_offset.get().min(text.len());
        // only whole lines: a line still being written is read next time
        let end = text[start..].rfind('\n').map_or(start, |i| start + i + 1);
        self.log_offset.set(end);
        let current = self.current.borrow().clone();
        let mut by_tag = self.by_tag.borrow_mut();
        for line in text[start..end].lines() {
            let (tag, argv) = line.split_once('\t').unwrap_or(("unknown", line));
            let tag = if tag == "unknown" { current.as_str() } else { tag };
            let hit = Hit { argv: argv.to_string() };
            by_tag.entry(tag.to_string()).or_default().push(hit);
        }
    }

    /// Every Node start attributed to `tag` so far (call after `settle`).
    pub fn hits_of(&self, tag: &str) -> Vec<Hit> {
        self.by_tag.borrow().get(tag).cloned().unwrap_or_default()
    }

    /// Wait for Node work the runs left in the background (harness.toml timeouts.settle_ms), stop the daemon, and read the
    /// log one last time.
    pub fn settle(&mut self) {
        std::thread::sleep(Duration::from_millis(cfg_int(&self.cfg, "timeouts", "settle_ms")));
        self.stop();
    }

    /// The plugin-relative script a recorded node argv starts (`hooks/git-guard.js`), else the argv itself.
    pub fn script_key(&self, argv: &str) -> String {
        let root = format!("{}/", self.plugin.display());
        argv.split_whitespace()
            .find(|w| [".js", ".mjs", ".cjs"].iter().any(|e| w.ends_with(e)))
            .map(|w| w.strip_prefix(&root).unwrap_or(w).to_string())
            .unwrap_or_else(|| format!("node {argv}"))
    }

    /// Where a report of this run is written (kept after the scratch world is removed).
    pub fn report_path(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("no_node");
        fs::create_dir_all(&d).unwrap();
        d.join(format!("{name}.json"))
    }

    /// Stop the daemon (and any a client started anyway) before the world is removed.
    pub fn stop(&mut self) {
        if let Some(mut ch) = self.daemon.take() {
            common::stop_child(&ah_engine::paths::socket_in(&self.state), &mut ch);
        }
        let (engine, home, state) = (self.engine.clone(), self.home.clone(), self.state.clone());
        common::reap(&state, || {
            ah_engine::discard::harmless(Command::new(&engine).arg("stop").env_clear().env("HOME", &home).env("AH_ENGINE_DIR", &state).output());
        });
        self.current.replace(String::new());
        self.take_hits();
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Observations of one test: (surface, Node path) -> the cases that showed it.
pub type Seen = BTreeMap<(String, String), Vec<String>>;

/// Record that `case` reached the Node path `key` on `surface`.
pub fn note(seen: &mut Seen, surface: &str, key: &str, case: &str) {
    let v = seen.entry((surface.to_string(), key.to_string())).or_default();
    if !v.iter().any(|c| c == case) {
        v.push(case.to_string());
    }
}

/// Collect a path's files with extension `ext`, sorted.
pub fn files_with_ext(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            files_with_ext(&p, ext, out);
        } else if p.extension().is_some_and(|e| e == ext) {
            out.push(p);
        }
    }
}
