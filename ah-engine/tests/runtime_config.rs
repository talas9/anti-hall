//! D17 (amended): the engine reads its settings, tables, messages and rules from the plugin's files at run time.
//!
//! One real daemon on a COPY of the plugin's `engine/` directory, an isolated HOME and state directory (never the user's
//! real `~/.anti-hall`). Environment variables are process-global, so the daemon scenarios live in one test that walks them
//! in order: a defaults edit is live without a restart, an invalid edit keeps the last good snapshot and is logged with a
//! reason code, a plugin update (a directory swap) is picked up. Then the cold-start case, where nothing can be loaded: the
//! engine answers "unavailable" (the exit code the wrapper turns into the Node fallback), never a built-in default.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
mod common;
use ah_engine::client;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(30) {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

/// Replace a file atomically (write a sibling, then rename), the way editors do.
fn put(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_dir(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

/// A copy of the plugin's `engine/` directory (its defaults and rules) as a plugin root.
fn plugin_copy(to: &Path) {
    let from = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    copy_dir(&from, &to.join("engine"));
}

fn status() -> Option<Value> {
    client::ctl_json("status")
}

fn queue_cap() -> Option<u64> {
    status()?["queue_cap"].as_u64()
}

/// Set `value` of the setting `[section.name]` in a defaults file's text.
fn set_value(text: &str, table: &str, value: u64) -> String {
    let head = format!("[{table}]\n");
    let at = text.find(&head).unwrap_or_else(|| panic!("{table} not in file"));
    let rest = &text[at..];
    let v = rest.find("\nvalue = ").unwrap() + 1;
    let end = v + rest[v..].find('\n').unwrap();
    format!("{}value = {value}{}", &text[..at + v], &text[at + end..])
}

fn run_hook(root: &Path, plugin_root: &Path, state: &Path) -> (i32, String, String) {
    let mut c = Command::new(BIN);
    c.args(["hook", "--event", "Stop"])
        .env("HOME", root.join("home"))
        .env("AH_ENGINE_DIR", state)
        .env("AH_ENGINE_PLUGIN_ROOT", plugin_root)
        .env("AH_ENGINE_NOSPAWN", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let o = c.output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
}

#[test]
fn defaults_are_read_at_run_time_hot_swapped_and_never_defaulted() {
    let root: PathBuf = PathBuf::from("/tmp").join(format!("ah-rtcfg-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    let (eng, plugin) = (root.join("eng"), root.join("plugin"));
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(&eng).unwrap();
    plugin_copy(&plugin);
    let engine_toml = plugin.join("engine/defaults/engine.toml");
    for (k, v) in [
        ("HOME", root.join("home").to_string_lossy().to_string()),
        ("AH_ENGINE_DIR", eng.to_string_lossy().to_string()),
        ("AH_ENGINE_PLUGIN_ROOT", plugin.to_string_lossy().to_string()),
        ("AH_ENGINE_CONFIG_WATCH_MS", "50".into()),
        ("AH_ENGINE_CONFIG_DEBOUNCE_MS", "100".into()),
        ("AH_ENGINE_NOSPAWN", "1".into()),
    ] {
        // SAFETY: this test crate holds a single test, so no other thread of this process reads or writes the environment.
        unsafe { std::env::set_var(k, v) };
    }
    let daemon = Command::new(BIN).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    struct Reap(PathBuf, std::process::Child);
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = client::ctl("stop");
            let t = Instant::now();
            while self.1.try_wait().ok().flatten().is_none() && t.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(20));
            }
            common::reap(&self.0, || {});
            // the direct child, whatever the marker said, then the files: the dir goes only once the daemon is gone
            ah_engine::discard::harmless(self.1.kill());
            ah_engine::discard::harmless(self.1.wait());
            if let Some(root) = self.0.parent() {
                ah_engine::discard::harmless(std::fs::remove_dir_all(root));
            }
        }
    }
    let _guard = Reap(eng.clone(), daemon);
    wait_for("the daemon to answer", || client::ping(&ah_engine::paths::socket()).is_some());

    // ---- start-up: read from the plugin's files, snapshot cache written ----------------------------------------------
    let q0 = queue_cap().expect("status");
    assert!(eng.join("defaults.cache").is_file(), "the daemon writes the validated snapshot cache for the thin client");
    let cached = std::fs::read_to_string(eng.join("defaults.cache")).unwrap();
    assert!(cached.lines().next().unwrap().ends_with(&plugin.to_string_lossy().to_string()), "the cache records the plugin root it was read from");

    // ---- an edit of a defaults file is live within the watch interval, with no restart --------------------------------
    let original = std::fs::read_to_string(&engine_toml).unwrap();
    let (q1, q2, q3) = (q0 + 31, q0 + 32, q0 + 33);
    put(&engine_toml, &set_value(&original, "daemon.queue", q1));
    wait_for("the edited default", || queue_cap() == Some(q1));
    assert!(std::fs::read_to_string(eng.join("defaults.cache")).unwrap().contains(&format!("\"v\":{q1}")), "the cache is regenerated on every load");
    assert!(ah_engine::health::events().iter().any(|e| e.kind == "defaults_applied"), "an applied reload is logged");

    // ---- an invalid edit falls back to the last-known-good copy (which holds the earlier edit), logged with a reason code ----
    let good = std::fs::read_to_string(&engine_toml).unwrap();
    put(&engine_toml, &set_value(&good, "daemon.queue", q2).replacen("[daemon.queue]\n", "[daemon.queue\n", 1)); // not TOML
    wait_for("the parse fallback", || ah_engine::health::events().iter().any(|e| e.kind == "defaults_fallback" && e.code == "parse"));
    assert_eq!(queue_cap(), Some(q1), "the broken file is answered by its last good copy, edit included");
    assert!(status().is_some_and(|s| s["health"]["degraded"] == true), "a defaults fallback marks the engine degraded");
    // a well-formed file that breaks a rule (a setting with no `doc`) falls back for that setting only, with its own code
    let undocumented = good.replacen("[daemon.queue]\ndoc = ", "[daemon.queue]\nnote = ", 1);
    assert_ne!(undocumented, good);
    put(&engine_toml, &undocumented);
    wait_for("the doc fallback", || ah_engine::health::events().iter().any(|e| e.kind == "defaults_fallback" && e.code == "doc"));
    assert_eq!(queue_cap(), Some(q1));
    // fixing the file applies it and clears the error
    put(&engine_toml, &set_value(&good, "daemon.queue", q2));
    wait_for("the fixed file", || queue_cap() == Some(q2));
    wait_for("the error to clear", || status().is_some_and(|s| s["config"]["last_error"].is_null()));

    // ---- a plugin update: the directory is swapped for a newer copy at the same path ---------------------------------
    let next = root.join("plugin-next");
    plugin_copy(&next);
    let next_toml = next.join("engine/defaults/engine.toml");
    put(&next_toml, &set_value(&std::fs::read_to_string(&next_toml).unwrap(), "daemon.queue", q3));
    let old = root.join("plugin-old");
    std::fs::rename(&plugin, &old).unwrap();
    std::fs::rename(&next, &plugin).unwrap();
    wait_for("the swapped plugin directory", || queue_cap() == Some(q3));

    // ---- an update that installs a NEW path: a request that names it moves the daemon there -------------------------
    let moved = root.join("plugin-moved");
    plugin_copy(&moved);
    let moved_toml = moved.join("engine/defaults/engine.toml");
    let q4 = q3 + 1;
    put(&moved_toml, &set_value(&std::fs::read_to_string(&moved_toml).unwrap(), "daemon.queue", q4));
    std::thread::sleep(Duration::from_millis(1100)); // a newer index than the active root's, whatever the file system's clock grain
    std::fs::write(moved.join("engine/defaults/index.toml"), std::fs::read_to_string(moved.join("engine/defaults/index.toml")).unwrap()).unwrap();
    let hook = |root_path: &Path| {
        // what the wrapper and the host give a hook client: the plugin root in the engine's own variable and the host's
        let mut c = Command::new(BIN);
        c.args(["hook", "--event", "Stop", "--host", "claude"])
            .env("AH_ENGINE_PLUGIN_ROOT", root_path)
            .env("CLAUDE_PLUGIN_ROOT", root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut ch = c.spawn().unwrap();
        let mut stdin = ch.stdin.take().unwrap();
        std::io::Write::write_all(&mut stdin, br#"{"session_id":"s1","cwd":"/tmp","hook_event_name":"Stop"}"#).ok();
        drop(stdin);
        ch.wait().ok();
    };
    hook(&moved);
    wait_for("a request naming the newer plugin root", || queue_cap() == Some(q4));
    hook(&plugin); // an older root, named by a request of another session, must not move it back
    std::thread::sleep(Duration::from_millis(600));
    // a status call that gets no answer (a busy CI runner) says nothing about the root: wait for an answer, then judge it
    wait_for("the daemon to answer a status call", || queue_cap().is_some());
    assert_eq!(queue_cap(), Some(q4), "an older plugin root is ignored");
    assert!(ah_engine::health::events().iter().all(|e| e.kind != "defaults_invalid" || e.code != "no_root"));

    // ---- cold start with nothing to read: unavailable (exit 75 = the wrapper's cue), logged, never a built-in default --------
    let (empty, fresh_state) = (root.join("empty-plugin"), root.join("fresh-state"));
    std::fs::create_dir_all(&empty).unwrap();
    let (code, out, err) = run_hook(&root, &empty, &fresh_state);
    assert_eq!(code, 75, "no defaults and no cache: the engine cannot answer ({err})");
    assert!(out.is_empty(), "nothing is printed on stdout (that would read as an allow)");
    assert!(err.contains("no_root"), "the reason is named: {err}");
    let note = std::fs::read_to_string(fresh_state.join("defaults.error")).expect("the reason is also written down in the state dir");
    assert!(note.contains("no_root"));
    // a broken file at cold start is answered by the plugin's pristine copy (no last-known-good copy in a fresh state dir)
    let broken = root.join("broken-plugin");
    plugin_copy(&broken);
    std::fs::write(broken.join("engine/defaults/engine.toml"), "[daemon\nnot toml").unwrap();
    let (code, _, err) = run_hook(&root, &broken, &root.join("fresh-state-1"));
    assert_ne!(code, 75, "the pristine copy answers: {err}");
    // with the pristine copy broken too: unavailable, with the validation code
    std::fs::write(broken.join("engine/defaults.pristine/engine.toml"), "[daemon\nnot toml").unwrap();
    let (code, _, err) = run_hook(&root, &broken, &root.join("fresh-state-2"));
    assert_eq!(code, 75, "{err}");
    assert!(err.contains("parse"), "{err}");
    // a plugin whose defaults lack a setting this engine reads (version skew) is rejected at load, not in a hook call
    let skewed = root.join("skewed-plugin");
    plugin_copy(&skewed);
    let msgs = skewed.join("engine/defaults/messages.toml");
    let eng_text = std::fs::read_to_string(&msgs).unwrap();
    let cut = eng_text.find("[msg.client_timeout]").unwrap();
    let end = cut + eng_text[cut..].find("\n\n").unwrap() + 2;
    std::fs::write(&msgs, format!("{}{}", &eng_text[..cut], &eng_text[end..])).unwrap();
    // (the pristine copy ships the same skew: a missing setting is otherwise taken from it)
    std::fs::write(skewed.join("engine/defaults.pristine/messages.toml"), format!("{}{}", &eng_text[..cut], &eng_text[end..])).unwrap();
    let (code, _, err) = run_hook(&root, &skewed, &root.join("fresh-state-3"));
    assert_eq!(code, 75, "{err}");
    assert!(err.contains("missing_key") && err.contains("msg.client_timeout"), "{err}");
    // the same files read fine when whole: the client then answers (here: nothing to run, so a quiet exit 0 or the fallback cue is not 75)
    let (code, _, err) = run_hook(&root, &plugin, &root.join("fresh-state-4"));
    assert_ne!(code, 75, "good defaults are loadable: {err}");
    assert!(root.join("fresh-state-4").join("defaults.cache").is_file(), "a client that had to parse the files leaves the cache for the next call");
    // the guard reaps the daemon, then removes `root` (removing it here first left the daemon running with no marker to find)
}
