//! Unit tests of the command check: each case states the Node guard's answer (checked against `command-guard.js`
//! by `parity/run-command.js`) and what the engine must do with it.
use super::*;

fn allow(c: &str) {
    assert_eq!(decide(c, Some("/tmp")), Verdict::Allow, "expected Allow: {c:?}");
}

fn defer(c: &str) {
    assert_eq!(decide(c, Some("/tmp")), Verdict::Defer, "expected Defer: {c:?}");
}

#[test]
fn light_commands_are_allowed() {
    for c in ["ls -la", "git status", "git log --oneline -5", "cat README.md | head -20", "echo hi 2>&1", "grep -rn deploy src", "node --version", ""] {
        allow(c);
    }
}

#[test]
fn heavy_commands_defer() {
    for c in [
        "npm test",
        "git push origin main",
        "cd app && cargo build",
        "bash -c 'npm run build'",
        "echo $(make)",
        "node -e \"require('fs').writeFileSync('x','y')\"",
        "gh pr merge 1",
        "python3 x.py",
    ] {
        defer(c);
    }
}

#[test]
fn writes_and_special_guards_defer() {
    for c in [
        "echo hi > out.txt",
        "sed -i s/a/b/ f.txt",
        "cp a b",
        "tee log.txt",
        "git stash",
        "hivecontrol workspace monitor",
        "cat ~/.anti-hall/devswarm/inbox/x",
        "python3 -c \"open('x','w')\"",
    ] {
        defer(c);
    }
    // targets Node skips without touching the file system
    allow("echo hi > $OUT");
    allow("echo hi >/dev/null");
}

#[test]
fn light_exceptions_with_lookahead() {
    allow("node scripts/jev-report.js");
    defer("node scripts/jev-report.js label x");
    allow("go env GOPATH");
    defer("go env -w GOPATH=/x");
    allow("node hooks/doctor.js");
    defer("node hooks/doctor.js --repair");
}

#[test]
fn non_ascii_defers() {
    defer("echo \u{2014}");
}

#[test]
fn shell_primitives_match_node() {
    use shell::*;
    let s = split_detailed("cd a && npm test; echo $(x) | tail -1");
    assert_eq!(s.segments, vec!["cd a ", " npm test", " echo ", "x", " tail -1"]);
    assert_eq!(s.delims, vec!["&&", ";", "subst", "group", "end"]);
    assert_eq!(effective_verb("FOO=1 sudo -u me timeout 5 npm test"), "npm");
    assert_eq!(extract_shell_c_payload("bash -lc 'make all'"), "make all");
    assert_eq!(extract_substitutions("a $(b (c)) `d`"), vec!["b (c)", "d"]);
    assert_eq!(writes::unbrace_simple_vars("${A} ${A}x ${B}_ ${1}"), "$A ${A}x ${B}_ ${1}");
}

#[test]
fn a_proven_subagent_is_allowed_past_the_special_guards() {
    for c in ["npm test", "git push origin main", "echo hi > out.txt", "sed -i s/a/b/ f.txt", "cd app && cargo build"] {
        assert_eq!(decide_in(c, Some("/tmp"), true), Verdict::Allow, "{c:?}");
        assert_eq!(decide_in(c, Some("/tmp"), false), Verdict::Defer, "{c:?}");
    }
    for c in ["git stash", "hivecontrol workspace monitor", "cat ~/.anti-hall/devswarm/inbox/x"] {
        assert_eq!(decide_in(c, Some("/tmp"), true), Verdict::Defer, "{c:?}");
    }
}

#[test]
fn non_ascii_is_answered_only_for_a_proven_subagent_and_only_without_a_trigger() {
    for c in ["echo caf\u{e9}", "npm test \u{2014} x", "ls \u{1F600}"] {
        assert_eq!(decide_in(c, Some("/tmp"), true), Verdict::Allow, "{c:?}");
        assert_eq!(decide_in(c, Some("/tmp"), false), Verdict::Defer, "{c:?}");
    }
    for c in ["git st\u{e9}ash", "git stash\u{a0}pop", "hivecontrol\u{a0}workspace monitor", "cat \u{e9}/inbox/x", "echo \u{212A} \u{130}", "sta\u{200b}sh"] {
        assert_eq!(decide_in(c, Some("/tmp"), true), Verdict::Defer, "{c:?}");
    }
    assert_eq!(decide_in("ls", Some("/tmp/\u{130}"), true), Verdict::Defer);
}
