//! #462: the agent-visible rule digest is generated from the enforced rule's own message entry, so editing that message changes
//! the digest, and `ah-regen --check` then reports the committed digest stale. Own process: the defaults snapshot is global and
//! this test edits a scratch copy of the plugin, never the checkout or the real home.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
mod common;
use std::path::Path;
use std::process::Command;

const EDITED: &str = "ZZ-edited enforced wording.";
const EDITED_DIGEST: &str = "ZZ-edited digest line.";

#[test]
#[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation in a single-test process
fn editing_an_enforced_rule_message_changes_the_digest_and_makes_the_committed_digest_stale() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-digest-drift-{}", std::process::id())));
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(root.join("eng")).unwrap();
    let plugin = root.join("plugin");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    assert!(Command::new("cp").arg("-R").arg(repo.join("plugins/anti-hall")).arg(&plugin).status().unwrap().success());
    // FIXME: Audit that the environment access only happens in single-threaded code.
    unsafe {
        std::env::set_var("HOME", root.join("home"));
        std::env::set_var("AH_ENGINE_DIR", root.join("eng"));
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", &plugin);
    }
    ah_engine::defaults::init().unwrap();
    let before = ah_engine::skillgen::digest_file();
    assert!(!before.contains(EDITED));
    // the unedited scratch copy generates the committed digest: nothing is stale
    let regen = |plugin: &Path| {
        Command::new(env!("CARGO_BIN_EXE_ah-regen"))
            .args(["--check", "--repo"])
            .arg(&repo)
            .env("HOME", root.join("home"))
            .env("AH_ENGINE_DIR", root.join("eng"))
            .env("AH_ENGINE_PLUGIN_ROOT", plugin)
            .output()
            .unwrap()
    };
    let digest_rel = format!("plugins/anti-hall/{}", ah_engine::defaults::text("guard_rules.digest_file"));
    assert!(!String::from_utf8_lossy(&regen(&plugin).stdout).contains(&digest_rel), "the unedited digest must not be stale");
    // edit the enforced force-push message (the entry the git guard blocks with, its instead text), not any digest text
    let file = plugin.join("engine/defaults/git.toml");
    let text = std::fs::read_to_string(&file).unwrap();
    let edited = text.replace("push without rewriting published history.", EDITED);
    assert_ne!(text, edited, "the force-push message moved: update this test");
    std::fs::write(&file, edited).unwrap();
    ah_engine::defaults::reload(None).unwrap();
    let after = ah_engine::skillgen::digest_file();
    assert!(after.contains(EDITED) && after != before, "the digest did not follow the enforced message:\n{after}");
    let out = regen(&plugin);
    assert_eq!(out.status.code(), Some(1), "ah-regen --check must exit 1");
    assert!(String::from_utf8_lossy(&out.stdout).contains(&digest_rel), "the digest must be listed stale:\n{}", String::from_utf8_lossy(&out.stdout));
    // the rule's own digest field is the other source: editing it changes the injected line and is stale too
    std::fs::write(&file, &text).unwrap();
    ah_engine::defaults::reload(None).unwrap();
    assert_eq!(ah_engine::skillgen::digest_file(), before, "restoring the message restores the digest");
    let d = ah_engine::defaults::raw("git.msg_force_push").get("digest").expect("git.msg_force_push has no digest field");
    let line = d.as_str().or_else(|| d.get("claude").and_then(|x| x.as_str())).expect("no claude digest text").to_string();
    let edited = text.replacen(&line, EDITED_DIGEST, 1);
    assert_ne!(text, edited, "the force-push digest text is not in git.toml: update this test");
    std::fs::write(&file, edited).unwrap();
    ah_engine::defaults::reload(None).unwrap();
    let after = ah_engine::skillgen::digest_file();
    let ess = after.split(&format!("\n{}\n", ah_engine::defaults::text("guard_rules.digest_sep"))).next().unwrap_or("").to_string();
    assert!(ess.contains(EDITED_DIGEST), "the injected essentials did not follow the digest field:\n{after}");
    let out = regen(&plugin);
    assert_eq!(out.status.code(), Some(1), "ah-regen --check must exit 1 after a digest edit");
    assert!(String::from_utf8_lossy(&out.stdout).contains(&digest_rel), "the digest must be listed stale:\n{}", String::from_utf8_lossy(&out.stdout));
}
