//! A bad `git.commit_expansion_patterns` entry (a lookbehind, `\b`, `\B`, a `^` anywhere, or an invalid regex) must never turn the
//! fail-closed git guard into a wall: the entry is dropped, the user is told ONCE per session, and every other git check keeps
//! working. Own test binary: the plugin root is process-wide, so this one runs against a copy of the shipped engine files whose
//! `commit_expansion_patterns` holds the bad entries.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::checks::Verdict;
use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::path::{Path, PathBuf};

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()).unwrap() }
    }
}

fn root_with_patterns(tmp: &Path, patterns: &str) -> PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall");
    let root = tmp.join("plugin");
    copy_dir(&src.join("engine"), &root.join("engine"));
    let f = root.join("engine/defaults/git.toml");
    let t = std::fs::read_to_string(&f).unwrap();
    let marker = "[git.commit_expansion_patterns]";
    let at = t.find(marker).unwrap();
    let vat = at + t[at..].find("value = ").unwrap();
    let end = vat + t[vat..].find('\n').unwrap();
    std::fs::write(&f, format!("{}value = {patterns}{}", &t[..vat], &t[end..])).unwrap();
    root
}

fn run(home: &Path, session: &str, command: &str) -> Verdict {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned())]);
    let payload = json!({
        "cwd": home, "hook_event_name": "PreToolUse", "session_id": session, "tool_name": "Bash", "tool_input": { "command": command }
    });
    ah_engine::script::run_forced("git", &payload, &json!({}), "PreToolUse", &env).expect("git script").expect("a verdict")
}

fn text(v: &Verdict) -> String {
    format!("{v:?}")
}

#[test]
fn a_bad_expansion_pattern_is_dropped_told_once_and_never_blocks_bash() {
    let tmp = std::env::temp_dir().join(format!("ah-badexp-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let tmp = std::fs::canonicalize(&tmp).unwrap();
    // BAD: \b, a lookbehind, `^` inside a group and inside a lookahead, an invalid regex.
    // GOOD (kept): `\\b` is a literal backslash then b, `[^a]` and `[\b]` are character classes, `\$\(` is the real pattern.
    let root = root_with_patterns(&tmp, r#"["\\bBAD1", "(?<=x)BAD2", "(?:^a)BAD3", "(?=^)BAD4", "(BAD5", "\\\\bGOODA", "[^a]GOODB", "[\\b]GOODC", "\\$\\("]"#);
    ah_engine::bootstrap::set_root_flag(root);
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();

    // 1. an ordinary Bash call is ALLOWED (with the advisory), not blocked with the fail-closed message
    let first = run(&home, "bad-exp", "ls -la");
    assert!(matches!(first, Verdict::Advisory(_)), "first call: {}", text(&first));
    let t = text(&first);
    for bad in ["BAD1", "BAD2", "BAD3", "BAD4", "BAD5"] {
        assert!(t.contains(bad), "advisory names {bad}: {t}");
    }
    assert!(!t.contains("GOOD"), "a valid pattern was dropped: {t}");
    // 2. the advisory is shown ONCE per session; the next call is a plain allow
    let second = run(&home, "bad-exp", "ls -la");
    assert!(matches!(second, Verdict::Allow), "second call: {}", text(&second));
    // a different session is told again
    assert!(matches!(run(&home, "bad-exp-2", "ls -la"), Verdict::Advisory(_)));
    // 3. the other git checks still work: a force push is blocked, and the remaining good expansion pattern still refuses `$(`
    assert!(matches!(run(&home, "bad-exp", "git push --force origin main"), Verdict::Block(_)));
    let exp = run(&home, "bad-exp", "git commit -m \"fix $(whoami)\"");
    assert!(matches!(exp, Verdict::Block(_)), "good pattern still active: {}", text(&exp));
    std::fs::remove_dir_all(&tmp).ok();
}
