//! Prevention: every `devswarm.js <verb> [<subcommand>]` command the shipped texts (engine defaults, skills) tell an agent to run
//! is answered by the engine on a machine with NO Node: none of them may exit with `mesh_write.exit_unable` (69, "the engine
//! cannot do this verb"), whatever the answer otherwise is (an error about a workspace that does not exist is a normal answer).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const UNABLE: i32 = 69;
/// The verbs of `scripts/devswarm.js` (its dispatch table); a prose word after `devswarm.js` that is not one is skipped.
const VERBS: &[&str] = &[
    "primary",
    "register",
    "ensure",
    "heartbeat",
    "inbox",
    "workspaces",
    "gate",
    "done",
    "nudge",
    "archive",
    "reap-orphans",
    "reconcile-registry",
    "unarchive",
    "archive-ignore",
    "archive-unignore",
    "archive-request",
    "register-primary",
    "migrate",
    "logs",
    "migrate-owner-keys",
    "send",
    "relay",
    "healthcheck",
    "ready-check",
    "mesh",
    "reconcile",
    "reap-stale",
    "reconcile-active",
    "spawn",
    "merge",
    "skip",
    "auto-archive",
    "prune-archived",
    "gate-intent",
    "retention",
    "notice",
    "help",
    "self-heal",
];
/// The subcommands of `inbox`.
const INBOX_SUBS: &[&str] = &["tick", "pull", "ack", "ack-primary", "count", "read", "read-primary", "peek-primary", "messages"];
/// Shipped commands the engine cannot yet answer without Node (measured 2026-10-23, each with the site that gives up). This is the
/// open work list, not an allowance: the test fails when a command is added to it without being unable, and when one listed here is
/// answered (delete the entry). Porting every entry is tracked in the P0 mesh-defer task; the list only ever shrinks.
const KNOWN_UNABLE: &[&str] = &[];
/// The verbs whose next word is a subcommand.
const WITH_SUB: &[&str] = &["inbox", "plan", "scope", "primary", "retention", "mesh"];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, ext, out);
        } else if p.extension().is_some_and(|x| x == ext) {
            out.push(p);
        }
    }
}

/// Every `(verb, subcommand)` the shipped texts name.
fn shipped_commands() -> BTreeSet<(String, Option<String>)> {
    let plugin = root().join("plugins").join("anti-hall");
    let mut paths = Vec::new();
    files(&plugin.join("engine").join("defaults"), "toml", &mut paths);
    files(&plugin.join("skills"), "md", &mut paths);
    let word = |s: &str| -> Option<String> { s.chars().all(|c| c.is_ascii_lowercase() || c == '-').then(|| s.to_string()) };
    let mut out = BTreeSet::new();
    for p in paths {
        let text = fs::read_to_string(&p).unwrap_or_default();
        for (i, _) in text.match_indices("devswarm.js ") {
            let mut it = text[i + "devswarm.js ".len()..]
                .split(|c: char| c.is_whitespace() || c == '`' || c == '"' || c == ')' || c == ',' || c == ';' || c == '.')
                .filter(|w| !w.is_empty());
            let Some(verb) = it.next().and_then(word) else { continue };
            if !VERBS.contains(&verb.as_str()) {
                continue;
            }
            let sub = if WITH_SUB.contains(&verb.as_str()) { it.next().and_then(word) } else { None };
            if verb == "inbox" && !sub.as_deref().is_some_and(|s| INBOX_SUBS.contains(&s)) {
                continue;
            }
            out.insert((verb, sub));
        }
    }
    out
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

#[test]
fn no_command_the_shipped_texts_name_exits_unable_without_node() {
    let cmds = shipped_commands();
    assert!(cmds.len() > 15, "the scan found too few commands: {cmds:?}");
    let scratch = std::env::temp_dir().join(format!("ah-shipped-cmds-{}", std::process::id()));
    ah_engine::discard::harmless(fs::remove_dir_all(&scratch)); // keep: our own scratch directory
    let (home, repo) = (scratch.join("home"), scratch.join("repo"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("f"), "x").unwrap();
    git(&repo, &["add", "f"]);
    git(&repo, &["commit", "-q", "-m", "i"]);
    // a PATH with git and the system tools but no node
    let path = "/usr/bin:/bin";
    assert!(!Path::new("/usr/bin/node").exists() && !Path::new("/bin/node").exists(), "this test needs a machine whose system PATH has no node");
    // a stand-in `hivecontrol` (the real one is a Node script): the probe and the workspace list the roster reads
    let stub = scratch.join("hivecontrol");
    fs::write(
        &stub,
        "#!/bin/sh\ncase \"$1 $2\" in\n\"--version \"*) echo 2.5.7;;\n\"workspace --help\") printf 'Commands:\\n  list [options]   List workspaces\\n  archive [idOrBranch]   Archive\\n';;\n\"workspace list\") echo '[]';;\nesac\n",
    )
    .unwrap();
    Command::new("chmod").arg("755").arg(&stub).status().unwrap();
    let run = |argv: &[String]| {
        Command::new(BIN)
            .arg("mesh")
            .args(argv)
            .current_dir(&repo)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", path)
            .env("ANTIHALL_DEVSWARM_HIVECONTROL", &stub)
            .env("AH_ENGINE_PLUGIN_ROOT", root().join("plugins").join("anti-hall"))
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    };
    // the workspace every command below names exists
    let register = || {
        let reg = run(&["register".into(), "fake-ws-1".into(), "--worktree".into(), repo.to_string_lossy().into_owned(), "--session".into(), "s1".into()]);
        assert_ne!(reg.status.code(), Some(UNABLE), "{}", String::from_utf8_lossy(&reg.stderr));
    };
    let mut unable = Vec::new();
    for (verb, sub) in &cmds {
        let mut argv: Vec<String> = vec![verb.clone()];
        argv.extend(sub.clone());
        match verb.as_str() {
            "send" => argv.extend(["--to", "fake-ws-1", "--message", "hello"].map(String::from)),
            "help" | "self-heal" | "roster" | "workspaces" | "healthcheck" | "ready-check" | "logs" | "migrate" | "reap-orphans" | "reconcile-registry" => {}
            _ => argv.push("fake-ws-1".into()),
        }
        register(); // an earlier command (`archive`) may have retired it
        let o = run(&argv);
        if o.status.code() == Some(UNABLE) {
            let key = match sub {
                Some(s) if *verb != "send" => format!("{verb} {s}"),
                _ => verb.clone(),
            };
            unable.push((key, String::from_utf8_lossy(&o.stderr).trim().to_string()));
        }
    }
    // a workspace nothing registered: Node refuses the read (exit 2, `unregistered-workspace`), the engine must not give up (69)
    let o = run(&["inbox".into(), "read-primary".into(), "never-registered-ws".into()]);
    assert_eq!(o.status.code(), Some(2), "{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    assert!(String::from_utf8_lossy(&o.stdout).contains("\"reason\":\"unregistered-workspace\""), "{}", String::from_utf8_lossy(&o.stdout));
    // a workspace registered without an inbox path (the one every command above names): Node refuses count|read|ack with
    // `no-inbox-path` (exit 2); the engine must answer the same instead of giving up (69)
    for sub in ["count", "read", "ack"] {
        register();
        let desc = home.join(".anti-hall").join("devswarm").join("workspaces").join("fake-ws-1.json");
        let mut d: serde_json::Value = serde_json::from_str(&fs::read_to_string(&desc).unwrap()).unwrap();
        d.as_object_mut().unwrap().remove("inboxPath");
        fs::write(&desc, d.to_string()).unwrap();
        let o = run(&["inbox".into(), sub.into(), "fake-ws-1".into()]);
        let out = String::from_utf8_lossy(&o.stdout);
        assert_eq!(o.status.code(), Some(2), "inbox {sub}: {out}{}", String::from_utf8_lossy(&o.stderr));
        assert!(out.contains("\"reason\":\"no-inbox-path\"") && out.contains("\"id\":\"fake-ws-1\""), "inbox {sub}: {out}");
    }
    ah_engine::discard::harmless(fs::remove_dir_all(&scratch)); // keep: our own scratch directory
    let now: BTreeSet<&str> = unable.iter().map(|(k, _)| k.as_str()).collect();
    let known: BTreeSet<&str> = KNOWN_UNABLE.iter().copied().collect();
    let new: Vec<_> = unable.iter().filter(|(k, _)| !known.contains(k.as_str())).collect();
    assert!(new.is_empty(), "these shipped commands exit {UNABLE} (engine unable) without Node:\n{new:#?}");
    let fixed: Vec<_> = known.difference(&now).collect();
    assert!(fixed.is_empty(), "these are answered now: delete them from KNOWN_UNABLE: {fixed:?}");
}
