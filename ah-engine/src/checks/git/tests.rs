//! Decision tests for the git check. Each case is a command string and whether the Node guard blocks it
//! (verified against the Node hook by `parity/run-git.js`; these pin the behaviour without Node).
use super::util::Settings;
use super::*;
use serde_json::json;
use std::collections::HashMap;

/// One private home per test thread, so the skip-file test cannot leak into the others.
fn home() -> std::path::PathBuf {
    let t = format!("{:?}", std::thread::current().id()).replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let d = std::path::PathBuf::from("/tmp").join(format!("ah-gg-unit-{}-{}", std::process::id(), t));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn run(cmd: &str) -> Verdict {
    let h = home();
    let s = Settings { home: h.to_string_lossy().to_string(), env: HashMap::new() };
    check_with(s, cmd, Some("/tmp"), "/plugin")
}

fn blocked(cmd: &str) -> String {
    match run(cmd) {
        Verdict::Block(m) => m,
        o => panic!("expected a block for {cmd:?}, got {o:?}"),
    }
}

fn allowed(cmd: &str) {
    assert_eq!(run(cmd), Verdict::Allow, "{cmd:?}");
}

const P: &str = "pu\x73h";
const F: &str = "--for\x63e";
const CO: &str = "Co-Authored\x2dBy";

#[test]
fn force_and_delete_pushes_block_with_the_node_message() {
    for c in [
        format!("git {P} {F} origin main"),
        format!("git {P} -f"),
        format!("git {P} origin +main"),
        format!("git {P} --force-with-lease"),
        format!("git {P} --mirror"),
        format!("git {P} -- origin +main"),
        format!("git {P} --for origin main"),
        format!("sudo -u deploy git {P} -f"),
        format!("env A=1 git {P} -f"),
        format!("timeout 5 git {P} -f"),
        format!("nice -n 5 git {P} -f"),
        format!("flock f git {P} -f"),
        format!("bash -c 'git {P} -f'"),
        format!("eval \"git {P} -f\""),
        format!("echo x | xargs git {P}"),
        format!("find . -exec git {P} {{}} \\;"),
        format!("git -c alias.p={P} p {F}"),
        format!("git \"{P}\" '-f'"),
    ] {
        let m = blocked(&c);
        assert!(m.contains("force push") || m.contains("xargs") || m.contains("find"), "{c}: {m}");
    }
    let m = blocked(&format!("git {P} --delete origin b"));
    assert!(
        m.contains("remote ref deletion") && m.contains("Override (only if the user explicitly asked): node '/plugin/scripts/devswarm.js' skip git-guard"),
        "{m}"
    );
    assert_eq!(
        blocked(&format!("git {P} -f")),
        "\u{26d4} anti-hall \u{b7} git-guard: force push is blocked.\nWhy: Rewriting published history is a deliberate human action.\nDo instead: do it manually with explicit owner confirmation, never from an automated push."
    );
}

#[test]
fn benign_commands_pass() {
    for c in [
        "git status",
        "git log --oneline -5",
        &format!("git {P} origin main"),
        &format!("git {P} -u origin feat"),
        "echo force",
        "git commit -m 'fix: thing'",
        &format!("git commit -m \"never git {P} {F}\""),
        &format!("echo 'git {P} {F}' > notes.md"),
        "ls -la && pwd",
    ] {
        allowed(c);
    }
}

#[test]
fn self_credit_in_every_message_route_blocks() {
    for c in [
        format!("git commit -m \"x\\n\\n{CO}: Claude <noreply@anthropic.com>\""),
        format!("git commit -m 'x' --trailer '{CO}: Claude <n@a.com>'"),
        format!("git commit -F - <<'EOF'\n{CO}: Claude <n@a.com>\nEOF"),
        format!("printf '%s' \"{CO}: Claude <n@a.com>\" | git commit -F -"),
        format!("git -c trailer.ai.key={CO} commit --trailer 'ai: x'"),
        format!("M=\"x\n{CO}: Claude <n@a.com>\"; bash -c 'git commit -m \"$M\"'"),
        "git commit -m \"\u{1f916} Generated with [Claude Code](https://claude.com/claude-code)\"".to_string(),
        format!("gh pr create --title t --body \"{CO}: Claude <n@a.com>\""),
    ] {
        let m = blocked(&c);
        assert!(m.contains("self-credit") || m.contains("-c trailer") || m.contains("creates a commit") || m.contains("body or title"), "{c}: {m}");
    }
    allowed("git commit -m \"docs: explain output generated with claude code\"");
}

#[test]
fn heredoc_data_is_not_scanned_but_executed_bodies_are() {
    let body = format!("git {P} {F} origin main");
    allowed(&format!("cat > notes.md <<'EOF'\n{body}\nEOF"));
    allowed(&format!("git commit -F - <<'EOF'\nnote: {body}\nEOF"));
    blocked(&format!("bash <<'EOF'\n{body}\nEOF"));
    blocked(&format!("cat > x.sh <<'EOF'\n{body}\nEOF"));
    blocked(&format!("cat <<'EOF' | bash\n{body}\nEOF"));
    blocked(&format!("cat > x.md <<'EOF'\n{body}\nEOF\nbash x.md"));
}

#[test]
fn credit_block_names_the_command_that_carries_it() {
    let footer = "\u{1f916} Generated with [Claude Code](https://claude.com/claude-code)";
    let m = blocked(&format!("git commit -m 'fix: clean' && gh pr create --title t --body 'body\n\n{footer}'"));
    assert!(m.contains("chained with `gh pr create`") && m.contains("not in the commit message"), "{m}");
    let m = blocked(&format!("gh pr create --title t --body 'clean' && git commit -m 'x\n\n{CO}: Claude <n@a.com>'"));
    assert!(m.contains("chained with `git commit`") && m.contains("not in the gh body or title"), "{m}");
    // credit in the rule's own command, or reaching git through a pipe: the plain message stands
    assert!(!blocked(&format!("git commit -m 'x\n\n{CO}: Claude <n@a.com>'")).contains("chained with"));
    assert!(!blocked(&format!("echo '{CO}: Claude <n@a.com>' | git commit -F -")).contains("chained with"));
    assert!(!blocked(&format!("git commit -m 'x\n\n{CO}: C <n@a.com>' && gh pr create --body '{footer}'")).contains("chained with"));
    allowed("git commit -m 'fix: clean' && gh pr create --title t --body 'a clean body'");
}

#[test]
fn heredoc_data_survives_read_only_neighbours_and_literal_variables() {
    let note = format!("Notes:\ngit {P} {F} origin main\n");
    let sp = "/tmp/ah-unit-sp";
    allowed(&format!("S={sp}; sed -n 200,211p $S/d.log | cut -c1-200\ncat > $S/r/d.md <<'E'\n{note}E"));
    allowed(&format!("A={sp}; B=sub; cat > $A/n.md <<'EOF'\n{note}EOF"));
    allowed(&format!("ls | tr a b | nl | tac | rev | fold -w 40\ncat > n.md <<'EOF'\n{note}EOF"));
    allowed(&format!("sed -n 5p log.txt\ncat > n.md <<'EOF'\n{note}EOF"));
    for c in [
        format!("S={sp}; cat > $S/d.sh <<'EOF'\n{note}EOF"),
        format!("cat > $S/n.md <<'EOF'\n{note}EOF"),
        format!("S=$(echo {sp}); cat > $S/n.md <<'EOF'\n{note}EOF"),
        format!("S={sp} cat > $S/n.md <<'EOF'\n{note}EOF"),
        format!("PATH={sp}; cat > n.md <<'EOF'\n{note}EOF"),
        format!("GIT_PAGER={sp}/x; cat > n.md <<'EOF'\n{note}EOF"),
        format!("sed -i s/a/b/ x\ncat > n.md <<'EOF'\n{note}EOF"),
        format!("sed -n '1w x' a\ncat > n.md <<'EOF'\n{note}EOF"),
        format!("grep -c x a.log\ncat > n.md <<'EOF'\n{note}EOF"),
    ] {
        blocked(&c);
    }
}

#[test]
fn launcher_directory_writes_block() {
    for c in [
        "cp x ~/.anti-hall/bin/devswarm.js",
        "echo x > ~/.anti-hall/bin/y",
        "tee ~/.anti-hall/bin/z",
        "sed -i s/a/b/ ~/.anti-hall/bin/devswarm.js",
        "rm -rf ~/.anti-hall/bin",
    ] {
        let m = blocked(c);
        assert!(m.contains("~/.anti-hall/bin/"), "{c}: {m}");
    }
    allowed("node ~/.anti-hall/bin/devswarm.js status");
}

#[test]
fn cmdsubst_arg_on_push_blocks_and_skip_file_is_honoured() {
    let m = blocked(&format!("git {P} origin \"$(echo x)\""));
    assert!(m.contains("command substitution"), "{m}");
    let h = home();
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    std::fs::write(h.join(".anti-hall/skip.json"), format!("{{\"git-guard\": {}}}", 32503680000000u64)).unwrap();
    allowed(&format!("git {P} -f"));
    std::fs::remove_file(h.join(".anti-hall/skip.json")).unwrap();
    blocked(&format!("git {P} -f"));
}

#[test]
fn tokenizer_and_splitter_basics() {
    use super::tokenize::*;
    let t = tokenize("git commit -m 'a b' \"c d\" e\\ f # tail");
    let texts: Vec<&str> = t.iter().map(|x| x.text.as_str()).collect();
    assert_eq!(texts, ["git", "commit", "-m", "a b", "c d", "e f"]);
    assert!(t[3].quoted_only && !t[0].quoted_only);
    assert_eq!(tokenize("$'a\\nb'")[0].text, "a\nb");
    assert_eq!(split_segments("a && b | c; d\ne"), ["a ", " b ", " c", " d", "e"].map(String::from));
    assert_eq!(split_segments("echo 'a;b' \"c|d\"").len(), 1);
    assert_eq!(effective_verb(&tokenize("sudo -u x env A=1 nice -n 3 /usr/bin/git push")).unwrap().verb, "git");
    assert_eq!(basename("\\git"), "git");
}

#[test]
fn escaped_literal_newline_and_comment_edge_cases() {
    allowed("echo 'a' # git push --force");
    blocked(&format!("git {P} \\\n  {F}"));
    blocked(&format!("echo \\>| git {P} {F}"));
}

mod jev_self_credit {
    use super::*;
    use crate::jev::testkit::{Fake, install_scripted, log_rows, ok};
    use std::sync::Arc;

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-gg-jev-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn settings(h: &std::path::Path, extra: &[(&str, &str)]) -> Settings {
        let mut env: HashMap<String, String> = ON.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        Settings { home: h.to_string_lossy().into_owned(), env }
    }

    fn on_mode(h: &std::path::Path) {
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        std::fs::write(h.join(".anti-hall/settings.json"), r#"{"jevIntegrations":{"gitGuardSelfCredit":"on"}}"#).unwrap();
    }

    fn lane(h: &std::path::Path, script: Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>>) -> Arc<Fake> {
        install_scripted(h, &ON, script).1
    }

    const PARAPHRASE: &str = r#"git commit -m "written with help from the assistant""#;

    fn conf(p: f64) -> Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError> {
        ok(200, &format!(r#"{{"answers":{{"decision":{{"noul":{p}}}}}}}"#))
    }

    #[test]
    fn in_on_mode_a_confident_paraphrase_adds_a_block_at_the_commit_site() {
        let h = home("on");
        on_mode(&h);
        lane(&h, vec![conf(0.97)]);
        let v = check_with_session(settings(&h, &[]), PARAPHRASE, Some("/tmp"), "/plugin", Some("sess"));
        let Verdict::Block(m) = v else { panic!("expected a block, got {v:?}") };
        assert!(m.contains("a commit message that appears to credit an AI assistant (paraphrased, flagged by the Jev classifier) is blocked."), "{m}");
        let rows = log_rows(&h);
        assert_eq!(
            (rows.len(), &rows[0]["id"], &rows[0]["mode"], &rows[0]["base"], &rows[0]["final"], &rows[0]["sessionId"]),
            (1, &json!("gitGuardSelfCredit"), &json!("on"), &json!(false), &json!(true), &json!("sess"))
        );
    }

    #[test]
    fn in_the_default_shadow_mode_the_ask_is_logged_and_never_changes_the_verdict() {
        let h = home("shadow");
        let fake = lane(&h, vec![conf(0.99)]);
        assert_eq!(check_with(settings(&h, &[]), PARAPHRASE, Some("/tmp"), "/plugin"), Verdict::Allow);
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert_eq!(log_rows(&h)[0]["mode"], json!("shadow"));
    }

    #[test]
    fn a_text_is_asked_once_per_command_and_at_most_eight_distinct_texts_are_asked() {
        let h = home("cap");
        let fake = lane(&h, (0..20).map(|_| conf(0.01)).collect());
        let one = format!("{PARAPHRASE}; {PARAPHRASE}; {PARAPHRASE}");
        assert_eq!(check_with(settings(&h, &[]), &one, Some("/tmp"), "/plugin"), Verdict::Allow);
        assert_eq!(fake.seen.lock().unwrap().len(), 1, "the same text is answered from the memo");
        let many: Vec<String> = (0..12).map(|i| format!(r#"git commit -m "note {i}""#)).collect();
        assert_eq!(check_with(settings(&h, &[]), &many.join("; "), Some("/tmp"), "/plugin"), Verdict::Allow);
        assert_eq!(fake.seen.lock().unwrap().len(), 1 + 8, "past the cap the regex verdict stands without asking");
    }

    #[test]
    fn a_regex_hit_never_asks_and_a_failed_ask_leaves_the_verdict_alone() {
        let h = home("regex");
        on_mode(&h);
        let fake = lane(&h, vec![]);
        let credit = format!(r#"git commit -m "x\n\n{CO}: Claude <noreply@anthropic.com>""#);
        assert!(matches!(check_with(settings(&h, &[]), &credit, Some("/tmp"), "/plugin"), Verdict::Block(_)));
        assert!(fake.seen.lock().unwrap().is_empty(), "the regex block returns before the consult");
        assert_eq!(check_with(settings(&h, &[]), PARAPHRASE, Some("/tmp"), "/plugin"), Verdict::Allow, "no answer: fail open");
    }

    #[test]
    fn a_gh_body_is_consulted_too() {
        let h = home("gh");
        on_mode(&h);
        lane(&h, vec![conf(0.97)]);
        let v = check_with(settings(&h, &[]), r#"gh pr create --title t --body "co-written by an assistant""#, Some("/tmp"), "/plugin");
        let Verdict::Block(m) = v else { panic!("expected a block, got {v:?}") };
        assert!(m.contains("a gh pr/issue/release body or title appears to credit an AI assistant"), "{m}");
    }
}

/// A command that has exited keeps its output while a helper of it still holds the pipe past `git.child_read_ms`: Node's
/// spawnSync collects until the pipe closes within its timeout, so an engine that gave up at `child_read_ms` read an empty
/// output and dropped the git-audit advisory Node printed (the full gate's git_audit parity mismatches).
#[test]
fn a_finished_commands_output_survives_a_pipe_that_closes_after_child_read() {
    let read = super::tables::tables().child_read;
    let script = format!("printf out; sleep {} &", (read * 2).as_secs_f64());
    let t = std::time::Instant::now();
    let got = super::util::run_capture("/bin/sh", &["-c".to_string(), script], None, &HashMap::new(), &HashMap::new(), read * 20);
    assert_eq!(got.as_deref(), Some("out"), "after {:?}", t.elapsed());
}
