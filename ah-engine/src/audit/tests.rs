//! The entry-path audit as a test the whole gate runs (task #539): it used to run only at deploy preflight, so a review and the
//! fold never saw a leftover js/sh file or a stale command line in a skill or doc. The scope is the one the preflight uses
//! (`routine.audit_args`): the plugin tree, without the machine section (a test never looks at the real machine).
use super::{Opts, run};
use std::path::{Path, PathBuf};

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-audit-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // a leftover of an earlier run of this test
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_shipped_plugin_tree_has_no_js_sh_or_wrong_entry_leftover() {
    let home = scratch("home");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let report = run(&Opts { root, home: home.clone(), live: false });
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // the scratch home is ours and empty
    let shown: Vec<String> = report.findings.iter().map(|f| format!("{} {}:{} [{}] {}", f.section, f.path, f.line, f.rule, f.text)).collect();
    assert!(shown.is_empty(), "entry-path leftovers (run `ah-engine audit entry-paths --root plugins/anti-hall --no-live`): {shown:#?}");
}

/// Mutation proof: a stale command line in a skill, a script file in the tree and a retired-tree pointer in a doc are each found, so
/// the test above cannot pass on a tree that holds one.
#[test]
fn a_seeded_stale_line_and_a_seeded_script_file_are_found() {
    let home = scratch("mut-home");
    let plugin = scratch("mut-plugin");
    std::fs::create_dir_all(plugin.join("skills/x")).unwrap();
    std::fs::create_dir_all(plugin.join("hooks")).unwrap();
    std::fs::write(plugin.join("skills/x/SKILL.md"), "# x\n\nRun `node hooks/old-guard.js` to start it.\nSee `plugins/anti-hall-node/hooks` too.\n").unwrap();
    std::fs::write(plugin.join("hooks/stale.js"), "console.log(1)\n").unwrap();
    let report = run(&Opts { root: plugin.clone(), home: home.clone(), live: false });
    crate::discard::harmless(std::fs::remove_dir_all(&plugin)); // our own scratch trees
    crate::discard::harmless(std::fs::remove_dir_all(&home));
    let has = |rule: &str, path: &str| report.findings.iter().any(|f| f.rule.contains(rule) && f.path.ends_with(path));
    assert!(has("node-invocation", "skills/x/SKILL.md"), "{:#?}", report.findings);
    assert!(has("node-dir", "skills/x/SKILL.md"), "{:#?}", report.findings);
    assert!(report.findings.iter().any(|f| f.path.ends_with("hooks/stale.js")), "{:#?}", report.findings);
}
