//! Unit tests of the generic host API (D88): the file, process, clock and state primitives scripts call. None of them holds a rule;
//! these tests pin their bounds. (The checks' own tests are in `tests.rs`.)
use super::*;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-hostapi-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    d.to_string_lossy().to_string()
}

fn write_home(tag: &str) -> String {
    home(tag)
}

fn env(h: &str) -> RequestEnv {
    RequestEnv::from_pairs([("HOME", h)])
}

fn put_override(h: &str, name: &str, body: &str) {
    std::fs::write(format!("{h}/.anti-hall/logic/{name}.js"), body).unwrap();
}

fn run_forced(name: &str, p: &Value, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, p, &Value::Null, "PreToolUse", e)
}

// ---- the general file and process primitives (D88 batch 5) ----

#[test]
fn a_scoped_append_adds_whole_texts_and_obeys_the_write_rules() {
    let h = write_home("a-ok");
    assert!(host::append_file(&h, ".anti-hall/log/x.log", "one\n").unwrap());
    assert!(host::append_file(&h, ".anti-hall/log/x.log", "two\n").unwrap());
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/log/x.log")).unwrap(), "one\ntwo\n");
    for bad in ["/etc/x", "../x", ".anti-hall/../x", ".anti-hall", "elsewhere/f", ""] {
        assert!(host::append_file(&h, bad, "t").is_err(), "{bad:?} must be refused");
    }
    let outside = std::path::Path::new(&h).join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, format!("{h}/.anti-hall/dirlink")).unwrap();
    std::os::unix::fs::symlink(outside.join("f"), format!("{h}/.anti-hall/filelink")).unwrap();
    assert!(host::append_file(&h, ".anti-hall/dirlink/f", "x").is_err());
    assert!(host::append_file(&h, ".anti-hall/filelink", "x").is_err());
    assert!(!outside.join("f").exists());
    let big = "x".repeat(defaults::num("script.write_max_bytes") as usize + 1);
    assert!(host::append_file(&h, ".anti-hall/big", &big).is_err());
}

#[test]
fn lstat_readdir_and_readlink_describe_the_path_itself_and_are_bounded() {
    let h = write_home("fs");
    std::fs::write(format!("{h}/f"), "abc").unwrap();
    std::fs::create_dir_all(format!("{h}/d")).unwrap();
    std::os::unix::fs::symlink(format!("{h}/f"), format!("{h}/l")).unwrap();
    let st = |p: &str| serde_json::from_str::<Value>(&host::lstat(&format!("{h}/{p}"))).unwrap();
    assert_eq!((st("f")["kind"].clone(), st("f")["size"].clone()), (json!("file"), json!(3)));
    assert_eq!(st("d")["kind"], json!("dir"));
    assert_eq!(st("l")["kind"], json!("link"), "a link is described, not followed");
    assert_eq!(st("nope"), Value::Null);
    assert!(st("f")["mtimeMs"].as_f64().unwrap() > 0.0 && st("f")["mode"].as_u64().unwrap() != 0);
    assert_eq!(host::readdir(&format!("{h}/d")), Some(vec![]));
    for n in ["b", "a", "c"] {
        std::fs::write(format!("{h}/d/{n}"), "").unwrap();
    }
    assert_eq!(host::readdir(&format!("{h}/d")), Some(vec!["a".into(), "b".into(), "c".into()]));
    assert_eq!(host::readdir(&format!("{h}/f")), None, "a file is not a directory");
    assert_eq!(host::readdir(&format!("{h}/nope")), None);
    // through the script API
    put_override(
        &h,
        "zz-fs",
        &format!(
            "function decide(p){{ var s = ah.fs.lstat('{h}/l'); var t = ah.fs.readlink('{h}/l'); var d = ah.fs.readdir('{h}/d'); return (s.kind === 'link' && t === '{h}/f' && d.join() === 'a,b,c' && ah.fs.readdir('{h}/f') === null && ah.fs.readlink('{h}/f') === null) ? 'allow' : 'defer'; }}"
        ),
    );
    assert_eq!(run_forced("zz-fs", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn exec_runs_only_allow_listed_programs_with_the_request_environment_and_a_bounded_budget() {
    let h = write_home("exec");
    std::process::Command::new("git").args(["init", "-q", &format!("{h}/repo")]).output().unwrap();
    let body = format!(
        "function decide(p){{ var r = ah.exec('git', ['rev-parse','--is-inside-work-tree'], {{cwd: '{h}/repo'}}); \
         if (!r || r.status !== 0 || r.stdout.trim() !== 'true') return {{block: 'git failed ' + JSON.stringify(r)}}; \
         if (ah.exec('sh', ['-c','echo hi']) !== null) return {{block: 'sh allowed'}}; \
         var e = ah.exec('git', ['config','--get','zz.key'], {{cwd: '{h}/repo', env: {{GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'zz.key', GIT_CONFIG_VALUE_0:'v1'}}}}); \
         if (!e || e.stdout.trim() !== 'v1') return {{block: 'env override missing ' + JSON.stringify(e)}}; \
         var n = ah.exec('git', ['config','--get','zz.key'], {{cwd: '{h}/repo'}}); \
         if (!n || n.status !== 1) return {{block: 'daemon env leaked ' + JSON.stringify(n)}}; \
         if (ah.exec('git', ['--no-such-flag']).status === 0) return {{block: 'bad status'}}; \
         for (var i = 0; i < 100; i++) {{ if (ah.exec('git', ['--version']) === null) return 'allow'; }} \
         return {{block: 'no call budget'}}; }}"
    );
    put_override(&h, "zz-exec", &body);
    assert_eq!(run_forced("zz-exec", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    // the budget resets for the next call
    assert_eq!(run_forced("zz-exec", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn exec_kills_a_run_past_its_timeout_and_answers_null() {
    let h = write_home("exec-t");
    let bin = format!("{h}/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(format!("{bin}/git"), "#!/bin/sh\nsleep 30\n").unwrap();
    std::process::Command::new("chmod").args(["+x", &format!("{bin}/git")]).output().unwrap();
    put_override(&h, "zz-slow", "function decide(p){ return ah.exec('git', ['x'], {timeoutMs: 150}) === null ? 'allow' : 'defer'; }");
    // the stub's `sleep` must be found (/bin:/usr/bin); with only `bin` on the PATH the stub failed at once with 127, and the test
    // passed only when its shell was slower to start than the timeout
    let path = format!("{bin}:/bin:/usr/bin");
    let e = RequestEnv::from_pairs([("HOME", h.as_str()), ("PATH", path.as_str())]);
    let t = std::time::Instant::now();
    assert_eq!(run_forced("zz-slow", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
}

// ---- the clock, the scoped state operations and the small pure helpers of the host API ----

#[test]
fn the_clock_is_one_injectable_source() {
    host::set_clock(Some(1_700_000_000_123.0));
    assert_eq!(host::now_ms(), 1_700_000_000_123.0);
    host::set_clock(None);
    let real = host::now_ms();
    assert!(real > 1_700_000_000_000.0, "the system clock is read when nothing is injected");
    let h = write_home("clock");
    put_override(&h, "zz-clock", "function decide(p){ return ah.clock.now() === 5 ? 'allow' : 'defer'; }");
    std::fs::create_dir_all(format!("{h}/.anti-hall/logic/lib")).unwrap();
    std::fs::write(format!("{h}/.anti-hall/logic/lib/99-clock.js"), "ah.clock.now = function(){ return 5; };").unwrap();
    assert_eq!(run_forced("zz-clock", &json!({}), &env(&h)), Some(Some(Verdict::Allow)), "a script-side override pins time");
    let local: Value = serde_json::from_str(&crate::script::host_b3::local_time(1_700_000_000_000.0)).unwrap();
    assert_eq!(local["year"], 2023);
    assert!(local["offsetMinutes"].is_i64());
}

#[test]
fn state_read_remove_sweep_and_the_scoped_operations_stay_inside_the_state_directory() {
    use host::{Op, scoped, state_read, state_remove, state_sweep};
    let h = write_home("stateops");
    assert!(scoped(&h, ".anti-hall/a/b", "", Op::Mkdir).unwrap());
    assert!(std::path::Path::new(&format!("{h}/.anti-hall/a/b")).is_dir());
    assert!(scoped(&h, ".anti-hall/a/b", "", Op::Mkdir).unwrap(), "an existing directory is fine");
    assert!(scoped(&h, ".anti-hall/a/f.txt", "one", Op::Write).unwrap());
    assert!(scoped(&h, ".anti-hall/a/f.txt", "+two", Op::Append).unwrap());
    assert_eq!(state_read(&h, ".anti-hall/a/f.txt").unwrap().as_deref(), Some("one+two"));
    assert_eq!(state_read(&h, ".anti-hall/a/none.txt").unwrap(), None);
    for bad in ["/etc/passwd", "../x", ".anti-hall/../x", "elsewhere/f"] {
        assert!(state_read(&h, bad).is_err() && state_remove(&h, bad).is_err() && scoped(&h, bad, "x", Op::Mkdir).is_err(), "{bad:?} must be refused");
    }
    assert!(state_remove(&h, ".anti-hall/a/f.txt").unwrap());
    assert!(state_remove(&h, ".anti-hall/a/f.txt").unwrap(), "an absent file is the goal state");
    assert!(!state_remove(&h, ".anti-hall/a/b").unwrap(), "a directory is never removed");
    // a link is refused, not followed
    let outside = format!("{h}/outside");
    std::fs::write(&outside, "keep").unwrap();
    std::os::unix::fs::symlink(&outside, format!("{h}/.anti-hall/a/lnk")).unwrap();
    assert!(state_remove(&h, ".anti-hall/a/lnk").is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    // the sweep removes only old regular files with the prefix, oldest first, bounded
    for n in ["s-1", "s-2", "s-3", "other-1"] {
        std::fs::write(format!("{h}/.anti-hall/a/{n}"), "x").unwrap();
    }
    host::set_clock(Some(host::now_ms() + 10_000.0));
    assert!(state_sweep(&h, ".anti-hall/a", "", 1000.0, 10.0).is_err(), "an empty prefix is refused");
    assert_eq!(state_sweep(&h, ".anti-hall/a", "s-", 1000.0, 2.0).unwrap(), 2.0, "at most max files");
    assert_eq!(state_sweep(&h, ".anti-hall/a", "s-", 1000.0, 10.0).unwrap(), 1.0);
    assert!(std::path::Path::new(&format!("{h}/.anti-hall/a/other-1")).exists() && std::path::Path::new(&format!("{h}/.anti-hall/a/lnk")).exists());
    host::set_clock(None);
    assert_eq!(state_sweep(&h, ".anti-hall/a", "other-", 3_600_000.0, 10.0).unwrap(), 0.0, "a fresh file is not old");
}

#[test]
fn hashes_and_the_exec_wrappers_are_stable() {
    let h = write_home("hashes");
    put_override(
        &h,
        "zz-hash",
        "function decide(p){ return (ah.sha1('abc') === 'a9993e364706816aba3e25717850c26c9cd0d89d' && ah.fnv('') === 'cbf29ce484222325' && ah.contentHash(['a','b']).length > 0) ? 'allow' : 'defer'; }",
    );
    assert_eq!(run_forced("zz-hash", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}
